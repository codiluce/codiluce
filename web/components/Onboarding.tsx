'use client';
// The onboarding tour on screen (lib/onboarding.ts). On a first visit, the
// welcome card offers it with what was indexed. While it plays, a ring marks
// the control the stop is about and the rest of the screen dims a little;
// nothing is blocked. One card stands beside the ring with the stop's words,
// Back, Next and Skip (← → and Esc too). Doing what the card invites does
// what Next would. The closing card offers the chapters. HelpMenu, the ? of
// the top bar, takes the tour again, or one chapter.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CHAPTERS, chapterMissing, type StopContext } from '../lib/onboarding';
import type { AtlasStore } from '../lib/store';
import { useAtlas, useStore } from './context';

/** Plain words with **bold** and `code`. */
function Words({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.length > 4 && part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code>
      : part)}</>;
}
const count = (value: number, word: string) => `${value.toLocaleString('en')} ${word}${value === 1 ? '' : 's'}`;

export function Onboarding() {
  const running = useAtlas(state => !!state.onboarding.run);
  // Offered once the map is there, and not over an explanation's tour (it comes back after).
  const welcome = useAtlas(state => state.onboarding.welcome && state.status === 'ready' && state.center !== 'tour');
  if (running) return <TourLayer />;
  return welcome ? <Welcome /> : null;
}

function Welcome() {
  const store = useStore();
  const repository = useAtlas(state => state.onboarding.thread.data?.repository ?? state.meta?.run.repositoryName ?? 'your repository');
  const counts = useAtlas(state => state.onboarding.thread.data?.counts);
  const parts = counts ? [count(counts.files, 'file'), ...(counts.flows ? [count(counts.flows, 'flow')] : []), ...(counts.commits ? [`${count(counts.commits, 'commit')} of history`] : [])] : [];
  return (
    <section className="onboarding-welcome" role="dialog" aria-modal="false" aria-labelledby="onboarding-welcome-title">
      <button className="icon-button small onboarding-close" onClick={() => store.dismissWelcome()} aria-label="Close the welcome" title="Close">×</button>
      <h2 id="onboarding-welcome-title">Codiluce lit up <strong>{repository}</strong></h2>
      {parts.length > 0 && <p>{parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.</p>}
      <p className="onboarding-lead">A short tour follows one of its files across the map, its code, its flow, what depends on it and its history.</p>
      <div className="onboarding-actions">
        <button className="button primary" onClick={() => void store.startOnboarding()}>Take the 2-minute tour</button>
        <button className="button" onClick={() => store.dismissWelcome()}>Not now</button>
      </div>
    </section>
  );
}

interface Box { left: number; top: number; width: number; height: number }
/** Where the control a stop is about is on screen, measured again as the layout moves (undefined: not on screen). */
function useTarget(target: string | undefined, revision: unknown): Box | undefined {
  const [box, setBox] = useState<Box>();
  useEffect(() => {
    if (!target) { setBox(undefined); return; }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = document.querySelector(`[data-onboarding="${target}"]`)?.getBoundingClientRect();
        const next = rect && rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined;
        setBox(previous => previous && next && Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.top - next.top) < 0.5 && Math.abs(previous.width - next.width) < 0.5 && Math.abs(previous.height - next.height) < 0.5 ? previous : next);
      });
    };
    measure();
    // Panels slide and resize without telling: look again a few times a second.
    const timer = setInterval(measure, 300);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); window.removeEventListener('resize', measure); };
  }, [target, revision]);
  return box;
}
const MARGIN = 12, RING = 6;
/**
 * The card beside its target: below a control (above when there is no room;
 * right of it when asked and there is room),
 * inside a large area at its bottom left (left of one on the right, like the
 * inspector), at the bottom of the window without a target.
 */
function placeCard(target: Box | undefined, width: number, height: number, side?: 'right'): { left: number; top: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  const clampLeft = (left: number) => Math.max(MARGIN, Math.min(vw - width - MARGIN, left));
  const clampTop = (top: number) => Math.max(MARGIN, Math.min(vh - height - MARGIN, top));
  if (!target) return { left: clampLeft((vw - width) / 2), top: clampTop(vh - height - 72) };
  if (target.height > vh * 0.4) {
    if (target.left > vw / 2) return { left: clampLeft(target.left - width - MARGIN - RING), top: clampTop(target.top + 48) };
    return { left: clampLeft(target.left + 20), top: clampTop(target.top + target.height - height - 20) };
  }
  const right = target.left + target.width + MARGIN + RING;
  if (side === 'right' && right + width <= vw - MARGIN) return { left: right, top: clampTop(target.top) };
  const left = clampLeft(target.left + target.width / 2 - width / 2);
  const below = target.top + target.height + MARGIN + RING;
  return { left, top: below + height <= vh - MARGIN ? below : clampTop(target.top - height - MARGIN - RING) };
}
const focusedArea = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-onboarding]')?.dataset.onboarding;

function TourLayer() {
  const store = useStore();
  // The words read the state as it changes (counts that arrive, a time-lapse being prepared).
  const state = useAtlas(current => current);
  const run = state.onboarding.run!, thread = state.onboarding.thread;
  const stops = store.onboardingStops(state);
  const closing = !!thread.data && run.stop >= stops.length;
  const stop = thread.data && !closing ? stops[run.stop] : undefined;
  const missing = stop ? store.onboardingMissing(stop) : undefined;
  const target = useTarget(stop?.target, `${run.tour}:${run.stop}:${run.beat}`);
  const card = useRef<HTMLDivElement>(null), next = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const width = Math.min(360, (typeof window === 'undefined' ? 360 : window.innerWidth) - 2 * MARGIN);
  // After every render: the card's height follows its words.
  useLayoutEffect(() => {
    const spot = placeCard(closing ? undefined : target, width, card.current?.offsetHeight ?? 180, stop?.side);
    setPlace(previous => previous && Math.abs(previous.left - spot.left) < 0.5 && Math.abs(previous.top - spot.top) < 0.5 ? previous : spot);
  });
  // A new stop or beat: Next has the keyboard (unless something is being typed in).
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) next.current?.focus({ preventScroll: true });
  }, [run.tour, run.stop, run.beat, closing]);
  // Doing what the invite asks moves on, as Next would.
  useEffect(() => {
    const check = () => queueMicrotask(() => store.onboardingCheck(focusedArea()));
    const unsubscribe = store.subscribe(check);
    document.addEventListener('focusin', check);
    return () => { unsubscribe(); document.removeEventListener('focusin', check); };
  }, [store]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const element = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
      // A dialog over the page (Settings) keeps its own keys.
      if (typing || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); void store.exitOnboarding(); }
      // On the map, the arrows move the camera.
      else if (element.tagName !== 'CANVAS' && event.key === 'ArrowRight') { event.preventDefault(); void store.onboardingNext(); }
      else if (element.tagName !== 'CANVAS' && event.key === 'ArrowLeft') { event.preventDefault(); void store.onboardingBack(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const exit = () => void store.exitOnboarding();
  let title: string, body: React.ReactNode;
  if (thread.status === 'error') { title = 'The tour could not start'; body = <p className="onboarding-text">{thread.error}</p>; }
  else if (!thread.data) { title = 'Getting ready'; body = <p className="onboarding-text">Reading what the tour follows…</p>; }
  else if (closing) { title = run.tour === 'core' ? 'That was the tour' : `${CHAPTERS.find(chapter => chapter.key === run.tour)?.title ?? 'Chapter'}: done`; body = <Closing store={store} />; }
  else {
    const context: StopContext = { thread: thread.data, state, start: state, focused: undefined };
    const text = missing ?? (run.beat === 'show' && stop?.show ? stop.show.text(context) : stop?.invite(context) ?? '');
    title = stop?.title ?? '';
    body = <p className={`onboarding-text${missing ? ' missing' : ''}`} id="onboarding-text"><Words text={text} /></p>;
  }
  const label = closing || thread.status === 'error' ? 'Done' : 'Next';
  return (
    <>
      {target && !closing && <div className={`onboarding-ring${target.height > window.innerHeight * 0.4 ? ' area' : ''}`} aria-hidden style={{ left: target.left - RING, top: target.top - RING, width: target.width + 2 * RING, height: target.height + 2 * RING }} />}
      <div ref={card} className={`onboarding-card${closing ? ' closing' : ''}`} role="dialog" aria-modal="false" aria-label={`Tour: ${title}`} aria-describedby={closing ? undefined : 'onboarding-text'} aria-busy={run.busy || undefined}
        style={{ width, ...(place ?? { left: MARGIN, top: -9999 }) }}>
        <div className="onboarding-head">
          {!closing && thread.data && stops.length > 1 && <span className="onboarding-step">{run.stop + 1} of {stops.length}</span>}
          <h2 id="onboarding-title">{title}</h2>
          <button className="icon-button small onboarding-close" onClick={exit} aria-label="End the tour" title="End the tour (Esc)">×</button>
        </div>
        {body}
        <div className="onboarding-actions">
          {thread.data && <button className="button" onClick={() => void store.onboardingBack()} disabled={run.busy || (run.stop === 0 && run.beat === 'invite')} title="Back (←)">Back</button>}
          <button ref={next} className="button primary" onClick={() => void (closing || thread.status === 'error' ? store.exitOnboarding() : store.onboardingNext())} disabled={run.busy || (!thread.data && thread.status !== 'error')} title={closing ? 'End the tour' : 'Next (→)'}>{label}</button>
          {!closing && thread.data && <button className="button link onboarding-skip" onClick={exit}>Skip tour</button>}
        </div>
      </div>
    </>
  );
}

/** The chapters, after a tour: each shows itself, or says how to turn it on here. */
function Closing({ store }: { store: AtlasStore }) {
  const thread = useAtlas(state => state.onboarding.thread.data)!;
  const done = useAtlas(state => state.onboarding.chapters);
  const [opened, setOpened] = useState<string>();
  return (
    <div className="onboarding-chapters">
      <p className="onboarding-text">There is more to see here:</p>
      <ul>
        {CHAPTERS.map(chapter => {
          const missing = chapterMissing(chapter.key, thread);
          return (
            <li key={chapter.key}>
              <div className="onboarding-chapter-text">
                <strong>{chapter.title}{done.includes(chapter.key) && <span className="onboarding-done" aria-label="taken"> ✓</span>}</strong>
                <small>{chapter.text}</small>
              </div>
              {missing
                ? <button className="button small" aria-expanded={opened === chapter.key} onClick={() => setOpened(opened === chapter.key ? undefined : chapter.key)}>How to turn it on</button>
                : <button className="button small" onClick={() => void store.startOnboarding(chapter.key)} aria-label={`Show me ${chapter.title}`}>Show me</button>}
              {missing && opened === chapter.key && <p className="note onboarding-how"><Words text={missing} /></p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const MENU_WIDTH = 300;
/** The ? of the top bar: the tour, a chapter of it, or the keyboard and pointer. */
export function HelpMenu({ onKeyboard }: { onKeyboard: () => void }) {
  const store = useStore();
  const done = useAtlas(state => state.onboarding.chapters);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<React.CSSProperties>();
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', onDown); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', close); };
  }, [open]);
  const toggle = () => {
    if (!open && button.current) { const at = button.current.getBoundingClientRect(), width = Math.min(MENU_WIDTH, window.innerWidth - 24); setPlace({ top: at.bottom + 6, left: Math.max(12, Math.min(at.right - width, window.innerWidth - width - 12)), width }); }
    setOpen(!open);
  };
  const choose = (action: () => void) => { setOpen(false); action(); };
  const onKey = (event: React.KeyboardEvent) => {
    const items = [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <div className="help-menu" ref={root} onKeyDown={open ? onKey : undefined}>
      <button ref={button} className="icon-button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="Help" title="Help: the tour, and the keyboard and pointer">?</button>
      {open && (
        <div ref={menu} className="color-by-menu help-menu-list" role="menu" aria-label="Help" style={place}>
          <button role="menuitem" onClick={() => choose(() => void store.startOnboarding())}>
            <span className="color-by-text"><strong>Take the tour</strong><small>One file of this repository across the map, its code, its flow, its impact and its history</small></span>
          </button>
          <div className="color-by-group" role="presentation">Chapters</div>
          {CHAPTERS.map(chapter => (
            <button key={chapter.key} role="menuitem" onClick={() => choose(() => void store.startOnboarding(chapter.key))}>
              <span className="color-by-text"><strong>{chapter.title}{done.includes(chapter.key) && <span className="onboarding-done" aria-label="taken"> ✓</span>}</strong><small>{chapter.text}</small></span>
            </button>
          ))}
          <div className="color-by-group" role="presentation">Reference</div>
          <button role="menuitem" onClick={() => choose(onKeyboard)}>
            <span className="color-by-text"><strong>Keyboard and pointer</strong><small>Shortcuts, and how the map is drawn</small></span>
          </button>
        </div>
      )}
    </div>
  );
}
