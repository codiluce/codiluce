'use client';
import { Fragment } from 'react';
import { typeLabel } from '../lib/format';
import { nextPlayable } from '../lib/playback';
import { useAtlas, useStore } from './context';

export function FlowPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const flows = useAtlas(state => state.flows);
  return (
    <>
      <div className="panel-header">
        <h2>Flows</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Close flows panel">⇤</button>
      </div>
      <div className="panel-body">
        <p className="note">A flow is a named sequence of entities: one you choose (declared), or the shortest path of indexed relationships between two entities (static). Neither is observed runtime behaviour. Two steps are joined by a solid link only when an indexed relationship connects them.</p>
        {flows.storageError && <p className="note error">{flows.storageError}</p>}
        {flows.draft ? <DraftEditor /> : <button className="button primary" onClick={() => store.startDraft()}>New flow</button>}
        {flows.activeId && <ActiveFlow />}
        <section className="section" style={{ marginTop: 10 }}>
          <h4>Saved flows</h4>
          {flows.flows.length === 0 && <p className="absent">No saved flows for this repository yet.</p>}
          <ul className="list">
            {flows.flows.map(flow => (
              <li key={flow.id} className={`row${flow.id === flows.activeId ? ' emphasized' : ''}`}>
                <div className="row-main">
                  <div className="row-title"><span className="label">{flow.name}</span></div>
                  <div className="row-sub">{flow.steps.length} steps · {flow.type === 'static' ? 'static (a path of indexed relationships)' : 'declared'}</div>
                </div>
                <div className="row-actions">
                  {flow.id === flows.activeId ? <button className="button small" onClick={() => store.deactivateFlow()}>Hide</button> : <button className="button small" onClick={() => void store.activateFlow(flow.id)}>Show</button>}
                  <button className="button small" onClick={() => store.editFlow(flow.id)} disabled={!!flows.draft}>Edit</button>
                  <button className="button small" onClick={() => store.deleteFlow(flow.id)} aria-label={`Delete flow ${flow.name}`}>✕</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
function DraftEditor() {
  const store = useStore();
  const draft = useAtlas(state => state.flows.draft)!;
  const selection = useAtlas(state => state.selection);
  useAtlas(state => state.sceneRevision);
  const canAdd = selection?.node?.kind === 'entity';
  return (
    <section className="section" aria-label={draft.id ? 'Edit flow' : 'New flow'}>
      <h4>{draft.id ? 'Edit flow' : 'New flow'}</h4>
      <label className="sr-only" htmlFor="flow-name">Flow name</label>
      <input id="flow-name" className="text-input" placeholder="Flow name, e.g. Login request" value={draft.name} onChange={event => store.setDraftName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void store.saveDraft(); }} />
      <p className="absent" style={{ margin: '8px 0' }}>Click entities on the map to append them, or add the current selection — or build the steps from a path.</p>
      <PathBuilder />
      <button className="button small" disabled={!canAdd} onClick={() => selection && store.addDraftStep(selection.id)}>Add selection{canAdd ? `: ${selection!.node!.name}` : ''}</button>
      <ol className="list" style={{ marginTop: 8 }} aria-label="Steps">
        {draft.entityIds.map((id, index) => {
          const node = store.scene.nodes.get(id);
          return (
            <li key={`${id}-${index}`} className="flow-step">
              <span className="num">{index + 1}</span>
              <span style={{ minWidth: 0 }}><strong>{node?.name ?? id}</strong><br /><span className="absent">{node ? typeLabel(node.type, node.role) : 'entity'}</span></span>
              <span className="row-actions">
                <button className="icon-button small" onClick={() => store.moveDraftStep(index, index - 1)} disabled={index === 0} aria-label={`Move step ${index + 1} up`}>↑</button>
                <button className="icon-button small" onClick={() => store.moveDraftStep(index, index + 1)} disabled={index === draft.entityIds.length - 1} aria-label={`Move step ${index + 1} down`}>↓</button>
                <button className="icon-button small" onClick={() => store.removeDraftStep(index)} aria-label={`Remove step ${index + 1}`}>✕</button>
              </span>
            </li>
          );
        })}
      </ol>
      {draft.error && <div className="field-error" role="alert">{draft.error}</div>}
      <div className="inspector-actions">
        <button className="button primary small" onClick={() => void store.saveDraft()}>Save flow</button>
        <button className="button small" onClick={() => store.cancelDraft()}>Cancel</button>
      </div>
    </section>
  );
}
/** Fill the draft with the shortest chain of indexed relationships between two entities. */
function PathBuilder() {
  const store = useStore();
  const draft = useAtlas(state => state.flows.draft)!;
  const selection = useAtlas(state => state.selection);
  useAtlas(state => state.sceneRevision);
  const canUse = selection?.node?.kind === 'entity';
  const path = draft.path;
  const name = (id?: string) => id ? store.scene.nodes.get(id)?.name ?? 'entity' : undefined;
  return (
    <div className="path-builder" role="group" aria-label="Build from a path">
      <div className="path-ends">
        <span className="absent">From</span><strong>{name(path?.from) ?? '—'}</strong>
        <button className="button small" disabled={!canUse} onClick={() => store.setPathEnd('from')}>Use selection</button>
        <span className="absent">To</span><strong>{name(path?.to) ?? '—'}</strong>
        <button className="button small" disabled={!canUse} onClick={() => store.setPathEnd('to')}>Use selection</button>
      </div>
      <button className="button small" disabled={!path?.from || !path?.to || path.status === 'loading'} onClick={() => void store.draftPath()}>{path?.status === 'loading' ? 'Finding…' : 'Find path'}</button>
      {draft.type === 'static' && <span className="chip">static: a path of indexed relationships</span>}
      {path?.notice && <p className={`note${path.status === 'error' ? ' error' : ''}`}>{path.notice}</p>}
    </div>
  );
}
function ActiveFlow() {
  const store = useStore();
  const flows = useAtlas(state => state.flows);
  const resolved = flows.resolved;
  const flow = flows.flows.find(item => item.id === flows.activeId);
  const state = flows.playback;
  if (!flow || !resolved) return null;
  const missing = resolved.steps.filter(step => step.missing).length;
  const next = nextPlayable(state);
  return (
    <section className="section" aria-label={`Flow ${flow.name}`}>
      <h4>Showing: {flow.name}</h4>
      {resolved.status === 'loading' && <p className="absent">Resolving steps against the current index…</p>}
      {resolved.status === 'error' && <p className="note error">{resolved.error}</p>}
      {missing > 0 && <p className="note warning">{missing} step{missing === 1 ? ' no longer exists' : 's no longer exist'} in the current index (renamed, moved or removed since the flow was saved). Playback skips missing steps.</p>}
      <div className="playback" role="group" aria-label="Playback">
        <button className="icon-button" onClick={() => store.playbackAction({ type: 'restart' })} aria-label="Restart" title="Restart">⏮</button>
        <button className="icon-button" onClick={() => store.playbackAction({ type: 'previous' })} aria-label="Previous step">◀</button>
        {state.status === 'playing'
          ? <button className="button primary" onClick={() => store.playbackAction({ type: 'pause' })} aria-label="Pause">❚❚ Pause</button>
          : <button className="button primary" onClick={() => store.playbackAction({ type: 'play' })} aria-label="Play" disabled={!state.playable.length}>▶ {state.status === 'finished' ? 'Replay' : 'Play'}</button>}
        <button className="icon-button" onClick={() => store.playbackAction({ type: 'next' })} aria-label="Next step">▶</button>
        <span className="absent" aria-live="polite">{state.status === 'idle' ? 'Ready' : state.status === 'finished' ? 'Finished' : `Step ${state.index + 1} of ${resolved.steps.length}`}</span>
      </div>
      <ol className="list" aria-label="Flow steps">
        {resolved.steps.map((step, index) => {
          const link = resolved.links[index];
          return (
            <Fragment key={`${step.entityId}-${index}`}>
              <li className={`flow-step${index === state.index ? ' current' : ''}${step.missing ? ' missing' : ''}`} aria-current={index === state.index ? 'step' : undefined}>
                <span className="num">{index + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <strong>{step.node?.name ?? 'Missing entity'}</strong><br />
                  <span className="absent">{step.node ? `${typeLabel(step.node.type, step.node.role)}${step.node.path ? ` · ${step.node.path}` : ''}` : `${step.entityId} was not found after reindexing`}</span>
                </span>
                {!step.missing && <button className="button small" onClick={() => store.playbackAction({ type: 'seek', index })}>Inspect</button>}
              </li>
              {index < resolved.steps.length - 1 && (
                <li className="flow-link" aria-label={link?.length ? `Connected by ${link.map(item => item.type).join(', ')}` : 'Declared order only'}>
                  {link?.length ? (
                    <>↓ <span className="graph">{link.map(item => item.type).join(', ')}</span> graph relationship
                      <button className="button link small" onClick={() => { const a = resolved.steps[index]!, b = resolved.steps[index + 1]!; void store.openEvidence(link[0]!.id, { from: a.node?.name ?? '', to: b.node?.name ?? '', type: link[0]!.type }); }}>why?</button></>
                  ) : <>↓ declared order only, no indexed relationship</>}
                  {index === state.index && next === index + 1 && state.status === 'playing' && <span aria-hidden>●</span>}
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}
