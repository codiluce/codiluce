import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  credentialsFile, depthOf, findKey, hideFromGit, installKind, keyFiles, readDotenv, readRepositorySettings, readState, readUserSettings,
  writeDotenv, writeRepositorySettings, writeState, gitFacts,
} from '../src/setup/settings.js';
import { CancelledError, multiselect, select, text, Writer, wrapText, type Terminal } from '../src/setup/terminal.js';
import { connectAgent, detectAgents, mcpLaunch } from '../src/setup/agents.js';
import { checkKey, keyShape } from '../src/setup/keys.js';
import { printSummary, runSetup, setupMode, type SetupContext } from '../src/setup/wizard.js';
import { BackgroundWork, StatusLine } from '../src/setup/background.js';
import { FIXTURE_CONFIG } from './history-fixture.js';

const temporary: string[] = [];
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });
async function folder(name = 'codiluce-setup-'): Promise<string> { const directory = await mkdtemp(path.join(tmpdir(), name)); temporary.push(directory); return directory; }
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...gitEnv, HOME: cwd }, encoding: 'utf8' }).trim();

/** A terminal whose keys are scripted: each step waits for text in the output, then types. */
function scriptedTerminal(steps: [RegExp, string][] = []): { terminal: Terminal; output: () => string } {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return input; } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
  let written = '', from = 0;
  output.on('data', chunk => {
    written += String(chunk);
    const step = steps[0];
    if (!step) return;
    const at = written.slice(from).search(step[0]);
    if (at < 0) return;
    from += at + 1;
    steps.shift();
    setImmediate(() => input.write(step[1]));
  });
  return { terminal: { input: input as unknown as Terminal['input'], output: output as unknown as Terminal['output'], interactive: true, color: false, unicode: true }, output: () => written };
}
const DOWN = '\x1b[B', ENTER = '\r', SPACE = ' ';

test('settings: keys are read from the environment, then the user credentials, then the state directory; written owner-only', async () => {
  const home = await folder();
  const state = await folder();
  const env = { CODILUCE_CONFIG_HOME: home } as NodeJS.ProcessEnv;
  const files = keyFiles(state, undefined, env);
  assert.deepEqual(files, [path.join(home, 'credentials'), path.join(state, '.env')]);
  await writeFile(path.join(state, '.env'), 'OPENAI_API_KEY="sk-state-key"\nOTHER=1 # note\n');
  assert.deepEqual(findKey('OPENAI_API_KEY', files, env), { value: 'sk-state-key', source: path.join(state, '.env') });
  writeDotenv(credentialsFile(env), { OPENAI_API_KEY: 'sk-user-key' });
  writeDotenv(credentialsFile(env), { ANTHROPIC_API_KEY: 'sk-ant-user' });
  assert.equal(findKey('OPENAI_API_KEY', files, env)!.value, 'sk-user-key', 'the user credentials win over the state directory');
  assert.equal(findKey('OPENAI_API_KEY', files, { ...env, OPENAI_API_KEY: 'sk-env' })!.source, 'environment');
  assert.deepEqual(readDotenv(credentialsFile(env)), { OPENAI_API_KEY: 'sk-user-key', ANTHROPIC_API_KEY: 'sk-ant-user' });
  assert.equal(readDotenv(path.join(state, '.env')).OTHER, '1');
  if (process.platform !== 'win32') assert.equal((await stat(credentialsFile(env))).mode & 0o777, 0o600);
  assert.equal(keyShape('openai', 'sk-ant-abcdefghijklmnopqrstuvwxyz'), 'This is an Anthropic key (sk-ant-…)');
  assert.equal(keyShape('anthropic', 'sk-ant-abcdefghijklmnopqrstuvwxyz'), undefined);
  assert.match(keyShape('anthropic', 'nope')!, /too short/);
});

test('settings: config.yml gains history and annotations without losing the rest; state and user settings round-trip', async () => {
  const state = await folder();
  await writeFile(path.join(state, 'config.yml'), '# my notes\nrepository:\n  name: shop\nignore:\n  - "**/tmp/**"\n');
  writeRepositorySettings(state, { history: { depth: '6 months ago', onDemand: false }, annotations: { enabled: true, maxCost: 3 } });
  const text = await readFile(path.join(state, 'config.yml'), 'utf8');
  assert.match(text, /# my notes/);
  assert.match(text, /\*\*\/tmp\/\*\*/);
  assert.deepEqual(readRepositorySettings(state), { history: { depth: '6 months ago', onDemand: false }, annotations: { enabled: true, maxCost: 3 } });
  assert.deepEqual([depthOf(50), depthOf('50'), depthOf('all'), depthOf('None'), depthOf(''), depthOf(-1)], [50, 50, 'all', 'none', undefined, undefined]);
  writeState(state, { setup: 1, version: '0.2.0' });
  writeState(state, { analysisMs: 1200 });
  assert.deepEqual(readState(state), { setup: 1, version: '0.2.0', analysisMs: 1200 });
  const home = await folder();
  assert.deepEqual(readUserSettings({ CODILUCE_CONFIG_HOME: home }), {});
});

test('settings: the state directory hides itself from Git unless something in it is tracked', async () => {
  const root = await folder();
  git(root, 'init', '-q');
  const state = path.join(root, '.codiluce');
  assert.equal(await hideFromGit(root, state), 'written');
  assert.match(await readFile(path.join(state, '.gitignore'), 'utf8'), /^\*$/m);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'nothing in .codiluce shows up');
  assert.equal(await hideFromGit(root, state), 'present');
  const tracked = await folder();
  git(tracked, 'init', '-q');
  await mkdir(path.join(tracked, '.codiluce'));
  await writeFile(path.join(tracked, '.codiluce/config.yml'), 'repository: { name: x }\n');
  git(tracked, 'add', '-A'); git(tracked, 'commit', '-qm', 'Track config');
  assert.equal(await hideFromGit(tracked, path.join(tracked, '.codiluce')), 'tracked');
  assert.equal(await hideFromGit(root, await folder()), 'outside');
});

test('settings: install kinds and Git facts', async () => {
  const tool = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(installKind(tool), 'checkout');
  assert.equal(installKind('/home/me/.npm/_npx/123abc/node_modules/codiluce'), 'npx');
  assert.equal(installKind('/repo/node_modules/codiluce', '/repo'), 'project');
  assert.equal(installKind('/usr/lib/node_modules/codiluce', '/repo'), 'global');
  const root = await folder();
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'a.txt'), '1');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'One');
  await writeFile(path.join(root, 'a.txt'), '2');
  git(root, 'commit', '-qam', 'Two');
  const facts = await gitFacts(root);
  assert.equal(facts.repository, true); assert.equal(facts.topLevel, true); assert.equal(facts.shallow, false);
  assert.equal(facts.commits, 2); assert.equal(facts.branch, 'main');
  assert.equal((await gitFacts(path.join(root, '..'))).repository, false);
});

test('prompts: choose with arrows and digits, select several with space, type a hidden key with validation, cancel with Ctrl+C', async () => {
  const { terminal, output } = scriptedTerminal([[/Depth/, `${DOWN}${ENTER}`], [/Agents/, `${DOWN}${SPACE}${ENTER}`], [/Key/, `bad${ENTER}`], [/must start/, `\x7f\x7f\x7fsk-good-key${ENTER}`]]);
  const w = new Writer(terminal);
  assert.equal(await select<number | string>(w, { message: 'Depth', choices: [{ value: 50, label: 'Last 50' }, { value: 'all', label: 'All', disabled: 'too many' }, { value: 'none', label: 'None' }], initial: 50 }), 'none', 'the disabled choice is skipped');
  assert.deepEqual(await multiselect(w, { message: 'Agents', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: ['a'] }), ['a', 'b']);
  const key = await text(w, { message: 'Key', secret: true, validate: value => value.startsWith('sk-') ? undefined : 'Keys must start with sk-' });
  assert.equal(key, 'sk-good-key');
  assert.doesNotMatch(output(), /good-key/, 'a secret is never echoed');
  assert.match(output(), /◇  Depth › None/);
  assert.match(output(), /◇  Agents › A, B/);
  const cancel = scriptedTerminal([[/Again/, '\x03']]);
  await assert.rejects(select(new Writer(cancel.terminal), { message: 'Again', choices: [{ value: 1, label: 'One' }] }), CancelledError);
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);
});

/** Fake agent CLIs that record what they were asked to do. */
async function fakeAgents(): Promise<{ bin: string; home: string; calls: (agent: string) => Promise<string> }> {
  const home = await folder();
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  await mkdir(path.join(home, '.cursor'));
  for (const [name, version] of [['claude', '2.1.299 (Claude Code)'], ['codex', 'codex-cli 0.162.1']] as const) {
    // `codex mcp get --json` prints codex-server.json, as if added earlier.
    await writeFile(path.join(bin, name), `#!/bin/sh\ncase "$1 $2" in "--version "*) echo "${version}";; "mcp get") cat "${home}/${name}-server.json" 2>/dev/null || exit 1;; *) echo "$@" >> "${home}/${name}.log";; esac\n`);
    await chmod(path.join(bin, name), 0o755);
  }
  return { bin, home, calls: async agent => readFile(path.join(home, `${agent}.log`), 'utf8').catch(() => '') };
}
function withEnv<T>(patch: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]));
  Object.assign(process.env, patch);
  return work().finally(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('agents: the MCP command fits the install, and agents are connected through their own CLIs or configuration', async () => {
  const tool = '/opt/codiluce';
  assert.deepEqual(mcpLaunch(tool, 'npx', { repo: '/r' }), { command: 'npx', args: ['-y', 'codiluce', 'mcp', '--repo', '/r'] });
  assert.deepEqual(mcpLaunch(tool, 'global'), { command: process.execPath, args: ['/opt/codiluce/bin/codiluce.js', 'mcp'] });
  assert.equal(mcpLaunch(tool, 'checkout').args.at(-2), '/opt/codiluce/src/cli.ts');
  const fake = await fakeAgents();
  const root = await folder();
  await withEnv({ PATH: `${fake.bin}${path.delimiter}${process.env.PATH}`, HOME: fake.home }, async () => {
    const install = { toolDirectory: tool, kind: 'npx' as const };
    const states = async () => (await detectAgents(root, install)).filter(agent => ['claude', 'codex', 'cursor'].includes(agent.id)).map(agent => [agent.id, agent.installed, agent.connected, agent.elsewhere]);
    assert.deepEqual(await states(), [['claude', true, false, undefined], ['codex', true, false, undefined], ['cursor', true, false, undefined]]);
    for (const agent of ['claude', 'codex', 'cursor'] as const) await connectAgent(agent, tool, 'npx', root);
    // Connected only when the server serves this repository through this install.
    await writeFile(path.join(fake.home, '.claude.json'), JSON.stringify({ projects: { [root]: { mcpServers: { codiluce: { command: 'npx', args: ['-y', 'codiluce', 'mcp', '--repo', '/elsewhere/shop'] } } } } }));
    await writeFile(path.join(fake.home, 'codex-server.json'), JSON.stringify({ name: 'codiluce', transport: { type: 'stdio', command: 'node', args: ['/old/codiluce/bin/codiluce.js', 'mcp'] } }));
    assert.deepEqual(await states(), [['claude', true, false, 'connected to shop'], ['codex', true, false, 'connected through another Codiluce install'], ['cursor', true, true, undefined]]);
    await writeFile(path.join(fake.home, '.claude.json'), JSON.stringify({ projects: { [root]: { mcpServers: { codiluce: { command: 'npx', args: ['-y', 'codiluce', 'mcp', '--repo', root] } } } } }));
    await writeFile(path.join(fake.home, 'codex-server.json'), JSON.stringify({ name: 'codiluce', transport: { type: 'stdio', command: 'npx', args: ['-y', 'codiluce', 'mcp', '--repo', root] } }));
    assert.deepEqual(await states(), [['claude', true, true, undefined], ['codex', true, true, undefined], ['cursor', true, true, undefined]], 'Codex bound to this repository serves it too');
  });
  assert.match(await fake.calls('claude'), new RegExp(`mcp add -s local codiluce -- npx -y codiluce mcp --repo ${root.replace(/[/\\]/g, '.')}`));
  assert.match(await fake.calls('codex'), /mcp add codiluce -- npx -y codiluce mcp\n/, 'Codex follows its working directory');
  const cursor = JSON.parse(await readFile(path.join(fake.home, '.cursor/mcp.json'), 'utf8')) as { mcpServers: { codiluce: { args: string[] } } };
  assert.deepEqual(cursor.mcpServers.codiluce.args, ['-y', 'codiluce', 'mcp', '--repo', '${workspaceFolder}']);
});

test('keys are checked with the provider: a working key, a refused one, and no network', async () => {
  const server = createServer((request, response) => {
    const key = String(request.headers['x-api-key'] ?? request.headers.authorization ?? '');
    if (key.includes('bad')) { response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"type":"error","error":{"type":"authentication_error","message":"invalid"}}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[],"has_more":false,"first_id":null,"last_id":null}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await checkKey('anthropic', 'sk-ant-good', { baseUrl: base }), { status: 'valid' });
    assert.equal((await checkKey('anthropic', 'sk-ant-bad', { baseUrl: base })).status, 'invalid');
    assert.deepEqual(await checkKey('openai', 'sk-good', { baseUrl: `${base}/v1` }), { status: 'valid' });
    assert.equal((await checkKey('openai', 'sk-bad', { baseUrl: `${base}/v1` })).status, 'invalid');
  } finally { server.close(); }
  assert.equal((await checkKey('openai', 'sk-x', { baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 500 })).status, 'unchecked');
});

let repository: string;
before(async () => {
  repository = path.join(await folder('codiluce-setup-repo-'), 'shop');
  await cp(fileURLToPath(new URL('./fixtures/repository', import.meta.url)), repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main'); git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'Import');
  for (const n of [1, 2]) { await writeFile(path.join(repository, `notes-${n}.md`), `${n}\n`); git(repository, 'add', '-A'); git(repository, 'commit', '-qm', `Note ${n}`); }
});
function context(stateDirectory: string, env: NodeJS.ProcessEnv): SetupContext {
  return { root: repository, stateDirectory, repositoryName: 'shop', toolDirectory: '/opt/codiluce', kind: 'npx', version: '9.9.9', analysisMs: 2000, base: { repository: { name: 'shop' }, applications: [], maxFileBytes: 1024 }, env };
}

test('setup asks the questions, saves the answers where they belong, and connects the chosen agents', async () => {
  const fake = await fakeAgents();
  const home = await folder();
  const env = { ...process.env, CODILUCE_CONFIG_HOME: home, PATH: `${fake.bin}${path.delimiter}${process.env.PATH}`, HOME: fake.home };
  const state = path.join(repository, '.codiluce');
  assert.equal(setupMode(state, true, env), 'ask');
  assert.equal(setupMode(state, false, env), 'quiet');
  const { terminal, output } = scriptedTerminal([
    [/Language models/, ENTER],                    // no provider
    [/Connect your agent/, `${SPACE}${ENTER}`],     // all three were selected; drop Claude Code
    [/In a new repository/, `${DOWN}${ENTER}`],     // use these answers
  ]);
  const result = await withEnv({ PATH: env.PATH, HOME: env.HOME }, () => runSetup(new Writer(terminal), context(state, env), { mode: 'ask' }));
  assert.equal(result.asked, true);
  assert.equal(result.fileCommits, 3);
  assert.equal(result.settings.history.depth, 'none');
  assert.equal(result.settings.history.precompute, undefined);
  assert.deepEqual(result.connected.filter(item => ['claude', 'codex', 'cursor'].includes(item.agent.id)).map(item => [item.agent.id, item.ok]), [['codex', true], ['cursor', true]]);
  assert.equal(await fake.calls('claude'), '');
  assert.equal(readRepositorySettings(state).history?.depth, 'none');
  assert.equal(readState(state).setup, 1);
  assert.equal(result.gitignore, 'written');
  assert.deepEqual(readUserSettings(env), { defaults: { history: { depth: 'none', onDemand: true }, annotations: { enabled: false, maxCost: 10 } }, askOnFirstRun: false });
  assert.equal(setupMode(state, true, env), undefined, 'asked once per repository');
  assert.match(output(), /History: all 3 commits and file changes ready/);
  assert.doesNotMatch(output(), /Last 3|Last 6 months|s per commit/);
  const cached = JSON.parse(await readFile(path.join(state, 'git-file-history.json'), 'utf8'));
  assert.equal(cached.entries.length, 3);
  assert.ok(cached.entries.every((entry: Record<string, unknown>) => Array.isArray(entry.files) && !entry.entities && !entry.relations));
  await assert.rejects(readFile(path.join(state, 'history.db')));
  printSummary(new Writer(terminal), result, context(state, env));
  assert.match(output(), /all 3 commits and file changes ready/);
  // A new repository then takes these answers without asking.
  const other = await folder();
  assert.equal(setupMode(other, true, env), 'reuse');
  const reused = await runSetup(new Writer(scriptedTerminal().terminal), { ...context(other, env), root: other }, { mode: 'reuse' });
  assert.equal(reused.asked, false);
  assert.equal(readRepositorySettings(other).history?.depth, 'none');
});

test('setup without a terminal decides nothing: saved settings stay, the setup stays due, nothing is spent', async () => {
  const state = await folder();
  const env = { ...process.env, CODILUCE_CONFIG_HOME: await folder() };
  await writeFile(path.join(state, 'config.yml'), stringify(FIXTURE_CONFIG));
  const result = await runSetup(new Writer(scriptedTerminal().terminal), { ...context(state, env), root: await folder() }, { mode: 'quiet' });
  assert.equal(result.asked, false);
  assert.equal(result.describe, undefined);
  assert.deepEqual(readRepositorySettings(state), {}, 'no sections are written for the user');
  assert.equal(readState(state).setup, undefined);
});

test('setup preloads all Git commits without a terminal and preserves explicit architecture settings', async () => {
  const state = await folder();
  const env = { ...process.env, CODILUCE_CONFIG_HOME: await folder() };
  writeRepositorySettings(state, { history: { depth: 1, onDemand: false, precompute: false } });
  const { terminal, output } = scriptedTerminal();
  const result = await runSetup(new Writer(terminal), context(state, env), { mode: 'quiet' });
  assert.equal(result.fileCommits, 3, 'architecture depth does not limit the Git timeline');
  assert.equal(result.describe, undefined);
  assert.deepEqual(readRepositorySettings(state).history, { depth: 1, onDemand: false, precompute: false });
  assert.equal(readState(state).setup, undefined);
  assert.match(output(), /all 3 commits and file changes ready/);
  assert.equal(JSON.parse(await readFile(path.join(state, 'git-file-history.json'), 'utf8')).entries.length, 3);
  await assert.rejects(readFile(path.join(state, 'history.db')));
});

test('setup Git history preload respects read-only cache mode', async () => {
  const state = await folder();
  const env = { ...process.env, CODILUCE_CONFIG_HOME: await folder() };
  const result = await runSetup(new Writer(scriptedTerminal().terminal), { ...context(state, env), readOnly: true }, { mode: 'quiet' });
  assert.equal(result.fileCommits, 3);
  await assert.rejects(readFile(path.join(state, 'git-file-history.json')));
});

test('setup preloads all locally available commits in a shallow clone', async () => {
  const root = path.join(await folder(), 'shallow');
  git(await folder(), 'clone', '--quiet', '--depth=2', `file://${repository}`, root);
  const state = path.join(root, '.codiluce');
  const env = { ...process.env, CODILUCE_CONFIG_HOME: await folder() };
  const { terminal, output } = scriptedTerminal();
  const result = await runSetup(new Writer(terminal), { ...context(state, env), root }, { mode: 'quiet' });
  assert.equal(result.git.shallow, true);
  assert.equal(result.fileCommits, 2);
  assert.match(output(), /shallow clone; indexing all available commits/);
  assert.equal(JSON.parse(await readFile(path.join(state, 'git-file-history.json'), 'utf8')).entries.length, 2);
  await assert.rejects(readFile(path.join(state, 'history.db')));
});

test('background work indexes history through the CLI and reports it on one line', { timeout: 120_000 }, async () => {
  const state = path.join(await folder(), 'state');
  await mkdir(state);
  await writeFile(path.join(state, 'config.yml'), stringify({ repository: { name: 'shop' }, applications: FIXTURE_CONFIG.applications }));
  const { terminal, output } = scriptedTerminal();
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const work = new BackgroundWork({ root: repository, stateDirectory: state, entry: ['--experimental-sqlite', '--no-warnings', '--import', loader, cli], line: new StatusLine(new Writer(terminal)) });
  const result = await work.history(2);
  assert.deepEqual(result, { indexed: 2, failed: 0, skipped: 0 });
  assert.match(output(), /History {2}2 commits indexed/);
  const again = await work.history(2);
  assert.equal(again?.skipped, 2);
  assert.match(output(), /up to date · 2 commits indexed/);
});
