import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialPlayback, nextPlayable, playback, type PlaybackState } from '../lib/playback';
import { highlightLines, splitHighlighted } from '../lib/highlight';

test('playback plays, pauses, advances with time, finishes, restarts and seeks', () => {
  let state: PlaybackState = initialPlayback([false, false, false]);
  assert.equal(state.status, 'idle');
  state = playback(state, { type: 'tick', elapsedMs: 5000, stepMs: 1000 });
  assert.equal(state.index, 0, 'idle playback ignores time');
  state = playback(state, { type: 'play' });
  state = playback(state, { type: 'tick', elapsedMs: 400, stepMs: 1000 });
  assert.deepEqual([state.index, state.progress], [0, 0.4]);
  assert.equal(nextPlayable(state), 1);
  state = playback(state, { type: 'pause' });
  assert.equal(playback(state, { type: 'tick', elapsedMs: 5000, stepMs: 1000 }), state, 'paused playback does not move');
  state = playback(playback(state, { type: 'play' }), { type: 'tick', elapsedMs: 1700, stepMs: 1000 });
  assert.equal(state.index, 2);
  state = playback(state, { type: 'tick', elapsedMs: 1000, stepMs: 1000 });
  assert.equal(state.status, 'finished');
  assert.equal(state.index, 2);
  state = playback(state, { type: 'play' });
  assert.deepEqual([state.status, state.index], ['playing', 0], 'play after finishing replays from the start');
  state = playback(state, { type: 'next' });
  state = playback(state, { type: 'previous' });
  assert.equal(state.index, 0);
  state = playback(state, { type: 'seek', index: 2 });
  assert.equal(state.index, 2);
  state = playback(state, { type: 'restart' });
  assert.deepEqual([state.status, state.index, state.progress], ['playing', 0, 0]);
  assert.equal(playback(initialPlayback([true, true]), { type: 'play' }).status, 'idle', 'nothing playable');
});
test('playback skips the stops marked as not playable', () => {
  let state = initialPlayback([false, true, false]);
  assert.deepEqual(state.playable, [0, 2]);
  state = playback(state, { type: 'play' });
  state = playback(state, { type: 'tick', elapsedMs: 1000, stepMs: 1000 });
  assert.equal(state.index, 2, 'stop 1 skipped');
});
test('syntax highlighting escapes HTML and keeps one balanced fragment per source line', () => {
  const lines = ['/* a comment that', '   spans lines <b>not html</b> */', 'const x = "<script>";'];
  const html = highlightLines(lines, 'typescript');
  assert.equal(html.length, 3);
  for (const line of html) {
    assert.equal((line.match(/<span/g) ?? []).length, (line.match(/<\/span>/g) ?? []).length, line);
    assert.ok(!line.includes('<b>') && !line.includes('<script>'));
  }
  assert.ok(html[1]!.includes('hljs-comment'), 'multi-line comment continues on the next line');
  assert.deepEqual(splitHighlighted('<span class="a">x\ny</span>'), ['<span class="a">x</span>', '<span class="a">y</span>']);
  assert.deepEqual(highlightLines(['<?php echo 1;'], 'unknown-language'), ['&lt;?php echo 1;']);
});
