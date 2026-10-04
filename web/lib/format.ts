// Display helpers. Missing values stay missing: callers get undefined, never 0.
const TYPE_LABELS: Record<string, string> = {
  repository: 'Repository', application: 'Application', group: 'District', directory: 'Directory', file: 'File',
  class: 'Class', controller: 'Controller', component: 'Component', function: 'Function', method: 'Method',
  route: 'Page route', api_endpoint: 'Endpoint', model: 'Model', database_table: 'Database table',
  external_service: 'External service', test: 'Test', user_flow: 'User flow', domain: 'Domain',
};
export function typeLabel(type: string, role?: string): string {
  if (type === 'function' && role === 'hook') return 'Hook';
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}
const RELATION_LABELS: Record<string, { outgoing: string; incoming: string }> = {
  imports: { outgoing: 'imports', incoming: 'imported by' },
  exports: { outgoing: 'exports', incoming: 'exported by' },
  handles: { outgoing: 'handled by', incoming: 'handles' },
  routes_to: { outgoing: 'routes to', incoming: 'routed from' },
  requests: { outgoing: 'requests', incoming: 'requested by' },
  extends: { outgoing: 'extends', incoming: 'extended by' },
  implements: { outgoing: 'implements', incoming: 'implemented by' },
  calls: { outgoing: 'calls', incoming: 'called by' },
  renders: { outgoing: 'renders', incoming: 'rendered by' },
  reads: { outgoing: 'reads', incoming: 'read by' },
  writes: { outgoing: 'writes', incoming: 'written by' },
  queries: { outgoing: 'queries', incoming: 'queried by' },
  maps_to: { outgoing: 'maps to', incoming: 'mapped from' },
  references: { outgoing: 'references', incoming: 'referenced by' },
  foreign_key: { outgoing: 'foreign key to', incoming: 'foreign key from' },
};
/**
 * Phrase a relation from the perspective of the selected entity. `handles`
 * points endpoint → handler, so an endpoint's outgoing edge reads "handled by".
 */
export function relationPhrase(type: string, direction: 'outgoing' | 'incoming' | 'self'): string {
  const labels = RELATION_LABELS[type];
  if (!labels) return direction === 'incoming' ? `${type} (incoming)` : type;
  return direction === 'incoming' ? labels.incoming : labels.outgoing;
}
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
export function percent(value: number): string { return `${Math.round(value * 100)}%`; }
export function shortSha(sha: string | undefined): string | undefined { return sha?.slice(0, 8); }
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
