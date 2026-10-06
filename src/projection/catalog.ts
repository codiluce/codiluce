// Every flow of a view, by entry point, and what each one touches.
//
// An entry point is where behaviour starts: a page (a Next.js page route, or
// an endpoint serving an Inertia page), an HTTP endpoint, an Artisan command,
// a scheduled task, or code making a request no endpoint answers. Each flow's
// *slice* is the set of entities it touches: what the entry sets in motion,
// forward over routes, renders, calls, references, requests, handles, invokes
// and table access (navigation to another page's endpoint stops there, so one
// page's journey does not pull in every page it links to), plus the models
// mapping a table it reaches and the client side of its request picture.
//
// Coverage classifies every file from the slices: an entry point's file, in N
// flows, supporting flows (imported, extended or declaring a table by code in
// flows), tests and tooling, configuration, not reached but with a known
// reason (an unresolved call site of the same name, a command run by a dynamic
// name), not reached at all, outside the configured applications (scripts
// and tools the analyzers do not read for flows), or code in a language whose
// calls are not analyzed (on the map with its history, but no flow can reach
// it: like assets, it is not measured). Pure and bounded; built once per view.
import { CODE_LANGUAGES, FLOW_LANGUAGES } from '../core/languages.js';
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';

export type CatalogKind = 'page' | 'request' | 'command' | 'schedule' | 'unmatched';
export const CATALOG_KINDS: CatalogKind[] = ['page', 'request', 'command', 'schedule', 'unmatched'];
export type CoverageCategory = 'entry' | 'flow' | 'supporting' | 'test' | 'config' | 'explained' | 'unreached' | 'outside' | 'unanalyzed' | 'asset';
export const COVERAGE_CATEGORIES: CoverageCategory[] = ['entry', 'flow', 'supporting', 'test', 'config', 'explained', 'unreached', 'outside', 'unanalyzed', 'asset'];
/** Categories outside the measure: no flow can reach these files. */
export const NOT_MEASURED = new Set<CoverageCategory>(['unanalyzed', 'asset']);
export type CoverageCounts = Record<CoverageCategory, number>;
const SLICE_FOLLOW = new Set(['routes_to', 'renders', 'calls', 'references', 'requests', 'handles', 'invokes', 'reads', 'writes']);
const SUPPORT_TYPES = new Set(['imports', 'exports', 'extends', 'implements']);
export const SLICE_LIMIT = 6000;
const TEST_PATH = /(^|\/)(tests?|__tests__|__mocks__|e2e|cypress|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|Test\.php$|(^|\/)database\/(seeders|factories)\//i;
const CONFIG_PATH = /(^|\/)(config|bootstrap)\/|(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(next-env\.d|vite-env\.d|env\.d)\.ts$|(^|\/)(artisan|server\.php|index\.php)$/;
/** Classes the framework calls by registration: middleware, providers, kernels, exception handlers. */
const FRAMEWORK_PATH = /(^|\/)app\/(Http\/Middleware|Providers|Exceptions)\/|(^|\/)app\/(Http|Console)\/Kernel\.php$/;
const MIGRATION_PATH = /(^|\/)database\/migrations\//;

export function emptyCounts(): CoverageCounts { return { entry: 0, flow: 0, supporting: 0, test: 0, config: 0, explained: 0, unreached: 0, outside: 0, unanalyzed: 0, asset: 0 }; }
export function isCodeFile(node: Pick<ProjectionNode, 'type' | 'language'>): boolean { return node.type === 'file' && CODE_LANGUAGES.has(node.language ?? ''); }

/** Endpoints serving a page (their handler, or the route closure, renders a client component): navigation targets. */
export function pageEndpoints(index: ProjectionIndex): Set<string> {
  const pages = new Set<string>();
  const rendersClient = (id: string) => (index.adjacency.get(id) ?? []).some(i => { const relation = index.relations[i]!; return relation.from === id && relation.type === 'renders' && relation.change !== 'removed' && index.node(relation.to)?.language !== 'php'; });
  for (const node of index.nodes.values()) {
    if (node.type !== 'api_endpoint' || node.change?.status === 'removed' || !node.name.startsWith('GET ')) continue;
    if (rendersClient(node.id)) { pages.add(node.id); continue; }
    for (const i of index.adjacency.get(node.id) ?? []) { const relation = index.relations[i]!; if (relation.from === node.id && relation.type === 'handles' && rendersClient(relation.to)) { pages.add(node.id); break; } }
  }
  return pages;
}

/**
 * What an entry sets in motion: forward over behaviour relations, without
 * entering another page through navigation, plus models mapping the tables it
 * reaches. Bounded by `SLICE_LIMIT` entities.
 */
export function forwardSlice(index: ProjectionIndex, entry: string, pages: Set<string>): { members: Set<string>; truncated: boolean } {
  const members = new Set<string>([entry]);
  const queue = [entry];
  let truncated = false;
  while (queue.length) {
    const id = queue.shift()!;
    for (const i of index.adjacency.get(id) ?? []) {
      const relation = index.relations[i]!;
      if (relation.from !== id || relation.to === id || relation.change === 'removed' || !SLICE_FOLLOW.has(relation.type) || members.has(relation.to)) continue;
      if (members.size >= SLICE_LIMIT) { truncated = true; break; }
      members.add(relation.to);
      // Navigation reaches another page's endpoint: that is another journey.
      if (relation.type === 'requests' && pages.has(relation.to)) continue;
      queue.push(relation.to);
    }
  }
  for (const id of [...members]) {
    if (index.node(id)?.type !== 'database_table') continue;
    for (const i of index.adjacency.get(id) ?? []) { const relation = index.relations[i]!; if (relation.to === id && relation.type === 'maps_to' && relation.change !== 'removed') members.add(relation.from); }
  }
  return { members, truncated };
}

/** The file an entity belongs to: its file ancestor, else the file at its path (endpoints, tables, commands). */
export function fileResolver(index: ProjectionIndex): (id: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return id => {
    if (cache.has(id)) return cache.get(id);
    let found: string | undefined;
    for (let node = index.node(id); node; node = node.canonicalParentId ? index.node(node.canonicalParentId) : undefined) if (node.type === 'file') { found = node.id; break; }
    if (!found) { const path = index.node(id)?.path; found = path ? index.fileByPath.get(path) : undefined; }
    cache.set(id, found);
    return found;
  };
}

export interface CoverageInput {
  index: ProjectionIndex;
  /** Flow slices, and the names of the flows (for reasons). */
  flows: { name: string; members: Set<string> }[];
  /** Entities that start flows. */
  entries: string[];
  /** Unresolved call sites by called name: how many, and in which entities. */
  unresolvedNames: Map<string, { sites: number; entities: Set<string> }>;
  /** Console commands may also run by a name the analyzer could not read. */
  dynamicCommandRuns: number;
}
export interface FileCoverage { category: CoverageCategory; flows: number; reason: string }
export interface CoverageComputation { files: Map<string, FileCoverage>; areas: Map<string, CoverageCounts>; totals: CoverageCounts; codeFiles: number }

export function computeCoverage(input: CoverageInput): CoverageComputation {
  const { index } = input;
  const fileOf = fileResolver(index);
  const flowsByFile = new Map<string, number[]>();
  input.flows.forEach((flow, flowIndex) => {
    const files = new Set<string>();
    for (const id of flow.members) { const file = fileOf(id); if (file) files.add(file); }
    for (const file of files) { const list = flowsByFile.get(file) ?? []; list.push(flowIndex); flowsByFile.set(file, list); }
  });
  const entryFiles = new Map<string, string>();
  for (const id of input.entries) { const file = fileOf(id), node = index.node(id); if (file && node && !entryFiles.has(file)) entryFiles.set(file, `${node.type === 'route' ? 'page' : node.type === 'api_endpoint' ? 'endpoint' : node.type === 'scheduled_task' ? 'scheduled task' : node.type} ${node.name}`); }
  // Supporting: imported, re-exported, extended or implemented by code in a flow; migrations declaring a table a flow reaches.
  const support = new Map<string, Set<string>>();
  const inFlow = (file: string | undefined) => !!file && flowsByFile.has(file);
  for (const relation of index.relations) {
    if (relation.change === 'removed') continue;
    const from = fileOf(relation.from), to = fileOf(relation.to);
    if (!to || from === to || !SUPPORT_TYPES.has(relation.type) || !inFlow(from) || inFlow(to)) continue;
    const set = support.get(to) ?? new Set<string>(); set.add(from!); support.set(to, set);
  }
  // Barrels: a file re-exporting code that flows use forwards it (index.tsx → ./Component), through nested barrels too.
  const forwards = new Map<string, Set<string>>();
  const reexports = index.relations.filter(relation => relation.type === 'exports' && relation.change !== 'removed');
  for (let changed = true; changed;) {
    changed = false;
    for (const relation of reexports) {
      const from = fileOf(relation.from), to = fileOf(relation.to);
      if (!from || !to || from === to || inFlow(from) || support.has(from) || forwards.get(from)?.has(to) || !(inFlow(to) || support.has(to) || forwards.has(to))) continue;
      const set = forwards.get(from) ?? new Set<string>(); set.add(to); forwards.set(from, set); changed = true;
    }
  }
  const tablesInFlows = new Set<string>();
  for (const flow of input.flows) for (const id of flow.members) if (index.node(id)?.type === 'database_table') tablesInFlows.add(id);
  const declares = new Map<string, string[]>();
  for (const id of tablesInFlows) { const node = index.node(id)!; const file = node.path ? index.fileByPath.get(node.path) : undefined; if (file) declares.set(file, [...declares.get(file) ?? [], node.name]); }
  // Symbols per file, for name-only explanations; incoming relations, for islands.
  const symbolNames = new Map<string, string[]>();
  const incoming = new Map<string, Set<string>>();
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity' || !['function', 'method', 'component', 'class', 'controller', 'model'].includes(node.type) || node.name.length < 3) continue;
    const file = fileOf(node.id);
    if (file) symbolNames.set(file, [...symbolNames.get(file) ?? [], node.name]);
  }
  for (const relation of index.relations) {
    if (relation.change === 'removed' || relation.type === 'exports') continue;
    const from = fileOf(relation.from), to = fileOf(relation.to);
    if (from && to && from !== to) { const set = incoming.get(to) ?? new Set<string>(); set.add(from); incoming.set(to, set); }
  }
  const commandFiles = new Set<string>();
  for (const node of index.nodes.values()) if (node.type === 'command') { const file = fileOf(node.id); if (file) commandFiles.add(file); }
  const nameOf = (file: string) => index.node(file)?.name ?? file;
  const insideApplication = (node: ProjectionNode) => index.canonicalAncestors(node).some(item => item.type === 'application');
  /**
   * Code whose calls no analyzer resolves, wherever it is: a language without
   * an analyzer, or PHP in an application that is not Laravel (an
   * application's label is its primary framework). Outside the applications,
   * TypeScript, JavaScript and PHP stay "outside", as before.
   */
  const unanalyzed = (node: ProjectionNode) => !FLOW_LANGUAGES.has(node.language ?? '')
    || (node.language === 'php' && insideApplication(node) && index.canonicalAncestors(node).filter(item => item.type === 'application').at(-1)?.detail !== 'laravel');
  const listNames = (ids: Iterable<string>, max = 3) => { const names = [...ids].map(nameOf).sort(); return `${names.slice(0, max).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`; };

  const files = new Map<string, FileCoverage>();
  for (const node of index.nodes.values()) {
    if (node.type !== 'file' || node.change?.status === 'removed') continue;
    const flows = flowsByFile.get(node.id) ?? [];
    const path = node.path ?? '';
    let category: CoverageCategory, reason: string;
    if (!isCodeFile(node)) {
      category = 'asset';
      reason = support.has(node.id) ? `Not code; used by ${listNames(support.get(node.id)!)}` : 'Not code (styles, data, documents, images…): not measured for flow coverage';
    } else if (entryFiles.has(node.id)) { category = 'entry'; reason = `Entry point: ${entryFiles.get(node.id)}${flows.length ? `; in ${flows.length} flow${flows.length === 1 ? '' : 's'}` : ''}`; }
    else if (flows.length) { category = 'flow'; reason = `In ${flows.length} flow${flows.length === 1 ? '' : 's'}: ${flows.slice(0, 3).map(i => input.flows[i]!.name).join(', ')}${flows.length > 3 ? ` and ${flows.length - 3} more` : ''}`; }
    else if (unanalyzed(node) && !support.has(node.id)) { category = 'unanalyzed'; reason = `${node.language === 'php' ? 'PHP outside a Laravel application' : `Code in ${node.language}`}: its calls are not analyzed yet, so no flow can reach it (not measured)`; }
    else if (TEST_PATH.test(path)) { category = 'test'; reason = 'Tests or test data: run by the test runner, not by the application'; }
    else if (support.has(node.id)) { category = 'supporting'; reason = `Supports flows: imported or extended by ${listNames(support.get(node.id)!)}`; }
    else if (forwards.has(node.id)) { category = 'supporting'; reason = `Supports flows: re-exports ${listNames(forwards.get(node.id)!)}, which flows use`; }
    else if (declares.has(node.id)) { category = 'supporting'; reason = `Declares table${declares.get(node.id)!.length === 1 ? '' : 's'} ${declares.get(node.id)!.join(', ')}, which flows read or write`; }
    else if (CONFIG_PATH.test(path) || MIGRATION_PATH.test(path) || FRAMEWORK_PATH.test(path)) { category = 'config'; reason = MIGRATION_PATH.test(path) ? 'A migration whose tables no flow reaches' : FRAMEWORK_PATH.test(path) ? 'Registered with the framework (middleware, provider, kernel or exception handler): it runs around requests, but flows do not follow it yet' : 'Configuration or bootstrapping, loaded by the framework'; }
    else if (!insideApplication(node)) { category = 'outside'; reason = 'Outside the configured applications (scripts, tools, other projects): not analyzed for flows'; }
    else {
      const names = (symbolNames.get(node.id) ?? []).filter(name => input.unresolvedNames.has(name));
      const callers = incoming.get(node.id);
      if (names.length) {
        const sites = names.reduce((sum, name) => sum + input.unresolvedNames.get(name)!.sites, 0);
        category = 'explained'; reason = `Possibly reached: ${sites} unresolved call site${sites === 1 ? '' : 's'} call ${names.slice(0, 3).map(name => `${name}()`).join(', ')} by name (not proven)`;
      } else if (commandFiles.has(node.id) && input.dynamicCommandRuns) { category = 'explained'; reason = `A command that nothing schedules or runs by a literal name; ${input.dynamicCommandRuns} place${input.dynamicCommandRuns === 1 ? '' : 's'} run commands by a computed name, or it is run by hand`; }
      else if (callers?.size) { category = 'unreached'; reason = `Used only by code no flow reaches: ${listNames(callers)}`; }
      else { category = 'unreached'; reason = 'Nothing indexed calls, renders, imports or routes to it, and it is not an entry point'; }
    }
    files.set(node.id, { category, flows: flows.length, reason });
  }
  // Roll up per area (code files only, so assets do not dilute coverage).
  const areas = new Map<string, CoverageCounts>();
  const totals = emptyCounts();
  let codeFiles = 0;
  for (const [id, coverage] of files) {
    totals[coverage.category]++;
    if (!NOT_MEASURED.has(coverage.category)) codeFiles++;
    for (let node = index.node(index.node(id)!.spatialParentId ?? ''); node; node = node.spatialParentId ? index.node(node.spatialParentId) : undefined) {
      const counts = areas.get(node.id) ?? emptyCounts(); counts[coverage.category]++; areas.set(node.id, counts);
    }
  }
  return { files, areas, totals, codeFiles };
}
