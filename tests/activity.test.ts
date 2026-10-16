import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeHook, repositoryPath } from '../src/activity/normalize.js';
import { ActivityService } from '../src/activity/service.js';
import { handleActivityRoute } from '../src/activity/routes.js';
import { activityLaunch, forwardHook, hookConfiguration } from '../src/activity/hooks.js';
import type { ActivitySnapshot } from '../src/activity/model.js';
import { activityCommand, AgentMetadata, connectionConfiguration } from '../src/activity/providers.js';

let root: string, outside: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codiluce-activity-'));
  outside = await mkdtemp(path.join(tmpdir(), 'codiluce-activity-outside-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;');
  await symlink(outside, path.join(root, 'escape'));
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
const hook = (extra: Record<string, unknown> = {}) => ({ session_id: 'session-one', cwd: root, hook_event_name: 'PreToolUse', tool_use_id: 'read-1', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, ...extra });

test('normalizes Codex patches and simple shell reads, searches and tests without guessing scripts', () => {
  const patch = normalizeHook(root, 'codex', hook({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** Delete File: ../secret\n*** End Patch' } }))!;
  assert.equal(patch.kind, 'edit');
  assert.deepEqual(patch.paths.map(item => item.path), ['src/a.ts', 'src/b.ts']);
  const shell = (command: string) => normalizeHook(root, 'codex', hook({ tool_name: 'Bash', tool_input: { command } }))!;
  assert.equal(shell('cat src/a.ts').kind, 'read');
  assert.deepEqual(shell("sed -n '1,20p' src/a.ts").paths, [{ path: 'src/a.ts', scope: 'file' }]);
  assert.deepEqual(shell("rg -n 'hello world' src").paths, [{ path: 'src', scope: 'directory' }]);
  assert.equal(shell("rg -n 'hello world' src").query, 'hello world');
  assert.equal(shell('npm test').kind, 'test');
  for (const command of ['python script.py', 'rg -g "*.ts" hello src', 'cat $SECRET', 'node -e "readFileSync(\'src/a.ts\')"']) {
    assert.equal(shell(command).kind, 'command'); assert.deepEqual(shell(command).paths, []);
  }
});

test('Codex batched exploration exposes every literal file read, including the reported dashboard regression', () => {
  const command = "sed -n '1,160p' web/e2e/agents.spec.ts && cat playwright.config.ts && sed -n '1,100p' scripts/build-cli.mjs && sed -n '1,170p' src/storage/sqlite.ts && sed -n '1,90p' web/components/Markdown.tsx";
  for (const tool of ['Bash', 'exec_command', 'shell_command']) {
    for (const phase of ['PreToolUse', 'PostToolUse']) {
      const event = normalizeHook(root, 'codex', hook({ tool_name: tool, hook_event_name: phase, tool_input: { command } }))!;
      assert.equal(event.kind, 'read');
      assert.deepEqual(event.paths.map(item => item.path), ['web/e2e/agents.spec.ts', 'playwright.config.ts', 'scripts/build-cli.mjs', 'src/storage/sqlite.ts', 'web/components/Markdown.tsx']);
      assert.equal(event.phase, phase === 'PreToolUse' ? 'started' : 'completed');
    }
  }
});

test('literal batches handle separators and quoting, retain read paths in mixed searches, and honor workdir', () => {
  const shell = (command: string, workdir?: string) => normalizeHook(root, 'codex', hook({ tool_name: 'Bash', tool_input: { command, ...(workdir ? { workdir } : {}) } }))!;
  for (const separator of [' && ', '; ', '\n']) {
    assert.deepEqual(shell(`cat src/a.ts${separator}cat src/b.ts`).paths.map(item => item.path), ['src/a.ts', 'src/b.ts']);
  }
  assert.deepEqual(shell('cat src/a.ts && cat src/a.ts').paths.map(item => item.path), ['src/a.ts']);
  assert.deepEqual(shell("cat 'src/a && b.ts' \"src/a; b.ts\" src/a\\ b.ts").paths.map(item => item.path), ['src/a && b.ts', 'src/a; b.ts', 'src/a b.ts']);
  assert.deepEqual(shell("cat 'src/$literal.ts' &&\n cat src/b.ts;\n").paths.map(item => item.path), ['src/$literal.ts', 'src/b.ts']);
  assert.deepEqual(shell('cat src/\\\na.ts').paths.map(item => item.path), ['src/a.ts']);
  assert.deepEqual(shell("cat src/a.ts && rg -n 'hello|world' src && sed -n '1,20p' src/b.ts").paths, [{ path: 'src/a.ts', scope: 'file' }, { path: 'src/b.ts', scope: 'file' }]);
  assert.deepEqual(shell('head -n 20 a.ts && tail -n 10 b.ts', 'src').paths.map(item => item.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(shell('cat ../secret escape/secret && cat src/a.ts').paths.map(item => item.path), ['src/a.ts']);
  const searches = shell('rg -n login src && grep -n login src');
  assert.equal(searches.kind, 'search');
  assert.equal(searches.query, 'login');
  assert.deepEqual(searches.paths, [{ path: 'src', scope: 'directory' }]);
});

test('common read flags consume their values instead of treating options as files', () => {
  for (const command of [
    'head -n 80 src/a.ts', 'head -n80 src/a.ts', 'head -80 src/a.ts',
    'head --lines 80 src/a.ts', 'head --lines=80 src/a.ts', 'head -q -c 80 src/a.ts',
    'tail -n +20 src/a.ts', 'tail -n+20 src/a.ts', 'tail --bytes=80 src/a.ts',
    'cat -n src/a.ts', 'cat -bns src/a.ts', 'cat --number src/a.ts',
    "sed -n '1,20p' -- src/a.ts",
  ]) {
    const event = normalizeHook(root, 'codex', hook({ tool_name: 'Bash', tool_input: { command } }))!;
    assert.equal(event.kind, 'read', command);
    assert.deepEqual(event.paths, [{ path: 'src/a.ts', scope: 'file' }], command);
  }
  const literal = normalizeHook(root, 'codex', hook({ tool_name: 'Bash', tool_input: { command: 'cat -- -notes.ts' } }))!;
  assert.deepEqual(literal.paths, [{ path: '-notes.ts', scope: 'file' }]);
});

test('ambiguous shell syntax and flags never invent file reads', () => {
  for (const command of [
    'cat src/a.ts | head -n 20', 'cat src/a.ts || cat src/b.ts', 'cat src/a.ts &',
    'cat src/a.ts > src/b.ts', 'cat < src/a.ts', 'cat $(pwd)/src/a.ts', 'cat `pwd`/src/a.ts',
    'cat "$SECRET"', 'cat src/*.ts', 'cat ~/src/a.ts', "cat 'src/a.ts", 'cat src/a.ts &&',
    'cd src && cat a.ts', 'eval cat src/a.ts', 'python script.py && cat src/a.ts', 'cat src/a.ts && ; cat src/b.ts',
    'head -n PRIVATE src/a.ts', 'head --unknown src/a.ts', 'tail -f src/a.ts', 'cat -z src/a.ts',
    "sed -i '1,20p' src/a.ts", "cat src/a.ts\n# cat src/b.ts", 'cat src/a.ts\0',
  ]) {
    const event = normalizeHook(root, 'codex', hook({ tool_name: 'Bash', tool_input: { command } }))!;
    assert.equal(event.kind, 'command', command);
    assert.deepEqual(event.paths, [], command);
  }
});

test('Claude scopes, namespaces, lifecycle, failures and privacy are preserved', () => {
  const read = normalizeHook(root, 'claude-code', hook({ agent_id: 'worker', prompt: 'PRIVATE', tool_response: 'PRIVATE FILE CONTENTS' }))!;
  assert.equal(read.actor, 'claude-code:session-one:worker');
  assert.equal(read.kind, 'read');
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE/);
  assert.notEqual(read.actor, normalizeHook(root, 'codex', hook())!.actor);
  const search = normalizeHook(root, 'claude-code', hook({ tool_name: 'Grep', tool_input: { pattern: 'login', path: 'src' } }))!;
  assert.deepEqual(search.paths, [{ path: 'src', scope: 'directory' }]);
  assert.equal(search.query, 'login');
  assert.equal(normalizeHook(root, 'codex', hook({ hook_event_name: 'PermissionRequest' }))!.status, 'waiting');
  assert.equal(normalizeHook(root, 'codex', hook({ hook_event_name: 'Stop' }))!.status, 'idle');
  assert.equal(normalizeHook(root, 'codex', hook({ hook_event_name: 'SessionEnd' }))!.status, 'finished');
  assert.equal(normalizeHook(root, 'claude-code', hook({ hook_event_name: 'PostToolUseFailure' }))!.phase, 'failed');
  assert.equal(normalizeHook(root, 'codex', hook({ hook_event_name: 'PostToolUse', tool_response: { exit_code: 1 } }))!.phase, 'failed');
});

test('rejects traversal, sibling-prefix paths, symlink escapes and foreign worktrees', () => {
  assert.equal(repositoryPath(root, root, '../secret'), undefined);
  assert.equal(repositoryPath(root, root, `${root}-sibling/secret`), undefined);
  assert.equal(repositoryPath(root, root, 'escape/not-yet-created'), undefined);
  assert.equal(repositoryPath(root, root, 'src/deleted.ts'), 'src/deleted.ts');
  assert.equal(normalizeHook(root, 'codex', hook({ cwd: outside })), undefined);
  assert.equal(normalizeHook(root, 'codex', { hook_event_name: 'Stop', cwd: root }), undefined);
});

test('bounded activity keeps simultaneous tools and agents distinct and expires stale runtime claims', () => {
  const activity = new ActivityService(root, true);
  for (const toolId of ['a', 'b']) activity.record(normalizeHook(root, 'codex', hook({ tool_use_id: toolId }), 100)!);
  activity.record(normalizeHook(root, 'codex', hook({ tool_use_id: 'a', hook_event_name: 'PostToolUse' }), 200)!);
  assert.equal(activity.snapshot(200).sessions[0]!.status, 'running');
  activity.record(normalizeHook(root, 'codex', hook({ tool_use_id: 'b', hook_event_name: 'PermissionRequest' }), 200)!);
  activity.record(normalizeHook(root, 'codex', hook({ tool_use_id: 'c' }), 200)!);
  activity.record(normalizeHook(root, 'codex', hook({ tool_use_id: 'c', hook_event_name: 'PostToolUse' }), 200)!);
  assert.equal(activity.snapshot(200).sessions[0]!.status, 'waiting', 'another completed tool must not clear a pending approval');
  activity.record(normalizeHook(root, 'claude-code', hook({ hook_event_name: 'Stop' }), 200)!);
  assert.equal(activity.snapshot(200).sessions.length, 2);
  assert.equal(activity.snapshot(400_000).sessions[0]!.status, 'unknown');
  for (let n = 0; n < 505; n++) activity.record(normalizeHook(root, 'codex', hook({ session_id: `s-${n}` }), n)!);
  assert.equal(activity.snapshot().events.length, 500);
  assert.equal(activity.snapshot().sessions.length, 100);
  activity.close();
});

test('retained paths follow a refreshed index and session titles survive subsequent tool events', async () => {
  let indexed = false;
  const activity = new ActivityService(root, true, undefined, target => ({ ...target, id: indexed ? 'file' : 'folder', exact: indexed }), async () => 'Provider session title');
  activity.record(normalizeHook(root, 'claude-code', hook({ session_title: 'Fix login', prompt: 'PRIVATE' }))!);
  activity.record(normalizeHook(root, 'claude-code', hook({ hook_event_name: 'PostToolUse' }))!);
  assert.equal(activity.snapshot().sessions[0]!.title, 'Fix login');
  assert.equal(activity.snapshot().events[0]!.paths[0]!.id, 'folder');
  indexed = true;
  assert.equal(activity.snapshot().events[0]!.paths[0]!.id, 'file');
  assert.equal(activity.observedPath(activity.snapshot().events[0]!.id, 0)!.exact, true);
  assert.equal(activity.observedPath('expired', 0), undefined);
  assert.doesNotMatch(JSON.stringify(activity.snapshot()), /PRIVATE|watcher|filesystem/);
  activity.close();
});

test('connection discovery matches this repository and state, without claiming trust from a config file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codiluce-connections-'));
  const state = path.join(directory, '.codiluce');
  const launch = activityLaunch(process.cwd(), 'checkout', 'codex', directory, state);
  const configuration = hookConfiguration('codex', launch);
  await mkdir(path.join(directory, '.codex'));
  await writeFile(path.join(directory, '.codex/hooks.json'), JSON.stringify(configuration));
  try {
    const found = await connectionConfiguration(directory, state, 'codex');
    assert.equal(found.configured, true);
    assert.equal(found.trust, 'unknown');
    assert.ok(found.sources.includes(path.join(directory, '.codex/hooks.json')));
    assert.equal((await connectionConfiguration(directory, state + '-other', 'codex')).configured, false);
    const command = String((configuration.hooks.PreToolUse![0] as { hooks: { command: string }[] }).hooks[0]!.command);
    assert.equal(activityCommand(command, 'codex', directory, state), true);
    assert.equal(activityCommand(command, 'codex', directory + '-sibling', state), false);
    assert.equal(activityCommand(command, 'claude-code', directory, state), false);
    await mkdir(path.join(directory, '.claude'));
    await writeFile(path.join(directory, '.claude/settings.local.json'), JSON.stringify({ ...hookConfiguration('claude-code', activityLaunch(process.cwd(), 'checkout', 'claude-code', directory, state)), disableAllHooks: true }));
    assert.equal((await connectionConfiguration(directory, state, 'claude-code')).disabled, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider trust is explicit, changed definitions require review, and checks refresh saved state', async () => {
  const state = path.join(root, '.codiluce');
  const launch = activityLaunch(process.cwd(), 'checkout', 'codex', root, state);
  const configuration = hookConfiguration('codex', launch);
  const command = String((configuration.hooks.PreToolUse![0] as { hooks: { command: string }[] }).hooks[0]!.command);
  let trustStatus = 'trusted';
  const metadata = new AgentMetadata(root, state, async () => ({ hooks: [{ command, enabled: true, trustStatus }] }));
  try {
    assert.equal((await metadata.connections())[0]!.trust, 'trusted');
    trustStatus = 'modified';
    assert.equal((await metadata.connections())[0]!.trust, 'modified');
    trustStatus = 'untrusted';
    assert.equal((await metadata.connections())[0]!.trust, 'needs-review');
  } finally { metadata.close(); }
});

test('HTTP stream, quiet bridge and generated lightweight hook work end to end; writes require the header', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'codiluce-hook-state-'));
  const service = new ActivityService(root, true);
  const server = createServer((request, response) => { void handleActivityRoute(service, request, response, new URL(request.url!, 'http://localhost')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(path.join(state, 'serve.json'), JSON.stringify({ url }));
  const abort = new AbortController();
  try {
    const stream = await fetch(`${url}/api/agents/stream`, { signal: abort.signal });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    await reader.read();
    const body = { provider: 'codex', payload: hook() };
    assert.equal((await fetch(`${url}/api/agents/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    await forwardHook('codex', state, (async function* () { yield JSON.stringify(hook({ tool_name: 'Bash', tool_input: { command: "head -n 20 src/a.ts && sed -n '1,10p' src/b.ts" } })); })());
    const data = new TextDecoder().decode((await reader.read()).value);
    assert.match(data, /session-one/);
    const launch = activityLaunch(process.cwd(), 'checkout', 'claude-code', root, state);
    const child = execFile(launch.command, launch.args, { timeout: 10000 });
    child.stdin!.end(JSON.stringify(hook({ tool_name: 'Edit' })));
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => { let stdout = '', stderr = ''; child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.on('data', chunk => stderr += chunk); child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Hook exited ${code}: ${stderr}`)) : resolve({ stdout, stderr })); });
    assert.deepEqual(result, { stdout: '', stderr: '' });
    const snapshot = await (await fetch(`${url}/api/agents`)).json() as ActivitySnapshot;
    assert.deepEqual(snapshot.events.map(event => event.provider), ['codex', 'claude-code']);
    assert.equal(snapshot.events[0]!.kind, 'read');
    assert.deepEqual(snapshot.events[0]!.paths.map(item => item.path), ['src/a.ts', 'src/b.ts']);
    assert.ok(hookConfiguration('codex', launch).hooks.PreToolUse);
    assert.ok(hookConfiguration('claude-code', launch).hooks.PostToolUseFailure);
    assert.equal(hookConfiguration('codex', launch).hooks.PostToolUseFailure, undefined);
    const reveal = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'activity' }, body: JSON.stringify({ eventId: snapshot.events[0]!.id, index: 0 }) };
    assert.equal((await fetch(`${url}/api/agents/reveal`, reveal)).status, 403, 'servers without a reveal handler cannot refresh an index');
    abort.abort(); await reader.cancel().catch(() => undefined);
    service.close();
    const disabled = new ActivityService(root, false);
    const readonlyServer = createServer((request, response) => { void handleActivityRoute(disabled, request, response, new URL(request.url!, url)); });
    await new Promise<void>(resolve => readonlyServer.listen(0, '127.0.0.1', resolve));
    try {
      const readonlyUrl = `http://127.0.0.1:${(readonlyServer.address() as { port: number }).port}`;
      assert.equal((await fetch(`${readonlyUrl}/api/agents/events`, { method: 'POST' })).status, 403);
      assert.equal((await fetch(`${readonlyUrl}/api/agents/reveal`, reveal)).status, 403);
    }
    finally { readonlyServer.closeAllConnections(); await new Promise<void>(resolve => readonlyServer.close(() => resolve())); }
  } finally { abort.abort(); service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(state, { recursive: true, force: true }); }
});

test('bridge fails open with malformed input or a stopped map', async () => {
  await forwardHook('codex', root, (async function* () { yield '{'; })());
  await forwardHook('codex', root, (async function* () { yield '{}'; })());
  const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', '--import', 'tsx', 'src/activity/hook-cli.ts', '--bad-option']);
  assert.equal(stdout, '');
});
