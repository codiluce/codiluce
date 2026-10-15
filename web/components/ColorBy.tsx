'use client';
import { useEffect, useRef, useState } from 'react';
import type { MetricLensResult } from '@engine/projection/dto';
import { LENS_TEXT, levelRange } from '../lib/lenses';
import type { ColorMode } from '../lib/store';
import { levelCss, themeById } from '../lib/themes';
import { windowText, WindowPicker } from './PeoplePanel';
import { useAtlas, useStore } from './context';

const MODES: { mode: ColorMode; label: string; hint: string; group: string }[] = [
  { mode: 'type', label: 'Type', hint: 'What each block is, in the theme’s colors', group: 'Structure' },
  { mode: 'coverage', label: 'Flow coverage', hint: 'Which files flows touch: entry points, in flows, supporting, not reached (not test coverage)', group: 'Structure' },
  { mode: 'families', label: 'Data families', hint: 'The tables each file uses, or the code it uses does', group: 'Structure' },
  { mode: 'complexity', label: LENS_TEXT.complexity.label, hint: LENS_TEXT.complexity.hint, group: 'Code health' },
  { mode: 'hotspots', label: LENS_TEXT.hotspots.label, hint: LENS_TEXT.hotspots.hint, group: 'Code health' },
  { mode: 'changes', label: LENS_TEXT.changes.label, hint: LENS_TEXT.changes.hint, group: 'History' },
  { mode: 'people', label: 'People', hint: 'Who changed each file most, in the people window', group: 'History' },
];

const MENU_WIDTH = 320;
/** Under the button, inside the window: right-aligned with it when there is room. */
function under(button: HTMLElement): React.CSSProperties {
  const at = button.getBoundingClientRect(), width = Math.min(MENU_WIDTH, window.innerWidth - 24);
  return { top: at.bottom + 6, left: Math.max(12, Math.min(at.right - width, window.innerWidth - width - 12)), width };
}

/** What colors the files on the map: one choice at a time. */
export function ColorBy() {
  const store = useStore();
  const mode = useAtlas(state => store.colorMode(state));
  const tables = useAtlas(state => state.meta?.coverage.databaseTables ?? 0);
  const [open, setOpen] = useState(false);
  // Placed under the button, kept inside the window (its right edge when there is room).
  const [place, setPlace] = useState<React.CSSProperties>();
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const modes = MODES.filter(item => item.mode !== 'families' || tables > 0 || mode === 'families');
  const current = MODES.find(item => item.mode === mode)!;
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', onDown); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', close); };
  }, [open]);
  const choose = (next: ColorMode) => { setOpen(false); button.current?.focus(); void store.colorBy(next); };
  const onKey = (event: React.KeyboardEvent) => {
    const items = [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <div className="color-by" ref={root} onKeyDown={open ? onKey : undefined}>
      <button ref={button} className="button" onClick={() => { if (!open) setPlace(under(button.current!)); setOpen(!open); }} aria-haspopup="menu" aria-expanded={open} data-active={mode !== 'type'} aria-label={`Color by: ${current.label}`} title={`What colors the files on the map. Now: ${current.hint}`}>
        Color: {current.label} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div ref={menu} className="color-by-menu" role="menu" aria-label="Color by" style={place}>
          {[...new Set(modes.map(item => item.group))].map(group => (
            <div key={group} role="group" aria-label={group}>
              <div className="color-by-group" aria-hidden>{group}</div>
              {modes.filter(item => item.group === group).map(item => (
                <button key={item.mode} role="menuitemradio" aria-checked={item.mode === mode} tabIndex={-1} onClick={() => choose(item.mode)}>
                  <span className="color-by-mark" aria-hidden>{item.mode === mode ? '●' : ''}</span>
                  <span className="color-by-text"><strong>{item.label}</strong><small>{item.hint}</small></span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** While a measure colors the map: what decides each level, how many files, and the highest ones. */
export function LensLegend() {
  const store = useStore();
  const lens = useAtlas(state => state.lens);
  const stamp = useAtlas(() => store.lensStamp());
  const dark = themeById(useAtlas(state => state.themeId)).dark;
  useEffect(() => { const state = store.getState().lens; if (state.show && state.status !== 'loading' && state.stamp !== stamp) void store.loadLens(); }, [store, lens.show, stamp]);
  if (!lens.show) return null;
  const shown = lens.show, text = LENS_TEXT[shown];
  const data = lens.data?.lens === shown && lens.stamp === stamp ? lens.data : undefined;
  return (
    <div className="coverage-legend families-legend lens-legend" role="region" aria-label={`${text.label} lens`}>
      <div className="coverage-legend-head">
        <strong>{text.label}</strong>
        <button className="icon-button small" onClick={() => void store.colorBy('type')} aria-label={`Stop coloring by ${text.label.toLowerCase()}`}>✕</button>
      </div>
      {shown !== 'complexity' && <WindowPicker />}
      {lens.status === 'loading' && !data && <p className="absent">{shown === 'complexity' ? 'Reading the measurements…' : 'Reading the Git history…'}</p>}
      {lens.status === 'error' && <p className="note error">{lens.error}</p>}
      {data && !data.available && <p className="absent">{data.reason}</p>}
      {data?.available && (
        <>
          <p className="absent">{text.basis}{data.window ? ` ${windowText(data.window)}.` : ''}</p>
          <ul className="coverage-keys lens-keys">
            {[...data.levels].reverse().map(level => (
              <li key={level.level}>
                <span className="type-dot" style={{ background: levelCss(String(level.level), dark) }} />
                <span className="lens-level">{text.levels[level.level]} <span className="absent">{levelRange(shown, level)}</span></span>
                <span className="count">{level.files}</span>
              </li>
            ))}
            {data.without > 0 && <li><span className="type-dot" style={{ background: levelCss('none', dark) }} /><span className="lens-level">{text.none}</span><span className="count">{data.without}</span></li>}
          </ul>
          {data.top.length > 0 && (
            <>
              <div className="lens-top-head">{shown === 'changes' ? 'Most changed' : shown === 'hotspots' ? 'Hottest' : 'Most complex'}</div>
              <ul className="lens-top">
                {data.top.map(item => (
                  <li key={item.id}>
                    <button onClick={() => void store.select(item.id, { fly: true })} title={`${item.path}: select it`}>
                      <span className="type-dot" style={{ background: levelCss(String(item.level), dark) }} />
                      <span className="lens-top-name">{item.path.split('/').at(-1)}</span>
                      <span className="count">{topValue(shown, item)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="absent">{shown === 'changes' ? 'Symbols take their file’s color.' : 'Zoomed in, functions show their own complexity.'} Closed areas show how many files they hold at their highest level.</p>
        </>
      )}
    </div>
  );
}
function topValue(lens: MetricLensResult['lens'], item: MetricLensResult['top'][number]): string {
  const commits = item.commits !== undefined ? `${item.commits} commit${item.commits === 1 ? '' : 's'}` : '';
  if (lens === 'changes') return commits;
  if (lens === 'complexity') return `complexity ${item.complexity}`;
  return `${commits} · complexity ${item.complexity}`;
}
