'use client';
import { useMemo, useState } from 'react';
import type { StepGuard, StepsResult } from '@engine/projection/dto';
import { pageStepBranch, pageStepGroups, type PageStepChoice, type PageStepGroup } from '../lib/page-steps';
import { StepsDiagram, StepsNotes, StepsOutline } from './StepsPanel';

function primaryConditions(guards: StepGuard[]): string {
  const positive = guards.filter(guard => !guard.negated);
  return (positive.length ? positive : guards).map(guard => guard.phrase).join(' · ');
}

export function PageSteps({ data, layout }: { data: StepsResult; layout: 'diagram' | 'outline' }) {
  const groups = useMemo(() => pageStepGroups(data), [data]);
  const [selectedId, setSelectedId] = useState<string>();
  const [effects, setEffects] = useState(false);
  const [query, setQuery] = useState('');
  const allGroups = [...groups.initialization, ...groups.interactions];
  const selectedGroup = allGroups.find(group => group.choices.some(choice => choice.id === selectedId));
  const choice = selectedGroup?.choices.find(item => item.id === selectedId);
  const fullBranch = useMemo(() => choice ? pageStepBranch(data, choice, true) : undefined, [data, choice]);
  const branch = useMemo(() => choice ? pageStepBranch(data, choice, effects) : undefined, [data, choice, effects]);
  const effectCount = fullBranch?.steps.filter(step => step.effect && step.id !== choice?.head).length ?? 0;
  const select = (item: PageStepChoice) => { setSelectedId(item.id); setEffects(false); };
  const filter = (items: PageStepGroup[]) => {
    const needle = query.trim().toLowerCase();
    return items.flatMap(group => {
      const choices = group.label.toLowerCase().includes(needle) ? group.choices : group.choices.filter(item => `${item.label} ${item.link.event ?? ''}`.toLowerCase().includes(needle));
      return choices.length ? [{ ...group, choices }] : [];
    });
  };
  const initialization = filter(groups.initialization), interactions = filter(groups.interactions);
  const renderGroups = (items: PageStepGroup[]) => (
    <div className="page-step-groups">
      {items.map(group => (
        <details key={group.id} className="page-step-group">
          <summary><span className="mono">{group.label}</span><span className="count">{group.choices.length}</span></summary>
          <div className="page-step-choices">
            {group.choices.map(item => (
              <button key={item.id} className="page-step-choice" onClick={() => select(item)}>
                <span className="mono">{item.label}</span>
                {item.link.event && <span className="page-step-event">{item.link.event}</span>}
                {item.link.when.length > 0 && <span className="step-when" title={item.link.when.map(guard => guard.phrase).join(' · ')}>{primaryConditions(item.link.when)}</span>}
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
  if (choice && branch) return (
    <div className="page-steps page-step-detail">
      <div className="page-step-toolbar">
        <button className="button small" onClick={() => setSelectedId(undefined)}>← Page overview</button>
        <span className="page-step-context"><strong className="mono">{selectedGroup!.label}</strong><span>{choice.link.event ?? 'Initialization'} · {choice.label}</span></span>
        {effectCount > 0 && <button className="button small" aria-pressed={effects} onClick={() => setEffects(value => !value)}>{effects ? 'Hide' : 'Show'} effects · {effectCount}</button>}
      </div>
      {choice.link.via.length > 0 && <p className="page-step-path mono">{data.anchor.name} → {choice.link.via.map(item => item.name).join(' → ')} → {choice.label}</p>}
      {choice.link.when.length > 0 && <div className="page-step-conditions step-when">
        <p>{primaryConditions(choice.link.when)}</p>
        {choice.link.when.some(guard => guard.negated) && choice.link.when.some(guard => !guard.negated) && <details><summary>All conditions · {choice.link.when.length}</summary><p>{choice.link.when.map(guard => guard.phrase).join(' · ')}</p></details>}
      </div>}
      {layout === 'diagram' ? <StepsDiagram data={branch} /> : <div className="page-step-outline"><StepsOutline data={branch} /></div>}
    </div>
  );
  return (
    <div className="page-steps page-step-overview">
      <p className="page-step-intro">Open a component, then choose one branch to follow. Controls on conditional cards are alternatives.</p>
      <input type="search" className="input page-step-filter" aria-label="Filter page branches" placeholder="Find a component or handler…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="page-step-sections">
        <section aria-label="Page initialization" className="page-step-section initialization">
          <h3>Page initialization <span className="count">{groups.initialization.reduce((sum, group) => sum + group.choices.length, 0)}</span></h3>
          <p>Work reachable when the page opens, before an event fires.</p>
          {initialization.length ? renderGroups(initialization) : <p className="absent">{groups.initialization.length ? 'No initialization branches match.' : 'No initialization actions or effects were resolved.'}</p>}
        </section>
        <section aria-label="User interactions" className="page-step-section interactions">
          <h3>User interactions <span className="count">{groups.interactions.reduce((sum, group) => sum + group.choices.length, 0)}</span></h3>
          <p>Event handlers, grouped by the component that binds them.</p>
          {interactions.length ? renderGroups(interactions) : <p className="absent">{groups.interactions.length ? 'No interactions match.' : 'No event handlers were resolved.'}</p>}
        </section>
      </div>
      <details className="page-step-notes"><summary>About this flow</summary><StepsNotes data={data} /></details>
    </div>
  );
}
