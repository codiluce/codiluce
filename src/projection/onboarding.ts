// The thread the onboarding tour follows through a repository, without a
// language model. Pure and deterministic.
//
// The tour shows one file at every stop: where it is, its code, the flow it is
// part of, what depends on it and how it changed. The flow comes first: among
// the flows drawn in lanes (requests, commands, scheduled tasks), the most
// complete one touching at least a few files, ranked by the files it touches
// (capped, so one huge flow does not win) with a bonus for reaching tables;
// without one, the page with the most files. The file is the flow's handler
// when something depends on it, otherwise the flow's file with the most
// dependents; without a flow, the most depended-on file of the repository.
// The caller then prefers a candidate with history. Ties break by path.
import type { FlowSummary } from './dto.js';
import type { ProjectionIndex } from './hierarchy.js';

export interface ThreadFlow { summary: FlowSummary; members: Set<string> }
/** A flow must touch at least this many files to carry the tour. */
export const THREAD_MIN_FILES = 3;
/** Files touched beyond this many no longer rank a flow higher. */
const FILES_CAP = 30;
const TABLE_BONUS = 10;
const STATUS_RANK: Record<string, number> = { complete: 3, partial: 2, headless: 1 };

/** The flows a tour can tell: the application's own, with an entry point. */
export function tourFlows(flows: ThreadFlow[]): ThreadFlow[] {
  return flows.filter(flow => flow.summary.kind !== 'unmatched' && (flow.summary.scope ?? 'application') === 'application');
}
/** For each file, how many other files depend on it: a relation from their code into its code. */
export function dependentFiles(index: ProjectionIndex, fileOf: (id: string) => string | undefined): Map<string, number> {
  const from = new Map<string, Set<string>>();
  for (const relation of index.relations) {
    if (relation.type === 'contains' || relation.change === 'removed') continue;
    const source = fileOf(relation.from), target = fileOf(relation.to);
    if (!source || !target || source === target) continue;
    let set = from.get(target);
    if (!set) from.set(target, set = new Set());
    set.add(source);
  }
  return new Map([...from].map(([file, files]) => [file, files.size]));
}
const byName = (a: ThreadFlow, b: ThreadFlow) => a.summary.name < b.summary.name ? -1 : a.summary.name > b.summary.name ? 1 : a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0;
/** The flow the tour follows, if any. */
export function threadFlow(flows: ThreadFlow[]): ThreadFlow | undefined {
  const usable = tourFlows(flows).filter(flow => flow.summary.files >= THREAD_MIN_FILES);
  const rank = (flow: ThreadFlow) => (STATUS_RANK[flow.summary.status ?? ''] ?? 0) * 1000 + Math.min(flow.summary.files, FILES_CAP) + (flow.summary.tables ? TABLE_BONUS : 0);
  const lanes = usable.filter(flow => flow.summary.detail === 'lanes').sort((a, b) => rank(b) - rank(a) || byName(a, b));
  if (lanes.length) return lanes[0];
  return usable.filter(flow => flow.summary.detail === 'steps').sort((a, b) => b.summary.files - a.summary.files || byName(a, b))[0];
}
/** The files the tour could follow, best first: the flow's (its handler first), or the repository's without a flow. */
export function threadFiles(index: ProjectionIndex, fileOf: (id: string) => string | undefined, dependents: ReadonlyMap<string, number>, flow?: ThreadFlow): string[] {
  const present = (id: string) => { const node = index.node(id); return node?.kind === 'entity' && node.type === 'file' && node.change?.status !== 'removed'; };
  const files = new Set<string>();
  if (flow) for (const member of flow.members) { const file = fileOf(member); if (file && present(file)) files.add(file); }
  else for (const node of index.nodes.values()) if (present(node.id)) files.add(node.id);
  const path = (id: string) => index.node(id)?.path ?? id;
  const ordered = [...files].sort((a, b) => (dependents.get(b) ?? 0) - (dependents.get(a) ?? 0) || (path(a) < path(b) ? -1 : path(a) > path(b) ? 1 : 0));
  if (!flow) return ordered;
  // The handler: what the entry point hands the work to.
  const entry = flow.summary.entry.id;
  const handlers = new Set(index.relations.filter(relation => relation.from === entry && relation.type === 'handles' && relation.change !== 'removed').map(relation => fileOf(relation.to)).filter((file): file is string => !!file && files.has(file) && (dependents.get(file) ?? 0) > 0));
  return [...ordered.filter(file => handlers.has(file)), ...ordered.filter(file => !handlers.has(file))];
}
/** The thread's file among the candidates: the first with history (`commits` at least 2) when there is history, else the first. */
export function pickFile(candidates: { id: string; commits?: number }[]): string | undefined {
  return (candidates.find(candidate => (candidate.commits ?? 0) >= 2) ?? candidates[0])?.id;
}
