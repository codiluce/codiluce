// Archetypes: what kind of building block each node is, so the map can give
// it a shape (a controller a portico, a table drums, a page a lit tower).
//
// Entities take theirs from their type (endpoints and page routes are gates,
// tables drums, commands kiosks…). Files take theirs, in order, from: their
// language (style sheets), test and configuration paths, an entry-point name,
// what the index declares at their path (scheduled tasks, commands, page
// routes, endpoints, tables), framework conventions for middleware, layouts
// and pages, the symbols they contain (controllers, models, hooks,
// components), and finally folder and name conventions shared by most
// frameworks (services, helpers, jobs…). Anything unclaimed has none and stays
// a plain block. Each result says why, and whether the index proves it or a
// convention suggests it. Pure, one pass per view.
import { CODE_LANGUAGES } from '../core/languages.js';
import { CONFIG_PATH, MIGRATION_PATH, TEST_PATH } from './catalog.js';
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';

export type Archetype = 'entry' | 'routes' | 'middleware' | 'controller' | 'service' | 'helper' | 'command' | 'schedule' | 'job'
  | 'model' | 'table' | 'page' | 'layout' | 'component' | 'hook' | 'style' | 'config' | 'test';
export const ARCHETYPES: Archetype[] = ['entry', 'routes', 'middleware', 'controller', 'service', 'helper', 'command', 'schedule', 'job', 'model', 'table', 'page', 'layout', 'component', 'hook', 'style', 'config', 'test'];
/** `indexed`: an entity type, role or declaration in the index; `convention`: a path or name rule; `language`: the file's language. */
export type ArchetypeBasis = 'indexed' | 'convention' | 'language';
export interface ArchetypeInfo { kind: Archetype; basis: ArchetypeBasis; reason: string }
/** How many blocks of one archetype an area holds. */
export interface ArchetypeCount { kind: Archetype; count: number }

const STYLE_LANGUAGES = new Set(['css', 'scss', 'sass', 'less', 'stylus', 'postcss']);
const DATA_LANGUAGES = new Set(['json', 'yaml', 'toml', 'ini', 'xml', 'dotenv', 'properties']);
const COMPONENT_LANGUAGES = new Set(['vue', 'svelte', 'astro']);

/** Where execution starts: front controllers, CLI launchers, `main` modules. */
const ENTRY_PATH = /(^|\/)public\/index\.php$|(^|\/)(artisan|manage\.py|wsgi\.py|asgi\.py|main\.go|Program\.cs|config\.ru)$|(^|\/)src\/(main|index)\.(rs|[cm]?[jt]sx?)$|(^|\/)main\.[cm]?[jt]sx?$|(^|\/)bin\/(www|rails|console)$|(^|\/)server\.[cm]?[jt]s$/;
/** Configuration the entry rule does not claim (the coverage rule also counts front controllers as configuration). */
const SETTINGS_PATH = /(^|\/)app\/Providers\/|(^|\/)Config\/|(^|\/)settings\.py$|(^|\/)\.env(\.\w+)?$|(^|\/)(tsconfig|jsconfig|package|composer|nuxt\.config|vite\.config)\.json$/;
const MIDDLEWARE_PATH = /(^|\/)middlewares?\/|Middleware\.[a-z]+$|(^|\/)middleware\.[cm]?[jt]s$/i;
const LAYOUT_PATH = /(^|\/)layout\.[cm]?[jt]sx?$|\+layout(\.server)?\.(svelte|[jt]s)$|(^|\/)layouts?\//i;
const PAGE_PATH = /(^|\/)page\.[cm]?[jt]sx?$|\+page\.svelte$|(^|\/)(pages|screens)\/(?!api\/).+\.([cm]?[jt]sx|vue|svelte|astro)$|(^|\/)views\/.+\.(blade\.php|html\.erb|erb|cshtml|twig|vue)$/i;
const CONTROLLER_PATH = /(^|\/)controllers?\/|Controller\.[a-z]+$|(^|\/)views\.py$/i;
/** `entities/` only in lower case (ORM entity folders): a capitalized `Entities/` is usually a domain module. */
const MODEL_PATH = /(^|\/)([Mm]odels|entities)\/|(^|\/)models\.py$/;
const TABLE_PATH = /(^|\/)migrations?\/|(^|\/)schema\.(rb|sql|prisma)$/i;
const COMMAND_PATH = /(^|\/)(Console\/Commands|commands|management\/commands|cli)\//i;
const SCHEDULE_PATH = /(^|\/)Console\/Kernel\.php$|(^|\/)routes\/console\.php$|(^|\/)(schedules?|cron)\//i;
const JOB_PATH = /(^|\/)(jobs|listeners|workers?|queues?|consumers?|subscribers)\/|(Job|Listener|Worker)\.[a-z]+$|(^|\/)tasks\.py$/i;
const SERVICE_PATH = /(^|\/)(services?|usecases?|use-cases|actions|domain)\/|Service\.[a-z]+$|[.-]service\.[cm]?[jt]s$/i;
const HELPER_PATH = /(^|\/)(helpers?|utils?|utilities|support|common)\/|(^|\/)helpers?\.[a-z]+$|[.-]?(util|utils|helpers?)\.[cm]?[jt]sx?$/i;
const ROUTES_PATH = /(^|\/)routes?\/|(^|\/)(urls\.py|routes\.rb|router\.[cm]?[jt]s|routes\.[cm]?[jt]s)$/i;
const HOOK_PATH = /(^|\/)use[A-Z]\w*\.[cm]?[jt]sx?$|(^|\/)(hooks|composables|state|stores?)\//;
const COMPONENT_PATH = /(^|\/)components?\//i;

const ENTITY_ARCHETYPES: Record<string, { kind: Archetype; reason: string }> = {
  api_endpoint: { kind: 'routes', reason: 'An endpoint: requests come in here' },
  route: { kind: 'routes', reason: 'A page route: visits come in here' },
  command: { kind: 'command', reason: 'A console command' },
  scheduled_task: { kind: 'schedule', reason: 'A scheduled task' },
  database_table: { kind: 'table', reason: 'A database table' },
  controller: { kind: 'controller', reason: 'A controller' },
  model: { kind: 'model', reason: 'A model mapped to a table' },
  component: { kind: 'component', reason: 'A component' },
  test: { kind: 'test', reason: 'A test' },
};
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** The part of the path a rule matched on: the folder up to the match, or the whole name. */
const folder = (path: string, rule: RegExp) => { const match = rule.exec(path); return match ? path.slice(0, match.index + match[0].length) : path; };

export function computeArchetypes(index: ProjectionIndex): Map<string, ArchetypeInfo> {
  // What the index declares at each path (endpoints, page routes, commands, schedules, tables).
  const declared = new Map<string, Record<string, number>>();
  const declare = (path: string, type: string) => { const counts = declared.get(path) ?? {}; counts[type] = (counts[type] ?? 0) + 1; declared.set(path, counts); };
  for (const node of index.nodes.values()) {
    if (node.change?.status === 'removed') continue;
    if (node.path && (node.type === 'api_endpoint' || node.type === 'route' || node.type === 'command' || node.type === 'scheduled_task' || node.type === 'database_table')) declare(node.path, node.type);
    if (node.type === 'database_table') for (const migration of node.migrations ?? []) if (migration !== node.path) declare(migration, 'database_table');
  }
  const result = new Map<string, ArchetypeInfo>();
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity') continue;
    const info = node.type === 'file' ? classifyFile(index, node, declared.get(node.path ?? '')) : classifyEntity(node);
    if (info) result.set(node.id, info);
  }
  return result;
}

const AREA_TYPES = new Set(['repository', 'application', 'directory']);
/**
 * What each area (repository, application, directory, district) holds, by
 * archetype, most first: the summary a closed area shows on its roof. A block
 * is the outermost node with an archetype (a file, or an endpoint or table
 * in its district); what is inside it counts through it, and nothing inside
 * a file without one counts at all.
 */
export function computeArchetypeCounts(index: ProjectionIndex, archetypes: Map<string, ArchetypeInfo>): Map<string, ArchetypeCount[]> {
  const counts = new Map<string, Map<Archetype, number>>();
  const visit = (node: ProjectionNode, areas: string[]): void => {
    if (node.change?.status === 'removed') return;
    const kind = archetypes.get(node.id)?.kind;
    if (kind) {
      for (const area of areas) { const own = counts.get(area) ?? new Map<Archetype, number>(); own.set(kind, (own.get(kind) ?? 0) + 1); counts.set(area, own); }
      return;
    }
    if (node.type === 'file') return;
    const inner = node.kind === 'group' || AREA_TYPES.has(node.type) ? [...areas, node.id] : areas;
    for (const id of node.children) { const child = index.node(id); if (child) visit(child, inner); }
  };
  visit(index.node(index.rootId)!, []);
  const order = new Map(ARCHETYPES.map((kind, i) => [kind, i]));
  return new Map([...counts].map(([area, own]) => [area, [...own].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || order.get(a.kind)! - order.get(b.kind)!)]));
}

function classifyEntity(node: ProjectionNode): ArchetypeInfo | undefined {
  if (node.type === 'function' && node.role === 'hook') return { kind: 'hook', basis: 'indexed', reason: 'A hook (a function named use…)' };
  const own = ENTITY_ARCHETYPES[node.type];
  return own ? { ...own, basis: 'indexed' } : undefined;
}

function classifyFile(index: ProjectionIndex, node: ProjectionNode, declared: Record<string, number> | undefined): ArchetypeInfo | undefined {
  const path = node.path ?? '', language = node.language ?? '', name = path.split('/').at(-1) ?? '';
  const convention = (kind: Archetype, rule: RegExp, what: string): ArchetypeInfo => ({ kind, basis: 'convention', reason: `${what}: ${folder(path, rule)}` });
  if (STYLE_LANGUAGES.has(language)) return { kind: 'style', basis: 'language', reason: `A ${language.toUpperCase()} style sheet` };
  if (TEST_PATH.test(path)) return { kind: 'test', basis: 'convention', reason: 'Tests or test data, by path' };
  if (ENTRY_PATH.test(path)) return { kind: 'entry', basis: 'convention', reason: `Execution starts here: ${name}` };
  if (!CODE_LANGUAGES.has(language)) {
    if (DATA_LANGUAGES.has(language) && (CONFIG_PATH.test(path) || SETTINGS_PATH.test(path) || !path.includes('/') || /(^|\/)[^/]*(config|rc)(\.[a-z]+)?$/i.test(name))) return { kind: 'config', basis: 'convention', reason: 'Configuration, by path' };
    return undefined;
  }
  if (CONFIG_PATH.test(path) || SETTINGS_PATH.test(path)) return { kind: 'config', basis: 'convention', reason: /(^|\/)app\/Providers\//.test(path) ? 'A service provider: registers code with the framework' : 'Configuration or bootstrapping, by path' };
  if (declared) {
    if (declared.scheduled_task) return { kind: 'schedule', basis: 'indexed', reason: `Declares ${plural(declared.scheduled_task, 'scheduled task')}` };
    if (declared.route) return { kind: 'page', basis: 'indexed', reason: `Declares ${plural(declared.route, 'page route')}` };
    if (declared.api_endpoint) return { kind: 'routes', basis: 'indexed', reason: `Declares ${plural(declared.api_endpoint, 'endpoint')}` };
    if (declared.command) return { kind: 'command', basis: 'indexed', reason: `Declares ${plural(declared.command, 'console command')}` };
    if (declared.database_table) return { kind: 'table', basis: 'indexed', reason: `Creates or changes ${plural(declared.database_table, 'table')}` };
  }
  if (MIDDLEWARE_PATH.test(path)) return convention('middleware', MIDDLEWARE_PATH, 'Middleware, by path');
  if (LAYOUT_PATH.test(path)) return convention('layout', LAYOUT_PATH, 'A layout, by path');
  if (PAGE_PATH.test(path)) return convention('page', PAGE_PATH, 'A page, by path');
  const inside = contents(index, node);
  const named = (type: string) => inside.get(type)?.[0];
  if (inside.has('controller')) return { kind: 'controller', basis: 'indexed', reason: `Holds controller ${named('controller')}` };
  if (inside.has('model')) return { kind: 'model', basis: 'indexed', reason: `Holds model ${named('model')}` };
  if (inside.has('hook') && /^use[A-Z]/.test(name)) return { kind: 'hook', basis: 'indexed', reason: `Exports hook ${named('hook')}` };
  if (inside.has('component')) return { kind: 'component', basis: 'indexed', reason: `Holds ${inside.get('component')!.length === 1 ? `component ${named('component')}` : plural(inside.get('component')!.length, 'component')}` };
  if (inside.has('hook')) return { kind: 'hook', basis: 'indexed', reason: `Exports hook ${named('hook')}` };
  if (CONTROLLER_PATH.test(path)) return convention('controller', CONTROLLER_PATH, 'A controller, by path');
  if (MODEL_PATH.test(path)) return convention('model', MODEL_PATH, 'A model, by path');
  if (MIGRATION_PATH.test(path) || TABLE_PATH.test(path)) return convention('table', TABLE_PATH, 'A migration or schema, by path');
  if (SCHEDULE_PATH.test(path)) return convention('schedule', SCHEDULE_PATH, 'A schedule, by path');
  if (COMMAND_PATH.test(path)) return convention('command', COMMAND_PATH, 'A console command, by path');
  if (JOB_PATH.test(path)) return convention('job', JOB_PATH, 'A job or listener, by path');
  if (SERVICE_PATH.test(path)) return convention('service', SERVICE_PATH, 'A service, by path');
  if (HELPER_PATH.test(path)) return convention('helper', HELPER_PATH, 'A helper, by path');
  if (ROUTES_PATH.test(path)) return convention('routes', ROUTES_PATH, 'Routes, by path');
  if (HOOK_PATH.test(path)) return convention('hook', HOOK_PATH, 'A hook, by path');
  if (COMPONENT_PATH.test(path)) return convention('component', COMPONENT_PATH, 'A component, by path');
  if (COMPONENT_LANGUAGES.has(language)) return { kind: 'component', basis: 'language', reason: `A ${language === 'vue' ? 'Vue' : language === 'svelte' ? 'Svelte' : 'Astro'} component file` };
  return undefined;
}

/** Names of the symbols a file contains, by archetype-bearing type (hooks are functions with the hook role). */
function contents(index: ProjectionIndex, file: ProjectionNode): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const visit = (id: string, depth: number) => {
    for (const childId of index.node(id)?.children ?? []) {
      const child = index.node(childId);
      if (!child || child.kind !== 'entity' || child.change?.status === 'removed') continue;
      const type = child.type === 'function' && child.role === 'hook' ? 'hook' : child.type;
      if (type === 'controller' || type === 'model' || type === 'component' || type === 'hook') { const list = found.get(type) ?? []; list.push(child.name); found.set(type, list); }
      if (depth < 2) visit(childId, depth + 1);
    }
  };
  visit(file.id, 0);
  return found;
}
