'use client';
import { useEffect, useRef, useState } from 'react';

/** Runs `tick` every `ms` while the element is on screen (and never with reduced motion). */
function useTicker(ms: number, tick: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry?.isIntersecting) timer = setInterval(() => latest.current(), ms);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearInterval(timer); };
  }, [ms]);
  return ref;
}

const PROMPT = 'Use Codiluce to explain how password reset works, and publish it.';
const CALLS = [
  { at: 2400, tool: 'start_explanation', detail: '“How a password reset works”' },
  { at: 3100, tool: 'flow', detail: 'POST /password/email' },
  { at: 3700, tool: 'source', detail: 'app/Http/Controllers/PasswordController.php' },
  { at: 4300, tool: 'impact', detail: 'table:password_resets' },
  { at: 5100, tool: 'publish_explanation', detail: '6 links checked ✓' },
];
const TYPE_MS = 1900, DONE_AT = 5900, LOOP_MS = 10000;

/** A coding agent's terminal, explaining through Codiluce's MCP tools and publishing to the map. */
export function AgentTerminal() {
  const [t, setT] = useState(LOOP_MS - 1);
  const ref = useTicker(100, () => setT(value => (value + 100) % LOOP_MS));
  const typed = PROMPT.slice(0, Math.round(PROMPT.length * Math.min(1, t / TYPE_MS)));
  return (
    <div ref={ref} className="term" aria-label={`A Claude Code session. The prompt: "${PROMPT}" It calls Codiluce's start_explanation, flow, source and impact tools, then publish_explanation, which checks six links and saves the answer to the map.`} role="img">
      <div className="term-head" aria-hidden="true"><span /><span /><span /><em>claude · acme/shop</em></div>
      <div className="term-body" aria-hidden="true">
        <p className="term-prompt"><span>&gt;</span> {typed}{t < TYPE_MS + 300 ? <i className="term-caret" /> : null}</p>
        {CALLS.filter(call => call.at <= t).map(call => (
          <p key={call.tool} className="term-call"><span className="term-bullet">●</span> codiluce · <b>{call.tool}</b><em>{call.detail}</em></p>
        ))}
        {t >= DONE_AT ? <p className="term-done">✻ Saved. It is in the Explain column of your map, with its links lit.</p> : null}
      </div>
    </div>
  );
}

const PRODUCTS = [
  { name: 'Claude Code', flag: 'claude-code', note: <>Merge the printed hooks into <code>.claude/settings.local.json</code>.</> },
  { name: 'Codex', flag: 'codex', note: <>Merge them into <code>.codex/hooks.json</code>, then trust them with <code>/hooks</code>.</> },
];

/** The map's Agent connections window: one hook configuration per product, and proof that its events arrive. */
export function HookStatus() {
  const [beat, setBeat] = useState(0);
  const ref = useTicker(1000, () => setBeat(value => value + 1));
  const product = PRODUCTS[Math.floor(beat / 5) % PRODUCTS.length]!, ago = beat % 5 % 3;
  return (
    <div ref={ref} className="hooks" role="img" aria-label="The map's Agent connections window: hook delivery confirmed for Claude Code and for Codex, and the command that prints each one's hook configuration.">
      <div className="hooks-head" aria-hidden="true"><strong>Agent connections</strong><span>×</span></div>
      <div className="hooks-body" aria-hidden="true">
        <div className="hooks-seg">{PRODUCTS.slice().reverse().map(item => <span key={item.flag} className={item === product ? 'is-on' : ''}>{item.name}</span>)}</div>
        <p className="hooks-state"><span className={`hooks-dot${ago === 0 ? ' is-ping' : ''}`} key={beat} /><strong>Hook delivery confirmed</strong><em>last hook {ago} s ago</em></p>
        <pre className="hooks-code"><span className="prompt">$ </span>npx codiluce activity hooks \{'\n'}    --agent {product.flag}</pre>
        <p className="hooks-note">{product.note}</p>
      </div>
    </div>
  );
}
