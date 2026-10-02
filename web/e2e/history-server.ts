// Serves the built UI and API for the history browser tests: the scripted
// Git history of tests/history-fixture.ts, indexed into a timeline.
import { createInspectionServer } from '../../src/api/server.js';
import { historyConfig, indexHistory, revisionConfig } from '../../src/history/indexer.js';
import { indexRepository } from '../../src/pipeline/index.js';
import { GraphStore } from '../../src/storage/sqlite.js';
import { createHistoryFixture } from '../../tests/history-fixture.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.E2E_HISTORY_PORT ?? 4398);
const ui = fileURLToPath(new URL('../out', import.meta.url));
const fixture = await createHistoryFixture();
await indexHistory({ root: fixture.root, stateDirectory: fixture.state, ref: 'main', jobs: 1 });
const store = new GraphStore(path.join(fixture.state, 'archipelago.db'));
store.save(await indexRepository(fixture.root, { config: (await revisionConfig(await historyConfig(fixture.root, fixture.state), fixture.root)).config }));
createInspectionServer(store, { root: fixture.root, stateDirectory: fixture.state, uiDirectory: ui }).listen(port, '127.0.0.1', () => console.log(`e2e history server on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void fixture.cleanup().finally(() => process.exit(0)));
