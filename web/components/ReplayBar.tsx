'use client';
import type { CSSProperties } from 'react';
import { agentColor } from '../lib/activity';
import { useAtlas, useStore } from './context';

/** Replay speeds: at 1×, a visit to a file lasts about a second. */
const SPEEDS = [0.5, 1, 2, 4, 8];
/** Media glyphs drawn, not typed: fonts show ⏮ and ⏭ as emoji. */
const ICONS = {
  previous: <><rect x="3" y="3" width="2" height="10" /><path d="M13 3v10L6 8z" /></>,
  next: <><rect x="11" y="3" width="2" height="10" /><path d="M3 3v10l7-5z" /></>,
  play: <path d="M4 2.5v11L13 8z" />,
  pause: <><rect x="3.5" y="3" width="3" height="10" rx="0.5" /><rect x="9.5" y="3" width="3" height="10" rx="0.5" /></>,
};
function Icon({ name }: { name: keyof typeof ICONS }) { return <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">{ICONS[name]}</svg>; }

/** A saved session replaying on the map: play, pause, a step back or forward, the speed, and what the agent does in the step. */
export function ReplayBar() {
  const store = useStore();
  const replay = useAtlas(state => state.agents.replay);
  if (!replay) return null;
  const { step, total, playing, done } = replay;
  const last = Math.max(0, total - 1);
  return (
    <div className="replay-bar" role="toolbar" aria-label="Session replay">
      <div className="replay-row">
        <span className="replay-title" title={replay.data.title}><i className="agent-swatch" style={{ '--swatch': agentColor(replay.id) } as CSSProperties} aria-hidden="true" />{replay.data.title || 'Agent session'}</span>
        <div className="replay-buttons">
          <button className="icon-button small" onClick={() => store.seekReplay(step - 1)} disabled={!total || step <= 0} aria-label="Previous step" title="Previous step"><Icon name="previous" /></button>
          <button className="icon-button small replay-play" onClick={() => store.playReplay(!playing)} disabled={!total} aria-label={playing ? 'Pause' : done ? 'Play again' : 'Play'} title={playing ? 'Pause' : done ? 'Play again from the start' : 'Play'}><Icon name={playing ? 'pause' : 'play'} /></button>
          <button className="icon-button small" onClick={() => store.seekReplay(step + 1)} disabled={!total || step >= last} aria-label="Next step" title="Next step"><Icon name="next" /></button>
        </div>
        <select className="replay-speed" value={replay.speed} onChange={event => store.setReplaySpeed(Number(event.target.value))} aria-label="Replay speed" title="Replay speed: at 1×, each file visit lasts about a second">
          {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
        </select>
        <button className="icon-button tiny replay-close" onClick={() => store.stopReplay()} aria-label="Close the replay" title="Close the replay (the live agents come back)">✕</button>
      </div>
      <div className="replay-row">
        <span className="replay-count" aria-label={`Step ${step + 1} of ${total}`}>{total ? `${step + 1} / ${total}` : '…'}</span>
        <span className={`replay-text${replay.failed ? ' failed' : ''}`} title={replay.text}>{done ? 'Replay over' : replay.text}{!done && replay.failed ? ' · failed' : ''}</span>
      </div>
      <input type="range" className="replay-scrub" min={0} max={last} value={Math.min(step, last)} disabled={!total} onChange={event => store.seekReplay(Number(event.target.value))} aria-label="Replay step" />
    </div>
  );
}
