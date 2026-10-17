'use client';
// Focus: a set of things (a selection and what it is connected to, the files
// of a pull request, what an explanation links) with the relationships
// between them as arrows, in the middle, in the map's projection (Settings,
// Views). On the map (the default): nothing re-sorted, the areas holding the
// set opened as nested frames and the blocks too small to read found through
// callouts (`map-plan`, in plan or isometric). Gathered: only the set, packed
// by the map's packer, in plan (`plan`) or on the isometric map (`gather`).
// Arrows run along the streets, their labels placed where they cover least
// (or numbered, or on the line), never over one another.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeSummary } from '@engine/projection/dto';
import { toScreen, worldToScreen, type Camera, type Viewport } from '../lib/camera';
import { ancestorsOf, applyAlpha, clamp01, containersOf, ease, focusFrame, focusLayout, isContainer, mapFrame, morph, sceneHierarchy, sceneOf, type Focus, type Hierarchy } from '../lib/focus-layout';
import { ensureNodes, arrowChip, arrowTotal, loadFocusSet, mainType, type FocusSet } from '../lib/focus-set';
import { DEFAULT_LOD } from '../lib/lod';
import { blockBoxes, boundsOf, drawArrows, drawCallouts, drawPlan, frameTree, hitPlan, inkFor, pill, projector, routeArrows, sceneTree, screenBox, whereOf, type Arrow, type Box, type Drawn, type Frame, type Ink, type RoutedArrow } from '../lib/plan';
import { placeLabels } from '../lib/labels';
import { MapRenderer } from '../lib/renderer';
import { PaletteCache, themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { fitInStage, lerpCamera, reducedMotion, stageStyles as styles, useStage, type Insets } from './Stage';

type FocusDrawing = 'map-plan' | 'plan' | 'gather';
const LAYOUTS: ['map' | 'gather', string, string][] = [
  ['map', 'On the map', 'Nothing moves: the areas holding these open as nested frames'],
  ['gather', 'Gathered', 'Only these, packed together by the map’s packer, in the map’s order'],
];
const ENTER = 1500, ARROWS = 700, STEP = 1100;
/** What the panel covers: the left side when the middle is wide, the top otherwise. */
const insetsFor = (viewport: Viewport): Insets => viewport.width >= 760 ? { left: 324, right: 16, top: 16, bottom: 16 } : { left: 16, right: 16, top: 250, bottom: 16 };
interface Play { start: number; key: string; camFrom?: Camera }

export function FocusView() {
  const store = useStore();
  const subject = useAtlas(state => state.focusView);
  const layout = useAtlas(state => state.views.focus);
  const flat = useAtlas(state => state.views.map === 'plan');
  const projection: FocusDrawing = layout === 'map' ? 'map-plan' : flat ? 'plan' : 'gather';
  const labels = useAtlas(state => state.views.labels);
  const themeId = useAtlas(state => state.themeId);
  const connections = useAtlas(state => state.connections);
  const shapes = useAtlas(state => state.shapes);
  const theme = themeById(themeId);
  const [set, setSet] = useState<FocusSet>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    if (!subject) return;
    const controller = new AbortController();
    setStatus('loading'); setError(undefined);
    (async () => {
      const found = await loadFocusSet(store, subject, controller.signal);
      if (controller.signal.aborted) return;
      await ensureNodes(store, found.ids, found.areas, controller.signal);
      if (controller.signal.aborted) return;
      setSet(found); setStatus('ready');
    })().catch(problem => { if (!controller.signal.aborted) { setStatus('error'); setError(problem instanceof Error ? problem.message : String(problem)); } });
    return () => controller.abort();
  }, [store, subject]);

  const renderer = useMemo(() => new MapRenderer(theme), [theme]);
  const palettes = useMemo(() => new PaletteCache(theme), [theme]);
  const ink = useMemo(() => inkFor(theme), [theme]);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 0.2 });
  const play = useRef<Play | undefined>(undefined);
  const userMoved = useRef(false);
  const last = useRef<{ order: Drawn[]; tilt: number; iso?: { scene: ReturnType<typeof sceneOf>; set: ReturnType<ReturnType<typeof sceneOf>['visible']> } }>({ order: [], tilt: 1 });
  const focusCache = useRef<{ key: string; focus?: Focus; from?: Frame }>({ key: '' });
  const routes = useRef<{ key: string; routed: RoutedArrow[] }>({ key: '', routed: [] });
  const isoCache = useRef<{ key: string; scene?: ReturnType<typeof sceneOf> }>({ key: '' });
  // Areas the plan opens whose children are not loaded: asked for once in a while, not every frame.
  const asked = useRef(new Map<string, number>());
  const load = (id: string) => { const now = performance.now(); if (now - (asked.current.get(id) ?? -1e9) < 4000) return; asked.current.set(id, now); void store.loadChildren([id]); };
  const playKey = `${subject?.kind}:${subject?.id}|${projection}|${flat}|${replay}|${set ? 'set' : ''}`;
  useEffect(() => { play.current = { start: performance.now(), key: playKey, ...(play.current ? { camFrom: { ...camera.current } } : {}) }; userMoved.current = false; }, [playKey]);

  const arrows = useMemo<Arrow[]>(() => (set?.arrows ?? []).map(arrow => ({ from: arrow.from, to: arrow.to, chip: arrowChip(arrow), color: theme.relation[mainType(arrow)] ?? theme.fallbackRelation, width: Math.min(4, 1.4 + Math.log2(arrowTotal(arrow))) * 0.85 })), [set, theme]);

  const canvas = useStage(({ ctx, viewport, time }) => {
    const scene = store.scene;
    background(ctx, viewport, theme.background);
    const p = play.current;
    if (!set || !p || !scene.rootId) return;
    const hierarchy = sceneHierarchy(scene);
    if (!hierarchy) return;
    const interest = set.ids.filter(id => scene.nodes.has(id));
    if (!interest.length) return;
    const elapsed = reducedMotion() ? 1e9 : time - p.start;
    const moving = !reducedMotion();
    const settle = (target: Camera, k: number) => { if (!(userMoved.current && elapsed > ENTER)) camera.current = p.camFrom && k < 1 ? lerpCamera(p.camFrom, target, ease(clamp01(k))) : target; };
    const avoidPanels = panels(viewport);
    if (projection === 'map-plan') {
      // The map as it is (in plan, or isometric): frame the set with some context around it.
      const rects = interest.map(id => scene.nodes.get(id)!.rect);
      const box = rects.reduce((a, r) => ({ x0: Math.min(a.x0, r.x), y0: Math.min(a.y0, r.y), x1: Math.max(a.x1, r.x + r.w), y1: Math.max(a.y1, r.y + r.h) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, hw = Math.max(210, (box.x1 - box.x0) / 2 * 1.08), hh = Math.max(210, (box.y1 - box.y0) / 2 * 1.08);
      const context = [{ x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 }];
      const fit = (tilt: number) => fitInStage(boundsOf(context, projector(tilt), tilt < 1 ? 30 : 0), viewport, insetsFor(viewport), 70);
      const tilt = flat ? 1 : 0;
      if (p.camFrom) settle(fit(tilt), elapsed / STEP); else if (!(userMoved.current && elapsed > ENTER)) camera.current = fit(tilt);
      const arrowProgress = clamp01((elapsed - (p.camFrom ? STEP : 600)) / ARROWS);
      const keep = new Set(interest.flatMap(id => [id, ...ancestorsOf(hierarchy, id)]));
      const force = new Set(interest.flatMap(id => ancestorsOf(hierarchy, id)));
      const names: Box[] = [];
      const interestSet = new Set(interest);
      const drawn = drawPlan(ctx, theme, palettes, viewport, camera.current, sceneTree(scene), {
        tilt, force, keep, labels: true, collect: names, labelFor: () => false,
        tint: node => (interestSet.has(node.id) && !isContainer(node) ? ink.tint : undefined),
        ring: node => (interestSet.has(node.id) ? { color: ink.accent, width: 2 } : undefined),
        pending: id => load(id),
      });
      last.current = { order: drawn.order, tilt };
      const routed = arrowProgress > 0 ? routesFor(routes.current, `${drawn.signature}|${tilt}|${arrows.length}`, () => routeArrows(drawn.drawn, arrows, id => anchorId(drawn.drawn, hierarchy, id))) : [];
      const project = projector(tilt);
      const callouts = drawCallouts(ctx, ink, viewport, interest.flatMap(id => {
        const item = anchorOf(drawn.drawn, hierarchy, id);
        if (!item) return [];
        const node = scene.nodes.get(id)!;
        const file = node.type !== 'file' && !isContainer(node) ? scene.nodes.get(node.spatialParentId ?? '') : undefined;
        return [{ id, box: screenBox(item, camera.current, viewport, tilt), name: `${node.name}${isContainer(node) ? '/' : ''}`, sub: set.captions.get(id) ?? whereOf(node, file), container: isContainer(node) }];
      }), [...names, ...avoidPanels], routed.map(arrow => arrow.points.map(q => toScreen(camera.current, viewport, project(q.x, q.y, q.z)))), time, moving);
      if (arrowProgress > 0) drawArrows(ctx, ink, theme, viewport, camera.current, tilt, routed, arrowProgress, time, { mode: labels, avoid: [...names, ...callouts, ...avoidPanels], blocks: blockBoxes(interest.flatMap(id => { const item = drawn.drawn.get(id); return item ? [item] : []; }), camera.current, viewport, tilt) }, moving);
      return;
    }
    // The set gathered: its focus layout (computed once per set and scene).
    const cacheKey = `${playKey}|${scene.revision}`;
    if (focusCache.current.key !== cacheKey) {
      const focus = focusLayout(hierarchy, interest, { fold: 'tile' });
      focusCache.current = { key: cacheKey, ...(focus ? { focus, from: nearFrame(hierarchy, interest) } : {}) };
    }
    const { focus, from } = focusCache.current;
    if (!focus || !from) return;
    const real = interest.map(id => hierarchy.node(id)!.rect);
    const t = clamp01((elapsed - (p.camFrom ? 0 : 900)) / (p.camFrom ? STEP : 1400));
    const frame = t >= 1 ? focusFrame(focus) : morph(from, focusFrame(focus), t);
    const arrowProgress = clamp01((elapsed - (p.camFrom ? STEP : 2300)) / ARROWS);
    const force = containersOf(focus.nodes);
    if (projection === 'plan') {
      const tilt = ease(clamp01((elapsed - 400) / 700));
      const fitTo = (rects: NodeSummary['rect'][], pad: number) => fitInStage(boundsOf(rects, projector(tilt), 20), viewport, insetsFor(viewport), pad);
      if (!(userMoved.current && elapsed > ENTER)) camera.current = lerpCamera(fitTo(real, 110), fitTo([focus.bounds], 60), ease(clamp01(t * 1.15)));
      const names: Box[] = [];
      const drawn = drawPlan(ctx, theme, palettes, viewport, camera.current, frameTree(frame), { tilt, force, labels: true, collect: names, ...(t < 1 ? { keep: new Set([...interest, ...force]) } : {}) });
      last.current = { order: drawn.order, tilt };
      if (arrowProgress > 0) {
        const routed = routesFor(routes.current, `${cacheKey}|${drawn.signature}|${Math.round(tilt * 20)}`, () => routeArrows(drawn.drawn, arrows));
        drawArrows(ctx, ink, theme, viewport, camera.current, tilt, routed, arrowProgress, time, { mode: labels, avoid: [...names, ...avoidPanels], blocks: blockBoxes(drawn.drawn.values(), camera.current, viewport, tilt) }, moving);
      }
      captions(ctx, ink, set, [...drawn.drawn.values()], (x, y, z) => toScreen(camera.current, viewport, projector(tilt)(x, y, z)), t, viewport, [...names, ...avoidPanels]);
      return;
    }
    // Gather: the isometric map gathers into the set, drawn by the map's renderer.
    const iso = (rects: NodeSummary['rect'][], pad: number) => fitInStage(boundsOf(rects, projector(0), 30), viewport, insetsFor(viewport), pad);
    if (!(userMoved.current && elapsed > ENTER)) camera.current = lerpCamera(iso(real, 120), iso([focus.bounds], 60), ease(clamp01(t * 1.15)));
    // Once gathered, the frame stops changing: keep its scene.
    if (t < 1 || isoCache.current.key !== cacheKey) isoCache.current = { key: t < 1 ? '' : cacheKey, scene: sceneOf(frame.nodes, hierarchy.rootId) };
    const isoScene = isoCache.current.scene!;
    isoScene.shapes = shapes;
    const visible = isoScene.visible(camera.current, viewport, DEFAULT_LOD, force);
    applyAlpha(visible, frame);
    const edges = arrowProgress > 0 ? arrows.map(arrow => ({ key: `${arrow.from}>${arrow.to}`, from: arrow.from, to: arrow.to, fromAncestors: [], toAncestors: [], type: mainType(set.arrows.find(item => item.from === arrow.from && item.to === arrow.to) ?? { types: {} }), count: 1, emphasized: true })) : [];
    renderer.render(ctx, window.devicePixelRatio || 1, viewport, camera.current, isoScene, visible, { edges, showDiagnostics: false, time, reducedMotion: !moving, shapes, streets: true, connections, emphasis: new Set(interest) }, DEFAULT_LOD);
    last.current = { order: [], tilt: 0, iso: { scene: isoScene, set: visible } };
    const drawnMap = new Map<string, Drawn>(visible.items.map(item => [item.node.id, { node: item.node, rect: item.node.rect, zBase: item.zBase, zTop: item.zTop, alpha: item.alpha, open: item.open, depth: 0 }]));
    // Arrow labels and captions keep off the names the map drew.
    const named = [...renderer.labelBoxes, ...avoidPanels];
    if (arrowProgress > 0.9) drawArrows(ctx, ink, theme, viewport, camera.current, 0, routeArrows(drawnMap, arrows).map(arrow => ({ ...arrow, width: 0 })), 1, time, { mode: labels, avoid: named }, moving);
    captions(ctx, ink, set, [...drawnMap.values()], (x, y, z) => worldToScreen(camera.current, viewport, x, y, z), t, viewport, named);
  }, camera, {
    onUserCamera: () => { userMoved.current = true; },
    onClick: (x, y) => {
      const { order, iso } = last.current;
      const hit = iso ? iso.scene.hitTest(iso.set, camera.current, { width: canvas.current?.clientWidth ?? 1, height: canvas.current?.clientHeight ?? 1 }, x, y)?.node : hitPlan(order, camera.current, { width: canvas.current?.clientWidth ?? 1, height: canvas.current?.clientHeight ?? 1 }, x, y, last.current.tilt)?.node;
      if (hit && !hit.id.startsWith('tile:') && hit.type !== 'repository') void store.select(hit.id, { fly: false });
    },
  });

  if (!subject) return null;
  const shown = set ? set.ids.filter(id => store.scene.nodes.has(id)).length : 0;
  return (
    <div className={styles.stage} aria-label="Focus">
      <canvas ref={canvas} className={styles.canvas} role="img" aria-label={set ? `${set.title}: ${set.ids.length} blocks and ${set.arrows.length} links` : 'Focus'} />
      <aside className={styles.panel}>
        <p className={styles.kicker}><span>Focus · {subject.kind === 'pull' ? 'pull request' : subject.kind}</span><button className="icon-button tiny" onClick={() => store.closeFocus()} aria-label="Close the focus">✕</button></p>
        <h2>{set?.title ?? subject.title}</h2>
        {status === 'loading' && <p><span className="spinner tiny" /> Gathering it from the index…</p>}
        {status === 'error' && <p className="note error">{error}</p>}
        {set && <p>{set.text}{set.more ? ` ${set.more} more left out to keep it readable.` : ''}{shown < set.ids.length ? ` ${set.ids.length - shown} not on this map.` : ''}</p>}
        <div className={styles.row}>
          <div className="segmented" role="group" aria-label="Layout">
            {LAYOUTS.map(([key, label, title]) => <button key={key} aria-pressed={layout === key} title={title} onClick={() => store.setViews({ focus: key })}>{label}</button>)}
          </div>
        </div>
        <div className={styles.row}>
          <button className="chip" onClick={() => setReplay(value => value + 1)} title="Play it again from the map">↻ Replay</button>
          <button className="chip" aria-pressed={!flat} onClick={() => store.setViews({ map: flat ? 'iso' : 'plan' })} title={flat ? 'Drawn as a 2D plan (click for the isometric map, everywhere)' : 'Drawn on the isometric map (click for the 2D plan, everywhere)'}>3D</button>
          <button className="chip" onClick={() => store.setViews({ labels: labels === 'placed' ? 'numbered' : labels === 'numbered' ? 'line' : 'placed' })} title="Where arrow labels go: placed where they cover least, as numbers with a legend, or on the line">Labels: {labels === 'placed' ? 'placed' : labels === 'numbered' ? 'numbered' : 'on the line'}</button>
        </div>
        <p className={styles.hint}>Drag to pan, wheel to zoom, click a block to select it. It draws in the map’s projection ({flat ? '2D plan' : 'isometric'}); 3D switches it everywhere.</p>
      </aside>
    </div>
  );
}

function background(ctx: CanvasRenderingContext2D, viewport: Viewport, colors: [string, string]) {
  const gradient = ctx.createLinearGradient(0, 0, 0, viewport.height);
  gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, viewport.width, viewport.height);
}
/** The panel (top left) covers the canvas: labels keep off it. */
function panels(viewport: Viewport): Box[] { return [{ x0: 0, y0: 0, x1: Math.min(viewport.width, 324), y1: Math.min(viewport.height, 330) }]; }
/** A block drawn for an ID: itself, or the nearest area holding it that is drawn. */
function anchorOf(drawn: Map<string, Drawn>, hierarchy: Hierarchy, id: string): Drawn | undefined {
  const own = drawn.get(id);
  if (own) return own;
  for (const ancestor of ancestorsOf(hierarchy, id).reverse()) { const item = drawn.get(ancestor); if (item) return item; }
  return undefined;
}
function anchorId(drawn: Map<string, Drawn>, hierarchy: Hierarchy, id: string): string | undefined { return anchorOf(drawn, hierarchy, id)?.node.id; }
/** Routes are searched again only when what is drawn changes (the streets they run on). */
function routesFor(cache: { key: string; routed: RoutedArrow[] }, key: string, route: () => RoutedArrow[]): RoutedArrow[] {
  if (cache.key !== key) { cache.key = key; cache.routed = route(); }
  return cache.routed;
}
/** The part of the map a gather starts from: the areas holding the set, their children, and the set's own children. */
function nearFrame(hierarchy: Hierarchy, interest: string[]): Frame {
  const keep = new Set<string>([hierarchy.rootId]);
  for (const id of interest) for (const ancestor of ancestorsOf(hierarchy, id)) keep.add(ancestor);
  const ids = new Set<string>(keep);
  for (const id of [...keep, ...interest]) { ids.add(id); for (const child of hierarchy.children(id)) ids.add(child); }
  const full = mapFrame(hierarchy);
  return { nodes: full.nodes.filter(node => ids.has(node.id)), alpha: new Map() };
}
/** An explanation's words for each block, above it where there is room; never over another caption. */
function captions(ctx: CanvasRenderingContext2D, ink: Ink, set: FocusSet, items: Drawn[], at: (x: number, y: number, z: number) => { x: number; y: number }, t: number, viewport: Viewport, avoid: Box[]) {
  if (!set.captions.size) return;
  ctx.save(); ctx.font = `700 10px ${ink.font}`;
  const asks = items.flatMap(item => {
    const caption = set.captions.get(item.node.id);
    if (!caption || item.alpha < 0.3) return [];
    const point = at(item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h / 2, item.zTop);
    return [{ caption, ask: { key: item.node.id, target: { x0: point.x - 8, y0: point.y - 8, x1: point.x + 8, y1: point.y + 8 }, w: ctx.measureText(caption).width + 11, h: 19 } }];
  });
  ctx.restore();
  const { placed } = placeLabels(asks.map(item => item.ask), { bounds: { x0: 4, y0: 4, x1: viewport.width - 4, y1: viewport.height - 4 }, avoid, directions: ['n', 'ne', 'nw', 's', 'e', 'w', 'se', 'sw'], distances: [4, 18, 36], columns: false });
  const byKey = new Map(asks.map(item => [item.ask.key, item.caption]));
  for (const spot of placed) pill(ctx, ink, byKey.get(spot.key)!, (spot.box.x0 + spot.box.x1) / 2, (spot.box.y0 + spot.box.y1) / 2, { alpha: 0.4 + 0.6 * t, size: 10 });
}
