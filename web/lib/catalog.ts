// The flow catalog in the visualizer: one list of every flow, filtered by
// kind, completeness and text, and grouped by area. Pure.
import type { CatalogKind, FlowStatus, FlowSummary } from '@engine/projection/dto';

/** What the panel's kind filter can show: everything, or one kind of start. */
export type CatalogTab = CatalogKind | 'all';
export const CATALOG_TABS: CatalogTab[] = ['all', 'page', 'request', 'command'];
/** The kinds behind a filter: requests include the requests no endpoint answers; the console holds commands and scheduled tasks. */
export function kindsOf(tab: CatalogTab): CatalogKind[] {
  return tab === 'all' ? ['page', 'request', 'unmatched', 'command', 'schedule'] : tab === 'request' ? ['request', 'unmatched'] : tab === 'command' ? ['schedule', 'command'] : [tab];
}
export const KIND_TEXT: Record<CatalogTab, string> = { all: 'All', page: 'Pages', request: 'Requests', command: 'Console', schedule: 'Scheduled', unmatched: 'Unmatched' };
export const KIND_HINT: Record<CatalogTab, string> = {
  all: 'Every flow the index can follow: pages, HTTP requests, and work that starts without a request.',
  page: 'What a user can do from each page: the page, what it renders, the requests it makes and what those reach.',
  request: 'Every HTTP request the index can follow, from the page or event that sends it to the response and back.',
  command: 'Artisan commands and scheduled tasks: work that starts without a request, from the scheduler, from code, or by hand.',
  schedule: 'Tasks the scheduler runs, and what they reach.',
  unmatched: 'Requests made by indexed code that no indexed endpoint answers.',
};
/** Completeness is about HTTP: a page with lanes, a request, an unmatched request. Console flows have none. */
export function completenessOf(item: FlowSummary): FlowStatus | undefined {
  return item.kind === 'command' || item.kind === 'schedule' ? undefined : item.status;
}
export function matchesCatalog(item: FlowSummary, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [item.name, item.path ?? '', item.handler ?? '', item.entry.name, item.app ?? '', item.cadence ?? '', item.title ?? '', item.goal ?? '', item.actor ?? ''].join('\u0000').toLowerCase();
  return words.every(word => text.includes(word));
}
export interface CatalogGroup { key: string; app?: string; group: string; label: string; items: FlowSummary[] }
/** Area groups (first path segment) first, then command namespaces, the scheduler, and requests no endpoint answers. */
const groupRank = (group: string) => group === 'unmatched' ? 3 : group === 'scheduler' ? 2 : group === 'commands' || group.endsWith(':') ? 1 : 0;
/**
 * Groups by application and group: a page and the requests under its path
 * share a group, whatever their kind. Within a group, the server's order
 * (pages, requests, console; then by path).
 */
export function groupCatalog(items: FlowSummary[], query = '', status?: FlowStatus): CatalogGroup[] {
  const groups = new Map<string, CatalogGroup>();
  for (const item of items) {
    if ((status && completenessOf(item) !== status) || !matchesCatalog(item, query)) continue;
    const key = `${item.app ?? ''}\u0000${item.group}`;
    let group = groups.get(key);
    if (!group) {
      const label = item.group === 'unmatched' ? 'Unmatched requests' : item.group === 'scheduler' ? 'Scheduler' : item.group === 'commands' ? 'Commands' : item.group;
      group = { key, ...(item.app ? { app: item.app } : {}), group: item.group, label, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  const order = (group: CatalogGroup) => [group.app ?? '', String(groupRank(group.group)), group.group.toLowerCase()].join('\u0000');
  return [...groups.values()].sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);
}
/** The flows the panel lists, in its order (a completeness filter only applies where the list has HTTP flows). */
export function visibleCatalog(items: FlowSummary[], options: { tab: CatalogTab; query: string; status?: FlowStatus }): CatalogGroup[] {
  const kinds = kindsOf(options.tab);
  const listed = items.filter(item => kinds.includes(item.kind));
  return groupCatalog(listed, options.query, listed.some(item => completenessOf(item)) ? options.status : undefined);
}
