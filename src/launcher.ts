// One-command local startup: prepare the UI, index the working tree, and
// serve both on localhost. The caller owns signals; closing a session releases
// the HTTP connections and databases without terminating the caller's process.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { createInspectionServer } from './api/server.js';
import { exists, loadConfig } from './core/config.js';
import { indexRepository } from './pipeline/index.js';
import { GraphStore } from './storage/sqlite.js';
import { keyFiles } from './setup/settings.js';

export interface LaunchOptions {
  repo?: string;
  stateDirectory?: string;
  /** Omit to try 4300 and then other available ports; 0 asks the OS to choose. */
  port?: number;
  uiDirectory?: string;
  buildUi?: boolean;
  open?: boolean;
  noCache?: boolean;
  historyIndexing?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** How progress is shown (default: plain lines through `log`). */
  reporter?: LaunchReporter;
  /** Runs after the analysis and before the server starts (the first-run setup); may turn on-demand history indexing on or off. */
  beforeServe?: (facts: AnalysisFacts) => Promise<{ historyIndexing?: boolean } | void>;
}
/** What the analysis found, for the first-run setup. */
export interface AnalysisFacts {
  root: string; stateDirectory: string; config: Awaited<ReturnType<typeof loadConfig>>;
  /** How long the analysis took, and whether it analyzed everything (no cache): then it is what one commit of history costs. */
  durationMs: number; full: boolean;
  entities: number; relations: number; files: number; errors: number;
}
/** Progress of a start, shown as plain lines or as spinners (src/setup/start.ts). */
export interface LaunchReporter {
  info(message: string): void;
  step(index: number, text: string): void;
  detail(text: string): void;
  done(text: string, status?: 'ok' | 'error'): void;
  listening(url: string): void;
}
export function plainReporter(log: (message: string) => void): LaunchReporter {
  return {
    info: log, step: (index, text) => log(`[${index}/3] ${text}…`), detail: text => log(`  ${text}`), done: text => log(text),
    listening: url => { log(`Visualizer: ${url}`); log('Press Ctrl+C to stop.'); },
  };
}
export interface LocalSession {
  url: string;
  root: string;
  stateDirectory: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

/** Locate assets from either src/launcher.ts or the compiled dist/src/launcher.js. */
export async function toolDirectory(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (await exists(manifest)) {
      const data = JSON.parse(await readFile(manifest, 'utf8')) as { name?: string };
      if (data.name === 'codiluce' || data.name?.endsWith('/codiluce')) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the Codiluce installation');
    directory = parent;
  }
}

/** Use shipped assets; in a source checkout, build them on the first launch. */
export async function prepareVisualizer(directory: string, options: Pick<LaunchOptions, 'uiDirectory' | 'buildUi' | 'signal' | 'log'> = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.uiDirectory === 'none') throw new Error('start requires the visualizer; use serve --ui none for API-only mode');
  const ui = options.uiDirectory ? path.resolve(options.uiDirectory) : path.join(directory, 'web/out');
  if (options.uiDirectory) {
    if (options.buildUi) throw new Error('--build-ui cannot be combined with --ui; it builds the bundled visualizer');
    if (!await exists(path.join(ui, 'index.html'))) throw new Error(`No built visualizer at ${ui}`);
    return ui;
  }
  if (!options.buildUi && await exists(path.join(ui, 'index.html'))) return ui;
  if (!await exists(path.join(directory, 'web/app/page.tsx'))) {
    throw new Error(options.buildUi
      ? '--build-ui is only available in a Codiluce source checkout. The npm package includes a prebuilt visualizer.'
      : 'The bundled visualizer is missing. Reinstall Codiluce or choose an existing build with --ui PATH.');
  }
  options.log?.('Building the visualizer (this is only needed on the first run or with --build-ui)…');
  const next = createRequire(path.join(directory, 'package.json')).resolve('next/dist/bin/next');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [next, 'build', 'web'], { cwd: directory, stdio: 'inherit', signal: options.signal });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Visualizer build failed (${signal ?? `exit ${code}`})`)));
  });
  options.signal?.throwIfAborted();
  if (!await exists(path.join(ui, 'index.html'))) throw new Error('The visualizer build did not produce web/out/index.html');
  return ui;
}

/** Bind directly, avoiding a separate port probe and its race with another process. */
export async function listenLocally(server: Server, port = 4300, fallback = true): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? port : attempt < 10 && port + attempt <= 65535 ? port + attempt : 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('The local server has no TCP address');
      return address.port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (!fallback || candidate === 0) throw new Error(`Port ${candidate} is already in use. Choose another with --port, or omit --port to choose automatically.`);
    }
  }
}

/** Browser opening is optional; its failure must not take the visualizer down. */
export async function openBrowser(url: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('No desktop session');
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 5000, windowsHide: true, signal }, error => error ? reject(error) : resolve());
  });
}

export async function launchLocal(options: LaunchOptions = {}): Promise<LocalSession> {
  const log = options.log ?? console.log;
  const report = options.reporter ?? plainReporter(log);
  const check = () => options.signal?.throwIfAborted();
  check();
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('--port must be an integer between 0 and 65535');
  const requestedRoot = options.repo ?? process.cwd();
  if (/^(?:https?:\/\/|git@)/i.test(requestedRoot)) throw new Error('start accepts a local repository directory');
  let root: string;
  try { root = await realpath(requestedRoot); }
  catch { throw new Error(`Repository directory not found: ${requestedRoot}`); }
  if (!(await stat(root)).isDirectory()) throw new Error(`Repository must be a directory: ${root}`);
  const stateDirectory = path.resolve(options.stateDirectory ?? path.join(root, '.codiluce'));
  const config = await loadConfig(root, stateDirectory);
  check();
  report.info(`Repository: ${root}`);
  report.info(`State: ${stateDirectory}`);
  report.info(config.applications.length ? `Applications: ${config.applications.map(app => `${app.name} (${[...app.frameworks, ...app.frameworks.length ? [] : app.ecosystems].join(', ') || 'no manifest'})`).join(', ')}`
    : `No applications detected (no package.json, composer.json, pyproject.toml, go.mod, Cargo.toml… manifest); showing a file map. Applications can be configured in ${path.join(stateDirectory, 'config.yml')}.`);
  report.step(1, 'Preparing the visualizer');
  const uiDirectory = await prepareVisualizer(await toolDirectory(), { ...options, log: message => report.detail(message) });
  check();
  await mkdir(stateDirectory, { recursive: true });
  const configFile = path.join(stateDirectory, 'config.yml');
  if (!await exists(configFile)) {
    try {
      await writeFile(configFile, stringify({ repository: config.repository, applications: config.applications, ignore: [], maxFileBytes: config.maxFileBytes }), { flag: 'wx' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  report.step(2, 'Analyzing the repository');
  const started = Date.now();
  let hits = 0;
  const graph = await indexRepository(root, {
    config, stateDirectory,
    onProgress: name => { check(); report.detail(`Analyzing ${name}…`); },
    ...(options.noCache ? {} : { cache: path.join(stateDirectory, 'cache'), onCache: event => { if (event.hit) { hits++; report.detail(`${event.unit}: unchanged, reused from the cache`); } } }),
  });
  const durationMs = Date.now() - started;
  check();
  const database = path.join(stateDirectory, 'codiluce.db');
  const writer = new GraphStore(database);
  try { writer.save(graph); } finally { writer.close(); }
  const errors = graph.diagnostics.filter(item => item.severity === 'error');
  report.done(`Indexed ${graph.entities.length} entities and ${graph.relations.length} relationships.`);
  if (errors.length) report.info(`Analysis reported ${errors.length} error${errors.length === 1 ? '' : 's'}; the available results and diagnostics are shown in the visualizer.`);
  const prepared = await options.beforeServe?.({ root, stateDirectory, config, durationMs, full: hits === 0, entities: graph.entities.length, relations: graph.relations.length, files: graph.entities.filter(entity => entity.type === 'file').length, errors: errors.length });
  check();
  report.step(3, 'Starting the local server');
  const store = new GraphStore(database, true);
  let server: Server;
  try { server = createInspectionServer(store, { root, stateDirectory, uiDirectory, maxFileBytes: config.maxFileBytes, historyIndexing: prepared?.historyIndexing ?? options.historyIndexing, keyFiles: keyFiles(stateDirectory, await toolDirectory()) }); }
  catch (error) { store.close(); throw error; }
  let closing = false;
  const closed = new Promise<void>(resolve => server.once('close', () => { store.close(); resolve(); }));
  const close = () => {
    if (!closing) { closing = true; server.close(); server.closeAllConnections(); }
    return closed;
  };
  try {
    const port = await listenLocally(server, options.port ?? 4300, options.port === undefined);
    const onAbort = () => { void close(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    server.once('close', () => options.signal?.removeEventListener('abort', onAbort));
    check();
    const url = `http://127.0.0.1:${port}/`;
    report.listening(url);
    if (options.open !== false) {
      try { await openBrowser(url, options.signal); }
      catch { if (!options.signal?.aborted) report.info(`Could not open the browser automatically. Open ${url} in your browser.`); }
    }
    check();
    return { url, root, stateDirectory, closed, close };
  } catch (error) { await close(); throw error; }
}
