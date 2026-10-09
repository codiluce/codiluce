'use client';
// The flow on the map, as a player. A flow plays branch by branch: each
// choice it offers (an event a page binds, an action it runs on load, a
// caller of an endpoint), from where the flow starts along real edges. The
// bar lists the branches, grouped where the choice is made, and the current
// branch in waves: the stops in one wave are reached at the same moment
// (alternatives, or work done side by side). The lanes (schematic) and Steps
// (outline) are one click away.
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { KIND_TEXT } from '../lib/catalog';
import { branchPosition, groupBranches, type MapBranch, type MapStop } from '../lib/map-flow';
import { useAtlas, useStore } from './context';

export function FlowBar() {
  const store = useStore();
  const tour = useAtlas(state => state.tour);
  const groups = useMemo(() => groupBranches(tour?.flow?.branches ?? []), [tour?.flow]);
  // Keep the branch being played in view in the list.
  const list = useRef<HTMLDivElement>(null);
  const index = tour?.playback.index;
  useEffect(() => { list.current?.querySelector('.flow-branch.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [index, tour?.flow]);
  if (!tour) return null;
  const { flow, playback, status } = tour;
  const branches = flow?.branches ?? [];
  const branch = branches[playback.index];
  const playing = playback.status === 'playing';
  const pins = flow?.pins ?? [];
  const gaps = pins.filter(pin => pin.kind === 'gap').length;
  const summary = status === 'loading' ? 'opening on the map…' : status === 'error' ? tour.error : [tour.subtitle, `${flow?.stops.length ?? 0} stops`, branches.length > 1 ? `${branches.length} branches` : '', gaps ? `${gaps} gap${gaps === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="flow-bar" role="region" aria-label={`Flow on the map: ${tour.title}`}>
      <div className="flow-bar-head">
        <span className="flow-bar-badge">{tour.kind ? KIND_TEXT[tour.kind] : tour.detail === 'steps' ? 'Steps' : 'Flow'}</span>
        <div className="flow-bar-title">
          <strong className="mono" title={tour.title}>{tour.title}</strong>
          <span className="absent">{summary}</span>
        </div>
        <div className="flow-bar-controls" role="group" aria-label="Playback">
          <button className="icon-button small" onClick={() => store.tourAction({ type: 'restart' })} aria-label="From the first branch" title="From the first branch" disabled={!branches.length}>⏮</button>
          <button className="icon-button small" onClick={() => store.tourAction({ type: 'previous' })} aria-label="Previous branch" title="Previous branch" disabled={!branches.length}>◀</button>
          {playing
            ? <button className="button small primary" onClick={() => store.tourAction({ type: 'pause' })} aria-label="Pause">❚❚</button>
            : <button className="button small primary" onClick={() => store.tourAction({ type: 'play' })} aria-label="Play" disabled={!playback.playable.length}>▶</button>}
          <button className="icon-button small" onClick={() => store.tourAction({ type: 'next' })} aria-label="Next branch" title="Next branch" disabled={!branches.length}>▶</button>
          {branches.length > 0 && <span className="flow-bar-position" aria-live="polite">{playback.status === 'finished' ? 'end' : `${playback.index + 1}/${branches.length}`}<span className="sr-only">{playback.status === 'finished' ? 'Finished' : `Branch ${playback.index + 1} of ${branches.length}`}</span></span>}
        </div>
        <div className="flow-bar-actions">
          <label className="toggle" title="While playing, the camera frames each branch as it starts"><input type="checkbox" checked={tour.follow} onChange={event => store.setTourFollow(event.target.checked)} /> Follow</label>
          <button className="button small" onClick={() => store.fitTour()} disabled={!flow?.stops.length} title="Fit the whole flow on the map">Fit</button>
          {tour.detail === 'lanes' && <button className="button small" onClick={() => void store.openRequestFlow(tour.id)} title="The same flow as a diagram in lanes, left to right">Lanes</button>}
          {tour.detail === 'steps' && <button className="button small" onClick={() => void store.openSteps(tour.id)} title="The same flow as an outline of steps, with conditions">Outline</button>}
          <button className="icon-button small" onClick={() => store.closeTour()} aria-label="Stop showing this flow on the map">✕</button>
        </div>
      </div>
      {branches.length > 1 && (
        <div className="flow-branches" role="group" aria-label="Branches" ref={list}>
          {groups.map(group => (
            <div key={group.label} className="flow-branch-group" role="group" aria-label={group.title}>
              <span className="flow-branch-group-label" title={group.title}>{group.label}</span>
              {group.items.map(({ branch: item, index }) => (
                <BranchButton key={item.key} branch={item} index={index} current={index === playback.index} stops={flow!.stops} />
              ))}
            </div>
          ))}
        </div>
      )}
      {flow && branch && <Waves branch={branch} stops={flow.stops} />}
    </div>
  );
}
function BranchButton({ branch, index, current, stops }: { branch: MapBranch; index: number; current: boolean; stops: MapStop[] }) {
  const store = useStore();
  const head = stops[branch.head]!;
  const reach = branch.waves.flat().length - (branch.waves[0]?.includes(branch.head) ? 1 : 2);
  return (
    <button className={`flow-branch t-${head.tone}${current ? ' current' : ''}`} aria-current={current ? 'step' : undefined} onClick={() => store.tourAction({ type: 'seek', index })}
      title={[`${branch.event ? `${branch.event} → ` : ''}${head.label}`, head.node?.path, reach > 0 ? `then ${reach} more stop${reach === 1 ? '' : 's'}` : 'nothing indexed follows'].filter(Boolean).join('\n')} style={{ '--tone': `var(--tone-${head.tone})` } as CSSProperties}>
      {branch.event && <span className="flow-branch-event">{branch.event}</span>}
      <span className="flow-branch-label">{head.label}</span>
      {reach > 0 ? <span className="flow-branch-reach">+{reach}</span> : null}
    </button>
  );
}
/** The current branch in waves: what is reached together, one edge further each time. */
function Waves({ branch, stops }: { branch: MapBranch; stops: MapStop[] }) {
  const store = useStore();
  const playback = useAtlas(state => state.tour!.playback);
  const { position, front } = branchPosition(branch, playback);
  const backWave = branch.links.some(link => link.wave >= branch.waves.length);
  return (
    <ol className="flow-waves" aria-label="This branch, wave by wave">
      {branch.waves.map((wave, depth) => (
        <li key={depth} className={`flow-wave${depth === front ? ' current' : ''}${depth <= position ? ' reached' : ''}`}>
          <span className="flow-wave-number" title={wave.length > 1 ? `${wave.length} stops reached at the same moment` : undefined}>{depth + 1}</span>
          <div className="flow-wave-stops">
            {wave.map(index => {
              const stop = stops[index]!;
              return (
                <button key={stop.key} className={`flow-stop t-${stop.tone}${depth === front ? ' current' : ''}`} aria-current={depth === front ? 'step' : undefined}
                  onClick={() => store.focusTourStop(index)} title={[stop.label, stop.detail, stop.node?.path].filter(Boolean).join('\n')} style={{ '--tone': `var(--tone-${stop.tone})` } as CSSProperties}>
                  <span className="flow-stop-label">{stop.label}</span>
                </button>
              );
            })}
          </div>
        </li>
      ))}
      {backWave && <li className={`flow-wave back${position >= branch.waves.length ? ' reached current' : ''}`}><span className="flow-wave-number" title="The response goes back to the caller">↩</span><div className="flow-wave-stops"><span className="absent">back to the caller</span></div></li>}
    </ol>
  );
}
