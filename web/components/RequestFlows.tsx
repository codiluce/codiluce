'use client';
// The lanes of a flow (the theater over the map): one request, command or
// scheduled task left to right, with a request travelling through it — the
// schematic of what the map shows in place. Everything drawn comes from
// indexed relationships and effects; gaps say what the index could not see.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { FlowLane, FlowStages, RequestFlow, RequestFlowEdge, RequestFlowNode } from '@engine/projection/dto';
import { typeLabel } from '../lib/format';
import { visibleCatalog } from '../lib/catalog';
import { fitScale, layoutRequestFlow, LANE_TEXT, STAGES, statusClass, STATUS_HINT, STATUS_TEXT, type PlacedFlowEdge, type RequestFlowLayout } from '../lib/request-flows';
import { useAtlas, useStore } from './context';
import { TypeBadge } from './TypeBadge';

const KIND_ICON: Record<string, string> = { page: '▦', entry: '◆', trigger: '⚡', caller: '↗', endpoint: '⇥', command: '⌘', schedule: '⏱', middleware: '◈', validation: '✓', handler: '⚙', method: 'ƒ', model: '◉', table: '⛁', effect: '✦', response: '↩', receive: '↘', continuation: '➜', gap: '?' };
const KIND_TEXT: Record<string, string> = { page: 'page', entry: 'entry point', trigger: 'event handler', caller: 'makes the request', endpoint: 'endpoint', command: 'Artisan command', schedule: 'scheduled task', middleware: 'middleware', validation: 'validation', handler: 'handler', method: 'method', model: 'model', table: 'table', effect: 'side effect', response: 'response', receive: 'receives the response', continuation: 'then, on the client', gap: 'gap' };
const LANE_ICON: Record<FlowLane, string> = { client: '▦', call: '↗', route: '⇥', gate: '◈', controller: '⚙', service: 'ƒ', data: '⛁', response: '↩', return: '↘' };
const STAGE_LANE: Record<string, FlowLane> = { client: 'client', call: 'call', handler: 'controller', data: 'data', response: 'response', returns: 'return' };
/** Seconds the request takes to cross one column of the theater. */
const COLUMN_SECONDS = 0.55, REST_SECONDS = 1.3;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  return reduced;
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** `AuthController::login` / `AccountService.signIn` → its class and member. */
function memberOf(label: string): { owner: string; name: string } | undefined {
  const match = /^(.*?)(?:::|\.)([^:.]+)$/.exec(label);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

export function MethodBadge({ method }: { method: string }) {
  const known = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  return <span className={`rf-method m-${known ? method.toLowerCase() : 'other'}`}>{known ? method.toUpperCase() : method.slice(0, 6) || 'HTTP'}</span>;
}
export function StagePips({ stages, labels }: { stages: FlowStages; labels?: boolean }) {
  return (
    <span className={`rf-pips${labels ? ' labelled' : ''}`} aria-label={`Stages found: ${STAGES.filter(([key]) => stages[key]).map(([, text]) => text).join(', ') || 'none'}`}>
      {STAGES.map(([key, text]) => (
        <span key={key} className={`rf-pip${stages[key] ? ' on' : ''}`} style={{ '--pip': `var(--lane-${STAGE_LANE[key]})` } as CSSProperties} title={`${text}: ${stages[key] ? 'found' : 'not found'}`}>
          {labels && <span className="rf-pip-text">{text}</span>}
        </span>
      ))}
    </span>
  );
}

// Theater --------------------------------------------------------------------
export function RequestFlowTheater() {
  const store = useStore();
  const open = useAtlas(state => state.requests.open);
  const catalog = useAtlas(state => state.catalog);
  const reduced = usePrefersReducedMotion();
  const visible = !!open;
  // Previous / next flow drawn in lanes, in the list as filtered in the Flows panel.
  const order = useMemo(() => catalog.data ? visibleCatalog(catalog.data.items, { tab: catalog.kind, query: catalog.query, status: catalog.filter }).flatMap(group => group.items.filter(item => item.detail === 'lanes').map(item => item.id)) : [], [catalog.data, catalog.kind, catalog.query, catalog.filter]);
  const position = open ? order.indexOf(open.id) : -1;
  const step = (delta: number) => { const id = order[position + delta]; if (id) void store.openRequestFlow(id); };
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'Escape') { if (store.getState().requests.open?.focus) store.focusRequestNode(undefined); else store.closeRequestFlow(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, visible]);
  if (!open || !visible) return null;
  const data = open.data;
  const playing = open.playing && !reduced;
  return (
    <div className="rf-theater" role="dialog" aria-label={data ? `Request flow ${data.name}` : 'Request flow'}>
      <header className="rf-head">
        <div className="rf-nav">
          <button className="icon-button small" onClick={() => step(-1)} disabled={position <= 0} aria-label="Previous request flow" title="Previous in the list">‹</button>
          <button className="icon-button small" onClick={() => step(1)} disabled={position < 0 || position >= order.length - 1} aria-label="Next request flow" title="Next in the list">›</button>
        </div>
        {data ? (data.kind === 'command' ? <span className="rf-method m-other">⌘</span> : data.kind === 'schedule' ? <span className="rf-method m-other">⏱</span> : <MethodBadge method={data.method} />) : <span className="rf-method m-other">…</span>}
        <div className="rf-head-title">
          <h2 className="mono">{data ? (data.kind === 'command' || data.kind === 'schedule' ? data.name : data.path) : 'Loading…'}</h2>
          {data && <span className="rf-head-sub">{data.kind === 'unmatched' ? `requested by ${data.caller}` : data.kind === 'schedule' ? data.path : data.handler ? `${data.kind === 'command' ? 'runs' : 'handled by'} ${data.handler}` : 'no handler resolved'}{data.app ? ` · ${data.app}` : ''}{position >= 0 ? ` · ${position + 1} of ${order.length}` : ''}</span>}
        </div>
        {data && <span className={`rf-status s-${data.status}`} title={STATUS_HINT[data.status]}>{STATUS_TEXT[data.status]}{data.gaps ? ` · ${data.gaps} gap${data.gaps === 1 ? '' : 's'}` : ''}</span>}
        <div className="rf-head-actions">
          {!reduced && <button className="button small" onClick={() => store.toggleRequestFlowPlaying()} aria-pressed={open.playing} disabled={!data}>{open.playing ? '❚❚ Pause' : '▶ Play'}</button>}
          <button className="button small primary" onClick={() => store.traceRequestFlow()} disabled={!data} title="Show this flow on the map: its areas open and a request travels through them">Show on map</button>
          <button className="icon-button small" onClick={() => store.closeRequestFlow()} aria-label="Close request flow" autoFocus>✕</button>
        </div>
      </header>
      {data && <div className="rf-stagebar"><StagePips stages={data.stages} labels /></div>}
      {open.status === 'loading' && !data && <div className="rf-loading big"><span className="rf-spark" />Following the request…</div>}
      {open.status === 'error' && <p className="note error" style={{ margin: 16 }}>{open.error}</p>}
      {data && (
        <div className="rf-body">
          <FlowDiagram flow={data} focus={open.focus} playing={playing} animate={!reduced} />
          {open.focus && <FlowDetail flow={data} focus={open.focus} />}
        </div>
      )}
      {data && <FlowFooter flow={data} />}
    </div>
  );
}
function FlowFooter({ flow }: { flow: RequestFlow }) {
  return (
    <footer className="rf-foot">
      <span className="rf-foot-item"><span className="rf-legend-line" /> indexed relationship</span>
      <span className="rf-foot-item"><span className="rf-legend-line returns" /> response going back</span>
      <span className="rf-foot-item"><span className="rf-legend-line gap" /> gap: the index cannot see further</span>
      <span className="rf-foot-item"><span className="rf-legend-when" /> conditional</span>
      <span className="rf-foot-stats">
        <span>{flow.callers} caller{flow.callers === 1 ? '' : 's'}</span>
        <span>{flow.tables} table{flow.tables === 1 ? '' : 's'}</span>
        {flow.responses.map(status => <span key={status} className={`rf-code st-${statusClass(status)}`}>{status}</span>)}
      </span>
      {flow.notices.length > 0 && <span className="rf-foot-notice" title={flow.notices.join('\n')}>⚠ {flow.notices[0]}{flow.notices.length > 1 ? ` (+${flow.notices.length - 1})` : ''}</span>}
    </footer>
  );
}

function FlowDiagram({ flow, focus, playing, animate }: { flow: RequestFlow; focus?: string; playing: boolean; animate: boolean }) {
  const store = useStore();
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutRequestFlow(flow.lanes, flow.nodes, flow.edges), [flow]);
  const byId = useMemo(() => new Map(flow.nodes.map(node => [node.id, node])), [flow]);
  const edges = useMemo(() => new Map(flow.edges.map(edge => [edge.id, edge])), [flow]);
  const cycle = layout.columns * COLUMN_SECONDS + REST_SECONDS;
  // Fit the flow to the canvas; the zoom buttons override it until another flow opens.
  const [view, setView] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<number | undefined>();
  useEffect(() => setZoom(undefined), [flow]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setView({ w: entry.contentRect.width - 8, h: entry.contentRect.height - 8 }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = zoom ?? fitScale(layout, view);
  useEffect(() => { const element = svg.current; if (!element?.pauseAnimations) return; if (playing) element.unpauseAnimations(); else element.pauseAnimations(); }, [playing, flow]);
  // Drag the background to pan.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const lit = useMemo(() => {
    if (!focus) return undefined;
    const set = new Set([focus]);
    for (const edge of flow.edges) if (edge.from === focus || edge.to === focus) { set.add(edge.from); set.add(edge.to); set.add(edge.id); }
    return set;
  }, [flow, focus]);
  const counts = useMemo(() => { const map = new Map<string, number>(); for (const node of flow.nodes) map.set(node.lane, (map.get(node.lane) ?? 0) + 1); return map; }, [flow]);
  const background = (target: EventTarget) => target === canvas.current || target === svg.current || (target as Element).classList?.contains('rf-lane-band');
  return (
    <>
    <div className="rf-canvas" ref={canvas}
      onClick={event => { if (background(event.target)) store.focusRequestNode(undefined); }}
      onPointerDown={event => { if (!background(event.target) || !canvas.current) return; drag.current = { x: event.clientX, y: event.clientY, left: canvas.current.scrollLeft, top: canvas.current.scrollTop }; }}
      onPointerMove={event => { const start = drag.current, element = canvas.current; if (!start || !element) return; element.scrollLeft = start.left - (event.clientX - start.x); element.scrollTop = start.top - (event.clientY - start.y); }}
      onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
      <svg ref={svg} width={Math.round(layout.width * scale)} height={Math.round(layout.height * scale)} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`Request flow diagram: ${flow.name}`}>
        <defs>
          <filter id="rf-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <filter id="rf-soft" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="4" floodOpacity="0.18" /></filter>
          <marker id="rf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="rf-arrowhead" /></marker>
        </defs>
        {layout.lanes.map(band => (
          <g key={band.lane} className="rf-lane" style={{ '--lane': `var(--lane-${band.lane})` } as CSSProperties}>
            <rect x={band.x - 10} y={6} width={band.w + 20} height={layout.height - 12} rx={18} className="rf-lane-band" />
            <text x={band.x + 2} y={30} className="rf-lane-title">{LANE_ICON[band.lane as FlowLane]} {clip(LANE_TEXT[band.lane as FlowLane], Math.max(6, Math.floor(band.w / 8.5)))}</text>
            <text x={band.x + band.w} y={30} textAnchor="end" className="rf-lane-count">{counts.get(band.lane) ?? 0}</text>
          </g>
        ))}
        {layout.edges.map(placed => <FlowEdge key={placed.id} placed={placed} edge={edges.get(placed.id)!} from={byId.get(placed.from)!} cycle={cycle} lit={!lit || lit.has(placed.id)} labelled={!!lit?.has(placed.id)} animate={animate} />)}
        {layout.nodes.map(box => {
          const node = byId.get(box.id)!;
          return <FlowNodeBox key={box.id} node={node} box={box} focused={focus === node.id} dimmed={!!lit && !lit.has(node.id)} cycle={cycle} animate={animate} onFocus={() => store.focusRequestNode(focus === node.id ? undefined : node.id)} />;
        })}
      </svg>
    </div>
    <div className="rf-zoom" role="group" aria-label="Zoom">
      <button className="icon-button small" onClick={() => setZoom(Math.max(0.3, scale / 1.2))} aria-label="Zoom out">−</button>
      <button className="button small" onClick={() => setZoom(undefined)} aria-pressed={zoom === undefined} title="Fit the flow to the window">Fit · {Math.round(scale * 100)}%</button>
      <button className="icon-button small" onClick={() => setZoom(Math.min(2, scale * 1.2))} aria-label="Zoom in">+</button>
    </div>
    </>
  );
}
function FlowEdge({ placed, edge, from, cycle, lit, labelled, animate }: { placed: PlacedFlowEdge; edge: RequestFlowEdge; from: RequestFlowNode; cycle: number; lit: boolean; labelled: boolean; animate: boolean }) {
  const label = edge.label ?? edge.when[0]?.phrase;
  const start = (placed.column * COLUMN_SECONDS) / cycle;
  // A request stops halfway into a gap: what lies beyond is not known.
  const end = Math.min(0.999, ((placed.column + placed.span * (edge.kind === 'gap' ? 0.5 : 1)) * COLUMN_SECONDS) / cycle);
  const fade = Math.min(0.02, (end - start) / 4);
  const text = label ? clip(label, labelled ? 34 : 24) : '';
  const width = text.length * 6.1 + 14;
  // Labels show where they fit between the boxes, and on the focused step's links.
  const showLabel = !!label && (labelled || (placed.span === 1 && placed.room >= width + 8));
  const title = [edge.label, ...edge.when.map(guard => guard.phrase), edge.via.length ? `via ${edge.via.map(item => item.name).join(' › ')}` : '', edge.hops.map(hop => hop.type).join(' → ')].filter(Boolean).join('\n');
  return (
    <g className={`rf-edge k-${edge.kind}${placed.back ? ' back' : ''}${lit ? '' : ' dim'}`} style={{ '--lane': `var(--lane-${from.lane})` } as CSSProperties}>
      <path d={placed.path} className="rf-edge-glow" />
      <path d={placed.path} className="rf-edge-line" markerEnd="url(#rf-arrow)" />
      {animate && !placed.back && (
        <circle r={edge.kind === 'returns' ? 4 : 4.5} className="rf-particle" opacity={0}>
          <animateMotion dur={`${cycle}s`} repeatCount="indefinite" path={placed.path} keyPoints="0;0;1;1" keyTimes={`0;${start.toFixed(4)};${end.toFixed(4)};1`} calcMode="linear" />
          <animate attributeName="opacity" dur={`${cycle}s`} repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes={`0;${start.toFixed(4)};${(start + fade).toFixed(4)};${(end - fade).toFixed(4)};${end.toFixed(4)};1`} />
        </circle>
      )}
      {showLabel ? (
        <g className={`rf-edge-label${edge.when.length ? ' when' : ''}`} transform={`translate(${placed.label.x},${placed.label.y})`}>
          <rect x={-width / 2} y={-9} width={width} height={18} rx={9} />
          <text textAnchor="middle" y={4}>{text}</text>
        </g>
      ) : edge.when.length > 0 && <rect className="rf-when-mark" x={placed.label.x - 4} y={placed.label.y - 4} width={8} height={8} transform={`rotate(45 ${placed.label.x} ${placed.label.y})`} />}
      <title>{title || edge.kind}</title>
    </g>
  );
}
function FlowNodeBox({ node, box, focused, dimmed, cycle, animate, onFocus }: { node: RequestFlowNode; box: RequestFlowLayout['nodes'][number]; focused: boolean; dimmed: boolean; cycle: number; animate: boolean; onFocus: () => void }) {
  const store = useStore();
  const arrive = (box.column * COLUMN_SECONDS) / cycle;
  const peak = Math.min(0.98, arrive + 0.35 / cycle), after = Math.min(0.995, arrive + 1.1 / cycle);
  const status = node.kind === 'response' ? statusClass(node.status) : undefined;
  // Methods read as `name()` over their class: a column of one class's helpers stays legible.
  const member = node.node?.type === 'method' ? memberOf(node.label) : undefined;
  const title = member ? `${member.name}()` : node.label;
  const sub = (member && ['handler', 'method', 'model'].includes(node.kind) ? member.owner : node.gap ? node.detail ?? KIND_TEXT.gap : node.detail ?? (node.node ? typeLabel(node.node.type, node.node.role) : KIND_TEXT[node.kind])) ?? '';
  const open = () => { const id = node.node?.id ?? node.effect?.owner; if (!id) return; store.traceRequestFlow({ play: false }); void store.select(id, { fly: true }); };
  return (
    <g className={`rf-node k-${node.kind}${status ? ` st-${status}` : ''}${focused ? ' focused' : ''}${dimmed ? ' dim' : ''}`} style={{ '--lane': `var(--lane-${node.lane})` } as CSSProperties} transform={`translate(${box.x},${box.y})`}
      tabIndex={0} role="button" aria-label={`${KIND_TEXT[node.kind]}: ${node.label}`} aria-pressed={focused}
      onClick={onFocus} onDoubleClick={open} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onFocus(); } }}>
      <rect className="rf-halo" x={-5} y={-5} width={box.w + 10} height={box.h + 10} rx={16} opacity={0}>
        {animate && <animate attributeName="opacity" dur={`${cycle}s`} repeatCount="indefinite" values="0;0;0.95;0;0" keyTimes={`0;${arrive.toFixed(4)};${peak.toFixed(4)};${after.toFixed(4)};1`} />}
      </rect>
      <rect className="rf-card" width={box.w} height={box.h} rx={13} filter="url(#rf-soft)" />
      <rect className="rf-accent" x={0} y={0} width={5} height={box.h} rx={2.5} />
      <circle className="rf-icon-bg" cx={22} cy={box.h / 2} r={13} />
      <text className="rf-icon" x={22} y={box.h / 2 + 5} textAnchor="middle">{KIND_ICON[node.kind] ?? '•'}</text>
      {node.kind === 'response' && node.status !== undefined ? (
        <>
          <text className="rf-status-code" x={42} y={29}>{node.status}</text>
          <text className="rf-title" x={42 + String(node.status).length * 12.5 + 7} y={28}>{clip(node.label.replace(/^\d+\s*/, ''), 9)}</text>
        </>
      ) : <text className="rf-title" x={42} y={26}>{clip(title, 17)}</text>}
      <text className="rf-sub" x={42} y={43}>{clip(sub, 21)}</text>
      {node.event && <text className="rf-tag" x={box.w - 7} y={14} textAnchor="end">{node.event}</text>}
      <title>{[node.label, node.detail, node.gap?.text, node.node?.path, node.node || node.effect ? 'Double-click: show on the map' : ''].filter(Boolean).join('\n')}</title>
    </g>
  );
}

/** The focused node's facts and links (or, with nothing focused, how to read the picture). */
function FlowDetail({ flow, focus }: { flow: RequestFlow; focus?: string }) {
  const store = useStore();
  const node = flow.nodes.find(item => item.id === focus);
  const byId = useMemo(() => new Map(flow.nodes.map(item => [item.id, item])), [flow]);
  if (!node) return null;
  const links = flow.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  const at = node.node;
  return (
    <aside className="rf-detail" aria-label={`Step ${node.label}`} style={{ '--lane': `var(--lane-${node.lane})` } as CSSProperties}>
      <div className="rf-detail-kind"><span className="rf-detail-icon">{KIND_ICON[node.kind]}</span>{LANE_TEXT[node.lane]} · {KIND_TEXT[node.kind]}<button className="icon-button small" onClick={() => store.focusRequestNode(undefined)} aria-label="Close step details">✕</button></div>
      <h3 className={node.node || node.effect ? 'mono' : undefined}>{node.label}</h3>
      {node.gap && <p className="note warning">{node.gap.text}</p>}
      {node.detail && !node.gap && <p className="rf-detail-text mono">{node.detail}</p>}
      {at && <div className="row-sub"><TypeBadge type={at.type} role={at.role} /> <span className="mono">{at.path ?? ''}</span></div>}
      {node.effect && <div className="row-sub">in {node.effect.ownerName}{node.effect.ownerPath ? <span className="mono"> · {node.effect.ownerPath}:{node.effect.line}</span> : null} · matched on {node.effect.via}</div>}
      <div className="inspector-actions">
        {node.node && <button className="button small primary" onClick={() => { store.traceRequestFlow({ play: false }); void store.select(node.node!.id, { fly: true }); }}>Show on map</button>}
        {node.node && node.node.path && <button className="button small" onClick={() => void store.openSource({ entity: node.node!.id }, node.label)}>Source</button>}
        {node.effect && <button className="button small" onClick={() => void store.openSource({ entity: node.effect!.owner, start: Math.max(1, node.effect!.line - 12), end: node.effect!.line + 12 }, `${node.label} · ${node.effect!.ownerName}:${node.effect!.line}`)}>Source</button>}
        {node.node && node.node.type !== 'database_table' && <button className="button small" onClick={() => void store.openSteps(node.node!.id)}>What happens from here</button>}
      </div>
      {links.length > 0 && (
        <section className="section">
          <h4>Links</h4>
          <ul className="rf-links">
            {links.map(edge => {
              const other = byId.get(edge.from === node.id ? edge.to : edge.from);
              return (
                <li key={edge.id}>
                  <button className="rf-link-target" onClick={() => other && store.focusRequestNode(other.id)}>{edge.from === node.id ? '→' : '←'} {other?.label ?? '?'}</button>
                  <span className="absent"> {edge.label ?? edge.kind}</span>
                  {edge.when.length > 0 && <div className="step-when">{edge.when.map(guard => guard.phrase).join(' · ')}</div>}
                  {edge.via.length > 0 && <div className="step-via">via {edge.via.map(item => item.name).join(' › ')}</div>}
                  {edge.hops.length > 0 && <div className="rf-hops">{edge.hops.map(hop => <button key={hop.relationId} className="button tiny" onClick={() => void store.openEvidence(hop.relationId, { from: hop.from, to: hop.to, type: hop.type })} title="The evidence for this relationship">{hop.type} · why?</button>)}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </aside>
  );
}
