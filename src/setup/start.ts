// `codiluce start`, as people see it in a terminal: a banner, one line per
// step (a spinner while it runs), the first-run setup after the analysis, the
// address of the map, then background work (history, descriptions) on one
// live line. Without a terminal it prints plain text without animation.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { launchLocal, plainReporter, toolDirectory, type AnalysisFacts, type LaunchReporter, type LocalSession } from '../launcher.js';
import { GraphStore } from '../storage/sqlite.js';
import { ProjectionService } from '../projection/service.js';
import { HistoryAccess } from '../history/service.js';
import { ANNOTATIONS_DATABASE, AnnotationStore } from '../ai/store.js';
import { loadAnnotationInput, type TaskName } from '../ai/tasks.js';
import { estimate } from '../ai/runner.js';
import { ExplanationStore } from '../explanations/store.js';
import { BackgroundWork, StatusLine } from './background.js';
import { depthOf, gitFacts, installKind, packageVersion, readRepositorySettings, readState, tilde, writeState, DEFAULT_HISTORY, type HistoryDepth, type InstallKind } from './settings.js';
import { createTerminal, elapsed, Writer, spinner, width, wrapText, type Terminal } from './terminal.js';
import { FIRST_TASKS, printSummary, runSetup, setupMode, type DescribeEstimate, type SetupContext, type SetupResult } from './wizard.js';

export interface StartOptions {
  repo?: string; stateDirectory?: string; port?: number; uiDirectory?: string; buildUi?: boolean; open?: boolean; noCache?: boolean;
  /** --history-indexing: on-demand indexing even when the settings turn it off. */
  historyIndexing?: boolean; readOnly?: boolean;
  /** --yes: no questions (the saved settings, or defaults). */
  yes?: boolean;
  /** --history DEPTH for this start: a number of commits, a Git date, all or none. */
  history?: string;
  signal?: AbortSignal;
  terminal?: Terminal;
  /** Tests: do not run background work. */
  background?: boolean;
}

export async function startCommand(options: StartOptions): Promise<LocalSession & { work?: BackgroundWork }> {
  const terminal = options.terminal ?? createTerminal({ yes: options.yes });
  const w = new Writer(terminal);
  const pretty = !!terminal.output.isTTY;
  const tool = await toolDirectory();
  const version = packageVersion(tool);
  banner(w, version);
  let setup: SetupResult | undefined, kind: InstallKind = 'global', history: HistoryDepth = 'none', facts: AnalysisFacts | undefined, mode: ReturnType<typeof setupMode>;
  const session = await launchLocal({
    repo: options.repo, stateDirectory: options.stateDirectory, port: options.port, uiDirectory: options.uiDirectory, buildUi: options.buildUi,
    open: options.open, noCache: options.noCache, signal: options.signal,
    reporter: pretty ? prettyReporter(w) : plainReporter(console.log),
    beforeServe: async found => {
      facts = found;
      kind = installKind(tool, found.root);
      const state = readState(found.stateDirectory);
      if (state.version && state.version !== version) note(w, pretty, `Codiluce was updated (${state.version} → ${version}). History snapshots from the old version are analyzed again in the background (time only, no cost); descriptions are kept.`);
      if (found.full) writeState(found.stateDirectory, { analysisMs: found.durationMs });
      mode = setupMode(found.stateDirectory, terminal.interactive);
      if (mode) {
        if (pretty) w.write();
        const context: SetupContext = {
          root: found.root, stateDirectory: found.stateDirectory, repositoryName: found.config.repository.name, toolDirectory: tool, kind, version,
          analysisMs: readState(found.stateDirectory).analysisMs ?? (found.full ? found.durationMs : undefined),
          base: { repository: found.config.repository, applications: found.config.applications, maxFileBytes: found.config.maxFileBytes },
          estimateDescriptions: () => describeEstimate(found.root, found.stateDirectory),
        };
        setup = await runSetup(w, context, { mode });
        if (mode === 'ask') { printSummary(w, setup, context); w.write(); }
        else if (mode === 'reuse') note(w, pretty, 'Set up with the answers you keep for new repositories (codiluce setup to change them).');
        else note(w, pretty, 'Not asking questions without a terminal: run codiluce setup to choose how much history to index, add API keys and connect your agent.');
      }
      const settings = readRepositorySettings(found.stateDirectory);
      const override = options.history !== undefined ? depthOf(options.history) : undefined;
      history = override ?? settings.history?.depth ?? (mode === 'quiet' ? 'none' : DEFAULT_HISTORY.depth);
      writeState(found.stateDirectory, { version, lastStart: new Date().toISOString() });
      return { historyIndexing: !options.readOnly && (options.historyIndexing || (settings.history?.onDemand ?? DEFAULT_HISTORY.onDemand)) };
    },
  });
  if (options.background === false || !facts) return session;
  const line = new StatusLine(w);
  const work = new BackgroundWork({ root: session.root, stateDirectory: session.stateDirectory, line });
  options.signal?.addEventListener('abort', () => work.stop(), { once: true });
  void session.closed.then(() => work.stop());
  void background(w, pretty, work, { session, history, setup, kind, version, mode });
  return { ...session, work };
}

async function background(w: Writer, pretty: boolean, work: BackgroundWork, context: { session: LocalSession; history: HistoryDepth; setup?: SetupResult; kind: InstallKind; version: string; mode: ReturnType<typeof setupMode> }): Promise<void> {
  const { session } = context;
  const { c } = w;
  // Explanations and agents: one line, so people know where their agent's answers go.
  const explanations = new ExplanationStore(session.stateDirectory).list();
  if (explanations.length && pretty) w.write(`${c.dim(w.s.done)}  ${c.bold('Explain')}  ${c.muted(`${explanations.length} explanation${explanations.length === 1 ? '' : 's'} in the map's Explain column`)}`);
  // npx keeps the data but not the version: once per version, say how to keep one.
  const state = readState(session.stateDirectory);
  if (context.kind === 'npx' && state.npxHint !== context.version) {
    note(w, pretty, `Running through npx: your results stay in ${tilde(session.stateDirectory)}, but each new version analyzes history again. To keep one version: npm install --global codiluce`);
    writeState(session.stateDirectory, { npxHint: context.version });
  }
  const tasks: Promise<unknown>[] = [];
  if (context.history !== 'none') {
    const git = await gitFacts(session.root);
    if (git.repository && git.topLevel && !git.shallow) tasks.push(work.history(context.history));
  }
  if (context.setup?.describe) tasks.push(work.describe(context.setup.describe.maxCost, context.setup.describe.tasks));
  await Promise.all(tasks);
}

function banner(w: Writer, version: string): void {
  const { c } = w;
  // The Eclipse mark: two filled halves with a horizontal band of light.
  const logo = [
    '     .------.     ',
    "  .-'########'-.  ",
    ' /##############\\ ',
    '                  ',
    ' \\##############/ ',
    "  '-.########.-'  ",
    "     '------'     ",
  ];
  const title = `${c.bold('codiluce')} ${c.dim(version)}`;
  const tagline = c.muted('Bring your code to light');
  const beside = (w.terminal.output.columns ?? 80) >= 52;
  w.write();
  logo.forEach((line, index) => w.write(`  ${c.accent(line)}${beside && index === 2 ? `  ${title}` : beside && index === 4 ? `  ${tagline}` : ''}`.trimEnd()));
  if (!beside) { w.write(`  ${title}`); w.write(`  ${tagline}`); }
  w.write();
  for (const line of wrapText('See how your code fits together. Explore files, flows and dependencies, and understand the impact of changes.', width(w.terminal) - 2)) w.write(`  ${c.muted(line)}`);
  w.write();
}
function note(w: Writer, pretty: boolean, text: string): void {
  if (!pretty) { w.write(text); return; }
  w.note(text);
}
/** Steps as spinners; the repository, state and applications as aligned rows. */
function prettyReporter(w: Writer): LaunchReporter {
  const { c } = w;
  let current: ReturnType<typeof spinner> | undefined;
  let step = 0, stepStarted = 0;
  const labels: Record<number, [string, string]> = { 1: ['Preparing the visualizer', 'Visualizer ready'], 2: ['Analyzing the repository', 'Analyzed'], 3: ['Starting the local server', 'Server started'] };
  const rows: [string, string][] = [];
  let repository = '';
  const flushRows = () => {
    if (!rows.length) return;
    for (const [label, value] of rows.splice(0)) w.write(`  ${c.muted(label.padEnd(12))} ${value}`);
    w.write();
  };
  return {
    info(message) {
      const match = /^(Repository|State|Applications): (.*)$/.exec(message);
      if (match) {
        const apps = [...match[2]!.matchAll(/\s*([^,(]+?) \(([^)]*)\)/g)].map(app => `${app[1]} ${c.dim(`(${app[2]})`)}`);
        const value = match[1] === 'Applications' ? (apps.length ? apps.join(`  ${c.dim('·')}  `) : match[2]!) : tilde(match[2]!);
        // The state directory inside the repository reads as its relative path.
        if (match[1] === 'State' && rows[0] && match[2]!.startsWith(`${repository}/`)) { rows.push(['State', match[2]!.slice(repository.length + 1)]); return; }
        if (match[1] === 'Repository') repository = match[2]!;
        rows.push([match[1] === 'Applications' ? 'Apps' : match[1]!, match[1] === 'Repository' ? c.bold(value) : value]);
        return;
      }
      flushRows();
      if (current) { current.update(message); return; }
      w.write(`   ${c.muted(message)}`);
    },
    step(index) {
      flushRows();
      if (current && step) current.stop(labels[step]![1], 'ok');
      step = index; stepStarted = Date.now();
      current = spinner(w);
      current.start(labels[index]![0]);
    },
    detail(text) { current?.update(`${labels[step]?.[0] ?? ''}${c.dim(` · ${text.replace(/…$/, '')}`)}`); },
    done(text, status = 'ok') {
      if (!current) { w.write(text); return; }
      const indexed = /^Indexed (\d+) entities and (\d+) relationships\.$/.exec(text);
      const took = elapsed(Date.now() - stepStarted);
      current.stop(indexed ? `Analyzed${took ? ` in ${took}` : ''} ${c.dim(`· ${Number(indexed[1]).toLocaleString('en-US')} entities · ${Number(indexed[2]).toLocaleString('en-US')} relationships`)}` : text, status);
      current = undefined; step = 0;
    },
    listening(url) {
      if (current) current.stop(`Map open at ${c.link(c.bold(url))}`, 'ok');
      current = undefined; step = 0;
      w.write(`   ${c.dim('Press Ctrl+C to stop.')}`);
    },
  };
}

/** What describing the code would cost now (offline: no request is sent). */
export async function describeEstimate(root: string, stateDirectory: string): Promise<DescribeEstimate | undefined> {
  const database = path.join(stateDirectory, 'codiluce.db');
  if (!existsSync(database)) return undefined;
  const store = new GraphStore(database, true);
  const access = new HistoryAccess(stateDirectory);
  const annotations = new AnnotationStore(path.join(stateDirectory, ANNOTATIONS_DATABASE));
  try {
    const projection = new ProjectionService(store, { root, history: access.get });
    const input = await loadAnnotationInput(store, projection, annotations, root);
    const planned = await estimate(input, FIRST_TASKS as TaskName[]);
    return { total: planned.total, tasks: planned.tasks.map(task => ({ task: task.task, pending: task.pending, model: task.model })) };
  } finally { annotations.close(); access.close(); store.close(); }
}
