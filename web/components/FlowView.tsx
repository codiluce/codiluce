'use client';
// One flow in the middle of the screen, in three views side by side: the map
// (what the flow touches stays lit, its links streaming), a diagram (a
// request, command or task in lanes, left to right; anything else that runs
// in layers) and an outline of its steps, with the conditions on each link.
// The lanes run wide, so they take the band along the bottom; the outline runs
// long, so it takes a column beside the map. Each view can have the whole
// middle, and the bars between them move.
import { useMemo, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { typeLabel } from '../lib/format';
import { visibleCatalog } from '../lib/catalog';
import { groupBranches, type MapBranch, type MapStop } from '../lib/map-flow';
import type { FlowPane, FlowSplit } from '../lib/store';
import { useAtlas, useStore } from './context';
import { LanesBadge, LanesBody, LanesStatus, lanesSubtitle, lanesTitle, StagePips } from './RequestFlows';
import { StepsDiagram, StepsNotes, StepsOutline } from './StepsPanel';
import { PageSteps } from './PageSteps';
import { ExplainActions, ExplanationChips } from './ExplainActions';
import { hrefForNode } from '@engine/explanations/links';

/** What the open flow is called, and what it is about: from its lanes or steps once loaded. */
function useFlowTitle(): { title: string; subtitle?: string } | undefined {
  const view = useAtlas(state => state.flowView);
  const data = useAtlas(state => state.flowView?.lanes && state.requests.open?.id === state.flowView.id ? state.requests.open.data : undefined);
  const anchor = useAtlas(state => state.steps && state.steps.anchor === state.flowView?.id ? state.steps.data?.anchor : undefined);
  if (!view) return undefined;
  if (data) return { title: lanesTitle(data), subtitle: lanesSubtitle(data) };
  if (anchor && !view.lanes) return { title: anchor.name, subtitle: `${typeLabel(anchor.type, anchor.role)}${anchor.path ? ` · ${anchor.path}` : ''}` };
  return { title: view.title, ...(view.subtitle ? { subtitle: view.subtitle } : {}) };
}

/** The flow's heading, across the middle: where it is in the Flows list, what it is, and which views share the middle. */
export function FlowHead() {
  const store = useStore();
  const view = useAtlas(state => state.flowView);
  const data = useAtlas(state => state.flowView?.lanes && state.requests.open?.id === state.flowView.id ? state.requests.open.data : undefined);
  const catalog = useAtlas(state => state.catalog);
  const named = useFlowTitle();
  const steps = useAtlas(state => state.steps);
  const explanations = useAtlas(state => state.explain.list.data);
  const about = useMemo(() => explanations?.items.filter(item => item.subject.target === view?.id) ?? [], [explanations, view?.id]);
  const anchor = data?.anchor ?? (steps?.anchor === view?.id ? steps?.data?.anchor : undefined);
  const ref = anchor ? hrefForNode(anchor) : undefined;
  const entry = !!anchor && ['route', 'api_endpoint', 'command', 'scheduled_task'].includes(anchor.type);
  const suggestions = ref && anchor ? [{ target: { kind: entry ? 'flow' as const : 'entity' as const, ref, label: anchor.name, type: anchor.type }, text: entry ? 'Explain this flow' : `Explain ${anchor.name}`, title: 'Explain what this code sets in motion' }] : [];
  // Previous / next flow, in the list as filtered in the Flows panel.
  const order = useMemo(() => catalog.data ? visibleCatalog(catalog.data.items, { tab: catalog.kind, query: catalog.query, status: catalog.filter }).flatMap(group => group.items) : [], [catalog.data, catalog.kind, catalog.query, catalog.filter]);
  if (!view || !named) return null;
  const position = order.findIndex(item => item.id === view.id && (item.detail === 'lanes') === view.lanes);
  const step = (delta: number) => { const item = order[position + delta]; if (item) void store.openCatalogFlow(item); };
  const diagram = view.lanes ? 'Lanes' : 'Diagram';
  const panes: { pane?: FlowPane; text: string; title: string }[] = [
    { text: 'Split', title: 'The map, the diagram and the outline side by side' },
    { pane: 'map', text: 'Map', title: 'The map alone, with the flow on it' },
    { pane: 'diagram', text: diagram, title: view.lanes ? 'The lanes alone: client, call, route, middleware, controller, services, data, response' : 'The steps in layers alone, top down from where they start' },
    { pane: 'outline', text: 'Outline', title: 'The outline of steps alone, with the conditions on each link' },
  ];
  return (
    <header className="rf-head flow-head" aria-label={`Flow ${named.title}`}>
      {order.length > 0 && (
        <div className="rf-nav">
          <button className="icon-button small" onClick={() => step(-1)} disabled={position <= 0} aria-label="Previous flow" title="Previous in the Flows list">‹</button>
          <button className="icon-button small" onClick={() => step(1)} disabled={position < 0 || position >= order.length - 1} aria-label="Next flow" title="Next in the Flows list">›</button>
        </div>
      )}
      {view.lanes ? <LanesBadge data={data} /> : <span className="rf-method m-other" aria-hidden>↧</span>}
      <div className="rf-head-title">
        <h2 className="mono">{named.title}</h2>
        {named.subtitle && <span className="rf-head-sub">{named.subtitle}{position >= 0 ? ` · ${position + 1} of ${order.length}` : ''}</span>}
      </div>
      {data && <LanesStatus data={data} />}
      <ExplanationChips items={about} label="Explanations of this flow" />
      <div className="segmented flow-panes-switch" role="group" aria-label="Views">
        {panes.map(item => <button key={item.text} aria-pressed={view.pane === item.pane} onClick={() => store.setFlowPane(item.pane)} title={item.title}>{item.text}</button>)}
      </div>
      <div className="rf-head-actions">
        <ExplainActions suggestions={suggestions} compact />
        <button className="icon-button small" onClick={() => store.closeFlowView()} aria-label="Close this flow">✕</button>
      </div>
    </header>
  );
}

/** Give a view of the flow the whole middle, or put it back beside the others. */
function PaneToggle({ pane, name }: { pane: FlowPane; name: string }) {
  const store = useStore();
  const full = useAtlas(state => state.flowView?.pane === pane);
  return (
    <button className="icon-button tiny flow-pane-toggle" onClick={() => store.setFlowPane(full ? undefined : pane)} aria-pressed={full} aria-label={full ? `Put the ${name} back beside the other views` : `Give the ${name} the whole middle`} title={full ? 'Back beside the other views' : 'Full size: the whole middle'}>
      {full ? '⤡' : '⤢'}
    </button>
  );
}
function PaneHead({ pane, title, children }: { pane: FlowPane; title: string; children?: ReactNode }) {
  return (
    <div className="flow-pane-head">
      <span className="flow-pane-title">{title}</span>
      {children}
      <PaneToggle pane={pane} name={title.toLowerCase()} />
    </div>
  );
}

/**
 * The flow on the map, over the map's view: the branches it offers, grouped
 * where the choice is made (all of them, or one on its own), and a fit.
 */
export function FlowMapBar() {
  const store = useStore();
  const tour = useAtlas(state => state.tour);
  const title = useAtlas(state => state.flowView?.title);
  const groups = useMemo(() => groupBranches(tour?.flow?.branches ?? []), [tour?.flow]);
  const flow = tour?.flow;
  const branches = flow?.branches ?? [];
  const gaps = flow?.pins.filter(pin => pin.kind === 'gap').length ?? 0;
  const summary = !tour || tour.status === 'loading' && !flow ? 'opening on the map…' : tour.status === 'error' ? tour.error : [`${flow?.stops.length ?? 0} stops`, branches.length > 1 ? `${branches.length} branches` : '', gaps ? `${gaps} gap${gaps === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="flow-pane-head flow-map-bar" role="region" aria-label={`Flow on the map: ${title ?? ''}`}>
      <span className="flow-pane-title">Map</span>
      <span className="absent flow-map-summary">{summary}</span>
      {branches.length > 1 && (
        <div className="flow-branches" role="group" aria-label="Branches">
          <button className={`flow-branch all${tour?.branch === undefined ? ' current' : ''}`} aria-pressed={tour?.branch === undefined} onClick={() => store.setTourBranch(undefined)} title="Every branch of the flow at once">All</button>
          {groups.map(group => (
            <div key={group.label} className="flow-branch-group" role="group" aria-label={group.title}>
              <span className="flow-branch-group-label" title={group.title}>{group.label}</span>
              {group.items.map(({ branch, index }) => <BranchButton key={branch.key} branch={branch} index={index} current={index === tour?.branch} stops={flow!.stops} />)}
            </div>
          ))}
        </div>
      )}
      <button className="button tiny" onClick={() => store.fitTour()} disabled={!flow?.stops.length} title="Fit the flow (or the branch shown) on the map">Fit</button>
      <PaneToggle pane="map" name="map" />
    </div>
  );
}
function BranchButton({ branch, index, current, stops }: { branch: MapBranch; index: number; current: boolean; stops: MapStop[] }) {
  const store = useStore();
  const head = stops[branch.head]!;
  const reach = branch.waves.flat().length - (branch.waves[0]?.includes(branch.head) ? 1 : 2);
  return (
    <button className={`flow-branch t-${head.tone}${current ? ' current' : ''}`} aria-pressed={current} onClick={() => store.setTourBranch(current ? undefined : index)}
      title={[`${branch.event ? `${branch.event} → ` : ''}${head.label}`, head.node?.path, reach > 0 ? `then ${reach} more stop${reach === 1 ? '' : 's'}` : 'nothing indexed follows', current ? 'Click again for every branch' : 'Only this branch on the map'].filter(Boolean).join('\n')} style={{ '--tone': `var(--tone-${head.tone})` } as CSSProperties}>
      {branch.event && <span className="flow-branch-event">{branch.event}</span>}
      <span className="flow-branch-label">{head.label}</span>
      {reach > 0 ? <span className="flow-branch-reach">+{reach}</span> : null}
    </button>
  );
}

/** The flow's diagram and outline, and the bars between the views (the map is the workbench's). */
export function FlowPanes() {
  return (
    <>
      <SplitBar axis="side" />
      <OutlinePane />
      <SplitBar axis="bottom" />
      <DiagramPane />
    </>
  );
}
function DiagramPane() {
  const view = useAtlas(state => state.flowView);
  const data = useAtlas(state => state.flowView?.lanes && state.requests.open?.id === state.flowView.id ? state.requests.open.data : undefined);
  const steps = useAtlas(state => state.steps);
  const named = useFlowTitle();
  if (!view) return null;
  if (view.lanes) return (
    <section className="flow-pane flow-pane-diagram" role="region" aria-label={data ? `Request flow ${data.name}` : 'Lanes'}>
      <PaneHead pane="diagram" title="Lanes">{data && <StagePips stages={data.stages} labels />}</PaneHead>
      <LanesBody />
    </section>
  );
  return (
    <section className="flow-pane flow-pane-diagram" role="region" aria-label={`Diagram of ${named?.title ?? view.title}`}>
      <PaneHead pane="diagram" title="Diagram" />
      <div className="flow-pane-body">
        <StepsState />
        {steps?.data && steps.anchor === view.id && (steps.data.anchor.type === 'route' ? <PageSteps key={steps.anchor} data={steps.data} layout="diagram" /> : <StepsDiagram data={steps.data} />)}
      </div>
    </section>
  );
}
function OutlinePane() {
  const view = useAtlas(state => state.flowView);
  const steps = useAtlas(state => state.steps);
  const named = useFlowTitle();
  if (!view) return null;
  return (
    <section className="flow-pane flow-pane-outline" role="region" aria-label={`Outline of ${named?.title ?? view.title}`}>
      <PaneHead pane="outline" title="Outline" />
      <div className="flow-pane-body flow-outline">
        <StepsState />
        {steps?.data && steps.anchor === view.id && (steps.data.anchor.type === 'route' ? <PageSteps key={steps.anchor} data={steps.data} layout="outline" /> : <><StepsNotes data={steps.data} /><StepsOutline data={steps.data} /></>)}
      </div>
    </section>
  );
}
function StepsState() {
  const steps = useAtlas(state => state.steps);
  if (steps?.status === 'loading' && !steps.data) return <div className="rf-loading big"><span className="rf-spark" />Following calls, handlers and requests…</div>;
  if (steps?.status === 'error') return <p className="note error">{steps.error}</p>;
  return null;
}

/**
 * The bar between the map and the outline (`side`), or between them and the
 * lanes (`bottom`): drag it, or use the arrow keys. The share is kept in the
 * preferences once the drag ends.
 */
function SplitBar({ axis }: { axis: keyof FlowSplit }) {
  const store = useStore();
  const share = useAtlas(state => state.flowSplit[axis]);
  const drag = useRef<{ body: HTMLElement; value: number } | null>(null);
  const shareAt = (body: HTMLElement, event: PointerEvent) => {
    const box = body.getBoundingClientRect();
    if (axis === 'side') return (box.right - event.clientX) / Math.max(1, box.width);
    const head = body.querySelector('.flow-head')?.getBoundingClientRect().height ?? 0;
    return (box.bottom - event.clientY) / Math.max(1, box.height - head);
  };
  const apply = (body: HTMLElement, value: number) => {
    const clamped = axis === 'side' ? Math.min(0.6, Math.max(0.16, value)) : Math.min(0.76, Math.max(0.16, value));
    body.style.setProperty(axis === 'side' ? '--flow-side' : '--flow-bottom', `${clamped}fr`);
    body.style.setProperty(axis === 'side' ? '--flow-main' : '--flow-top', `${1 - clamped}fr`);
    return clamped;
  };
  const onKey = (event: KeyboardEvent) => {
    const keys: Record<string, number> = axis === 'side' ? { ArrowLeft: 0.03, ArrowRight: -0.03 } : { ArrowUp: 0.03, ArrowDown: -0.03 };
    const delta = keys[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    store.setFlowSplit({ [axis]: share + delta });
  };
  const name = axis === 'side' ? 'the outline beside the map' : 'the lanes below the map';
  return (
    <div className={`flow-split-bar ${axis}`} role="separator" tabIndex={0} aria-orientation={axis === 'side' ? 'vertical' : 'horizontal'} aria-label={`Resize ${name}`} title={`Drag to resize ${name}`}
      aria-valuenow={Math.round(share * 100)} aria-valuemin={16} aria-valuemax={axis === 'side' ? 60 : 76} onKeyDown={onKey}
      onPointerDown={event => { const body = event.currentTarget.parentElement; if (!body) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { body, value: share }; }}
      onPointerMove={event => { const current = drag.current; if (current) current.value = apply(current.body, shareAt(current.body, event)); }}
      onPointerUp={() => { const current = drag.current; drag.current = null; if (current) store.setFlowSplit({ [axis]: current.value }); }}
      onPointerCancel={() => { drag.current = null; }} />
  );
}
