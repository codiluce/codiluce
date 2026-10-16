'use client';
// The middle of the screen: the map, or one of the tools open beside it (a
// flow, a blast radius, a list of the files lit). A flow shares the middle
// between the map, its lanes (or layers) and its outline, any of which can
// have it whole. With another tool in the middle, the map stays as a small
// overview in a corner, showing what the tool lights; tabs switch between
// them, and a click on the overview brings the map back.
import { useState, type CSSProperties } from 'react';
import { useAtlas, useStore } from './context';
import { FilesView, filesTitle } from './FilesView';
import { FlowHead, FlowMapBar, FlowPanes } from './FlowView';
import { ImpactView, impactOriginName } from './ImpactView';
import { MapView } from './MapView';
import { SourcePanel } from './SourcePanel';
import { SplitMap } from './SplitMap';
import { TourStage } from './TourStage';

export function Workbench({ split }: { split: boolean }) {
  const store = useStore();
  const center = useAtlas(state => state.center);
  const flow = useAtlas(state => state.center === 'flow' ? state.flowView : undefined);
  const shares = useAtlas(state => state.flowSplit);
  const reading = center === 'conversations';
  // The map is in the middle on its tab, behind a tour's scenes, and beside a flow's other views (or alone) when a flow is open.
  const mapShown = center === 'map' || center === 'tour' || (!!flow && (!flow.pane || flow.pane === 'map'));
  // Another tool in the middle: the map is an overview in a corner.
  const corner = !mapShown && !flow && !reading;
  const [overview, setOverview] = useState(true);
  const style = flow ? { '--flow-side': `${shares.side}fr`, '--flow-main': `${1 - shares.side}fr`, '--flow-bottom': `${shares.bottom}fr`, '--flow-top': `${1 - shares.bottom}fr` } as CSSProperties : undefined;
  return (
    <section className={`map-area${corner ? ' tool-open' : ''}`}>
      <CenterTabs />
      <div className={`center-body${flow ? ` flow-split${flow.pane ? ` max-${flow.pane}` : ''}` : ''}`} style={style}>
        {flow && <FlowHead />}
        {center === 'impact' && <ImpactView />}
        {center === 'files' && <FilesView />}
        <div className={`map-holder${corner ? ' small' : ''}${reading || (corner && !overview) || (flow && !mapShown) ? ' hidden' : ''}`} aria-hidden={reading || corner || (!!flow && !mapShown) || undefined}>
          {flow && mapShown && <FlowMapBar />}
          {split && center === 'map' ? <SplitMap /> : <MapView />}
          {corner && <button className="overview-open" onClick={() => store.setCenter('map')} aria-label="Back to the map" title="Back to the map" tabIndex={-1} />}
          {corner && <button className="icon-button tiny overview-hide" onClick={() => setOverview(false)} aria-label="Hide the overview map" title="Hide the overview" tabIndex={-1}>–</button>}
        </div>
        {corner && !overview && <button className="button small overview-show" onClick={() => setOverview(true)} title="Show the map as an overview in this corner">Overview map</button>}
        {flow && <FlowPanes />}
        {center === 'tour' && <TourStage />}
      </div>
      <SourcePanel />
    </section>
  );
}
/** One tab per tool open, after the map's; none while only the map is open. */
function CenterTabs() {
  const store = useStore();
  const center = useAtlas(state => state.center);
  const flow = useAtlas(state => state.flowView);
  const lanes = useAtlas(state => state.requests.open && state.requests.open.id === state.flowView?.id ? state.requests.open.data : undefined);
  const impact = useAtlas(state => state.impact.open ? state.impact : undefined);
  const known = useAtlas(() => impact?.forId ? store.scene.nodes.get(impact.forId)?.name : undefined);
  const files = useAtlas(state => state.files);
  const tour = useAtlas(state => state.explain.tour && state.explain.detail?.data?.id === state.explain.tour.id ? state.explain.detail.data.title : undefined);
  if (!flow && !impact && !files && !tour) return null;
  const tab = (view: typeof center, label: string, title: string, close?: { text: string; run: () => void }) => (
    <div className={`center-tab${center === view ? ' current' : ''}`} key={view}>
      <button role="tab" aria-selected={center === view} onClick={() => store.setCenter(view)} title={title}><span className="center-tab-label">{label}</span></button>
      {close && <button className="center-tab-close" onClick={close.run} aria-label={close.text} title={close.text}>✕</button>}
    </div>
  );
  return (
    <div className="center-tabs" role="tablist" aria-label="Map and tools">
      {tab('map', 'Map', 'The map of the repository')}
      {flow && tab('flow', `Flow · ${lanes && flow.lanes ? (lanes.kind === 'command' || lanes.kind === 'schedule' ? lanes.name : `${lanes.method} ${lanes.path}`) : flow.title}`, `${flow.title} on the map, ${flow.lanes ? 'in lanes' : 'in layers'} and as an outline`, { text: 'Close the flow tab', run: () => store.closeFlowView() })}
      {impact && tab('impact', impact.forId ? `Impact · ${impactOriginName(impact.forId, impact.data, known)}` : 'Impact', 'What depends on it, hop by hop', { text: 'Close the impact tab', run: () => store.hideImpact() })}
      {tour && tab('tour', `Tour · ${tour}`, 'The explanation, scene by scene', { text: 'Stop the tour', run: () => store.closeTour() })}
      {files && tab('files', filesTitle(files, files.data), 'The files lit on the map, as a list', { text: 'Close the files tab', run: () => store.closeFiles() })}
    </div>
  );
}
