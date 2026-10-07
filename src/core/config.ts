import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parse } from 'yaml';
import { ANALYZED_FRAMEWORKS, ECOSYSTEMS, readManifests, type Ecosystem } from './manifests.js';

const execute = promisify(execFile);

export interface ApplicationConfig {
  name: string; path: string;
  /**
   * What it is built on, primary first: the configured frameworks, then those
   * its manifests declare. nextjs and laravel are analyzed in depth; the
   * others are recorded.
   */
  frameworks: string[];
  /** Ecosystems of the manifests at its root (package.json → node, composer.json → php, go.mod → go…), by priority. */
  ecosystems: Ecosystem[];
  apiOrigins?: string[];
  /** Environment variables declared to hold this application's origin (e.g. NEXT_PUBLIC_API_URL). A configured assumption, recorded as such in evidence. */
  apiOriginEnv?: string[];
}
/** An application as configuration may give it: frameworks and ecosystems are completed from its manifests. */
export type ApplicationInput = Omit<ApplicationConfig, 'frameworks' | 'ecosystems'> & {
  frameworks?: string[]; ecosystems?: string[];
  /** The earlier single-framework form (`type: nextjs`): one configured framework. */
  type?: string;
};
export interface AtlasConfig {
  repository: { name: string; id?: string };
  applications: ApplicationConfig[];
  ignore: string[];
  maxFileBytes: number;
}
export type RawConfig = Omit<Partial<AtlasConfig>, 'applications'> & { applications?: ApplicationInput[] };
export const DEFAULT_IGNORES = [
  '**/node_modules/**', '**/vendor/**', '**/.git/**', '**/.next/**', '**/storage/**', '**/coverage/**',
  '**/build/**', '**/dist/**', '**/out/**', '**/.codiluce/**', '**/.cache/**', '**/.gradle/**', '**/Pods/**',
  '**/.venv/**', '**/__pycache__/**', '**/bootstrap/cache/**', '**/public/phpmyadmin/**', '**/__db__/**',
  '**/.cursor/**', '**/.agents/**', '**/next-env.d.ts', '**/*.generated.*', '**/*.min.js', '**/*.map',
  '**/.env', '**/.env.*', '**/.htpasswd', '**/*.pem', '**/*.key', '**/*.sqlite', '**/*.db', '**/*.log',
  // Build output and tool caches of other ecosystems (Rust/Maven target, .NET obj, SwiftPM, Python and framework caches).
  '**/target/**', '**/obj/**', '**/.build/**', '**/DerivedData/**', '**/.tox/**', '**/.mypy_cache/**', '**/.pytest_cache/**', '**/.ruff_cache/**',
  '**/*.egg-info/**', '**/.svelte-kit/**', '**/.nuxt/**', '**/.output/**', '**/.astro/**', '**/.turbo/**', '**/.parcel-cache/**', '**/.vs/**',
  '**/.bundle/**', '**/.dart_tool/**', '**/.kotlin/**', '**/.bsp/**', '**/.metals/**', '**/.bloop/**', '**/cmake-build-*/**',
];
/** Directories of tests and test data: what they hold is not an application of the repository. */
const TEST_DIRECTORIES = /^(tests?|__tests__|spec|fixtures|__fixtures__|testdata)$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9.+-]*$/;
/** The frameworks analyzed in depth, with the ecosystem each implies when no manifest names it. */
const IMPLIED_ECOSYSTEM: Record<string, Ecosystem> = { nextjs: 'node', laravel: 'php' };
export function hasFramework<T extends Pick<ApplicationConfig, 'frameworks'>>(app: T | undefined, framework: string): app is T { return !!app?.frameworks.includes(framework); }
/** What an application is, in one word: its primary framework, else its primary ecosystem. */
export function applicationKind(app: Pick<ApplicationInput, 'type' | 'frameworks' | 'ecosystems'>): string | undefined { return app.type ?? app.frameworks?.[0] ?? app.ecosystems?.[0]; }
/** The application a repository-relative path belongs to: the innermost one containing it. */
export function applicationAt<T extends Pick<ApplicationConfig, 'path'>>(applications: T[], relative: string): T | undefined {
  let found: T | undefined, depth = -1;
  for (const app of applications) {
    const inside = app.path === '.' || relative === app.path || relative.startsWith(`${app.path}/`);
    const own = app.path === '.' ? 0 : app.path.split('/').length;
    if (inside && own > depth) { found = app; depth = own; }
  }
  return found;
}
/** What Git ignores in a working tree (an ignored directory is listed, not its files); undefined without Git. */
export async function gitIgnored(root: string): Promise<{ files: Set<string>; directories: Set<string> } | undefined> {
  try {
    const { stdout } = await execute('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const ignored = stdout.split('\0').filter(Boolean);
    return { files: new Set(ignored.filter(file => !file.endsWith('/'))), directories: new Set(ignored.filter(file => file.endsWith('/')).map(file => file.slice(0, -1))) };
  } catch { return undefined; }
}
export function repoPath(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const normalized = path.relative(root, absolute);
  if (path.isAbsolute(relative) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`Path outside repository: ${relative}`);
  return absolute;
}
export async function exists(file: string): Promise<boolean> { try { await stat(file); return true; } catch { return false; } }
export function matchesGlob(relative: string, glob: string): boolean {
  // Supported configuration syntax: *, ** and ?. Escape everything else.
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { pattern += '(?:.*/)?'; i++; } else pattern += '.*';
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[\^$+?.()|{}\[\]\\]/g, '\\$&');
  }
  const regex = new RegExp(`^${pattern}$`);
  return regex.test(relative) || (glob.endsWith('/**') && regex.test(`${relative}/`));
}
/**
 * Applications found by their manifests, down to two directory levels below
 * the root (`apps/web`), outside test directories and those the scanner
 * prunes (default ignores, Git-ignored). A directory is an application when
 * one of its manifests declares one, not only a workspace or tooling (see
 * manifests.ts). Applications can nest — a Capacitor shell at the root around
 * a Next.js frontend and a Laravel backend — except inside a Next.js or
 * Laravel application, which owns its whole directory: a nested application
 * would split its analysis. `rootName` names one at the root.
 */
export async function detectApplications(root: string, rootName = path.basename(root)): Promise<ApplicationConfig[]> {
  const apps: ApplicationConfig[] = [];
  const ignored = (await gitIgnored(root))?.directories ?? new Set<string>();
  async function inspect(relative: string, depth: number): Promise<void> {
    const directory = repoPath(root, relative);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const found = await readManifests(directory, entries.map(entry => entry.name), relative);
    if (found?.application) {
      apps.push({ name: relative === '.' ? rootName : relative.replaceAll('/', '-'), path: relative, frameworks: found.frameworks, ecosystems: found.ecosystems });
      if (found.frameworks.some(framework => ANALYZED_FRAMEWORKS.has(framework))) return;
    }
    if (depth >= 2) return;
    for (const entry of entries) {
      const rel = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && !TEST_DIRECTORIES.test(entry.name) && !ignored.has(rel) && !DEFAULT_IGNORES.some(glob => matchesGlob(rel, glob))) await inspect(rel, depth + 1);
    }
  }
  await inspect('.', 0);
  // A nested application named like the repository (repository `api` with `api/`) keeps the name.
  const rootApp = apps.find(app => app.path === '.');
  if (rootApp && apps.some(app => app !== rootApp && app.name === rootApp.name)) rootApp.name = `${rootApp.name}-root`;
  return apps;
}
export async function loadConfig(root: string, stateDirectory: string): Promise<AtlasConfig> {
  return resolveConfig(root, await readRawConfig(stateDirectory));
}
/** The configuration file as written, before defaults, autodetection and path validation. */
export async function readRawConfig(stateDirectory: string): Promise<RawConfig> {
  const file = path.join(stateDirectory, 'config.yml');
  const input: unknown = await exists(file) ? parse(await readFile(file, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object');
  return input as RawConfig;
}
export async function resolveConfig(root: string, raw: RawConfig): Promise<AtlasConfig> {
  if (raw.ignore !== undefined && (!Array.isArray(raw.ignore) || !raw.ignore.every(glob => typeof glob === 'string'))) throw new Error('ignore must be a list of globs');
  const repository = raw.repository ?? { name: path.basename(root) };
  if (!repository || typeof repository.name !== 'string' || !repository.name.trim() || (repository.id !== undefined && typeof repository.id !== 'string')) throw new Error('Invalid repository configuration');
  if (raw.applications !== undefined && !Array.isArray(raw.applications)) throw new Error('applications must be a list');
  const config: AtlasConfig = {
    repository,
    applications: raw.applications ? await Promise.all(raw.applications.map(app => configuredApplication(root, app))) : await detectApplications(root, repository.name),
    ignore: [...DEFAULT_IGNORES, ...(raw.ignore ?? [])],
    maxFileBytes: raw.maxFileBytes ?? 1024 * 1024,
  };
  if (!Array.isArray(config.ignore) || !config.ignore.every(glob => typeof glob === 'string')) throw new Error('ignore must be a list of globs');
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1) throw new Error('maxFileBytes must be a positive integer');
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const app of config.applications) {
    if (names.has(app.name) || paths.has(app.path)) throw new Error('Application names and paths must be unique');
    names.add(app.name); paths.add(app.path);
    if (app.apiOrigins !== undefined && (!Array.isArray(app.apiOrigins) || !app.apiOrigins.every(origin => typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin))) throw new Error('apiOrigins must contain HTTP origins without paths');
    if (app.apiOriginEnv !== undefined && (!Array.isArray(app.apiOriginEnv) || !app.apiOriginEnv.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)))) throw new Error('apiOriginEnv must contain environment variable names');
  }
  const envOwners = new Map<string, string>();
  for (const app of config.applications) for (const name of app.apiOriginEnv ?? []) { if (envOwners.has(name) && envOwners.get(name) !== app.name) throw new Error(`apiOriginEnv ${name} is declared for more than one application`); envOwners.set(name, app.name); }
  return config;
}
/**
 * A configured application, completed from its manifests: configured
 * frameworks come first, then the ones its manifests declare. A manifest that
 * cannot be read adds nothing (a commit replayed by history may hold a broken
 * one); the configured frameworks still apply.
 */
async function configuredApplication(root: string, input: ApplicationInput): Promise<ApplicationConfig> {
  const list = (value: unknown) => value === undefined ? [] : Array.isArray(value) && value.every(item => typeof item === 'string' && IDENTIFIER.test(item)) ? value as string[] : undefined;
  const frameworks = list(input?.frameworks), ecosystems = list(input?.ecosystems);
  if (!input || typeof input.name !== 'string' || !input.name || typeof input.path !== 'string' || !frameworks || !ecosystems
    || !ecosystems.every(item => (ECOSYSTEMS as readonly string[]).includes(item)) || (input.type !== undefined && (typeof input.type !== 'string' || !IDENTIFIER.test(input.type)))) throw new Error('Invalid application configuration');
  const absolute = repoPath(root, input.path);
  const relative = path.relative(root, absolute).split(path.sep).join('/') || '.';
  const resolved = await realpath(absolute);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Application symlink escapes repository');
  if (!(await stat(resolved)).isDirectory()) throw new Error('Application path must be a directory');
  const found = await readManifests(resolved, await readdir(resolved), relative).catch(() => undefined);
  const { type, ...rest } = input;
  const allFrameworks = [...new Set([...(type ? [type] : []), ...frameworks, ...found?.frameworks ?? []])];
  const implied = allFrameworks.flatMap(framework => IMPLIED_ECOSYSTEM[framework] ?? []);
  return { ...rest, path: relative, frameworks: allFrameworks, ecosystems: [...new Set([...ecosystems as Ecosystem[], ...found?.ecosystems ?? [], ...implied])] };
}
