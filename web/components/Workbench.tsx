'use client';
// The middle of the screen: the map, or one of the tools open beside it (a
// flow, a blast radius, a list of the files lit). With a tool in the middle,
// the map stays as a small overview in a corner, showing what the tool lights;
// tabs switch between them, and a click on the overview brings the map back.
import { useState } from 'react';
import { useAtlas, useStore } from './context';
import { FilesView, filesTitle } from './FilesView';
import { FlowBar } from './FlowBar';
import { FlowView } from './FlowView';
import { ImpactView, impactOriginName } from './ImpactView';
import { MapView } from './MapView';
import { SourcePanel } from './SourcePanel';
import { SplitMap } from './SplitMap';

export function Workbench({ split }: { split: boolean }) {
  const store = useStore();
  const center = useAtlas(state => state.center);
  const small = center !== 'map';
  const [overview, setOverview] = useState(true);
  return (
    <section className={`map-area${small ? ' tool-open' : ''}`}>
      <CenterTabs />
      <div className="center-body">
        {center === 'flow' && <FlowView />}
        {center === 'impact' && <ImpactView />}
        {center === 'files' && <FilesView />}
        <div className={`map-holder${small ? ' small' : ''}${small && !overview ? ' hidden' : ''}`} aria-hidden={small || undefined}>
          {split && !small ? <SplitMap /> : <MapView />}
          {!small && <FlowBar />}
          {small && <button className="overview-open" onClick={() => store.setCenter('map')} aria-label="Back to the map" title="Back to the map" tabIndex={-1} />}
          {small && <button className="icon-button tiny overview-hide" onClick={() => setOverview(false)} aria-label="Hide the overview map" title="Hide the overview" tabIndex={-1}>–</button>}
        </div>
        {small && !overview && <button className="button small overview-show" onClick={() => setOverview(true)} title="Show the map as an overview in this corner">Overview map</button>}
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
  if (!flow && !impact && !files) return null;
  const tab = (view: typeof center, label: string, title: string, close?: { text: string; run: () => void }) => (
    <div className={`center-tab${center === view ? ' current' : ''}`} key={view}>
      <button role="tab" aria-selected={center === view} onClick={() => store.setCenter(view)} title={title}><span className="center-tab-label">{label}</span></button>
      {close && <button className="center-tab-close" onClick={close.run} aria-label={close.text} title={close.text}>✕</button>}
    </div>
  );
  return (
    <div className="center-tabs" role="tablist" aria-label="Map and tools">
      {tab('map', 'Map', 'The map of the repository')}
      {flow && tab('flow', `Flow · ${lanes && flow.lanes ? (lanes.kind === 'command' || lanes.kind === 'schedule' ? lanes.name : `${lanes.method} ${lanes.path}`) : flow.title}`, `${flow.layout === 'outline' ? 'Outline' : flow.lanes ? 'Lanes' : 'Diagram'} of ${flow.title}`, { text: 'Close the flow tab', run: () => store.closeFlowView() })}
      {impact && tab('impact', impact.forId ? `Impact · ${impactOriginName(impact.forId, impact.data, known)}` : 'Impact', 'What depends on it, hop by hop', { text: 'Close the impact tab', run: () => store.hideImpact() })}
      {files && tab('files', filesTitle(files, files.data), 'The files lit on the map, as a list', { text: 'Close the files tab', run: () => store.closeFiles() })}
    </div>
  );
}
