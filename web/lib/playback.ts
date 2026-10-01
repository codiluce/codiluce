// Pure playback state machine for declared flows. Missing steps (entities that
// disappeared after reindexing) are skipped, never played.
export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'finished';
export interface PlaybackState {
  status: PlaybackStatus;
  /** Index into the flow's steps of the current step. */
  index: number;
  /** 0..1 progress of the indicator from `index` toward the next playable step. */
  progress: number;
  /** Indices of steps that can be played, ascending. */
  playable: number[];
}
export type PlaybackAction =
  | { type: 'load'; missing: boolean[] }
  | { type: 'play' } | { type: 'pause' } | { type: 'restart' }
  | { type: 'next' } | { type: 'previous' } | { type: 'seek'; index: number }
  | { type: 'tick'; elapsedMs: number; stepMs: number };

export function initialPlayback(missing: boolean[] = []): PlaybackState {
  const playable = missing.flatMap((isMissing, index) => isMissing ? [] : [index]);
  return { status: 'idle', index: playable[0] ?? 0, progress: 0, playable };
}
function after(state: PlaybackState, index: number): number | undefined { return state.playable.find(candidate => candidate > index); }
function before(state: PlaybackState, index: number): number | undefined { return [...state.playable].reverse().find(candidate => candidate < index); }
export function playback(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'load': return initialPlayback(action.missing);
    case 'play':
      if (!state.playable.length) return state;
      if (state.status === 'finished') return { ...state, status: 'playing', index: state.playable[0]!, progress: 0 };
      return { ...state, status: 'playing' };
    case 'pause': return state.status === 'playing' ? { ...state, status: 'paused' } : state;
    case 'restart': return { ...state, status: state.playable.length ? 'playing' : 'idle', index: state.playable[0] ?? 0, progress: 0 };
    case 'next': {
      const next = after(state, state.index);
      return next === undefined ? { ...state, progress: 0, status: state.status === 'playing' ? 'finished' : state.status } : { ...state, index: next, progress: 0 };
    }
    case 'previous': {
      const previous = before(state, state.index);
      return previous === undefined ? { ...state, progress: 0 } : { ...state, index: previous, progress: 0, status: state.status === 'finished' ? 'paused' : state.status };
    }
    case 'seek': return state.playable.includes(action.index) ? { ...state, index: action.index, progress: 0, status: state.status === 'finished' ? 'paused' : state.status } : state;
    case 'tick': {
      if (state.status !== 'playing' || action.stepMs <= 0) return state;
      let { index, progress } = state;
      progress += action.elapsedMs / action.stepMs;
      while (progress >= 1) {
        const next = after(state, index);
        if (next === undefined) return { ...state, index, progress: 0, status: 'finished' };
        index = next; progress -= 1;
      }
      // The last playable step has nowhere to travel; it simply dwells then finishes.
      return { ...state, index, progress };
    }
  }
}
/** Next playable step after the current one, for drawing the travelling indicator. */
export function nextPlayable(state: PlaybackState): number | undefined { return after(state, state.index); }
