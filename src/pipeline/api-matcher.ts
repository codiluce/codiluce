import type { AnalysisContext, Analyzer, HttpObservation } from '../core/analyzer.js';
import { hasFramework } from '../core/config.js';
import { ANALYZER_VERSION, evidence, type Entity, type Evidence } from '../core/graph.js';
import { compileIndexedPath, matchIndexedPath, requestPathSegments } from '../analysis/routes/pattern.js';
import { routingContract, matchRoutePattern } from '../analysis/routes/contracts.js';
import { configuredProxy, proxyPath, relativeApiBoundary, requestApplication } from '../analysis/routes/boundaries.js';
export const apiMatcher: Analyzer = {
  name: 'api-matcher', version: `${ANALYZER_VERSION}:5`,
  async analyze(context: AnalysisContext): Promise<void> {
    const endpoints = [...context.graph.entities.values()].filter(entity => entity.type === 'api_endpoint');
    const appsById = new Map(context.config.applications.map(app => [context.applicationIds.get(app.name), app]));
    const appFor = (entity: Entity) => entity.parentId ? appsById.get(entity.parentId) : undefined;
    const contracts = new Map(endpoints.map(endpoint => [endpoint.id, routingContract(endpoint.metadata.routing)]));
    const patterns = new Map(endpoints.map(endpoint => [endpoint.id, compileIndexedPath(String(endpoint.metadata.routePath))]));
    const requests = new Map<string, string[]>();
    const matchPath = (endpoint: Entity, path: string, strict = true): boolean => {
      const contract = contracts.get(endpoint.id);
      if (contract) return matchRoutePattern(contract.pattern, path, strict);
      let segments = requests.get(path); if (!segments) { segments = requestPathSegments(path); requests.set(path, segments); }
      return matchIndexedPath(patterns.get(endpoint.id)!, segments, strict);
    };
    const methodMatches = (endpoint: Entity, method: string): boolean => {
      const contract = contracts.get(endpoint.id), methods = contract?.methods;
      if (contract?.excludedMethods?.includes(method)) return false;
      return endpoint.metadata.method === method || methods === '*' || Array.isArray(methods) && methods.includes(method);
    };
    const literalEligible = new Map<string, Entity[]>(), resolvedEligible = new Map<string, Entity[]>();
    const link = (observation: HttpObservation, endpoint: Entity, facts: Evidence[], metadata: Record<string, unknown>) => {
      context.graph.relate(observation.callerId, endpoint.id, 'requests', facts, metadata);
      if (observation.effect) { observation.effect.endpoint = endpoint.id; observation.effect.targetName = endpoint.name; }
    };
    for (const observation of context.http) {
      if (observation.url === undefined && observation.resolved && observation.method) { matchResolved(observation, observation.resolved); continue; }
      if (observation.url === undefined || !observation.method) continue;
      let pathname: string; let search = '';
      let origin: string | undefined;
      try {
        if (observation.url.startsWith('/') && !observation.url.startsWith('//')) { const url = new URL(observation.url, 'http://atlas.invalid'); pathname = url.pathname; search = url.search; }
        else if (/^https?:\/\//.test(observation.url)) { const url = new URL(observation.url); pathname = url.pathname; origin = url.origin; search = url.search; }
        else throw new Error('Relative URLs without a leading slash require browser/base URL context');
      } catch (error) { context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: 'unresolved-http-url', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: error instanceof Error ? error.message : String(error) }); continue; }
      const callerApp = requestApplication(context, observation);
      const key = JSON.stringify([observation.method, origin, callerApp?.name, observation.transport]);
      let eligible = literalEligible.get(key);
      if (!eligible) {
        eligible = endpoints.filter(endpoint => {
          const app = appFor(endpoint);
          if (!app || !methodMatches(endpoint, observation.method!) || endpoint.metadata.registration === 'convention' && endpoint.metadata.framework === 'laravel') return false;
          if (origin && !app.apiOrigins?.includes(origin)) return false;
          if (!origin && observation.transport === 'sveltekit-fetch') return app.name === callerApp?.name && endpoint.metadata.framework === 'sveltekit';
          if (!origin && ['sveltekit', 'astro'].includes(String(endpoint.metadata.framework)) && app.name !== callerApp?.name && !callerApp?.apiProxies?.some(proxy => proxy.target === app.name)) return false;
          // Relative requests can target a local Next endpoint or a unique backend.
          return !!origin || !hasFramework(app, 'nextjs') || app.name === callerApp?.name;
        });
        literalEligible.set(key, eligible);
      }
      const proxy = !origin ? configuredProxy(callerApp, pathname) : undefined;
      const selectors = [...new URLSearchParams(search).keys()].filter(key => key.startsWith('/'));
      const candidates = eligible.filter(endpoint => {
        const action = contracts.get(endpoint.id)?.action;
        return (!action || (action.name === 'default' ? selectors.length === 0 : selectors.length === 1 && selectors[0] === `/${action.name}`)) && (!proxy || appFor(endpoint)?.name === proxy.target) && matchPath(endpoint, proxy ? proxyPath(proxy, pathname) : pathname);
      });
      // Keep constrained candidates in ambiguity detection: ignoring one could
      // falsely select another route with the same HTTP method/path.
      if (candidates.length !== 1 || candidates[0]!.metadata.constraintsUnresolved) {
        context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: candidates.length > 1 ? 'ambiguous-http-match' : candidates.length === 1 ? 'constrained-http-match' : 'unmatched-http-call', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: `${observation.method} ${pathname}: ${candidates.length} eligible endpoints${origin ? ' with explicit origin association' : ''}${candidates[0]?.metadata.constraintsUnresolved ? '; route constraints unresolved' : ''}` });
        continue;
      }
      const endpoint = candidates[0]!;
      if (!origin && (contracts.get(endpoint.id) || proxy)) {
        const boundary = relativeApiBoundary(context, observation, callerApp, appFor(endpoint)!, pathname);
        if ('reason' in boundary) { context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: 'unverified-relative-api-boundary', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: boundary.reason }); continue; }
        link(observation, endpoint, [observation.evidence, ...boundary.proof, ...endpoint.evidence], { method: observation.method, url: observation.url, resolution: boundary.resolution });
        continue;
      }
      // Laravel relative paths require an explicit proxy association. A browser
      // relative URL alone does not prove it reaches another application —
      // unless the page making it is served by that same Laravel application.
      const sameOrigin = !origin && endpoint.metadata.framework === 'laravel' && callerApp?.name === appFor(endpoint)?.name;
      if (!origin && endpoint.metadata.framework === 'laravel' && !sameOrigin) {
        context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: 'unverified-relative-api-boundary', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: `${observation.method} ${pathname} matches Laravel structurally, but no origin/proxy mapping proves the cross-application boundary` });
        continue;
      }
      link(observation, endpoint, [observation.evidence, ...(sameOrigin ? [sameOriginFact(observation, endpoint)] : []), ...endpoint.evidence], { method: observation.method, url: observation.url, resolution: sameOrigin ? 'same-origin' : 'literal' });
    }
    function sameOriginFact(observation: HttpObservation, endpoint: Entity): Evidence {
      return evidence('framework', 'api-matcher', observation.evidence.file, observation.evidence.line, `Relative URL from code of ${appFor(endpoint)?.name}, a Laravel application: the page making the request is served by the same origin`);
    }
    /** A URL whose base was proven (configured origin or declared environment variable), possibly with template holes. */
    function matchResolved(observation: HttpObservation, resolved: NonNullable<HttpObservation['resolved']>): void {
      const callerApp = requestApplication(context, observation);
      const diagnose = (code: string, reason: string) => context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code, entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason });
      const key = JSON.stringify([observation.method, resolved.app, callerApp?.name, observation.transport]);
      let eligible = resolvedEligible.get(key);
      if (!eligible) {
        eligible = endpoints.filter(endpoint => {
          const app = appFor(endpoint);
          if (!app || !methodMatches(endpoint, observation.method!) || endpoint.metadata.registration === 'convention' && endpoint.metadata.framework === 'laravel') return false;
          if (resolved.app) return app.name === resolved.app;
          if (observation.transport === 'sveltekit-fetch') return app.name === callerApp?.name && endpoint.metadata.framework === 'sveltekit';
          if (endpoint.metadata.framework === 'sveltekit' && app.name !== callerApp?.name && !callerApp?.apiProxies?.some(proxy => proxy.target === app.name)) return false;
          return !!contracts.get(endpoint.id) || app.name === callerApp?.name || (hasFramework(app, 'laravel') && !hasFramework(callerApp, 'laravel'));
        });
        resolvedEligible.set(key, eligible);
      }
      const proxy = !resolved.app ? configuredProxy(callerApp, resolved.pattern) : undefined;
      const pattern = proxy ? proxyPath(proxy, resolved.pattern) : resolved.pattern;
      const scoped = proxy ? eligible.filter(endpoint => appFor(endpoint)?.name === proxy.target) : eligible;
      // A dynamic path summary does not prove a form action query selector.
      const strict = scoped.filter(endpoint => !contracts.get(endpoint.id)?.action && matchPath(endpoint, pattern));
      const loose = scoped.filter(endpoint => !contracts.get(endpoint.id)?.action && matchPath(endpoint, pattern, false));
      const label = `${observation.method} ${resolved.pattern}${resolved.app ? ` on ${resolved.app}` : ''}`;
      if (strict.length !== 1 || loose.length !== 1 || strict[0]!.metadata.constraintsUnresolved) {
        const reason = loose.length > strict.length ? `${label}: a dynamic segment could also equal a literal route segment (${loose.filter(item => !strict.includes(item)).map(item => item.name).join(', ')})` : `${label}: ${strict.length} eligible endpoints${strict[0]?.metadata.constraintsUnresolved ? '; route constraints unresolved' : ''}`;
        diagnose(loose.length > 1 ? 'ambiguous-http-match' : strict.length === 1 ? 'constrained-http-match' : 'unmatched-http-call', reason);
        return;
      }
      const endpoint = strict[0]!;
      let boundaryProof: Evidence[] = [], boundaryResolution: string | undefined;
      if (!resolved.app && (contracts.get(endpoint.id) || proxy)) {
        const boundary = relativeApiBoundary(context, observation, callerApp, appFor(endpoint)!, resolved.pattern);
        if ('reason' in boundary) { diagnose('unverified-relative-api-boundary', boundary.reason); return; }
        boundaryProof = boundary.proof; boundaryResolution = boundary.resolution;
      }
      const sameOrigin = !resolved.app && endpoint.metadata.framework === 'laravel' && callerApp?.name === appFor(endpoint)?.name;
      if (!boundaryResolution && !resolved.app && endpoint.metadata.framework === 'laravel' && !sameOrigin) { diagnose('unverified-relative-api-boundary', `${label} matches Laravel structurally, but no origin/proxy mapping proves the cross-application boundary`); return; }
      const holes = resolved.holes ? [evidence('framework', 'api-matcher', observation.evidence.file, observation.evidence.line, `${resolved.holes} dynamic path segment${resolved.holes === 1 ? '' : 's'} matched to route parameter${resolved.holes === 1 ? '' : 's'} of ${endpoint.name}; no literal route can match them`)] : [];
      link(observation, endpoint, [observation.evidence, ...resolved.proof, ...boundaryProof, ...(sameOrigin ? [sameOriginFact(observation, endpoint)] : []), ...holes, ...endpoint.evidence], { method: observation.method, url: resolved.display, pattern: resolved.pattern, resolution: resolved.app ? 'proven-base' : boundaryResolution ?? (sameOrigin ? 'same-origin' : 'template') });
    }
  },
};
