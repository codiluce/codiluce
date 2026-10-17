// What the Focus tool shows, gathered from the index: a selection and what
// it is connected to, the files a pull request changes, or what an
// explanation links, each with the relationships between them as arrows.
// The blocks are then made reachable in the map's scene (their areas and
// the areas' children, for context), the way selecting does.
import type { NodeSummary, RelationItem } from '@engine/projection/dto';
import type { AtlasApi } from './api';
import type { AtlasStore, FocusSubject } from './store';

export interface FocusArrow { from: string; to: string; label?: string; types: Record<string, number> }
export interface FocusSet {
  title: string; text: string;
  /** What it is about, most significant first. */
  ids: string[];
  arrows: FocusArrow[];
  /** A line under a block's name (an explanation's link text). */
  captions: Map<string, string>;
  /** The areas holding them (to load). */
  areas: string[];
  /** Left out to keep the picture readable. */
  more: number;
}
/** At most this many blocks, and arrows between them. */
export const FOCUS_MAX = 40, ARROWS_MAX = 16;
/** A selection keeps fewer: what it is connected to can be many, and the picture has to stay readable. */
const SELECTION_MAX = 28;

export function arrowTotal(arrow: Pick<FocusArrow, 'types'>): number { return Object.values(arrow.types).reduce((a, b) => a + b, 0); }
export function arrowChip(arrow: Pick<FocusArrow, 'types'>): string { return Object.entries(arrow.types).sort((a, b) => b[1] - a[1]).map(([type, n]) => `${type}${n > 1 ? ` ×${n}` : ''}`).join(' · '); }
export function mainType(arrow: Pick<FocusArrow, 'types'>): string { return Object.entries(arrow.types).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'references'; }
/** Arrows by pair, counted by relation type. */
export function mergeArrows(items: { from: string; to: string; type: string }[]): FocusArrow[] {
  const byPair = new Map<string, FocusArrow>();
  for (const item of items) {
    if (item.from === item.to) continue;
    const key = `${item.from}>${item.to}`;
    const arrow = byPair.get(key) ?? { from: item.from, to: item.to, types: {} };
    arrow.types[item.type] = (arrow.types[item.type] ?? 0) + 1;
    byPair.set(key, arrow);
  }
  return [...byPair.values()].sort((a, b) => arrowTotal(b) - arrowTotal(a));
}
/** The selection's relationships as arrows, the other ends as the set (the most connected first). */
export function selectionSet(node: NodeSummary, ancestors: string[], relations: RelationItem[]): FocusSet {
  const counts = new Map<string, number>();
  for (const item of relations) counts.set(item.other.id, (counts.get(item.other.id) ?? 0) + 1);
  const others = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const kept = new Set(others.slice(0, SELECTION_MAX - 1));
  const arrows = mergeArrows(relations.filter(item => kept.has(item.other.id)).map(item => item.direction === 'incoming' ? { from: item.other.id, to: node.id, type: item.type } : { from: node.id, to: item.other.id, type: item.type }));
  const areas = new Set(ancestors);
  for (const item of relations) if (kept.has(item.other.id)) for (const id of item.otherAncestors) areas.add(id);
  return {
    title: `${node.name}${node.type === 'directory' ? '/' : ''} and what it is connected to`,
    text: kept.size ? `${kept.size} connected ${kept.size === 1 ? 'entity' : 'entities'} by ${relations.length} relationship${relations.length === 1 ? '' : 's'}, at their places on the map.` : 'The index has no relationships between it and other code, so it stands alone here.',
    ids: [node.id, ...kept], arrows: arrows.slice(0, ARROWS_MAX), captions: new Map(), areas: [...areas], more: Math.max(0, others.length - kept.size),
  };
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) await run(items[next++]!); }));
}
/** Relationships between the blocks of a set (from each file or symbol of it, through their symbols). */
export async function linksAmong(api: AtlasApi, ids: string[], kinds: Map<string, string>, signal?: AbortSignal): Promise<FocusArrow[]> {
  const set = new Set(ids);
  const found: { from: string; to: string; type: string }[] = [];
  const sources = ids.filter(id => kinds.get(id) !== 'directory' && kinds.get(id) !== 'application' && kinds.get(id) !== 'repository').slice(0, 30);
  await pool(sources, 6, async id => {
    try {
      const page = await api.relations(id, { direction: 'outgoing', limit: 300, ...(kinds.get(id) === 'file' ? { scope: 'contained' as const } : {}) }, signal);
      for (const item of page.items) {
        const target = [item.other.id, ...[...item.otherAncestors].reverse()].find(other => set.has(other));
        if (target && target !== id) found.push({ from: id, to: target, type: item.type });
      }
    } catch (error) { if (signal?.aborted) throw error; }
  });
  return mergeArrows(found).slice(0, ARROWS_MAX);
}

/** Gather a subject's set from the store's state (what is already loaded) or the API. */
export async function loadFocusSet(store: AtlasStore, subject: FocusSubject, signal: AbortSignal): Promise<FocusSet> {
  const api = store.api, state = store.getState();
  if (subject.kind === 'selection') {
    const located = state.selection?.id === subject.id && state.selection.locate ? state.selection.locate : await api.locate(subject.id, signal);
    const node = located.node, ancestors = located.spatialAncestors.map(item => item.id);
    if (node.type === 'directory' || node.type === 'application' || node.type === 'repository' || node.kind === 'group') {
      const aggregate = state.aggregate.forId === subject.id && state.aggregate.data ? state.aggregate.data : await api.aggregate(subject.id, signal);
      const relations: RelationItem[] = aggregate.groups.flatMap(group => Array.from({ length: Math.min(9, group.count) }, (_, i) => ({ id: `${group.anchor.id}:${group.type}:${group.direction}:${i}`, type: group.type, direction: group.direction === 'incoming' ? 'incoming' as const : 'outgoing' as const, other: group.anchor, otherAncestors: group.anchorAncestors })));
      const set = selectionSet(node, ancestors, relations);
      return { ...set, text: `${set.ids.length - 1} areas and blocks connected to it from outside, by ${aggregate.totalCrossing} relationships.` };
    }
    // A file: its own and its symbols' relationships across its boundary (what is inside it is not the point).
    const loaded = node.type !== 'file' && state.relations.forId === subject.id ? state.relations.items : [];
    const items = loaded.length ? loaded : (await api.relations(subject.id, { limit: 300, ...(node.type === 'file' ? { scope: 'contained' as const } : {}) }, signal)).items;
    const relations = items.filter(item => item.other.id !== node.id && !(node.type === 'file' && item.otherAncestors.includes(node.id)) && (!state.relations.type || item.type === state.relations.type));
    return selectionSet(node, ancestors, relations);
  }
  if (subject.kind === 'pull') {
    const detail = state.pulls.pull?.id === subject.id && state.pulls.pull.data ? state.pulls.pull.data : await api.pull(subject.id, state.people.window, signal);
    const files = Object.entries(detail.files).sort((a, b) => b[1].added + b[1].deleted - (a[1].added + a[1].deleted));
    const ids = files.slice(0, FOCUS_MAX).map(([id]) => id);
    const kinds = new Map(ids.map(id => [id, 'file']));
    const arrows = await linksAmong(api, ids, kinds, signal);
    const name = detail.pull.number !== undefined ? `#${detail.pull.number} ${detail.pull.title}` : detail.pull.title;
    return {
      title: name, text: `${files.length} file${files.length === 1 ? '' : 's'} on this map${detail.outsideTotal ? ` (and ${detail.outsideTotal} not on it)` : ''}; the ${arrows.length} strongest links between them, from the index.`,
      ids, arrows, captions: new Map(files.slice(0, FOCUS_MAX).map(([id, file]) => [id, `+${file.added} −${file.deleted}`])), areas: Object.keys(detail.areas), more: Math.max(0, files.length - ids.length),
    };
  }
  const detail = state.explain.detail?.id === subject.id ? state.explain.detail.data : undefined;
  if (!detail) throw new Error('Open the explanation to focus on what it links.');
  const seen = new Set<string>(), captions = new Map<string, string>(), areas = new Set<string>(), kinds = new Map<string, string>();
  for (const link of detail.links) {
    if (!link.id || link.status === 'missing' || link.status === 'external' || seen.has(link.id) || link.kind === 'flow' || link.kind === 'commit' || link.kind === 'pr' || link.kind === 'feature') continue;
    seen.add(link.id);
    if (link.label && link.label !== link.name) captions.set(link.id, link.label.length > 42 ? `${link.label.slice(0, 40)}…` : link.label);
    for (const id of link.ancestors ?? []) areas.add(id);
    if (link.type) kinds.set(link.id, link.type);
  }
  const ids = [...seen].slice(0, FOCUS_MAX);
  const arrows = ids.length > 1 ? await linksAmong(api, ids, kinds, signal) : [];
  return { title: detail.title, text: `What it links (${ids.length}), at their places on the map; the links between them come from the index.`, ids, arrows, captions, areas: [...areas], more: Math.max(0, seen.size - ids.length) };
}

/** Make the blocks reachable in the map's scene: the missing nodes (areas first), then the children of their areas, for context. */
export async function ensureNodes(store: AtlasStore, ids: string[], areas: string[], signal?: AbortSignal): Promise<void> {
  const scene = store.scene;
  const missing = [...new Set([...areas, ...ids])].filter(id => !scene.nodes.has(id));
  for (let i = 0; i < missing.length; i += 150) {
    const page = await store.api.nodes(missing.slice(i, i + 150), signal);
    for (const node of [...page.items].sort((a, b) => a.depth - b.depth)) scene.upsert(node);
  }
  if (signal?.aborted) return;
  const open = [...new Set([...areas, ...ids.flatMap(id => { const parent = scene.nodes.get(id)?.spatialParentId; return parent ? [parent] : []; })])]
    .filter(id => scene.nodes.has(id) && (scene.nodes.get(id)?.childCount ?? 0) > 0 && !scene.childList(id).complete)
    .sort((a, b) => (scene.nodes.get(a)?.depth ?? 0) - (scene.nodes.get(b)?.depth ?? 0));
  for (let i = 0; i < open.length && !signal?.aborted; i += 6) await store.loadChildren(open.slice(i, i + 6));
}
