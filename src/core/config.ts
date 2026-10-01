import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export interface ApplicationConfig { name: string; path: string; type: 'nextjs' | 'laravel'; apiOrigins?: string[] }
export interface AtlasConfig {
  repository: { name: string; id?: string };
  applications: ApplicationConfig[];
  ignore: string[];
  maxFileBytes: number;
}
export const DEFAULT_IGNORES = [
  '**/node_modules/**', '**/vendor/**', '**/.git/**', '**/.next/**', '**/storage/**', '**/coverage/**',
  '**/build/**', '**/dist/**', '**/out/**', '**/.archipelago/**', '**/.cache/**', '**/.gradle/**', '**/Pods/**',
  '**/.venv/**', '**/__pycache__/**', '**/bootstrap/cache/**', '**/public/phpmyadmin/**', '**/__db__/**',
  '**/.cursor/**', '**/.agents/**', '**/next-env.d.ts', '**/*.generated.*', '**/*.min.js', '**/*.map',
  '**/.env', '**/.env.*', '**/.htpasswd', '**/*.pem', '**/*.key', '**/*.sqlite', '**/*.db', '**/*.log',
];
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
export async function detectApplications(root: string): Promise<ApplicationConfig[]> {
  const apps: ApplicationConfig[] = [];
  async function inspect(relative: string, depth: number): Promise<void> {
    const directory = repoPath(root, relative);
    for (const [manifest, type] of [['package.json', 'nextjs'], ['composer.json', 'laravel']] as const) {
      const file = path.join(directory, manifest);
      if (await exists(file)) {
        let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; require?: Record<string, string> };
        try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error(`Invalid manifest: ${path.relative(root, file)}`); }
        const matches = type === 'nextjs' ? parsed.dependencies?.next || parsed.devDependencies?.next : parsed.require?.['laravel/framework'];
        if (matches) { apps.push({ name: relative === '.' ? path.basename(root) : relative.replaceAll('/', '-'), path: relative, type }); return; }
      }
    }
    if (depth >= 2) return;
    const { readdir } = await import('node:fs/promises');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const rel = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && !DEFAULT_IGNORES.some(glob => matchesGlob(rel, glob))) await inspect(rel, depth + 1);
    }
  }
  await inspect('.', 0);
  return apps;
}
export async function loadConfig(root: string, stateDirectory: string): Promise<AtlasConfig> {
  const file = path.join(stateDirectory, 'config.yml');
  const input: unknown = await exists(file) ? parse(await readFile(file, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object');
  const raw = input as Partial<AtlasConfig>;
  if (raw.ignore !== undefined && (!Array.isArray(raw.ignore) || !raw.ignore.every(glob => typeof glob === 'string'))) throw new Error('ignore must be a list of globs');
  const config: AtlasConfig = {
    repository: raw.repository ?? { name: path.basename(root) },
    applications: raw.applications ?? await detectApplications(root),
    ignore: [...DEFAULT_IGNORES, ...(raw.ignore ?? [])],
    maxFileBytes: raw.maxFileBytes ?? 1024 * 1024,
  };
  if (!config.repository || typeof config.repository.name !== 'string' || !config.repository.name.trim() || (config.repository.id !== undefined && typeof config.repository.id !== 'string')) throw new Error('Invalid repository configuration');
  if (!Array.isArray(config.ignore) || !config.ignore.every(glob => typeof glob === 'string')) throw new Error('ignore must be a list of globs');
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1) throw new Error('maxFileBytes must be a positive integer');
  if (!Array.isArray(config.applications)) throw new Error('applications must be a list');
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const app of config.applications) {
    if (!app || typeof app.name !== 'string' || !app.name || typeof app.path !== 'string' || !['nextjs', 'laravel'].includes(app.type)) throw new Error('Invalid application configuration');
    const absolute = repoPath(root, app.path);
    app.path = path.relative(root, absolute).split(path.sep).join('/') || '.';
    const resolved = await realpath(absolute);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Application symlink escapes repository');
    if (!(await stat(resolved)).isDirectory()) throw new Error('Application path must be a directory');
    if (names.has(app.name) || paths.has(app.path)) throw new Error('Application names and paths must be unique');
    names.add(app.name); paths.add(app.path);
    if (app.apiOrigins !== undefined && (!Array.isArray(app.apiOrigins) || !app.apiOrigins.every(origin => typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin))) throw new Error('apiOrigins must contain HTTP origins without paths');
  }
  for (const a of config.applications) for (const b of config.applications) if (a !== b && (a.path === '.' || b.path.startsWith(`${a.path}/`))) throw new Error('Overlapping application paths are unsupported');
  return config;
}
