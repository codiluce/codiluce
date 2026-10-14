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
createInspectionServer(store, { root, stateDirectory: path.join(root, '.codiluce'), uiDirectory: ui }).listen(port, '127.0.0.1', () => console.log(`e2e server on ${port}`));
