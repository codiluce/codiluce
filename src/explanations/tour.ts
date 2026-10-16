// A tour resolved against the live index: each scene's boxes (what its links
// name, a symbol inside its file's box when both are shown, grouped by
// folder) and its arrows with the relationships the index holds between their
// ends, the evidence chip. The arrows themselves are the model's; the index
// only says what backs them.
import path from 'node:path';
import type { LinkContext } from '../projection/service.js';
import type { ProjectionNode } from '../projection/hierarchy.js';
import type { ArrowEvidence, ExplanationTour, ResolvedArrow, ResolvedLink, ResolvedScene, SceneBox } from './model.js';
import { canBeBox, sceneHrefs, scenesOf, sceneView } from './scenes.js';

/** Entities collected on each side of an arrow, at most (a folder's files and their symbols). */
const EVIDENCE_SIDE_LIMIT = 600;
const FILE_LIKE = new Set(['file', 'directory', 'application', 'repository', 'database_table']);

/** The tour of an answer's text, or undefined when it has no scenes. `linkOf` gives each href resolved (with its staleness). */
export function resolveTour(text: string, turn: number, context: LinkContext, linkOf: (href: string) => ResolvedLink | undefined): ExplanationTour | undefined {
  const { intro, scenes } = scenesOf(text);
  if (!scenes.length) return undefined;
  const sides = new Map<string, Set<string>>();
  const side = (id: string) => { let set = sides.get(id); if (!set) sides.set(id, set = collect(context, id)); return set; };
  const resolved = scenes.map((scene, index): ResolvedScene => {
    const view = sceneView(scene);
    const boxes: SceneBox[] = [];
    const keyOf = new Map<string, string>();
    for (const href of sceneHrefs(scene)) {
      if (!canBeBox(href)) continue;
      const link = linkOf(href);
      if (!link) continue;
      const key = link.id ?? link.href;
      keyOf.set(href, key);
      if (boxes.some(box => box.key === key)) continue;
      const caption = scene.captions?.[href];
      boxes.push({ key, link, group: groupOf(link, context), ...(caption ? { caption } : {}) });
    }
    // A symbol sits inside its file's box when the file is shown too.
    const keys = new Set(boxes.map(box => box.key));
    for (const box of boxes) {
      if (!box.link.id || !box.link.type || FILE_LIKE.has(box.link.type) || box.link.kind !== 'path') continue;
      const file = context.fileOf(box.link.id);
      if (file && file !== box.key && keys.has(file)) box.parent = file;
    }
    const arrows: ResolvedArrow[] = [];
    for (const arrow of scene.arrows ?? []) {
      const fromKey = keyOf.get(arrow.from.trim()), toKey = keyOf.get(arrow.to.trim());
      if (!fromKey || !toKey || fromKey === toKey) continue;
      const from = boxes.find(box => box.key === fromKey)!.link, to = boxes.find(box => box.key === toKey)!.link;
      const evidence = from.id && to.id && from.status !== 'missing' && to.status !== 'missing' ? evidenceBetween(context, side(from.id), side(to.id)) : [];
      arrows.push({ ...arrow, fromKey, toKey, evidence });
    }
    const start = scene.start ? keyOf.get(scene.start.trim()) : undefined;
    const flow = scene.flow ? linkOf(scene.flow) : undefined;
    return { index, title: scene.title, markdown: scene.markdown, view, boxes, arrows, ...(start ? { start } : {}), ...(flow ? { flow } : {}) };
  });
  return { turn, intro, scenes: resolved };
}

/** The folder a box is grouped in: a file's or symbol's folder, a folder's parent, a flow's entry folder. */
function groupOf(link: ResolvedLink, context: LinkContext): string {
  if (link.kind === 'table') return '';
  if (link.kind === 'flow') return link.path ? dirname(link.path) : '';
  if (!link.path) return '';
  if (link.type === 'directory' || link.type === 'application') return dirname(link.path);
  if (link.type === 'file') return dirname(link.path);
  const file = link.id ? context.fileOf(link.id) : undefined;
  const filePath = file ? context.index.node(file)?.path : undefined;
  return dirname(filePath ?? link.path);
}
function dirname(value: string): string { const dir = path.posix.dirname(value); return dir === '.' ? '' : dir; }

/** An entity and what it holds (a file's symbols, a folder's files and symbols), bounded. */
function collect(context: LinkContext, id: string): Set<string> {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length && result.size < EVIDENCE_SIDE_LIMIT) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    const node: ProjectionNode | undefined = context.index.node(current);
    if (!node) continue;
    if (node.kind === 'entity') result.add(current);
    queue.push(...node.children);
  }
  return result;
}
/** The relationships the index holds between two sides, either way, counted by type. */
export function evidenceBetween(context: LinkContext, from: Set<string>, to: Set<string>): ArrowEvidence[] {
  const counts = new Map<string, ArrowEvidence>();
  const seen = new Set<number>();
  const [small, large, smallIsFrom] = from.size <= to.size ? [from, to, true] : [to, from, false];
  for (const id of small) {
    for (const index of context.index.adjacency.get(id) ?? []) {
      if (seen.has(index)) continue;
      seen.add(index);
      const relation = context.index.relations[index]!;
      if (relation.change === 'removed' || relation.from === relation.to) continue;
      const other = relation.from === id ? relation.to : relation.from;
      if (!large.has(other) || small.has(other)) continue;
      // Forward when it runs from the arrow's start to its end.
      const forward = smallIsFrom ? relation.from === id : relation.to === id;
      const key = `${relation.type}:${forward ? '' : 'r'}`;
      const item = counts.get(key) ?? { type: relation.type, count: 0, ...(forward ? {} : { reverse: true }) };
      item.count++;
      counts.set(key, item);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
}
