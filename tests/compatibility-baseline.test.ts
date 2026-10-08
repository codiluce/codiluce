import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { indexRepository } from '../src/pipeline/index.js';
import { canonicalJson, digest } from '../src/history/fingerprint.js';

test('compatibility infrastructure preserves existing Next.js/Laravel identities and relationship semantics', async () => {
  const graph = await indexRepository(fileURLToPath(new URL('./fixtures/repository/', import.meta.url)));
  const entities = graph.entities.map(({ id, type, name, path, parentId, sourceRange, language }) => ({ id, type, name, path, parentId, sourceRange, language }));
  const relations = graph.relations.map(({ id, from, to, type, metadata }) => ({ id, from, to, type, metadata }));
  // Recorded before adding the new adapters. Provenance versions and Git
  // metrics intentionally do not participate in these structural baselines.
  assert.equal(entities.length, 218);
  assert.equal(relations.length, 368);
  assert.equal(digest(canonicalJson(entities)), 'b4840b897992cc74bdae471509dda1e77238cfa6');
  assert.equal(digest(canonicalJson(relations)), '01cd245f08218aba81f62b81a25da68fbede9717');
});
