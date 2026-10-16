'use client';
// An explanation's tour on stage, in the middle: one scene at a time. A map
// scene frames its code on the map and numbers it; a diagram scene frames it
// first, then its boxes rise off their blocks into a diagram while the map
// dims behind; the next diagram slides the boxes they share, and a map scene
// sinks them back. The text stays in the Explanations column, in step. The
// bar at the bottom steps through the scenes (← and → too).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedLink, ResolvedScene, SceneBox } from '@engine/explanations/model';
import { sceneOnStage } from '../lib/controller';
import { typeLabel } from '../lib/format';
import { framingNodes, originsOnMap, prefersReducedMotion, type MorphItem, type ScreenRect } from '../lib/map-morph';
import { CodeDiagram, type DiagramArrow, type DiagramBox } from './CodeDiagram';
import { useAtlas, useStore } from './context';

/** How long the camera gets to frame a scene before its boxes rise. */
const FRAME_MS = 1100;
const SINK_MS = 760;

export function TourStage() {
  const store = useStore();
  const scene = useAtlas(sceneOnStage);
  const tour = useAtlas(state => state.explain.tour);
  const count = useAtlas(state => state.explain.detail?.data?.tour?.scenes.length ?? 0);
  const title = useAtlas(state => state.explain.detail?.data?.title);
  const [diagram, setDiagram] = useState<{ scene: ResolvedScene; origins: ReadonlyMap<string, ScreenRect>; leaving?: boolean; entry: number }>();
  const current = useRef(diagram);
  current.current = diagram;
  const entries = useRef(0);
  const [peek, setPeek] = useState(false);
  const nextButton = useRef<HTMLButtonElement>(null);
  // A tour that starts takes the keyboard (← and →), unless something is being typed.
  const tourId = tour?.id;
  useEffect(() => {
    if (!tourId) return;
    const active = document.activeElement;
    if (!active || active === document.body || (active instanceof HTMLTextAreaElement && !active.value.trim())) nextButton.current?.focus({ preventScroll: true });
  }, [tourId]);

  useEffect(() => {
    if (!scene) return;
    const reduced = prefersReducedMotion();
    const items = morphItems(scene);
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, run: () => void) => timers.push(setTimeout(() => { if (!cancelled) run(); }, reduced ? 0 : ms));
    const frame = async () => {
      await store.placeOnMap(items.flatMap(item => item.id ? [item.id] : []));
      if (cancelled) return;
      const nodes = framingNodes(store.scene.nodes, items);
      if (nodes.length) store.navigator?.fitNodes(nodes);
    };
    const shown = current.current;
    if (scene.view === 'diagram') {
      if (shown && !shown.leaving) setDiagram({ scene, origins: reduced ? new Map() : originsOnMap(store.navigator, items), entry: shown.entry });
      else void frame().then(() => later(FRAME_MS, () => setDiagram({ scene, origins: reduced ? new Map() : originsOnMap(store.navigator, items), entry: ++entries.current })));
    } else if (shown && !shown.leaving) {
      // Back to the map: the boxes sink to where their blocks are, then the camera frames this scene.
      setDiagram({ ...shown, leaving: true, origins: reduced ? new Map() : originsOnMap(store.navigator, morphItems(shown.scene)) });
      later(SINK_MS, () => void frame());
    } else void frame();
    return () => { cancelled = true; for (const timer of timers) clearTimeout(timer); };
  }, [scene, store]);

  // Leaving the stage: nothing stays lit by a box the pointer left.
  useEffect(() => () => store.hoverLink(undefined), [store]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey || target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); store.stepScene(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); store.stepScene(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const shown = diagram?.scene;
  const model = useMemo(() => shown ? diagramOf(shown) : undefined, [shown]);
  const linkOf = useCallback((id: string | undefined) => id ? shown?.boxes.find(box => box.key === id)?.link : undefined, [shown]);
  const onLeft = useCallback(() => setDiagram(value => value?.leaving ? undefined : value), []);
  if (!tour || !scene) return null;
  return (
    <div className={`tour-stage${diagram && !diagram.leaving ? ' with-diagram' : ''}`}>
      <div className={`tour-backdrop${diagram && !diagram.leaving ? ' on' : ''}${peek ? ' peek' : ''}`} aria-hidden="true" />
      {diagram && model && (
        <CodeDiagram key={diagram.entry} boxes={model.boxes} arrows={model.arrows} {...(shown?.start ? { start: shown.start } : {})} origins={diagram.origins} leaving={!!diagram.leaving} onLeft={onLeft}
          groupLabel={group => `${group}/`} label={shown!.title}
          onHover={id => { const link = linkOf(id); setPeek(!!link); store.hoverLink(link); }}
          onSelect={id => { const link = linkOf(id); if (link) void store.openFromTour(link); }} />
      )}
      {scene.view === 'flow' && <FlowCard scene={scene} />}
      <div className="tour-bar" role="toolbar" aria-label="Tour">
        <button className="icon-button small" onClick={() => store.stepScene(-1)} disabled={tour.scene === 0} aria-label="Previous scene" title="Previous scene (←)">‹</button>
        <div className="tour-where">
          <span className="tour-count">{tour.scene + 1} / {count}</span>
          <span className="tour-title" title={title}>{scene.title}</span>
        </div>
        <div className="tour-pips" role="tablist" aria-label="Scenes">
          {Array.from({ length: count }, (_, index) => <button key={index} role="tab" aria-selected={index === tour.scene} className={`tour-pip${index === tour.scene ? ' current' : ''}`} onClick={() => store.showScene(index)} aria-label={`Scene ${index + 1}`} title={`Scene ${index + 1}`} />)}
        </div>
        <button ref={nextButton} className="icon-button small" onClick={() => store.stepScene(1)} disabled={tour.scene >= count - 1} aria-label="Next scene" title="Next scene (→)">›</button>
        <button className="icon-button tiny tour-stop" onClick={() => store.closeTour()} aria-label="Stop the tour" title="Stop the tour">✕</button>
      </div>
    </div>
  );
}

/** A flow scene, until the flow view plays in the stage: what it follows, and a way to open it. */
function FlowCard({ scene }: { scene: ResolvedScene }) {
  const store = useStore();
  const flow = scene.flow;
  if (!flow) return null;
  return (
    <div className="tour-flow-card">
      <span className="cd-kind">Flow</span>
      <strong>{flow.label ?? flow.name ?? flow.href}</strong>
      {flow.status !== 'missing' && <button className="button tiny" onClick={() => void store.followLink(flow)}>Open the flow</button>}
    </div>
  );
}

function morphItems(scene: ResolvedScene): MorphItem[] {
  return scene.boxes.map(box => ({ key: box.key, ...(box.link.id ? { id: box.link.id } : {}), ...(box.link.ancestors ? { ancestors: box.link.ancestors } : {}) }));
}

/** A scene as boxes and arrows: symbols inside their file's box, evidence as chips. */
export function diagramOf(scene: ResolvedScene): { boxes: DiagramBox[]; arrows: DiagramArrow[] } {
  const part = (box: SceneBox) => ({ id: box.key, title: nameOf(box.link), kind: kindOf(box.link), ...(box.caption ? { caption: box.caption } : {}), ...stateOf(box.link) });
  const boxes: DiagramBox[] = scene.boxes.filter(box => !box.parent).map(box => {
    const parts = scene.boxes.filter(item => item.parent === box.key).map(part);
    const subtitle = subtitleOf(box.link);
    return { ...part(box), group: box.group, ...(subtitle ? { subtitle } : {}), ...(parts.length ? { parts } : {}) };
  });
  const arrows: DiagramArrow[] = scene.arrows.map((arrow, index) => ({
    id: `${index}`, from: arrow.fromKey, to: arrow.toKey, label: arrow.label, directed: !arrow.undirected,
    chips: arrow.evidence.slice(0, 3).map(item => ({ text: `${item.reverse ? '← ' : ''}${item.type}${item.count > 1 ? ` ×${item.count}` : ''}`, title: `Evidence from the index: ${item.count} “${item.type}” relationship${item.count === 1 ? '' : 's'} between them, ${item.reverse ? 'running the other way' : 'running this way'}` })),
  }));
  return { boxes, arrows };
}
function nameOf(link: ResolvedLink): string {
  if (link.kind === 'flow') return link.label ?? link.name ?? link.href;
  if (link.type === 'file' || link.type === 'directory' || link.type === 'application') return link.path?.split('/').pop() || link.name || link.href;
  return link.name ?? link.label ?? link.href;
}
function kindOf(link: ResolvedLink): string { return link.kind === 'flow' ? 'Flow' : link.kind === 'table' ? 'Table' : typeLabel(link.type ?? 'file'); }
function subtitleOf(link: ResolvedLink): string | undefined {
  // A symbol shown without its file says which file it is in.
  if (link.kind === 'path' && link.type && !['file', 'directory', 'application'].includes(link.type)) return link.path?.split('/').pop();
  return undefined;
}
function stateOf(link: ResolvedLink): { state?: 'changed' | 'missing'; note?: string } {
  if (link.status === 'missing') return { state: 'missing', note: link.reason ?? 'Nothing indexed has this name any more' };
  if (link.status === 'changed') return { state: 'changed', note: 'Its code changed since this was written' };
  return {};
}
