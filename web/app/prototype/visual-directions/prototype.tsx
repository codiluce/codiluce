'use client';
// PROTOTYPE (throwaway) — the switcher: which prototype (?proto=) and which variant (?variant=).
import { useCallback, useEffect, useState } from 'react';
import { FocusPrototype } from './focus';
import { AgentsPrototype } from './agents';
import { BeatPrototype } from './beat';

const PROTOS = {
  focus: { name: 'Focus layout', variants: { A: 'Gather (iso)', B: 'Plan', C: 'Lift', D: 'Map plan (no re-sorting)' } },
  agents: { name: 'Agent characters', variants: { A: 'Buddies (hop)', B: 'Pixel crew (walk the streets)', C: 'Pins (breadcrumbs)', D: 'Pixel crew (hop roof to roof)' } },
  beat: { name: 'Commit beat', variants: { A: 'In place', B: 'Stage (iso)', C: 'Stage (plan) + ledger' } },
} as const;
type ProtoId = keyof typeof PROTOS;

function readParams(): { proto: ProtoId; variant: string } {
  const params = new URLSearchParams(window.location.search);
  const proto = (params.get('proto') ?? 'focus') as ProtoId;
  return { proto: proto in PROTOS ? proto : 'focus', variant: params.get('variant') ?? 'A' };
}

export function Prototype() {
  const [state, setState] = useState<{ proto: ProtoId; variant: string }>();
  useEffect(() => { setState(readParams()); }, []);
  const go = useCallback((proto: ProtoId, variant: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('proto', proto); params.set('variant', variant);
    window.history.replaceState(null, '', `?${params}`);
    setState({ proto, variant });
  }, []);
  const cycle = useCallback((step: number) => {
    if (!state) return;
    const keys = Object.keys(PROTOS[state.proto].variants);
    go(state.proto, keys[(keys.indexOf(state.variant) + step + keys.length) % keys.length]!);
  }, [state, go]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [cycle]);
  if (!state) return null;
  const proto = PROTOS[state.proto];
  const label = (proto.variants as Record<string, string>)[state.variant] ?? '?';
  return (
    <div className="proto-root">
      {state.proto === 'focus' ? <FocusPrototype key={`focus-${state.variant}`} variant={state.variant} /> : state.proto === 'agents' ? <AgentsPrototype key={`agents-${state.variant}`} variant={state.variant} /> : <BeatPrototype key={`beat-${state.variant}`} variant={state.variant} />}
      {process.env.NODE_ENV !== 'production' ? (
        <nav className="proto-switcher" aria-label="Prototype switcher">
          <select value={state.proto} onChange={event => go(event.target.value as ProtoId, 'A')} aria-label="Prototype">
            {(Object.keys(PROTOS) as ProtoId[]).map(id => <option key={id} value={id}>{PROTOS[id].name}</option>)}
          </select>
          <button onClick={() => cycle(-1)} aria-label="Previous variant">←</button>
          <span>{state.variant} ({label})</span>
          <button onClick={() => cycle(1)} aria-label="Next variant">→</button>
        </nav>
      ) : null}
    </div>
  );
}
