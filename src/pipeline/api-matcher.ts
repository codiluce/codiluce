import type { AnalysisContext, Analyzer, HttpObservation } from '../core/analyzer.js';
import { hasFramework } from '../core/config.js';
import { ANALYZER_VERSION, evidence, type Entity, type Evidence } from '../core/graph.js';

const HOLE = '{*}';
function isParameter(segment: string): boolean { return /^\{[^/{}]+\??\}$/.test(segment) || /^:[^/]+$/.test(segment); }
/**
 * Route path vs request path. A request segment `{*}` stands for a dynamic
 * value filling one segment: `strict` lets it match only a route parameter;
 * otherwise it may also equal a literal segment (used to detect ambiguity).
 */
function matchPath(route: string, url: string, strict = true): boolean {
  const routeSegments = route.split('/').filter(Boolean), urlSegments = url.split('/').filter(Boolean);
  let cursor = 0;
  for (const segment of routeSegments) {
    if (/^\{[^/{}]+\?\}$/.test(segment)) { if (cursor < urlSegments.length) cursor++; }
    else if (/^\{[^/{}]+\}$/.test(segment) || /^:[^*+]+$/.test(segment)) { if (!urlSegments[cursor++]) return false; }
    else if (/^:[^/]+[+*]$/.test(segment)) { return segment.endsWith('*') || cursor < urlSegments.length; }
    else { const value = urlSegments[cursor++]; if (value === HOLE ? strict : segment !== value) return false; }
  }
  return cursor === urlSegments.length;
}
export const apiMatcher: Analyzer = {
  name: 'api-matcher', version: ANALYZER_VERSION,
  async analyze(context: AnalysisContext): Promise<void> {
    const endpoints = [...context.graph.entities.values()].filter(entity => entity.type === 'api_endpoint');
    const appFor = (entity: Entity) => context.config.applications.find(app => context.applicationIds.get(app.name) === entity.parentId);
    const link = (observation: HttpObservation, endpoint: Entity, facts: Evidence[], metadata: Record<string, unknown>) => {
      context.graph.relate(observation.callerId, endpoint.id, 'requests', facts, metadata);
      if (observation.effect) { observation.effect.endpoint = endpoint.id; observation.effect.targetName = endpoint.name; }
    };
    for (const observation of context.http) {
      if (observation.url === undefined && observation.resolved && observation.method) { matchResolved(observation, observation.resolved); continue; }
      if (observation.url === undefined || !observation.method) continue;
      let pathname: string;
      let origin: string | undefined;
      try {
        if (observation.url.startsWith('/') && !observation.url.startsWith('//')) pathname = new URL(observation.url, 'http://atlas.invalid').pathname;
        else if (/^https?:\/\//.test(observation.url)) { const url = new URL(observation.url); pathname = url.pathname; origin = url.origin; }
        else throw new Error('Relative URLs without a leading slash require browser/base URL context');
      } catch (error) { context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: 'unresolved-http-url', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: error instanceof Error ? error.message : String(error) }); continue; }
      const callerApp = context.files.get(observation.evidence.file!)?.application;
      const candidates = endpoints.filter(endpoint => {
        const app = appFor(endpoint);
        if (!app || endpoint.metadata.method !== observation.method || endpoint.metadata.registration === 'convention' && endpoint.metadata.framework === 'laravel') return false;
        if (origin && !app.apiOrigins?.includes(origin)) return false;
        // Relative requests can target a local Next endpoint or a unique backend.
        if (!origin && hasFramework(app, 'nextjs') && app.name !== callerApp?.name) return false;
        return matchPath(String(endpoint.metadata.routePath), pathname);
      });
      // Keep constrained candidates in ambiguity detection: ignoring one could
      // falsely select another route with the same HTTP method/path.
      if (candidates.length !== 1 || candidates[0]!.metadata.constraintsUnresolved) {
        context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: candidates.length > 1 ? 'ambiguous-http-match' : candidates.length === 1 ? 'constrained-http-match' : 'unmatched-http-call', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: `${observation.method} ${pathname}: ${candidates.length} eligible endpoints${origin ? ' with explicit origin association' : ''}${candidates[0]?.metadata.constraintsUnresolved ? '; route constraints unresolved' : ''}` });
        continue;
      }
      const endpoint = candidates[0]!;
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
      const callerApp = context.files.get(observation.evidence.file!)?.application;
      const diagnose = (code: string, reason: string) => context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code, entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason });
      const eligible = endpoints.filter(endpoint => {
        const app = appFor(endpoint);
        if (!app || endpoint.metadata.method !== observation.method || endpoint.metadata.registration === 'convention' && endpoint.metadata.framework === 'laravel') return false;
        if (resolved.app) return app.name === resolved.app;
        return app.name === callerApp?.name || (hasFramework(app, 'laravel') && !hasFramework(callerApp, 'laravel'));
      });
      const strict = eligible.filter(endpoint => matchPath(String(endpoint.metadata.routePath), resolved.pattern));
      const loose = eligible.filter(endpoint => matchPath(String(endpoint.metadata.routePath), resolved.pattern, false));
      const label = `${observation.method} ${resolved.pattern}${resolved.app ? ` on ${resolved.app}` : ''}`;
      if (strict.length !== 1 || loose.length !== 1 || strict[0]!.metadata.constraintsUnresolved) {
        const reason = loose.length > strict.length ? `${label}: a dynamic segment could also equal a literal route segment (${loose.filter(item => !strict.includes(item)).map(item => item.name).join(', ')})` : `${label}: ${strict.length} eligible endpoints${strict[0]?.metadata.constraintsUnresolved ? '; route constraints unresolved' : ''}`;
        diagnose(loose.length > 1 ? 'ambiguous-http-match' : strict.length === 1 ? 'constrained-http-match' : 'unmatched-http-call', reason);
        return;
      }
      const endpoint = strict[0]!;
      const sameOrigin = !resolved.app && endpoint.metadata.framework === 'laravel' && callerApp?.name === appFor(endpoint)?.name;
      if (!resolved.app && endpoint.metadata.framework === 'laravel' && !sameOrigin) { diagnose('unverified-relative-api-boundary', `${label} matches Laravel structurally, but no origin/proxy mapping proves the cross-application boundary`); return; }
      const holes = resolved.holes ? [evidence('framework', 'api-matcher', observation.evidence.file, observation.evidence.line, `${resolved.holes} dynamic path segment${resolved.holes === 1 ? '' : 's'} matched to route parameter${resolved.holes === 1 ? '' : 's'} of ${endpoint.name}; no literal route can match them`)] : [];
      link(observation, endpoint, [observation.evidence, ...resolved.proof, ...(sameOrigin ? [sameOriginFact(observation, endpoint)] : []), ...holes, ...endpoint.evidence], { method: observation.method, url: resolved.display, pattern: resolved.pattern, resolution: resolved.app ? 'proven-base' : sameOrigin ? 'same-origin' : 'template' });
    }
  },
};
