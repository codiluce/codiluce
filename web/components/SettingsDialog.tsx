'use client';
import { useEffect, useRef, useState } from 'react';
import { THEMES } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { HiddenPathsSettings } from './MapVisibility';

const TABS = [['appearance', 'Appearance'], ['map', 'Map'], ['views', 'Views'], ['hidden', 'Hidden paths']] as const;
/** How the map looks, everywhere it is drawn; the first choice of each is the default. */
const VIEW_GROUPS: { key: 'map' | 'focus'; label: string; note: string; choices: [string, string][] }[] = [
  { key: 'map', label: 'Map projection', note: 'The map seen from straight above, as a plan where every area is a frame, or as an isometric city. One projection for everything: the map, History’s commits, Focus and Agents at work (who hop from roof to roof in isometric). The 3D control on the map switches it too.', choices: [['plan', '2D plan'], ['iso', 'Isometric']] },
  { key: 'focus', label: 'Focus layout', note: 'A selection and what it is connected to, a pull request’s files or what an explanation links: kept at their places on the map, the areas holding them opened as nested frames, or gathered and packed together.', choices: [['map', 'On the map'], ['gather', 'Gathered']] },
];
type SettingsTab = typeof TABS[number][0];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const themeId = useAtlas(state => state.themeId);
  const shapes = useAtlas(state => state.shapes);
  const connections = useAtlas(state => state.connections);
  const streets = useAtlas(state => state.streets);
  const views = useAtlas(state => state.views);
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled)') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  useEffect(() => {
    store.showHiddenPaths(tab === 'hidden');
    return () => store.showHiddenPaths(false);
  }, [store, tab]);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div ref={dialog} className="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}>
        <div className="settings-heading">
          <h2 id="settings-title">Settings</h2>
          <button ref={close} className="icon-button small" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <div className="segmented settings-tabs" role="tablist" aria-label="Settings categories">
          {TABS.map(([key, label], index) => <button key={key} id={`settings-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`settings-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            setTab(TABS[next]![0]);
            document.getElementById(`settings-tab-${TABS[next]![0]}`)?.focus();
          }}>{label}</button>)}
        </div>
        <div className="settings-body" id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'appearance' && <fieldset className="theme-picker">
            <legend className="settings-label">Theme</legend>
            <div className="theme-list">
              {THEMES.map(theme => {
                const font = theme.ui['--font'] ?? theme.style?.font ?? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
                const fontName = font.split(',')[0]!.replaceAll('"', '').replace(/ Variable$/, '').replace('system-ui', 'System');
                const entityColor = (type: string) => { const { h, s, l } = theme.entity[type] ?? theme.fallbackEntity; return `hsl(${h} ${s}% ${l}%)`; };
                const colors = [
                  ['Background', theme.ui['--bg'] ?? theme.background[0]], ['Panels', theme.ui['--panel-solid'] ?? theme.background[1]],
                  ['Text', theme.ui['--text'] ?? theme.text.primary], ['Accent', theme.ui['--accent'] ?? theme.selection],
                  ['Files', entityColor('file')], ['Components', entityColor('component')],
                ];
                return <label key={theme.id} className="theme-option" data-selected={themeId === theme.id}>
                  <input type="radio" name="theme" value={theme.id} aria-label={theme.name} checked={themeId === theme.id} tabIndex={themeId === theme.id ? 0 : -1} onChange={() => store.setTheme(theme.id)} />
                  <span className="theme-type" aria-hidden="true" title={`Typography: ${fontName}`} style={{ fontFamily: font, color: theme.ui['--text'], background: theme.ui['--panel-solid'] }}>A</span>
                  <span className="theme-name">{theme.name}<small>{theme.dark ? 'Dark' : 'Light'} · {fontName}</small></span>
                  <span className="theme-colors" aria-hidden="true">{colors.map(([label, color]) => <span key={label} className="theme-swatch" title={`${label}: ${color}`} style={{ background: color }} />)}</span>
                </label>;
              })}
            </div>
          </fieldset>}
          {tab === 'map' && <>
            <label className="toggle"><input type="checkbox" checked={shapes} onChange={event => store.setShapes(event.target.checked)} /> Building shapes</label>
            <p className="note">Each kind of block gets its own shape: controllers are rail turntables, tables are storage drums, and pages are browser billboards. Turn it off for plain blocks.</p>
            <label className="toggle"><input type="checkbox" checked={streets} onChange={event => store.setStreets(event.target.checked)} /> Streets between blocks</label>
            <p className="note">Leave streets between files and wider avenues between folders, or pack blocks edge to edge.</p>
            <span className="settings-label">Links on the map</span>
            <div className="segmented" role="group" aria-label="Links on the map">
              <button aria-pressed={connections === 'arcs'} onClick={() => store.setConnections('arcs')}>Arcs</button>
              <button aria-pressed={connections === 'rails'} onClick={() => store.setConnections('rails')}>Rails</button>
            </div>
            <p className="note">Draw links over the blocks, or along the floors at right angles. You can also switch from the map's link control.</p>
          </>}
          {tab === 'views' && <>
            {VIEW_GROUPS.map(group => <div key={group.key}>
              <span className="settings-label">{group.label}</span>
              <div className="segmented" role="group" aria-label={group.label}>
                {group.choices.map(([value, label]) => <button key={value} aria-pressed={views[group.key] === value} onClick={() => store.setViews({ [group.key]: value })}>{label}</button>)}
              </div>
              <p className="note">{group.note}</p>
            </div>)}
            <span className="settings-label">Arrow labels</span>
            <div className="segmented" role="group" aria-label="Arrow labels">
              {([['placed', 'Placed'], ['numbered', 'Numbered'], ['line', 'On the line']] as const).map(([value, label]) => <button key={value} aria-pressed={views.labels === value} onClick={() => store.setViews({ labels: value })}>{label}</button>)}
            </div>
            <p className="note">Placed: where they cover least, off names and blocks, as numbers with a legend when nothing fits. Numbered: always numbers. On the line: in the middle of the longest run. Labels never cover one another.</p>
          </>}
          {tab === 'hidden' && <HiddenPathsSettings />}
        </div>
      </div>
    </div>
  );
}
