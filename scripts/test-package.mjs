// Exercise the release tarball with production dependencies, outside this
// checkout. No install scripts, TypeScript loader, or Next.js runtime is used.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package');
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-package-'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const run = (command, args, cwd = root) => execute(command, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);

async function checkSession(bin, repo, args = [], signal = 'SIGINT') {
  const child = spawn(process.execPath, [bin, 'start', ...args, '--port', '0', '--no-open'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 30_000);
  try {
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /Visualizer: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match) resolve(match[1]);
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Packaged launcher exited before listening:\n${output}`)));
    });
    assert.doesNotMatch(output, /Building the visualizer/);
    const html = await (await fetch(url)).text();
    assert.match(html, /Codiluce/);
    // The exported page needs its actual JS, CSS and font assets, not just HTML.
    const assets = [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map(match => match[1]);
    assert.ok(assets.length > 0, 'the static visualizer includes its scripts and styles');
    for (const asset of assets) assert.equal((await fetch(new URL(asset, url))).status, 200, asset);
    const summary = await (await fetch(`${url}api/summary`)).json();
    assert.ok(summary.counts.entities > 0 && summary.counts.relations > 0);
    const search = await (await fetch(`${url}api/projection/search?q=LoginForm`)).json();
    assert.ok(search.items.some(item => item.name.includes('LoginForm')));
    assert.equal((await fetch(`${url}licenses/fontsource-variable-nunito.txt`)).status, 200);
    child.kill(signal);
    assert.deepEqual(await exited, [0, null], output);
    await assert.rejects(fetch(url));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
  }
}

try {
  console.log('Building and packing the release…');
  await npm(['pack', '--pack-destination', temporary, '--loglevel=error']);
  const tarballs = (await readdir(temporary)).filter(name => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  const tarball = path.join(temporary, tarballs[0]);
  const report = JSON.parse((await npm(['pack', '--dry-run', '--ignore-scripts', '--json'])).stdout)[0];
  const files = report.files.map(file => file.path);
  for (const required of ['bin/codiluce.js', 'dist/src/cli.js', 'dist/src/history/worker.js', 'web/out/index.html', 'LICENSE', 'web/out/licenses/react.txt']) {
    assert.ok(files.includes(required), `tarball is missing ${required}`);
  }
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:\.env(?:\..*)?|\.codiluce|node_modules|tests|test-results|brand-explorations)(?:\/|$)|\.(?:db|sqlite|tgz|ts|tsx|tsbuildinfo)$/, `unexpected package file: ${file}`);
  }
  console.log(`Tarball: ${(report.size / 1024 / 1024).toFixed(2)} MB, ${files.length} files.`);

  const consumer = path.join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  console.log('Installing with production dependencies and install scripts disabled…');
  await npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);
  const installed = path.join(consumer, 'node_modules', ...manifest.name.split('/'));
  const bin = path.join(installed, 'bin/codiluce.js');
  const dependencies = JSON.parse((await npm(['ls', '--omit=dev', '--all', '--json'], consumer)).stdout).dependencies[manifest.name].dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(), Object.keys(manifest.dependencies).sort());
  const help = (await npm(['exec', '--offline', '--no', '--', 'codiluce', '--help'], consumer)).stdout;
  assert.match(help, /Code and architecture visualizer/);
  assert.equal((await npm(['exec', '--offline', '--no', '--', 'codiluce', '--version'], consumer)).stdout.trim(), manifest.version);

  const repo = path.join(consumer, 'repository with spaces');
  await cp(path.join(root, 'tests/fixtures/repository'), repo, { recursive: true });
  console.log('Starting the installed executable from a repository with spaces…');
  await checkSession(bin, repo);
  assert.ok((await readdir(path.join(repo, '.codiluce'))).includes('codiluce.db'));
  const summary = JSON.parse((await run(process.execPath, [bin, 'inspect', 'summary'], repo)).stdout);
  assert.ok(summary.counts.entities > 0);
  assert.deepEqual(JSON.parse((await run(process.execPath, ['--experimental-sqlite', bin, 'inspect', 'summary'], repo)).stdout), summary);
  await assert.rejects(run(process.execPath, [bin, 'start', '--build-ui', '--no-open'], repo), error => error.code === 1 && /only available in a Codiluce source checkout/.test(error.stderr));
  await assert.rejects(run(process.execPath, [bin, 'unknown-command'], repo), error => error.code === 1);
  const broken = path.join(repo, 'frontend/src/broken.ts');
  await writeFile(broken, 'export function broken( {');
  await assert.rejects(run(process.execPath, [bin, 'index', '--state-dir', path.join(temporary, 'error state')], repo), error => error.code === 2);
  await rm(broken);

  console.log('Checking compiled history workers…');
  await writeFile(path.join(repo, '.gitignore'), '.codiluce/\n');
  await run('git', ['init', '--quiet'], repo);
  await run('git', ['add', '.'], repo);
  const commitArgs = ['-c', 'user.name=Codiluce package test', '-c', 'user.email=package@example.test', 'commit', '--quiet'];
  await run('git', [...commitArgs, '-m', 'Initial fixture'], repo);
  await writeFile(path.join(repo, 'README.md'), '# Packaged history fixture\n');
  await run('git', ['add', 'README.md'], repo);
  await run('git', [...commitArgs, '-m', 'Add readme'], repo);
  const history = JSON.parse((await run(process.execPath, [bin, 'history', 'index', '--jobs', '2'], repo)).stdout);
  assert.equal(history.failed, 0);
  assert.equal(history.indexed, 2);

  // A scoped fallback must still locate its own bundled assets.
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ ...manifest, name: '@package-test/codiluce' }));
  await checkSession(bin, repo, [], 'SIGTERM');

  const standalone = path.join(temporary, 'standalone repository');
  await mkdir(standalone);
  console.log('Checking npm exec against the tarball without a local installation…');
  assert.equal((await npm(['exec', '--yes', `--package=${tarball}`, '--', 'codiluce', '--version'], standalone)).stdout.trim(), manifest.version);
  assert.match((await npm(['exec', '--yes', `--package=${tarball}`, '--', 'codiluce', '--help'], standalone)).stdout, /Code and architecture visualizer/);
  console.log('Package installation, static UI, API, history workers, signals and npm exec passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
