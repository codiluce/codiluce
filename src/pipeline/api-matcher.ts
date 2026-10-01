import type { AnalysisContext, Analyzer } from '../core/analyzer.js';
import { ANALYZER_VERSION, type Entity } from '../core/graph.js';

function matchPath(route: string, url: string): boolean {
  const routeSegments = route.split('/').filter(Boolean), urlSegments = url.split('/').filter(Boolean);
  let cursor = 0;
  for (const segment of routeSegments) {
    if (/^\{[^/{}]+\?\}$/.test(segment)) { if (cursor < urlSegments.length) cursor++; }
    else if (/^\{[^/{}]+\}$/.test(segment) || /^:[^*+]+$/.test(segment)) { if (!urlSegments[cursor++]) return false; }
    else if (/^:[^/]+[+*]$/.test(segment)) { return segment.endsWith('*') || cursor < urlSegments.length; }
    else if (segment !== urlSegments[cursor++]) return false;
  }
  return cursor === urlSegments.length;
}
export const apiMatcher: Analyzer = {
  name: 'api-matcher', version: ANALYZER_VERSION,
  async analyze(context: AnalysisContext): Promise<void> {
    const endpoints = [...context.graph.entities.values()].filter(entity => entity.type === 'api_endpoint');
    const appFor = (entity: Entity) => context.config.applications.find(app => context.applicationIds.get(app.name) === entity.parentId);
    for (const observation of context.http) {
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
        if (!origin && app.type === 'nextjs' && app.name !== callerApp?.name) return false;
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
      // relative URL alone does not prove it reaches another application.
      if (!origin && endpoint.metadata.framework === 'laravel') {
        context.graph.diagnose({ analyzer: 'api-matcher', severity: 'warning', code: 'unverified-relative-api-boundary', entityId: observation.callerId, file: observation.evidence.file, line: observation.evidence.line, reason: `${observation.method} ${pathname} matches Laravel structurally, but no origin/proxy mapping proves the cross-application boundary` });
        continue;
      }
      context.graph.relate(observation.callerId, endpoint.id, 'requests', [observation.evidence, ...endpoint.evidence], { method: observation.method, url: observation.url, resolution: 'literal' });
    }
  },
};
