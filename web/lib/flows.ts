// Named, manually declared flows. Flows are an overlay: they store entity IDs
// only (never copies of graph objects) and are kept apart from structural
// facts. A declared sequence is not evidence of execution.
import type { Flow, FlowStep } from '@engine/core/graph';

export interface StoredFlow extends Flow { type: 'declared'; createdAt: string; updatedAt: string }
export interface FlowPersistence { load(): StoredFlow[]; save(flows: StoredFlow[]): void }
export const FLOW_STORAGE_VERSION = 1;
export function flowStorageKey(repositoryId: string): string { return `archipelago:flows:v${FLOW_STORAGE_VERSION}:${repositoryId}`; }

function isStep(value: unknown): value is FlowStep {
  return !!value && typeof value === 'object' && typeof (value as FlowStep).entityId === 'string' && (value as FlowStep).entityId.length > 0;
}
function isFlow(value: unknown): value is StoredFlow {
  const flow = value as StoredFlow;
  return !!flow && typeof flow === 'object' && typeof flow.id === 'string' && typeof flow.name === 'string' && flow.type === 'declared' && Array.isArray(flow.steps) && flow.steps.every(isStep);
}
/** localStorage adapter scoped to one repository identity. Malformed entries are ignored, not thrown. */
export function localFlowPersistence(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, repositoryId: string): FlowPersistence {
  const key = flowStorageKey(repositoryId);
  return {
    load() {
      if (!storage) return [];
      try {
        const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(isFlow).map(flow => ({ ...flow, steps: flow.steps.map(step => ({ entityId: step.entityId })) })) : [];
      } catch { return []; }
    },
    save(flows) {
      if (!storage) throw new Error('Browser storage is unavailable; flows cannot be saved');
      storage.setItem(key, JSON.stringify(flows.map(flow => ({ id: flow.id, name: flow.name, type: flow.type, createdAt: flow.createdAt, updatedAt: flow.updatedAt, steps: flow.steps.map(step => ({ entityId: step.entityId })) }))));
    },
  };
}
export function memoryFlowPersistence(initial: StoredFlow[] = []): FlowPersistence {
  let flows = structuredClone(initial);
  return { load: () => structuredClone(flows), save: next => { flows = structuredClone(next); } };
}
export function validateFlowName(name: string, flows: StoredFlow[], editingId?: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the flow a name';
  if (trimmed.length > 80) return 'Use at most 80 characters';
  if (flows.some(flow => flow.id !== editingId && flow.name.toLowerCase() === trimmed.toLowerCase())) return 'A flow with this name already exists';
  return undefined;
}
export function upsertFlow(flows: StoredFlow[], draft: { id?: string; name: string; entityIds: string[] }, now: string, newId: () => string): StoredFlow[] {
  if (!draft.entityIds.length) throw new Error('A flow needs at least one step');
  const error = validateFlowName(draft.name, flows, draft.id);
  if (error) throw new Error(error);
  const steps = draft.entityIds.map(entityId => ({ entityId }));
  const existing = draft.id ? flows.find(flow => flow.id === draft.id) : undefined;
  if (existing) return flows.map(flow => flow.id === existing.id ? { ...flow, name: draft.name.trim(), steps, updatedAt: now } : flow);
  return [...flows, { id: newId(), name: draft.name.trim(), type: 'declared', steps, createdAt: now, updatedAt: now }];
}
export function removeFlow(flows: StoredFlow[], id: string): StoredFlow[] { return flows.filter(flow => flow.id !== id); }
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
export function removeAt<T>(items: T[], index: number): T[] { return items.filter((_, i) => i !== index); }
export interface ResolvedStep { index: number; entityId: string; missing: boolean }
/** Mark steps whose entity no longer exists in the current index (e.g. after reindexing). */
export function resolveSteps(flow: Pick<Flow, 'steps'>, existing: ReadonlySet<string>): ResolvedStep[] {
  return flow.steps.map((step, index) => ({ index, entityId: step.entityId, missing: !existing.has(step.entityId) }));
}
