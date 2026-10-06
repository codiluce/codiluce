import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchLocal, listenLocally, prepareVisualizer } from '../src/launcher.js';

const temporary: string[] = [];
after(async () => { for (const directory of temporary) await rm(directory, { recursive: true, force: true }); });
async function directory(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'archipelago-launcher-')); temporary.push(folder); return folder;
}
async function fixture(): Promise<{ root: string; ui: string }> {
  const root = path.join(await directory(), 'repository with spaces');
  await mkdir(path.join(root, 'src/app'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '*' } }));
  await writeFile(path.join(root, 'src/app/page.tsx'), 'export default function Welcome() { return <div>Hello</div>; }\n');
  const ui = path.join(await directory(), 'ui with spaces');
  await mkdir(ui);
  await writeFile(path.join(ui, 'index.html'), '<!doctype html><title>Launcher fixture</title>');
  return { root, ui };
}
async function shutdown(server: Server): Promise<void> {
  const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done;
}
const quiet = () => undefined;

test('launch indexes an uninitialized repository and serves its map, API and source together', async () => {
  const { root, ui } = await fixture();
  const session = await launchLocal({ repo: root, uiDirectory: ui, port: 0, open: false, log: quiet });
  try {
    assert.equal(session.stateDirectory, path.join(root, '.archipelago'));
    assert.match(await readFile(path.join(session.stateDirectory, 'config.yml'), 'utf8'), /frameworks:\n\s+- nextjs/);
    assert.match(await (await fetch(session.url)).text(), /Launcher fixture/);
    const summary = await (await fetch(`${session.url}api/summary`)).json() as { counts: { entities: number; relations: number } };
    assert.ok(summary.counts.entities > 0 && summary.counts.relations > 0);
    const search = await (await fetch(`${session.url}api/projection/search?q=Welcome`)).json() as { items: { id: string; name: string }[] };
    const symbol = search.items.find(item => item.name === 'Welcome'); assert.ok(symbol);
    const source = await (await fetch(`${session.url}api/source?entity=${encodeURIComponent(symbol.id)}`)).json() as { lines: string[] };
    assert.ok(source.lines.some(line => line.includes('Welcome')));
  } finally { await session.close(); await session.close(); }
  await assert.rejects(fetch(session.url));
});

test('relaunch preserves configuration, reuses cache, and indexes subsequent edits', async () => {
  const { root, ui } = await fixture();
  const stateDirectory = await directory();
  const config = 'repository:\n  name: Personal project\napplications:\n  - name: website\n    path: .\n    type: nextjs\nignore:\n  - excluded/**\n';
  await writeFile(path.join(stateDirectory, 'config.yml'), config);
  const options = { repo: root, stateDirectory, uiDirectory: ui, port: 0, open: false };
  await (await launchLocal({ ...options, log: quiet })).close();
  const messages: string[] = [];
  await (await launchLocal({ ...options, log: message => messages.push(message) })).close();
  assert.ok(messages.some(message => message.includes('reused from the cache')));
  assert.equal(await readFile(path.join(stateDirectory, 'config.yml'), 'utf8'), config);
  await writeFile(path.join(root, 'src/app/page.tsx'), 'export default function UpdatedWelcome() { return <div>Updated</div>; }\n');
  const session = await launchLocal({ ...options, log: quiet });
  try {
    const search = await (await fetch(`${session.url}api/projection/search?q=UpdatedWelcome`)).json() as { items: { name: string }[] };
    assert.ok(search.items.some(item => item.name === 'UpdatedWelcome'));
    assert.equal(await readFile(path.join(stateDirectory, 'config.yml'), 'utf8'), config);
    assert.equal((await readdir(root)).includes('.archipelago'), false, 'external state stays outside the repository');
  } finally { await session.close(); }
});

test('a directory without supported applications still opens a file map', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'readme.md'), '# A plain repository\n');
  const { ui } = await fixture();
  const messages: string[] = [];
  const session = await launchLocal({ repo: root, uiDirectory: ui, port: 0, open: false, log: message => messages.push(message) });
  try {
    assert.ok(messages.some(message => message.includes('showing a file map')));
    const search = await (await fetch(`${session.url}api/projection/search?q=readme`)).json() as { items: { name: string }[] };
    assert.ok(search.items.some(item => item.name === 'readme.md'));
  } finally { await session.close(); }
});

test('invalid inputs fail before creating repository state', async () => {
  const { root, ui } = await fixture();
  const base = { repo: root, uiDirectory: ui, port: 0, open: false, log: quiet };
  for (const port of [-1, 65536, 1.5, NaN]) await assert.rejects(launchLocal({ ...base, port }), /--port/);
  await assert.rejects(launchLocal({ ...base, repo: path.join(root, 'missing') }), /directory not found/);
  await assert.rejects(launchLocal({ ...base, repo: path.join(root, 'package.json') }), /must be a directory/);
  await assert.rejects(launchLocal({ ...base, repo: 'https://github.com/owner/repo' }), /local repository directory/);
  await assert.rejects(launchLocal({ ...base, uiDirectory: path.join(ui, 'missing') }), /No built visualizer/);
  await assert.rejects(launchLocal({ ...base, uiDirectory: 'none' }), /requires the visualizer/);
  await assert.rejects(launchLocal({ ...base, buildUi: true }), /cannot be combined/);
  assert.equal((await readdir(root)).includes('.archipelago'), false);
});

test('automatic port selection skips an occupied port, while an explicit port fails clearly', async () => {
  const busy = createServer((_request, response) => response.end('original server'));
  const port = await listenLocally(busy, 0);
  const automatic = createServer((_request, response) => response.end('launcher'));
  try {
    const chosen = await listenLocally(automatic, port, true);
    assert.notEqual(chosen, port);
    assert.equal(await (await fetch(`http://127.0.0.1:${chosen}`)).text(), 'launcher');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'original server');
    const { root, ui } = await fixture();
    await assert.rejects(launchLocal({ repo: root, uiDirectory: ui, port, open: false, log: quiet }), /already in use.*--port/);
  } finally { await shutdown(automatic); await shutdown(busy); }
});

test('aborting a running session releases the port and closes its connections', async () => {
  const { root, ui } = await fixture();
  const controller = new AbortController();
  const session = await launchLocal({ repo: root, uiDirectory: ui, port: 0, open: false, signal: controller.signal, log: quiet });
  controller.abort();
  await session.closed;
  await assert.rejects(fetch(session.url));
  const replacement = createServer();
  try { await listenLocally(replacement, Number(new URL(session.url).port), false); }
  finally { await shutdown(replacement); }
  await assert.rejects(launchLocal({ repo: root, signal: controller.signal, log: quiet }), { name: 'AbortError' });
});

test('missing UI is built in the tool directory, reused thereafter, and can be explicitly rebuilt', async () => {
  const tool = await directory();
  const bin = path.join(tool, 'node_modules/next/dist/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(tool, 'package.json'), '{"type":"module"}');
  const builder = path.join(bin, 'next.js');
  await writeFile(builder, `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
if (process.argv.slice(2).join(' ') !== 'build web') process.exit(2);
mkdirSync('web/out', { recursive: true });
writeFileSync('web/out/index.html', '<!doctype html><title>Built</title>');
appendFileSync('build-count', 'built\\n');
`);
  const ui = await prepareVisualizer(tool);
  assert.equal(ui, path.join(tool, 'web/out'));
  await prepareVisualizer(tool);
  assert.equal(await readFile(path.join(tool, 'build-count'), 'utf8'), 'built\n');
  await prepareVisualizer(tool, { buildUi: true });
  assert.equal(await readFile(path.join(tool, 'build-count'), 'utf8'), 'built\nbuilt\n');
  await writeFile(builder, 'process.exit(1);');
  await assert.rejects(prepareVisualizer(tool, { buildUi: true }), /Visualizer build failed/);
});

test('CLI defaults to the current repository and shuts down cleanly on SIGINT', { timeout: 20_000 }, async () => {
  const { root, ui } = await fixture();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-sqlite', '--import', loader, cli, 'start', '--ui', ui, '--port', '0', '--no-open'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stderr.on('data', data => { output += data; });
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', data => {
        output += data;
        const match = /Visualizer: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match) resolve(match[1]!);
      });
      child.once('exit', () => reject(new Error(`Launcher exited before listening: ${output}`)));
      child.once('error', reject);
    });
    assert.match(output, /Applications:.*nextjs/);
    assert.equal((await fetch(url)).status, 200);
    child.kill('SIGINT');
    const [code, signal] = await exited;
    assert.deepEqual([code, signal], [0, null]);
    await assert.rejects(fetch(url));
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
