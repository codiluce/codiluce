import type { TypeScriptPackScope } from './typescript-pack.js';
import type { EffectFact } from '../../core/graph.js';
import { requestExecutionContext } from '../routes/boundaries.js';

export function browserInvocations(scope: TypeScriptPackScope, pack: string, flag: string): void {
    // Browser invocation is contextual. A shared method can also execute in
    // SSR; do not relabel its declaration or its original request as browser.
    const { context } = scope, observations = [...context.http];
    const outgoing = new Map<string, string[]>();
    for (const relation of context.graph.relations.values()) if (relation.type === 'calls') outgoing.set(relation.from, [...(outgoing.get(relation.from) ?? []), relation.to]);
    for (const event of context.graph.entities.values()) {
      if (!event.metadata[flag] || !scope.inputs?.some(file => file.path === event.path)) continue;
      const seen = new Set<string>(), pending = [...(outgoing.get(event.id) ?? [])];
      while (pending.length && seen.size < 128) {
        const id = pending.shift()!; if (seen.has(id)) continue; seen.add(id);
        if (requestExecutionContext(context, { callerId: id, fileId: '', expression: '', evidence: event.evidence[0]! }) === 'server') continue;
        for (const observation of observations) if (observation.callerId === id && requestExecutionContext(context, observation) === 'unknown' && (observation.url?.startsWith('/') && !observation.url.startsWith('//') || observation.resolved?.relative)) {
          const effect: EffectFact | undefined = observation.effect && { ...observation.effect };
          if (effect) { const effects = event.metadata.effects as EffectFact[] | undefined ?? []; if (effects.length < 40) effects.push(effect); event.metadata.effects = effects; }
          const file = context.files.get(event.path!);
          if (file) context.http.push({ ...observation, callerId: event.id, fileId: file.id, effect, evidence: { ...observation.evidence, explanation: `${observation.evidence.explanation ?? 'HTTP call'}; invoked by ${pack} ${event.metadata.event ?? event.name} callback at ${event.path}:${event.sourceRange?.startLine}` } });
        }
        pending.push(...(outgoing.get(id) ?? []));
      }
      if (pending.length) context.graph.diagnose({ analyzer: pack, severity: 'warning', code: `${pack}-event-call-budget`, file: event.path, entityId: event.id, reason: 'Browser invocation traversal exceeded its 128-callable budget' });
    }
}
