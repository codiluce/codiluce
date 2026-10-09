'use client';

import { useEffect, useRef, useState } from 'react';
import {
  GAP_GHOSTS, GAP_MILESTONES, agentOutput, comprehension, gapArea, gapLine, gapScale, humanComprehension,
} from '../lib/gap';

const DRAW_MS = 3600;
const LIFT_MS = 1400;
const AGENT_DOTS = 16;
const HUMAN_DOTS = 5;
const DEFAULT_SIZE = { width: 930, height: 520 };

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeLift = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** Everything the animation moves, found once by `data-part`. */
function partsOf(root: HTMLElement) {
  const one = <T extends Element>(name: string) => root.querySelector<T>(`[data-part="${name}"]`)!;
  const all = <T extends Element>(name: string) => Array.from(root.querySelectorAll<T>(`[data-part="${name}"]`));
  return {
    plot: one<HTMLDivElement>('plot'),
    svg: one<SVGSVGElement>('svg'),
    axis: one<SVGPathElement>('axis'),
    ghosts: all<SVGPathElement>('ghost'),
    band: one<SVGPathElement>('band'),
    before: one<SVGPathElement>('before'),
    human: one<SVGPathElement>('human'),
    agentGlow: one<SVGPathElement>('agent-glow'),
    agent: one<SVGPathElement>('agent'),
    gap: one<SVGPathElement>('gap'),
    ends: all<SVGCircleElement>('gap-end'),
    heads: all<SVGGElement>('head'),
    agentDots: all<SVGCircleElement>('agent-dot'),
    humanDots: all<SVGCircleElement>('human-dot'),
    ticks: all<SVGPathElement>('tick'),
    milestones: all<HTMLSpanElement>('milestone'),
    labels: all<HTMLSpanElement>('label'),
  };
}

/**
 * "The comprehension gap is widening": agent output against human comprehension, drawn as time sweeps right when the
 * section comes into view. The switch turns Codiluce on, and comprehension rises to follow the output.
 */
export function ComprehensionGap() {
  const root = useRef<HTMLDivElement>(null);
  const [lifted, setLifted] = useState(false);
  const liftTarget = useRef(0);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const parts = partsOf(element);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    let size = { ...DEFAULT_SIZE };
    let progress = still.matches ? 1 : 0;
    let drawStart: number | undefined;
    let on = liftTarget.current;
    let lift = { from: on, to: on, start: 0 };
    let visible = false;
    let frame = 0;
    let last = performance.now();
    let march = 0;

    const render = (now: number) => {
      const scale = gapScale(size.width, size.height);
      const t = progress;
      const human = (x: number) => comprehension(x, on);
      parts.svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
      parts.axis.setAttribute('d', `M0 ${scale.axis}H${size.width - 2}M${size.width - 10} ${scale.axis - 5}L${size.width - 2} ${scale.axis}L${size.width - 10} ${scale.axis + 5}`);
      GAP_GHOSTS.forEach((ghost, i) => parts.ghosts[i]?.setAttribute('d', gapLine(ghost.f, 0, Math.min(t, ghost.end), scale, 90)));
      parts.band.setAttribute('d', on > 0.001 ? gapArea(humanComprehension, human, t, scale) : '');
      parts.band.style.opacity = String(on);
      parts.before.setAttribute('d', on > 0.001 ? gapLine(humanComprehension, 0, t, scale) : '');
      parts.before.style.opacity = String(on * 0.7);
      parts.human.setAttribute('d', gapLine(human, 0, t, scale));
      const agentPath = gapLine(agentOutput, 0, t, scale);
      parts.agent.setAttribute('d', agentPath);
      parts.agentGlow.setAttribute('d', agentPath);

      // The gap: a dashed line at the edge of time, from comprehension up to output.
      const gx = scale.x(t), top = scale.y(agentOutput(t)), bottom = scale.y(human(t));
      const showGap = t > 0.45 && bottom - top > 14;
      parts.gap.setAttribute('d', showGap ? `M${gx} ${top + 6}V${bottom - 6}` : '');
      parts.gap.style.strokeDashoffset = String(march);
      parts.ends.forEach((end, i) => {
        end.setAttribute('cx', String(gx));
        end.setAttribute('cy', String(i ? bottom - 6 : top + 6));
        end.style.opacity = showGap ? '1' : '0';
      });
      [agentOutput, human].forEach((f, i) => {
        const head = parts.heads[i];
        if (!head) return;
        head.setAttribute('transform', `translate(${gx} ${scale.y(f(t))})`);
        head.style.opacity = t > 0.002 && t < 1 ? '1' : '0';
      });

      // Output flows along its curve, faster as it climbs; comprehension trickles.
      const flow = (dots: SVGCircleElement[], f: (x: number) => number, period: number) => dots.forEach((dot, i) => {
        if (still.matches || t < 1) { dot.style.opacity = '0'; return; }
        const s = ((now / period + i / dots.length) % 1 + 1) % 1;
        dot.setAttribute('cx', scale.x(s).toFixed(1));
        dot.setAttribute('cy', scale.y(f(s)).toFixed(1));
        dot.style.opacity = (Math.sin(Math.PI * s) * 0.85).toFixed(2);
      });
      flow(parts.agentDots, agentOutput, 5200);
      flow(parts.humanDots, human, 11000);

      GAP_MILESTONES.forEach((milestone, i) => {
        const reached = t >= milestone.x;
        const x = scale.x(milestone.x);
        parts.ticks[i]?.setAttribute('d', `M${x} ${scale.axis}V${scale.y(agentOutput(milestone.x)) + 4}`);
        parts.ticks[i]?.classList.toggle('is-on', reached);
        const pill = parts.milestones[i];
        if (pill) {
          pill.style.left = `${(x / size.width) * 100}%`;
          pill.style.top = `${scale.axis + 14}px`;
          pill.classList.toggle('is-on', reached);
        }
      });

      // Labels sit at the end of each curve, the gap's halfway between.
      const end = { agent: scale.y(agentOutput(1)), human: scale.y(human(1)), before: scale.y(humanComprehension(1)) };
      const at = { agent: end.agent, gap: (end.agent + end.human) / 2, human: end.human, lift: (end.human + end.before) / 2 };
      parts.labels.forEach(label => {
        const key = label.dataset.key as keyof typeof at;
        label.style.top = `${at[key]}px`;
        if (key === 'lift') label.style.opacity = String(on);
      });
      element.dataset.done = t >= 1 ? 'true' : 'false';
    };

    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (drawStart !== undefined && progress < 1) progress = ease(Math.min(1, (now - drawStart) / DRAW_MS));
      if (liftTarget.current !== lift.to) lift = { from: on, to: liftTarget.current, start: now };
      if (on !== lift.to) {
        const k = still.matches ? 1 : Math.min(1, (now - lift.start) / LIFT_MS);
        on = k >= 1 ? lift.to : lift.from + (lift.to - lift.from) * easeLift(k);
      }
      if (!still.matches) march -= dt * 0.012;
      render(now);
      frame = visible ? requestAnimationFrame(tick) : 0;
    };
    const wake = () => {
      if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };

    // Observers can queue several entries for the plot; the last one is current.
    const resize = new ResizeObserver(entries => {
      const entry = entries.at(-1);
      if (!entry) return;
      size = { width: Math.max(280, entry.contentRect.width), height: Math.max(220, entry.contentRect.height) };
      render(performance.now());
    });
    resize.observe(parts.plot);
    const seen = new IntersectionObserver(entries => {
      const entry = entries.at(-1);
      visible = !!entry?.isIntersecting;
      if (visible && drawStart === undefined && entry!.intersectionRatio >= 0.35) drawStart = performance.now();
      if (visible) wake();
    }, { threshold: [0, 0.35] });
    seen.observe(parts.plot);
    // The switch can be pressed while the chart is off screen (keyboard), so it wakes the loop too.
    element.addEventListener('gap:lift', wake);
    render(performance.now());

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      seen.disconnect();
      element.removeEventListener('gap:lift', wake);
    };
  }, []);

  const toggle = () => {
    const next = !lifted;
    setLifted(next);
    liftTarget.current = next ? 1 : 0;
    root.current?.dispatchEvent(new Event('gap:lift'));
  };

  return (
    <div className="gap" ref={root} data-done="false" data-lifted={lifted}>
      <div className="gap-copy">
        <p className="eyebrow">Why now</p>
        <h2 id="gap-title" className="section-title">The comprehension gap is widening.</h2>
        <p className="section-lede">
          More people and more agents are writing code, and every change is bigger than the last. Reading the diff no
          longer tells a team what the system does, which flows a change touches, or what it can break.
        </p>
        <button type="button" className="gap-switch" aria-pressed={lifted} onClick={toggle}>
          <span className="gap-switch-track" aria-hidden="true"><span className="gap-switch-thumb" /></span>
          With Codiluce
        </button>
        <p className="gap-switch-note">
          Codiluce keeps understanding in step with the code: every flow, dependency and change, linked to the source that
          proves it.
        </p>
      </div>

      <figure className="gap-figure" aria-labelledby="gap-title">
        <div className="gap-chart">
          <div className="gap-plot" data-part="plot">
            <svg data-part="svg" className="gap-svg" viewBox={`0 0 ${DEFAULT_SIZE.width} ${DEFAULT_SIZE.height}`} role="img" aria-labelledby="gap-desc">
              <desc id="gap-desc">
                Illustration: from autocomplete to coding agents to agents working in parallel, the code agents write grows
                exponentially while human comprehension of it barely rises, so the gap between them keeps widening. With
                Codiluce on, comprehension rises to follow the output and the gap narrows.
              </desc>
              <defs>
                <linearGradient id="gap-band" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#ffbf47" stopOpacity="0.32" />
                  <stop offset="1" stopColor="#ffbf47" stopOpacity="0.04" />
                </linearGradient>
                {[['agent', '#ff6a3d'], ['human', '#3ddc97']].map(([kind, color]) => (
                  <linearGradient key={kind} id={`gap-ghost-${kind}`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor={color} stopOpacity="0.04" />
                    <stop offset="0.65" stopColor={color} stopOpacity="0.22" />
                    <stop offset="1" stopColor={color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>
              <path data-part="axis" className="gap-axis" />
              {GAP_MILESTONES.map(milestone => <path key={milestone.label} data-part="tick" className="gap-tick" />)}
              {GAP_GHOSTS.map((ghost, i) => <path key={i} data-part="ghost" className={`gap-ghost ${ghost.kind}`} />)}
              <path data-part="band" className="gap-band" fill="url(#gap-band)" />
              <path data-part="before" className="gap-before" />
              <path data-part="human" className="gap-human" />
              <path data-part="agent-glow" className="gap-agent-glow" />
              <path data-part="agent" className="gap-agent" />
              <path data-part="gap" className="gap-line" />
              <circle data-part="gap-end" className="gap-end" r="2.5" />
              <circle data-part="gap-end" className="gap-end" r="2.5" />
              {Array.from({ length: AGENT_DOTS }, (_, i) => <circle key={i} data-part="agent-dot" className="gap-dot agent" r="2" />)}
              {Array.from({ length: HUMAN_DOTS }, (_, i) => <circle key={i} data-part="human-dot" className="gap-dot human" r="2" />)}
              <g data-part="head" className="gap-head agent"><circle r="10" /><circle r="3.5" /></g>
              <g data-part="head" className="gap-head human"><circle r="10" /><circle r="3.5" /></g>
            </svg>
            {GAP_MILESTONES.map(milestone => <span key={milestone.label} data-part="milestone" className="gap-milestone">{milestone.label}</span>)}
          </div>
          <div className="gap-labels">
            <span data-part="label" data-key="agent" className="gap-pill agent">Agent output</span>
            <span data-part="label" data-key="gap" className="gap-pill gap-key">Comprehension gap</span>
            <span data-part="label" data-key="human" className="gap-pill human">Human comprehension</span>
            <span data-part="label" data-key="lift" className="gap-pill lift">Lifted by Codiluce</span>
          </div>
        </div>
        <figcaption className="gap-caption">An illustration of the trend, not measured data.</figcaption>
      </figure>
    </div>
  );
}
