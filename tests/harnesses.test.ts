import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARNESSES, HARNESS_IDS, harnessId, runtimeProfile, sessionKey, type HarnessId } from '../src/harnesses/registry.js';
import { normalizeHook } from '../src/activity/normalize.js';
import { ActivityService } from '../src/activity/service.js';
import { handleActivityRoute } from '../src/activity/routes.js';
import { hookConfiguration, activityLaunch } from '../src/activity/hooks.js';
import { integrationConfiguration, planIntegration, applyIntegration } from '../src/harnesses/setup.js';
import { editConfiguration, parseConfiguration, writeReviewedFile, valueAt, upsertConfigurationItems } from '../src/harnesses/config.js';
import { connectionConfiguration } from '../src/activity/providers.js';
import { nativeActivityFixture } from './harness-fixtures.js';
import { CHARACTERS } from '../web/lib/crew-characters.js';

let directory: string, root: string, state: string, home: string;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'codiluce-harnesses-')); root = path.join(directory, 'repo with spaces'); state = path.join(directory, 'state'); home = path.join(directory, 'home');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(state); await mkdir(home);
  await writeFile(path.join(root, 'src/a.ts'), 'export const value = 1;');
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

const native = (id: HarnessId, cwd = root) => nativeActivityFixture(id, cwd);

test('registry gives twelve stable identities, runtime profiles and original character coverage', () => {
  assert.equal(HARNESSES.length, 12); assert.equal(new Set(HARNESS_IDS).size, 12);
  for (const item of HARNESSES) {
    assert.equal(harnessId(item.id), item.id); assert.ok(item.profiles.length); assert.ok(item.docs.length);
    assert.throws(() => runtimeProfile(item.id, 'unregistered'));
    if (!['codex', 'claude-code'].includes(item.id)) {
      const sprite = CHARACTERS[item.character]!; assert.ok(sprite, item.id); assert.equal(sprite.rows.length, 14);
      for (const row of sprite.rows) { assert.equal(row.length, 12, `${item.id}: ${row}`); for (const pixel of row) assert.ok(pixel === '.' || sprite.colors[pixel]); }
    }
  }
  assert.equal(harnessId('claude'), 'claude-code'); assert.equal(harnessId('cascade'), 'windsurf'); assert.equal(harnessId('not-a-harness'), undefined);
  assert.equal(sessionKey('codex', 'old:session'), 'codex:old:session');
  assert.notEqual(sessionKey('pi', 'session:child'), sessionKey('pi', 'session', 'child'));
});

for (const id of HARNESS_IDS) test(`${id}: native observations share path, privacy, lifecycle and root validation`, () => {
  const event = normalizeHook(root, id, native(id))!;
  assert.ok(event, id); assert.equal(event.provider, id); assert.equal(event.sessionId, 'session:one');
  assert.equal(event.kind, 'read'); assert.equal(event.phase, 'completed'); assert.deepEqual(event.paths, [{ path: 'src/a.ts', scope: 'file' }]);
  assert.equal(normalizeHook(root, id, native(id, path.join(directory, 'foreign'))), undefined);
  assert.equal(JSON.stringify(event).includes('tool_input'), false);
});

test('error, identity, parent attribution, permission and completion boundaries stay conservative', () => {
  const failed = normalizeHook(root, 'hermes', { ...native('hermes'), extra: { status: 'blocked', tool_call_id: 'c' } })!;
  assert.equal(failed.phase, 'failed'); assert.equal(failed.status, 'error');
  const turn = normalizeHook(root, 'windsurf', { ...native('windsurf'), agent_action_name: 'post_cascade_response' })!;
  assert.equal(turn.status, 'idle'); assert.equal(turn.turnId, 'turn:one'); assert.equal(turn.toolId, undefined);
  const child = normalizeHook(root, 'cursor', { conversation_id: 'parent', hook_event_name: 'subagentStop', workspace_roots: [root], child_conversation_id: 'child' })!;
  assert.equal(child.sessionId, 'parent'); assert.equal(child.agentId, 'child'); assert.equal(child.lifecycle, 'child-end');
  assert.equal(normalizeHook(root, 'cursor', { conversation_id: 'parent', hook_event_name: 'subagentStop', workspace_roots: [root], subagent_type: 'reviewer' }), undefined);
  assert.equal(normalizeHook(root, 'openclaw', { ...native('openclaw'), context: { agentId: 'main' } }), undefined, 'a configured role is not a session ID');
  assert.equal(normalizeHook(root, 'cursor', { ...native('cursor'), workspace_roots: [root, '/another'] }), undefined, 'multiroot relative paths need actual cwd');
  for (const id of ['cursor', 'antigravity'] as const) {
    const profile = runtimeProfile(id), config = hookConfiguration(id, { command: '/node', args: ['observer'] });
    assert.ok(!profile.activity.events.some(name => /^(preToolUse|PreToolUse|subagentStart)$/.test(name)));
    assert.ok(!JSON.stringify(config).includes('auto_approve'));
  }
});

test('configuration edits preserve JSONC/JSON5 comments, TOML and YAML data and reject malformed files', () => {
  for (const text of ['// Keep\n{"other":1 /* yes */}\n', '{ other: 1, // keep\n}', '{"hooks":{"Stop":[{"command":"other"}, /* keep */]}}']) {
    const changed = editConfiguration(text, 'jsonc', ['mcpServers', 'codiluce', 'command'], '/node');
    assert.equal(valueAt(parseConfiguration(changed, 'jsonc'), ['mcpServers', 'codiluce', 'command']), '/node');
    assert.ok(changed.includes('keep') || changed.includes('Keep'));
    const appended = editConfiguration(changed, 'jsonc', ['hooks', 'Stop'], [{ command: 'ours' }], true);
    assert.ok(appended.includes('keep') || appended.includes('Keep'));
    assert.ok(Array.isArray(valueAt(parseConfiguration(appended, 'jsonc'), ['hooks', 'Stop'])));
  }
  let toml = '# keep\n[other]\nvalue = 2\n[mcp_servers.codiluce]\ncommand = "old"\nargs = [\n "old",\n]\n# keep below\n[mcp_servers.other]\ncommand = "other"\n';
  toml = editConfiguration(toml, 'toml', ['mcp_servers', 'codiluce', 'command'], 'new');
  toml = editConfiguration(toml, 'toml', ['mcp_servers', 'codiluce', 'args'], ['a', 'b']);
  assert.match(toml, /# keep below/); assert.equal(valueAt(parseConfiguration(toml, 'toml'), ['mcp_servers', 'other', 'command']), 'other');
  const yaml = editConfiguration('# keep\nmodel: test\n', 'yaml', ['mcp_servers', 'codiluce', 'command'], '/node');
  assert.match(yaml, /# keep/); assert.equal(parseConfiguration(yaml, 'yaml').model, 'test');
  for (const malformed of ['{broken', '{"x":1,"x":2}', '{"x":process.env.SECRET}', '[]']) assert.throws(() => parseConfiguration(malformed, 'jsonc'));
});

test('all runtime setup plans merge idempotently in isolated homes without changing unrelated settings', async () => {
  for (const item of HARNESSES) for (const profile of item.profiles) {
    const scopeRoot = path.join(root, `setup-${profile.id}`), scopeHome = path.join(home, profile.id), scopeState = path.join(scopeRoot, '.codiluce');
    await mkdir(scopeRoot, { recursive: true });
    const options = { profile: profile.id, home: scopeHome, env: {} };
    const initial = await planIntegration(item.id, '/opt/codiluce', 'global', scopeRoot, scopeState, options);
    await applyIntegration(initial);
    const repeat = await planIntegration(item.id, '/opt/codiluce', 'global', scopeRoot, scopeState, options);
    assert.ok(repeat.changes.every(file => file.before === file.after), profile.id);
    assert.equal(initial.integration.files.some(file => file.purpose === 'mcp'), true);
    for (const change of initial.changes) if (change.executable) assert.equal((await stat(change.path)).mode & 0o777, 0o700);
    const snippet = initial.integration.files.find(file => file.purpose === 'mcp')!;
    const entry = valueAt(parseConfiguration(snippet.content, profile.mcp.format), [...profile.mcp.key, 'codiluce']); assert.ok(entry, profile.id);
    assert.ok(!initial.integration.instructions.join(' ').includes('auto-approve'));
  }
});

test('setup refuses concurrent changes and symlink destinations rather than replacing them', async () => {
  const file = path.join(directory, 'reviewed.json'); await writeFile(file, '{}');
  await assert.rejects(writeReviewedFile(file, 'old', 'new'), /changed since preview/);
  const link = path.join(directory, 'linked.json'); await symlink(file, link);
  await assert.rejects(writeReviewedFile(link, '{}', 'new'), /non-file/);
  assert.equal(await readFile(file, 'utf8'), '{}');
});

test('hook updates replace owned duplicates while preserving unrelated hooks and comments', () => {
  for (const ending of ['', ',']) {
    const source = `{"hooks":{"Stop":[{"command":"other"}, /* keep this */ {"command":"owned-old"},{"command":"owned-old"}${ending}]}}`;
    const changed = upsertConfigurationItems(source, 'jsonc', ['hooks', 'Stop'], [{ command: 'owned-new' }], value => String((value as { command?: string }).command).startsWith('owned-'));
    assert.match(changed, /keep this/);
    assert.equal(JSON.stringify(valueAt(parseConfiguration(changed, 'jsonc'), ['hooks', 'Stop'])), JSON.stringify([{ command: 'other' }, { command: 'owned-new' }]));
    assert.equal(upsertConfigurationItems(changed, 'jsonc', ['hooks', 'Stop'], [{ command: 'owned-new' }], value => String((value as { command?: string }).command).startsWith('owned-')), changed);
  }
});

test('all twelve native observations travel through the HTTP API, and stable source IDs deduplicate', async () => {
  const service = new ActivityService(root, true), server = createServer((request, response) => void handleActivityRoute(service, request, response, new URL(request.url!, 'http://localhost')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const id of HARNESS_IDS) {
      const response = await fetch(`${url}/api/agents/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'activity' }, body: JSON.stringify({ provider: id, payload: native(id) }) });
      assert.equal(response.status, 202, id);
    }
    assert.equal(service.snapshot().sessions.length, 12);
    const event = normalizeHook(root, 'pi', { ...native('pi'), source_event_id: 'same' })!; service.record(event); service.record(event);
    assert.equal(service.snapshot().events.length, 13);
  } finally { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('generated Pi/OpenCode/OpenClaw plugins execute their native callback contracts without mutations', async () => {
  const observations: { provider: HarnessId; payload: unknown }[] = [];
  const server = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); observations.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(202).end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(state, 'serve.json'), JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  try {
    for (const id of ['pi', 'opencode', 'openclaw'] as const) {
      const file = integrationConfiguration(id, '/tool', 'global', root, state, { home }).files.find(file => file.purpose === 'plugin')!;
      const modulePath = path.join(directory, `${id}.mjs`); await writeFile(modulePath, file.content);
      const module = await import(pathToFileURL(modulePath).href);
      if (id === 'pi') {
        const callbacks = new Map(); module.default({ on: (name: string, callback: unknown) => callbacks.set(name, callback) });
        const event = { toolName: 'read', toolCallId: 'one', input: { path: 'src/a.ts', content: 'private' } }, original = JSON.stringify(event);
        assert.equal(callbacks.get('tool_call')(event, { cwd: root, sessionManager: { getSessionId: () => 'plugin' } }), undefined); assert.equal(JSON.stringify(event), original);
      } else if (id === 'opencode') {
        const hooks = await module.Codiluce({ directory: root });
        const input = { sessionID: 'plugin', callID: 'one', tool: 'read' }, output = { args: { filePath: 'src/a.ts' } };
        await hooks['tool.execute.before'](input, output); await hooks['tool.execute.after'](input, {}); assert.equal(output.args.filePath, 'src/a.ts');
      } else {
        const callbacks = new Map(); module.default.register({ config: { agents: { defaults: { workspace: root } } }, on: (name: string, callback: unknown) => callbacks.set(name, callback) });
        assert.equal(callbacks.get('after_tool_call')({ toolName: 'read', params: { path: 'src/a.ts' }, toolCallId: 'one' }, { sessionId: 'plugin', agentId: 'main' }), undefined);
      }
    }
    const until = Date.now() + 4000; while (observations.length < 4 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(observations.length, 4); assert.ok(!JSON.stringify(observations).includes('private'));
    for (const observation of observations) assert.ok(normalizeHook(root, observation.provider, observation.payload));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('hook subprocesses provide native no-op output even with a stopped map', async () => {
  const execute = promisify(execFile);
  for (const [id, profile, event, expected] of [['cursor', 'cursor', 'stop', '{}'], ['cline', 'cline-legacy', 'PostToolUse', '{"cancel":false}'], ['antigravity', 'antigravity', 'Stop', '{"decision":"stop"}']] as const) {
    const launch = activityLaunch(process.cwd(), 'checkout', id, root, path.join(directory, 'stopped'));
    const child = execFile(launch.command, [...launch.args, '--profile', profile, '--event', event], { timeout: 5000 });
    child.stdin!.end('broken');
    const output = await new Promise<string>((resolve, reject) => { let out = ''; child.stdout!.on('data', data => out += data); child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Exit ${code}`)) : resolve(out)); });
    assert.equal(output.trim(), expected);
  }
});
