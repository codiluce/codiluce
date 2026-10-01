'use client';
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AtlasState, AtlasStore } from '../lib/store';

export const AtlasContext = createContext<AtlasStore | null>(null);
export function useStore(): AtlasStore {
  const store = useContext(AtlasContext);
  if (!store) throw new Error('AtlasContext is missing');
  return store;
}
/** Subscribe to a slice of state. Selectors must return stable references (state slices or primitives). */
export function useAtlas<T>(selector: (state: AtlasState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
