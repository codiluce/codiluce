import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type RawConfig } from '../src/core/config.js';
import type { Entity, SoftwareGraph } from '../src/core/graph.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { compileRailsPath } from '../src/analysis/routes/rails-patterns.js';
import { matchRoutePattern } from '../src/analysis/routes/contracts.js';
import { RailsInflections } from '../src/analysis/frameworks/rails-inflections.js';

const roots: string[] = []; after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const base = { Gemfile: 'gem "rails", "~>8.1.0"', 'config/application.rb': 'module Shop; class Application < Rails::Application; end; end', 'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base; end' };
const controller = (name: string, actions: string[], body = '') => `class ${name} < ApplicationController\n${body}\n${actions.map(action => `def ${action}; end`).join('\n')}\nend`;
async function repository(routes: string, files: Record<string, string> = {}) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rails-')); roots.push(root); for (const [file, source] of Object.entries({ ...base, 'config/routes.rb': `Rails.application.routes.draw do\n${routes}\nend`, ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), source); } return root; }
async function index(root: string, options: { config?: RawConfig; cache?: AnalysisCache; revision?: string } = {}) { return indexRepository(root, { config: await resolveConfig(root, options.config ?? { repository: { name: 'rails-fixture' }, applications: [{ name: 'server', path: '.', ecosystems: ['ruby'], apiOrigins: ['https://rails.test'] }] }), cache: options.cache, revision: options.revision }); }
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'rails').sort((a, b) => Number(a.metadata.routeOrder) - Number(b.metadata.routeOrder));
const handler = (graph: SoftwareGraph, endpoint: Entity) => graph.entities.find(entity => entity.id === graph.relations.find(relation => relation.type === 'handles' && relation.from === endpoint.id)?.to);
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['indexer', 'git-metrics'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Rails frozen English rules preserve irregular/uncountable and ordinary resource morphology', () => {
 const inflector = new RailsInflections(); for (const [single, plural] of [['person', 'people'], ['child', 'children'], ['mouse', 'mice'], ['analysis', 'analyses'], ['category', 'categories'], ['status', 'statuses'], ['fish', 'fish'], ['photo', 'photos']]) { assert.equal(inflector.pluralize(single!), plural); assert.equal(inflector.singularize(plural!), single); }
});

test('Rails Journey paths retain optional formats/groups, default dot limits, globs and normalization', () => {
 const path = compileRailsPath('/users/:id'); for (const request of ['/users/12', '/users/12.json', '/users//12/', '/users/a%2Eb']) assert.ok(matchRoutePattern(path, request), request); for (const request of ['/users/12.json.extra', '/Users/12', '/users/', '/users/12/other']) assert.equal(matchRoutePattern(path, request), false, request);
 assert.equal(matchRoutePattern(compileRailsPath('/users/:id', false), '/users/12.json'), false); assert.equal(matchRoutePattern(compileRailsPath('/users/:id', true), '/users/12'), false); assert.ok(matchRoutePattern(compileRailsPath('/users/:id', true), '/users/12.json'));
 const optional = compileRailsPath('(/:locale)/photos'); assert.ok(matchRoutePattern(optional, '/photos')); assert.ok(matchRoutePattern(optional, '/en/photos.json')); const glob = compileRailsPath('/files/*path'); assert.ok(matchRoutePattern(glob, '/files/a/b.json')); assert.equal(matchRoutePattern(glob, '/files/'), false);
 assert.ok(matchRoutePattern(compileRailsPath('/users/:id', false, { id: 'digits' }), '/users/12')); assert.equal(matchRoutePattern(compileRailsPath('/users/:id', false, { id: 'digits' }), '/users/abc'), false);
});

test('Rails plural and singleton resources link every original controller action', async () => {
 const root = await repository('resources :photos\nresource :profile', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['index', 'create', 'new', 'show', 'edit', 'update', 'destroy']), 'app/controllers/profiles_controller.rb': controller('ProfilesController', ['create', 'new', 'show', 'edit', 'update', 'destroy']) }); const graph = await index(root), routes = endpoints(graph);
 assert.equal(routes.length, 13); assert.ok(routes.every(route => handler(graph, route)?.type === 'method')); assert.ok(routes.every(route => !route.metadata.constraintsUnresolved)); assert.equal(routes.find(route => route.metadata.action === 'update')?.metadata.method, 'PATCH|PUT'); assert.ok(!routes.some(route => route.metadata.routePath === '/profile/:id'));
});

test('Rails nested and shallow resources preserve controller namespaces, paths and custom parameter names', async () => {
 const root = await repository('namespace :admin do\n resources :people, param: :slug, only: :show, shallow: true do\n resources :comments, only: [:index, :show]\n end\nend', { 'app/controllers/admin/people_controller.rb': controller('Admin::PeopleController', ['show']), 'app/controllers/admin/comments_controller.rb': controller('Admin::CommentsController', ['index', 'show']) }); const graph = await index(root), routes = endpoints(graph); assert.deepEqual(routes.map(route => route.metadata.routePath), ['/admin/people/:person_slug/comments', '/admin/comments/:id', '/admin/people/:slug']); assert.ok(routes.every(route => handler(graph, route)));
});

test('Rails member, collection, new and on declarations expand before default mappings', async () => {
 const root = await repository('resources :photos, only: :show do\n member { get :preview }\n collection { get :search }\n new { get :wizard }\n get :audit, on: :member\n get :inspect\nend', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show', 'preview', 'search', 'wizard', 'audit', 'inspect']) }); const graph = await index(root); assert.deepEqual(endpoints(graph).map(route => route.metadata.routePath), ['/photos/:id/preview', '/photos/search', '/photos/new/wizard', '/photos/:id/audit', '/photos/:photo_id/inspect', '/photos/:id']); assert.ok(endpoints(graph).every(route => handler(graph, route)));
});

test('Rails scopes and literal verbs preserve absolute controllers, defaults, format and only/except restrictions', async () => {
 const root = await repository('scope path: "v1", module: :api do\n resources :photos, only: [:show, :destroy], except: [:show]\n get "status", to: "/status#show", format: false\nend\nroot to: "status#show"\nmatch "combined", to: "status#show", via: [:get, :post]', { 'app/controllers/api/photos_controller.rb': controller('Api::PhotosController', ['show', 'destroy']), 'app/controllers/status_controller.rb': controller('StatusController', ['show']) }); const graph = await index(root); assert.deepEqual(endpoints(graph).map(route => route.metadata.routePath), ['/v1/photos/:id', '/v1/status', '/', '/combined']); assert.ok(endpoints(graph).every(route => handler(graph, route))); assert.equal(endpoints(graph).at(-1)?.metadata.method, 'GET|POST');
});

test('Rails route draw files and reused concerns retain the invoking scope and original evidence', async () => {
 const root = await repository('concern :commentable do |options|\n resources :comments, options\nend\nnamespace :admin do\n draw :admin\nend\nresources :photos, only: :show do\n concerns :commentable, only: :index\nend', { 'config/routes/admin.rb': 'resources :people, only: :show', 'app/controllers/admin/people_controller.rb': controller('Admin::PeopleController', ['show']), 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']), 'app/controllers/comments_controller.rb': controller('CommentsController', ['index']) }); const graph = await index(root); assert.deepEqual(endpoints(graph).map(route => route.metadata.routePath), ['/admin/people/:id', '/photos/:photo_id/comments', '/photos/:id']); assert.ok(endpoints(graph).every(route => handler(graph, route))); assert.equal(endpoints(graph)[0]?.path, 'config/routes/admin.rb'); assert.ok(endpoints(graph)[1]?.evidence.some(fact => fact.explanation?.includes('concern')));
});

test('Rails api_only defaults suppress new/edit without overriding explicit action lists', async () => {
 const root = await repository('resources :photos\nresources :forms, only: [:new, :edit]', { 'config/application.rb': 'module Shop; class Application < Rails::Application; config.api_only = true; end; end', 'app/controllers/photos_controller.rb': controller('PhotosController', ['index', 'create', 'show', 'update', 'destroy']), 'app/controllers/forms_controller.rb': controller('FormsController', ['new', 'edit']) }); const graph = await index(root); assert.equal(endpoints(graph).length, 7); assert.ok(!endpoints(graph).some(route => String(route.metadata.routePath).includes('/photos/new'))); assert.ok(endpoints(graph).every(route => handler(graph, route)));
});

test('Rails callbacks retain inherited private methods, filters, overrides, skip/prepend order and reference semantics', async () => {
 const root = await repository('resources :photos, only: [:show, :index]', { 'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base\n before_action :authenticate\n private\n def authenticate; end\nend', 'app/controllers/photos_controller.rb': 'class PhotosController < ApplicationController\n before_action :audit, only: :show\n prepend_before_action :prepare\n skip_before_action :authenticate, only: :index\n after_action :finish\n def show; end\n def index; end\n private\n def audit; end\n def prepare; end\n def finish; end\nend' }); const graph = await index(root); for (const route of endpoints(graph)) { const action = handler(graph, route)!; assert.ok(action); const callbacks = graph.relations.filter(relation => relation.type === 'references' && relation.from === action.id && relation.metadata?.role === 'action_callback').sort((a, b) => Number(a.metadata?.order) - Number(b.metadata?.order)).map(relation => graph.entities.find(entity => entity.id === relation.to)!.name); assert.deepEqual(callbacks, route.metadata.action === 'show' ? ['prepare', 'authenticate', 'audit', 'finish'] : ['prepare', 'finish']); assert.ok(!graph.relations.some(relation => relation.type === 'calls' && relation.from === action.id)); }
});

test('Rails literal segment/host constraints and original handlers participate in explicit-origin HTTP matching', async () => {
 const root = await repository('get "photos/:id", to: "photos#show", constraints: { id: /\\d+/, host: "rails.test" }', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']), 'client.ts': 'export function load(){return fetch("https://rails.test/photos/12.json")} export function wrong(){return fetch("https://rails.test/photos/abc")}' }); const graph = await index(root); assert.equal(graph.relations.filter(relation => relation.type === 'requests').length, 1); assert.ok(handler(graph, endpoints(graph)[0]!));
});

test('Rails route order and explicit HEAD precedence retain the selected original action', async () => {
 const root = await repository('get "photos/:id", to: "photos#show"\nget "photos/new", to: "photos#new"\nhead "photos/new", to: "photos#head_check"', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show', 'new', 'head_check']), 'client.ts': 'export function load(){return fetch("https://rails.test/photos/new")} export function check(){return fetch("https://rails.test/photos/new",{method:"HEAD"})}' }); const graph = await index(root); const requests = graph.relations.filter(relation => relation.type === 'requests'); assert.equal(requests.length, 2); assert.deepEqual(requests.map(relation => handler(graph, graph.entities.find(entity => entity.id === relation.to)!)?.name).sort(), ['show', 'head_check'].sort());
});

test('Rails dynamic DSL, callable constraints, missing controllers/actions and engine mounts stay visible gaps', async () => {
 const root = await repository('get route_path, to: "photos#show"\nget "private", to: "photos#secret"\nget "missing", to: "absent#show"\nconstraints Authorized.new do\n get "guarded", to: "photos#show"\nend\nmount Engine => "/engine"', { 'app/controllers/photos_controller.rb': 'class PhotosController < ApplicationController; def show; end; private; def secret; end; end' }); const graph = await index(root); assert.ok(endpoints(graph).every(route => route.metadata.constraintsUnresolved)); assert.ok(graph.diagnostics.some(item => item.analyzer === 'rails'));
});

test('Rails route/controller/config edits invalidate caches and cold/warm/revision retain original identities', async () => {
 const root = await repository('# 😀\r\nresources :photos, only: :show\r\n', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rails-cache-')); roots.push(state); const cold = await index(root, { cache: new AnalysisCache(state) }), warm = await index(root, { cache: new AnalysisCache(state) }), revision = await index(root, { revision: 'pinned' }); assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision)); assert.equal(endpoints(cold)[0]?.sourceRange?.startLine, 3); const original = handler(cold, endpoints(cold)[0]!)!; assert.equal(original.path, 'app/controllers/photos_controller.rb');
 await writeFile(path.join(root, 'app/controllers/photos_controller.rb'), controller('PhotosController', ['other'])); const changed = await index(root, { cache: new AnalysisCache(state) }); assert.equal(handler(changed, endpoints(changed)[0]!), undefined); assert.ok(endpoints(changed)[0]?.metadata.constraintsUnresolved);
});

test('Rails reviewed versions distinguish underscore-prefixed actions', async () => {
 for (const version of ['7.1.0', '7.2.0', '8.0.0', '8.1.0']) {
  const root = await repository('get "hidden", to: "photos#_hidden"', { Gemfile: `gem "rails", "${version}"`, 'app/controllers/photos_controller.rb': controller('PhotosController', ['_hidden']) });
  const graph = await index(root), route = endpoints(graph)[0]!;
  assert.equal(Boolean(handler(graph, route)), version !== '8.1.0', version);
  assert.equal(Boolean(route.metadata.constraintsUnresolved), version === '8.1.0', version);
 }
});

test('Rails abstract parent methods are internal while original child overrides remain actions', async () => {
 const root = await repository('get "inherited", to: "photos#inherited"\nget "show", to: "photos#show"', {
  'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base; abstract!; def inherited; end; def show; end; end',
  'app/controllers/photos_controller.rb': controller('PhotosController', ['show'])
 }); const graph = await index(root); assert.equal(handler(graph, endpoints(graph)[0]!), undefined); assert.equal(handler(graph, endpoints(graph)[1]!)?.path, 'app/controllers/photos_controller.rb', JSON.stringify(graph.diagnostics.filter(item => item.analyzer === 'rails')));
});

test('Rails reopened controllers retain the latest initialized original method identity', async () => {
 const root = await repository('get "show", to: "photos#show"', { 'app/controllers/photos_controller.rb': 'class PhotosController < ApplicationController\n def show; end\nend\nclass PhotosController\n def show; end\nend' });
 const graph = await index(root), action = handler(graph, endpoints(graph)[0]!)!; assert.equal(action.sourceRange?.startLine, 5); assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
});

test('Rails namespaced route DSL selects absolute controller constants', async () => {
 const root = await repository('get "show", to: "photos#show"', { 'config/routes.rb': 'module Routes\n class PhotosController; def show; end; end\n Rails.application.routes.draw do\n get "show", to: "photos#show"\n end\nend', 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) });
 const graph = await index(root); assert.equal(handler(graph, endpoints(graph)[0]!)?.path, 'app/controllers/photos_controller.rb'); assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved);
});

test('Rails native namespace shadows, custom dispatch, callback facades and mixins block original action claims', async () => {
 for (const [extra, body] of [['module Outer; ActionController = Custom; end', ''], ['def Rails.application; FakeApplication; end', ''], ['', 'def self.action_methods; end'], ['', 'def self.before_action(*args); end'], ['', 'include GeneratedActions']]) {
  const root = await repository('get "show", to: "photos#show"', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show'], body!), 'lib/shadow.rb': extra! }); const graph = await index(root); assert.equal(handler(graph, endpoints(graph)[0]!), undefined); assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved);
 }
});

test('Rails conditional callbacks and conditional skips keep source references with conditions', async () => {
 const root = await repository('get "show", to: "photos#show"', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show'], 'before_action :audit\n skip_before_action :audit, if: :skip_audit?\n if enabled\n before_action :conditional\n end\n private\n def audit; end\n def conditional; end\n public') });
 const graph = await index(root), action = handler(graph, endpoints(graph)[0]!)!; assert.ok(action);
 const callbacks = graph.relations.filter(relation => relation.from === action.id && relation.metadata?.role === 'action_callback'); assert.equal(callbacks.length, 2); assert.ok(callbacks.every(relation => (relation.metadata?.conditions as string[]).some(condition => /Conditional/.test(condition)))); assert.ok(!graph.relations.some(relation => relation.from === action.id && relation.type === 'calls'));
});

test('Rails missing mandatory callback skips cannot claim initialized actions', async () => {
 const root = await repository('get "show", to: "photos#show"', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show'], 'skip_before_action :absent') }); const graph = await index(root); assert.equal(handler(graph, endpoints(graph)[0]!), undefined); assert.ok(graph.diagnostics.some(item => /Skipping/.test(item.reason)));
});

test('Rails literal morphology overrides and resource aliases govern nested parameter names', async () => {
 const root = await repository('resources :people, as: :authors, only: :show do\n resources :teeth, only: :index\nend\nresource :tooth, only: :show', { 'config/initializers/inflections.rb': 'ActiveSupport::Inflector.inflections(:en) do |inflect|\n inflect.irregular "tooth", "teeth"\nend', 'app/controllers/people_controller.rb': controller('PeopleController', ['show']), 'app/controllers/teeth_controller.rb': controller('TeethController', ['index', 'show']) }); const graph = await index(root); assert.deepEqual(endpoints(graph).map(route => route.metadata.routePath), ['/people/:author_id/teeth', '/people/:id', '/tooth']); assert.ok(endpoints(graph).every(route => handler(graph, route) && !route.metadata.constraintsUnresolved));
});

test('Rails custom regex word inflections constrain generated resource registrations', async () => {
 const root = await repository('resources :photos, only: :show', { 'config/initializers/inflections.rb': 'ActiveSupport::Inflector.inflections do |inflect|; inflect.plural /x/, "y"; end', 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root); assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved); assert.ok(graph.diagnostics.some(item => /inflection|plural/.test(item.reason)));
});

test('Rails path names, custom paths, scoped defaults, hash shorthand and literal redirects retain mappings', async () => {
 const root = await repository('resources :photos, path: "images", path_names: { new: "make", edit: "change" }, only: [:new, :edit]\ndefaults controller: "photos", action: "show" do\n get "default"\nend\nget "/shortcut" => "photos#show"\nget "old", to: redirect("/images", status: 302)', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['new', 'edit', 'show']) }); const graph = await index(root), routes = endpoints(graph); assert.deepEqual(routes.map(route => route.metadata.routePath), ['/images/make', '/images/:id/change', '/default', '/shortcut', '/old']); assert.ok(routes.slice(0, 4).every(route => handler(graph, route))); assert.equal(routes[4]!.metadata.statusCode, 302); assert.ok(routes[4]!.metadata.automaticResponse);
});

test('Rails immutable literal route locals resolve while mutable targets remain visible', async () => {
 const root = await repository('literal = "photos/:id"\nget literal, to: "photos#show"\nmutable = "old"\nmutable = dynamic\nget mutable, to: "photos#show"', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root), routes = endpoints(graph); assert.equal(routes[0]!.metadata.routePath, '/photos/:id'); assert.ok(handler(graph, routes[0]!)); assert.ok(routes[1]!.metadata.constraintsUnresolved);
});

test('Rails dynamic dispatch values and unreviewed matcher options cannot silently claim exact routes', async () => {
 const root = await repository('get "show", controller: dynamic, action: :show\nget "wide", to: "photos#show", anchor: false\nget "symbol", to: :show, controller: "photos"\nresources :photos, only: :show, controller: dynamic', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root); assert.ok(endpoints(graph).every(route => route.metadata.constraintsUnresolved)); assert.equal(handler(graph, endpoints(graph)[0]!), undefined); assert.equal(handler(graph, endpoints(graph)[2]!), undefined);
});

test('Rails unavailable and recursive draw/concern sources retain unresolved registration competitors', async () => {
 const root = await repository('concern :recursive do\n concerns :recursive\nend\nconcerns :recursive\ndraw :loop\ndraw :denied', { 'config/routes/loop.rb': 'draw :loop', 'config/routes/denied.rb': 'get "hidden", to: "photos#show"', 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root, { config: { ignore: ['config/routes/denied.rb'], applications: [{ name: 'server', path: '.', ecosystems: ['ruby'] }] } }); assert.equal(endpoints(graph).length, 3); assert.ok(endpoints(graph).every(route => route.metadata.constraintsUnresolved && !handler(graph, route))); assert.ok(graph.diagnostics.some(item => /cyclic/.test(item.reason)));
});

test('Rails mounted engine and unknown helpers keep prefix competitors including their base path', async () => {
 const root = await repository('mount Engine => "/engine"\ncustom_routes\nget "known", to: "photos#show"', { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root), routes = endpoints(graph); assert.equal(routes[0]!.metadata.routePath, '/engine/*unresolved'); assert.ok(matchRoutePattern((routes[0]!.metadata.routing as { pattern: ReturnType<typeof compileRailsPath> }).pattern, '/engine')); assert.ok(routes.every(route => route.metadata.constraintsUnresolved));
});

test('Rails configuration, concern and draw edits invalidate warm route expansions', async () => {
 const root = await repository('draw :extra\nresources :photos', { 'config/routes/extra.rb': 'get "one", to: "photos#show"', 'app/controllers/photos_controller.rb': controller('PhotosController', ['index', 'create', 'new', 'show', 'edit', 'update', 'destroy']) }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rails-input-cache-')); roots.push(state);
 const cold = await index(root, { cache: new AnalysisCache(state) }); assert.equal(endpoints(cold).length, 8);
 await writeFile(path.join(root, 'config/routes/extra.rb'), 'get "two", to: "photos#show"'); await writeFile(path.join(root, 'config/application.rb'), 'module Shop; class Application < Rails::Application; config.api_only = true; end; end');
 const changed = await index(root, { cache: new AnalysisCache(state) }); assert.equal(endpoints(changed).length, 6); assert.equal(endpoints(changed)[0]!.metadata.routePath, '/two'); assert.equal(shape(changed), shape(await index(root)));
});

test('Rails Journey all-optional paths and bounded ambiguous syntax retain declared matching status', () => {
 const optional = compileRailsPath('(/:locale)(/:platform)'); for (const value of ['/', '/en', '/en/mobile', '/en/mobile.json']) assert.ok(matchRoutePattern(optional, value), value);
 assert.equal(compileRailsPath('/:a:b:c').status, 'partial'); assert.equal(compileRailsPath('/:a-:b/:c-:d/end', false).status, 'partial'); assert.equal(compileRailsPath('/broken(').status, 'partial');
 assert.ok(matchRoutePattern(compileRailsPath('/items/:id', 'json'), '/items/12')); assert.ok(matchRoutePattern(compileRailsPath('/items/:id', 'json'), '/items/12.json')); assert.equal(matchRoutePattern(compileRailsPath('/items/:id', 'json'), '/items/12.xml'), false);
});

test('Rails API and Metal controllers preserve dispatch and missing callback-module boundaries', async () => {
 for (const [native, callback, expected] of [['API', '', true], ['Metal', '', true], ['Metal', 'before_action :audit', false]] as const) {
  const root = await repository('get "show", to: "photos#show"', { 'app/controllers/application_controller.rb': `class ApplicationController < ActionController::${native}; end`, 'app/controllers/photos_controller.rb': controller('PhotosController', ['show'], callback) }); const graph = await index(root); assert.equal(Boolean(handler(graph, endpoints(graph)[0]!)), expected, native + callback);
 }
});

test('Rails unsupported escaped route literals and deeply nested scopes retain bounded gaps', async () => {
 for (const path of ['/with space', '/encoded%20space', '/quoted"path', '/非ascii']) assert.equal(compileRailsPath(path).status, 'partial', path);
 const root = await repository('scope "nested" do\n'.repeat(40) + 'get "show", to: "photos#show"\n' + 'end\n'.repeat(40), { 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root); assert.equal(endpoints(graph).length, 0); assert.ok((graph.entities.find(entity => entity.path === 'config/routes.rb' && entity.type === 'file')!.metadata.railsRoutes as { gaps: string[] }).gaps.some(reason => /depth budget/.test(reason)));
});

test('Rails nested parameter constraints and deep shallow collections retain parent routing semantics', async () => {
 const root = await repository('resources :posts, only: :show, shallow: true, constraints: { id: /\\d+/ } do\n resources :comments, only: [:index, :show] do\n resources :likes, only: :index\n end\nend', { 'app/controllers/posts_controller.rb': controller('PostsController', ['show']), 'app/controllers/comments_controller.rb': controller('CommentsController', ['index', 'show']), 'app/controllers/likes_controller.rb': controller('LikesController', ['index']) }); const graph = await index(root), routes = endpoints(graph); assert.deepEqual(routes.map(route => route.metadata.routePath), ['/comments/:comment_id/likes', '/posts/:post_id/comments', '/comments/:id', '/posts/:id']); assert.ok(routes.every(route => handler(graph, route) && !route.metadata.constraintsUnresolved));
 const pattern = (routes[1]!.metadata.routing as { pattern: ReturnType<typeof compileRailsPath> }).pattern; assert.ok(matchRoutePattern(pattern, '/posts/12/comments')); assert.equal(matchRoutePattern(pattern, '/posts/abc/comments'), false);
});

test('Rails concern activation preserves conditional definition and redefinition boundaries', async () => {
 const root = await repository('if enabled\n draw :definitions\nend\nconcerns :optional', { 'config/routes/definitions.rb': 'concern :optional do\n get "optional", to: "photos#show"\nend', 'app/controllers/photos_controller.rb': controller('PhotosController', ['show']) }); const graph = await index(root), optional = endpoints(graph).find(route => route.metadata.routePath === '/optional')!; assert.ok(optional.metadata.constraintsUnresolved); assert.ok((optional.metadata.routing as { conditions: string[] }).conditions.some(reason => /Conditional/.test(reason)));
});
