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
import { FlowStore, FLOWS_DATABASE } from '../../src/storage/flows.js';

const port = Number(process.env.E2E_PORT ?? 4399);
const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
const ui = fileURLToPath(new URL('../out', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'atlas-e2e-'));
await cp(fixture, root, { recursive: true });
await mkdir(path.join(root, '.archipelago'));
await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
const store = new GraphStore(path.join(root, '.archipelago/archipelago.db'));
store.save(await indexRepository(root));
const state = path.join(root, '.archipelago');
createInspectionServer(store, { root, stateDirectory: state, uiDirectory: ui, flows: new FlowStore(path.join(state, FLOWS_DATABASE)) }).listen(port, '127.0.0.1', () => console.log(`e2e server on ${port}`));
