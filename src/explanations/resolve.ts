// Resolving explanation links against the live index: what each names on the
// map, what lights with it, and a fingerprint of its code so a later index can
// tell whether it changed since the text was written.
import { createHash } from 'node:crypto';
import type { LinkContext } from '../projection/service.js';
import type { ProjectionNode } from '../projection/hierarchy.js';
import { SYMBOL_TYPES } from '../projection/hierarchy.js';
import { linksIn, parseLink, pathHref, schemeHref, type ParsedLink } from './links.js';
import type { ResolvedLink } from './model.js';

/** Commits of the current branch (oldest first) with their pull request number and snapshot, for `commit:` and `pr:` links. */
export interface CommitRef { sha: string; subject: string; pr?: number; snapshot?: string }
export interface ResolveEnvironment { context: LinkContext; commits: CommitRef[] }
/** Files lit for a folder, flow or feature link, at most. */
export const MEMBER_LIMIT = 2000;
/** Entities lit by one explanation, at most. */
export const FOOTPRINT_LIMIT = 6000;
const CONTAINERS = new Set(['repository', 'application', 'directory', 'group']);
const ENTRY_TYPES = new Set(['route', 'api_endpoint', 'command', 'scheduled_task', 'user_flow']);

export function resolveLink(parsed: ParsedLink, environment: ResolveEnvironment): ResolvedLink {
  const { context } = environment;
  const base = { href: parsed.href, kind: parsed.kind } as const;
  switch (parsed.kind) {
    case 'external': return { ...base, status: 'external' };
    case 'path': return resolvePath(parsed, context);
    case 'flow': {
      const flow = findFlow(context, parsed.target);
      if (!flow) return { ...base, status: 'missing', reason: `No flow starts at "${parsed.target}"; use the name the flows tool lists (e.g. "POST /api/orders", "/cart", "app:sync")` };
      const entry = context.index.node(flow.summary.entry.id);
      return { ...base, status: 'ok', ...entityFields(context, entry ?? context.index.node(flow.summary.id)!), label: flow.summary.title ?? flow.summary.name, detail: flow.summary.detail, members: bounded([...flow.members]) };
    }
    case 'table': {
      const wanted = parsed.target.toLowerCase();
      const table = [...context.index.nodes.values()].find(node => node.type === 'database_table' && node.change?.status !== 'removed' && node.name.toLowerCase() === wanted);
      return table ? { ...base, status: 'ok', ...entityFields(context, table) } : { ...base, status: 'missing', reason: `No table named ${parsed.target} is declared by the indexed migrations` };
    }
    case 'feature': {
      const result = context.features();
      const wanted = parsed.target.toLowerCase();
      const feature = result.features.find(item => item.key.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
      if (!feature) return { ...base, status: 'missing', reason: result.features.length ? `No feature ${parsed.target}; features are ${result.features.map(item => item.key).join(', ')}` : 'No features are described (run annotate)' };
      return { ...base, status: 'ok', feature: feature.key, label: feature.name, members: bounded(Object.keys(result.of).filter(id => result.of[id] === feature.key && context.index.node(id)?.type === 'file')) };
    }
    case 'commit': {
      if (!/^[0-9a-f]{4,40}$/.test(parsed.target)) return { ...base, status: 'missing', reason: 'A commit link takes a SHA (at least 4 hexadecimal characters)' };
      const matches = environment.commits.filter(commit => commit.sha.startsWith(parsed.target));
      if (matches.length !== 1) return { ...base, status: 'missing', reason: matches.length ? `${parsed.target} names ${matches.length} commits; give more characters` : `No commit ${parsed.target} on the current branch` };
      const commit = matches[0]!;
      return { ...base, status: 'ok', sha: commit.sha, label: commit.subject, ...(commit.snapshot ? { snapshot: commit.snapshot } : {}) };
    }
    case 'pr': {
      const number = Number(parsed.target);
      const commit = Number.isInteger(number) ? [...environment.commits].reverse().find(item => item.pr === number) : undefined;
      if (!commit) return { ...base, status: 'missing', reason: `No merged pull request #${parsed.target} on the current branch (Git records it only in merge and squash messages)` };
      return { ...base, status: 'ok', sha: commit.sha, label: commit.subject, ...(commit.snapshot ? { snapshot: commit.snapshot } : {}) };
    }
  }
}

function resolvePath(parsed: ParsedLink, context: LinkContext): ResolvedLink {
  const base = { href: parsed.href, kind: 'path' as const };
  let id = context.byPath.get(parsed.target);
  let reason: string | undefined;
  if (id === undefined && parsed.target) {
    // Written relative to an application (`app/Models/User.php` for `backend/app/Models/User.php`): accepted when one path ends so.
    const suffix = `/${parsed.target}`;
    const candidates = [...context.byPath.keys()].filter(key => key.endsWith(suffix));
    if (candidates.length === 1) { id = context.byPath.get(candidates[0]!); reason = `Matched ${candidates[0]}; link it by its full path`; }
    else if (candidates.length > 1) return { ...base, status: 'missing', reason: `${parsed.target} matches ${candidates.length} paths (${candidates.slice(0, 4).join(', ')}…); give the full path` };
  }
  const node = id ? context.index.node(id) : undefined;
  if (!node) return { ...base, status: 'missing', reason: 'No indexed file or folder has this path (paths are relative to the repository root)' };
  let target = node;
  let lines = parsed.lines;
  if (parsed.symbol) {
    const symbol = node.type === 'file' ? findSymbol(context, node, parsed.symbol) : undefined;
    if (!symbol) return { ...base, status: 'missing', path: node.path, reason: node.type === 'file' ? `No symbol ${parsed.symbol} is indexed in ${node.path}` : `${node.path} is a folder; symbols are linked inside their file` };
    target = symbol;
  } else if (lines && node.type === 'file') {
    const inner = innermostAt(context, node, lines.start);
    if (inner) target = inner;
  }
  if (!lines && target.sourceRange && target !== node) lines = { start: target.sourceRange.startLine, end: target.sourceRange.endLine };
  const container = CONTAINERS.has(target.type);
  return {
    ...base, status: 'ok', ...entityFields(context, target), ...(lines ? { lines } : {}),
    ...(container ? { members: bounded(filesUnder(context, target)) } : {}), ...(reason ? { reason } : {}),
  };
}
function entityFields(context: LinkContext, node: ProjectionNode): Pick<ResolvedLink, 'id' | 'type' | 'name' | 'path' | 'ancestors'> {
  return { id: node.id, type: node.type, name: node.name, ...(node.path ? { path: node.path } : {}), ancestors: context.index.spatialAncestors(node).map(item => item.id) };
}
function bounded(ids: string[]): string[] { return ids.length > MEMBER_LIMIT ? ids.slice(0, MEMBER_LIMIT) : ids; }
/** Indexed files inside a container, in index order. */
function filesUnder(context: LinkContext, container: ProjectionNode): string[] {
  const files: string[] = [];
  for (const node of context.index.nodes.values()) if (node.type === 'file' && node.change?.status !== 'removed' && context.index.contains(container, node)) files.push(node.id);
  return files;
}
function symbolsOf(context: LinkContext, file: ProjectionNode): ProjectionNode[] {
  const result: ProjectionNode[] = [];
  const visit = (node: ProjectionNode) => { for (const id of node.children) { const child = context.index.node(id); if (child && child.kind === 'entity') { result.push(child); visit(child); } } };
  visit(file);
  return result;
}
/** A symbol of a file by name, `Class.method` (also `::`, `->`, `#`), or the end of its qualified name; exact before case-insensitive. */
function findSymbol(context: LinkContext, file: ProjectionNode, wanted: string): ProjectionNode | undefined {
  const symbols = symbolsOf(context, file);
  const parts = wanted.split(/::|->|\.|#|\\/).filter(Boolean);
  const byChain = (fold: (text: string) => string) => {
    if (parts.length < 2) return undefined;
    return symbols.find(symbol => {
      if (fold(symbol.name) !== fold(parts.at(-1)!)) return false;
      let parent = symbol.canonicalParentId ? context.index.node(symbol.canonicalParentId) : undefined;
      for (let index = parts.length - 2; index >= 0; index--) {
        if (!parent || fold(parent.name) !== fold(parts[index]!)) return false;
        parent = parent.canonicalParentId ? context.index.node(parent.canonicalParentId) : undefined;
      }
      return true;
    });
  };
  for (const fold of [(text: string) => text, (text: string) => text.toLowerCase()]) {
    const found = symbols.find(symbol => fold(symbol.name) === fold(wanted)) ?? byChain(fold)
      ?? symbols.find(symbol => symbol.qualifiedName && [`\\`, '::', '.', '#', '/'].some(separator => fold(symbol.qualifiedName!).endsWith(fold(`${separator}${wanted}`))));
    if (found) return found;
  }
  return undefined;
}
function innermostAt(context: LinkContext, file: ProjectionNode, line: number): ProjectionNode | undefined {
  let best: ProjectionNode | undefined;
  for (const symbol of symbolsOf(context, file)) {
    const range = symbol.sourceRange;
    if (!range || line < range.startLine || line > range.endLine || !SYMBOL_TYPES.has(symbol.type)) continue;
    if (!best || range.endLine - range.startLine < best.sourceRange!.endLine - best.sourceRange!.startLine) best = symbol;
  }
  return best;
}
function findFlow(context: LinkContext, wanted: string): LinkContext['flows'][number] | undefined {
  const flows = context.flows.filter(flow => flow.summary.kind !== 'unmatched');
  const exact = flows.find(flow => flow.summary.name === wanted || flow.summary.id === wanted || flow.summary.entry.id === wanted);
  if (exact) return exact;
  const fold = wanted.toLowerCase().replace(/\s+/g, ' ');
  const folded = flows.filter(flow => flow.summary.name.toLowerCase() === fold || flow.summary.entry.name.toLowerCase() === fold || flow.summary.title?.toLowerCase() === fold);
  if (folded.length === 1) return folded[0];
  // A route without its method: the one flow at that path.
  const byPath = flows.filter(flow => flow.summary.path?.toLowerCase() === fold || flow.summary.name.toLowerCase().replace(/^[a-z]+ /, '') === fold);
  return byPath.length === 1 ? byPath[0] : folded[0];
}

/** What a link's code is now: changes when the code it names changes (undefined: nothing to compare). */
export function fingerprintOf(link: ResolvedLink, context: LinkContext): string | undefined {
  if (link.status === 'missing' || link.status === 'external' || !link.id && !link.members) return undefined;
  if (link.kind === 'path' && link.type && !CONTAINERS.has(link.type)) return link.id ? context.fingerprint(link.id) : undefined;
  if (link.kind === 'table') return link.id ? context.fingerprint(link.id) : undefined;
  if (link.kind === 'flow' || (link.kind === 'path' && link.type !== 'repository')) {
    const files = new Set<string>();
    for (const id of link.members ?? []) { const file = context.fileOf(id); if (file) files.add(file); }
    if (!files.size) return undefined;
    const hash = createHash('sha256');
    for (const file of [...files].sort()) hash.update(`${file}=${context.fingerprint(file) ?? ''}\n`);
    return `set:${hash.digest('hex').slice(0, 24)}`;
  }
  return undefined;
}

/** Every link of a Markdown text, resolved, once per href. */
export function resolveAll(markdown: string, environment: ResolveEnvironment, cache = new Map<string, ResolvedLink>()): ResolvedLink[] {
  const result: ResolvedLink[] = [];
  for (const occurrence of linksIn(markdown)) {
    if (cache.has(occurrence.href)) { if (!result.some(item => item.href === occurrence.href)) result.push(cache.get(occurrence.href)!); continue; }
    const parsed = parseLink(occurrence.href);
    if (!parsed) continue;
    const resolved = resolveLink(parsed, environment);
    cache.set(occurrence.href, resolved);
    result.push(resolved);
  }
  return result;
}
/** What lights on the map for these links: their entities (members for folders, flows, features) and the areas holding them. */
export function footprintOf(links: ResolvedLink[], context: LinkContext): { ids: string[]; areas: Record<string, number> } {
  const ids = new Set<string>();
  for (const link of links) {
    if (link.status !== 'ok' && link.status !== 'changed') continue;
    if (link.id && link.type !== 'repository') ids.add(link.id);
    if (link.type !== 'repository') for (const id of link.members ?? []) { if (ids.size >= FOOTPRINT_LIMIT) break; ids.add(id); }
  }
  const areas: Record<string, number> = {};
  for (const id of ids) {
    const node = context.index.node(id);
    if (!node) continue;
    for (const ancestor of context.index.spatialAncestors(node)) areas[ancestor.id] = (areas[ancestor.id] ?? 0) + 1;
  }
  return { ids: [...ids], areas };
}
/** The href a tool returns for an indexed entity (what a model should copy into its text). */
export function hrefOf(node: Pick<ProjectionNode, 'id' | 'type' | 'name' | 'path' | 'canonicalParentId' | 'qualifiedName'>, context: LinkContext): string | undefined {
  if (node.type === 'repository') return './';
  if (node.type === 'database_table') return schemeHref('table', node.name);
  // Entry points: by the flow that starts there.
  const flow = ENTRY_TYPES.has(node.type) ? context.flows.find(item => item.summary.entry.id === node.id && item.summary.kind !== 'unmatched') : undefined;
  if (flow) return schemeHref('flow', flow.summary.name);
  if (!node.path) return undefined;
  if (node.type === 'file') return pathHref(node.path);
  if (CONTAINERS.has(node.type)) return pathHref(node.path, { folder: true });
  if (ENTRY_TYPES.has(node.type)) return pathHref(node.path);
  // A symbol: Class.method when it sits in a class, else its name.
  const parent = node.canonicalParentId ? context.index.node(node.canonicalParentId) : undefined;
  const chain = parent && parent.type !== 'file' && SYMBOL_TYPES.has(parent.type) ? `${parent.name}.${node.name}` : node.name;
  return pathHref(node.path, { symbol: chain });
}
