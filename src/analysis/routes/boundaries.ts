import type { AnalysisContext, HttpObservation } from '../../core/analyzer.js';
import type { ApplicationConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';

export function requestApplication(context: AnalysisContext, observation: HttpObservation): ApplicationConfig | undefined {
  // Contextual callbacks can invoke a shared source outside their application.
  // Ownership follows the caller; evidence still points to the original call.
  const caller = context.graph.entities.get(observation.callerId);
  return context.files.get(caller?.path ?? observation.evidence.file ?? '')?.application;
}

export function requestExecutionContext(context: AnalysisContext, observation: HttpObservation): 'browser' | 'server' | 'unknown' {
  let entity = context.graph.entities.get(observation.callerId);
  while (entity) {
    if (entity.metadata.executionContext === 'server' || entity.metadata.serverAction || entity.metadata.serverModule) return 'server';
    if (entity.metadata.executionContext === 'browser') return 'browser';
    entity = entity.parentId ? context.graph.entities.get(entity.parentId) : undefined;
  }
  return 'unknown';
}
export function configuredProxy(app: ApplicationConfig | undefined, pathname: string): NonNullable<ApplicationConfig['apiProxies']>[number] | undefined {
  return app?.apiProxies?.filter(proxy => pathname === proxy.pathPrefix || pathname.startsWith(`${proxy.pathPrefix.replace(/\/$/, '')}/`)).sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
}
export function proxyPath(proxy: NonNullable<ApplicationConfig['apiProxies']>[number], pathname: string): string {
  return `${(proxy.targetPrefix ?? proxy.pathPrefix).replace(/\/$/, '')}/${pathname.slice(proxy.pathPrefix.length).replace(/^\//, '')}`.replace(/\/$/, '') || '/';
}
export function relativeApiBoundary(context: AnalysisContext, observation: HttpObservation, caller: ApplicationConfig | undefined, target: ApplicationConfig, pathname: string): { proof: Evidence[]; resolution: string } | { reason: string } {
  const execution = requestExecutionContext(context, observation);
  if (execution !== 'browser') return { reason: `Relative URL has ${execution} execution context; a browser origin is required to prove the application boundary` };
  const proxy = configuredProxy(caller, pathname);
  if (proxy?.target === target.name) return { resolution: 'configured-proxy', proof: [evidence('framework', 'api-matcher', observation.evidence.file, observation.evidence.line, `Configured browser proxy on ${caller!.name}: ${proxy.pathPrefix} → ${target.name}${proxy.targetPrefix ?? proxy.pathPrefix}`)] };
  if (caller?.name === target.name) return { resolution: 'same-origin', proof: [evidence('framework', 'api-matcher', observation.evidence.file, observation.evidence.line, `Browser request from ${caller.name} reaches a registered endpoint of the same application`)] };
  return { reason: 'A relative browser URL requires an explicit proxy association to reach another application' };
}
