import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileIndexedPath, matchIndexedPath, requestPathSegments } from '../src/analysis/routes/pattern.js';

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
