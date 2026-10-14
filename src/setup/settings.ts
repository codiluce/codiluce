// Where the first-run setup keeps what it learned and decided:
// - the repository's choices in `<state>/config.yml` (`history`, `annotations`), beside its applications;
// - a run record in `<state>/state.json` (set up once, which version ran last, how long the first analysis took);
// - the user's defaults and API keys in `~/.config/codiluce/` (`config.yml`; `credentials`, mode 0600, dotenv),
//   never inside a repository;
// - `<state>/.gitignore` (`*`), so the analysis never lands in a commit.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse, parseDocument, stringify } from 'yaml';

const execute = promisify(execFile);
export const STATE_FILE = 'state.json';
export const SETUP_VERSION = 1;

/** `none`: no history; `all`; a number of the newest commits; otherwise a Git date ("6 months ago"). */
export type HistoryDepth = number | string;
export interface HistorySettings { depth: HistoryDepth; onDemand: boolean }
export interface AnnotationSettings { enabled: boolean; maxCost: number }
export interface RepositorySettings { history?: HistorySettings; annotations?: AnnotationSettings }
export interface RunState {
  setup?: number; version?: string; lastStart?: string;
  /** Duration of the last analysis without a cache (the cost of one commit, for history estimates). */
  analysisMs?: number;
  /** The npx hint was shown for this version. */
  npxHint?: string;
}
export interface UserSettings { defaults?: RepositorySettings; askOnFirstRun?: boolean }

export const DEFAULT_HISTORY: HistorySettings = { depth: 50, onDemand: true };
export const DEFAULT_ANNOTATIONS: AnnotationSettings = { enabled: false, maxCost: 10 };

// Paths ----------------------------------------------------------------------------------
/** `~/.config/codiluce` (or `$XDG_CONFIG_HOME/codiluce`; `%APPDATA%\codiluce` on Windows). */
export function userDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODILUCE_CONFIG_HOME) return env.CODILUCE_CONFIG_HOME;
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'codiluce');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'codiluce');
}
export function credentialsFile(env: NodeJS.ProcessEnv = process.env): string { return path.join(userDirectory(env), 'credentials'); }
/**
 * Files an API key is read from, first match wins after the environment: the
 * user's credentials, then `.env` in the state directory (hidden from Git),
 * then `.env` of a source checkout. Never the target repository.
 */
export function keyFiles(stateDirectory: string, toolDirectory?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [credentialsFile(env), path.join(stateDirectory, '.env'), ...(toolDirectory ? [path.join(toolDirectory, '.env')] : [])];
}
export type KeyName = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
/** A key and where it was found. */
export function findKey(name: KeyName, files: string[], env: NodeJS.ProcessEnv = process.env): { value: string; source: string } | undefined {
  if (env[name]) return { value: env[name]!, source: 'environment' };
  for (const file of files) {
    const value = readDotenv(file)[name];
    if (value) return { value, source: file };
  }
  return undefined;
}
export function readDotenv(file: string): Record<string, string> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return {}; }
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    result[match[1]!] = value;
  }
  return result;
}
/** Set keys in a dotenv file, keeping its other lines; the file is readable by its owner only. */
export function writeDotenv(file: string, values: Record<string, string>): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : ['# Codiluce API keys (written by codiluce setup). Keep this file private.'];
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex(line => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
    const entry = `${name}=${value}`;
    if (at >= 0) lines[at] = entry; else lines.push(entry);
  }
  writeFileSync(file, `${lines.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

// Repository settings ----------------------------------------------------------------------
export function readRepositorySettings(stateDirectory: string): RepositorySettings {
  const file = path.join(stateDirectory, 'config.yml');
  let raw: Record<string, unknown> = {};
  try { const parsed = parse(readFileSync(file, 'utf8')) as unknown; if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>; } catch { /* none yet */ }
  return settingsFrom(raw);
}
function settingsFrom(raw: Record<string, unknown>): RepositorySettings {
  const result: RepositorySettings = {};
  const history = raw.history as Record<string, unknown> | undefined;
  if (history && typeof history === 'object') result.history = { depth: depthOf(history.depth) ?? DEFAULT_HISTORY.depth, onDemand: history.onDemand !== false };
  const annotations = raw.annotations as Record<string, unknown> | undefined;
  if (annotations && typeof annotations === 'object') result.annotations = { enabled: annotations.enabled === true, maxCost: typeof annotations.maxCost === 'number' && annotations.maxCost > 0 ? annotations.maxCost : DEFAULT_ANNOTATIONS.maxCost };
  return result;
}
export function depthOf(value: unknown): HistoryDepth | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'all') return text;
  if (/^\d+$/.test(text) && Number(text) > 0) return Number(text);
  return value.trim();
}
/** Write the setup sections into config.yml, keeping everything else (comments included). */
export function writeRepositorySettings(stateDirectory: string, settings: RepositorySettings, base?: { repository: unknown; applications: unknown; maxFileBytes: number }): void {
  const file = path.join(stateDirectory, 'config.yml');
  mkdirSync(stateDirectory, { recursive: true });
  const document = existsSync(file) ? parseDocument(readFileSync(file, 'utf8')) : parseDocument(stringify(base ? { repository: base.repository, applications: base.applications, ignore: [], maxFileBytes: base.maxFileBytes } : {}));
  if (settings.history) document.set('history', { depth: settings.history.depth, onDemand: settings.history.onDemand });
  if (settings.annotations) document.set('annotations', { enabled: settings.annotations.enabled, maxCost: settings.annotations.maxCost });
  writeFileSync(file, String(document));
}

// Run state ------------------------------------------------------------------------------------
export function readState(stateDirectory: string): RunState {
  try { return JSON.parse(readFileSync(path.join(stateDirectory, STATE_FILE), 'utf8')) as RunState; } catch { return {}; }
}
export function writeState(stateDirectory: string, patch: RunState): RunState {
  const next = { ...readState(stateDirectory), ...patch };
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(path.join(stateDirectory, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// User settings --------------------------------------------------------------------------------------
export function readUserSettings(env: NodeJS.ProcessEnv = process.env): UserSettings {
  try {
    const raw = parse(readFileSync(path.join(userDirectory(env), 'config.yml'), 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return {};
    return { ...(raw.defaults && typeof raw.defaults === 'object' ? { defaults: settingsFrom(raw.defaults as Record<string, unknown>) } : {}), ...(typeof raw.askOnFirstRun === 'boolean' ? { askOnFirstRun: raw.askOnFirstRun } : {}) };
  } catch { return {}; }
}
export function writeUserSettings(settings: UserSettings, env: NodeJS.ProcessEnv = process.env): string {
  const file = path.join(userDirectory(env), 'config.yml');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `# Codiluce defaults for new repositories (written by codiluce setup)\n${stringify(settings)}`);
  return file;
}

// Git ----------------------------------------------------------------------------------------------
/**
 * Hide the state directory from Git with its own `.gitignore` (`*`), unless
 * something in it is already tracked. The repository's own `.gitignore` is
 * never touched. Returns what happened.
 */
export async function hideFromGit(root: string, stateDirectory: string): Promise<'written' | 'present' | 'tracked' | 'outside'> {
  const file = path.join(stateDirectory, '.gitignore');
  if (existsSync(file)) return 'present';
  const relative = path.relative(root, stateDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'outside';
  try {
    const { stdout } = await execute('git', ['ls-files', '--', relative], { cwd: root });
    if (stdout.trim()) return 'tracked';
  } catch { /* not a Git repository: still hide it, in case it becomes one */ }
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(file, '# Written by Codiluce: the analysis, history and explanations stay out of Git.\n*\n');
  return 'written';
}
export interface GitFacts { repository: boolean; topLevel: boolean; shallow: boolean; branch?: string; commits: number; recent: number; recentSince: string }
/** What history the repository has: first-parent commits of HEAD, and how many in the last six months. */
export async function gitFacts(root: string): Promise<GitFacts> {
  const run = async (args: string[]) => (await execute('git', args, { cwd: root, maxBuffer: 1 << 20 })).stdout.trim();
  const recentSince = '6 months ago';
  try {
    const top = await run(['rev-parse', '--show-toplevel']);
    const shallow = (await run(['rev-parse', '--is-shallow-repository'])) === 'true';
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined);
    const commits = Number(await run(['rev-list', '--count', '--first-parent', 'HEAD']).catch(() => '0'));
    const recent = Number(await run(['rev-list', '--count', '--first-parent', `--since=${recentSince}`, 'HEAD']).catch(() => '0'));
    return { repository: true, topLevel: realpathSync(top) === realpathSync(root), shallow, ...(branch && branch !== 'HEAD' ? { branch } : {}), commits, recent, recentSince };
  } catch { return { repository: false, topLevel: false, shallow: false, commits: 0, recent: 0, recentSince }; }
}

// Install kind --------------------------------------------------------------------------------------
/** How this Codiluce was installed: through npx (a temporary cache), globally, in the project, or a source checkout. */
export type InstallKind = 'npx' | 'global' | 'project' | 'checkout';
export function installKind(toolDirectory: string, root?: string): InstallKind {
  if (existsSync(path.join(toolDirectory, 'web/app/page.tsx')) && existsSync(path.join(toolDirectory, 'src/cli.ts'))) return 'checkout';
  if (/[\\/]_npx[\\/]/.test(toolDirectory)) return 'npx';
  if (root && !path.relative(path.join(root, 'node_modules'), toolDirectory).startsWith('..')) return 'project';
  return 'global';
}
export function packageVersion(toolDirectory: string): string {
  try { return (JSON.parse(readFileSync(path.join(toolDirectory, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
}
/** A path with the home directory written as ~. */
export function tilde(file: string): string {
  const home = os.homedir();
  return file === home ? '~' : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}
