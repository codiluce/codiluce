'use client';
// PROTOTYPE (throwaway) — question: does a *focus layout* (only the cut, packed
// in map order) read as a diagram, and which presentation works best?
// Four variants on real data (this repository's map):
//   A  Gather (iso): the real map, the cut forced open, then the city gathers into the focus layout (app renderer).
//   B  Plan: the same, tilted into a flat plan seen from above, arrows on the streets.
//   C  Lift: the map stays; the focus layout floats above its region on stalks.
//   D  Map plan: no re-sorting at all. The real map flattened into a plan (nested areas as nested frames),
//      the camera on the interest set, tiny blocks found through callout labels.
// Arrow labels (all variants): placed by score along the route, numbered with a legend, or on the line.
// Cases: the tree-sitter tour (5 scenes, ↑/↓), a real PR (merge 6686d2e), and a deep link (depth 3 ↔ depth 11).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, Viewport } from '../../../lib/camera';
import { toScreen, worldToScreen } from '../../../lib/camera';
import { DEFAULT_LOD } from '../../../lib/lod';
import type { EdgeOverlay } from '../../../lib/renderer';
import { applyAlpha, clamp01, containersOf, ease, fitInStage, fitIso, focusFrame, focusLayout, FONT, lerpCamera, loadJson, makeRenderer, MapIndex, mapFrame, morph, pill, renderState, sceneOf, theme, useCanvas, type Focus, type Frame, type N } from './kit';
import { blockBoxes, boundsOf, drawArrows, drawFrame, projector, routeArrows, type Arrow, type ArrowLabelOptions, type Box, type Drawn, type LabelMode } from './plan';

interface TourScene { title: string; view?: 'map'; text: string; focus?: string[]; arrows?: { from: string; to: string; label: string; undirected?: boolean }[]; captions?: Record<string, string> }
const TS = 'src/analysis/tree-sitter/';
const TOUR: TourScene[] = [
  { title: 'Where tree-sitter lives', view: 'map', focus: [TS, 'src/pipeline/index.ts', `${TS}grammars.ts`], captions: { [TS]: 'parsers, workers, extractors', 'src/pipeline/index.ts': 'runs every analyzer', [`${TS}grammars.ts`]: 'grammars and queries' },
    text: 'Tree-sitter parses every language Codiluce does not read with a dedicated compiler. All of it sits in the tree-sitter folder, started from the indexing pipeline and fed by the grammar catalog.' },
  { title: 'From an index run to a parser process', focus: ['src/pipeline/index.ts', `${TS}analyzer.ts`, `${TS}native-budget.ts#IndexedStructureParser`, `${TS}client.ts#StructureParser`, `${TS}worker.ts`],
    arrows: [{ from: 'src/pipeline/index.ts', to: `${TS}analyzer.ts`, label: 'runs, among its analyzers' }, { from: `${TS}analyzer.ts`, to: `${TS}native-budget.ts#IndexedStructureParser`, label: 'parses each file with' }, { from: `${TS}native-budget.ts#IndexedStructureParser`, to: `${TS}client.ts#StructureParser`, label: 'is a budgeted' }, { from: `${TS}client.ts#StructureParser`, to: `${TS}worker.ts`, label: 'forks a process running' }],
    text: 'The pipeline lists the structure analyzer among its analyzers. For each file, the analyzer asks an IndexedStructureParser, which budgets how much one parser process may take. It is a StructureParser: it forks the worker as a separate Node process.' },
  { title: 'Inside the worker', focus: [`${TS}worker.ts`, `${TS}grammars.ts#verifiedGrammar`, `${TS}grammars.ts#queryText`, `${TS}extract.ts#extractStructure`],
    arrows: [{ from: `${TS}worker.ts`, to: `${TS}grammars.ts#verifiedGrammar`, label: 'loads a checked .wasm grammar with' }, { from: `${TS}worker.ts`, to: `${TS}grammars.ts#queryText`, label: 'reads the language query with' }, { from: `${TS}worker.ts`, to: `${TS}extract.ts#extractStructure`, label: 'turns each syntax tree into facts with' }],
    text: 'The worker loads each language once: verifiedGrammar checks the .wasm grammar against the manifest\'s hash, and queryText reads the language\'s query. extractStructure walks the captures into structure facts.' },
  { title: 'Per-language detail', focus: [`${TS}extract.ts#extractStructure`, `${TS}python-imports.ts`, `${TS}go-syntax.ts`, `${TS}ruby-syntax.ts`, `${TS}jvm-syntax.ts`, `${TS}csharp-syntax.ts`, `${TS}rust-syntax.ts`, `${TS}embedded-host.ts`],
    arrows: [{ from: `${TS}extract.ts#extractStructure`, to: `${TS}python-imports.ts`, label: 'Python imports' }, { from: `${TS}extract.ts#extractStructure`, to: `${TS}go-syntax.ts`, label: 'Go' }, { from: `${TS}extract.ts#extractStructure`, to: `${TS}ruby-syntax.ts`, label: 'Ruby' }, { from: `${TS}extract.ts#extractStructure`, to: `${TS}jvm-syntax.ts`, label: 'Java, Kotlin' }, { from: `${TS}extract.ts#extractStructure`, to: `${TS}csharp-syntax.ts`, label: 'C#' }, { from: `${TS}extract.ts#extractStructure`, to: `${TS}rust-syntax.ts`, label: 'Rust' }, { from: `${TS}embedded-host.ts`, to: `${TS}extract.ts#extractStructure`, label: 'the template-host counterpart of', undirected: true }],
    text: 'extractStructure handles what all languages share, and hands each language\'s own rules to its extractor. Templates take their own path, since a template holds two languages at once.' },
  { title: 'Back into the graph', focus: [`${TS}worker.ts`, `${TS}client.ts#StructureParser`, `${TS}analyzer.ts`, 'src/core/graph.ts'],
    arrows: [{ from: `${TS}worker.ts`, to: `${TS}client.ts#StructureParser`, label: 'sends structure facts back to' }, { from: `${TS}client.ts#StructureParser`, to: `${TS}analyzer.ts`, label: 'resolves the parse for' }, { from: `${TS}analyzer.ts`, to: 'src/core/graph.ts', label: 'writes entities and evidence into' }],
    text: 'The facts travel back over the process boundary to the analyzer, which writes entities, containment and evidence into the graph, stamped with the grammar\'s revision and hash.' },
];
interface Pull { sha: string; title: string; subject: string; files: { status: string; path: string }[]; arrows: { from: string; to: string; types: Record<string, number> }[] }
type CaseId = 'tour' | 'pull' | 'deep';
interface Shown { title: string; text: string; interest: string[]; arrows: Arrow[]; captions: Map<string, string> }
const DEEP = 'tests/fixtures/repository/frontend/src/app/(account)/users/[id]/page.tsx';

function shownFor(index: MapIndex, pull: Pull | undefined, which: CaseId, sceneIndex: number): Shown {
  if (which === 'pull' && pull) {
    const present = pull.files.map(file => index.byPath.get(file.path)).filter((node): node is N => !!node);
    const top = [...pull.arrows].sort((a, b) => total(b) - total(a)).slice(0, 14);
    return {
      title: `PR · ${pull.subject} (${pull.sha})`, text: `${pull.files.length} files changed; the ${top.length} strongest of ${pull.arrows.length} relationships between them, from the index.`,
      interest: present.map(node => node.id),
      arrows: top.map(arrow => { const [type] = Object.entries(arrow.types).sort((a, b) => b[1] - a[1])[0]!; return { from: arrow.from, to: arrow.to, type, chip: Object.entries(arrow.types).map(([t, n]) => `${t}${n > 1 ? ` ×${n}` : ''}`).join(' · '), color: theme.relation[type] ?? theme.fallbackRelation, width: Math.min(4, 1.4 + Math.log2(total(arrow))) * 0.8 }; }),
      captions: new Map(),
    };
  }
  if (which === 'deep') {
    const a = index.byPath.get('src/cli.ts')!, b = index.byPath.get(DEEP)!;
    return { title: 'A deep link: depth 3 ↔ depth 11', text: 'src/cli.ts and a fixture page eleven levels deep, about 1,050 units apart on the map. On today\'s map the page is drawn only from zoom 4.77 (inside `[id]/`); framing both needs ~1.2. The arrow is an illustration.',
      interest: [a.id, b.id], arrows: [{ from: a.id, to: b.id, label: 'example link' }], captions: new Map() };
  }
  const scene = TOUR[sceneIndex]!;
  const links = [...new Set([...(scene.focus ?? []), ...(scene.arrows ?? []).flatMap(arrow => [arrow.from, arrow.to])])];
  const id = (link: string) => index.resolve(link)?.id;
  return {
    title: `${sceneIndex + 1}/${TOUR.length} · ${scene.title}`, text: scene.text,
    interest: links.map(id).filter((value): value is string => !!value),
    arrows: (scene.arrows ?? []).flatMap(arrow => { const from = id(arrow.from), to = id(arrow.to); return from && to ? [{ from, to, label: arrow.label, directed: !arrow.undirected }] : []; }),
    captions: new Map(Object.entries(scene.captions ?? {}).flatMap(([link, caption]) => { const target = id(link); return target ? [[target, caption] as const] : []; })),
  };
}
const total = (arrow: { types: Record<string, number> }) => Object.values(arrow.types).reduce((a, b) => a + b, 0);

interface Play { kind: 'enter' | 'step'; start: number; from: Frame; to: Frame; camFrom?: Camera; done: boolean }
const HOLD = 1300, MORPH = 1500, STEP = 1100, ARROWS = 700, TILT = 700;

export function FocusPrototype({ variant }: { variant: string }) {
  const [map, setMap] = useState<{ nodes: N[] }>();
  const [pull, setPull] = useState<Pull>();
  const [which, setWhich] = useState<CaseId>('tour');
  const [sceneIndex, setScene] = useState(0);
  const [fold, setFold] = useState<'tile' | 'drop'>('tile');
  const [replay, setReplay] = useState(0);
  const [plan, setPlan] = useState(true);
  const [labelMode, setLabelMode] = useState<LabelMode>('placed');
  const labelRef = useRef<LabelMode>('placed');
  labelRef.current = labelMode;
  useEffect(() => { void loadJson<{ nodes: N[] }>('map').then(setMap); void loadJson<Pull>('pull').then(setPull); }, []);
  const index = useMemo(() => (map ? new MapIndex(map.nodes) : undefined), [map]);
  const shown = useMemo(() => (index ? shownFor(index, pull, which, sceneIndex) : undefined), [index, pull, which, sceneIndex]);
  const focus = useMemo(() => (index && shown ? focusLayout(index, shown.interest, { fold }) : undefined), [index, shown, fold]);
  const renderer = useMemo(() => makeRenderer(), []);
  useEffect(() => { (window as unknown as { __focus?: Focus }).__focus = focus; }, [focus]);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 0.2 });
  const play = useRef<Play | undefined>(undefined);
  const last = useRef<Frame | undefined>(undefined);
  const tilt = useRef({ from: 0, to: 1, start: -1e9 });
  const viewport = useRef<Viewport>({ width: 1200, height: 800 });
  const userMoved = useRef(false);
  const stats = useRef<string[]>([]);
  const [readout, setReadout] = useState<string[]>([]);

  // Keys: ↑/↓ step the tour (← → belong to the variant switcher).
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (which !== 'tour') return;
      if (event.key === 'ArrowDown') setScene(s => Math.min(TOUR.length - 1, s + 1));
      if (event.key === 'ArrowUp') setScene(s => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [which]);

  // A new case (or replay, fold, variant) enters from the map; a new scene of the tour steps from the last one.
  const caseKey = `${which}|${fold}|${variant}|${replay}`;
  const lastCase = useRef('');
  useEffect(() => {
    if (!index || !focus) return;
    const to = focusFrame(focus);
    const now = performance.now();
    userMoved.current = false;
    if (lastCase.current !== caseKey || !last.current) {
      lastCase.current = caseKey;
      play.current = { kind: 'enter', start: now, from: mapFrame(index), to, done: false };
      if (variant === 'B') tilt.current = { from: 0, to: plan ? 1 : 0, start: now + HOLD - TILT };
    } else play.current = { kind: 'step', start: now, from: last.current, to, camFrom: { ...camera.current }, done: false };
    last.current = to;
    stats.current = describe(index, focus, shown!);
    setReadout(stats.current);
  }, [index, focus, caseKey, shown, variant, plan]);
  useEffect(() => { if (variant === 'B') tilt.current = { from: currentTilt(performance.now()), to: plan ? 1 : 0, start: performance.now() }; }, [plan, variant]);
  const currentTilt = (now: number) => { const t = tilt.current; return t.from + (t.to - t.from) * ease(clamp01((now - t.start) / TILT)); };

  const drawRef = useCanvas(({ ctx, viewport: vp, time }) => {
    viewport.current = vp;
    if (!index || !focus || !shown || !play.current) { ctx.fillStyle = theme.background[0]; ctx.fillRect(0, 0, vp.width, vp.height); return; }
    const p = play.current;
    const elapsed = time - p.start;
    const real = shown.interest.map(id => index.byId.get(id)!.rect);
    let frame: Frame, t = 1, arrowProgress = 0;
    if (p.kind === 'enter') {
      const hold = variant === 'C' ? 700 : HOLD;
      if (elapsed < hold) { frame = mapFrame(index); t = 0; }
      else if (variant !== 'C' && elapsed < hold + MORPH) { t = (elapsed - hold) / MORPH; frame = morph(p.from, p.to, t); }
      else { frame = p.to; t = 1; }
      arrowProgress = clamp01((elapsed - hold - (variant === 'C' ? 1000 : MORPH)) / ARROWS);
    } else {
      t = clamp01(elapsed / STEP); frame = t < 1 ? morph(p.from, p.to, t) : p.to;
      arrowProgress = clamp01((elapsed - STEP) / ARROWS);
    }
    const force = containersOf(focus.nodes);
    if (variant === 'A') drawGather(ctx, vp, time, frame, t, arrowProgress, force, p, elapsed, real);
    else if (variant === 'B') drawPlan(ctx, vp, time, frame, t, arrowProgress, force, p, elapsed, real);
    else if (variant === 'D') arrowProgress = drawMapPlan(ctx, vp, time, p, elapsed, real);
    else drawLift(ctx, vp, time, arrowProgress, force, p, elapsed, real);
    if (!p.done && arrowProgress >= 1) p.done = true;
  }, camera, () => { userMoved.current = true; });

  function cameraFor(target: Camera, from: Camera | undefined, k: number): Camera {
    if (userMoved.current && play.current?.done) return camera.current;
    return from ? lerpCamera(from, target, ease(clamp01(k))) : target;
  }

  function drawGather(ctx: CanvasRenderingContext2D, vp: Viewport, time: number, frame: Frame, t: number, arrowProgress: number, force: Set<string>, p: Play, elapsed: number, real: N['rect'][]) {
    const mapCam = fitIso(real, vp, 120), focusCam = fitIso([focus!.bounds], vp, 60);
    if (p.kind === 'enter') camera.current = cameraFor(t <= 0 ? mapCam : focusCam, t <= 0 ? undefined : mapCam, t * 1.15);
    else camera.current = cameraFor(focusCam, p.camFrom, t * 1.1);
    const scene = sceneOf(frame.nodes, index!.root.id);
    const set = scene.visible(camera.current, vp, DEFAULT_LOD, force);
    applyAlpha(set, frame);
    const edges: EdgeOverlay[] = arrowProgress > 0 ? shown!.arrows.map(arrow => ({ key: `${arrow.from}>${arrow.to}`, from: arrow.from, to: arrow.to, fromAncestors: [], toAncestors: [], type: arrow.type ?? 'invokes', count: 1, emphasized: true })) : [];
    renderer.render(ctx, window.devicePixelRatio || 1, vp, camera.current, scene, set, renderState(time, { edges }), DEFAULT_LOD);
    // Labels for arrows (the renderer draws the rails) and captions.
    const drawn = new Map<string, Drawn>();
    for (const item of set.items) drawn.set(item.node.id, { node: item.node, rect: item.node.rect, zBase: item.zBase, zTop: item.zTop, alpha: item.alpha, open: item.open, depth: 0 });
    if (arrowProgress > 0.9) {
      labelsOnly(ctx, vp, camera.current, routeArrows(drawn, shown!.arrows).map(arrow => ({ ...arrow, color: arrow.color ?? theme.relation.invokes ?? '#c084fc' })), { mode: labelRef.current, avoid: panels(vp) });
    }
    captions(ctx, vp, camera.current, set.items.map(item => ({ id: item.node.id, rect: item.node.rect, zTop: item.zTop })), t);
  }

  function drawPlan(ctx: CanvasRenderingContext2D, vp: Viewport, time: number, frame: Frame, t: number, arrowProgress: number, force: Set<string>, p: Play, elapsed: number, real: N['rect'][]) {
    const gradient = ctx.createLinearGradient(0, 0, 0, vp.height);
    gradient.addColorStop(0, theme.background[0]); gradient.addColorStop(1, theme.background[1]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, vp.width, vp.height);
    const tiltNow = currentTilt(time);
    const fit = (rects: N['rect'][], pad: number) => fitInStage(boundsOf(rects, projector(tiltNow), 20), vp, pad);
    const mapCam = fit(real, 120), focusCam = fit([focus!.bounds], 60);
    if (p.kind === 'enter') camera.current = cameraFor(t <= 0 ? mapCam : focusCam, t <= 0 ? undefined : mapCam, t * 1.15);
    else camera.current = cameraFor(focusCam, p.camFrom, t * 1.1);
    const names: Box[] = [];
    const drawn = drawFrame(ctx, vp, camera.current, frame, { tilt: tiltNow, force, labels: true, collect: names, ...(t < 1 ? { dimOthers: new Set([...shown!.interest, ...force]) } : {}) });
    if (arrowProgress > 0) drawArrows(ctx, vp, camera.current, tiltNow, routeArrows(drawn, shown!.arrows), arrowProgress, undefined, time, { mode: labelRef.current, avoid: [...names, ...panels(vp)], blocks: blockBoxes(drawn, camera.current, vp, tiltNow) });
    const project = projector(tiltNow);
    captions(ctx, vp, camera.current, [...drawn.values()].map(item => ({ id: item.node.id, rect: item.rect, zTop: item.zTop })), t, (x, y, z) => toScreen(camera.current, vp, project(x, y, z)));
  }

  function drawLift(ctx: CanvasRenderingContext2D, vp: Viewport, time: number, arrowProgress: number, force: Set<string>, p: Play, elapsed: number, real: N['rect'][]) {
    const mapCam = fitIso(real, vp, 160);
    if (!(userMoved.current && p.done)) camera.current = p.kind === 'enter' ? mapCam : cameraFor(mapCam, p.camFrom, elapsed / STEP);
    const frame = mapFrame(index!);
    const scene = sceneOf(frame.nodes, index!.root.id);
    const set = scene.visible(camera.current, vp, DEFAULT_LOD, force);
    renderer.render(ctx, window.devicePixelRatio || 1, vp, camera.current, scene, set, renderState(time, { emphasis: new Set(shown!.interest) }), DEFAULT_LOD);
    const lift = p.kind === 'enter' ? ease(clamp01((elapsed - 700) / 1000)) : 1;
    if (lift <= 0) return;
    // The lifted layer: the focus layout, magnified to about half the width, above the middle of its region.
    const project = projector(0);
    const fb = focus!.bounds;
    const own = boundsOf([fb], project, 10);
    const k = Math.min(3.2 / camera.current.scale, (vp.width * 0.5) / ((own.maxX - own.minX) * camera.current.scale));
    const scale = camera.current.scale * k;
    const center = { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 };
    const realBox = real.reduce((a, r) => ({ x0: Math.min(a.x0, r.x), y0: Math.min(a.y0, r.y), x1: Math.max(a.x1, r.x + r.w), y1: Math.max(a.y1, r.y + r.h) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const below = worldToScreen(camera.current, vp, (realBox.x0 + realBox.x1) / 2, (realBox.y0 + realBox.y1) / 2, 0);
    const height = vp.height * 0.3 * lift;
    const target = { x: Math.max(vp.width * 0.3, Math.min(vp.width * 0.7, below.x)), y: Math.max(vp.height * 0.32, below.y - height) };
    const pc = project(center.x, center.y, 0);
    const liftCam: Camera = { scale, x: pc.x - (target.x - vp.width / 2) / scale, y: pc.y - (target.y - vp.height / 2) / scale };
    // Stalks from each block of the set down to its place on the map.
    const lifted = focusFrame(focus!);
    const alphaFrame: Frame = { nodes: lifted.nodes, alpha: new Map(lifted.nodes.map(node => [node.id, lift])) };
    ctx.save();
    // A soft shadow on the map under the layer.
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(target.x, target.y + height * 0.95, (own.maxX - own.minX) * scale * 0.42, (own.maxY - own.minY) * scale * 0.18, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    const drawnMap = new Map(set.items.map(item => [item.node.id, item]));
    const drawn = drawFrame(ctx, vp, liftCam, alphaFrame, { tilt: 0, force, labels: false });
    ctx.save();
    for (const id of shown!.interest) {
      const up = drawn.get(id), down = drawnMap.get(id) ?? [...index!.ancestors(id)].reverse().map(a => drawnMap.get(a)).find(Boolean);
      if (!up || !down) continue;
      const a = toScreen(liftCam, vp, project(up.rect.x + up.rect.w / 2, up.rect.y + up.rect.h / 2, up.zBase));
      const b = worldToScreen(camera.current, vp, down.node.rect.x + down.node.rect.w / 2, down.node.rect.y + down.node.rect.h / 2, down.zTop);
      ctx.strokeStyle = 'rgba(255,214,140,0.55)'; ctx.lineWidth = 1.3; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,214,140,0.9)'; ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // Redraw the layer on top of its stalks, with labels.
    drawFrame(ctx, vp, liftCam, alphaFrame, { tilt: 0, force, labels: true });
    if (arrowProgress > 0) drawArrows(ctx, vp, liftCam, 0, routeArrows(drawn, shown!.arrows), arrowProgress, undefined, time, { mode: labelRef.current, avoid: panels(vp), blocks: blockBoxes(drawn, liftCam, vp, 0) });
    captions(ctx, vp, liftCam, [...drawn.values()].map(item => ({ id: item.node.id, rect: item.rect, zTop: item.zTop })), 1, (x, y, z) => toScreen(liftCam, vp, project(x, y, z)));
  }

  /**
   * D: the real map, flattened (no re-sorting). The camera settles on the
   * interest set; its ancestors are forced open so the nesting shows as
   * frames; blocks too small to read get a marker and a callout label.
   * Returns the arrows' progress.
   */
  function drawMapPlan(ctx: CanvasRenderingContext2D, vp: Viewport, time: number, p: Play, elapsed: number, real: N['rect'][]): number {
    const gradient = ctx.createLinearGradient(0, 0, 0, vp.height);
    gradient.addColorStop(0, theme.background[0]); gradient.addColorStop(1, theme.background[1]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, vp.width, vp.height);
    const interest = new Set(shown!.interest);
    // Frame the interest set with some context around it (at least ~420 units).
    const box = real.reduce((a, r) => ({ x0: Math.min(a.x0, r.x), y0: Math.min(a.y0, r.y), x1: Math.max(a.x1, r.x + r.w), y1: Math.max(a.y1, r.y + r.h) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, hw = Math.max(210, (box.x1 - box.x0) / 2 * 1.08), hh = Math.max(210, (box.y1 - box.y0) / 2 * 1.08);
    const context = [{ x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 }];
    const fit = (tilt: number) => fitInStage(boundsOf(context, projector(tilt), tilt < 1 ? 30 : 0), vp, 110);
    let tiltNow = 1, arrowProgress: number;
    if (p.kind === 'enter') {
      // The iso map for a moment, then it flattens while the camera settles.
      const k = ease(clamp01((elapsed - 500) / 1000));
      tiltNow = k;
      camera.current = cameraFor(lerpCamera(fit(0), fit(1), k), undefined, 1);
      arrowProgress = clamp01((elapsed - 1600) / ARROWS);
    } else {
      camera.current = cameraFor(fit(1), p.camFrom, elapsed / STEP);
      arrowProgress = clamp01((elapsed - STEP) / ARROWS);
    }
    const force = new Set(shown!.interest.flatMap(id => index!.ancestors(id)));
    const keep = new Set([...interest, ...force]);
    const names: Box[] = [];
    const drawn = drawFrame(ctx, vp, camera.current, mapFrame(index!), {
      tilt: tiltNow, force, labels: true, collect: names, dimOthers: keep,
      labelFor: () => false,
      tint: node => (interest.has(node.id) && !index!.isContainer(node) ? 'hsl(36 52% 44%)' : undefined),
      ring: node => (interest.has(node.id) ? { color: '#ffd68c', width: 2 } : undefined),
    });
    const project = projector(tiltNow);
    const screenBox = (item: Drawn): Box => {
      const r = item.rect;
      const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => toScreen(camera.current, vp, project(x!, y!, item.zTop)));
      return { x0: Math.min(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), x1: Math.max(...pts.map(q => q.x)), y1: Math.max(...pts.map(q => q.y)) };
    };
    const routed = arrowProgress > 0 ? routeArrows(drawn, shown!.arrows) : [];
    // Labels for the interest set: inside the block when it fits, else a callout with a leader.
    const callouts = placeCallouts(ctx, vp, [...interest].flatMap(id => {
      const item = drawn.get(id) ?? index!.ancestors(id).reverse().map(a => drawn.get(a)).find(Boolean);
      if (!item) return [];
      const node = index!.byId.get(id)!;
      const file = node.type !== 'file' && !index!.isContainer(node) ? index!.byId.get(node.spatialParentId ?? '') : undefined;
      const folders = (node.path ?? '').split('/').slice(0, -1).filter(Boolean);
      const where = file ? `in ${file.name}` : folders.length > 2 ? `…/${folders.slice(-2).join('/')}/` : folders.length ? `${folders.join('/')}/` : '';
      return [{ id, box: screenBox(item), name: `${node.name}${index!.isContainer(node) ? '/' : ''}`, sub: shown!.captions.get(id) ?? where, container: index!.isContainer(node) }];
    }), [...names, ...panels(vp)], routed.map(arrow => arrow.points.map(q => toScreen(camera.current, vp, project(q.x, q.y, q.z)))));
    if (arrowProgress > 0) drawArrows(ctx, vp, camera.current, tiltNow, routed, arrowProgress, undefined, time, { mode: labelRef.current, avoid: [...names, ...callouts, ...panels(vp)], blocks: blockBoxes(new Map([...drawn].filter(([id]) => interest.has(id))), camera.current, vp, tiltNow) });
    return arrowProgress;
  }

  /** Callouts: a name inside a block that can hold it; otherwise a marker, a leader line and a label placed where it covers least. */
  function placeCallouts(ctx: CanvasRenderingContext2D, vp: Viewport, items: { id: string; box: Box; name: string; sub: string; container: boolean }[], avoid: Box[], routes: { x: number; y: number }[][]): Box[] {
    const placed: Box[] = [];
    const blocks = items.map(item => item.box);
    const lines: Box[] = routes.flatMap(points => points.slice(1).map((b, i) => { const a = points[i]!; return { x0: Math.min(a.x, b.x) - 2, y0: Math.min(a.y, b.y) - 2, x1: Math.max(a.x, b.x) + 2, y1: Math.max(a.y, b.y) + 2 }; }));
    const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    ctx.save(); ctx.textBaseline = 'middle';
    // Big blocks first: they keep their names inside; the rest go round them.
    const sorted = [...items].sort((a, b) => (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0) - (a.box.x1 - a.box.x0) * (a.box.y1 - a.box.y0));
    for (const item of sorted) {
      const { box } = item;
      const bw = box.x1 - box.x0, bh = box.y1 - box.y0, mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2;
      ctx.font = `800 12px ${FONT}`;
      const w1 = ctx.measureText(item.name).width;
      ctx.font = `600 10px ${FONT}`;
      const w2 = item.sub ? ctx.measureText(item.sub).width : 0;
      const w = Math.max(w1, w2) + 16, h = item.sub ? 32 : 20;
      // Inside: a leaf whose block holds the label with room to spare.
      if (!item.container && bw >= w + 6 && bh >= h + 6) {
        const inside = { x0: mx - w / 2, y0: my - h / 2, x1: mx + w / 2, y1: my + h / 2 };
        if (!placed.some(other => overlap(inside, other) > 0)) {
          placed.push(inside);
          drawCallout(ctx, item, mx, my, w, h, false);
          continue;
        }
      }
      // Outside: 8 directions × 3 distances around the block.
      let best: { x: number; y: number; cost: number } | undefined;
      for (const distance of [26, 52, 90]) for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 - Math.PI / 2;
        const x = mx + Math.cos(a) * (bw / 2 + distance + w / 2 - 10), y = my + Math.sin(a) * (bh / 2 + distance + h / 2 - 4);
        const cand = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
        const area = w * h;
        let cost = distance / 260;
        if (cand.x0 < 4 || cand.y0 < 4 || cand.x1 > vp.width - 4 || cand.y1 > vp.height - 4) cost += 4;
        for (const other of placed) cost += 10 * overlap(cand, other) / area;
        for (const other of avoid) cost += 4 * overlap(cand, other) / area;
        for (const other of blocks) cost += 2 * overlap(cand, other) / area;
        for (const other of lines) cost += 0.8 * overlap(cand, other) / area;
        if (!best || cost < best.cost) best = { x, y, cost };
      }
      if (!best) continue;
      placed.push({ x0: best.x - w / 2, y0: best.y - h / 2, x1: best.x + w / 2, y1: best.y + h / 2 });
      // Marker: a ring the size of the block, never smaller than 9 px, pulsing when the block is tiny.
      const r = Math.max(9, Math.max(bw, bh) / 2 + 3);
      const tiny = Math.max(bw, bh) < 14;
      ctx.strokeStyle = '#ffd68c'; ctx.lineWidth = 1.6;
      if (tiny || item.container) {
        if (tiny) { ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.stroke(); const pulse = (performance.now() % 1400) / 1400; ctx.globalAlpha = 1 - pulse; ctx.beginPath(); ctx.arc(mx, my, r + pulse * 12, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
      }
      // Leader: from the block's edge (or the marker) to the label's nearest side.
      const ex = Math.max(best.x - w / 2, Math.min(best.x + w / 2, mx)), ey = Math.max(best.y - h / 2, Math.min(best.y + h / 2, my));
      const angle = Math.atan2(ey - my, ex - mx);
      const sx = tiny ? mx + Math.cos(angle) * r : Math.max(box.x0, Math.min(box.x1, ex)), sy = tiny ? my + Math.sin(angle) * r : Math.max(box.y0, Math.min(box.y1, ey));
      ctx.strokeStyle = 'rgba(255,214,140,0.85)'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = '#ffd68c'; ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
      drawCallout(ctx, item, best.x, best.y, w, h, true);
    }
    ctx.restore();
    return placed;
  }
  function drawCallout(ctx: CanvasRenderingContext2D, item: { name: string; sub: string }, x: number, y: number, w: number, h: number, pillShape: boolean) {
    ctx.textAlign = 'center';
    if (pillShape) {
      ctx.fillStyle = 'rgba(12,14,24,0.94)'; ctx.strokeStyle = '#ffd68c'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 8); ctx.fill(); ctx.stroke();
    }
    const nameY = item.sub ? y - 6.5 : y + 0.5;
    ctx.font = `800 12px ${FONT}`; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,18,0.8)'; ctx.fillStyle = '#fff7e6';
    if (!pillShape) ctx.strokeText(item.name, x, nameY);
    ctx.fillText(item.name, x, nameY);
    if (item.sub) {
      ctx.font = `600 10px ${FONT}`; ctx.fillStyle = '#e6c58c';
      if (!pillShape) ctx.strokeText(item.sub, x, y + 8);
      ctx.fillText(item.sub, x, y + 8);
    }
  }

  function captions(ctx: CanvasRenderingContext2D, vp: Viewport, cam: Camera, items: { id: string; rect: N['rect']; zTop: number }[], t: number, at?: (x: number, y: number, z: number) => { x: number; y: number }) {
    if (!shown!.captions.size) return;
    const byId = new Map(items.map(item => [item.id, item]));
    for (const [id, caption] of shown!.captions) {
      const item = byId.get(id);
      if (!item) continue;
      const point = at ? at(item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h / 2, item.zTop) : worldToScreen(cam, vp, item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h / 2, item.zTop);
      pill(ctx, caption, point.x, point.y - 22, { color: '#ffd68c', alpha: 0.4 + 0.6 * t });
    }
  }

  const tourScene = which === 'tour' ? TOUR[sceneIndex] : undefined;
  return (
    <div className="proto-stage">
      <canvas ref={drawRef} className="proto-canvas" />
      <aside className="proto-panel">
        <p className="proto-kicker">Prototype 1 · Focus layout</p>
        <div className="proto-row">
          {(['tour', 'pull', 'deep'] as const).map(id => <button key={id} className={which === id ? 'on' : ''} onClick={() => { setWhich(id); setScene(0); }}>{id === 'tour' ? 'Tree-sitter tour' : id === 'pull' ? 'Real PR' : 'Deep link'}</button>)}
        </div>
        <h2>{shown?.title ?? 'Loading…'}</h2>
        <p className="proto-text">{shown?.text}</p>
        {tourScene ? (
          <div className="proto-row">
            <button disabled={sceneIndex === 0} onClick={() => setScene(s => s - 1)}>↑ Previous</button>
            <button disabled={sceneIndex === TOUR.length - 1} onClick={() => setScene(s => s + 1)}>↓ Next</button>
            <span className="proto-dots">{TOUR.map((_, i) => <i key={i} className={i === sceneIndex ? 'on' : ''} />)}</span>
          </div>
        ) : null}
        <div className="proto-row">
          <button onClick={() => setReplay(r => r + 1)}>↻ Replay from the map</button>
          {variant !== 'D' ? <button onClick={() => setFold(f => (f === 'tile' ? 'drop' : 'tile'))}>Siblings: {fold === 'tile' ? '+N tiles' : 'dropped'}</button> : null}
          {variant === 'B' ? <button onClick={() => setPlan(v => !v)}>{plan ? '⤢ Tilt to iso' : '⤓ Flatten to plan'}</button> : null}
          <button onClick={() => setLabelMode(m => (m === 'placed' ? 'numbered' : m === 'numbered' ? 'line' : 'placed'))}>Arrow labels: {labelMode === 'placed' ? 'placed' : labelMode === 'numbered' ? 'numbered' : 'on the line (before)'}</button>
        </div>
        <p className="proto-hint">Wheel to zoom, drag to pan once it settles. ← → switch variants{which === 'tour' ? ', ↑ ↓ step scenes' : ''}.</p>
      </aside>
      <pre className="proto-readout">{readout.join('\n')}</pre>
    </div>
  );
}

function labelsOnly(ctx: CanvasRenderingContext2D, vp: Viewport, cam: Camera, arrows: ReturnType<typeof routeArrows>, options: ArrowLabelOptions) {
  // drawArrows without the strokes: labels only (the app renderer draws the rails, with occlusion).
  drawArrows(ctx, vp, cam, 0, arrows.map(arrow => ({ ...arrow, width: 0 })), 1, undefined, 0, options);
}
/** The panel (top left) and the readout (bottom right) cover the canvas: labels keep off them. */
function panels(vp: Viewport): Box[] {
  return [{ x0: 0, y0: 0, x1: 366, y1: 340 }, { x0: vp.width - 380, y0: vp.height - 190, x1: vp.width, y1: vp.height }, { x0: vp.width / 2 - 240, y0: vp.height - 70, x1: vp.width / 2 + 240, y1: vp.height }];
}

function describe(index: MapIndex, focus: Focus, shown: Shown): string[] {
  const rects = focus.rects;
  let backward = 0, detour = 0;
  for (const arrow of shown.arrows) {
    const a = rects.get(arrow.from), b = rects.get(arrow.to);
    if (!a || !b) continue;
    if (b.y + b.h / 2 < a.y + a.h / 2 - 4 || (Math.abs(b.y - a.y) < 4 && b.x < a.x)) backward++;
    detour += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  const depths = shown.interest.map(id => index.ancestors(id).length);
  return [
    `interest       ${shown.interest.length} (depth ${Math.min(...depths)}–${Math.max(...depths)})`,
    `cut            ${focus.nodes.filter(n => !n.id.startsWith('tile:')).length} nodes, ${focus.tiles.size} +N tiles`,
    `merged chains  ${[...focus.merged.entries()].map(([head, rest]) => `${index.byId.get(head)!.name}/…(${rest.length})`).join(', ') || '—'}`,
    `focus size     ${Math.round(focus.bounds.w)} × ${Math.round(focus.bounds.h)} units (map: 4355 × 3330)`,
    `arrows         ${shown.arrows.length}, ${backward} against reading order`,
    `arrow span     ${Math.round(detour)} units (manhattan, center to center)`,
  ];
}
