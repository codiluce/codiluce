// A commit beat: one commit told in a few seconds on a stable stage. Removed
// files turn red and sink, moved ones show, added ones grow out of the ground,
// changed ones pulse, and every changed file gets a label (+ ~ − →). The beat
// plays on the commit's own frame of the History time-lapse (the timeline
// layout, so places never move between commits), whichever projection draws
// it. Pure (no DOM): the Commit beat tool draws it, tests run it.
import type { NodeSummary } from '@engine/projection/dto';
import type { Scene } from './scene';

export type BeatStatus = 'added' | 'modified' | 'removed' | 'moved';
export interface BeatFile {
  id: string; path: string; name: string; status: BeatStatus;
  /** Beat clock (ms) at which it lands. */
  at: number;
  lines: { added: number; removed: number };
  /** Changed symbols inside, when the commit has an architecture snapshot. */
  symbols?: NodeSummary['changes'];
}
export interface BeatPlan { files: BeatFile[]; byId: Map<string, BeatFile>; t0: number; end: number; counts: Record<BeatStatus, number> }
export const GLYPH: Record<BeatStatus, string> = { added: '+ ', modified: '~ ', removed: '− ', moved: '→ ' };
const ORDER: BeatStatus[] = ['removed', 'moved', 'added', 'modified'];

/** The changed files of a commit's frame, and when each lands: removals first, then moves, additions, changes; the biggest first within each. */
export function planBeat(scene: Scene, options: { t0: number; lines?: ReadonlyMap<string, { added: number; removed: number }> }): BeatPlan {
  const lines = options.lines ?? new Map();
  const files: NodeSummary[] = [];
  for (const node of scene.nodes.values()) {
    const status = node.change?.status;
    if (node.type === 'file' && status && status !== 'unchanged') files.push(node);
  }
  const weight = (node: NodeSummary) => { const s = lines.get(node.path ?? ''); return (s?.added ?? 0) + (s?.removed ?? 0) + 5 * ((node.changes?.added ?? 0) + (node.changes?.modified ?? 0) + (node.changes?.removed ?? 0)); };
  const out: BeatFile[] = [];
  const counts: Record<BeatStatus, number> = { added: 0, modified: 0, removed: 0, moved: 0 };
  let t = options.t0;
  for (const status of ORDER) {
    const list = files.filter(node => node.change!.status === status).sort((a, b) => weight(b) - weight(a) || (a.path ?? a.name).localeCompare(b.path ?? b.name));
    if (!list.length) continue;
    counts[status] = list.length;
    const step = Math.min(110, 1300 / list.length);
    list.forEach((node, i) => out.push({ id: node.id, path: node.path ?? node.name, name: node.name, status, at: t + i * step, lines: lines.get(node.path ?? '') ?? { added: 0, removed: 0 }, ...(node.changes ? { symbols: node.changes } : {}) }));
    t += list.length * step + 300;
  }
  const last = Math.max(options.t0, ...out.map(file => file.at));
  return { files: out, byId: new Map(out.map(file => [file.id, file])), t0: options.t0, end: last + 1800, counts };
}

/** One line about the commit from its changes (no model call): what it adds, removes and changes most. */
export function changeLine(plan: BeatPlan): string {
  const by = (status: BeatStatus) => plan.files.filter(file => file.status === status);
  const count = new Map<string, number>();
  for (const file of plan.files) count.set(file.name, (count.get(file.name) ?? 0) + 1);
  const label = (file: BeatFile) => (count.get(file.name)! > 1 ? file.path.split('/').slice(-2).join('/') : file.name);
  const names = (list: BeatFile[], n = 2) => list.slice(0, n).map(label).join(', ') + (list.length > n ? ` and ${list.length - n} more` : '');
  const parts: string[] = [];
  if (by('added').length) parts.push(`adds ${names(by('added'))}`);
  if (by('removed').length) parts.push(`removes ${names(by('removed'))}`);
  if (by('moved').length) parts.push(`moves ${names(by('moved'))}`);
  const modified = by('modified');
  if (modified[0]) {
    const s = modified[0].symbols;
    const what = s ? [s.added ? `${s.added} new` : '', s.modified ? `${s.modified} changed` : '', s.removed ? `${s.removed} removed` : ''].filter(Boolean).join(', ') : '';
    const lines = modified[0].lines.added + modified[0].lines.removed;
    parts.push(`changes ${label(modified[0])}${what ? ` (${what} symbols)` : lines ? ` (+${modified[0].lines.added} −${modified[0].lines.removed})` : ''}${modified.length > 1 ? ` and ${modified.length - 1} more file${modified.length > 2 ? 's' : ''}` : ''}`);
  }
  return parts.join('; ');
}
/** The file a node belongs to (itself for a file), for symbols that change with it. */
export function fileOf(scene: Scene, id: string): string | undefined {
  for (let node = scene.nodes.get(id); node; node = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined) if (node.type === 'file') return node.id;
  return undefined;
}
