'use client';
// Inspector sections for call resolution and effects, and the timeline's
// commit-impact chip. Results come from /api/history/impact and the
// `callSites` / `effects` metadata the analyzers record on symbols. The blast
// radius of an entity has its own view (ImpactView).
import { useEffect } from 'react';
import type { CallSites, EffectFact, Entity } from '@engine/core/graph';
import { compactNumber } from '../lib/format';
import { useAtlas, useStore } from './context';

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
  const stamp = useAtlas(() => store.viewStamp());
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
