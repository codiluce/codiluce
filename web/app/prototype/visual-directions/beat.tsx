'use client';
// PROTOTYPE (throwaway) — question: can one real commit read as clearly as the
// landing page's History scene? One *beat* per commit: a card, then removals
// sink, additions grow, modifications pulse, changed links draw in, labels
// settle. Three variants that disagree on the stage:
//   A  In place: the real map (timeline layout), the changed files' areas forced open, the camera flies to them.
//   B  Stage (iso): the focus layout of the changed files, gathered from the map; the app renderer.
//   C  Stage (plan) + ledger: the stage as a flat plan, a ledger in step, and the author performing the beat.
// Real commits of this repository from the history index (port 4301 at capture time).
import { useEffect, useMemo, useRef, useState } from 'react';
import { toScreen, worldToScreen, type Camera, type Viewport } from '../../../lib/camera';
import { DEFAULT_LOD } from '../../../lib/lod';
import type { EdgeOverlay, MotionState } from '../../../lib/renderer';
import { applyAlpha, clamp01, containersOf, ease, fitInStage, fitIso, focusFrame, focusLayout, lerpCamera, loadJson, makeRenderer, MapIndex, mapFrame, morph, pill, renderState, sceneOf, STAGE, theme, useCanvas, type Frame, type N } from './kit';
import { boundsOf, drawArrows, drawFrame, projector, routeArrows, type Arrow, type Drawn } from './plan';
import { drawBuddy, drawPerson, drawShadow, type Pose } from './characters';

interface Commit {
  sha: string; subject: string; author: string; date: string; coAuthors: string[];
  files: { files: number; added: number; modified: number; removed: number; moved: number; insertions: number; deletions: number };
  stat: { added: number; removed: number; path: string }[];
  changes: N[]; relations: { from: string; to: string; type: string; change: 'added' | 'removed' }[];
  map: { nodes: N[] };
}
type Status = 'added' | 'modified' | 'removed' | 'moved';
interface Beat { id: string; path: string; name: string; status: Status; at: number; lines: { added: number; removed: number }; facets: string[]; symbols?: N['changes']; visit?: boolean }
interface Plan { beats: Beat[]; byId: Map<string, Beat>; t0: number; relationsAt: number; end: number; relations: (Commit['relations'][number] & { at: number })[]; visits: Beat[] }

const GLYPH: Record<Status, string> = { added: '+ ', modified: '~ ', removed: '− ', moved: '→ ' };
const TINT: Record<Status, string> = { added: 'hsl(142 52% 42%)', modified: 'hsl(40 80% 48%)', removed: 'hsl(350 62% 46%)', moved: 'hsl(272 55% 58%)' };
const PRELUDE: Record<string, number> = { A: 1300, B: 2000, C: 2300 };
const VISIT = 560, HOP = 320;

function planFor(commit: Commit, index: MapIndex, variant: string): Plan {
  const lines = new Map(commit.stat.map(s => [s.path, s]));
  const files = commit.changes.filter(node => node.type === 'file' && node.change && node.change.status !== 'unchanged' && index.byId.has(node.id));
  const weight = (node: N) => { const s = lines.get(node.path ?? ''); return (s?.added ?? 0) + (s?.removed ?? 0) + 5 * ((node.changes?.added ?? 0) + (node.changes?.modified ?? 0) + (node.changes?.removed ?? 0)); };
  const group = (status: Status) => files.filter(node => node.change!.status === status).sort((a, b) => weight(b) - weight(a));
  const ordered = [...group('removed'), ...group('moved'), ...group('added'), ...group('modified')];
  const t0 = PRELUDE[variant] ?? 1300;
  const beats: Beat[] = [];
  const make = (node: N, at: number): Beat => ({ id: node.id, path: node.path ?? node.name, name: node.name, status: node.change!.status as Status, at, lines: { added: lines.get(node.path ?? '')?.added ?? 0, removed: lines.get(node.path ?? '')?.removed ?? 0 }, facets: (node.change!.facets ?? []).filter(f => f !== 'source' && f !== 'size' && f !== 'diagnostics'), ...(node.changes ? { symbols: node.changes } : {}) });
  if (variant === 'C') {
    // Performed: the author visits the most significant files one by one; the rest land together at the end.
    const visits = [...ordered].sort((a, b) => weight(b) - weight(a)).slice(0, 7);
    const visitOrder = ordered.filter(node => visits.includes(node));
    visitOrder.forEach((node, i) => beats.push({ ...make(node, t0 + i * VISIT + HOP), visit: true }));
    const rest = ordered.filter(node => !visits.includes(node));
    const after = t0 + visitOrder.length * VISIT + 200;
    rest.forEach((node, i) => beats.push(make(node, after + i * Math.min(70, 1000 / Math.max(1, rest.length)))));
  } else {
    let t = t0;
    for (const status of ['removed', 'moved', 'added', 'modified'] as Status[]) {
      const list = ordered.filter(node => node.change!.status === status);
      if (!list.length) continue;
      const step = Math.min(110, 1300 / list.length);
      list.forEach((node, i) => beats.push(make(node, t + i * step)));
      t += list.length * step + 300;
    }
  }
  const last = Math.max(...beats.map(b => b.at), t0);
  const known = new Set(beats.map(b => b.id));
  const relations = commit.relations.filter((r, i, all) => known.has(r.from) && known.has(r.to) && all.findIndex(o => o.from === r.from && o.to === r.to && o.change === r.change) === i).slice(0, 24).map((r, i) => ({ ...r, at: last + 500 + i * 70 }));
  const relationsAt = last + 500;
  return { beats, byId: new Map(beats.map(b => [b.id, b])), t0, relationsAt, relations, end: relationsAt + relations.length * 70 + 1800, visits: beats.filter(b => b.visit) };
}
/** One line about the commit from the indexed changes (no model call). */
function changeLine(commit: Commit, plan: Plan): string {
  const by = (status: Status) => plan.beats.filter(b => b.status === status);
  const count = new Map<string, number>(); for (const b of plan.beats) count.set(b.name, (count.get(b.name) ?? 0) + 1);
  const label = (b: Beat) => (count.get(b.name)! > 1 ? b.path.split('/').slice(-2).join('/') : b.name);
  const names = (list: Beat[], n = 2) => list.slice(0, n).map(label).join(', ') + (list.length > n ? ` and ${list.length - n} more` : '');
  const parts: string[] = [];
  if (by('added').length) parts.push(`adds ${names(by('added'))}`);
  if (by('removed').length) parts.push(`removes ${names(by('removed'))}`);
  const modified = [...by('modified')].sort((a, b) => ((b.symbols?.added ?? 0) + (b.symbols?.modified ?? 0)) - ((a.symbols?.added ?? 0) + (a.symbols?.modified ?? 0)));
  if (modified[0]) {
    const s = modified[0].symbols;
    const what = s ? [s.added ? `${s.added} new` : '', s.modified ? `${s.modified} changed` : '', s.removed ? `${s.removed} removed` : ''].filter(Boolean).join(', ') : '';
    parts.push(`changes ${label(modified[0])}${what ? ` (${what} symbols)` : ''}${modified.length > 1 ? ` and ${modified.length - 1} more files` : ''}`);
  }
  const links = commit.relations.filter(r => r.change === 'added').length, gone = commit.relations.filter(r => r.change === 'removed').length;
  if (links || gone) parts.push(`${links ? `+${links}` : ''}${links && gone ? ' / ' : ''}${gone ? `−${gone}` : ''} links between them`);
  return parts.join('; ');
}
const agentOf = (commit: Commit) => (commit.coAuthors.some(a => /anthropic|claude/i.test(a)) ? 'claude-code' : commit.coAuthors.some(a => /openai|codex/i.test(a)) ? 'codex' : undefined);

export function BeatPrototype({ variant }: { variant: string }) {
  const [commits, setCommits] = useState<Commit[]>();
  const [which, setWhich] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [replay, setReplay] = useState(0);
  const [auto, setAuto] = useState(false);
  const [readout, setReadout] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(0);
  useEffect(() => { void loadJson<Commit[]>('commits').then(setCommits); }, []);
  const commit = commits?.[which];
  const index = useMemo(() => (commit ? new MapIndex(commit.map.nodes) : undefined), [commit]);
  const plan = useMemo(() => (commit && index ? planFor(commit, index, variant) : undefined), [commit, index, variant]);
  const stage = useMemo(() => (index && plan ? focusLayout(index, plan.beats.map(b => b.id), { fold: 'tile', fileSide: [48, 104] }) : undefined), [index, plan]);
  const fileOf = useMemo(() => {
    const map = new Map<string, string>();
    if (!index) return map;
    for (const node of index.nodes) {
      if (node.type === 'file') { map.set(node.id, node.id); continue; }
      for (let p = node.spatialParentId; p; p = index.byId.get(p)?.spatialParentId) if (index.byId.get(p)?.type === 'file') { map.set(node.id, p); break; }
    }
    return map;
  }, [index]);
  const renderer = useMemo(() => makeRenderer(), []);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 0.2 });
  const clock = useRef({ tau: 0, last: 0, start: 0 });
  const userMoved = useRef(false);
  const settings = useRef({ speed, auto });
  settings.current = { speed, auto };
  const motion = useRef<MotionState>({ appear: new Map(), flash: new Map() });
  useEffect(() => { clock.current = { tau: 0, last: performance.now(), start: performance.now() }; userMoved.current = false; }, [plan, replay]);
  useEffect(() => () => { STAGE.right = 0; STAGE.top = 0; }, []);

  /** Nodes as they are at beat time `tau`: added ones absent until they land, changes shown once revealed. */
  function atTime(nodes: N[], tau: number): Frame {
    const out: N[] = [], alpha = new Map<string, number>();
    for (const node of nodes) {
      const file = fileOf.get(node.id), beat = file ? plan!.byId.get(file) : undefined;
      if (!beat) { out.push(node.change ? { ...node, change: undefined } : node); continue; }
      const shown = tau >= beat.at;
      if (!shown && (beat.status === 'added' || node.change?.status === 'added')) continue;
      if (!shown) { out.push({ ...node, change: undefined }); continue; }
      out.push(node);
      if (beat.status === 'removed' && node.id === beat.id) alpha.set(node.id, 1 - 0.65 * clamp01((tau - beat.at) / 700));
    }
    return { nodes: out, alpha };
  }

  const drawRef = useCanvas(({ ctx, viewport, time }) => {
    if (!commit || !index || !plan || !stage) { ctx.fillStyle = theme.background[0]; ctx.fillRect(0, 0, viewport.width, viewport.height); return; }
    const s = settings.current;
    const dt = Math.min(100, time - clock.current.last); clock.current.last = time;
    clock.current.tau += dt * s.speed;
    const tau = clock.current.tau;
    if (s.auto && tau > plan.end + 1200 && commits) { setWhich(w => (w + 1) % commits.length); clock.current.tau = -1e9; }
    STAGE.right = variant === 'C' ? 350 : 0; STAGE.top = 150;
    // Renderer motion: rises and flashes keyed to the beat clock.
    motion.current.appear.clear(); motion.current.flash.clear();
    for (const beat of plan.beats) {
      if (tau < beat.at) continue;
      const start = time - (tau - beat.at) / s.speed;
      if (beat.status === 'added') motion.current.appear.set(beat.id, start);
      if (beat.status === 'modified') motion.current.flash.set(beat.id, start);
    }
    const relations = plan.relations.filter(r => tau >= r.at);
    if (variant === 'C') drawPlanStage(ctx, viewport, time, tau, relations);
    else drawIso(ctx, viewport, time, tau, relations);
    if (Math.floor(time / 200) !== Math.floor((time - dt) / 200)) {
      const done = plan.beats.filter(b => tau >= b.at).length;
      setRevealed(done);
      const phase = tau < plan.t0 ? (variant === 'A' ? 'flying to the changes' : 'gathering the stage') : done < plan.beats.length ? `${plan.beats.find(b => tau < b.at)?.status ?? ''} files` : tau < plan.relationsAt + plan.relations.length * 70 ? 'links' : 'settled';
      setReadout([
        `beat clock   ${(Math.max(0, tau) / 1000).toFixed(1)} s of ${(plan.end / 1000).toFixed(1)} s (${s.speed}×)`,
        `phase        ${phase}`,
        `revealed     ${done}/${plan.beats.length} files, ${relations.length}/${plan.relations.length} links`,
        `stage        ${Math.round(stage.bounds.w)} × ${Math.round(stage.bounds.h)} units, ${stage.tiles.size} +N tiles`,
      ]);
    }
  }, camera, () => { userMoved.current = true; });

  function drawIso(ctx: CanvasRenderingContext2D, vp: Viewport, time: number, tau: number, relations: Plan['relations']) {
    const changedRects = plan!.beats.map(b => index!.byId.get(b.id)!.rect);
    const overview = fitIso([index!.root.rect], vp, 40), onChanges = fitIso(changedRects, vp, 90), onStage = fitIso([stage!.bounds], vp, 60);
    let frame: Frame;
    if (variant === 'A') {
      if (!userMoved.current) camera.current = lerpCamera(overview, onChanges, ease(clamp01(tau / plan!.t0)));
      frame = atTime(index!.nodes, tau);
    } else {
      const k = clamp01((tau - 600) / 1300);
      if (!userMoved.current) camera.current = lerpCamera(onChanges, onStage, ease(k));
      const base = k <= 0 ? mapFrame(index!) : k >= 1 ? focusFrame(stage!) : morph(mapFrame(index!), focusFrame(stage!), k);
      frame = atTime(base.nodes, tau);
      for (const [id, a] of base.alpha) frame.alpha.set(id, (frame.alpha.get(id) ?? 1) * a);
    }
    const scene = sceneOf(frame.nodes, index!.root.id);
    const force = variant === 'A' ? new Set(plan!.beats.flatMap(b => index!.ancestors(b.id))) : containersOf(stage!.nodes);
    const set = scene.visible(camera.current, vp, DEFAULT_LOD, force);
    applyAlpha(set, frame);
    // Removed files sink into the ground.
    for (const item of set.items) {
      const beat = plan!.byId.get(item.node.id);
      if (beat?.status === 'removed' && tau >= beat.at) { const k = clamp01((tau - beat.at) / 700); item.zTop = item.zBase + (item.zTop - item.zBase) * (1 - ease(k)) + 0.4; }
    }
    const edges: EdgeOverlay[] = relations.map(r => ({ key: `${r.from}>${r.to}>${r.change}`, from: r.from, to: r.to, fromAncestors: index!.ancestors(r.from), toAncestors: index!.ancestors(r.to), type: r.type, count: 1, change: r.change }));
    renderer.render(ctx, window.devicePixelRatio || 1, vp, camera.current, scene, set, renderState(time, { edges, comparison: { dimUnchanged: variant === 'A' }, motion: motion.current }), DEFAULT_LOD);
    // Callouts on the changed files (A: the labels are too small at this zoom), facet chips (B).
    const shown = plan!.beats.filter(b => tau >= b.at).sort((a, b) => b.lines.added + b.lines.removed - (a.lines.added + a.lines.removed));
    const top = variant === 'A' ? shown.slice(0, 10) : shown.filter(b => b.facets.length || b.status !== 'modified');
    for (const beat of top) {
      const item = set.items[set.index.get(beat.id) ?? -1] ?? scene.representative(beat.id, set);
      if (!item) continue;
      const r = item.node.rect, p = worldToScreen(camera.current, vp, r.x + r.w / 2, r.y + r.h / 2, item.zTop);
      const age = tau - beat.at;
      const text = variant === 'A' ? `${GLYPH[beat.status]}${beat.name}${beat.lines.added || beat.lines.removed ? `  +${beat.lines.added} −${beat.lines.removed}` : ''}` : beat.facets.length ? beat.facets.join(' · ') : `+${beat.lines.added} −${beat.lines.removed}`;
      pill(ctx, text, p.x, p.y - (variant === 'A' ? 18 : 30) - Math.max(0, 1 - age / 250) * 8, { color: theme.change[beat.status], size: variant === 'A' ? 11 : 9.5, alpha: clamp01(age / 250) });
    }
    if (variant === 'A' && shown.length > 10) pill(ctx, `and ${shown.length - 10} more changed files`, vp.width / 2 + STAGE.left / 2, vp.height - 110, { size: 11 });
  }

  function drawPlanStage(ctx: CanvasRenderingContext2D, vp: Viewport, time: number, tau: number, relations: Plan['relations']) {
    const gradient = ctx.createLinearGradient(0, 0, 0, vp.height);
    gradient.addColorStop(0, theme.background[0]); gradient.addColorStop(1, theme.background[1]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, vp.width, vp.height);
    const tilt = ease(clamp01((tau - 600) / 700));
    const k = clamp01((tau - 900) / 1300);
    const fit = (rects: N['rect'][], pad: number) => fitInStage(boundsOf(rects, projector(tilt), 20), vp, pad);
    const changedRects = plan!.beats.map(b => index!.byId.get(b.id)!.rect);
    if (!userMoved.current) camera.current = lerpCamera(fit(changedRects, 90), fit([stage!.bounds], 50), ease(k));
    const base = k <= 0 ? mapFrame(index!) : k >= 1 ? focusFrame(stage!) : morph(mapFrame(index!), focusFrame(stage!), k);
    const frame = atTime(base.nodes, tau);
    for (const [id, a] of base.alpha) frame.alpha.set(id, (frame.alpha.get(id) ?? 1) * a);
    for (const beat of plan!.beats) if (beat.status === 'added' && tau >= beat.at) frame.alpha.set(beat.id, clamp01((tau - beat.at) / 300));
    const statusOf = (node: N) => { const file = fileOf.get(node.id); const beat = file ? plan!.byId.get(file) : undefined; return beat && tau >= beat.at ? (node.id === beat.id ? beat.status : (node.change?.status as Status | undefined)) : undefined; };
    const drawn = drawFrame(ctx, vp, camera.current, frame, {
      tilt, force: containersOf(stage!.nodes), labels: true,
      tint: node => { const st = statusOf(node); return st && st !== ('unchanged' as Status) ? TINT[st] : undefined; },
      ring: node => { const beat = plan!.byId.get(node.id); if (!beat || tau < beat.at) return undefined; const age = tau - beat.at; return age < 900 ? { color: theme.change[beat.status], width: 3 * (1 - age / 900) + 1 } : beat.status === 'removed' ? { color: theme.change.removed, width: 1.2, dash: [4, 3] } : undefined; },
      glyph: node => { const beat = plan!.byId.get(node.id); return beat && tau >= beat.at ? GLYPH[beat.status] : ''; },
    });
    const arrows: Arrow[] = relations.map(r => ({ from: r.from, to: r.to, chip: r.type, color: r.change === 'added' ? theme.change.added : theme.change.removed, ...(r.change === 'removed' ? { dash: [4, 4] } : {}), width: 1.6 }));
    if (arrows.length && tilt > 0.95) drawArrows(ctx, vp, camera.current, tilt, routeArrows(drawn, arrows), 1, undefined, time);
    performer(ctx, vp, drawn, tau, time, tilt);
  }

  /** The author performs the beat: hops to each visited file, with a hammer (added), notebook (changed) or eraser (removed). */
  function performer(ctx: CanvasRenderingContext2D, vp: Viewport, drawn: Map<string, Drawn>, tau: number, time: number, tilt: number) {
    const visits = plan!.visits;
    if (!visits.length || tau < plan!.t0 - 300) return;
    const project = projector(tilt);
    // A file that has not landed yet is not drawn: aim at its place on the stage (it used to vanish there, a flicker).
    const at = (id: string) => {
      const d = drawn.get(id);
      if (d) return toScreen(camera.current, vp, project(d.rect.x + d.rect.w / 2, d.rect.y + d.rect.h / 2, d.zTop));
      const r = stage!.rects.get(id), parent = index!.byId.get(id)?.spatialParentId;
      const floor = [parent, ...index!.ancestors(id).reverse()].map(a => (a ? drawn.get(a) : undefined)).find(Boolean);
      return r ? toScreen(camera.current, vp, project(r.x + r.w / 2, r.y + r.h / 2, floor?.zTop ?? 0)) : undefined;
    };
    const i = Math.max(0, Math.min(visits.length - 1, Math.floor((tau - plan!.t0) / VISIT)));
    const local = tau - plan!.t0 - i * VISIT;
    const to = at(visits[i]!.id), from = i > 0 ? at(visits[i - 1]!.id) : undefined;
    if (!to) return;
    let x = to.x, y = to.y, ground = to.y, pose: Pose = visits[i]!.status === 'added' ? 'build' : visits[i]!.status === 'removed' ? 'erase' : 'edit', facing: 1 | -1 = 1;
    if (from && local < HOP) {
      const p = ease(local / HOP);
      x = from.x + (to.x - from.x) * p; ground = from.y + (to.y - from.y) * p; y = ground - Math.sin(p * Math.PI) * 60; pose = 'idle'; facing = to.x >= from.x ? 1 : -1;
    }
    const after = tau > plan!.t0 + visits.length * VISIT;
    if (after) pose = tau > plan!.end - 1200 ? 'wave' : 'idle';
    const size = 54;
    drawShadow(ctx, x, ground, size, ground - y);
    const agent = agentOf(commit!);
    if (agent) drawBuddy(ctx, x, y, { provider: agent, color: 'hsl(48 90% 60%)', size, facing, pose, poseAge: local, time, stretch: 1, alpha: 1, seed: 3 });
    const initials = commit!.author.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    // A person avatar: performing for a human-only commit, or standing beside the agent.
    if (agent) drawPerson(ctx, x - 34, ground + 4, 40, initials, 28, 'idle', time, 0.95);
    else drawPerson(ctx, x, y, size, initials, 28, pose, time);
  }

  const counts = commit?.files;
  const agent = commit ? agentOf(commit) : undefined;
  const cardKey = `${commit?.sha}-${replay}`;
  const [cardIn, setCardIn] = useState(false);
  useEffect(() => { setCardIn(false); const timer = setTimeout(() => setCardIn(true), 60); return () => clearTimeout(timer); }, [cardKey]);
  return (
    <div className="proto-stage">
      <canvas ref={drawRef} className="proto-canvas" />
      <aside className="proto-panel">
        <p className="proto-kicker">Prototype 3 · Commit beat</p>
        <h2>{variant === 'A' ? 'In place, on the real map' : variant === 'B' ? 'On a stage (iso)' : 'On a stage (plan), with a ledger and the author'}</h2>
        <div className="proto-row">
          {commits?.map((c, i) => <button key={c.sha} className={i === which ? 'on' : ''} onClick={() => { setWhich(i); setReplay(r => r + 1); }}>{c.sha.slice(0, 7)}</button>)}
        </div>
        <div className="proto-row">
          <button onClick={() => setReplay(r => r + 1)}>↻ Replay</button>
          <button onClick={() => setSpeed(v => (v === 1 ? 2 : v === 2 ? 0.5 : 1))}>{speed}×</button>
          <button className={auto ? 'on' : ''} onClick={() => setAuto(a => !a)}>Play all in turn</button>
        </div>
        <p className="proto-text">Real commits of this repository, from its history index. Removed files sink, added ones grow, changed ones pulse; links the commit changed draw in last.</p>
        <p className="proto-hint">Wheel to zoom, drag to pan. ← → switch variants.</p>
      </aside>
      {commit && counts && plan ? (
        <section className={`proto-card${cardIn ? '' : ' enter'}`} key={cardKey}>
          <div className="meta"><span className="mono">{commit.sha.slice(0, 7)}</span><span>{commit.author}{agent ? <> with <span className="tag">{agent === 'claude-code' ? 'Claude Code' : 'Codex'}</span></> : null}</span><span>{new Date(commit.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
          <h2>{commit.subject}</h2>
          <div className="meta counts">
            {counts.added ? <b className="add">+{counts.added} added</b> : null}
            {counts.modified ? <b className="mod">~{counts.modified} changed</b> : null}
            {counts.removed ? <b className="del">−{counts.removed} removed</b> : null}
            <span>· +{counts.insertions.toLocaleString()} −{counts.deletions.toLocaleString()} lines · {revealed}/{plan.beats.length} shown</span>
          </div>
          <p className="line">{changeLine(commit, plan)}</p>
        </section>
      ) : null}
      {variant === 'C' && plan ? (
        <aside className="proto-ledger">
          <h3 style={{ margin: '0 0 8px', fontSize: 12 }}>Ledger</h3>
          <ol>
            {[...plan.beats].sort((a, b) => a.at - b.at).map(beat => {
              const done = clock.current.tau >= beat.at, now = done && clock.current.tau - beat.at < 700;
              return <li key={beat.id} className={now ? 'now' : done ? 'done' : ''}><span className={beat.status === 'added' ? 'add' : beat.status === 'removed' ? 'del' : beat.status === 'moved' ? 'mov' : 'mod'}>{GLYPH[beat.status].trim()}</span><span title={beat.path}>{beat.path.length > 30 ? `…${beat.path.slice(-29)}` : beat.path}</span><em>{beat.facets.length ? beat.facets.join(',') : `+${beat.lines.added} −${beat.lines.removed}`}</em></li>;
            })}
          </ol>
        </aside>
      ) : null}
      <pre className="proto-readout" style={variant === 'C' ? { right: 360 } : undefined}>{readout.join('\n')}</pre>
    </div>
  );
}
