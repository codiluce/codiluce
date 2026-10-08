import type { TypeScriptPackScope } from './typescript-pack.js';
import type { EffectFact } from '../../core/graph.js';
import { requestExecutionContext } from '../routes/boundaries.js';

/** An imported callable can be registered by several applications. Keep its
 * declaration/evidence and copy only proven contextual relative invocations. */
export function kitInvocations(scope: TypeScriptPackScope): void {
  const { context } = scope, observations = [...context.http], outgoing = new Map<string, string[]>();
  for (const relation of context.graph.relations.values()) if (relation.type === 'calls') outgoing.set(relation.from, [...outgoing.get(relation.from) ?? [], relation.to]);
  for (const entity of context.graph.entities.values()) {
    if (!entity.metadata.svelteKitInvocation || !scope.inputs?.some(file => file.path === entity.metadata.registrationFile)) continue;
    const pending = [String(entity.metadata.registeredTarget)], seen = new Set<string>();
    while (pending.length && seen.size < 128) {
      const target = pending.shift()!; if (seen.has(target)) continue; seen.add(target);
      for (const observation of observations) if (observation.callerId === target && (observation.transport === 'sveltekit-fetch' || entity.metadata.executionContext === 'browser' && requestExecutionContext(context, observation) === 'unknown') && (observation.resolved?.relative || observation.url?.startsWith('/') && !observation.url.startsWith('//'))) {
        const effect: EffectFact | undefined = observation.effect && { ...observation.effect };
        if (effect) { const effects = entity.metadata.effects as EffectFact[] | undefined ?? []; if (effects.length < 40) effects.push(effect); entity.metadata.effects = effects; }
        const file = context.files.get(String(entity.metadata.registrationFile));
        if (file) context.http.push({ ...observation, callerId: entity.id, fileId: file.id, effect, evidence: { ...observation.evidence, explanation: `${observation.evidence.explanation}; ${observation.transport ? 'RequestEvent' : 'Browser invocation context'} supplied by ${entity.metadata.executionApplication} at ${entity.metadata.registrationFile}` } });
      }
      pending.push(...outgoing.get(target) ?? []);
    }
    if (pending.length) context.graph.diagnose({ analyzer: 'sveltekit', severity: 'warning', code: 'sveltekit-invocation-budget', file: String(entity.metadata.registrationFile), entityId: entity.id, reason: 'Kit invocation traversal exceeded its 128-callable budget' });
  }
}
