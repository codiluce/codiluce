import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { detectApplications, exists, loadConfig } from './core/config.js';
import { indexRepository } from './pipeline/index.js';
import { GraphStore } from './storage/sqlite.js';
import { createInspectionServer } from './api/server.js';
import { HISTORY_DATABASE, indexHistory, type HistoryProgress } from './history/indexer.js';
import { HistoryStore } from './history/store.js';
import { annotateCommand } from './ai/command.js';
import { launchLocal, toolDirectory } from './launcher.js';

const HELP = `Codiluce — Bring your code to light
Code and architecture visualizer

npm start -- [PATH] [--state-dir PATH] [--port N] [--no-open] [--build-ui]
npm run codiluce -- start [PATH] [--repo PATH] [--state-dir PATH] [--port N]
                            [--no-open] [--build-ui] [--ui PATH] [--no-cache] [--history-indexing]
npm run codiluce -- init [--repo PATH] [--state-dir PATH]
npm run codiluce -- index [--repo PATH] [--state-dir PATH] [--no-cache]
npm run codiluce -- inspect [summary|entities|entity|relations|relation|diagnostics] [options]
npm run codiluce -- serve [--repo PATH] [--state-dir PATH] [--port 4300] [--ui PATH|none] [--history-indexing] [--read-only]
npm run codiluce -- history index [--repo PATH] [--state-dir PATH] [--ref BRANCH] [--limit N]
                       [--since DATE] [--commits SHA,SHA] [--jobs N] [--all-parents] [--pr-metadata github]
npm run codiluce -- history status [--repo PATH] [--state-dir PATH]
npm run codiluce -- annotate [--repo PATH] [--state-dir PATH] [--tasks files,flows,commits,folders,domains,overview,chapters]
                       [--estimate] [--pilot] [--max-cost 10] [--concurrency 6] [--force]

Options: --search TEXT --type TYPE --id ID --path PATH --parent ID
         --direction incoming|outgoing|both --severity info|warning|error
         --code CODE --limit 1..500 --offset NUMBER

State defaults to <repo>/.codiluce. inspect outputs JSON; serve is a local
API that also serves the built visualizer (web/out, see npm run build:web)
unless --ui none. It only reads the graph (it keeps the map's layout slots in
<state>/layout.json); --read-only refuses on-demand history indexing even with
--history-indexing. index persists diagnostics and exits 2
for analyzer errors. index reuses the analysis of applications whose files
did not change from <state>/cache (bounded; safe to delete; --no-cache
re-analyzes everything).

start prepares the visualizer (building it if missing), analyzes the local
repository and opens the map in your browser. PATH defaults to the current
directory. Existing configuration and analysis caches are reused. Omit --port
to choose an available port starting at 4300; --port 0 asks the OS to choose.
--no-open leaves browser opening to you; --build-ui rebuilds the bundled UI.

history index analyzes past commits of a branch (first-parent history by
default) into <state>/history.db for the timeline. Commits are read from Git
objects into scratch directories; the repository is not modified. Already
indexed commits are skipped. --pr-metadata github reads merged pull requests
from the GitHub API (GITHUB_TOKEN for private repositories). serve
--history-indexing lets the map index a missing commit on request.

annotate describes files, folders, flows, domains, commits and history
chapters with OpenAI models (OPENAI_API_KEY from the environment or a .env in
this workspace or the state directory) into <state>/annotations.db, in
ASD-STE100 Simplified Technical English. It always estimates the cost first,
measured by one pilot request per small task, and does not run when the
estimate exceeds --max-cost (US dollars, default 10). --estimate stops after
the estimate (add --pilot to measure). Unchanged inputs are never sent again.
`;
async function main(): Promise<void> {
  const string = { type: 'string' } as const;
  const boolean = { type: 'boolean' } as const;
  const options = { tasks: string, 'max-cost': string, concurrency: string, estimate: boolean, pilot: boolean, force: boolean, repo: string, 'state-dir': string, port: string, ui: string, search: string, type: string, id: string, path: string, parent: string, direction: string, severity: string, code: string, limit: string, offset: string, ref: string, since: string, commits: string, jobs: string, 'pr-metadata': string, 'all-parents': boolean, 'history-indexing': boolean, 'no-cache': boolean, 'no-open': boolean, 'build-ui': boolean, 'read-only': boolean, help: boolean };
  const { positionals, values } = parseArgs({ allowPositionals: true, options });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  if (command === 'start') {
    if (positionals.length > 2) throw new Error('start accepts one repository directory');
    if (positionals[1] && values.repo) throw new Error('Choose a repository with PATH or --repo, not both');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const session = await launchLocal({
        repo: positionals[1] ?? values.repo, stateDirectory: values['state-dir'],
        port: values.port !== undefined ? Number(values.port) : undefined,
        uiDirectory: values.ui, buildUi: !!values['build-ui'], open: !values['no-open'],
        noCache: !!values['no-cache'], historyIndexing: !!values['history-indexing'] && !values['read-only'],
        signal: controller.signal,
      });
      await session.closed;
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return;
  }
  const root = await realpath(String(values.repo ?? process.cwd()));
  const stateDirectory = path.resolve(String(values['state-dir'] ?? path.join(root, '.codiluce')));
  const database = path.join(stateDirectory, 'codiluce.db');
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
    const cache: { hits: string[]; misses: string[] } = { hits: [], misses: [] };
    const graph = await indexRepository(root, {
      stateDirectory, onProgress: name => console.error(`Analyzing ${name}…`),
      ...(values['no-cache'] ? {} : { cache: path.join(stateDirectory, 'cache'), onCache: event => { (event.hit ? cache.hits : cache.misses).push(`${event.analyzer}:${event.unit}`); if (event.hit) console.error(`  ${event.unit}: unchanged, reused from the cache (${event.ms} ms)`); } }),
    });
    await mkdir(stateDirectory, { recursive: true });
    const store = new GraphStore(database);
    try { store.save(graph); console.log(JSON.stringify({ database, ...store.summary(), ...(values['no-cache'] ? {} : { cache }) }, null, 2)); } finally { store.close(); }
    if (graph.diagnostics.some(diagnostic => diagnostic.severity === 'error')) process.exitCode = 2;
    return;
  }
  if (command === 'annotate') {
    if (!await exists(database)) throw new Error('No graph cache; run init and index first');
    process.exitCode = await annotateCommand({
      root, stateDirectory, keyDirectories: [fileURLToPath(new URL('..', import.meta.url)), stateDirectory],
      tasks: values.tasks as string | undefined, estimateOnly: !!values.estimate, pilot: !!values.pilot,
      maxCost: values['max-cost'] !== undefined ? Number(values['max-cost']) : 10, concurrency: values.concurrency !== undefined ? Number(values.concurrency) : 6, force: !!values.force,
    });
    return;
  }
  if (command === 'history') {
    const action = positionals[1] ?? 'status';
    if (action === 'status') {
      const file = path.join(stateDirectory, HISTORY_DATABASE);
      if (!await exists(file)) throw new Error('No history yet; run history index first');
      const history = new HistoryStore(file, true);
      try { console.log(JSON.stringify({ database: file, ...history.status() }, null, 2)); } finally { history.close(); }
      return;
    }
    if (action !== 'index') throw new Error(`Unknown history action ${action}`);
    const positive = (name: string) => { const value = values[name as keyof typeof values]; if (value === undefined) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`); return number; };
    if (values['pr-metadata'] !== undefined && values['pr-metadata'] !== 'github') throw new Error('--pr-metadata supports: github');
    await mkdir(stateDirectory, { recursive: true });
    const started = Date.now();
    const result = await indexHistory({
      root, stateDirectory, ref: values.ref as string | undefined, firstParent: !values['all-parents'], limit: positive('limit'), since: values.since as string | undefined,
      commits: values.commits ? String(values.commits).split(',').map(item => item.trim()).filter(Boolean) : undefined, jobs: positive('jobs'),
      pullRequests: values['pr-metadata'] === 'github' ? 'github' : undefined, onProgress: reportHistory,
    });
    console.log(JSON.stringify({ database: path.join(stateDirectory, HISTORY_DATABASE), ...result, seconds: Math.round((Date.now() - started) / 100) / 10 }, null, 2));
    if (result.failed) process.exitCode = 2;
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
    const ui = values.ui === 'none' ? undefined : values.ui ? path.resolve(String(values.ui)) : path.join(await toolDirectory(), 'web/out');
    const uiDirectory = ui && await exists(path.join(ui, 'index.html')) ? ui : undefined;
    if (values.ui && values.ui !== 'none' && !uiDirectory) { store.close(); throw new Error(`No built UI at ${ui}; run npm run build:web`); }
    const server = createInspectionServer(store, { root, stateDirectory, uiDirectory, maxFileBytes, historyIndexing: !!values['history-indexing'] && !values['read-only'] });
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
function reportHistory(event: HistoryProgress): void {
  const commit = (sha: string, date: string, subject: string) => `${sha.slice(0, 8)} ${date.slice(0, 10)} ${subject.length > 56 ? `${subject.slice(0, 55)}…` : subject}`;
  if (event.type === 'plan') console.error(`History of ${event.ref} (${event.head.slice(0, 8)}): ${event.timeline} first-parent commits, ${event.targets} selected, ${event.pending} to analyze with ${event.jobs} process${event.jobs === 1 ? '' : 'es'}`);
  else if (event.type === 'indexed') { const stats = event.snapshot.stats; console.error(`[${String(event.done).padStart(String(event.total).length)}/${event.total}] ${commit(event.commit.sha, event.commit.authoredAt, event.commit.subject)} · ${stats.entities} entities, ${stats.newVersions} new versions${stats.applicationSource === 'detected' ? ` · applications detected: ${stats.applications.join(', ') || 'none'}` : stats.substitutedApplications ? ` · ${Object.entries(stats.substitutedApplications).map(([name, at]) => `${name} at ${at}/`).join(', ')}` : ''} · ${((stats.durationMs ?? 0) / 1000).toFixed(1)}s`); }
  else if (event.type === 'failed') console.error(`[${event.done}/${event.total}] ${commit(event.commit.sha, event.commit.authoredAt, event.commit.subject)} FAILED: ${event.error}`);
  else if (event.type === 'layout') console.error(`Timeline layout registry: ${event.snapshots} snapshots (${event.rebuilt ? 'rebuilt' : 'extended'}, ${event.durationMs} ms)`);
  else if (event.type === 'pull-requests') console.error(`Pull requests: ${event.count} merged PRs recorded`);
  else console.error(`Warning: ${event.message}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
