'use client';
// Blast radius in the middle of the screen: what depends on an entity, or on
// the uncommitted changes, hop by hop. It stays on its origin while you select
// what it lists; the overview map colors it by hops. Listed by hops, or by
// application, feature or folder. Results come from /api/projection/impact
// and /api/projection/impact-working.
import { useState } from 'react';
import type { ImpactGroupBy, ImpactItem, ImpactResult, NodeSummary } from '@engine/projection/dto';
import { compactNumber, shortSha, typeLabel } from '../lib/format';
import { impactColors, mixHex } from '../lib/renderer';
import { WORKING_CHANGES } from '../lib/store';
import { themeById } from '../lib/themes';
import { CopyButton } from './FilesView';
import { useAtlas, useStore } from './context';
import { TypeBadge } from './TypeBadge';

const DEPTHS = [1, 2, 3, 4, 6, 8, 10];
const GROUPS: [ImpactGroupBy | undefined, string][] = [[undefined, 'Hops'], ['app', 'Application'], ['feature', 'Feature'], ['folder', 'Folder']];
function distanceColor(themeId: string, distance: number, depth: number): string {
  const colors = impactColors(themeById(themeId));
  return distance === 0 ? colors.origin : mixHex(colors.near, colors.far, depth > 1 ? (distance - 1) / (depth - 1) : 0);
}
/** What a blast radius starts from, in words. */
export function impactOriginName(forId: string | undefined, data: ImpactResult | undefined, fallback?: string): string {
  if (forId === WORKING_CHANGES) return 'uncommitted changes';
  return data?.origin.kind === 'entity' ? data.origin.node.name : fallback ?? '…';
}

export function ImpactView() {
  const store = useStore();
  const impact = useAtlas(state => state.impact);
  const themeId = useAtlas(state => state.themeId);
  const selection = useAtlas(state => state.selection?.node);
  const live = useAtlas(state => state.meta?.snapshot.kind === 'working_tree' && !state.meta.comparison);
  const comparing = useAtlas(state => !!state.meta?.comparison);
  const features = useAtlas(state => (state.annotations.data?.domains.length ?? 0) > 0);
  const known = useAtlas(() => impact.forId && impact.forId !== WORKING_CHANGES ? store.scene.nodes.get(impact.forId)?.name : undefined);
  const data = impact.forId ? impact.data : undefined;
  const max = data ? Math.max(1, ...data.byDistance) : 1;
  const working = impact.forId === WORKING_CHANGES;
  const name = impactOriginName(impact.forId, data, known);
  const groups = GROUPS.filter(([key]) => key !== 'feature' || features);
  const copy = () => impact.items.map(item => `${item.name} (${typeLabel(item.type, item.role)}, ${item.distance} hop${item.distance === 1 ? '' : 's'})${item.path ? ` ${item.path}` : ''}`).join('\n');
  return (
    <section className="tool-view impact-view" role="region" aria-label="Blast radius">
      <header className="tool-head">
        <div className="tool-title">
          <h2>Impact{impact.forId ? <> of <span className={working ? undefined : 'mono'}>{name}</span></> : ''}</h2>
          <span className="absent">What depends on it, through indexed relationships, hop by hop</span>
        </div>
        <div className="tool-actions">
          {impact.forId && (
            <>
              <label htmlFor="impact-depth" className="absent">Hops</label>
              <select id="impact-depth" className="select small" value={impact.depth} onChange={event => void store.setImpactDepth(Number(event.target.value))}>
                {DEPTHS.map(depth => <option key={depth} value={depth}>{depth}</option>)}
              </select>
              <CopyButton text={copy} disabled={!impact.items.length} label="Copy list" title="Copy the entities listed (name, type, hops, path), one per line" />
              <button className="button small primary" onClick={() => store.setCenter('map')} disabled={!data} title="Back to the map, colored by hops from the origin">Show on map</button>
            </>
          )}
          <button className="icon-button small" onClick={() => store.hideImpact()} aria-label="Close impact">✕</button>
        </div>
      </header>
      <div className="tool-body">
        <div className="impact-origins" role="group" aria-label="Impact of">
          {selection && selection.kind === 'entity' && <button className="chip" aria-pressed={impact.forId === selection.id} onClick={() => void store.showImpact(selection.id)} title="What depends on the selection">The selection: <strong>{selection.name}</strong></button>}
          {live && <button className="chip" aria-pressed={working} onClick={() => void store.showWorkingImpact()} title="What depends on the code changed since the last commit, as indexed">Uncommitted changes</button>}
          {impact.forId && impact.forId !== WORKING_CHANGES && impact.forId !== selection?.id && <span className="chip" aria-pressed>{name}</span>}
        </div>
        {!impact.forId && <p className="note">Select something on the map or search for it, then choose it above. {live ? 'Or see what your uncommitted changes affect.' : ''}</p>}
        {impact.forId && <OriginNote data={data} node={data?.origin.kind === 'entity' ? data.origin.node : selection?.id === impact.forId ? selection : undefined} working={working} />}
        {impact.status === 'loading' && !data && <div className="rf-loading"><span className="rf-spark" />Walking dependents…</div>}
        {impact.status === 'error' && <p className="note error">{impact.error}</p>}
        {data && (
          <>
            {data.total === 0 && !(data.origin.kind === 'working' && data.origin.reason) && <p className="note">Nothing indexed depends on this. That is a lower bound: see what the walk cannot see below.</p>}
            {data.total > 0 && (
              <div className="impact-bars" role="list" aria-label="Affected entities by hop count">
                {data.byDistance.map((count, distance) => distance === 0 ? null : (
                  <button key={distance} role="listitem" className="impact-bar" aria-pressed={impact.filter.distance === distance} onClick={() => void store.setImpactFilter({ ...impact.filter, distance: impact.filter.distance === distance ? undefined : distance })} disabled={!count} title={`${count} at ${distance} hop${distance === 1 ? '' : 's'}`}>
                    <span className="impact-bar-label">{distance}</span>
                    <span className="impact-bar-track"><span className="impact-bar-fill" style={{ width: `${(count / max) * 100}%`, background: distanceColor(themeId, distance, data.depth) }} /></span>
                    <span className="count">{count}</span>
                  </button>
                ))}
              </div>
            )}
            {data.total > 0 && <p className="impact-highlight">{(data.highlights.endpoints > 0 || data.highlights.routes > 0) && <>Reaches {[data.highlights.endpoints ? `${data.highlights.endpoints} endpoint${data.highlights.endpoints === 1 ? '' : 's'}` : '', data.highlights.routes ? `${data.highlights.routes} page${data.highlights.routes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}. </>}Affected: {data.highlights.applications.map(app => `${app.count} in ${app.name}`).join(', ')}.</p>}
            {data.truncated && <p className="note warning">The walk stopped at its node limit; deeper dependents are not listed.</p>}
            {data.seedsTruncated && <p className="note warning">Only the first entities inside this container seed the walk.</p>}
            <Unknowns unknowns={data.unknowns} />
            {data.total > 0 && (
              <div className="impact-controls">
                <div className="segmented" role="group" aria-label="List by">
                  {groups.map(([key, text]) => <button key={text} aria-pressed={impact.group === key} onClick={() => void store.setImpactGroup(key)}>{text}</button>)}
                </div>
                {data.byType.length > 1 && (
                  <div className="filters" role="group" aria-label="Affected types">
                    <button className="chip" aria-pressed={!impact.filter.type} onClick={() => void store.setImpactFilter({ ...impact.filter, type: undefined })}>All</button>
                    {data.byType.map(item => <button key={item.type} className="chip" aria-pressed={impact.filter.type === item.type} onClick={() => void store.setImpactFilter({ ...impact.filter, type: impact.filter.type === item.type ? undefined : item.type })}>{typeLabel(item.type)} <span className="count">{item.count}</span></button>)}
                  </div>
                )}
              </div>
            )}
            {impact.group && data.groups ? (
              <ul className="tree impact-groups" aria-label={`Affected, by ${impact.group === 'app' ? 'application' : impact.group}`}>
                {data.groups.map(group => {
                  const open = impact.filter.groupKey === group.key;
                  return (
                    <li key={group.key} className={`tree-item${open ? ' lit' : ''}`}>
                      <div className="tree-row">
                        <button className="tree-label" aria-expanded={open} onClick={() => void store.setImpactFilter({ ...impact.filter, groupKey: open ? undefined : group.key })}>
                          <span className="tree-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
                          <span className="impact-distance" style={{ background: distanceColor(themeId, group.distance, data.depth) }} title={`Nearest: ${group.distance} hop${group.distance === 1 ? '' : 's'}`}>{group.distance}</span>
                          <span className={`label${impact.group === 'folder' ? ' mono' : ''}`}>{group.name}</span>
                          <span className="count">{group.count}</span>
                        </button>
                      </div>
                      {open && <div className="tree-children"><ImpactList depth={data.depth} /></div>}
                    </li>
                  );
                })}
              </ul>
            ) : <ImpactList depth={data.depth} />}
            {comparing && <p className="absent">Computed on the viewed snapshot; relationships removed since the baseline are not walked.</p>}
          </>
        )}
      </div>
    </section>
  );
}
function ImpactList({ depth }: { depth: number }) {
  const store = useStore();
  const impact = useAtlas(state => state.impact);
  const data = impact.data;
  if (!data) return null;
  return (
    <>
      <ul className="list">{impact.items.map(item => <ImpactRow key={item.id} item={item} depth={depth} />)}</ul>
      {impact.status === 'loading' && <p className="absent">Loading…</p>}
      {data.items.hasMore && <button className="button small" onClick={() => store.loadMoreImpact()} disabled={impact.status === 'loading'}>Load more ({impact.items.length} of {data.items.total})</button>}
    </>
  );
}
/** Where the walk starts, and how much that is. */
function OriginNote({ data, node, working }: { data?: ImpactResult; node?: NodeSummary; working: boolean }) {
  const origin = data?.origin;
  if (origin?.kind === 'working') {
    if (origin.reason) return <p className="note">{origin.reason}</p>;
    const changed = Object.entries(origin.byStatus ?? {}).map(([status, count]) => `${count} ${status}`).join(', ');
    return origin.method === 'comparison'
      ? <p className="absent impact-origin">From the {data!.seeds} entities{changed ? ` (${changed})` : ''} in {origin.files} file{origin.files === 1 ? '' : 's'} that changed since the indexed commit {origin.head ? shortSha(origin.head) : ''}, as indexed.</p>
      : <p className="absent impact-origin">From everything in the {origin.files} file{origin.files === 1 ? '' : 's'} Git reports as changed or new{origin.missing ? ` (${origin.missing} more not in the index: deleted, or not analyzed)` : ''}. Index the HEAD commit in History to start from what changed inside them only.</p>;
  }
  if (working) return null;
  if (!node) return null;
  return <p className="absent impact-origin">What depends on {node.kind === 'group' || node.childCount > 0 ? 'anything inside ' : ''}<strong>{node.name}</strong> through indexed calls, renders, handlers, routes, HTTP requests and inheritance{node.type === 'file' ? ', plus files importing it' : ''}. Containment is not climbed.{data ? ` ${compactNumber(data.total)} affected.` : ''}</p>;
}
function Unknowns({ unknowns }: { unknowns: { unresolvedHttpCalls: number; possibleCallers: { name: string; sites: number; entities: number }[] } }) {
  if (!unknowns.unresolvedHttpCalls && !unknowns.possibleCallers.length) return null;
  return (
    <div className="note impact-unknowns">
      <strong>Lower bound.</strong> The walk only follows proven relationships.
      <ul>
        {unknowns.unresolvedHttpCalls > 0 && <li>{unknowns.unresolvedHttpCalls} HTTP call{unknowns.unresolvedHttpCalls === 1 ? '' : 's'} could not be linked to an endpoint and might also reach the endpoints listed.</li>}
        {unknowns.possibleCallers.map(item => <li key={item.name}>{item.sites} unresolved call site{item.sites === 1 ? '' : 's'} in {item.entities} entit{item.entities === 1 ? 'y' : 'ies'} call something named <code>{item.name}</code> (matched by name only, not proven).</li>)}
      </ul>
    </div>
  );
}
function ImpactRow({ item, depth }: { item: ImpactItem; depth: number }) {
  const store = useStore();
  const themeId = useAtlas(state => state.themeId);
  const selected = useAtlas(state => state.selection?.id === item.id);
  const [open, setOpen] = useState(false);
  const last = item.chain.at(-1);
  return (
    <li className={`row impact-row${selected ? ' selected' : ''}`}>
      <div className="row-main">
        <button className="row-title row-button" onClick={() => void store.select(item.id, { fly: false })} title="Select it: the inspector shows it, the overview marks it">
          <span className="impact-distance" style={{ background: distanceColor(themeId, item.distance, depth) }} title={`${item.distance} hop${item.distance === 1 ? '' : 's'} away`}>{item.distance}</span>
          <TypeBadge type={item.type} role={item.role} />
          <span className="label" title={item.name}>{item.name}</span>
        </button>
        {last && <div className="row-sub">{last.from.name} {last.type} {last.to.name}{item.path ? ` · ${item.path}` : ''}</div>}
        {open && (
          <ol className="impact-chain">
            {item.chain.map(hop => (
              <li key={hop.relationId}>
                <span className="mono">{hop.from.name}</span> <span className="relation-phrase">{hop.type}</span> <span className="mono">{hop.to.name}</span>
                <button className="button tiny" onClick={() => void store.openEvidence(hop.relationId, { from: hop.from.name, to: hop.to.name, type: hop.type })} aria-label={`Why does ${hop.from.name} ${hop.type} ${hop.to.name}?`}>Why?</button>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="row-actions">
        <button className="button small" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? 'Less' : 'Chain'}</button>
        <button className="button small" onClick={() => { store.setCenter('map'); void store.select(item.id, { fly: true }); }} aria-label={`Go to ${item.name} on the map`}>Go</button>
      </div>
    </li>
  );
}
