// Named flows: an overlay of ordered entity IDs that someone declared, or
// found as a path of indexed relationships (static). They are never copies of
// graph objects and never evidence of execution. Shared by the flow store
// (server) and the visualizer, so both enforce the same rules.
import type { Flow, FlowStep } from './graph.js';

export interface StoredFlow extends Flow {
  type: 'declared' | 'static';
  createdAt: string; updatedAt: string;
  /** Server-side version, incremented on every save: an edit based on an older one is refused. */
  revision?: number;
}
export interface FlowInput { id?: string; name: string; type: 'declared' | 'static'; steps: FlowStep[] }
export const FLOW_NAME_MAX = 80, FLOW_STEPS_MAX = 200;
/** Entity and relation IDs as the graph builder makes them (`kind:hash`); projection districts are not entities. */
const ENTITY_ID = /^[a-z_]+:[0-9a-f]{8,64}$/;
const FLOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validateFlowName(name: string, flows: Pick<StoredFlow, 'id' | 'name'>[], editingId?: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the flow a name';
  if (trimmed.length > FLOW_NAME_MAX) return `Use at most ${FLOW_NAME_MAX} characters`;
  if (flows.some(flow => flow.id !== editingId && flow.name.toLowerCase() === trimmed.toLowerCase())) return 'A flow with this name already exists';
  return undefined;
}
/** Every rule a flow must satisfy before it is stored. Returns the first problem, or undefined. */
export function validateFlow(input: unknown, flows: Pick<StoredFlow, 'id' | 'name'>[], editingId?: string): string | undefined {
  if (!input || typeof input !== 'object') return 'A flow must be an object';
  const flow = input as Partial<FlowInput>;
  if (flow.id !== undefined && (typeof flow.id !== 'string' || !FLOW_ID.test(flow.id))) return 'Invalid flow id';
  if (typeof flow.name !== 'string') return 'Give the flow a name';
  const name = validateFlowName(flow.name, flows, editingId);
  if (name) return name;
  if (flow.type !== 'declared' && flow.type !== 'static') return 'A flow is declared or static';
  if (!Array.isArray(flow.steps) || !flow.steps.length) return 'A flow needs at least one step';
  if (flow.steps.length > FLOW_STEPS_MAX) return `A flow has at most ${FLOW_STEPS_MAX} steps`;
  for (const step of flow.steps) {
    if (!step || typeof step !== 'object' || typeof step.entityId !== 'string' || !ENTITY_ID.test(step.entityId)) return 'Every step must be an indexed entity ID';
    if (step.relationId !== undefined && (typeof step.relationId !== 'string' || !ENTITY_ID.test(step.relationId))) return 'Invalid relation ID in a step';
  }
  return undefined;
}
/** Only the overlay's own fields: entity (and relation) IDs, never copies of graph objects. */
export function flowSteps(steps: FlowStep[]): FlowStep[] { return steps.map(step => ({ entityId: step.entityId, ...(step.relationId ? { relationId: step.relationId } : {}) })); }
