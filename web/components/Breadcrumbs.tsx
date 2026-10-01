'use client';
import { Fragment } from 'react';
import { useAtlas, useStore } from './context';

/** Canonical ancestry of the selection (projection districts are not part of it). */
export function Breadcrumbs() {
  const store = useStore();
  const selection = useAtlas(state => state.selection);
  const meta = useAtlas(state => state.meta);
  const chain = selection?.locate ? [...selection.locate.canonicalAncestors, { id: selection.locate.node.id, type: selection.locate.node.type, name: selection.locate.node.name }] : undefined;
  return (
    <nav className="breadcrumbs" aria-label="Canonical location of the selection">
      {!chain && meta && <><button className="crumb" onClick={() => store.navigator?.fitAll()}>{meta.run.repositoryName}</button><span className="hint">— select something on the map or search to see its canonical location</span></>}
      {chain?.map((item, index) => (
        <Fragment key={item.id}>
          {index > 0 && <span className="sep" aria-hidden>›</span>}
          <button className="crumb" aria-current={index === chain.length - 1} onClick={() => void store.select(item.id, { fly: true })} title={item.type}>{item.name}</button>
        </Fragment>
      ))}
      {selection?.locate && selection.locate.node.kind === 'group' && <span className="hint">· projection district (not an indexed entity)</span>}
    </nav>
  );
}
