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
      if (data.name === 'archipelago') return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the Archipelago installation');
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
  const check = () => options.signal?.throwIfAborted();
  check();
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('--port must be an integer between 0 and 65535');
  const requestedRoot = options.repo ?? process.cwd();
  if (/^(?:https?:\/\/|git@)/i.test(requestedRoot)) throw new Error('start accepts a local repository directory');
  let root: string;
  try { root = await realpath(requestedRoot); }
  catch { throw new Error(`Repository directory not found: ${requestedRoot}`); }
  if (!(await stat(root)).isDirectory()) throw new Error(`Repository must be a directory: ${root}`);
  const stateDirectory = path.resolve(options.stateDirectory ?? path.join(root, '.archipelago'));
  const config = await loadConfig(root, stateDirectory);
  check();
  log(`Repository: ${root}`);
  log(`State: ${stateDirectory}`);
  log(config.applications.length ? `Applications: ${config.applications.map(app => `${app.name} (${app.type})`).join(', ')}`
    : `No Next.js or Laravel applications detected; showing a file map. Applications can be configured in ${path.join(stateDirectory, 'config.yml')}.`);
  log('[1/3] Preparing the visualizer…');
  const uiDirectory = await prepareVisualizer(await toolDirectory(), { ...options, log });
  check();
  await mkdir(stateDirectory, { recursive: true });
  const configFile = path.join(stateDirectory, 'config.yml');
  if (!await exists(configFile)) {
    try {
      await writeFile(configFile, stringify({ repository: config.repository, applications: config.applications, ignore: [], maxFileBytes: config.maxFileBytes }), { flag: 'wx' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  log('[2/3] Analyzing the repository…');
  const graph = await indexRepository(root, {
    config, stateDirectory,
    onProgress: name => { check(); log(`  Analyzing ${name}…`); },
    ...(options.noCache ? {} : { cache: path.join(stateDirectory, 'cache'), onCache: event => { if (event.hit) log(`  ${event.unit}: unchanged, reused from the cache`); } }),
  });
  check();
  const database = path.join(stateDirectory, 'archipelago.db');
  const writer = new GraphStore(database);
  try { writer.save(graph); } finally { writer.close(); }
  const errors = graph.diagnostics.filter(item => item.severity === 'error');
  log(`Indexed ${graph.entities.length} entities and ${graph.relations.length} relationships.`);
  if (errors.length) log(`Analysis reported ${errors.length} error${errors.length === 1 ? '' : 's'}; the available results and diagnostics are shown in the visualizer.`);
  log('[3/3] Starting the local server…');
  const store = new GraphStore(database, true);
  let server: Server;
  try { server = createInspectionServer(store, { root, stateDirectory, uiDirectory, maxFileBytes: config.maxFileBytes, historyIndexing: options.historyIndexing }); }
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
    log(`Visualizer: ${url}`);
    log('Press Ctrl+C to stop.');
    if (options.open !== false) {
      try { await openBrowser(url, options.signal); }
      catch { if (!options.signal?.aborted) log(`Could not open the browser automatically. Open ${url} in your browser.`); }
    }
    check();
    return { url, root, stateDirectory, closed, close };
  } catch (error) { await close(); throw error; }
}
