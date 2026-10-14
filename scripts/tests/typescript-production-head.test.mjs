import assert from 'node:assert/strict';
import test from 'node:test';
import {compareCompilerHeadGraphs} from '../qualify-typescript-production-head.mjs';

const graph = () => ({schemaVersion: 1, run: {schemaVersion: 1, id: 'original', analyzedAt: 'original-time', commitSha: 'a'.repeat(40), configDigest: 'b'.repeat(64), analyzerVersions: {'typescript-nextjs': '1', 'rust-symbols': '2'}}, entities: [{id: 'file', type: 'file', path: 'é😀.ts', metadata: {contentHash: 'c'.repeat(64), nested: {values: [null, true, 42, 'é😀']}}, sourceRange: {startLine: 1, startColumn: 1, endLine: 2, endColumn: 8}, evidence: [{source: 'ast', analyzer: 'typescript-nextjs', analyzerVersion: '1', confidence: 1}]}], relations: [{id: 'relation', from: 'file', to: 'file', type: 'references', metadata: {original: true}}], diagnostics: [{id: 'diagnostic', code: 'original', reason: 'Retain the complete observation'}]});

test('compiler head comparison permits only the actual run UUID and analysis time to vary', () => {
  const original = graph(), candidate = graph(); candidate.run.id = 'fresh'; candidate.run.analyzedAt = 'fresh-time';
  const result = compareCompilerHeadGraphs(candidate, original);
  assert.deepEqual(result.counts, {entities: 1, relations: 1, diagnostics: 1});
  assert.deepEqual(result.volatileFields, ['run.id', 'run.analyzedAt']);
  assert.equal(result.producerNormalization, false);
  assert.equal(candidate.run.id, 'fresh'); assert.equal(original.run.id, 'original');
});

test('compiler head comparison rejects producer versions in both run and evidence', () => {
  for (const change of [value => value.run.analyzerVersions['typescript-nextjs'] = '2', value => value.run.analyzerVersions['rust-symbols'] = '1', value => value.entities[0].evidence[0].analyzerVersion = '2']) {
    const candidate = graph(); change(candidate);
    assert.throws(() => compareCompilerHeadGraphs(candidate, graph()), /differs beyond run UUID\/time/);
  }
});

test('compiler head comparison retains original ranges, nested metadata, edges, diagnostics and configuration', () => {
  for (const change of [value => value.entities[0].sourceRange.endColumn++, value => value.entities[0].metadata.nested.values[3] = 'é', value => value.relations[0].metadata.original = false, value => value.diagnostics[0].reason = 'Changed', value => value.run.configDigest = 'd'.repeat(64), value => value.run.commitSha = 'e'.repeat(40)]) {
    const candidate = graph(); change(candidate);
    assert.throws(() => compareCompilerHeadGraphs(candidate, graph()), /differs beyond run UUID\/time/);
  }
});

test('incomplete, duplicated or unsorted compiler head record inventories cannot qualify', () => {
  const omitted = graph(); omitted.relations = [];
  assert.throws(() => compareCompilerHeadGraphs(omitted, graph()), /differs beyond run UUID\/time/);
  for (const entities of [[graph().entities[0], graph().entities[0]], [{...graph().entities[0], id: 'z'}, graph().entities[0]]]) {
    const candidate = graph(); candidate.entities = entities;
    assert.throws(() => compareCompilerHeadGraphs(candidate, graph()), /unique sorted IDs/);
  }
});

test('missing actual volatile run fields cannot be synthesized into qualification', () => {
  for (const key of ['id', 'analyzedAt']) {
    const candidate = graph(); delete candidate.run[key];
    assert.throws(() => compareCompilerHeadGraphs(candidate, graph()));
  }
});
