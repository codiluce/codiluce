import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeSummary, Step, StepLink, StepsResult } from '../../src/projection/dto.js';
import { pageStepBranch, pageStepGroups } from '../lib/page-steps';
import { fromSteps } from '../lib/map-flow';

function fixture(): StepsResult {
  const node = (id: string, type = 'function'): NodeSummary => ({ id, name: id, type, kind: 'entity', path: `${id}.tsx`, depth: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, childCount: 0, diagnostics: 0, stats: { files: 0, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 } });
  const step = (id: string, kind: Step['kind'], layer: number, type?: string): Step => ({ id, kind, layer, node: node(id, type), ancestors: [] });
  const effect = (id: string, owner: string, layer: number): Step => ({ id, kind: 'effect', layer, ancestors: [], effect: { owner, ownerName: owner, category: 'storage', operation: 'write', detail: id, line: 1, via: 'DOM', when: [] } });
  const link = (from: string, to: string, component?: string, event?: string): StepLink => ({ id: `${from}>${to}`, from, to, via: component ? [{ id: component, name: component, type: 'component', ancestors: [] }] : [], hops: [], when: [], back: false, ...(event ? { event } : {}) });
  const anchor = node('/', 'route');
  return { anchor, notices: [], steps: [
    { ...step('/', 'anchor', 0), node: anchor }, step('Player', 'action', 1, 'component'), step('play', 'trigger', 2), step('seek', 'trigger', 2), step('solve', 'trigger', 1), step('track', 'action', 3),
    effect('initEffect', 'Player', 2), effect('playEffect', 'track', 4), effect('seekEffect', 'seek', 3), effect('solveEffect', 'solve', 2),
  ], links: [link('/', 'Player'), link('Player', 'play', undefined, 'onClick'), link('Player', 'seek', undefined, 'onChange'), link('/', 'solve', 'ExerciseCard', 'onClick'), link('Player', 'initEffect'), link('play', 'track'), link('track', 'playEffect'), link('seek', 'seekEffect'), link('solve', 'solveEffect'), link('track', 'Player')] };
}

test('page choices retain component context and separate initialization from event bindings', () => {
  const groups = pageStepGroups(fixture());
  assert.deepEqual(groups.initialization.map(group => [group.label, group.choices.map(choice => choice.label)]), [['Player', ['Player']]]);
  assert.deepEqual(groups.interactions.map(group => [group.label, group.choices.map(choice => choice.label)]), [['Player', ['play', 'seek']], ['ExerciseCard', ['solve']]]);
});

test('following one page choice preserves its real prefix without firing sibling controls', () => {
  const data = fixture(), groups = pageStepGroups(data);
  const initialization = pageStepBranch(data, groups.initialization[0]!.choices[0]!, true);
  assert.deepEqual(initialization.steps.map(step => step.id), ['/', 'Player', 'initEffect']);
  const play = groups.interactions[0]!.choices[0]!;
  const hidden = pageStepBranch(data, play, false), expanded = pageStepBranch(data, play, true);
  assert.deepEqual(hidden.steps.map(step => step.id), ['/', 'Player', 'play', 'track']);
  assert.deepEqual(expanded.steps.filter(step => step.effect).map(step => step.id), ['playEffect']);
  assert.ok(expanded.links.some(link => link.from === '/' && link.to === 'Player'));
  assert.ok(expanded.links.find(link => link.from === 'track' && link.to === 'Player')!.back, 'cycles do not pull in other controls');
  const ids = new Set(hidden.steps.map(step => step.id));
  assert.ok(hidden.links.every(link => ids.has(link.from) && ids.has(link.to)), 'hidden effects leave no dangling edges');
});

test('page map playback follows the same choices and includes only each branch\'s effects', () => {
  const map = fromSteps(fixture());
  const initialization = map.branches[0]!, play = map.branches.find(branch => branch.label === 'play')!;
  assert.equal(initialization.group, 'Initialization · Player');
  assert.deepEqual(initialization.waves.flat().map(i => map.stops[i]!.label), ['/', 'Player']);
  assert.deepEqual(initialization.pinKeys, ['initEffect']);
  assert.deepEqual(play.waves.flat().map(i => map.stops[i]!.label), ['/', 'Player', 'play', 'track']);
  assert.deepEqual(play.pinKeys, ['playEffect']);
  assert.equal(play.group, 'Player');
});
