'use client';
import { useState } from 'react';
import type { Dependency, NodeSummary } from '@engine/projection/dto';
import { compactNumber, dependencyLabel, relationPhrase, typeLabel } from '../lib/format';
import { DEPENDENCIES_DRAWN as DRAWN, shownDependencies } from '../lib/store';
import { themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';

const DIRECTION_TEXT = { outgoing: 'Uses', incoming: 'Used by' } as const;

/**
 * Dependencies on (the Dependencies button): what the selection uses and what
 * uses it, one row per file at the other end, first in the inspector. The
 * direction and type filters choose what the map draws too; the pointer on a
 * row puts its rail in front.
 */
export function DependenciesSection({ node }: { node: NodeSummary }) {
  const store = useStore();
  const dependencies = useAtlas(state => state.dependencies);
  const data = dependencies.forId === node.id ? dependencies.data : undefined;
  if (dependencies.forId === node.id && dependencies.status === 'error') return <section className="section dependencies-section"><h4>Dependencies</h4><p className="note error">{dependencies.error}</p></section>;
  if (!data) return <section className="section dependencies-section"><h4>Dependencies</h4><p className="absent">Finding what {node.name} uses and what uses it…</p></section>;
  const inDirection = data.items.filter(item => dependencies.direction === 'both' || item.direction === dependencies.direction);
  const typeTotals = new Map<string, number>();
  for (const item of inDirection) for (const entry of item.types) typeTotals.set(entry.type, (typeTotals.get(entry.type) ?? 0) + entry.count);
  const shown = shownDependencies(dependencies);
  const count = (direction: Dependency['direction']) => data.items.filter(item => item.direction === direction).length;
  const groups = (['outgoing', 'incoming'] as const).map(direction => ({ direction, items: shown.filter(item => item.direction === direction) })).filter(group => group.items.length);
  return (
    <section className="section dependencies-section" aria-label="Dependencies">
      <h4>Dependencies <span className="chip"><span className="count">{data.items.length}{data.truncated ? '+' : ''}</span></span></h4>
      {data.items.length === 0
        ? <p className="note">Nothing indexed crosses its boundary. Only calls the analyzers could resolve are relationships: calls through callbacks, props or untyped values are counted under call sites instead, so this is not evidence that nothing is connected.</p>
        : <p className="absent dependencies-summary">{compactNumber(data.total)} relationship{data.total === 1 ? '' : 's'} with {data.items.length}{data.truncated ? '+' : ''} files, endpoints and tables, drawn on the map as rails to each.</p>}
      {data.items.length > 0 && (
        <>
          <div className="segmented" role="group" aria-label="Direction">
            {(['both', 'outgoing', 'incoming'] as const).map(direction => (
              <button key={direction} aria-pressed={dependencies.direction === direction} onClick={() => store.setDependencyFilter({ direction })}>
                {direction === 'both' ? 'Both' : direction === 'outgoing' ? `Uses → ${count('outgoing')}` : `← Used by ${count('incoming')}`}
              </button>
            ))}
          </div>
          {typeTotals.size > 1 && (
            <div className="filters" role="group" aria-label="Relationship types">
              <button className="chip" aria-pressed={!dependencies.type} onClick={() => store.setDependencyFilter({ type: null })}>All</button>
              {[...typeTotals].sort((a, b) => b[1] - a[1]).map(([type, total]) => (
                <button key={type} className="chip" aria-pressed={dependencies.type === type} onClick={() => store.setDependencyFilter({ type: dependencies.type === type ? null : type })}>
                  <TypeLine type={type} />{type.replace(/_/g, ' ')} <span className="count">{compactNumber(total)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="row-actions dependencies-actions">
            <button className="button small" onClick={() => store.navigator?.fitNodes([node, ...shown.slice(0, DRAWN).map(item => item.end)])}>Fit on the map</button>
            <button className="button small" onClick={() => store.openFocus({ kind: 'selection', id: node.id, title: node.name })} title="Them at their places on the map, with the links as arrows (in the middle of the screen)">Focus on them</button>
          </div>
          {shown.length > DRAWN && <p className="absent">The map draws the {DRAWN} most connected; all {shown.length} are listed.</p>}
          {groups.map(group => (
            <div key={group.direction} className="dependencies-group">
              <div className="direction">{group.direction === 'outgoing' ? `${DIRECTION_TEXT.outgoing} → what ${node.name} depends on` : `← ${DIRECTION_TEXT.incoming}: what depends on ${node.name}`} <span className="count">{group.items.length}</span></div>
              <ul className="list" onMouseLeave={() => store.hoverDependency(undefined)}>
                {group.items.map(item => <DependencyRow key={`${item.direction}${item.end.id}`} item={item} filter={dependencies.type} hovered={dependencies.hover === item.end.id} />)}
              </ul>
            </div>
          ))}
          {data.truncated && <p className="absent">Showing the most connected dependencies.</p>}
        </>
      )}
    </section>
  );
}
function TypeLine({ type }: { type: string }) {
  const theme = themeById(useAtlas(state => state.themeId));
  return <span className="line" style={{ width: 10, height: 3, borderRadius: 2, background: theme.relation[type] ?? theme.fallbackRelation }} />;
}
function DependencyRow({ item, filter, hovered }: { item: Dependency; filter?: string; hovered: boolean }) {
  const store = useStore();
  const theme = themeById(useAtlas(state => state.themeId));
  const [open, setOpen] = useState(false);
  const types = filter ? item.types.filter(entry => entry.type === filter) : item.types;
  const color = theme.relation[types[0]?.type ?? ''] ?? theme.fallbackRelation;
  const links = filter ? item.links.filter(link => link.type === filter) : item.links;
  const total = types.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <li className={`row dependency-row${hovered ? ' emphasized' : ''}`} onMouseEnter={() => store.hoverDependency(item.end.id)} onFocus={() => store.hoverDependency(item.end.id)}>
      <div className="row-main">
        <div className="row-title">
          <span className="relation-phrase" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }} title={item.direction === 'outgoing' ? 'What the selection does with it' : 'What it does with the selection'}>{dependencyLabel(types, item.direction)}</span>
          <span className="label" title={item.end.path ?? item.end.name}>{item.end.name}</span>
        </div>
        <div className="row-sub">{typeLabel(item.end.type, item.end.role)}{item.end.path ? ` · ${item.end.path}` : ''}</div>
        {open && (
          <ul className="list dependency-links">
            {links.map(link => (
              <li key={link.id} className="row">
                <div className="row-main"><div className="row-title"><span className="label" title={`${link.from.name} ${relationPhrase(link.type, 'outgoing')} ${link.to.name}`}>{link.from.name} → {link.to.name}</span></div><div className="row-sub">{relationPhrase(link.type, 'outgoing')}{link.change === 'added' ? ' · added' : ''}</div></div>
                <div className="row-actions"><button className="button small" onClick={() => void store.openEvidence(link.id, { from: link.from.name, to: link.to.name, type: link.type })} aria-label={`Why is ${link.from.name} connected to ${link.to.name}?`}>Why?</button></div>
              </li>
            ))}
            {total > links.length && <li className="absent">and {total - links.length} more</li>}
          </ul>
        )}
      </div>
      <div className="row-actions">
        <button className="button small" onClick={() => setOpen(value => !value)} aria-expanded={open} title="The relationships behind it, each with its evidence">{open ? 'Hide' : 'Why?'}</button>
        <button className="button small" onClick={() => void store.select(item.end.id, { fly: true })} aria-label={`Go to ${item.end.name}`}>Go</button>
      </div>
    </li>
  );
}
