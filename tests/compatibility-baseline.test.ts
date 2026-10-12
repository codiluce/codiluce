import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { indexRepository } from '../src/pipeline/index.js';
import { canonicalJson, digest } from '../src/history/fingerprint.js';

test('compatibility infrastructure preserves existing Next.js/Laravel identities and relationship semantics', async () => {
  const graph = await indexRepository(fileURLToPath(new URL('./fixtures/repository/', import.meta.url)));
  // Wider original Laravel structure deliberately adds properties/promotions
  // and separately qualified PHP source references. Preserve the frozen prior
  // graph projection while asserting that the additions are actually present.
  const added = new Set(graph.entities.filter(entity=>entity.evidence.some(proof=>proof.analyzer==='php-laravel-structure')&&!entity.evidence.some(proof=>proof.analyzer==='php-laravel')).map(entity=>entity.id));
  const anonymous=graph.entities.filter(entity=>entity.metadata.anonymous===true);
  // Reviewed directly from these unchanged original fixture sources. Anonymous
  // migration classes remain a separate explicit type-owner gap.
  const expected=[['backend/app/Providers/FortifyServiceProvider.php',16,'arrow-function'],['backend/routes/console.php',6,'closure'],['backend/routes/settings.php',4,'closure'],['backend/routes/web.php',5,'closure'],['backend/routes/web.php',9,'arrow-function'],['backend/routes/api.php',5,'closure'],['backend/routes/api.php',12,'closure'],['backend/routes/api.php',15,'closure'],['backend/database/migrations/2026_01_02_create_profiles_and_audit.php',8,'closure'],['backend/database/migrations/2026_01_02_create_profiles_and_audit.php',14,'closure'],['backend/database/migrations/2026_01_02_create_profiles_and_audit.php',19,'closure'],['backend/database/migrations/2026_01_03_update_users.php',8,'closure'],['backend/database/migrations/2026_01_03_update_users.php',14,'arrow-function'],['backend/database/migrations/2026_01_03_update_users.php',17,'closure'],['backend/database/migrations/2026_01_01_create_users.php',6,'closure']];
  assert.deepEqual(anonymous.map(entity=>[entity.path,entity.sourceRange!.startLine,entity.metadata.declarationKind]).sort(),expected.sort());assert.ok(anonymous.every(entity=>entity.metadata.qualifiedName===undefined));assert.equal(added.size,5+expected.length);
  const entities = graph.entities.filter(entity=>!added.has(entity.id)).map(({ id, type, name, path, parentId, sourceRange, language }) => ({ id, type, name, path, parentId, sourceRange, language }));
  const relations = graph.relations.filter(relation=>!added.has(relation.from)&&!added.has(relation.to)&&!(relation.evidence.length&&relation.evidence.every(proof=>['php-symbols','php-imports'].includes(proof.analyzer)))).map(({ id, from, to, type, metadata }) => ({ id, from, to, type, metadata }));
  // Recorded before adding the new adapters. Provenance versions and Git
  // metrics intentionally do not participate in these structural baselines.
  assert.equal(entities.length, 218);
  assert.equal(relations.length, 368);
  assert.equal(digest(canonicalJson(entities)), 'b4840b897992cc74bdae471509dda1e77238cfa6');
  assert.equal(digest(canonicalJson(relations)), '01cd245f08218aba81f62b81a25da68fbede9717');
});
