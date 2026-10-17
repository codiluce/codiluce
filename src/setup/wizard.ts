// The first-run setup: a few questions after the first analysis (so the
// estimates are real) and before the browser opens. History depth, API keys
// (checked, kept outside the repository), describing the code (with its cost),
// connecting agents over MCP, and whether new repositories ask again. Every
// answer can be changed later with `codiluce setup`. Without a terminal the
// saved settings (or safe defaults) are used, and nothing is spent.
import path from 'node:path';
import { cpus } from 'node:os';
import { connectAgent, detectAgents, mcpJson, mcpLaunch, type Agent, type AgentId } from './agents.js';
import { checkKey, keyShape, PROVIDERS, type Provider } from './keys.js';
import {
  credentialsFile, DEFAULT_ANNOTATIONS, DEFAULT_HISTORY, findKey, gitFacts, hideFromGit, keyFiles, readRepositorySettings, readState, readUserSettings,
  SETUP_VERSION, tilde, writeDotenv, writeRepositorySettings, writeState, writeUserSettings,
  type AnnotationSettings, type GitFacts, type HistoryDepth, type HistorySettings, type InstallKind, type RepositorySettings,
} from './settings.js';
import { about, confirm, multiselect, select, spinner, text, type Choice, type Writer } from './terminal.js';

/** What describing the code would cost now, from the offline estimate (`annotate --estimate`). */
export interface DescribeEstimate { total: number; tasks: { task: string; pending: number; model: string }[] }
export interface SetupContext {
  root: string; stateDirectory: string; repositoryName: string;
  toolDirectory: string; kind: InstallKind; version: string;
  /** Duration of an analysis without a cache: what one commit of history costs. */
  analysisMs?: number;
  /** Writes `config.yml` with the detected applications when it does not exist yet. */
  base?: { repository: unknown; applications: unknown; maxFileBytes: number };
  estimateDescriptions?: () => Promise<DescribeEstimate | undefined>;
  env?: NodeJS.ProcessEnv;
}
export interface SetupResult {
  settings: Required<RepositorySettings>;
  /** Describe now, in the background, within this cap. */
  describe?: { maxCost: number; tasks: string[]; estimate: number };
  connected: { agent: Agent; ok: boolean; error?: string }[];
  keys: { provider: Provider; file: string }[];
  gitignore: Awaited<ReturnType<typeof hideFromGit>>;
  git: GitFacts;
  /** Asked now (false: the saved settings or the defaults were used). */
  asked: boolean;
}
/** Tasks run on the first description: those that need no history (commits and chapters wait for `codiluce annotate`). */
export const FIRST_TASKS = ['files', 'flows', 'folders', 'domains', 'overview'];
const JOBS = Math.min(6, Math.max(1, Math.floor(cpus().length / 2)));

/** The setup is due on a repository's first start (and once after the upgrade that brought it). */
export function setupDue(stateDirectory: string): boolean { return (readState(stateDirectory).setup ?? 0) < SETUP_VERSION; }

/**
 * How the setup runs: `ask` the questions; `reuse` the answers the user keeps
 * for new repositories (they chose not to be asked again); or `quiet` without a
 * terminal, where saved settings stay and nothing is decided for the user.
 */
export type SetupMode = 'ask' | 'reuse' | 'quiet';
/** The mode for a start: questions only on a repository's first start, in a terminal, unless the user keeps answers for new repositories. */
export function setupMode(stateDirectory: string, interactive: boolean, env: NodeJS.ProcessEnv = process.env): SetupMode | undefined {
  if (!setupDue(stateDirectory)) return undefined;
  if (!interactive) return 'quiet';
  return readUserSettings(env).askOnFirstRun === false ? 'reuse' : 'ask';
}
/** Ask the questions (or apply settings without asking), then save the answers. */
export async function runSetup(w: Writer, context: SetupContext, options: { mode: SetupMode }): Promise<SetupResult> {
  const env = context.env ?? process.env;
  const { c } = w;
  const saved = readRepositorySettings(context.stateDirectory);
  const user = readUserSettings(env);
  const git = await gitFacts(context.root);
  const ask = options.mode === 'ask';
  const files = keyFiles(context.stateDirectory, context.kind === 'checkout' ? context.toolDirectory : undefined, env);
  let history: HistorySettings = saved.history ?? user.defaults?.history ?? DEFAULT_HISTORY;
  let annotations: AnnotationSettings = saved.annotations ?? user.defaults?.annotations ?? DEFAULT_ANNOTATIONS;
  const result: SetupResult = { settings: { history, annotations }, connected: [], keys: [], gitignore: 'present', git, asked: ask };

  if (ask) {
    w.write(`${c.dim(w.s.start)}  ${c.bold(`Set up Codiluce for ${context.repositoryName}`)}`);
    w.note('Enter keeps the default. Change any of this later with codiluce setup.');
    w.rail();
    const depth = await askHistory(w, git, context.analysisMs, history.precompute ? history.depth : 'none');
    history = { ...history, depth, ...(depth !== 'none' ? { precompute: true } : history.precompute !== undefined ? { precompute: false } : {}) };
    const keys = await askKeys(w, files, env);
    result.keys = keys.saved;
    if (keys.openai) {
      const describe = await askDescribe(w, context, annotations);
      annotations = describe.settings;
      if (describe.run) result.describe = describe.run;
    }
    result.connected = await askAgents(w, context);
    const defaults = await select<'ask' | 'reuse'>(w, {
      message: 'In a new repository',
      choices: [{ value: 'ask', label: 'Ask me again', hint: 'these questions, on its first start' }, { value: 'reuse', label: 'Use these answers', hint: 'and do not ask' }],
      initial: user.askOnFirstRun === false ? 'reuse' : 'ask',
    });
    writeUserSettings({ defaults: { history: { ...history }, annotations: { enabled: annotations.enabled, maxCost: annotations.maxCost } }, askOnFirstRun: defaults === 'ask' }, env);
  }
  result.settings = { history, annotations };
  // Without a terminal, nothing is decided for the user: saved choices stay, and the setup stays due.
  if (options.mode !== 'quiet' || saved.history || saved.annotations) writeRepositorySettings(context.stateDirectory, result.settings, context.base);
  result.gitignore = await hideFromGit(context.root, context.stateDirectory);
  if (options.mode !== 'quiet') writeState(context.stateDirectory, { setup: SETUP_VERSION });
  return result;
}

async function askHistory(w: Writer, git: GitFacts, analysisMs: number | undefined, initial: HistoryDepth): Promise<HistoryDepth> {
  const { c } = w;
  if (!git.repository) { w.note('History: not a Git repository, so there is no history to index.', c.muted); return 'none'; }
  if (git.shallow) { w.note('History: this is a shallow clone, so most commits are missing. Run git fetch --unshallow, then codiluce setup, to index history.', c.muted); return 'none'; }
  if (!git.topLevel) { w.note('History: indexing needs the top-level folder of the Git repository; start Codiluce there to index history.', c.muted); return 'none'; }
  const per = analysisMs ?? 0;
  const time = (commits: number) => per ? about(Math.ceil(commits / JOBS) * per) : '';
  const count = (commits: number) => `${commits.toLocaleString('en-US')} commit${commits === 1 ? '' : 's'}`;
  const last = Math.min(50, git.commits);
  const choices: Choice<HistoryDepth>[] = [
    { value: 'none', label: 'Git evolution; architecture on demand', hint: 'recommended · no full analysis per commit' },
    { value: 50, label: `Last ${last} commit${last === 1 ? '' : 's'}`, hint: time(last) },
    ...(git.recent > last && git.recent < git.commits ? [{ value: git.recentSince, label: 'Last 6 months', hint: [count(git.recent), time(git.recent)].filter(Boolean).join(' · ') }] : []),
    ...(git.commits > last ? [{ value: 'all', label: `All ${count(git.commits)}`, hint: time(git.commits) }] : []),
  ];
  const detail = `${git.branch ?? 'This branch'} has ${count(git.commits)}. File evolution comes directly from Git. Full architecture snapshots are generated when requested. Optionally precompute snapshots in the background${per ? ` (about ${Math.max(1, Math.round(per / 1000))} s per commit, ${JOBS} at a time)` : ''}.`;
  const initialValue = choices.some(choice => choice.value === initial) ? initial : typeof initial === 'number' ? 50 : initial;
  return select<HistoryDepth>(w, { message: 'History', detail, choices, initial: initialValue });
}

async function askKeys(w: Writer, files: string[], env: NodeJS.ProcessEnv): Promise<{ anthropic: boolean; openai: boolean; saved: SetupResult['keys'] }> {
  const { c } = w;
  const found = { anthropic: findKey('ANTHROPIC_API_KEY', files, env), openai: findKey('OPENAI_API_KEY', files, env) };
  const where = (source: string) => source === 'environment' ? 'in the environment' : `in ${tilde(source)}`;
  const choices: Choice<Provider>[] = (['anthropic', 'openai'] as const).map(provider => ({
    value: provider, label: PROVIDERS[provider].name,
    hint: found[provider] ? `key found ${where(found[provider]!.source)}` : `for ${PROVIDERS[provider].uses}`,
  }));
  const chosen = await multiselect<Provider>(w, {
    message: 'Language models (optional)',
    detail: 'Ask questions in the map, and have the code described in plain English. Your own key, billed by the provider; Codiluce works without them. Keys are kept on this computer, outside the repository.',
    choices, initial: (['anthropic', 'openai'] as const).filter(provider => found[provider]), none: 'none',
  });
  const entered: Partial<Record<Provider, string>> = {};
  for (const provider of chosen) {
    if (found[provider]) continue;
    const info = PROVIDERS[provider];
    for (;;) {
      const key = await text(w, { message: `${info.name} API key`, detail: `Create one at ${info.console}`, secret: true, allowEmpty: true, validate: value => keyShape(provider, value) });
      if (!key) break;
      const check = spinner(w);
      check.start(`Checking the key with ${info.name}…`);
      const verdict = await checkKey(provider, key);
      if (verdict.status === 'invalid') {
        check.stop(`${verdict.message}. Try again, or leave it empty to skip.`, 'error');
        continue;
      }
      check.stop(verdict.status === 'valid' ? `${info.name} key works` : verdict.message, verdict.status === 'valid' ? 'ok' : 'skip');
      entered[provider] = key;
      break;
    }
  }
  const saved: SetupResult['keys'] = [];
  if (Object.keys(entered).length) {
    const place = await select<'user' | 'repository'>(w, {
      message: 'Keep the key',
      choices: [
        { value: 'user', label: 'For every repository on this computer', hint: `${tilde(credentialsFile(env))}, readable only by you` },
        { value: 'repository', label: 'For this repository only', hint: `${tilde(files[1]!)}, hidden from Git` },
      ],
    });
    const file = place === 'user' ? credentialsFile(env) : files[1]!;
    writeDotenv(file, Object.fromEntries(Object.entries(entered).map(([provider, key]) => [PROVIDERS[provider as Provider].variable, key!])));
    for (const provider of Object.keys(entered) as Provider[]) saved.push({ provider, file });
    w.note(`Saved to ${tilde(file)}, readable only by you.`, c.green);
    w.rail();
  }
  return { anthropic: !!(found.anthropic || entered.anthropic), openai: !!(found.openai || entered.openai), saved };
}

async function askDescribe(w: Writer, context: SetupContext, current: AnnotationSettings): Promise<{ settings: AnnotationSettings; run?: SetupResult['describe'] }> {
  const estimating = spinner(w);
  estimating.start('Estimating what describing the code would cost…');
  let estimate: DescribeEstimate | undefined;
  try { estimate = await context.estimateDescriptions?.(); } catch { estimate = undefined; }
  if (!estimate) { estimating.stop('No estimate yet (it needs an analysis); run codiluce annotate --estimate later', 'skip'); return { settings: current }; }
  const pending = estimate.tasks.filter(task => task.pending > 0);
  if (!pending.length) { estimating.stop('The code is already described', 'ok'); return { settings: { ...current, enabled: true } }; }
  estimating.stop(`Estimated: about $${money(estimate.total)}`, 'ok');
  const cap = Math.max(0.25, Math.ceil(estimate.total * 1.5 * 100) / 100);
  const what = pending.map(task => `${task.pending.toLocaleString('en-US')} ${task.task === 'overview' ? 'overview' : task.task}`).join(', ');
  const choice = await select<'later' | 'now'>(w, {
    message: 'Describe the code',
    detail: `OpenAI describes ${what} in plain English, for the inspector and the Features panel: about $${money(estimate.total)} on your account, stopped at $${money(cap)}. Descriptions are saved in .codiluce/ and are not paid for again unless the code changes. Commit descriptions wait for codiluce annotate, once history is indexed.`,
    choices: [{ value: 'later', label: 'Not now', hint: 'codiluce annotate any time' }, { value: 'now', label: 'Describe it now', hint: `in the background · up to $${money(cap)}` }],
    initial: 'later',
  });
  if (choice === 'later') return { settings: current };
  return { settings: { ...current, enabled: true }, run: { maxCost: cap, tasks: FIRST_TASKS, estimate: estimate.total } };
}
function money(value: number): string { return value < 0.01 ? value.toFixed(3) : value.toFixed(2); }

async function askAgents(w: Writer, context: SetupContext): Promise<SetupResult['connected']> {
  const { c } = w;
  const looking = spinner(w);
  looking.start('Looking for coding agents…');
  const agents = await detectAgents(context.root);
  const installed = agents.filter(agent => agent.installed);
  looking.stop(installed.length ? `Found ${installed.map(agent => agent.name).join(', ')}` : 'No coding agent found (Claude Code, Codex, Cursor)', installed.length ? 'ok' : 'skip');
  const launch = mcpLaunch(context.toolDirectory, context.kind);
  if (!installed.length) {
    w.note('Any MCP client can use Codiluce. Add this server to its configuration:', c.muted);
    for (const line of mcpJson(launch).split('\n')) w.write(`${c.dim(w.s.rail)}    ${c.link(line)}`);
    return [];
  }
  const choices: Choice<AgentId>[] = agents.map(agent => ({
    value: agent.id, label: agent.name,
    ...(agent.installed ? agent.connected ? { hint: 'already connected · select to connect it again' } : { hint: agent.scope } : { disabled: 'not found' }),
  }));
  const chosen = await multiselect<AgentId>(w, {
    message: 'Connect your agent',
    detail: 'Add Codiluce\'s MCP server, so your agent reads the index (flows, impact, history, source) and saves what it explains in the map\'s Explain column. Then ask it, for example: "Use Codiluce to explain how sign-in works, and publish it".',
    choices, initial: installed.filter(agent => !agent.connected).map(agent => agent.id), none: 'none',
  });
  const results: SetupResult['connected'] = [];
  for (const id of chosen) {
    const agent = agents.find(item => item.id === id)!;
    const connecting = spinner(w);
    connecting.start(`Connecting ${agent.name}…`);
    try {
      await connectAgent(id, context.toolDirectory, context.kind, context.root, path.resolve(context.stateDirectory) !== path.join(context.root, '.codiluce') ? context.stateDirectory : undefined);
      connecting.stop(`${agent.name} connected ${c.dim(`· ${agent.scope}`)}`, 'ok');
      results.push({ agent, ok: true });
    } catch (error) {
      const message = error instanceof Error ? (error.message.split('\n').find(line => line.trim()) ?? error.message) : String(error);
      connecting.stop(`${agent.name}: ${message}`, 'error');
      results.push({ agent, ok: false, error: message });
    }
  }
  return results;
}

/** The answers, in one box, after the questions. */
export function printSummary(w: Writer, result: SetupResult, context: SetupContext): void {
  const { c } = w;
  const depth = result.settings.history.depth;
  const commits = result.git.commits;
  const historyText = depth === 'none' ? 'Git file evolution; architecture snapshots on demand'
    : depth === 'all' || (typeof depth === 'number' && commits && commits <= depth) ? `all ${commits.toLocaleString('en-US')} commits, in the background`
      : typeof depth === 'number' ? `the last ${depth} commits, in the background` : `commits since ${depth}, in the background`;
  const inside = path.relative(context.root, context.stateDirectory);
  const state = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside : tilde(context.stateDirectory);
  const rows: ([string, string] | string)[] = [
    ['History', historyText],
    ['Models', result.keys.length ? `${result.keys.map(item => PROVIDERS[item.provider].name).join(' and ')} key saved to ${tilde(result.keys[0]!.file)}` : 'keys as found (environment or saved earlier)'],
    ['Describe', result.describe ? `now, in the background, up to $${money(result.describe.maxCost)}` : result.settings.annotations.enabled ? 'on' : 'not now'],
    ['Agents', result.connected.filter(item => item.ok).map(item => item.agent.name).join(', ') || 'none connected'],
    ['Saved', `${state}/config.yml${result.gitignore === 'written' ? `, and ${state}/ is hidden from Git` : ''}`],
  ];
  if (result.gitignore === 'tracked') rows.push(c.red('Something in .codiluce/ is tracked by Git, so it was not hidden from Git.'));
  w.write(`${c.dim(w.s.end)}`);
  w.write();
  w.box('Ready', rows);
}
