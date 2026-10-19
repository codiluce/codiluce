'use client';
// "Explain" where the code is: in the inspector, on a flow, on a commit. Each
// suggestion asks the chat in the Explanations column (when a model has a
// key) or copies a prompt for an agent connected to Codiluce over MCP.
import { useState } from 'react';
import { agentPrompt, type PromptTarget } from '@engine/explanations/prompts';
import type { ExplanationSummary } from '@engine/explanations/model';
import { useAtlas, useStore } from './context';
import { TemplateIcon } from './TemplateIcon';

export interface Suggestion { target: PromptTarget; text: string; title: string }

/** Copy text to the clipboard (falls back to a selected text area where the Clipboard API is refused). */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
  try {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}
/** A button that copies, and says so for a moment. */
export function CopyButton({ text, label = 'Copy', title, className = 'button tiny' }: { text: string | (() => string); label?: string; title?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button className={className} title={title} onClick={async () => { const ok = await copyText(typeof text === 'function' ? text() : text); setState(ok ? 'copied' : 'failed'); setTimeout(() => setState('idle'), 1600); }}>
      {state === 'copied' ? '✓ Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}
/** The agent prompt for a target, with how to connect Codiluce when it is not yet. */
export function useAgentPrompt(): (target: PromptTarget) => string {
  const setup = useAtlas(state => state.explain.setup);
  return target => agentPrompt(target, setup ? { setup: setup.mcp.claude } : {});
}
/** One row of suggestions: the first is the main "Explain"; each can be asked here or copied for an agent. */
export function ExplainActions({ suggestions, compact = false }: { suggestions: Suggestion[]; compact?: boolean }) {
  const store = useStore();
  const canAsk = useAtlas(state => !!state.explain.setup?.models.some(model => model.available) && !state.explain.setup?.readOnly);
  const prompt = useAgentPrompt();
  const [open, setOpen] = useState(false);
  if (!suggestions.length) return null;
  const [main, ...more] = suggestions;
  return (
    <div className={`explain-actions${compact ? ' compact' : ''}`}>
      <button className="button small explain-button" onClick={() => void store.askAbout(main!.target, main!.target.label)} title={canAsk ? `${main!.title} (in the Explanations column)` : `${main!.title}: opens the question in the Explanations column (add an API key to ask there, or copy the prompt for your agent)`}>✦ {main!.text}</button>
      <CopyButton text={() => prompt(main!.target)} label="Copy prompt" className="button small" title="Copy a prompt for your agent (Claude Code, Codex, Cursor…) connected to Codiluce over MCP; it saves its answer here" />
      {more.length > 0 && <button className="icon-button small" aria-expanded={open} onClick={() => setOpen(value => !value)} title="More questions about it">⋯</button>}
      {open && more.length > 0 && (
        <ul className="explain-more" role="menu">
          {more.map(item => (
            <li key={item.text} role="none">
              <button role="menuitem" className="link-button" onClick={() => { setOpen(false); void store.askAbout(item.target, item.target.label); }} title={item.title}>{item.target.template && <TemplateIcon id={item.target.template.id} size={22} />}{item.text}</button>
              <CopyButton text={() => prompt(item.target)} label="Copy prompt" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
/** Explanations already written about something: open one in the column. */
export function ExplanationChips({ items, label = 'Explained' }: { items: ExplanationSummary[]; label?: string }) {
  const store = useStore();
  if (!items.length) return null;
  return (
    <div className="explanation-chips" aria-label={label}>
      {items.slice(0, 3).map(item => (
        <button key={item.id} className={`chip explanation-chip${item.stale.changed || item.stale.missing ? ' stale' : ''}`} onClick={() => void store.openExplanations({ id: item.id })} title={`${item.title}${item.stale.changed || item.stale.missing ? ' (the code it links changed since)' : ''}: open it in the Explanations column`}>
          ✦ {item.title}
        </button>
      ))}
      {items.length > 3 && <button className="chip" onClick={() => void store.openExplanations()}>+{items.length - 3}</button>}
    </div>
  );
}
