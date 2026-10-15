'use client';
import { useEffect, useRef } from 'react';
import { useAtlas, useStore } from './context';

export function MapVisibilityUI() {
  const store = useStore();
  const state = useAtlas(state => state.mapVisibility);
  const rules = useAtlas(state => state.meta?.mapVisibility);
  const menu = useAtlas(state => state.mapMenu);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    menuButton.current?.focus();
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.map-context-menu')) store.closeMapMenu(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') store.closeMapMenu(); };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', key); };
  }, [menu, store]);
  return <>
    {menu && <div className="map-context-menu" role="menu" aria-label={`Map actions for ${menu.node.name}`} style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 248)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 100)) }}>
      <span className="mono absent">{menu.node.path}</span>
      <button ref={menuButton} role="menuitem" disabled={state.busy || !rules?.writable} onClick={() => void store.hideFromMap(menu.node)}>Hide from map</button>
    </div>}
    {(state.notice || state.error) && !state.open && <div className="map-visibility-notice" role={state.error ? 'alert' : 'status'}>
      <span>{state.error ?? state.notice}</span>
      {state.undo && !state.error && <button className="button small" disabled={state.busy} onClick={() => void store.undoMapVisibility()}>Undo</button>}
      <button className="icon-button small" aria-label="Dismiss map visibility message" onClick={() => store.dismissMapNotice()}>×</button>
    </div>}
  </>;
}

/** The same hide/restore preferences, inside Settings rather than another modal. */
export function HiddenPathsSettings() {
  const store = useStore();
  const state = useAtlas(state => state.mapVisibility);
  const rules = useAtlas(state => state.meta?.mapVisibility);
  if (!rules) return <p className="note">Map visibility settings are not available yet.</p>;
  return <div className="hidden-paths-settings">
    <p className="note">Hidden files stay available in search, code and connections. The map reclaims their space.</p>
    {!rules.writable && <p className="note">Start the server with a state directory to save map preferences.</p>}
    {state.error && <p className="note error" role="alert">{state.error}</p>}
    <h3>Local choices</h3>
    {!rules.hidden.length && <p className="absent">No locally hidden paths. Select a folder or file in the Inspector, or right-click it on the map.</p>}
    <ul className="list">{rules.hidden.map(path => <li className="row" key={path}><span className="row-main mono">{path}</span><button className="button small" disabled={state.busy || !rules.writable} onClick={() => void store.changeMapVisibility({ action: 'restore', path }, `${path} restored.`)} aria-label={`Restore ${path}`}>Restore</button></li>)}</ul>
    {!!rules.shared.length && <><h3>Shared rules</h3><p className="note">From <code>.codiluceignore</code>. Restoring a rule here saves a local override.</p><ul className="list">{rules.shared.filter(pattern => !pattern.startsWith('!')).map((pattern, index) => <li className="row" key={`${index}:${pattern}`}><span className="row-main mono">{pattern}{rules.disabledShared.includes(pattern) && <span className="absent"> · restored locally</span>}</span><button className="button small" disabled={state.busy || !rules.writable} onClick={() => void store.changeMapVisibility({ action: rules.disabledShared.includes(pattern) ? 'enable-rule' : 'disable-rule', pattern })}>{rules.disabledShared.includes(pattern) ? 'Hide again' : 'Restore'}</button></li>)}</ul></>}
    {!!rules.revealed.length && <><h3>Visible exceptions</h3><ul className="list">{rules.revealed.map(path => <li className="row" key={path}><span className="row-main mono">{path}</span><button className="button small" disabled={state.busy || !rules.writable} onClick={() => void store.changeMapVisibility({ action: 'conceal', path })}>Remove exception</button></li>)}</ul></>}
    <p className="note">Local choices are saved per repository. To share defaults with your team, add paths such as <code>/docs/</code> to <code>.codiluceignore</code> at the repository root.</p>
    <div className="inspector-actions"><button className="button" disabled={state.busy || !rules.writable || !rules.hidden.length && !rules.shared.some(rule => !rule.startsWith('!') && !rules.disabledShared.includes(rule)) && !rules.revealed.length} onClick={() => void store.changeMapVisibility({ action: 'restore-all' }, 'All paths restored.')}>Restore all</button>{state.undo && <button className="button" disabled={state.busy} onClick={() => void store.undoMapVisibility()}>Undo</button>}</div>
  </div>;
}
