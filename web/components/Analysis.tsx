'use client';
// Inspector sections for call resolution and blast radius, and the timeline's
// commit-impact chip. Results come from /api/projection/impact and the
// `callSites` / `effects` metadata the analyzers record on symbols.
import { useEffect, useState } from 'react';
import type { CallSites, EffectFact, Entity } from '@engine/core/graph';
import type { ImpactItem, NodeSummary } from '@engine/projection/dto';
import { compactNumber, typeLabel } from '../lib/format';
import { impactColors, mixHex } from '../lib/renderer';
import { themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { TypeBadge } from './TypeBadge';

const DEPTHS = [1, 2, 3, 4, 6, 8, 10];
function distanceColor(themeId: string, distance: number, depth: number): string {
  const colors = impactColors(themeById(themeId));
  return distance === 0 ? colors.origin : mixHex(colors.near, colors.far, depth > 1 ? (distance - 1) / (depth - 1) : 0);
}

/** Blast radius of the selection: what depends on it, hop by hop, and what the walk cannot see. */
export function ImpactSection({ node }: { node: NodeSummary }) {
  const store = useStore();
  const impact = useAtlas(state => state.impact);
  const themeId = useAtlas(state => state.themeId);
  const comparing = useAtlas(state => !!state.meta?.comparison);
  if (!impact.open || impact.forId !== node.id) return null;
  const data = impact.data;
  const max = data ? Math.max(1, ...data.byDistance) : 1;
  return (
    <section className="section impact-section" aria-label="Blast radius">
      <h4>Blast radius {data && <span className="chip"><span className="count">{compactNumber(data.total)}</span></span>}</h4>
      <p className="absent" style={{ margin: '0 0 6px' }}>What depends on {node.kind === 'group' || node.childCount > 0 ? 'anything inside ' : ''}<strong>{node.name}</strong> through indexed calls, renders, handlers, routes, HTTP requests and inheritance{node.type === 'file' ? ', plus files importing it' : ''}. Containment is not climbed.</p>
      <div className="impact-controls">
        <label htmlFor="impact-depth" className="absent">Hops</label>
        <select id="impact-depth" className="select small" value={impact.depth} onChange={event => void store.setImpactDepth(Number(event.target.value))}>
          {DEPTHS.map(depth => <option key={depth} value={depth}>{depth}</option>)}
        </select>
        <button className="button small" onClick={() => store.hideImpact()}>Hide</button>
        {data && data.total > 0 && <button className="button small" onClick={() => store.navigator?.fitNodes([node, ...impact.items.slice(0, 200)])}>Fit on map</button>}
      </div>
      {impact.status === 'loading' && !data && <p className="absent">Walking dependents…</p>}
      {impact.status === 'error' && <p className="note error">{impact.error}</p>}
      {data && (
        <>
          {data.total === 0 && <p className="note">Nothing indexed depends on this. That is a lower bound: see what the walk cannot see below.</p>}
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
          {data.byType.length > 1 && (
            <div className="filters" role="group" aria-label="Affected types">
              <button className="chip" aria-pressed={!impact.filter.type} onClick={() => void store.setImpactFilter({ ...impact.filter, type: undefined })}>All</button>
              {data.byType.map(item => <button key={item.type} className="chip" aria-pressed={impact.filter.type === item.type} onClick={() => void store.setImpactFilter({ ...impact.filter, type: impact.filter.type === item.type ? undefined : item.type })}>{typeLabel(item.type)} <span className="count">{item.count}</span></button>)}
            </div>
          )}
          <ul className="list">{impact.items.map(item => <ImpactRow key={item.id} item={item} depth={data.depth} />)}</ul>
          {data.items.hasMore && <button className="button small" onClick={() => store.loadMoreImpact()} disabled={impact.status === 'loading'}>Load more ({impact.items.length} of {data.items.total})</button>}
          {comparing && <p className="absent">Computed on the viewed snapshot; relationships removed since the baseline are not walked.</p>}
        </>
      )}
    </section>
  );
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
  const [open, setOpen] = useState(false);
  const last = item.chain.at(-1);
  return (
    <li className="row impact-row">
      <div className="row-main">
        <div className="row-title">
          <span className="impact-distance" style={{ background: distanceColor(themeId, item.distance, depth) }} title={`${item.distance} hop${item.distance === 1 ? '' : 's'} away`}>{item.distance}</span>
          <TypeBadge type={item.type} role={item.role} />
          <span className="label" title={item.name}>{item.name}</span>
        </div>
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
        <button className="button small" onClick={() => void store.select(item.id, { fly: true })} aria-label={`Go to ${item.name}`}>Go</button>
      </div>
    </li>
  );
}

/** Which call sites in this symbol were linked, left the indexed code, or stayed unresolved. */
export function CallSitesSection({ entity }: { entity: Entity }) {
  const sites = entity.metadata.callSites as CallSites | undefined;
  if (!sites) return null;
  const total = sites.resolved + sites.external + sites.unresolved;
  const names = Object.entries(sites.unresolvedNames ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <section className="section">
      <h4>Call sites <span className="chip"><span className="count">{total}</span></span></h4>
      <div className="callsites-bar" aria-hidden>
        <span className="resolved" style={{ flex: sites.resolved }} /><span className="external" style={{ flex: sites.external }} /><span className="unresolved" style={{ flex: sites.unresolved }} />
      </div>
      <dl className="facts">
        <dt>Linked</dt><dd>{sites.resolved} <span className="absent">· calls, constructions and renders of indexed code (see relationships)</span></dd>
        <dt>External</dt><dd>{sites.external} <span className="absent">· framework, packages and language built-ins</span></dd>
        <dt>Unresolved</dt><dd>{sites.unresolved}{names.length > 0 && <span className="absent"> · {names.slice(0, 8).map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`).join(', ')}</span>}</dd>
      </dl>
      {sites.unresolved > 0 && <p className="absent" style={{ margin: 0 }}>Unresolved sites call callbacks, props or untyped values: what they reach is not drawn and not in any blast radius.</p>}
    </section>
  );
}
const EFFECT_ICON: Record<string, string> = { database: '⛁', response: '↩', network: '⇄', storage: '▤', navigation: '➜', cache: '◷', mail: '✉', queue: '⇶', event: '✦', auth: '⚿', file: '▢', process: '⚙' };
/** What this symbol's own code does outside the indexed code, matched on resolved names. */
export function EffectsSection({ entity }: { entity: Entity }) {
  const store = useStore();
  const effects = entity.metadata.effects as EffectFact[] | undefined;
  if (!effects?.length) return null;
  return (
    <section className="section">
      <h4>Effects <span className="chip"><span className="count">{effects.length}</span></span></h4>
      <ul className="list">
        {effects.map((effect, index) => (
          <li key={index} className="row effect-row">
            <div className="row-main">
              <div className="row-title">
                <span className={`effect-badge ${effect.category}`} aria-hidden>{EFFECT_ICON[effect.category] ?? '•'}</span>
                <span className="label">{effect.category} · {effect.operation}{effect.status ? ` · ${effect.status}` : ''}</span>
              </div>
              <div className="row-sub mono" title={effect.detail}>{effect.detail}</div>
              <div className="row-sub">matched on {effect.via}{effect.line ? ` · line ${effect.line}` : ''}{effect.endpoint ? ` · reaches ${effect.targetName ?? 'an endpoint'}` : effect.targetName ? ` · ${effect.targetName}` : ''}{effect.tableName ? ` · table ${effect.tableName}` : ''}{effect.wrapper ? ' · made for the callers of this wrapper (see their requests)' : ''}</div>
            </div>
            <div className="row-actions">
              {(effect.endpoint ?? effect.target) && <button className="button small" onClick={() => void store.select((effect.endpoint ?? effect.target)!, { fly: true })}>Go</button>}
              {effect.table && <button className="button small" onClick={() => void store.select(effect.table!, { fly: true })}>Table</button>}
              {entity.path && effect.line && <button className="button small" onClick={() => void store.openSource({ entity: entity.id, start: Math.max(1, effect.line - 12), end: effect.line + 12 }, `${effect.category} · ${entity.name}:${effect.line}`)}>Source</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Timeline: what the viewed comparison's changes reach, and a toggle to show it on the map. */
export function CommitImpactChip() {
  const store = useStore();
  const stamp = useAtlas(state => `${state.meta?.snapshot.id ?? ''}|${state.meta?.comparison?.baseline.id ?? ''}|${state.timeline.open ? 'folders' : state.lens}`);
  const comparing = useAtlas(state => !!state.meta?.comparison);
  const commitImpact = useAtlas(state => state.commitImpact);
  useEffect(() => { if (comparing) void store.loadCommitImpact(); }, [store, stamp, comparing]);
  if (!comparing) return null;
  const data = commitImpact.viewStamp === stamp ? commitImpact.data : undefined;
  const loading = commitImpact.status === 'loading';
  const parts = data ? [data.highlights.endpoints ? `${data.highlights.endpoints} endpoint${data.highlights.endpoints === 1 ? '' : 's'}` : '', data.highlights.routes ? `${data.highlights.routes} page${data.highlights.routes === 1 ? '' : 's'}` : ''].filter(Boolean) : [];
  const title = data ? `The ${data.seeds} entities this change modified or removed reach ${data.total} dependent entities within ${data.depth} hops${parts.length ? ` (${parts.join(', ')})` : ''}. Click to ${commitImpact.show ? 'hide it on' : 'show it on'} the map.` : 'Computing what the changes reach…';
  return (
    <button className={`change-stat impact-stat${commitImpact.show ? ' active' : ''}`} aria-pressed={commitImpact.show} onClick={() => store.toggleCommitImpact()} title={title} disabled={!data}>
      reach {loading && !data ? '…' : data ? <>{compactNumber(data.total)}{parts.length ? <span className="absent"> · {parts.join(' · ')}</span> : null}</> : '—'}
    </button>
  );
}
