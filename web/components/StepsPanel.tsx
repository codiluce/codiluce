'use client';
// "What happens from here": the steps an anchor sets in motion, as an outline
// (left panel) and as a layered diagram. Every link is a chain of indexed
// relationships (each with Why?); folded entities are listed as "via"; the
// conditions on a link are read from the source of the step it leaves.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Step, StepLink, StepsResult } from '@engine/projection/dto';
import { typeLabel } from '../lib/format';
import { layoutSteps } from '../lib/steps-layout';
import { useAtlas, useStore } from './context';
import { TypeBadge } from './TypeBadge';

const KIND_TEXT: Record<string, string> = { anchor: 'start', route: 'page', endpoint: 'endpoint', handler: 'handler', trigger: 'trigger', action: 'action', effect: 'effect' };
const EFFECT_ICON: Record<string, string> = { database: '⛁', response: '↩', network: '⇄', storage: '▤', navigation: '➜', cache: '◷', mail: '✉', queue: '⇶', event: '✦', auth: '⚿', file: '▢', process: '⚙' };

export function stepTitle(step: Step): string {
  if (step.effect) return `${step.effect.category} · ${step.effect.operation}${step.effect.status ? ` · ${step.effect.status}` : ''}`;
  return step.node?.name ?? step.id;
}
function linkLabel(link: StepLink): string[] {
  const parts: string[] = [];
  if (link.event) parts.push(`on ${link.event}`);
  for (const guard of link.when) parts.push(guard.phrase);
  return parts;
}

export function StepsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const steps = useAtlas(state => state.steps);
  const [diagram, setDiagram] = useState(false);
  if (!steps) return null;
  const data = steps.data;
  return (
    <>
      <div className="panel-header">
        <h2>What happens from here</h2>
        <button className="icon-button small" onClick={() => { store.closeSteps(); onClose(); }} aria-label="Close steps">✕</button>
      </div>
      <div className="panel-body steps-panel">
        {steps.status === 'loading' && <p className="absent">Following calls, handlers and requests…</p>}
        {steps.status === 'error' && <p className="note error">{steps.error}</p>}
        {data && (
          <>
            <p className="note">Steps are drawn from indexed relationships and effects, not observed at runtime. Plumbing in between is folded into each link as <em>via</em>; conditions are read from the source.</p>
            <div className="inspector-actions">
              <button className="button small primary" onClick={() => setDiagram(true)}>Diagram</button>
              <button className="button small" onClick={() => store.navigator?.fitNodes(data.steps.flatMap(step => step.node ? [step.node] : []))}>Fit on map</button>
            </div>
            {data.notices.map(notice => <p key={notice} className="absent">{notice}</p>)}
            <StepsOutline data={data} />
            {diagram && <StepsDiagram data={data} onClose={() => setDiagram(false)} />}
          </>
        )}
      </div>
    </>
  );
}
function StepsOutline({ data }: { data: StepsResult }) {
  const byId = useMemo(() => new Map(data.steps.map(step => [step.id, step])), [data]);
  const outgoing = useMemo(() => {
    const map = new Map<string, StepLink[]>();
    for (const link of data.links) map.set(link.from, [...map.get(link.from) ?? [], link]);
    return map;
  }, [data]);
  const shown = new Set<string>();
  const render = (stepId: string, depth: number): ReactNode => {
    const step = byId.get(stepId);
    if (!step) return null;
    shown.add(stepId);
    const children = (outgoing.get(stepId) ?? []).filter(link => byId.has(link.to));
    return (
      <li key={`${stepId}:${depth}`} className="steps-item">
        <StepCard step={step} />
        {children.length > 0 && (
          <ul className="steps-children">
            {children.map(link => {
              const repeat = shown.has(link.to) || link.back;
              return (
                <Fragment key={link.id}>
                  <LinkLine link={link} />
                  {repeat ? <li className="steps-item"><StepCard step={byId.get(link.to)!} repeat /></li> : render(link.to, depth + 1)}
                </Fragment>
              );
            })}
          </ul>
        )}
      </li>
    );
  };
  return <ul className="steps-outline" aria-label="Steps">{render(data.anchor.id, 0)}</ul>;
}
function StepCard({ step, repeat }: { step: Step; repeat?: boolean }) {
  const store = useStore();
  const focus = useAtlas(state => state.steps?.focus);
  const open = () => {
    store.focusStep(step.id);
    if (step.node) void store.select(step.node.id, { fly: true });
    else if (step.effect) { void store.select(step.effect.owner, { fly: true }); void store.openSource({ entity: step.effect.owner, start: Math.max(1, step.effect.line - 12), end: step.effect.line + 12 }, `${step.effect.category} · ${step.effect.ownerName}:${step.effect.line}`); }
  };
  return (
    <div className={`step-card kind-${step.kind}${focus === step.id ? ' focused' : ''}${repeat ? ' repeat' : ''}`}>
      <button className="step-main" onClick={open} onDoubleClick={() => step.node && void store.openSteps(step.node.id)} title={step.node ? `${typeLabel(step.node.type, step.node.role)} · ${step.node.path ?? ''}${step.node ? ' — double-click to start from here' : ''}` : step.effect?.detail}>
        <span className="step-kind">{step.effect ? (EFFECT_ICON[step.effect.category] ?? '•') : KIND_TEXT[step.kind]}</span>
        <span className="label">{stepTitle(step)}</span>
        {step.app && <span className="chip app-chip">{step.app}</span>}
      </button>
      {step.node && <div className="row-sub"><TypeBadge type={step.node.type} role={step.node.role} /> {step.node.path ?? ''}</div>}
      {step.effect && <div className="row-sub mono" title={step.effect.detail}>{step.effect.detail}{step.effect.when.length ? <span className="step-when"> · {step.effect.when.map(guard => guard.phrase).join(' · ')}</span> : null}</div>}
      {step.effect && <div className="row-sub">in {step.effect.ownerName} · matched on {step.effect.via}</div>}
      {repeat && <div className="row-sub">already shown above</div>}
      {step.navigation && <div className="row-sub">opens another page: its steps are its own flow</div>}
    </div>
  );
}
function LinkLine({ link }: { link: StepLink }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const labels = linkLabel(link);
  return (
    <li className="steps-link">
      <span className="steps-arrow" aria-hidden>↓</span>
      <span className="steps-link-text">
        {labels.length > 0 && <span className="step-when">{labels.join(' · ')}</span>}
        {link.via.length > 0 && <span className="step-via"> via {link.via.map(item => item.name).join(' › ')}</span>}
        {!labels.length && !link.via.length && <span className="absent">{link.hops.at(-1)?.type ?? 'effect'}</span>}
        {link.hops.length > 0 && <button className="button tiny" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? 'less' : `${link.hops.length} hop${link.hops.length === 1 ? '' : 's'}`}</button>}
      </span>
      {open && (
        <ol className="impact-chain">
          {link.hops.map(hop => (
            <li key={hop.relationId}>
              <span className="relation-phrase">{hop.type}</span>{hop.file ? <span className="mono"> {hop.file}{hop.line ? `:${hop.line}` : ''}</span> : null}{hop.sites > 1 ? <span className="absent"> · {hop.sites} sites</span> : null}
              {hop.when.length > 0 && <span className="step-when"> · {hop.when.map(guard => guard.phrase).join(' · ')}</span>}
              <button className="button tiny" onClick={() => void store.openEvidence(hop.relationId, { from: hop.from, to: hop.to, type: hop.type })}>Why?</button>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
/** The same steps laid out in layers, over the map area. */
function StepsDiagram({ data, onClose }: { data: StepsResult; onClose: () => void }) {
  const store = useStore();
  const focus = useAtlas(state => state.steps?.focus);
  const layout = useMemo(() => layoutSteps(data.steps.map(step => ({ id: step.id, layer: step.layer })), data.links.map(link => ({ id: link.id, from: link.from, to: link.to, back: link.back }))), [data]);
  const byId = useMemo(() => new Map(data.steps.map(step => [step.id, step])), [data]);
  const links = useMemo(() => new Map(data.links.map(link => [link.id, link])), [data]);
  const scroller = useRef<HTMLDivElement>(null);
  // Open on the start of the picture: it is centered over the widest layer.
  useEffect(() => {
    const anchor = layout.boxes.find(box => box.id === data.anchor.id), element = scroller.current;
    if (anchor && element) element.scrollLeft = Math.max(0, anchor.x + anchor.w / 2 - element.clientWidth / 2);
  }, [layout, data]);
  return (
    <div className="steps-diagram" role="dialog" aria-label={`What happens from ${data.anchor.name}`} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <div className="panel-header">
        <h2>What happens from {data.anchor.name}</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Close diagram" autoFocus>✕</button>
      </div>
      <div className="steps-diagram-body" ref={scroller}>
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Steps diagram">
          <defs><marker id="steps-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="steps-arrowhead" /></marker></defs>
          {layout.edges.map(edge => {
            const link = links.get(edge.id)!;
            const labels = linkLabel(link);
            const lit = !!focus && (edge.from === focus || edge.to === focus);
            return (
              <g key={edge.id} className={`steps-edge${edge.back ? ' back' : ''}${lit ? ' lit' : ''}`}>
                <path d={edge.path} markerEnd="url(#steps-arrow)" />
                {labels.length > 0 && <text x={edge.label.x} y={edge.label.y} textAnchor="middle">{labels[0]!.length > 30 ? `${labels[0]!.slice(0, 29)}…` : labels[0]}</text>}
                <title>{[...labels, link.via.length ? `via ${link.via.map(item => item.name).join(' › ')}` : ''].filter(Boolean).join('\n') || link.hops.map(hop => hop.type).join(' → ')}</title>
              </g>
            );
          })}
          {layout.boxes.map(box => {
            const step = byId.get(box.id)!;
            const title = stepTitle(step);
            const sub = step.effect ? step.effect.detail : step.node ? typeLabel(step.node.type, step.node.role) : '';
            return (
              <g key={box.id} className={`steps-box kind-${step.kind}${focus === step.id ? ' focused' : ''}`} transform={`translate(${box.x},${box.y})`} tabIndex={0} role="button" aria-label={`${KIND_TEXT[step.kind]} ${title}`}
                onClick={() => { store.focusStep(step.id); if (step.node) void store.select(step.node.id, { fly: true }); else if (step.effect) void store.select(step.effect.owner, { fly: true }); }}
                onDoubleClick={() => step.node && void store.openSteps(step.node.id)}
                onKeyDown={event => { if (event.key === 'Enter' && step.node) void store.select(step.node.id, { fly: true }); }}>
                <rect width={box.w} height={box.h} rx={9} />
                <text x={10} y={18} className="steps-box-kind">{(step.effect ? `${EFFECT_ICON[step.effect.category] ?? '•'} ` : '') + KIND_TEXT[step.kind]}{step.app ? ` · ${step.app}` : ''}</text>
                <text x={10} y={36} className="steps-box-title">{title.length > 25 ? `${title.slice(0, 24)}…` : title}</text>
                <text x={10} y={52} className="steps-box-sub">{sub.length > 34 ? `${sub.slice(0, 33)}…` : sub}</text>
                <title>{[title, sub, step.navigation ? 'Opens another page: its steps are its own flow' : '', step.node ? 'Double-click to start from here' : ''].filter(Boolean).join('\n')}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
