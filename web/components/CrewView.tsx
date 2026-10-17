'use client';
// Agents at work: every observed session as a pixel character on the map, in
// the middle. It hops to the files it is reported at (copies split off for
// parallel reads) and steps outside, onto a mat beside the map's edge, for
// what is about no file: thinking, writing the reply, planning, the web, a
// command, waiting for permission, resting. The map is drawn in its
// projection (Settings, Views): in plan with nothing re-sorted, the areas
// holding their files open as nested frames (`map-plan`), or isometric, where
// they hop from roof to roof (`hop`). A ledger lists what was observed,
// newest first.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEvent } from '@engine/activity/model';
import type { Rect } from '@engine/projection/dto';
import { toScreen, worldToScreen, type Bounds, type Camera, type Viewport } from '../lib/camera';
import { agentColor } from '../lib/activity';
import { Cast, crewEvent, replayEvents, YARD, type Actor, type Move } from '../lib/crew';
import { ancestorsOf, clamp01, ease, sceneHierarchy } from '../lib/focus-layout';
import { ensureNodes } from '../lib/focus-set';
import { DEFAULT_LOD } from '../lib/lod';
import { boundsOf, drawCallouts, drawPlan, hitPlan, inkFor, pill, projector, sceneTree, screenBox, whereOf, type Drawn, type Ink } from '../lib/plan';
import { placeLabels } from '../lib/labels';
import { drawPixel, drawShadow, drawYard, POSE_LABEL, sparkle, type Look } from '../lib/pixel-crew';
import { MapRenderer } from '../lib/renderer';
import { nodeHeight, type VisibleSet } from '../lib/scene';
import { PaletteCache, themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { FaceIcon, fitInStage, lerpCamera, NARROW, reducedMotion, stageStyles as styles, useStage, type Insets } from './Stage';

/** What the panel and the ledger cover: beside the map when the middle is wide, the ledger under it otherwise. */
const insetsFor = (viewport: Viewport): Insets => viewport.width >= NARROW ? { left: 290, right: 290, top: 16, bottom: 16 } : viewport.width >= 640 ? { left: 280, right: 16, top: 16, bottom: viewport.height * 0.3 + 12 } : { left: 16, right: 16, top: 320, bottom: viewport.height * 0.3 + 12 };
/** Sessions seen within this long are on the map when the tool opens, at their latest place. */
const RECENT_MS = 5 * 60_000;
interface Point { x: number; y: number }
interface Anchor extends Point { rect: Rect; z: number }

export function CrewView() {
  const store = useStore();
  const open = useAtlas(state => state.crewView);
  const projection = useAtlas(state => state.views.map === 'plan' ? 'map-plan' : 'hop');
  const snapshot = useAtlas(state => state.agents.snapshot);
  const connected = useAtlas(state => state.agents.connected);
  const themeId = useAtlas(state => state.themeId);
  const theme = themeById(themeId);
  const renderer = useMemo(() => new MapRenderer(theme), [theme]);
  const palettes = useMemo(() => new PaletteCache(theme), [theme]);
  const ink = useMemo(() => inkFor(theme), [theme]);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 0.05 });
  const autoFrame = useRef(true);
  const [framing, setFraming] = useState(true);
  const clock = useRef({ now: 0, last: 0 });
  const seen = useRef(new Set<string>());
  const replaying = useRef<number | undefined>(undefined);
  const [replay, setReplay] = useState(false);
  // Bumped after a replay: the live cast is seeded again from what is happening now.
  const [epoch, setEpoch] = useState(0);
  const fitted = useRef(false);
  const requested = useRef(new Set<string>());
  const asked = useRef(new Map<string, number>());
  const last = useRef<{ order: Drawn[]; set?: VisibleSet }>({ order: [] });
  const cast = useMemo(() => new Cast(
    id => store.scene.nodes.get(id)?.rect,
    () => (store.scene.rootId ? store.scene.nodes.get(store.scene.rootId)?.rect : undefined),
    agentColor, true,
  ), [store]);
  const [legend, setLegend] = useState<{ key: string; color: string; provider: Actor['provider']; title: string; pose: Actor['pose']; mini: boolean; outside: boolean }[]>([]);
  const [ledger, setLedger] = useState<{ id: string; actor: string; provider: Actor['provider']; label: string; at: number }[]>([]);

  const load = (id: string) => { const now = performance.now(); if (now - (asked.current.get(id) ?? -1e9) < 4000) return; asked.current.set(id, now); void store.loadChildren([id]); };
  const ensure = (events: ActivityEvent[]) => {
    const ids: string[] = [], areas: string[] = [];
    for (const event of events) for (const path of event.paths) if (path.id && !requested.current.has(path.id)) { requested.current.add(path.id); ids.push(path.id); areas.push(...path.ancestors ?? []); }
    if (ids.length) void ensureNodes(store, ids, areas).catch(() => undefined);
  };
  // Live: new observations join the cast as they arrive; on opening, recent sessions start where they are.
  useEffect(() => {
    if (!open || !snapshot || replaying.current !== undefined) return;
    const sessions = snapshot.sessions;
    const fresh = snapshot.events.filter(event => !seen.current.has(event.id)).sort((a, b) => a.at - b.at);
    if (!fresh.length) return;
    const first = seen.current.size === 0;
    fresh.forEach(event => seen.current.add(event.id));
    ensure(fresh);
    const now = clock.current.now;
    if (first) {
      // Already done: applied at once, in the past, so nobody walks in.
      const recent = new Set(sessions.filter(session => Date.now() - session.lastSeen <= RECENT_MS && session.status !== 'finished').map(session => session.actor));
      const events = fresh.filter(event => recent.has(event.actor) && Date.now() - event.at <= RECENT_MS);
      cast.push(events.flatMap((event, i) => { const ev = crewEvent(event, now - 60_000 + i, sessions); return ev ? [ev] : []; }));
      return;
    }
    cast.push(fresh.flatMap((event, i) => { const ev = crewEvent(event, now + i * 120, sessions); return ev ? [ev] : []; }));
  }, [open, snapshot, cast, store, epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const startReplay = () => {
    if (!snapshot) return;
    // The sessions that touched files on this map, most recent first (others only run commands, all outside).
    const sorted = [...snapshot.events].sort((a, b) => a.at - b.at);
    const onMap = new Set(sorted.filter(event => event.paths.some(path => path.id)).map(event => event.actor));
    const theirs = onMap.size ? sorted.filter(event => onMap.has(event.actor)) : sorted;
    // Up to their last file and a little after (what came later may all be outside).
    const lastFile = theirs.findLastIndex(event => event.paths.some(path => path.id));
    const events = theirs.slice(Math.max(0, (lastFile < 0 ? theirs.length : lastFile + 40) - 160), lastFile < 0 ? undefined : lastFile + 40);
    ensure(events);
    cast.reset();
    const played = replayEvents(events, snapshot.sessions, clock.current.now + 200);
    cast.push(played);
    replaying.current = (played.at(-1)?.t ?? clock.current.now) + 3500;
    autoFrame.current = true; setFraming(true); setReplay(true);
  };
  const stopReplay = () => {
    replaying.current = undefined; setReplay(false);
    cast.reset(); seen.current.clear();
    setEpoch(value => value + 1);
  };

  const size = (scale: number) => Math.max(30, Math.min(64, 30 + scale * 55));
  const canvas = useStage(({ ctx, viewport, time }) => {
    const dt = Math.min(100, time - (clock.current.last || time)); clock.current.last = time;
    clock.current.now += dt;
    const now = clock.current.now;
    if (replaying.current !== undefined && now > replaying.current && !cast.pending) { stopReplay(); }
    cast.advance(now);
    const scene = store.scene;
    const hierarchy = sceneHierarchy(scene);
    const root = scene.rootId ? scene.nodes.get(scene.rootId) : undefined;
    if (!hierarchy || !root) { ctx.fillStyle = theme.background[0]; ctx.fillRect(0, 0, viewport.width, viewport.height); return; }
    const plan = projection === 'map-plan';
    const tilt = plan ? 1 : 0;
    const project = projector(tilt);
    const actors = [...cast.actors.values()];
    // Frame where they are (their files and mats), easing toward it until the user takes the camera.
    const rects: Rect[] = actors.flatMap(actor => [actor.target, actor.lastFile].flatMap(id => { const r = id ? cast.rectOf(id) : undefined; return r ? [r] : []; }));
    const insets = insetsFor(viewport);
    const target = fitInStage(rects.length ? padded(boundsOf(rects, project, plan ? 0 : 30), plan ? 160 : 120) : boundsOf([root.rect], project, 30), viewport, insets, 40);
    if (autoFrame.current) camera.current = !fitted.current || reducedMotion() ? target : lerpCamera(camera.current, target, 1 - Math.exp(-dt / 600));
    fitted.current = true;
    const s = size(camera.current.scale);
    const busy = new Set(actors.flatMap(actor => (actor.target && !actor.target.startsWith(YARD) ? [actor.target] : [])));
    for (const actor of actors) for (const clone of actor.clones) if (!clone.end) busy.add(clone.target);
    let anchor: (id: string) => Anchor | undefined;
    if (plan) {
      background(ctx, viewport, theme.background);
      const force = new Set([root.id, ...[...busy].flatMap(id => ancestorsOf(hierarchy, id))]);
      const keep = new Set([...busy, ...force]);
      const colorOf = new Map<string, string>();
      for (const actor of actors) if (actor.target && busy.has(actor.target)) colorOf.set(actor.target, actor.color);
      const drawn = drawPlan(ctx, theme, palettes, viewport, camera.current, sceneTree(scene), {
        tilt: 1, force, openPx: 130, ...(busy.size ? { keep } : {}), labels: true, labelFor: node => !busy.has(node.id),
        tint: node => (busy.has(node.id) && node.type !== 'directory' ? ink.tint : undefined),
        ring: node => { const color = colorOf.get(node.id); return color ? { color, width: 2.2 } : undefined; },
        pending: load,
      });
      last.current = { order: drawn.order };
      anchor = id => {
        const yard = cast.yards.get(id);
        if (yard) return { ...toScreen(camera.current, viewport, project(yard.x, yard.y, 0)), rect: { x: yard.x - 20, y: yard.y - 20, w: 40, h: 40 }, z: 0 };
        const item = drawn.drawn.get(id) ?? ancestorsOf(hierarchy, id).reverse().map(a => drawn.drawn.get(a)).find(Boolean);
        if (!item) return undefined;
        const r = item.rect;
        return { ...toScreen(camera.current, viewport, project(r.x + r.w / 2, r.y + r.h / 2, 0)), rect: r, z: 0 };
      };
      // Names of the files they are on: inside when they fit, otherwise a callout.
      drawCallouts(ctx, ink, viewport, [...busy].flatMap(id => {
        const item = drawn.drawn.get(id);
        const node = scene.nodes.get(id);
        if (!item || !node) return [];
        const file = node.type !== 'file' && node.type !== 'directory' ? scene.nodes.get(node.spatialParentId ?? '') : undefined;
        return [{ id, box: screenBox(item, camera.current, viewport, 1), name: `${node.name}${node.type === 'directory' ? '/' : ''}`, sub: whereOf(node, file), container: node.type === 'directory', ...(colorOf.get(id) ? { color: colorOf.get(id)! } : {}) }];
      }), [{ x0: 0, y0: 0, x1: insets.left, y1: viewport.height }, { x0: viewport.width - insets.right, y0: 0, x1: viewport.width, y1: viewport.height }, { x0: 0, y0: viewport.height - insets.bottom, x1: viewport.width, y1: viewport.height }], [], time, !reducedMotion());
    } else {
      const set = scene.visible(camera.current, viewport, DEFAULT_LOD);
      for (const id of set.pending.slice(0, 4)) load(id);
      renderer.render(ctx, window.devicePixelRatio || 1, viewport, camera.current, scene, set, { edges: [], showDiagnostics: false, time, reducedMotion: reducedMotion(), shapes: store.getState().shapes, streets: store.getState().streets }, DEFAULT_LOD);
      // The map recedes a little so the characters read.
      ctx.fillStyle = theme.dark ? 'rgba(8,10,18,0.32)' : 'rgba(255,255,255,0.28)'; ctx.fillRect(0, 0, viewport.width, viewport.height);
      last.current = { order: [], set };
      anchor = id => {
        const yard = cast.yards.get(id);
        if (yard) return { ...worldToScreen(camera.current, viewport, yard.x, yard.y, 0), rect: { x: yard.x - 20, y: yard.y - 20, w: 40, h: 40 }, z: 0 };
        const item = set.items[set.index.get(id) ?? -1] ?? scene.representative(id, set);
        if (!item) return undefined;
        const r = item.node.rect;
        return { ...worldToScreen(camera.current, viewport, r.x + r.w / 2, r.y + r.h / 2, item.zTop), rect: r, z: item.zTop };
      };
    }
    // The city limit: the map's edge, faintly, so "outside" reads as outside.
    const top = plan ? 0 : nodeHeight(root);
    ctx.save(); ctx.strokeStyle = theme.dark ? 'rgba(255,236,200,0.28)' : 'rgba(60,50,30,0.3)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]); ctx.beginPath();
    [[root.rect.x, root.rect.y], [root.rect.x + root.rect.w, root.rect.y], [root.rect.x + root.rect.w, root.rect.y + root.rect.h], [root.rect.x, root.rect.y + root.rect.h]].forEach(([x, y], i) => { const p = toScreen(camera.current, viewport, project(x!, y!, top)); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath(); ctx.stroke(); ctx.restore();
    drawCast(ctx, ink, viewport, actors, now, time, s, plan, anchor, (rect, z, color, alpha, dashed) => footprint(ctx, viewport, camera.current, project, rect, z, color, alpha, dashed));
    if (Math.floor(time / 300) !== Math.floor((time - dt) / 300)) {
      setLegend(actors.map(actor => ({ key: actor.key, color: actor.color, provider: actor.provider, title: actor.title, pose: actor.pose, mini: actor.mini, outside: !!actor.target?.startsWith(YARD) })));
      setLedger(cast.applied.slice(-40).reverse().map(ev => ({ id: ev.id, actor: ev.actor, provider: ev.provider, label: ev.label, at: ev.at })));
    }
  }, camera, {
    onUserCamera: () => { autoFrame.current = false; setFraming(false); },
    onClick: (x, y) => {
      const viewport = { width: canvas.current?.clientWidth ?? 1, height: canvas.current?.clientHeight ?? 1 };
      const { order, set } = last.current;
      const hit = set ? store.scene.hitTest(set, camera.current, viewport, x, y)?.node : hitPlan(order, camera.current, viewport, x, y)?.node;
      if (hit && hit.type !== 'repository') void store.select(hit.id, { fly: false });
    },
  });

  const enabled = snapshot?.enabled;
  return (
    <div className={styles.stage} aria-label="Agents at work">
      <canvas ref={canvas} className={styles.canvas} role="img" aria-label={`Agents at work: ${legend.length} on the map`} />
      <aside className={styles.panel}>
        <p className={styles.kicker}><span>Agents at work{replay ? ' · replay' : ''}</span><button className="icon-button tiny" onClick={() => store.closeCrew()} aria-label="Close agents at work">✕</button></p>
        <div className={styles.row}>
          {!framing && <button className="chip" onClick={() => { autoFrame.current = true; setFraming(true); }} title="Frame where they are, and keep framing them">Frame them</button>}
          <button className="chip" aria-pressed={projection === 'hop'} onClick={() => store.setViews({ map: projection === 'hop' ? 'plan' : 'iso' })} title={projection === 'hop' ? 'They hop from roof to roof on the isometric map (click for the 2D plan, everywhere)' : 'On the map as a 2D plan (click for the isometric map, where they hop from roof to roof, everywhere)'}>3D</button>
          {replay ? <button className="chip" aria-pressed="true" onClick={stopReplay} title="Back to what happens now">■ Stop the replay</button>
            : <button className="chip" onClick={startReplay} disabled={!snapshot?.events.length} title="Play the latest observations again, sped up">↻ Replay the latest</button>}
        </div>
        {legend.length ? <ul className={styles.legend} aria-label="On the map">{legend.map(item => <li key={item.key}><FaceIcon provider={item.provider} color={item.color} /><span>{item.mini ? '↳ ' : ''}{item.title}</span><small>{item.outside ? 'outside · ' : ''}{POSE_LABEL[item.pose]}</small></li>)}</ul>
          : <p className={styles.note}>{!connected ? 'Connecting to agent activity…' : enabled === false ? 'Agent activity is disabled on this server.' : 'No agent at work right now. Their reads, edits and commands appear here as they happen; Replay plays the latest again.'}</p>}
        <p className={styles.hint}>On the roofs: the files they read, edit or search. Outside, on a mat by the nearest edge: thinking, writing the reply, planning, the web, commands, permission and rest. Hooks observe tools, not the model: thinking is inferred from quiet gaps.</p>
      </aside>
      <aside className={styles.ledger} aria-label="Observed">
        <h3>Observed</h3>
        <ol>{ledger.map(item => <li key={item.id} className={`${styles.face} ${styles.done}`}><FaceIcon provider={item.provider} color={agentColor(item.actor)} size={16} /><span title={item.label}>{item.label}</span><em>{ago(item.at)}</em></li>)}</ol>
      </aside>
    </div>
  );
}

function ago(at: number): string { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; }
function padded(bounds: Bounds, pad: number): Bounds { return { minX: bounds.minX - pad, minY: bounds.minY - pad, maxX: bounds.maxX + pad, maxY: bounds.maxY + pad }; }
function background(ctx: CanvasRenderingContext2D, viewport: Viewport, colors: [string, string]) {
  const gradient = ctx.createLinearGradient(0, 0, 0, viewport.height);
  gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, viewport.width, viewport.height);
}
function footprint(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, project: ReturnType<typeof projector>, r: Rect, z: number, color: string, alpha: number, dashed: boolean) {
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => toScreen(camera, viewport, project(x!, y!, z)));
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []); ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); ctx.restore();
}
/** Where something moving between two places is (a hop along an arc), or where it stands. */
function position(anchor: (id: string) => Anchor | undefined, move: Move | undefined, target: string | undefined, now: number, s: number): { x: number; y: number; ground: number; dx: number; moving: boolean } | undefined {
  const end = target ? anchor(target) : undefined;
  if (!end) return undefined;
  if (!move || now >= move.start + move.dur || !move.from || reducedMotion()) return { x: end.x, y: end.y, ground: end.y, dx: 0, moving: false };
  const start = anchor(move.from);
  if (!start) return { x: end.x, y: end.y, ground: end.y, dx: 0, moving: false };
  const p = clamp01((now - move.start) / move.dur), e = ease(p);
  const x = start.x + (end.x - start.x) * e, ground = start.y + (end.y - start.y) * e;
  const height = Math.min(110, s * 0.5 + Math.hypot(end.x - start.x, end.y - start.y) * 0.32);
  return { x, y: ground - Math.sin(p * Math.PI) * height, ground, dx: end.x - start.x, moving: true };
}
function drawCast(ctx: CanvasRenderingContext2D, ink: Ink, viewport: Viewport, actors: Actor[], now: number, time: number, size: number, plan: boolean, anchor: (id: string) => Anchor | undefined, outline: (rect: Rect, z: number, color: string, alpha: number, dashed: boolean) => void) {
  const list: { y: number; draw: () => void }[] = [];
  // The mats outside, under everyone.
  for (const actor of actors) {
    if (!actor.target?.startsWith(YARD)) continue;
    const yard = anchor(actor.target);
    if (yard) drawYard(ctx, yard.x, yard.y, actor.mini ? size * 0.72 : size, actor.color, 0.8, plan, ink.dark);
  }
  for (const actor of actors) {
    const s = actor.mini ? size * 0.72 : size;
    const pos = position(anchor, actor.move, actor.target, now, s);
    if (!pos) continue;
    if (pos.dx) actor.facing = pos.dx > 0 ? 1 : -1;
    const born = clamp01((now - actor.born) / 300), dying = actor.gone !== undefined ? clamp01((actor.gone - now) / 600) : 1;
    const alpha = Math.min(born, dying) * (actor.status === 'unknown' ? 0.4 : 1);
    const target = actor.target && !actor.target.startsWith(YARD) ? anchor(actor.target) : undefined;
    if (target && !pos.moving) outline(target.rect, target.z, actor.color, 0.75 * alpha, actor.pose === 'search');
    const look: Look = { provider: actor.provider, color: actor.color, size: s, facing: actor.facing, pose: actor.pose, poseAge: now - actor.poseAt, time: time + actor.seed * 100, alpha, walking: false, seed: actor.seed, ...(actor.result ? { result: actor.result, resultAge: now - (actor.resultAt ?? 0) } : {}) };
    list.push({ y: pos.y, draw: () => { drawShadow(ctx, pos.x, pos.ground, s, pos.ground - pos.y, alpha, actor.color); drawPixel(ctx, pos.x, pos.y, look); } });
    for (const clone of actor.clones) {
      const end = clone.end ? clamp01((now - clone.end) / 700) : 0;
      const cpos = position(anchor, end > 0 ? { from: clone.target, to: actor.target ?? clone.target, start: clone.end!, dur: 600 } : clone.move, end > 0 ? actor.target : clone.target, now, s * 0.78);
      if (!cpos) continue;
      const tgt = anchor(clone.target);
      if (tgt && !end) outline(tgt.rect, tgt.z, actor.color, 0.5, false);
      const copy: Look = { ...look, size: s * 0.78, alpha: alpha * 0.62 * (1 - end * 0.6), facing: cpos.dx >= 0 ? 1 : -1, seed: actor.seed + 11 };
      list.push({ y: cpos.y, draw: () => { drawShadow(ctx, cpos.x, cpos.ground, s * 0.78, cpos.ground - cpos.y, copy.alpha); drawPixel(ctx, cpos.x, cpos.y, copy); sparkle(ctx, cpos.x, cpos.y, now - clone.start, actor.color); if (clone.end) sparkle(ctx, cpos.x, cpos.y, now - clone.end, actor.color); } });
    }
  }
  list.sort((a, b) => a.y - b.y).forEach(item => item.draw());
  // Names under them when zoomed in enough, and what they do outside; never over one another.
  if (size < 34) return;
  ctx.save(); ctx.font = `700 10px ${ink.font}`;
  const names = actors.flatMap(actor => {
    if (actor.mini) return [];
    const pos = position(anchor, actor.move, actor.target, now, size);
    if (!pos || pos.x < -50 || pos.x > viewport.width + 50) return [];
    const outside = actor.target?.startsWith(YARD) && !pos.moving;
    const text = outside ? `${actor.title} · ${POSE_LABEL[actor.pose]}` : actor.title;
    return [{ actor, text, ask: { key: actor.key, target: { x0: pos.x - 10, y0: pos.ground - 2, x1: pos.x + 10, y1: pos.ground + 4 }, w: ctx.measureText(text).width + 11, h: 19 } }];
  });
  ctx.restore();
  let memory = nameSlots.get(ctx);
  if (!memory) { memory = new Map(); nameSlots.set(ctx, memory); }
  const { placed } = placeLabels(names.map(name => name.ask), { bounds: { x0: 2, y0: 2, x1: viewport.width - 2, y1: viewport.height - 2 }, memory, directions: ['s', 'se', 'sw', 'n', 'e', 'w', 'ne', 'nw'], distances: [2, 14, 30, 52], columns: false });
  const byKey = new Map(names.map(name => [name.actor.key, name]));
  for (const spot of placed) {
    const { actor, text } = byKey.get(spot.key)!;
    if (spot.leader) { ctx.save(); ctx.strokeStyle = actor.color; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(spot.leader.from.x, spot.leader.from.y); ctx.lineTo(spot.leader.to.x, spot.leader.to.y); ctx.stroke(); ctx.restore(); }
    pill(ctx, ink, text, (spot.box.x0 + spot.box.x1) / 2, (spot.box.y0 + spot.box.y1) / 2, { color: actor.color, size: 10, alpha: 0.88 });
  }
}
/** Where each canvas's name labels went on the previous frame (they keep their places while free). */
const nameSlots = new WeakMap<CanvasRenderingContext2D, Map<string, string>>();
