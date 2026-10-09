'use client';
// One flow in the middle of the screen, in two layouts: a diagram (a request,
// command or task in lanes, left to right; anything else that runs in layers)
// and an outline of its steps, with the conditions on each link. The map, as
// an overview in a corner, lights what the flow touches; "Show on map" plays
// the same flow there.
import { useMemo } from 'react';
import { typeLabel } from '../lib/format';
import { visibleCatalog } from '../lib/catalog';
import { useAtlas, useStore } from './context';
import { LanesBadge, LanesBody, LanesStatus, lanesSubtitle, lanesTitle, useLanesMotion } from './RequestFlows';
import { StepsDiagram, StepsNotes, StepsOutline } from './StepsPanel';

export function FlowView() {
  const store = useStore();
  const view = useAtlas(state => state.flowView);
  const open = useAtlas(state => state.requests.open);
  const steps = useAtlas(state => state.steps);
  const catalog = useAtlas(state => state.catalog);
  const motion = useLanesMotion();
  // Previous / next flow in lanes, in the list as filtered in the Flows panel.
  const order = useMemo(() => catalog.data ? visibleCatalog(catalog.data.items, { tab: catalog.kind, query: catalog.query, status: catalog.filter }).flatMap(group => group.items.filter(item => item.detail === 'lanes').map(item => item.id)) : [], [catalog.data, catalog.kind, catalog.query, catalog.filter]);
  if (!view) return null;
  const lanes = view.lanes && open?.id === view.id ? open : undefined;
  const data = lanes?.data;
  const anchor = steps?.anchor === view.id ? steps.data?.anchor : undefined;
  const title = data ? lanesTitle(data) : anchor?.name ?? view.title;
  const subtitle = data ? lanesSubtitle(data) : anchor ? `${typeLabel(anchor.type, anchor.role)}${anchor.path ? ` · ${anchor.path}` : ''}` : view.subtitle;
  const position = view.lanes ? order.indexOf(view.id) : -1;
  const step = (delta: number) => { const id = order[position + delta]; if (id) void store.openRequestFlow(id); };
  const diagramText = view.lanes ? 'Lanes' : 'Diagram';
  const label = data ? `Request flow ${data.name}` : `What happens from ${anchor?.name ?? view.title}`;
  return (
    <section className="tool-view flow-view" role="region" aria-label={label}>
      <header className="rf-head">
        {view.lanes && (
          <div className="rf-nav">
            <button className="icon-button small" onClick={() => step(-1)} disabled={position <= 0} aria-label="Previous request flow" title="Previous in the Flows list">‹</button>
            <button className="icon-button small" onClick={() => step(1)} disabled={position < 0 || position >= order.length - 1} aria-label="Next request flow" title="Next in the Flows list">›</button>
          </div>
        )}
        {view.lanes ? <LanesBadge data={data} /> : <span className="rf-method m-other" aria-hidden>↧</span>}
        <div className="rf-head-title">
          <h2 className="mono">{title}</h2>
          {subtitle && <span className="rf-head-sub">{subtitle}{position >= 0 ? ` · ${position + 1} of ${order.length}` : ''}</span>}
        </div>
        {data && <LanesStatus data={data} />}
        <div className="segmented" role="group" aria-label="Layout">
          <button aria-pressed={view.layout === 'diagram'} onClick={() => void store.setFlowLayout('diagram')} title={view.lanes ? 'The flow in lanes, left to right: client, call, route, middleware, controller, services, data, response' : 'The steps in layers, top down from where they start'}>{diagramText}</button>
          <button aria-pressed={view.layout === 'outline'} onClick={() => void store.setFlowLayout('outline')} title="The steps as an outline, with the conditions on each link">Outline</button>
        </div>
        <div className="rf-head-actions">
          {view.layout === 'diagram' && lanes && motion && <button className="button small" onClick={() => store.toggleRequestFlowPlaying()} aria-pressed={lanes.playing} disabled={!data}>{lanes.playing ? '❚❚ Pause' : '▶ Play'}</button>}
          <button className="button small primary" onClick={() => store.traceRequestFlow()} title="Play this flow on the map: its areas open and the flow runs through them">Show on map</button>
          <button className="icon-button small" onClick={() => store.closeFlowView()} aria-label="Close this flow">✕</button>
        </div>
      </header>
      {view.layout === 'diagram' && view.lanes ? <LanesBody /> : (
        <div className="flow-steps">
          {steps?.status === 'loading' && !steps.data && <div className="rf-loading big"><span className="rf-spark" />Following calls, handlers and requests…</div>}
          {steps?.status === 'error' && <p className="note error">{steps.error}</p>}
          {steps?.data && steps.anchor === view.id && (view.layout === 'diagram'
            ? <StepsDiagram data={steps.data} />
            : (
              <div className="flow-outline">
                <StepsNotes data={steps.data} />
                <StepsOutline data={steps.data} />
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
