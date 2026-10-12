import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileIndexedPath, IndexedPathCandidates, matchIndexedPath, requestPathSegments } from '../src/analysis/routes/pattern.js';
import { compileExpressPath, matchRoutePattern } from '../src/analysis/routes/contracts.js';

test('compiled Next/Laravel paths retain optional parameters and catch-all cardinality', () => {
  const matches = (route: string, request: string) => matchIndexedPath(compileIndexedPath(route), requestPathSegments(request));
  assert.equal(matches('/users/{id}', '/users/12'), true);
  assert.equal(matches('/users/{id}', '/users'), false);
  assert.equal(matches('/users/{id?}', '/users'), true);
  assert.equal(matches('/users/{id?}', '/users/12'), true);
  assert.equal(matches('/users/{id?}', '/users/12/edit'), false);
  assert.equal(matches('/docs/:path+', '/docs'), false);
  assert.equal(matches('/docs/:path+', '/docs/one/two'), true);
  assert.equal(matches('/docs/:path*', '/docs'), true);
  assert.equal(matches('/docs/:path*', '/docs/one/two'), true);
  assert.equal(matches('/users/:id', '/users/12'), true);
  assert.equal(matches('/users/:id', '/users/12/edit'), false);
});

test('a dynamic request segment cannot select a literal route and loose matching retains the competitor', () => {
  const request = requestPathSegments('/users/{*}');
  const parameter = compileIndexedPath('/users/{id}'), literal = compileIndexedPath('/users/new');
  assert.equal(matchIndexedPath(parameter, request), true);
  assert.equal(matchIndexedPath(literal, request), false);
  assert.equal(matchIndexedPath(literal, request, false), true);
  assert.equal(matchIndexedPath(parameter, request, false), true);
});

test('compilation preserves original dialect/spelling and treats unsupported route syntax as literal', () => {
  const route = compileIndexedPath('/users/(create|new)/{id?}');
  assert.equal(route.original, '/users/(create|new)/{id?}');
  assert.equal(route.dialect, 'next-laravel');
  assert.deepEqual(route.segments, [{ kind: 'literal', value: 'users' }, { kind: 'literal', value: '(create|new)' }, { kind: 'parameter', name: 'id', optional: true }]);
  assert.equal(matchIndexedPath(route, requestPathSegments('/users/create')), false);
});

test('literal-prefix selection preserves exhaustive matches, ambiguity and registration order', () => {
  const routes = ['/{any}', '/api/resource/{id}', '/api/resource/new', '/api/{kind}/{id?}', '/other/:rest*', '/', '/api/resource/{id}/edit', '/encoded/%2F', '/unicode/ñ', '/constructor/__proto__', '//api//resource//new//', '/api/resource/:tail+'];
  const entries = routes.map((value, id) => ({ value: { id, route: value }, pattern: compileIndexedPath(value) }));
  const index = new IndexedPathCandidates(entries);
  const requests = ['/', '/api/resource/12', '/api/resource/new', '/api/resource/new/', '//api//resource//new//', '/api/resource/12/edit', '/api/other', '/other', '/other/a/b', '/unknown', '/encoded/%2F', '/encoded//', '/unicode/ñ', '/unicode/%C3%B1', '/constructor/__proto__', '/api/resource/{*}', '/api/{*}/new'];
  for (const path of requests) for (const strict of [true, false]) {
    const matching = (value: typeof entries[number]['value']) => matchIndexedPath(entries[value.id]!.pattern, requestPathSegments(path), strict);
    assert.deepEqual(index.candidates(path).filter(matching), entries.map(entry => entry.value).filter(matching), `${path}, strict=${strict}`);
  }
  const sparse = new IndexedPathCandidates(Array.from({ length: 1500 }, (_, id) => ({ value: id, pattern: compileIndexedPath(`/api/resource${id}/{key}`) })));
  assert.deepEqual(sparse.candidates('/api/resource749/1'), [749]);
});

test('framework dialects remain eligible alongside indexed paths and retain conflicting matches', () => {
  const framework = compileExpressPath('/API/{resource/}:id', 5);
  const entries = [
    { value: 'before', pattern: compileIndexedPath('/api/resource/new') },
    { value: 'framework' },
    { value: 'parameter', pattern: compileIndexedPath('/api/resource/{id}') },
    { value: 'after', pattern: compileIndexedPath('/unrelated') },
  ];
  const index = new IndexedPathCandidates(entries);
  for (const path of ['/api/resource/new', '/API/resource/12', '/api/12', '/api/resource/{*}', '/unrelated', '/']) {
    const matches = (value: string) => value === 'framework' ? matchRoutePattern(framework, path) : matchIndexedPath(entries.find(entry => entry.value === value)!.pattern!, requestPathSegments(path));
    assert.deepEqual(index.candidates(path).filter(matches), entries.map(entry => entry.value).filter(matches));
    assert.ok(index.candidates(path).includes('framework'));
  }
});
