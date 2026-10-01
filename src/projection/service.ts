// Read-only projection queries for the visualizer. Built from the current
// SQLite snapshot and rebuilt when a new analysis run becomes current.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SourceRange } from '../core/graph.js';
import { pagination, type GraphStore } from '../storage/sqlite.js';
import { LAYOUT_VERSION, layoutHierarchy, type LayoutState, type Rect } from './layout.js';
import { ProjectionIndex, type EntityRow, type ProjectionNode } from './hierarchy.js';
import type { AggregateResult, DiagnosticsPage, LocateResult, NodeSummary, Page, ProjectionMeta, RelationItem, RelationsPage, SearchPage } from './dto.js';
export type { NodeSummary, Page, RelationItem } from './dto.js';
export class NotFoundError extends Error {}
interface Current { runId: string; index: ProjectionIndex; rects: Map<string, Rect>; persisted: boolean; holes: number }
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

export class ProjectionService {
  private current?: Current;
  constructor(private readonly store: GraphStore, private readonly options: { stateDirectory?: string } = {}) {}

  private load(): Current {
    const run = this.store.currentRun();
    if (!run) throw new NotFoundError('No indexed graph; run index first');
    if (this.current?.runId === run.id) return this.current;
    const db = this.store.db;
    const rows: EntityRow[] = db.prepare(`SELECT e.id, e.type, e.name, e.path, e.language, e.parent_id, e.source_range,
      json_extract(e.metadata,'$.qualifiedName') AS qualified_name, json_extract(e.metadata,'$.signature') AS signature,
      json_extract(e.metadata,'$.routePath') AS route_path, json_extract(e.metadata,'$.method') AS http_method,
      json_extract(e.metadata,'$.framework') AS framework, json_extract(e.metadata,'$.role') AS role,
      json_extract(e.metadata,'$.analysisSkipped') AS skipped, json_extract(metric.data,'$.loc') AS loc
      FROM entities e LEFT JOIN metrics metric ON metric.entity_id=e.id ORDER BY e.id`).all().map(row => ({
      id: String(row.id), type: String(row.type), name: String(row.name),
      ...(row.path ? { path: String(row.path) } : {}), ...(row.language ? { language: String(row.language) } : {}),
      ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), ...(row.source_range ? { sourceRange: JSON.parse(String(row.source_range)) as SourceRange } : {}),
      ...(typeof row.loc === 'number' ? { loc: row.loc } : {}), ...(row.qualified_name ? { qualifiedName: String(row.qualified_name) } : {}),
      ...(typeof row.signature === 'string' ? { signature: row.signature } : {}), ...(row.route_path ? { routePath: String(row.route_path) } : {}),
      ...(row.http_method ? { method: String(row.http_method) } : {}), ...(row.framework ? { framework: String(row.framework) } : {}),
      ...(row.role ? { role: String(row.role) } : {}), ...(row.skipped ? { analysisSkipped: String(row.skipped) } : {}),
    }));
    const relations = db.prepare("SELECT id, from_id, to_id, type FROM relations WHERE type != 'contains' ORDER BY id").all().map(row => ({ id: String(row.id), from: String(row.from_id), to: String(row.to_id), type: String(row.type) }));
    const diagnostics = db.prepare('SELECT * FROM diagnostics ORDER BY id').all().map(row => ({ id: String(row.id), analyzer: String(row.analyzer), severity: String(row.severity), code: String(row.code), reason: String(row.reason), ...(row.file ? { file: String(row.file) } : {}), ...(row.line ? { line: Number(row.line) } : {}), ...(row.entity_id ? { entityId: String(row.entity_id) } : {}) }));
    const index = new ProjectionIndex(run.id, rows, relations, diagnostics);
    const file = this.options.stateDirectory ? path.join(this.options.stateDirectory, 'layout.json') : undefined;
    let previous: LayoutState | undefined;
    if (file) { try { const parsed = JSON.parse(readFileSync(file, 'utf8')) as LayoutState & { repositoryId?: string }; if (parsed.version === LAYOUT_VERSION && parsed.repositoryId === run.repositoryId) previous = parsed; } catch { /* first layout or unreadable state: start fresh */ } }
    const result = layoutHierarchy(index.layoutNodes(), index.rootId, previous);
    let persisted = false;
    if (file) {
      try {
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...result.state, repositoryId: run.repositoryId, runId: run.id }));
        renameSync(temporary, file); persisted = true;
      } catch { /* read-only state directory: layout is still deterministic for this graph */ }
    }
    this.current = { runId: run.id, index, rects: result.rects, persisted, holes: result.holes };
    return this.current;
  }
  private summary(current: Current, node: ProjectionNode): NodeSummary {
    return {
      id: node.id, kind: node.kind, type: node.type, name: node.name,
      ...(node.path ? { path: node.path } : {}), ...(node.language ? { language: node.language } : {}), ...(node.sourceRange ? { sourceRange: node.sourceRange } : {}),
      ...(node.canonicalParentId ? { canonicalParentId: node.canonicalParentId } : {}), ...(node.spatialParentId ? { spatialParentId: node.spatialParentId } : {}),
      depth: node.depth, rect: current.rects.get(node.id)!, childCount: node.children.length,
      ...(node.loc !== undefined ? { loc: node.loc } : {}), ...(node.detail ? { detail: node.detail } : {}), ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
      ...(node.role ? { role: node.role } : {}), ...(node.explanation ? { explanation: node.explanation } : {}),
      diagnostics: node.diagnostics, stats: node.stats,
    };
  }
  private require(current: Current, id: string): ProjectionNode {
    const node = current.index.node(id);
    if (!node) throw new NotFoundError(`Unknown projection node ${id}`);
    return node;
  }
  meta(): ProjectionMeta {
    const current = this.load();
    const db = this.store.db;
    const root = current.index.node(current.index.rootId)!;
    const count = (sql: string) => Number(db.prepare(sql).get()!.count);
    return {
      run: this.store.currentRun()!,
      root: this.summary(current, root),
      layout: { version: LAYOUT_VERSION, persisted: current.persisted, holes: current.holes, bounds: current.rects.get(root.id) },
      entityTypes: db.prepare('SELECT type, count(*) AS count FROM entities GROUP BY type ORDER BY type').all().map(row => ({ type: String(row.type), count: Number(row.count) })),
      relationTypes: db.prepare('SELECT type, count(*) AS count FROM relations GROUP BY type ORDER BY type').all().map(row => ({ type: String(row.type), count: Number(row.count) })),
      diagnosticSeverities: db.prepare('SELECT severity, count(*) AS count FROM diagnostics GROUP BY severity ORDER BY severity').all().map(row => ({ severity: String(row.severity), count: Number(row.count) })),
      coverage: {
        databaseTables: count("SELECT count(*) AS count FROM entities WHERE type='database_table'"),
        resolvedHttpRequests: count("SELECT count(*) AS count FROM relations WHERE type='requests'"),
        unresolvedHttpCalls: count("SELECT count(*) AS count FROM diagnostics WHERE code IN ('unresolved-http-call','unresolved-http-url','unmatched-http-call','ambiguous-http-match','constrained-http-match','unverified-relative-api-boundary')"),
        calls: count("SELECT count(*) AS count FROM relations WHERE type IN ('calls','renders')"),
        gitHistory: count("SELECT count(*) AS count FROM metrics WHERE json_extract(data,'$.churn') IS NOT NULL"),
      },
    };
  }
  children(id: string, options: { limit?: number; offset?: number }): Page<NodeSummary> {
    const current = this.load();
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const ids = node.children.slice(offset, offset + limit);
    return { items: ids.map(child => this.summary(current, current.index.node(child)!)), limit, offset, total: node.children.length, hasMore: offset + limit < node.children.length };
  }
  nodes(ids: string[]): { items: NodeSummary[]; missing: string[] } {
    if (ids.length > 200) throw new Error('At most 200 ids per request');
    const current = this.load();
    const items: NodeSummary[] = [], missing: string[] = [];
    for (const id of ids) { const node = current.index.node(id); if (node) items.push(this.summary(current, node)); else missing.push(id); }
    return { items, missing };
  }
  locate(id: string): LocateResult {
    const current = this.load();
    const node = this.require(current, id);
    return {
      node: this.summary(current, node),
      spatialAncestors: current.index.spatialAncestors(node).map(item => this.summary(current, item)),
      canonicalAncestors: current.index.canonicalAncestors(node).map(item => ({ id: item.id, type: item.type, name: item.name })),
    };
  }
  search(query: string, options: { type?: string; limit?: number; offset?: number }): SearchPage {
    const { limit, offset } = pagination({ limit: options.limit ?? 30, offset: options.offset });
    const text = query.trim().toLowerCase();
    if (!text) throw new Error('search query is required');
    if (text.length > 200) throw new Error('search must be at most 200 characters');
    const current = this.load();
    const tokens = text.split(/\s+/);
    const scored: { node: ProjectionNode; score: number }[] = [];
    const typeCounts = new Map<string, number>();
    for (const node of current.index.nodes.values()) {
      if (node.kind !== 'entity' || !tokens.every(token => node.search.includes(token))) continue;
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
      if (options.type && node.type !== options.type) continue;
      const name = node.name.toLowerCase(), qualified = node.qualifiedName?.toLowerCase();
      // Multi-word queries (e.g. "LoginForm.tsx login") rank by the word that best matches the name.
      const rank = (term: string) => name === term ? 0 : qualified === term || qualified?.endsWith(`\\${term}`) || qualified?.endsWith(`::${term}`) || qualified?.endsWith(`.${term}`) ? 1 : name.startsWith(term) ? 2 : name.includes(term) ? 3 : qualified?.includes(term) ? 4 : 5;
      scored.push({ node, score: Math.min(rank(text), ...(tokens.length > 1 ? tokens.map(rank) : [])) });
    }
    scored.sort((a, b) => a.score - b.score || a.node.name.length - b.node.name.length || a.node.depth - b.node.depth || (a.node.name < b.node.name ? -1 : a.node.name > b.node.name ? 1 : a.node.id < b.node.id ? -1 : 1));
    const items = scored.slice(offset, offset + limit).map(({ node }) => ({ ...this.summary(current, node), breadcrumb: current.index.canonicalAncestors(node).slice(1).map(item => item.name).join(' › ') }));
    return { items, limit, offset, total: scored.length, hasMore: offset + limit < scored.length, typeCounts: [...typeCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)) };
  }
  private relationItems(current: Current, indices: number[], perspective: (index: number) => { direction: RelationItem['direction']; otherId: string }): RelationItem[] {
    const relations = indices.map(index => current.index.relations[index]!);
    const metadata = new Map<string, Record<string, unknown>>();
    if (relations.length) {
      const rows = this.store.db.prepare(`SELECT id, metadata FROM relations WHERE id IN (${relations.map(() => '?').join(',')})`).all(...relations.map(relation => relation.id));
      for (const row of rows) if (row.metadata) metadata.set(String(row.id), JSON.parse(String(row.metadata)));
    }
    return indices.map(index => {
      const relation = current.index.relations[index]!;
      const { direction, otherId } = perspective(index);
      const other = current.index.node(otherId)!;
      return { id: relation.id, type: relation.type, direction, other: this.summary(current, other), otherAncestors: current.index.spatialAncestors(other).map(node => node.id), ...(metadata.has(relation.id) ? { metadata: metadata.get(relation.id) } : {}) };
    });
  }
  relations(id: string, options: { direction?: string; type?: string; limit?: number; offset?: number }): RelationsPage {
    const current = this.load();
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const direction = options.direction ?? 'both';
    if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('direction must be incoming, outgoing or both');
    const all = (current.index.adjacency.get(node.id) ?? []).map(index => {
      const relation = current.index.relations[index]!;
      const dir: RelationItem['direction'] = relation.from === relation.to ? 'self' : relation.from === node.id ? 'outgoing' : 'incoming';
      return { index, relation, direction: dir, otherId: dir === 'incoming' ? relation.from : relation.to };
    });
    const counts = new Map<string, number>();
    for (const item of all) { const key = `${item.relation.type}\u0000${item.direction}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    const filtered = all.filter(item => (direction === 'both' || item.direction === direction || item.direction === 'self') && (!options.type || item.relation.type === options.type));
    const rank = { outgoing: 0, self: 1, incoming: 2 };
    filtered.sort((a, b) => rank[a.direction] - rank[b.direction] || (a.relation.type < b.relation.type ? -1 : a.relation.type > b.relation.type ? 1 : 0) || compareNames(current, a.otherId, b.otherId) || (a.relation.id < b.relation.id ? -1 : 1));
    const page = filtered.slice(offset, offset + limit);
    const lookup = new Map(page.map(item => [item.index, item]));
    return {
      items: this.relationItems(current, page.map(item => item.index), index => lookup.get(index)!),
      limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length,
      typeCounts: [...counts].map(([key, count]) => { const [type, dir] = key.split('\u0000'); return { type: type!, direction: dir!, count }; }).sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.direction < b.direction ? -1 : 1),
    };
  }
  /** Classify every non-containment relation touching the subtree of `container`. */
  private crossing(current: Current, container: ProjectionNode, filter: { type?: string; direction?: string }) {
    const index = current.index;
    const ancestors = new Set([container.id, ...index.spatialAncestors(container).map(node => node.id)]);
    const anchorOf = (id: string): string => {
      // The anchor is the outside endpoint's ancestor just below the lowest common ancestor with the container.
      let previous = id;
      for (let node = index.node(id); node; node = node.spatialParentId ? index.node(node.spatialParentId) : undefined) {
        if (ancestors.has(node.id)) return node.id === id ? id : previous;
        previous = node.id;
      }
      return previous;
    };
    const internal = new Map<string, number>();
    const crossing: { relationIndex: number; direction: 'outgoing' | 'incoming'; anchor: string; type: string; outside: string }[] = [];
    index.relations.forEach((relation, relationIndex) => {
      if (filter.type && relation.type !== filter.type) return;
      const fromInside = index.contains(container, index.node(relation.from)!), toInside = index.contains(container, index.node(relation.to)!);
      if (fromInside && toInside) { internal.set(relation.type, (internal.get(relation.type) ?? 0) + 1); return; }
      if (!fromInside && !toInside) return;
      const direction: 'outgoing' | 'incoming' = fromInside ? 'outgoing' : 'incoming';
      if (filter.direction && filter.direction !== 'both' && filter.direction !== direction) return;
      const outside = fromInside ? relation.to : relation.from;
      crossing.push({ relationIndex, direction, anchor: anchorOf(outside), type: relation.type, outside });
    });
    return { internal, crossing };
  }
  aggregate(id: string, options: { type?: string; direction?: string }): AggregateResult {
    const current = this.load();
    const container = this.require(current, id);
    const { internal, crossing } = this.crossing(current, container, options);
    const groups = new Map<string, { anchor: string; type: string; direction: string; count: number }>();
    for (const item of crossing) {
      const key = `${item.direction}\u0000${item.type}\u0000${item.anchor}`;
      const group = groups.get(key) ?? { anchor: item.anchor, type: item.type, direction: item.direction, count: 0 };
      group.count++; groups.set(key, group);
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count || (a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.anchor < b.anchor ? -1 : 1));
    return {
      internal: [...internal].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
      groups: sorted.slice(0, 200).map(group => { const anchor = current.index.node(group.anchor)!; return { ...group, anchor: this.summary(current, anchor), anchorAncestors: current.index.spatialAncestors(anchor).map(node => node.id) }; }),
      totalCrossing: crossing.length, truncated: sorted.length > 200,
    };
  }
  aggregateEdges(id: string, options: { anchor: string; type?: string; direction?: string; limit?: number; offset?: number }): Page<RelationItem & { inside: NodeSummary }> {
    const current = this.load();
    const container = this.require(current, id);
    this.require(current, options.anchor);
    const { limit, offset } = pagination(options);
    const { crossing } = this.crossing(current, container, options);
    const matching = crossing.filter(item => item.anchor === options.anchor);
    matching.sort((a, b) => compareNames(current, a.outside, b.outside) || a.relationIndex - b.relationIndex);
    const page = matching.slice(offset, offset + limit);
    const lookup = new Map(page.map(item => [item.relationIndex, item]));
    const items = this.relationItems(current, page.map(item => item.relationIndex), index => ({ direction: lookup.get(index)!.direction, otherId: lookup.get(index)!.outside })).map((item, i) => {
      const relation = current.index.relations[page[i]!.relationIndex]!;
      return { ...item, inside: this.summary(current, current.index.node(item.direction === 'outgoing' ? relation.from : relation.to)!) };
    });
    return { items, limit, offset, total: matching.length, hasMore: offset + limit < matching.length };
  }
  diagnostics(id: string, options: { limit?: number; offset?: number; severity?: string }): DiagnosticsPage {
    const current = this.load();
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const range = node.kind === 'entity' && node.type !== 'file' && node.path && node.sourceRange ? node.sourceRange : undefined;
    const matching = current.index.diagnostics.filter(item => {
      const owner = current.index.node(item.nodeId)!;
      if (current.index.contains(node, owner)) return true;
      // File-level findings that fall inside a symbol's indexed source range.
      return !!range && item.file === node.path && item.line !== undefined && item.line >= range.startLine && item.line <= range.endLine;
    });
    const codes = new Map<string, { code: string; severity: string; count: number }>();
    for (const item of matching) { const key = `${item.severity}\u0000${item.code}`; const entry = codes.get(key) ?? { code: item.code, severity: item.severity, count: 0 }; entry.count++; codes.set(key, entry); }
    const filtered = matching.filter(item => !options.severity || item.severity === options.severity);
    filtered.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || (a.file ?? '').localeCompare(b.file ?? '', 'en') || (a.line ?? 0) - (b.line ?? 0) || (a.id < b.id ? -1 : 1));
    return {
      items: filtered.slice(offset, offset + limit).map(item => ({ ...item, nodeName: current.index.node(item.nodeId)!.name })),
      limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length,
      codes: [...codes.values()].sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
    };
  }
  between(a: string, b: string): { items: RelationItem[] } {
    const current = this.load();
    this.require(current, a); this.require(current, b);
    const indices = (current.index.adjacency.get(a) ?? []).filter(index => { const relation = current.index.relations[index]!; return (relation.from === a && relation.to === b) || (relation.from === b && relation.to === a); });
    return { items: this.relationItems(current, indices, index => { const relation = current.index.relations[index]!; return relation.from === a ? { direction: 'outgoing', otherId: b } : { direction: 'incoming', otherId: b }; }) };
  }
}
function compareNames(current: Current, a: string, b: string): number {
  const x = current.index.node(a)!.name, y = current.index.node(b)!.name;
  return x < y ? -1 : x > y ? 1 : 0;
}
