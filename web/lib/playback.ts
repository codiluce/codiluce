// Pure playback state machine: a current item (a branch of a flow on the
// map), how far it has played (0..1), play/pause/step/seek. Items marked as
// skipped are never played.
export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'finished';
export interface PlaybackState {
  status: PlaybackStatus;
  /** Index of the current item. */
  index: number;
  /** 0..1: how far the current item has played. */
  progress: number;
  /** Indices of items that can be played, ascending. */
  playable: number[];
}
export type PlaybackAction =
  | { type: 'load'; skipped: boolean[] }
  | { type: 'play' } | { type: 'pause' } | { type: 'restart' }
  | { type: 'next' } | { type: 'previous' } | { type: 'seek'; index: number }
  | { type: 'tick'; elapsedMs: number; stepMs: number };

export function initialPlayback(skipped: boolean[] = []): PlaybackState {
  const playable = skipped.flatMap((skip, index) => skip ? [] : [index]);
  return { status: 'idle', index: playable[0] ?? 0, progress: 0, playable };
}
function after(state: PlaybackState, index: number): number | undefined { return state.playable.find(candidate => candidate > index); }
function before(state: PlaybackState, index: number): number | undefined { return [...state.playable].reverse().find(candidate => candidate < index); }
export function playback(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'load': return initialPlayback(action.skipped);
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
      return { ...state, index, progress };
    }
  }
}
/** The next playable item after the current one. */
export function nextPlayable(state: PlaybackState): number | undefined { return after(state, state.index); }
