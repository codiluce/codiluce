'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONTROLLERS, DUSK, DUSK_FILE, LOT, drawDistrict, fit, footprint, hsl, label, pill, project, roof, type Lot, type LotStyle, type Projection, type Rect } from '../lib/district';
import { EclipseMark } from './EclipseMark';
import { NextTag } from './NextTag';

/**
 * The landing page's map demo: Codiluce's window, drawn with the map's own building shapes, playing its biggest
 * features one after another (agents at work, an explanation, a flow, the history). Everything here is a scripted
 * imitation of the app on a made-up repository; the timings are compressed so each scene fits in a few seconds.
 */
export type SceneId = 'agents' | 'explain' | 'flows' | 'history';
interface Scene { id: SceneId; tab: string; caption: string; ms: number; still: number; tool: string }
export const SCENES: Scene[] = [
  { id: 'agents', tab: 'Agents', tool: 'Agents', caption: 'Each Claude Code or Codex session lights the code it reads, edits and searches, as it happens.', ms: 9800, still: 7200 },
  { id: 'explain', tab: 'Explain', tool: 'Explain', caption: 'Your agent explains the code through Codiluce. Point at a link in its answer and that code lights up.', ms: 12400, still: 7500 },
  { id: 'flows', tab: 'Flows', tool: 'Flows', caption: 'Follow a click through the request to the handler and the table it reads, link by link.', ms: 8400, still: 6000 },
  { id: 'history', tab: 'History', tool: 'History', caption: 'Every commit is a snapshot: watch what each one added, changed and removed, in place.', ms: 10200, still: 3900 },
];
/** Other parts of the page ask for a scene with this event (detail: a SceneId). */
export const SCENE_EVENT = 'codiluce:scene';

const TOOLS = ['History', 'Flows', 'People', 'Impact', 'Explain', 'Agents'];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => 1 - (1 - clamp01(v)) ** 3;
/** 1 between `from` and `to`, easing in and out over `fade` ms. */
const within = (t: number, from: number, to: number, fade = 260) => clamp01(Math.min((t - from) / fade, (to - t) / fade));
const DIM = { ...DUSK_FILE, l: 19 };
const ACCENT = hsl(DUSK.accent);

// Agents: two sessions working at once, as their hooks report them.
interface Session { key: string; product: string; title: string; id: string; color: string }
const CLAUDE: Session = { key: 'claude', product: 'Claude Code', title: 'Add password reset', id: '8f3a1c2e', color: 'hsl(265 80% 74%)' };
const CODEX: Session = { key: 'codex', product: 'Codex', title: 'Fix the order import', id: '019a7d4b', color: 'hsl(186 72% 54%)' };
interface AgentEvent { at: number; who: Session; verb: string; lot?: string; folder?: Rect; path?: string; query?: string }
const EVENTS: AgentEvent[] = [
  { at: 300, who: CLAUDE, verb: 'Search', folder: CONTROLLERS, path: 'app/Http/Controllers/', query: 'reset' },
  { at: 1200, who: CODEX, verb: 'Read file', lot: 'import' },
  { at: 2000, who: CLAUDE, verb: 'Read file', lot: 'pw-ctrl' },
  { at: 2800, who: CODEX, verb: 'Read file', lot: 'console' },
  { at: 3500, who: CLAUDE, verb: 'Read file', lot: 'reset-svc' },
  { at: 4400, who: CLAUDE, verb: 'Edit file', lot: 'reset-svc' },
  { at: 5200, who: CODEX, verb: 'Edit file', lot: 'import' },
  { at: 6000, who: CLAUDE, verb: 'Edit file', lot: 'mail-job' },
  { at: 6900, who: CLAUDE, verb: 'Edit file', lot: 'reset-form' },
  { at: 7800, who: CODEX, verb: 'Run tests' },
];
/** Marks fade over 30 seconds in the app; here, faster. */
const MARK_MS = 6500;

// Explain: the agent's working card, then its answer.
// The card lists each tool call as the app does (start_explanation itself is not a step).
const STEPS = [
  { at: 400, text: 'search reset' }, { at: 1000, text: 'flow POST /password/email' }, { at: 1600, text: 'source app/Http/Controllers/PasswordController.php' },
  { at: 2200, text: 'impact table:password_resets' }, { at: 3000, text: 'publish_explanation How a password reset works' },
];
const ANSWER_AT = 3800;
const LINKS: Record<string, string> = { l1: 'reset', l2: 'reset-form', l3: 'pw-ctrl', l4: 'reset-svc', l5: 'resets', l6: 'mail-job' };
const HOVERS = [{ link: 'l2', from: 5000, to: 6400 }, { link: 'l3', from: 6800, to: 8200 }, { link: 'l5', from: 8600, to: 10000 }, { link: 'l6', from: 10400, to: 11800 }];

// Flows: one request, from the page to the table.
const STOPS = [
  { lot: 'login', lane: 'Frontend', name: 'page /login', kind: 'page', via: '' },
  { lot: 'login-form', lane: '', name: 'LoginForm', kind: 'component', via: 'renders' },
  { lot: 'session', lane: '', name: 'useSession.signIn()', kind: 'hook', via: 'onSubmit' },
  { lot: 'routes', lane: 'HTTP', name: 'POST /api/login', kind: 'request', via: 'requests' },
  { lot: 'auth-ctrl', lane: 'Backend', name: 'AuthController.login', kind: 'endpoint', via: 'handles' },
  { lot: 'auth-svc', lane: '', name: 'AuthService.attempt', kind: 'method', via: 'calls' },
  { lot: 'user', lane: '', name: 'User', kind: 'model', via: 'queries' },
  { lot: 'users', lane: 'Database', name: 'users', kind: 'table', via: 'reads' },
];
const STOP_MS = 700, FLOW_START = 400;
const flowProgress = (t: number) => Math.min(STOPS.length - 1, Math.max(-1, (t - FLOW_START) / STOP_MS));

// History: four commits on the branch, applied in place.
interface Commit { at: number; sha: string; message: string; who: string; agent?: boolean; when: string; added: string[]; modified: string[]; removed: string[] }
const COMMITS: Commit[] = [
  { at: 900, sha: '3e1a9c0', message: 'Import orders from the shop feed', who: 'Ana Ruiz', when: '12 days ago', added: ['import', 'orders'], modified: ['console'], removed: [] },
  { at: 3000, sha: '7b42f19', message: 'Password reset by email', who: 'Claude Code', agent: true, when: '5 days ago', added: ['reset', 'reset-form', 'pw-ctrl', 'reset-svc', 'resets'], modified: ['routes'], removed: [] },
  { at: 5300, sha: 'c90d2e4', message: 'Queue the reset mail', who: 'Ana Ruiz', when: '2 days ago', added: ['mail-job'], modified: ['reset-svc'], removed: [] },
  { at: 7500, sha: '5f6a811', message: 'Drop the legacy token helper', who: 'Codex', agent: true, when: '3 hours ago', added: [], modified: ['auth-svc'], removed: ['token'] },
];
const ADDED = { h: 150, s: 55, l: 46 }, REMOVED = { h: 0, s: 62, l: 50 };
const CHANGE_COLORS = { added: 'hsl(150 62% 56%)', modified: ACCENT, removed: 'hsl(0 78% 64%)' };
const currentCommit = (t: number) => COMMITS.reduce<number>((found, commit, index) => commit.at <= t ? index : found, -1);
const born = new Map(COMMITS.flatMap(commit => commit.added.map(id => [id, commit] as const)));
const died = new Map(COMMITS.flatMap(commit => commit.removed.map(id => [id, commit] as const)));

function lotStyle(scene: SceneId, t: number, item: Lot): LotStyle {
  const birth = born.get(item.id), death = died.get(item.id);
  if (scene === 'history') {
    if (birth && t < birth.at) return { hidden: true };
    if (death && t >= death.at) {
      const k = (t - death.at) / 900;
      return k >= 1 ? { hidden: true } : { color: REMOVED, grow: 1 - ease(k) };
    }
    if (birth) {
      const k = (t - birth.at) / 2200;
      return k < 1 ? { color: { h: ADDED.h, s: ADDED.s * (1 - k), l: ADDED.l + (DUSK_FILE.l - ADDED.l) * k }, grow: ease((t - birth.at) / 700) } : {};
    }
    const touched = COMMITS.find(commit => commit.modified.includes(item.id) && t >= commit.at && t < commit.at + 1800);
    return touched ? { hot: 1 - (t - touched.at) / 1800 } : {};
  }
  if (death) return { hidden: true };
  if (scene === 'explain') {
    if (t < ANSWER_AT) return {};
    const shown = ease((t - ANSWER_AT) / 500);
    const hover = HOVERS.find(h => t >= h.from - 260 && t <= h.to + 260);
    const linked = Object.values(LINKS).includes(item.id);
    if (hover) {
      const k = within(t, hover.from, hover.to);
      if (LINKS[hover.link] === item.id) return { hot: 0.5 + 0.5 * k };
      return { color: DIM, hot: linked ? 0.5 * (1 - k) : 0 };
    }
    return linked ? { hot: 0.5 * shown } : { color: { ...DUSK_FILE, l: DUSK_FILE.l - (DUSK_FILE.l - DIM.l) * shown } };
  }
  if (scene === 'flows') {
    const progress = flowProgress(t), stop = STOPS.findIndex(s => s.lot === item.id);
    if (stop < 0) return { color: { ...DUSK_FILE, l: 27 } };
    return { hot: stop <= progress + 0.02 ? Math.max(0.45, 1 - (progress - stop) * 0.9) : 0 };
  }
  return {};
}

function drawOverlay(ctx: CanvasRenderingContext2D, p: Projection, scene: SceneId, t: number) {
  if (scene === 'agents') {
    // The latest mark of each session on each lot (or folder), as the map keeps them.
    const latest = new Map<string, AgentEvent>();
    for (const event of EVENTS) if (event.at <= t && (event.lot || event.folder)) latest.set(`${event.lot ?? 'folder'}|${event.who.key}`, event);
    const groups = new Map<string, AgentEvent[]>();
    for (const event of latest.values()) { const key = event.lot ?? 'folder'; groups.set(key, [...(groups.get(key) ?? []), event]); }
    for (const marks of groups.values()) {
      marks.sort((a, b) => b.at - a.at);
      const first = marks[0]!, age = t - first.at, alpha = Math.max(0.2, 1 - age / MARK_MS) * clamp01(age / 180);
      ctx.save();
      ctx.globalAlpha = alpha;
      footprint(ctx, p, first.folder ?? LOT[first.lot!]!, first.folder ? 0 : undefined);
      ctx.setLineDash(first.folder ? [5, 4] : []);
      ctx.strokeStyle = first.who.color; ctx.lineWidth = age < 1500 ? 2.4 + Math.sin(age / 150) : 2;
      if (age < 1500) { ctx.shadowColor = first.who.color; ctx.shadowBlur = 12; }
      ctx.stroke();
      ctx.restore();
      const item = first.lot ? LOT[first.lot]! : undefined;
      let [x, y] = item ? roof(p, item) : project(p, CONTROLLERS.x + CONTROLLERS.w / 2, CONTROLLERS.y + CONTROLLERS.d / 2, 0.9);
      if (item) { label(ctx, item.name, x, y - 6, Math.max(0.55, alpha)); y -= 26; } else y -= 4;
      for (const mark of marks) {
        const markAge = t - mark.at;
        pill(ctx, mark.verb, x, y - (1 - ease(markAge / 220)) * 6, mark.who.color, Math.max(0.25, 1 - markAge / MARK_MS) * clamp01(markAge / 160));
        y -= 21;
      }
    }
  } else if (scene === 'explain' && t >= ANSWER_AT) {
    const hover = HOVERS.find(h => t >= h.from && t <= h.to);
    for (const [link, id] of Object.entries(LINKS)) {
      const item = LOT[id]!, on = hover?.link === link, k = hover ? (on ? within(t, hover.from, hover.to) : 0) : ease((t - ANSWER_AT) / 500) * 0.7;
      if (on) {
        ctx.save(); ctx.globalAlpha = k;
        footprint(ctx, p, item); ctx.strokeStyle = ACCENT; ctx.lineWidth = 2.2; ctx.shadowColor = ACCENT; ctx.shadowBlur = 10; ctx.stroke();
        ctx.restore();
      }
      const [x, y] = roof(p, item);
      if (k > 0.02) label(ctx, item.name, x, y - 6, k, on ? '#ffe2a8' : '#f5f5f3');
    }
  } else if (scene === 'flows') {
    const progress = flowProgress(t);
    const anchor = (index: number) => { const item = LOT[STOPS[index]!.lot]!; return roof(p, item, 0.95); };
    for (let k = 0; k < STOPS.length - 1; k++) {
      const a = anchor(k), b = anchor(k + 1), lift = Math.min(60, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.3), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - lift] as const;
      const point = (u: number) => [(1 - u) ** 2 * a[0] + 2 * (1 - u) * u * m[0] + u * u * b[0], (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * m[1] + u * u * b[1]] as const;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(m[0], m[1], b[0], b[1]); ctx.setLineDash([3, 4]); ctx.strokeStyle = hsl(DUSK.accent, 0.25); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
      const fill = clamp01(progress - k);
      if (!fill) continue;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); for (let q = 1; q <= 24; q++) { const [px, py] = point(fill * q / 24); ctx.lineTo(px, py); }
      ctx.shadowColor = ACCENT; ctx.shadowBlur = 8; ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      if (fill < 1) { const [px, py] = point(fill); ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#fff3d6'; ctx.fill(); }
    }
    STOPS.forEach((stop, index) => {
      if (index > progress + 0.02) return;
      const [x, y] = roof(p, LOT[stop.lot]!);
      label(ctx, LOT[stop.lot]!.name, x, y - 7, index >= Math.floor(progress) ? 1 : 0.7);
    });
  } else if (scene === 'history') {
    const current = currentCommit(t);
    if (current < 0) return;
    const commit = COMMITS[current]!, age = t - commit.at, next = COMMITS[current + 1];
    const alpha = clamp01(age / 200) * (age < 1800 ? 1 : 0.4) * (next ? clamp01((next.at - t) / 300) : 1);
    const changes: [string, keyof typeof CHANGE_COLORS][] = [...commit.added.map(id => [id, 'added'] as [string, 'added']), ...commit.modified.map(id => [id, 'modified'] as [string, 'modified']), ...commit.removed.map(id => [id, 'removed'] as [string, 'removed'])];
    for (const [id, change] of changes) {
      const item = LOT[id]!;
      ctx.save(); ctx.globalAlpha = alpha * (change === 'removed' ? 1 - ease((age - 900) / 900) * 0.6 : 1);
      footprint(ctx, p, item); ctx.setLineDash(change === 'removed' ? [4, 4] : []); ctx.strokeStyle = CHANGE_COLORS[change]; ctx.lineWidth = 2;
      if (age < 1200) { ctx.shadowColor = CHANGE_COLORS[change]; ctx.shadowBlur = 10; }
      ctx.stroke(); ctx.restore();
      const [x, y] = roof(p, item, change === 'removed' ? 0.2 : 1);
      label(ctx, `${change === 'added' ? '+ ' : change === 'removed' ? '− ' : '~ '}${item.name}`, x, y - 6, alpha, CHANGE_COLORS[change]);
    }
  }
}

function PanelHead({ title }: { title: string }) {
  return <div className="demo-panel-head"><span>{title}</span><span aria-hidden="true">⇤</span></div>;
}

function AgentsPanel({ t }: { t: number }) {
  const seen = EVENTS.filter(event => event.at <= t).reverse().slice(0, 5);
  const status = (session: Session) => session === CODEX && t > 8600 ? 'idle' : 'running';
  return (
    <>
      <PanelHead title="Agents" />
      <div className="demo-panel-body">
        <p className="demo-live demo-optional"><span className="demo-live-dot" />Live activity</p>
        <h4>Sessions <span className="demo-count">2</span></h4>
        {[CLAUDE, CODEX].map(session => (
          <div key={session.key} className="demo-session">
            <span className="demo-dot" style={{ background: session.color }} />
            <span className="demo-session-name"><strong>{session.title}</strong><small>{session.product} · <span className="mono">{session.id}</span></small></span>
            <span className={`demo-status ${status(session)}`}>{status(session)}</span>
          </div>
        ))}
        <h4>Recent activity</h4>
        <ol className="demo-feed">
          {seen.map(event => (
            <li key={event.at}>
              <div className="demo-feed-head">
                <span className="demo-dot" style={{ background: event.who.color }} />
                <strong>{event.verb}</strong>
                <span className="demo-subtle">completed</span>
                <time>{Math.floor((t - event.at) / 1000)}s</time>
              </div>
              {event.query ? <p className="demo-feed-line">Search: <code>{event.query}</code></p> : null}
              {event.lot || event.path ? <p className="demo-feed-path mono">{event.path ?? LOT[event.lot!]!.path}</p> : <p className="demo-feed-line">{event.who.title} · {event.who.product}</p>}
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

function ExplainPanel({ t, linkRef }: { t: number; linkRef: (id: string) => (el: HTMLSpanElement | null) => void }) {
  if (t < ANSWER_AT) {
    const steps = STEPS.filter(step => step.at <= t), saving = steps.length === STEPS.length;
    return (
      <>
        <PanelHead title="Explanations" />
        <div className="demo-panel-body">
          <section className="demo-work">
            <div className="demo-work-head"><span className="demo-pulse" /><strong>Claude Code is explaining</strong><span className="demo-subtle">{Math.floor(t / 1000) + 1} s</span></div>
            <p className="demo-work-title">How a password reset works</p>
            <div className="demo-question"><span>Question</span><p>How does a password reset work?</p></div>
            <ul className="demo-steps">{steps.map(step => <li key={step.at} className="mono">{step.text}</li>)}</ul>
            <p className="demo-working"><span className="demo-spark" />{saving ? 'Saving the explanation…' : 'Reading the code…'}</p>
          </section>
        </div>
      </>
    );
  }
  const hover = HOVERS.find(h => t >= h.from && t <= h.to)?.link;
  const a = (id: string, text: string) => <span ref={linkRef(id)} className={`demo-link${hover === id ? ' is-hover' : ''}`}>{text}</span>;
  return (
    <>
      <PanelHead title="Explanations" />
      <div className="demo-panel-body demo-answer">
        <h3>How a password reset works</h3>
        <p className="demo-meta"><span className="demo-tag">Flow</span>by claude-code · just now · written at 4f2c9a1</p>
        <p className="demo-check demo-optional"><span className="demo-box" aria-hidden="true">✓</span>Light on map (6)</p>
        <div className="demo-question demo-optional"><span>Question</span><p>How does a password reset work?</p></div>
        <p>
          Someone asks for a link on the {a('l1', 'reset page')}. {a('l2', 'ResetForm')} posts the email
          to {a('l3', 'PasswordController.store')}, which hands it to {a('l4', 'ResetService')}.
        </p>
        <p>
          The service stores a token in {a('l5', 'password_resets')} and queues {a('l6', 'SendResetLink')}, so the
          mail never holds up the request.
        </p>
      </div>
    </>
  );
}

function FlowsPanel({ t }: { t: number }) {
  const progress = flowProgress(t);
  return (
    <>
      <PanelHead title="Flow" />
      <div className="demo-panel-body">
        <p className="demo-flow-head"><span className="flow-dot" aria-hidden="true" /><code>POST /api/login</code><span className="demo-subtle">from /login</span></p>
        <ol className="demo-lanes">
          {STOPS.map((stop, index) => (
            <li key={stop.name} className={index <= progress + 0.02 ? index === Math.floor(progress) ? 'is-lit is-head' : 'is-lit' : ''}>
              <span className="demo-lane">{stop.lane}</span>
              <span className="demo-node" />
              <span className="demo-stop"><span className="mono">{stop.name}</span><small>{stop.kind}{stop.via ? <> · ← {stop.via}</> : null}</small></span>
            </li>
          ))}
        </ol>
        <p className="demo-foot demo-optional">Each link opens its evidence: analyzer, file and line.</p>
      </div>
    </>
  );
}

function HistoryPanel({ t }: { t: number }) {
  const current = currentCommit(t);
  return (
    <>
      <PanelHead title="History" />
      <div className="demo-panel-body">
        <p className="demo-live">{current < 0 ? 'Playing main from 3 weeks ago…' : <>Snapshot <span className="mono">{COMMITS[current]!.sha}</span> · {current + 1} of {COMMITS.length}</>}</p>
        <ol className="demo-commits">
          {COMMITS.map((commit, index) => (
            <li key={commit.sha} className={index === current ? 'is-current' : index < current ? 'is-past' : ''}>
              <span className="demo-commit-line"><span className="mono demo-sha">{commit.sha}</span><span className="demo-msg">{commit.message}</span></span>
              <small>{commit.who}{commit.agent ? <span className="demo-agent">agent</span> : null} · {commit.when}</small>
              {index === current ? (
                <span className="demo-changes">
                  {commit.added.length ? <b className="add">+{commit.added.length} added</b> : null}
                  {commit.modified.length ? <b className="mod">~{commit.modified.length} modified</b> : null}
                  {commit.removed.length ? <b className="del">−{commit.removed.length} removed</b> : null}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

export function MapDemo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const links = useRef<Record<string, HTMLSpanElement | null>>({});
  const clock = useRef({ scene: 0, t: 0, last: 0, playing: true, still: false, beat: -1 });
  const redraw = useRef<() => void>(() => undefined);
  const [scene, setScene] = useState(0);
  const [beat, setBeat] = useState(0);
  const [playing, setPlaying] = useState(true);
  const t = beat * 100;
  const active = SCENES[scene]!;

  const select = (index: number, restart = true) => {
    const c = clock.current;
    // Paused, a scene shows its most telling moment rather than its empty start.
    c.scene = index; c.t = c.playing ? 0 : SCENES[index]!.still; c.beat = Math.floor(c.t / 100);
    setScene(index); setBeat(c.beat);
    if (restart) redraw.current();
  };

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const c = clock.current;
    c.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (c.still) { c.playing = false; setPlaying(false); select(0, false); }
    let frame = 0, visible = false;
    const draw = (now: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const p = fit(w, h), id = SCENES[c.scene]!.id, st = c.t;
      drawDistrict(ctx, p, c.still ? 0 : now / 1000, item => lotStyle(id, st, item));
      drawOverlay(ctx, p, id, st);
    };
    const loop = (now: number) => {
      const dt = c.last ? Math.min(100, now - c.last) : 0;
      c.last = now;
      if (c.playing) {
        c.t += dt;
        if (c.t >= SCENES[c.scene]!.ms) { c.scene = (c.scene + 1) % SCENES.length; c.t = 0; setScene(c.scene); }
      }
      const b = Math.floor(c.t / 100);
      if (b !== c.beat) { c.beat = b; setBeat(b); }
      draw(now);
      if (visible && !c.still) frame = requestAnimationFrame(loop);
    };
    const start = () => { cancelAnimationFrame(frame); c.last = 0; frame = requestAnimationFrame(loop); };
    redraw.current = () => { if (c.still || !visible) requestAnimationFrame(draw); };
    const observer = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting && !document.hidden; if (visible) start(); else cancelAnimationFrame(frame); });
    observer.observe(canvas);
    // Hidden tabs stop drawing; the observer does not fire again on return, so check the viewport here.
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      const box = canvas.getBoundingClientRect();
      visible = !document.hidden && box.bottom > 0 && box.top < window.innerHeight;
      if (visible) start();
    };
    const onResize = () => requestAnimationFrame(draw);
    const onScene = (event: Event) => {
      const index = SCENES.findIndex(s => s.id === (event as CustomEvent<SceneId>).detail);
      if (index >= 0) select(index);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    window.addEventListener(SCENE_EVENT, onScene);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize); window.removeEventListener(SCENE_EVENT, onScene);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The pointer glides to the link the explanation scene is about to point at.
  const target = active.id === 'explain' && t >= ANSWER_AT + 400 ? (HOVERS.find(h => t <= h.to) ?? HOVERS.at(-1)!).link : undefined;
  useLayoutEffect(() => {
    const cursor = cursorRef.current, root = rootRef.current, link = target ? links.current[target] : undefined;
    if (!cursor || !root) return;
    if (!link) { cursor.dataset.on = 'false'; return; }
    const a = root.getBoundingClientRect(), b = link.getBoundingClientRect();
    const x = b.left - a.left + Math.min(b.width * 0.6, 60), y = b.top - a.top + b.height * 0.55;
    if (cursor.dataset.on !== 'true') {
      // Appear just below the first link, then glide; never fly in from the corner.
      cursor.style.transition = 'none';
      cursor.style.transform = `translate(${x + 30}px, ${y + 40}px)`;
      void cursor.offsetWidth;
      cursor.style.transition = '';
    }
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.dataset.on = 'true';
  }, [target, scene]);

  const linkRef = (id: string) => (el: HTMLSpanElement | null) => { links.current[id] = el; };
  const toggle = () => { const c = clock.current; c.playing = !c.playing; setPlaying(c.playing); };
  const history = active.id === 'history';

  return (
    <div className="demo" id="demo">
      <div ref={rootRef} className="demo-window shot-frame">
        <div className="demo-bar" aria-hidden="true">
          <span className="demo-brand"><EclipseMark className="demo-mark" /><span>codiluce</span></span>
          <span className="demo-repo"><strong>acme/shop</strong><small>main · 4f2c9a1</small></span>
          <span className="demo-search">⌕ Search files, symbols, routes…</span>
          <span className="demo-tools">{TOOLS.map(tool => <span key={tool} className={tool === active.tool ? 'is-on' : ''}>{tool}</span>)}</span>
        </div>
        <div className="demo-body">
          <div className="demo-panel" aria-hidden="true" key={active.id}>
            {active.id === 'agents' ? <AgentsPanel t={t} /> : active.id === 'explain' ? <ExplainPanel t={t} linkRef={linkRef} /> : active.id === 'flows' ? <FlowsPanel t={t} /> : <HistoryPanel t={t} />}
          </div>
          <div className="demo-map">
            <canvas ref={canvasRef} role="img" aria-label="A repository drawn by Codiluce as an isometric map: each file is a building shaped by its kind. The demo plays agents marking the files they touch, an explanation lighting the code it links, a request flowing from a page to a table, and commits adding and removing files." />
            {history ? (
              <div className="demo-timeline" aria-hidden="true">
                <span className="demo-timeline-label">Timeline</span>
                <span className="demo-track">
                  {COMMITS.map(commit => <span key={commit.sha} className={`demo-tick${commit.at <= t ? ' is-past' : ''}`} style={{ left: `${(commit.at / active.ms) * 100}%` }} />)}
                  <span className="demo-playhead" style={{ left: `${Math.min(100, (t / active.ms) * 100)}%` }} />
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <span ref={cursorRef} className="demo-cursor" data-on="false" aria-hidden="true">
          <svg viewBox="0 0 16 20" width="16" height="20"><path d="M1 1l13 10.5-6 .6 3.6 6.4-2.4 1.2-3.5-6.4L1 17.5z" fill="#f5f5f3" stroke="#0a0a0b" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        </span>
      </div>
      <div className="demo-tabs">
        <div className="demo-tablist" role="tablist" aria-label="Features in the demo">
          {SCENES.map((item, index) => (
            <button key={item.id} type="button" role="tab" aria-selected={index === scene} className="demo-tab" onClick={() => select(index)}>
              <span className="demo-tab-bar"><span style={{ transform: `scaleX(${index === scene ? Math.min(1, t / item.ms) : index < scene ? 1 : 0})` }} /></span>
              <strong>{item.tab}{item.id === 'agents' ? <NextTag feature="agents" /> : null}</strong>
              <span>{item.caption}</span>
            </button>
          ))}
        </div>
        <button type="button" className="demo-play" onClick={toggle} aria-label={playing ? 'Pause the demo' : 'Play the demo'} title={playing ? 'Pause' : 'Play'}>
          {playing ? <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4.5 3h2.2v10H4.5zM9.3 3h2.2v10H9.3z" fill="currentColor" /></svg> : <svg viewBox="0 0 16 16" width="14" height="14"><path d="M5 3l8 5-8 5z" fill="currentColor" /></svg>}
        </button>
      </div>
      <p className="demo-caption">{active.caption}</p>
    </div>
  );
}
