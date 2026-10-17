// Serves the built UI and API for browser tests against a fresh index of the
// fixture repository (copied to a temporary directory).
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { indexRepository } from '../../src/pipeline/index.js';
import { GraphStore } from '../../src/storage/sqlite.js';
import { createInspectionServer } from '../../src/api/server.js';
import { composeTour } from '../../src/explanations/scenes.js';
import { HARNESS_IDS } from '../../src/harnesses/registry.js';

const port = Number(process.env.E2E_PORT ?? 4399);
const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
const ui = fileURLToPath(new URL('../out', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'atlas-e2e-'));
await cp(fixture, root, { recursive: true });
await cp(fileURLToPath(new URL('../../tests/fixtures/structure', import.meta.url)), path.join(root, 'structure'), { recursive: true });
await mkdir(path.join(root, '.codiluce'));
await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
const store = new GraphStore(path.join(root, '.codiluce/codiluce.db'));
store.save(await indexRepository(root));
// One explanation, as an agent would save it over MCP (explanations.spec.ts).
await mkdir(path.join(root, '.codiluce/explanations'));
await writeFile(path.join(root, '.codiluce/explanations/2026-10-14-how-login-works-e2e0.md'), [
  '---', 'title: How login works', 'subject:', '  kind: flow', '  ref: flow:POST /auth/login', 'source: agent', 'agent: e2e', '---', '',
  '<!-- codiluce:question at=2026-10-14T08:00:00.000Z -->', 'How does login work?', '',
  '<!-- codiluce:answer at=2026-10-14T08:00:00.000Z -->',
  'The [login form](frontend/src/components/LoginForm.tsx) calls [the login request](flow:POST%20/auth/login), answered by [login](backend/app/Http/Controllers/AuthController.php#AuthController.login). [Gone](backend/nope.php).', '',
].join('\n'));
// And one told as a tour: a map scene, then a diagram with a symbol inside its file (explanations.spec.ts).
const form = 'frontend/src/components/LoginForm.tsx', controller = 'backend/app/Http/Controllers/AuthController.php';
await writeFile(path.join(root, '.codiluce/explanations/2026-10-16-login-in-scenes-e2e1.md'), [
  '---', 'title: Login in scenes', 'subject:', '  kind: question', 'source: agent', 'agent: e2e', 'updatedAt: 2026-10-16T08:00:00.000Z', '---', '',
  '<!-- codiluce:answer at=2026-10-16T08:00:00.000Z -->',
  composeTour('Login, in two scenes.', [
    { title: 'Where login lives', view: 'map', markdown: `The [form](${form}) and [the controller](${controller}).` },
    { title: 'How the form reaches the server', markdown: `The form posts to [login](${controller}#AuthController.login).`, focus: [form, controller, `${controller}#AuthController.login`, 'backend/app/Services/AuthService.php'], start: form,
      arrows: [{ from: form, to: `${controller}#AuthController.login`, label: 'posts the credentials to' }, { from: controller, to: 'backend/app/Services/AuthService.php', label: 'asks' }] },
  ]), '',
].join('\n'));
// Isolated provider history: browser tests must never import the developer's chats.
const codexHome = path.join(root, '.codiluce/agent-fixtures/codex'), claudeHome = path.join(root, '.codiluce/agent-fixtures/claude');
await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
await mkdir(path.join(claudeHome, 'projects/repo'), { recursive: true });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
await writeFile(path.join(codexHome, 'sessions/codex-e2e.jsonl'), jsonl([
  { type: 'session_meta', timestamp: '2026-10-15T10:00:00.000Z', payload: { id: 'codex-e2e', cwd: root, title: 'Preserve readable session history' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${root}\n\n<INSTRUCTIONS>\nAlways show this injected setup marker.\n</INSTRUCTIONS>\n<environment_context>cwd=${root}</environment_context>` }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'How should we browse our login session history?' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'Read', call_id: 'read-form', arguments: JSON.stringify({ file_path: 'frontend/src/components/LoginForm.tsx' }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'read-form', output: 'Login form code.' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Keep session history readable as Markdown, with original messages and tool activity.' }] } },
]));
await writeFile(path.join(claudeHome, 'projects/repo/claude-e2e.jsonl'), jsonl([
  { type: 'user', uuid: 'claude-user', sessionId: 'claude-e2e', cwd: root, timestamp: '2026-10-15T09:00:00.000Z', message: { content: 'Add a session viewer.' } },
  { type: 'assistant', uuid: 'claude-edit', cwd: root, message: { content: [{ type: 'tool_use', id: 'edit-form', name: 'Edit', input: { file_path: 'frontend/src/components/LoginForm.tsx' } }] } },
  { type: 'user', uuid: 'claude-result', cwd: root, message: { content: [{ type: 'tool_result', tool_use_id: 'edit-form', content: 'Updated successfully.' }] } },
  { type: 'ai-title', aiTitle: 'Add a human-readable session viewer', sessionId: 'claude-e2e' },
]));
createInspectionServer(store, { root, stateDirectory: path.join(root, '.codiluce'), uiDirectory: ui, conversationSources: { codexHome, claudeHome, harnessHomes: Object.fromEntries(HARNESS_IDS.map(id => [id, path.join(root, '.codiluce/agent-fixtures', id)])) } }).listen(port, '127.0.0.1', () => console.log(`e2e server on ${port}`));
