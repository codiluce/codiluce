// Spatial projection of the canonical containment hierarchy.
//
// Canonical containment is never rewritten. The projection only adds
// *projection groups* (synthetic, clearly marked, never entities) where the
// canonical hierarchy has no spatial home for an entity: routes and endpoints
// are canonical children of their application, so they are placed in a
// "Routes & endpoints" district inside that application; database tables
// declared by its migrations go to a "Database" district; Artisan commands and
// scheduled tasks to a "Console" district.
import type { SourceRange } from '../core/graph.js';
import type { LayoutNode } from './layout.js';

export interface EntityRow {
  id: string; type: string; name: string; path?: string; language?: string; parentId?: string;
  sourceRange?: SourceRange; loc?: number; qualifiedName?: string; signature?: string;
  routePath?: string; method?: string; framework?: string; role?: string; analysisSkipped?: string;
  /** Comparison views only: how this entity differs from the baseline snapshot. */
  change?: NodeChange;
  /**
   * A projection group given as a row (the Features view: a domain, a folder
   * inside it): its explanation. Such rows are spatial only, never entities.
   */
  group?: string;
  /** A group row holding routes, tables and commands in districts, as an application does. */
  districts?: boolean;
  /** Database tables of the live index: the migrations that create or change them. */
  migrations?: string[];
}
export interface RelationRow { id: string; from: string; to: string; type: string; change?: 'added' | 'removed' }
export interface DiagnosticRow { id: string; severity: string; code: string; reason: string; analyzer: string; file?: string; line?: number; entityId?: string }
import type { ChangeCounts, NodeChange, NodeStats } from './dto.js';
export interface ProjectionNode {
  id: string; kind: 'entity' | 'group'; type: string; name: string;
  path?: string; language?: string; sourceRange?: SourceRange;
  canonicalParentId?: string; spatialParentId?: string;
  /** Spatial children in default order (first-layout order). */
  children: string[];
  depth: number; pre: number; post: number;
  loc?: number; detail?: string; qualifiedName?: string; role?: string;
  /** Present only on projection groups. */
  explanation?: string;
  ownDiagnostics: number; diagnostics: number; stats: NodeStats;
  change?: NodeChange;
  /** Comparison views only: changed entities below this node. */
  changes?: ChangeCounts;
  /** Database tables: the migrations that create or change them, when known. */
  migrations?: string[];
  search: string;
}
export const SYMBOL_TYPES = new Set(['class', 'controller', 'component', 'function', 'method', 'model', 'test']);
export const INTERFACE_TYPES = new Set(['route', 'api_endpoint']);
export const DATA_TYPES = new Set(['database_table']);
export const CONSOLE_TYPES = new Set(['command', 'scheduled_task']);
const BAND: Record<string, number> = { application: 0, group: 1, directory: 2, file: 3 };
const PADDING: Record<string, number> = { repository: 48, application: 28, group: 10, directory: 10, file: 4, class: 3, controller: 3, component: 3, function: 2, method: 2 };
function compareText(a: string, b: string): number { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; }
function routeSegment(row: EntityRow): string {
  const route = row.routePath ?? row.name.replace(/^[A-Z]+\s+/, '');
  const first = route.split('/').filter(Boolean)[0];
  return first === undefined ? '/' : `/${first}`;
}
/** Groups of interface entities are split by first path segment once a district holds more than this many. */
export const ROUTE_SUBGROUP_THRESHOLD = 16;

export class ProjectionIndex {
  readonly nodes = new Map<string, ProjectionNode>();
  readonly relations: RelationRow[];
  readonly adjacency = new Map<string, number[]>();
  readonly diagnostics: (DiagnosticRow & { nodeId: string })[] = [];
  readonly fileByPath = new Map<string, string>();
  readonly rootId: string;

  constructor(readonly runId: string, rows: EntityRow[], relations: RelationRow[], diagnostics: DiagnosticRow[], readonly comparison = false) {
    const root = rows.find(row => row.type === 'repository' && !row.parentId);
    if (!root) throw new Error('Projection requires a repository root');
    this.rootId = root.id;
    const canonicalChildren = new Map<string, EntityRow[]>();
    for (const row of rows) {
      if (row.type === 'file' && row.path) this.fileByPath.set(row.path, row.id);
      if (!row.parentId) continue;
      const list = canonicalChildren.get(row.parentId) ?? [];
      list.push(row); canonicalChildren.set(row.parentId, list);
    }
    const make = (row: EntityRow, spatialParentId: string | undefined, depth: number): ProjectionNode => {
      const node: ProjectionNode = {
        id: row.id, kind: row.group !== undefined ? 'group' : 'entity', type: row.group !== undefined ? 'group' : row.type, name: row.name, children: [], depth, pre: 0, post: 0,
        ...(row.group !== undefined ? { explanation: row.group } : {}),
        ...(row.path ? { path: row.path } : {}), ...(row.language ? { language: row.language } : {}),
        ...(row.sourceRange ? { sourceRange: row.sourceRange } : {}), ...(row.parentId ? { canonicalParentId: row.parentId } : {}),
        ...(spatialParentId ? { spatialParentId } : {}), ...(row.loc !== undefined ? { loc: row.loc } : {}),
        ...(row.qualifiedName ? { qualifiedName: row.qualifiedName } : {}), ...(row.role ? { role: row.role } : {}),
        ...(detail(row) ? { detail: detail(row) } : {}), ...(row.change ? { change: row.change } : {}), ...(row.migrations?.length ? { migrations: row.migrations } : {}),
        ownDiagnostics: 0, diagnostics: 0, stats: { files: 0, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 },
        search: [row.name, row.path ?? '', row.qualifiedName ?? ''].join('\u0000').toLowerCase(),
      };
      this.nodes.set(node.id, node);
      return node;
    };
    const group = (id: string, name: string, parent: ProjectionNode, explanation: string): ProjectionNode => {
      const node: ProjectionNode = { id, kind: 'group', type: 'group', name, children: [], depth: parent.depth + 1, pre: 0, post: 0, spatialParentId: parent.id, ...(parent.kind === 'entity' ? { canonicalParentId: parent.id } : parent.canonicalParentId ? { canonicalParentId: parent.canonicalParentId } : {}), explanation, ownDiagnostics: 0, diagnostics: 0, stats: { files: 0, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 }, search: '' };
      this.nodes.set(id, node);
      parent.children.push(id);
      return node;
    };
    const build = (row: EntityRow, spatialParent: ProjectionNode | undefined): void => {
      const node = make(row, spatialParent?.id, spatialParent ? spatialParent.depth + 1 : 0);
      if (spatialParent) spatialParent.children.push(node.id);
      const children = canonicalChildren.get(row.id) ?? [];
      const districtParent = row.type === 'application' || row.type === 'repository' || !!row.districts;
      const structural = children.filter(child => !(districtParent && (INTERFACE_TYPES.has(child.type) || DATA_TYPES.has(child.type) || CONSOLE_TYPES.has(child.type))));
      const interfaces = children.filter(child => districtParent && INTERFACE_TYPES.has(child.type));
      const tables = children.filter(child => districtParent && DATA_TYPES.has(child.type));
      const console = children.filter(child => districtParent && CONSOLE_TYPES.has(child.type));
      if (interfaces.length) {
        const district = group(`projection:routes:${row.id}`, 'Routes & endpoints', node, `Projection grouping: routes and endpoints whose canonical parent is ${row.type} ${row.name}. Their containment is unchanged.`);
        interfaces.sort((a, b) => compareText(a.routePath ?? a.name, b.routePath ?? b.name) || compareText(a.method ?? '', b.method ?? '') || compareText(a.id, b.id));
        if (interfaces.length > ROUTE_SUBGROUP_THRESHOLD) {
          const bySegment = new Map<string, EntityRow[]>();
          for (const item of interfaces) { const key = routeSegment(item); bySegment.set(key, [...bySegment.get(key) ?? [], item]); }
          for (const segment of [...bySegment.keys()].sort(compareText)) {
            const sub = group(`projection:routes:${row.id}:${segment}`, segment, district, `Projection grouping by first path segment ${segment}.`);
            for (const item of bySegment.get(segment)!) build(item, sub);
          }
        } else for (const item of interfaces) build(item, district);
      }
      if (tables.length) {
        const district = group(`projection:database:${row.id}`, 'Database', node, `Projection grouping: database tables declared by the migrations of ${row.type} ${row.name} (the intended schema, not the live database). Their containment is unchanged.`);
        tables.sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
        for (const item of tables) build(item, district);
      }
      if (console.length) {
        const district = group(`projection:console:${row.id}`, 'Console', node, `Projection grouping: Artisan commands and scheduled tasks of ${row.type} ${row.name}, entry points that run without an HTTP request. Their containment is unchanged.`);
        console.sort((a, b) => compareText(a.type, b.type) || compareText(a.name, b.name) || compareText(a.id, b.id));
        for (const item of console) build(item, district);
      }
      structural.sort((a, b) => {
        const bandA = BAND[a.type] ?? 4, bandB = BAND[b.type] ?? 4;
        if (bandA !== bandB) return bandA - bandB;
        if (bandA === 4) return (a.sourceRange?.startLine ?? 0) - (b.sourceRange?.startLine ?? 0) || compareText(a.name, b.name) || compareText(a.id, b.id);
        return compareText(a.name, b.name) || compareText(a.id, b.id);
      });
      for (const child of structural) build(child, node);
    };
    build(root, undefined);
    // Pre/post numbering for O(1) subtree membership; aggregate stats bottom-up.
    let counter = 0;
    const visit = (node: ProjectionNode): void => {
      node.pre = counter++;
      for (const id of node.children) {
        const child = this.nodes.get(id)!;
        visit(child);
        const s = node.stats, c = child.stats;
        s.files += c.files; s.symbols += c.symbols; s.endpoints += c.endpoints; s.measuredLoc += c.measuredLoc; s.unmeasuredFiles += c.unmeasuredFiles; s.descendants += c.descendants + 1;
      }
      if (comparison) {
        const counts: ChangeCounts = { added: 0, removed: 0, modified: 0, moved: 0 };
        for (const id of node.children) {
          const child = this.nodes.get(id)!;
          if (child.changes) { counts.added += child.changes.added; counts.removed += child.changes.removed; counts.modified += child.changes.modified; counts.moved += child.changes.moved; }
          const status = child.change?.status;
          if (status && status !== 'unchanged') counts[status]++;
        }
        node.changes = counts;
      }
      // Ghosts (removed entities) are drawn but not counted as present content.
      if (node.change?.status === 'removed') { node.post = counter - 1; return; }
      if (node.type === 'file') { node.stats.files++; if (node.loc !== undefined) node.stats.measuredLoc += node.loc; else node.stats.unmeasuredFiles++; }
      else if (SYMBOL_TYPES.has(node.type)) node.stats.symbols++;
      else if (INTERFACE_TYPES.has(node.type)) node.stats.endpoints++;
      node.post = counter - 1;
    };
    visit(this.nodes.get(this.rootId)!);
    this.relations = relations.filter(relation => relation.type !== 'contains' && this.nodes.has(relation.from) && this.nodes.has(relation.to));
    this.relations.forEach((relation, index) => {
      for (const id of relation.from === relation.to ? [relation.from] : [relation.from, relation.to]) {
        const list = this.adjacency.get(id) ?? []; list.push(index); this.adjacency.set(id, list);
      }
    });
    for (const diagnostic of diagnostics) {
      const nodeId = diagnostic.entityId && this.nodes.has(diagnostic.entityId) ? diagnostic.entityId : diagnostic.file && this.fileByPath.has(diagnostic.file) ? this.fileByPath.get(diagnostic.file)! : this.rootId;
      this.diagnostics.push({ ...diagnostic, nodeId });
      const node = this.nodes.get(nodeId)!;
      node.ownDiagnostics++;
      for (let current: ProjectionNode | undefined = node; current; current = current.spatialParentId ? this.nodes.get(current.spatialParentId) : undefined) current.diagnostics++;
    }
  }
  node(id: string): ProjectionNode | undefined { return this.nodes.get(id); }
  contains(ancestor: ProjectionNode, node: ProjectionNode): boolean { return node.pre >= ancestor.pre && node.pre <= ancestor.post; }
  spatialAncestors(node: ProjectionNode): ProjectionNode[] {
    const chain: ProjectionNode[] = [];
    for (let current = node.spatialParentId ? this.nodes.get(node.spatialParentId) : undefined; current; current = current.spatialParentId ? this.nodes.get(current.spatialParentId) : undefined) chain.unshift(current);
    return chain;
  }
  canonicalAncestors(node: ProjectionNode): ProjectionNode[] {
    const chain: ProjectionNode[] = [];
    for (let current = node.canonicalParentId ? this.nodes.get(node.canonicalParentId) : undefined; current; current = current.canonicalParentId ? this.nodes.get(current.canonicalParentId) : undefined) chain.unshift(current);
    return chain;
  }
  /** Layout input: weights use measured LOC, falling back to indexed source span for geometry only. */
  layoutNodes(): Map<string, LayoutNode> {
    const result = new Map<string, LayoutNode>();
    for (const node of this.nodes.values()) {
      // Tables have no measured lines: the span of the migration call declaring them sizes them, like a symbol's span.
      const span = node.sourceRange ? node.sourceRange.endLine - node.sourceRange.startLine + 1 : undefined;
      // Symbols keep source order inside files and classes; areas are packed largest-first.
      const preserveOrder = node.type === 'file' || SYMBOL_TYPES.has(node.type);
      result.set(node.id, { id: node.id, children: node.children, weight: node.loc ?? span, padding: PADDING[node.type] ?? 3, ...(preserveOrder ? { preserveOrder } : {}) });
    }
    return result;
  }
}
function detail(row: EntityRow): string | undefined {
  if (row.type === 'api_endpoint' || row.type === 'route') return row.framework ? `${row.framework} ${row.type === 'route' ? 'page route' : 'endpoint'}` : undefined;
  if (row.type === 'scheduled_task') return 'scheduled task';
  // A table is declared by a migration (its path): name it without the timestamp prefix.
  if (row.type === 'database_table') return row.path ? `from ${row.path.split('/').at(-1)!.replace(/\.php$/, '').replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '')}` : undefined;
  if (row.signature) return `${row.role === 'hook' ? 'hook ' : ''}${row.signature}`;
  if (row.type === 'file') return row.analysisSkipped ? `not analyzed: ${row.analysisSkipped}` : row.language;
  // Its primary framework, else the language most of its code is written in.
  if (row.type === 'application') return row.framework ?? row.language;
  return undefined;
}
