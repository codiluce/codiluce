// Named flows. Flows are an overlay: they store entity IDs only (never copies
// of graph objects) and are kept apart from structural facts. A declared flow
// is a sequence someone chose; a static flow was found as a path over indexed
// relationships. Neither is evidence of execution.
//
// Where they are kept is a persistence adapter: the server's flow store
// (`<state>/flows.db`, shared by every browser using that server), or this
// browser's local storage when the server cannot store them.
import type { FlowStep } from '@engine/core/graph';
// The flow rules are shared with the server's flow store (a pure module: no Node APIs), so this is a value import by path.
import { flowSteps, validateFlowName, type StoredFlow } from '../../src/core/flows';
import type { FlowsList, StoredFlowInput } from './api';

export type { StoredFlow } from '../../src/core/flows';
export { validateFlowName };
export interface FlowPersistence {
  /** `server`: the server's flow store; `browser`: this browser's local storage only. */
  readonly kind: 'server' | 'browser';
  /** False when flows can be shown but not changed (a read-only server). */
  readonly writable: boolean;
  list(): Promise<StoredFlow[]>;
  /** Store a new flow or replace one; resolves to the stored flow (with its new revision). Rejects with FlowConflict when it changed elsewhere. */
  save(flow: StoredFlow, isNew: boolean): Promise<StoredFlow>;
  remove(id: string): Promise<void>;
}
/** The flow was changed (or deleted) elsewhere since it was loaded; `current` is its stored version. */
export class FlowConflict extends Error { constructor(readonly current?: StoredFlow) { super('This flow was changed elsewhere since it was loaded'); } }
export const FLOW_STORAGE_VERSION = 1;
export function flowStorageKey(repositoryId: string): string { return `archipelago:flows:v${FLOW_STORAGE_VERSION}:${repositoryId}`; }

function isStep(value: unknown): value is FlowStep {
  return !!value && typeof value === 'object' && typeof (value as FlowStep).entityId === 'string' && (value as FlowStep).entityId.length > 0;
}
function isFlow(value: unknown): value is StoredFlow {
  const flow = value as StoredFlow;
  return !!flow && typeof flow === 'object' && typeof flow.id === 'string' && typeof flow.name === 'string' && (flow.type === 'declared' || flow.type === 'static') && Array.isArray(flow.steps) && flow.steps.every(isStep);
}
/** Only what a flow is: its name, kind, dates and step IDs. */
function overlay(flow: StoredFlow): StoredFlow {
  return { id: flow.id, name: flow.name, type: flow.type, createdAt: flow.createdAt, updatedAt: flow.updatedAt, steps: flowSteps(flow.steps), ...(flow.revision !== undefined ? { revision: flow.revision } : {}) };
}
/** Flows kept in this browser's local storage, per repository identity (the fallback, and what older versions used). */
export function readLocalFlows(storage: Pick<Storage, 'getItem'> | undefined, repositoryId: string): StoredFlow[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(flowStorageKey(repositoryId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isFlow).map(flow => overlay({ ...flow, steps: flow.steps.map(step => ({ entityId: step.entityId })) })) : [];
  } catch { return []; }
}
/** localStorage adapter scoped to one repository identity. Malformed entries are ignored, not thrown. */
export function localFlowPersistence(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, repositoryId: string): FlowPersistence {
  const key = flowStorageKey(repositoryId);
  const write = (flows: StoredFlow[]) => {
    if (!storage) throw new Error('Browser storage is unavailable; flows cannot be saved');
    storage.setItem(key, JSON.stringify(flows.map(overlay)));
  };
  return {
    kind: 'browser', writable: true,
    async list() { return readLocalFlows(storage, repositoryId); },
    async save(flow) {
      const flows = readLocalFlows(storage, repositoryId);
      const stored = overlay(flow);
      write(flows.some(item => item.id === flow.id) ? flows.map(item => item.id === flow.id ? stored : item) : [...flows, stored]);
      return stored;
    },
    async remove(id) { write(readLocalFlows(storage, repositoryId).filter(flow => flow.id !== id)); },
  };
}
export function memoryFlowPersistence(initial: StoredFlow[] = []): FlowPersistence {
  let flows = structuredClone(initial);
  return {
    kind: 'browser', writable: true,
    async list() { return structuredClone(flows); },
    async save(flow) { const stored = overlay(structuredClone(flow)); flows = flows.some(item => item.id === flow.id) ? flows.map(item => item.id === flow.id ? stored : item) : [...flows, stored]; return structuredClone(stored); },
    async remove(id) { flows = flows.filter(flow => flow.id !== id); },
  };
}
export interface FlowApi {
  flows(): Promise<FlowsList>;
  createFlow(flow: StoredFlowInput): Promise<StoredFlow>;
  updateFlow(id: string, flow: StoredFlowInput & { revision?: number }): Promise<StoredFlow>;
  deleteFlow(id: string): Promise<void>;
}
/** The server's flow store. A stale revision (409) or a flow deleted meanwhile (404) is a FlowConflict. */
export function serverFlowPersistence(api: FlowApi, writable: boolean): FlowPersistence {
  const conflict = (error: unknown): never => {
    const status = (error as { status?: number }).status;
    if (status === 409 || status === 404) throw new FlowConflict((error as { body?: { flow?: StoredFlow } }).body?.flow);
    throw error;
  };
  return {
    kind: 'server', writable,
    async list() { return (await api.flows()).flows; },
    async save(flow, isNew) {
      if (!writable) throw new Error('This server is read-only: flows cannot be changed');
      const input = { id: flow.id, name: flow.name, type: flow.type, steps: flowSteps(flow.steps) };
      try { return isNew ? await api.createFlow(input) : await api.updateFlow(flow.id, { ...input, revision: flow.revision }); } catch (error) { return conflict(error); }
    },
    async remove(id) {
      if (!writable) throw new Error('This server is read-only: flows cannot be changed');
      try { await api.deleteFlow(id); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    },
  };
}
/** The flow a draft becomes: a new one, or the edited one (keeping its revision for the server's check). */
export function draftFlow(flows: StoredFlow[], draft: { id?: string; name: string; entityIds: string[]; type?: StoredFlow['type'] }, now: string, newId: () => string): { flow: StoredFlow; isNew: boolean } {
  if (!draft.entityIds.length) throw new Error('A flow needs at least one step');
  const error = validateFlowName(draft.name, flows, draft.id);
  if (error) throw new Error(error);
  const steps = draft.entityIds.map(entityId => ({ entityId }));
  const existing = draft.id ? flows.find(flow => flow.id === draft.id) : undefined;
  const type = draft.type ?? 'declared';
  // Editing the steps of a static flow makes it a declared one.
  if (existing) return { isNew: false, flow: { ...existing, name: draft.name.trim(), type: existing.type === 'static' && JSON.stringify(existing.steps) === JSON.stringify(steps) ? 'static' : type, steps, updatedAt: now } };
  return { isNew: true, flow: { id: newId(), name: draft.name.trim(), type, steps, createdAt: now, updatedAt: now } };
}
export function upsertFlow(flows: StoredFlow[], draft: { id?: string; name: string; entityIds: string[]; type?: StoredFlow['type'] }, now: string, newId: () => string): StoredFlow[] {
  const { flow, isNew } = draftFlow(flows, draft, now, newId);
  return isNew ? [...flows, flow] : flows.map(item => item.id === flow.id ? flow : item);
}
export function replaceFlow(flows: StoredFlow[], flow: StoredFlow): StoredFlow[] { return flows.some(item => item.id === flow.id) ? flows.map(item => item.id === flow.id ? flow : item) : [...flows, flow]; }
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
export function resolveSteps(flow: Pick<StoredFlow, 'steps'>, existing: ReadonlySet<string>): ResolvedStep[] {
  return flow.steps.map((step, index) => ({ index, entityId: step.entityId, missing: !existing.has(step.entityId) }));
}
