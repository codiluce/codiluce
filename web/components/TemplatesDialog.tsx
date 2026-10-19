'use client';
// The Explain templates, to start a question from: a search, the categories,
// and a card per template with its icon and the [placeholders] it asks for.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { placeholdersIn, TEMPLATE_GROUPS, TEMPLATES, type ExplainTemplate, type TemplateGroup } from '@engine/explanations/templates';
import { TemplateIcon } from './TemplateIcon';

/** A placeholder as a short label: `feature`, not `feature, e.g. password reset`. */
export function blankLabel(text: string): string { return text.split(', e.g.')[0]!; }

export function TemplatesDialog({ container, onChoose, onClose }: { container: Element; onChoose: (template: ExplainTemplate) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<TemplateGroup | 'all'>('all');
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // The opener re-renders often (agents are polled): keep the latest close without re-running the effect below.
  const close = useRef(onClose);
  close.current = onClose;
  const matching = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return TEMPLATES.filter(item => words.every(word => `${item.title} ${item.description} ${item.text} ${item.group}`.toLowerCase().includes(word)));
  }, [query]);
  const shown = group === 'all' ? matching : matching.filter(item => item.group === group);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    // Back where it was opened from (a chosen template then moves it to the question).
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);

  const cards = () => [...(dialog.current?.querySelectorAll<HTMLButtonElement>('.template-card') ?? [])];
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && shown[0]) { event.preventDefault(); onChoose(shown[0]); }
    if (event.key === 'ArrowDown') { event.preventDefault(); cards()[0]?.focus(); }
  };
  // Arrows move between the cards, in reading order.
  const onCardsKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const list = cards(), index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    if (index + step < 0) search.current?.focus();
    else list[Math.min(list.length - 1, index + step)]?.focus();
  };
  const sections = TEMPLATE_GROUPS.map(item => ({ ...item, templates: shown.filter(template => template.group === item.id) })).filter(item => item.templates.length);

  return createPortal(
    <div className="settings-backdrop templates-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} className="templates-card" role="dialog" aria-modal="true" aria-labelledby="templates-title" aria-describedby="templates-note">
        <div className="templates-heading">
          <div>
            <h2 id="templates-title">Start from a template</h2>
            <p id="templates-note" className="templates-sub">Common questions about a codebase. Pick one, fill its <span className="mono">[placeholders]</span>, then ask here or copy it for your agent.</p>
          </div>
          <button className="icon-button small" onClick={onClose} aria-label="Close templates">×</button>
        </div>
        <div className="templates-search">
          <label className="sr-only" htmlFor="templates-query">Search templates</label>
          <input ref={search} id="templates-query" className="text-input" type="search" placeholder="Search: security, tests, a feature…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKey} autoComplete="off" />
        </div>
        <div className="templates-layout">
          <nav className="templates-groups" aria-label="Categories">
            {[{ id: 'all' as const, title: 'All', description: 'Every template' }, ...TEMPLATE_GROUPS].map(item => {
              const count = item.id === 'all' ? matching.length : matching.filter(template => template.group === item.id).length;
              return (
                <button key={item.id} className="templates-group" aria-pressed={group === item.id} onClick={() => setGroup(item.id)} title={item.description} disabled={!count && group !== item.id}>
                  <span>{item.title}</span><span className="count">{count}</span>
                </button>
              );
            })}
          </nav>
          <div className="templates-list" onKeyDown={onCardsKey}>
            {sections.map(section => (
              <section key={section.id} className="templates-section" aria-labelledby={`templates-${section.id}`}>
                <h3 id={`templates-${section.id}`}>{section.title} <span className="templates-sub">{section.description}</span></h3>
                <div className="templates-grid">
                  {section.templates.map(template => {
                    const blanks = [...new Set(placeholdersIn(template.text).map(blank => blankLabel(blank.text)))];
                    return (
                      <button key={template.id} className="template-card" onClick={() => onChoose(template)} title={template.text}>
                        <TemplateIcon id={template.id} size={60} />
                        <span className="template-card-text">
                          <span className="template-card-title">{template.title}</span>
                          <span className="template-card-description">{template.description}</span>
                          {blanks.length > 0 && <span className="template-card-blanks">{blanks.map(blank => <span key={blank} className="blank">{blank}</span>)}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            {!sections.length && <p className="absent">No template matches “{query}”.</p>}
          </div>
        </div>
      </div>
    </div>,
    container,
  );
}
