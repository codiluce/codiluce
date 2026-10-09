import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parse } from 'yaml';
import { ECOSYSTEMS, readManifests, type Ecosystem } from './manifests.js';
import { nodeWorkspacePatterns } from './workspaces.js';
import { parseGoManifest } from '../analysis/resolution/go-manifest.js';

const execute = promisify(execFile);

/** Explicit target inputs; absent fields remain unknown, never host defaults. */
export interface GoBuildConfig { goos?: string; goarch?: string; tags?: string[]; cgoEnabled?: boolean; compiler?: 'gc' | 'gccgo'; toolchainVersion?: string; workspace?: string | false; includeTests?: boolean; httpMuxGo121?: boolean }

export interface ApplicationConfig {
  name: string; path: string;
  /**
   * What it is built on, primary first: the configured frameworks, then those
   * its manifests declare. Analysis depth is reported per file by adapters
   * and packs; framework recognition alone does not imply semantic support.
   */
  frameworks: string[];
  /** Ecosystems of the manifests at its root (package.json → node, composer.json → php, go.mod → go…), by priority. */
  ecosystems: Ecosystem[];
  apiOrigins?: string[];
  /** Environment variables declared to hold this application's origin (e.g. NEXT_PUBLIC_API_URL). A configured assumption, recorded as such in evidence. */
  apiOriginEnv?: string[];
  /** Explicit browser proxy assumptions; executable proxy configuration is not evaluated. */
  apiProxies?: { target: string; pathPrefix: string; targetPrefix?: string }[];
  /** Static language source roots, relative to this application's path. */
  sourceRoots?: Record<string, string[]>;
  /** Explicit framework entry modules/factories (e.g. flask: ["shop:create_app"]). */
  entrypoints?: Record<string, string[]>;
  go?: GoBuildConfig;
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
// Directory ownership is independent of the framework pack registry. Keep
// legacy ownership, while explicitly declared workspace members can nest.
const OWNS_DIRECTORY = new Set(['nextjs', 'laravel']);
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
 * the root (`apps/web`) and at declared Node workspace members, outside test directories and those the scanner
 * prunes (default ignores, Git-ignored). A directory is an application when
 * one of its manifests declares one, not only a workspace or tooling (see
 * manifests.ts). Applications can nest — a Capacitor shell at the root around
 * a Next.js frontend and a Laravel backend — except inside a Next.js or
 * Laravel application, which owns its whole directory: a nested application
 * would split its analysis. `rootName` names one at the root.
 */
export async function detectApplications(root: string, rootName = path.basename(root), extraIgnores: readonly string[] = []): Promise<ApplicationConfig[]> {
  const apps: ApplicationConfig[] = [];
  const inventory = await gitIgnored(root);
  const ignored = inventory?.directories ?? new Set<string>();
  const ignores = [...DEFAULT_IGNORES, ...extraIgnores];
  const inspected = new Map<string, number>();
  const ownedDirectories = new Set<string>();
  const allowed = (relative: string) => !relative.split('/').some(segment => segment.startsWith('.') && segment !== '.' || TEST_DIRECTORIES.test(segment)) && ![...ignored].some(directory => relative === directory || relative.startsWith(`${directory}/`)) && !ignores.some(glob => matchesGlob(relative, glob));
  async function declaredMembers(relative: string, names: string[]): Promise<void> {
    if (names.includes('go.work')) {
      const workspace = parseGoManifest(await readFile(path.join(repoPath(root, relative), 'go.work'), 'utf8'), 'workspace');
      if (workspace.valid) for (const member of workspace.uses) {
        if (path.isAbsolute(member) || /^[A-Za-z]:/.test(member)) continue;
        const directory = path.posix.normalize(path.posix.join(relative, member));
        if (directory === '..' || directory.startsWith('../') || !allowed(directory)) continue;
        const absolute = repoPath(root, directory);
        if (await realpath(absolute).catch(() => undefined) !== absolute || !(await stat(absolute).catch(() => undefined))?.isDirectory()) continue;
        await inspect(directory, 2);
      }
    }
    for (const manifest of ['package.json', 'pnpm-workspace.yaml']) {
      if (!names.includes(manifest)) continue;
      const patterns = nodeWorkspacePatterns(manifest, await readFile(path.join(repoPath(root, relative), manifest), 'utf8'));
      const normalize = (pattern: string) => path.posix.normalize(path.posix.join(relative, pattern));
      const includes = patterns.include.map(normalize).filter(pattern => pattern !== '..' && !pattern.startsWith('../'));
      const excludes = patterns.exclude.map(normalize);
      let visited = 0;
      const walked = new Set<string>();
      async function walk(directory: string, depth: number): Promise<void> {
        if (walked.has(directory) || depth > 32 || ++visited > 20_000 || !allowed(directory)) return;
        walked.add(directory);
        const entries = (await readdir(repoPath(root, directory), { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name, 'en'));
        if (includes.some(pattern => matchesGlob(directory, pattern)) && !excludes.some(pattern => matchesGlob(directory, pattern))) await inspect(directory, 2);
        for (const entry of entries) if (entry.isDirectory()) await walk(path.posix.join(directory, entry.name), depth + 1);
      }
      for (const pattern of includes) {
        const wildcard = pattern.search(/[?*]/);
        const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
        const directory = wildcard < 0 ? prefix : prefix.endsWith('/') ? prefix.slice(0, -1) || '.' : path.posix.dirname(prefix);
        // No glob expansion follows a symlink, including a literal member.
        const absolute = repoPath(root, directory);
        if (await realpath(absolute).catch(() => undefined) !== absolute || !allowed(directory) || !(await stat(absolute).catch(() => undefined))?.isDirectory()) continue;
        if (wildcard < 0) {
          if (!excludes.some(pattern => matchesGlob(directory, pattern))) await inspect(directory, 2);
        } else await walk(directory, 0);
      }
    }
  }
  async function inspect(relative: string, depth: number): Promise<void> {
    const previousDepth = inspected.get(relative);
    if (previousDepth !== undefined && previousDepth <= depth) return;
    inspected.set(relative, depth);
    const directory = repoPath(root, relative);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const names = entries.filter(entry => !entry.isSymbolicLink() && !inventory?.files.has(path.posix.join(relative, entry.name)) && !ignores.some(glob => matchesGlob(path.posix.join(relative, entry.name), glob))).map(entry => entry.name);
    if (previousDepth === undefined) {
      const found = await readManifests(directory, names, relative);
      await declaredMembers(relative, names);
      if (found?.application) {
        apps.push({ name: relative === '.' ? rootName : relative.replaceAll('/', '-'), path: relative, frameworks: found.frameworks, ecosystems: found.ecosystems });
        if (found.frameworks.some(framework => OWNS_DIRECTORY.has(framework))) ownedDirectories.add(relative);
      }
    }
    if (ownedDirectories.has(relative)) return;
    if (depth >= 2) return;
    for (const entry of entries) {
      const rel = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory() && allowed(rel)) await inspect(rel, depth + 1);
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
    applications: raw.applications ? await Promise.all(raw.applications.map(app => configuredApplication(root, app))) : await detectApplications(root, repository.name, raw.ignore ?? []),
    ignore: [...DEFAULT_IGNORES, ...(raw.ignore ?? [])],
    maxFileBytes: raw.maxFileBytes ?? 1024 * 1024,
  };
  if (!Array.isArray(config.ignore) || !config.ignore.every(glob => typeof glob === 'string')) throw new Error('ignore must be a list of globs');
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1) throw new Error('maxFileBytes must be a positive integer');
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const app of config.applications) {
    if (app.go !== undefined) {
      const go = app.go, tag = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.]+$/.test(value);
      if (!go || typeof go !== 'object' || Array.isArray(go) || Object.keys(go).some(key => !['goos', 'goarch', 'tags', 'cgoEnabled', 'compiler', 'toolchainVersion', 'workspace', 'includeTests', 'httpMuxGo121'].includes(key))
        || go.goos !== undefined && !tag(go.goos) || go.goarch !== undefined && !tag(go.goarch)
        || go.tags !== undefined && (!Array.isArray(go.tags) || go.tags.length > 128 || !go.tags.every(tag) || new Set(go.tags).size !== go.tags.length)
        || go.cgoEnabled !== undefined && typeof go.cgoEnabled !== 'boolean' || go.includeTests !== undefined && typeof go.includeTests !== 'boolean' || go.httpMuxGo121 !== undefined && typeof go.httpMuxGo121 !== 'boolean'
        || go.compiler !== undefined && !['gc', 'gccgo'].includes(go.compiler)
        || go.toolchainVersion !== undefined && !/^1\.\d+(?:\.\d+)?$/.test(go.toolchainVersion)
        || go.workspace !== undefined && go.workspace !== false && (typeof go.workspace !== 'string' || path.isAbsolute(go.workspace) || /[\\\0]/.test(go.workspace) || /^[A-Za-z]:/.test(go.workspace))) throw new Error('Invalid Go build configuration');
      if (typeof go.workspace === 'string') repoPath(root, path.posix.join(app.path, go.workspace));
    }
    if (names.has(app.name) || paths.has(app.path)) throw new Error('Application names and paths must be unique');
    names.add(app.name); paths.add(app.path);
    if (app.apiOrigins !== undefined && (!Array.isArray(app.apiOrigins) || !app.apiOrigins.every(origin => typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin))) throw new Error('apiOrigins must contain HTTP origins without paths');
    if (app.apiOriginEnv !== undefined && (!Array.isArray(app.apiOriginEnv) || !app.apiOriginEnv.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)))) throw new Error('apiOriginEnv must contain environment variable names');
    const prefix = (value: unknown) => typeof value === 'string' && value.startsWith('/') && !/[?#{}\\]/.test(value) && !value.includes('//') && !value.split('/').some(part => part === '.' || part === '..');
    if (app.apiProxies !== undefined && (!Array.isArray(app.apiProxies) || !app.apiProxies.every(proxy => proxy && config.applications.some(target => target.name === proxy.target) && prefix(proxy.pathPrefix) && (proxy.targetPrefix === undefined || prefix(proxy.targetPrefix))) || new Set(app.apiProxies.map(proxy => proxy.pathPrefix.replace(/\/$/, '') || '/')).size !== app.apiProxies.length)) throw new Error('apiProxies must contain unique absolute path prefixes and existing target application names');
    if (app.sourceRoots !== undefined) {
      if (!app.sourceRoots || typeof app.sourceRoots !== 'object' || Array.isArray(app.sourceRoots) || !Object.entries(app.sourceRoots).every(([language, roots]) => IDENTIFIER.test(language) && Array.isArray(roots) && roots.length > 0 && roots.every(root => typeof root === 'string' && !path.isAbsolute(root) && !/^[A-Za-z]:/.test(root) && !/[\\\0]/.test(root)))) throw new Error('sourceRoots must map language names to nonempty lists of repository-relative paths');
      for (const roots of Object.values(app.sourceRoots)) for (const sourceRoot of roots) repoPath(root, path.posix.join(app.path, sourceRoot));
    }
    if (app.entrypoints !== undefined && (!app.entrypoints || typeof app.entrypoints !== 'object' || Array.isArray(app.entrypoints) || !Object.entries(app.entrypoints).every(([framework, entries]) => IDENTIFIER.test(framework) && Array.isArray(entries) && entries.length > 0 && entries.length <= 64 && new Set(entries).size === entries.length && entries.every(entry => typeof entry === 'string' && entry.length <= 512 && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?::[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/.test(entry))))) throw new Error('entrypoints must map framework names to unique Python module[:attribute] entries');
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
