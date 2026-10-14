// Map preferences never alter the indexed graph or the repository checkout.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { MapVisibilityAction, MapVisibilityState } from './dto.js';
import type { EntityRow, ProjectionIndex } from './hierarchy.js';
import type { LayoutNode, TimelineRegistry } from './layout.js';

const MAX_BYTES = 64 * 1024, MAX_ITEMS = 1000;
const within = (file: string, parent: string) => file === parent || file.startsWith(`${parent}/`);
export function mapPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Expected a repository-relative file or folder path');
  return value;
}
function read(file: string | undefined): string {
  if (!file) return '';
  try { if (statSync(file).size > MAX_BYTES) throw new Error(`Map rules exceed ${MAX_BYTES} bytes`); return readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export class MapVisibility {
  private cached?: { key: string; state: MapVisibilityState; matcher: ReturnType<typeof ignore> };
  constructor(private readonly options: { root?: string; stateDirectory?: string; readOnly?: boolean }, private readonly repositoryId: () => string) {}
  private get file(): string | undefined { return this.options.stateDirectory && path.join(this.options.stateDirectory, 'map-visibility.json'); }
  state(): MapVisibilityState {
    const repositoryId = this.repositoryId();
    const sharedText = read(this.options.root && path.join(this.options.root, '.codiluceignore'));
    const localText = read(this.file);
    const key = `${repositoryId}\0${sharedText}\0${localText}`;
    if (this.cached?.key === key) return this.cached.state;
    const shared = sharedText.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
    let local: Partial<MapVisibilityState> & { repositoryId?: string } = {};
    if (localText) {
      const parsed = JSON.parse(localText);
      if (parsed.repositoryId === repositoryId) local = parsed;
    }
    const list = (items: unknown): string[] => {
      if (items === undefined) return [];
      if (!Array.isArray(items) || items.length > MAX_ITEMS || !items.every(item => typeof item === 'string')) throw new Error('Invalid map visibility preferences');
      return [...new Set(items)];
    };
    const hidden = list(local.hidden).map(mapPath), revealed = list(local.revealed).map(mapPath), disabledShared = list(local.disabledShared).filter(rule => shared.includes(rule));
    if (shared.length > MAX_ITEMS) throw new Error('Too many .codiluceignore rules');
    const state = { shared, hidden, revealed, disabledShared, writable: !!this.file && !this.options.readOnly, revision: createHash('sha256').update(key).digest('hex').slice(0, 16) };
    this.cached = { key, state, matcher: ignore({ ignorecase: false }).add(shared.filter(rule => !disabledShared.includes(rule))) };
    return state;
  }
  get active(): boolean { const state = this.state(); return !!(state.hidden.length || state.shared.some(rule => !rule.startsWith('!') && !state.disabledShared.includes(rule))); }
  hides(relative: string | undefined, directory = false): boolean {
    if (!relative || relative === '.') return false;
    const state = this.cached?.state ?? this.state();
    // More specific local choices win: reveal one file inside a hidden
    // folder, or hide one file inside a revealed folder.
    const specificity = (items: string[]) => items.reduce((length, item) => within(relative, item) ? Math.max(length, item.length) : length, 0);
    const hidden = specificity(state.hidden), revealed = specificity(state.revealed);
    if (hidden || revealed) return hidden > revealed;
    return this.cached!.matcher.ignores(directory ? `${relative}/` : relative);
  }
  update(action: MapVisibilityAction): MapVisibilityState {
    const state = this.state();
    if (this.options.readOnly) throw new Error('Map preferences are read-only');
    if (!this.file) throw new Error('Map preferences need a state directory');
    let { hidden, revealed, disabledShared } = state;
    if (action.action === 'hide') { const relative = mapPath(action.path); hidden = [...new Set([...hidden, relative])]; revealed = revealed.filter(item => !within(item, relative)); }
    else if (action.action === 'restore') { const relative = mapPath(action.path); hidden = hidden.filter(item => item !== relative); }
    else if (action.action === 'reveal') { const relative = mapPath(action.path); hidden = hidden.filter(item => item !== relative); revealed = [...new Set([...revealed, relative])]; }
    else if (action.action === 'conceal') { const relative = mapPath(action.path); revealed = revealed.filter(item => item !== relative); }
    else if (action.action === 'disable-rule' || action.action === 'enable-rule') {
      if (!state.shared.includes(action.pattern)) throw new Error('Unknown shared map rule');
      disabledShared = action.action === 'disable-rule' ? [...new Set([...disabledShared, action.pattern])] : disabledShared.filter(rule => rule !== action.pattern);
    } else if (action.action === 'set-local') {
      if ([action.hidden, action.revealed, action.disabledShared].some(items => !Array.isArray(items) || items.length > MAX_ITEMS)) throw new Error('Invalid map visibility preferences');
      hidden = [...new Set(action.hidden.map(mapPath))]; revealed = [...new Set(action.revealed.map(mapPath))];
      if (!action.disabledShared.every(rule => state.shared.includes(rule))) throw new Error('Unknown shared map rule');
      disabledShared = [...new Set(action.disabledShared)];
    } else if (action.action === 'restore-all') { hidden = []; revealed = []; disabledShared = state.shared.filter(rule => !rule.startsWith('!')); }
    else throw new Error('Unknown map visibility action');
    if ([hidden, revealed, disabledShared].some(items => items.length > MAX_ITEMS)) throw new Error('Too many map visibility preferences');
    const body = JSON.stringify({ version: 1, repositoryId: this.repositoryId(), hidden, revealed, disabledShared }, null, 2);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Map visibility preferences are too large');
    mkdirSync(this.options.stateDirectory!, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 }); renameSync(temporary, this.file);
    return this.state();
  }
  /** Visible nodes plus ancestors needed to reach a specifically revealed descendant. */
  layout(index: ProjectionIndex): Map<string, LayoutNode> {
    const all = index.layoutNodes();
    if (!this.active) return all;
    const result = new Map<string, LayoutNode>();
    const order: string[] = [], stack = [index.rootId];
    while (stack.length) { const id = stack.pop()!; order.push(id); stack.push(...all.get(id)!.children); }
    for (const id of order.reverse()) {
      const node = index.nodes.get(id)!, layout = all.get(id)!;
      const children = layout.children.filter(child => result.has(child));
      const source = node.path ? node : index.canonicalAncestors(node).reverse().find(parent => parent.path);
      const visible = !this.hides(source?.path, !!source && ['directory', 'application'].includes(source.type));
      if (id !== index.rootId && !children.length && (!visible || node.kind === 'group' && layout.children.length > 0)) continue;
      result.set(id, { ...layout, children, ...(layout.children.length && ['repository', 'directory', 'application', 'group'].includes(node.type) ? { weight: undefined } : {}) });
    }
    return result;
  }
  /** Filter the history union, including slots absent from today's snapshot. */
  registry(original: TimelineRegistry, entities: Iterable<Pick<EntityRow, 'id' | 'type' | 'path' | 'parentId'>>): TimelineRegistry {
    if (!this.active) return original;
    const rows = [...entities], byId = new Map(rows.map(row => [row.id, row]));
    const known = new Set<string>(), allowed = new Set<string>(), containers = new Set<string>();
    for (const row of rows) {
      const key = original.alias[row.id] ?? row.id; known.add(key);
      if (['repository', 'application', 'directory'].includes(row.type)) containers.add(key);
      let own = row, relative = row.path;
      const seen = new Set<string>();
      while (!relative && own.parentId && !seen.has(own.id)) { seen.add(own.id); const parent = byId.get(own.parentId); if (!parent) break; own = parent; relative = own.path; }
      if (!this.hides(relative, ['directory', 'application'].includes(own.type))) allowed.add(key);
    }
    const registry: TimelineRegistry = { version: original.version, nodes: {}, slots: {}, alias: { ...original.alias } };
    const kept = new Map<string, boolean>(), visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (kept.has(id)) return kept.get(id)!;
      if (visiting.has(id)) return false;
      visiting.add(id);
      const children = (original.slots[id] ?? []).filter(visit);
      visiting.delete(id);
      const visible = allowed.has(id) || children.length > 0 || !known.has(id) && !(original.slots[id]?.length);
      kept.set(id, visible);
      if (visible) { registry.nodes[id] = { ...original.nodes[id]!, ...(original.slots[id]?.length && (containers.has(id) || !known.has(id)) ? { weight: undefined } : {}) }; registry.slots[id] = children; }
      return visible;
    };
    for (const id of Object.keys(original.nodes)) visit(id);
    return registry;
  }
}
