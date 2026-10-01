import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { detectApplications, exists, loadConfig } from './core/config.js';
import { indexRepository } from './pipeline/index.js';
import { GraphStore } from './storage/sqlite.js';
import { createInspectionServer } from './api/server.js';

const HELP = `Archipelago — Phase 1 graph inspection

npm run archipelago -- init [--repo PATH] [--state-dir PATH]
npm run archipelago -- index [--repo PATH] [--state-dir PATH]
npm run archipelago -- inspect [summary|entities|entity|relations|relation|diagnostics] [options]
npm run archipelago -- serve [--repo PATH] [--state-dir PATH] [--port 4300] [--ui PATH|none]

Options: --search TEXT --type TYPE --id ID --path PATH --parent ID
         --direction incoming|outgoing|both --severity info|warning|error
         --code CODE --limit 1..500 --offset NUMBER

State defaults to <repo>/.archipelago. inspect outputs JSON; serve is a local,
read-only API that also serves the built visualizer (web/out, see
npm run build:web) unless --ui none. index persists diagnostics and exits 2
for analyzer errors.
`;
async function main(): Promise<void> {
  const string = { type: 'string' } as const;
  const options = { repo: string, 'state-dir': string, port: string, ui: string, search: string, type: string, id: string, path: string, parent: string, direction: string, severity: string, code: string, limit: string, offset: string, help: { type: 'boolean' } as const };
  const { positionals, values } = parseArgs({ allowPositionals: true, options });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  const root = await realpath(String(values.repo ?? process.cwd()));
  const stateDirectory = path.resolve(String(values['state-dir'] ?? path.join(root, '.archipelago')));
  const database = path.join(stateDirectory, 'archipelago.db');
  if (command === 'init') {
    await mkdir(stateDirectory, { recursive: true });
    const configFile = path.join(stateDirectory, 'config.yml');
    if (!await exists(configFile)) {
      await writeFile(configFile, stringify({ repository: { name: path.basename(root) }, applications: await detectApplications(root), ignore: [], maxFileBytes: 1024 * 1024 }), { flag: 'wx' });
    }
    const store = new GraphStore(database); store.close();
    console.log(JSON.stringify({ config: configFile, database }, null, 2));
    return;
  }
  if (command === 'index') {
    const graph = await indexRepository(root, { stateDirectory, onProgress: name => console.error(`Analyzing ${name}…`) });
    await mkdir(stateDirectory, { recursive: true });
    const store = new GraphStore(database);
    try { store.save(graph); console.log(JSON.stringify({ database, ...store.summary() }, null, 2)); } finally { store.close(); }
    if (graph.diagnostics.some(diagnostic => diagnostic.severity === 'error')) process.exitCode = 2;
    return;
  }
  if (command !== 'inspect' && command !== 'serve') throw new Error(`Unknown command ${command}`);
  if (!await exists(database)) throw new Error('No graph cache; run init and index first');
  const store = new GraphStore(database, true);
  if (command === 'serve') {
    const port = Number(values.port ?? 4300);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { store.close(); throw new Error('Invalid port'); }
    let maxFileBytes: number | undefined;
    try { maxFileBytes = (await loadConfig(root, stateDirectory)).maxFileBytes; } catch (error) { console.error(`Configuration unavailable (${error instanceof Error ? error.message : String(error)}); source viewing uses the default size limit`); }
    const ui = values.ui === 'none' ? undefined : values.ui ? path.resolve(String(values.ui)) : fileURLToPath(new URL('../web/out', import.meta.url));
    const uiDirectory = ui && await exists(path.join(ui, 'index.html')) ? ui : undefined;
    if (values.ui && values.ui !== 'none' && !uiDirectory) { store.close(); throw new Error(`No built UI at ${ui}; run npm run build:web`); }
    const server = createInspectionServer(store, { root, stateDirectory, uiDirectory, maxFileBytes });
    server.once('error', error => { store.close(); console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Graph inspection API: http://127.0.0.1:${port}/api`);
      console.log(uiDirectory ? `Visualizer: http://127.0.0.1:${port}/` : 'Visualizer UI not built (npm run build:web); API only');
    });
    const stop = () => server.close(() => { store.close(); process.exit(0); });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  try {
    const pagination = { limit: values.limit ? Number(values.limit) : undefined, offset: values.offset ? Number(values.offset) : undefined };
    let result: unknown;
    switch (positionals[1] ?? 'summary') {
      case 'summary': result = store.summary(); break;
      case 'entities': result = store.entities({ ...pagination, search: values.search as string | undefined, type: values.type as string | undefined, path: values.path as string | undefined, parentId: values.parent as string | undefined }); break;
      case 'entity': if (!values.id) throw new Error('entity requires --id'); result = store.entity(String(values.id)); break;
      case 'relations': {
        const direction = String(values.direction ?? 'both');
        if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('Invalid direction');
        result = store.relations({ ...pagination, entityId: values.id as string | undefined, direction: direction as 'incoming' | 'outgoing' | 'both', type: values.type as string | undefined }); break;
      }
      case 'relation': if (!values.id) throw new Error('relation requires --id'); result = store.relation(String(values.id)); break;
      case 'diagnostics': result = store.diagnostics({ ...pagination, severity: values.severity as string | undefined, code: values.code as string | undefined }); break;
      default: throw new Error('Unknown inspection query');
    }
    if (result === undefined) throw new Error('No matching entity/relation');
    console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
