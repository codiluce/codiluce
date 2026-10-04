import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { FlowStore, FLOWS_DATABASE } from '../src/storage/flows.js';
import { createInspectionServer } from '../src/api/server.js';
import { validateFlow } from '../src/core/flows.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const temporary: string[] = [];
let graph: SoftwareGraph, store: GraphStore, state: string;
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
before(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-flows-')); temporary.push(root);
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.archipelago'));
  await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  state = await mkdtemp(path.join(tmpdir(), 'atlas-flows-state-')); temporary.push(state);
});
after(async () => { store.close(); for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });

test('flows validate names, types and entity IDs; projection districts are not steps', () => {
  const steps = [{ entityId: 'symbol:0123456789abcdef01234567' }];
  assert.equal(validateFlow({ name: 'Login', type: 'declared', steps }, []), undefined);
  assert.equal(validateFlow({ name: ' ', type: 'declared', steps }, []), 'Give the flow a name');
  assert.equal(validateFlow({ name: 'login', type: 'declared', steps }, [{ id: 'a', name: 'Login' }]), 'A flow with this name already exists');
  assert.equal(validateFlow({ name: 'Login', type: 'observed', steps }, []), 'A flow is declared or static');
  assert.equal(validateFlow({ name: 'Login', type: 'declared', steps: [] }, []), 'A flow needs at least one step');
  assert.equal(validateFlow({ name: 'Login', type: 'declared', steps: [{ entityId: 'projection:routes:application:0123456789abcdef01234567' }] }, []), 'Every step must be an indexed entity ID');
  assert.equal(validateFlow({ name: 'Login', type: 'declared', steps: [{ entityId: '../../etc' }] }, []), 'Every step must be an indexed entity ID');
  assert.equal(validateFlow({ id: '../x', name: 'Login', type: 'declared', steps }, []), 'Invalid flow id');
});
test('the flow store keeps ordered IDs per repository, survives reopening, and refuses stale edits', async () => {
  const file = path.join(state, FLOWS_DATABASE);
  let flows = new FlowStore(file, () => '2026-10-02T10:00:00.000Z');
  const steps = [id('login', 'function'), id('POST /auth/login', 'api_endpoint'), id('AuthController')].map(entityId => ({ entityId, copied: { name: 'not stored' } }));
  const created = flows.create('repository:a', { name: '  Login chain ', type: 'declared', steps });
  assert.deepEqual([created.name, created.revision, created.createdAt], ['Login chain', 1, '2026-10-02T10:00:00.000Z']);
  assert.deepEqual(created.steps, steps.map(step => ({ entityId: step.entityId })), 'only IDs are stored');
  assert.deepEqual(flows.list('repository:b'), [], 'another repository sees nothing');
  assert.throws(() => flows.create('repository:a', { name: 'LOGIN CHAIN', type: 'declared', steps }), /already exists/);
  flows.close();
  flows = new FlowStore(file, () => '2026-10-02T11:00:00.000Z');
  const updated = flows.update('repository:a', created.id, { name: 'Login', type: 'static', steps: steps.slice(0, 2) }, 1);
  assert.deepEqual([updated.name, updated.type, updated.revision, updated.steps.length, updated.updatedAt, updated.createdAt], ['Login', 'static', 2, 2, '2026-10-02T11:00:00.000Z', '2026-10-02T10:00:00.000Z']);
  assert.throws(() => flows.update('repository:a', created.id, { name: 'Stale', type: 'declared', steps }, 1), (error: Error & { status?: number; flow?: { revision: number } }) => error.status === 409 && error.flow?.revision === 2);
  assert.throws(() => flows.update('repository:a', 'missing', { name: 'x', type: 'declared', steps }, 1), /Unknown flow/);
  assert.equal(flows.remove('repository:a', created.id), true);
  assert.equal(flows.remove('repository:a', created.id), false);
  assert.equal(flows.db.prepare('SELECT count(*) AS n FROM flow_steps').get()!.n, 0, 'steps go with their flow');
  flows.close();
  const readOnly = new FlowStore(file, undefined, true);
  assert.throws(() => readOnly.create('repository:a', { name: 'x', type: 'declared', steps }), /read-only/);
  readOnly.close();
});
test('importing browser flows keeps ids and dates, skips what is stored, and renames name clashes', () => {
  const flows = new FlowStore(':memory:');
  const entityId = id('LoginForm', 'component');
  flows.create('repository:a', { name: 'Login', type: 'declared', steps: [{ entityId }] });
  const result = flows.import('repository:a', [
    { id: 'browser-1', name: 'Login', type: 'declared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', steps: [{ entityId }, { entityId }] },
    { id: 'browser-1', name: 'Again', type: 'declared', steps: [{ entityId }] },
    { id: 'browser-2', name: 'Bad', type: 'observed', steps: [{ entityId }] },
  ]);
  assert.deepEqual(result.imported.map(flow => [flow.id, flow.name, flow.createdAt, flow.steps.length]), [['browser-1', 'Login (2)', '2026-01-01T00:00:00.000Z', 2]]);
  assert.deepEqual(result.skipped.map(item => item.reason), ['already stored', 'A flow is declared or static']);
  flows.close();
});
test('flow routes list, create, update, delete and import; writes need the visualizer header, a loopback host and no foreign origin', async () => {
  const flows = new FlowStore(':memory:');
  const server = createInspectionServer(store, { flows });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Archipelago-Request': 'flows' };
  const steps = [{ entityId: id('signIn') }, { entityId: id('POST /auth/login', 'api_endpoint') }];
  try {
    assert.deepEqual(await fetch(`${base}/api/flows`).then(response => response.json()), { storage: 'server', writable: true, flows: [] });
    const missingHeader = await fetch(`${base}/api/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', type: 'declared', steps }) });
    assert.equal(missingHeader.status, 403);
    const foreign = await fetch(`${base}/api/flows`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: JSON.stringify({ name: 'x', type: 'declared', steps }) });
    assert.equal(foreign.status, 403);
    // DNS rebinding: the browser sends the attacker's host name.
    const rebound = await new Promise<number>((resolve, reject) => { const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/flows', method: 'POST', headers: { ...headers, Host: `evil.example:${address.port}` } }, response => { response.resume(); resolve(response.statusCode!); }); request.on('error', reject); request.end(JSON.stringify({ name: 'x', type: 'declared', steps })); });
    assert.equal(rebound, 403);
    assert.equal((await fetch(`${base}/api/flows`, { method: 'POST', headers: { 'X-Archipelago-Request': 'flows' }, body: 'name=x' })).status, 415);
    const created = await fetch(`${base}/api/flows`, { method: 'POST', headers: { ...headers, Origin: base }, body: JSON.stringify({ name: 'Sign in', type: 'declared', steps }) });
    assert.equal(created.status, 201);
    const flow = await created.json();
    assert.equal((await fetch(`${base}/api/flows`, { method: 'POST', headers, body: JSON.stringify({ name: 'sign in', type: 'declared', steps }) })).status, 400);
    const updated = await fetch(`${base}/api/flows/${flow.id}`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Sign in (edited)', type: 'declared', steps: [...steps].reverse(), revision: 1 }) }).then(response => response.json());
    assert.equal(updated.revision, 2);
    const stale = await fetch(`${base}/api/flows/${flow.id}`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Lost', type: 'declared', steps, revision: 1 }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).flow.name, 'Sign in (edited)');
    const imported = await fetch(`${base}/api/flows/import`, { method: 'POST', headers, body: JSON.stringify({ flows: [{ id: 'local-1', name: 'From the browser', type: 'static', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', steps }] }) }).then(response => response.json());
    assert.equal(imported.imported.length, 1);
    assert.equal((await fetch(`${base}/api/flows`).then(response => response.json())).flows.length, 2);
    assert.equal((await fetch(`${base}/api/flows/${flow.id}`, { method: 'DELETE', headers: { 'X-Archipelago-Request': 'flows' } })).status, 204);
    assert.equal((await fetch(`${base}/api/flows/${flow.id}`, { method: 'DELETE', headers: { 'X-Archipelago-Request': 'flows' } })).status, 404);
    assert.equal((await fetch(`${base}/api/flows`, { method: 'PATCH', headers })).status, 405);
    assert.equal((await fetch(`${base}/api/summary`, { method: 'POST', headers })).status, 405, 'everything else stays read-only');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  // --read-only: listing works, writes are refused.
  const readOnly = createInspectionServer(store, { flows: new FlowStore(':memory:'), flowsWritable: false });
  await new Promise<void>(resolve => readOnly.listen(0, '127.0.0.1', resolve));
  const other = readOnly.address(); assert.ok(other && typeof other !== 'string');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${other.port}/api/flows`).then(response => response.json())).writable, false);
    assert.equal((await fetch(`http://127.0.0.1:${other.port}/api/flows`, { method: 'POST', headers, body: JSON.stringify({ name: 'x', type: 'declared', steps }) })).status, 403);
  } finally { await new Promise<void>(resolve => readOnly.close(() => resolve())); }
});
