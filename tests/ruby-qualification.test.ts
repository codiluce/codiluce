import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import type { Entity, SoftwareGraph } from '../src/core/graph.js';
import { compareRubyVersions, rubyNumericVersion, satisfiesRubyRequirements, emptyRubyRequirements, validRubyRequirements, rubyProfileSubset } from '../src/analysis/languages/ruby-version.js';

// Generated source-contract fixtures. Only Codiluce's own parser/indexer runs.
const roots: string[] = []; after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-ruby-qualification-')); roots.push(root); for (const [file, text] of Object.entries(files)) await put(root, file, text); return root; }
const app: ApplicationInput = { name: 'server', path: '.', ecosystems: ['ruby'], apiOrigins: ['https://rails.test'] };
async function index(root: string, applications = [app], cache?: AnalysisCache, revision?: string, ignore?: string[]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'qualification' }, applications, ignore }), cache, revision }); }
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'rails').sort((a, b) => Number(a.metadata.routeOrder) - Number(b.metadata.routeOrder));
const handler = (graph: SoftwareGraph, route: Entity) => graph.entities.find(entity => entity.id === graph.relations.find(edge => edge.type === 'handles' && edge.from === route.id)?.to);
const base = { Gemfile: 'gem "rails", "~>8.1.0"', 'config/application.rb': 'module Shop; class Application < Rails::Application; end; end', 'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base; end', 'app/controllers/users_controller.rb': 'class UsersController < ApplicationController; def show; end; def update; end; end', 'config/routes.rb': 'Rails.application.routes.draw do; resources :users, only: %i[show update]; end' };
const locked = (rails: string, zeitwerk = '2.7.5') => `GEM\n  specs:\n    rails (${rails})\n    zeitwerk (${zeitwerk})\n`;
const profile = (graph: SoftwareGraph) => (graph.entities.find(entity => entity.type === 'repository')!.metadata.rubyAutoloadProfiles as { profile: { reviewed: boolean; version?: string; requirements: string[]; gaps: string[] } }[])[0]!.profile;

test('Numeric RubyGems comparisons retain hotfix precision and trailing-zero equivalence', () => {
 for (const [a, b, result] of [['8.1.3.1', '8.1.3', 1], ['8.1.3.0', '8.1.3', 0], ['8.1.3.10', '8.1.3.2', 1], ['8.1.3.1.0', '8.1.3.1', 0], ['8.1.03.01', '8.1.3.1', 0], ['7.2.0', '8.0', -1], ['2.7.5.1', '2.7.6', -1], ['0', '0.0.0', 0]] as const) assert.equal(compareRubyVersions(rubyNumericVersion(a)!, rubyNumericVersion(b)!), result, `${a} / ${b}`);
 for (const value of ['8.2.0.alpha', '8.1.3-1', 'latest', '1..2', '-1', '9007199254740992', Array(17).fill('1').join('.')]) assert.equal(rubyNumericVersion(value), undefined, value);
});

test('RubyGems requirements apply native pessimistic precision, exclusions and bounded profile intersections', () => {
 const cases: [string, string[], boolean][] = [['8.1.3.1', ['~>8.1'], true], ['8.2', ['~>8.1.0'], false], ['8.1.3.2', ['~>8.1.3.1'], true], ['8.1.4', ['~>8.1.3.1'], false], ['8.1.3', ['~>8.1.3.1'], false], ['8.1.3.1', ['8.1.3'], false], ['8.1.3.0', ['=8.1.3'], true], ['8.1.3.1', ['>=8.1.3', '<8.2', '!=8.1.3.1'], false], ['8.1.3.2', ['>=8.1.3', '<8.2', '!=8.1.3.1'], true], ['8.1.3.1', ['<=8.1.3.1', '>8.1.3'], true], ['8.1.3', ['>8.1.3'], false], ['3.99', ['~>3'], true], ['4', ['~>3'], false]];
 for (const [version, requirements, expected] of cases) assert.equal(satisfiesRubyRequirements(version, requirements), expected, JSON.stringify([version, requirements]));
 for (const requirements of [['>=8.2', '<8.1'], ['8.1.3', '!=8.1.3.0'], ['>8.1', '<=8.1']]) assert.equal(emptyRubyRequirements(requirements), true);
 assert.equal(emptyRubyRequirements(['>8.1.3', '<8.1.3.1']), false);
 assert.equal(rubyProfileSubset({ requirements: ['>=7.1', '<7.3'] }, '7.1', '7.3'), true);
 assert.equal(rubyProfileSubset({ requirements: ['>=8.0', '<=8.2', '!=8.2.0'] }, '8.0', '8.2'), true);
 assert.equal(rubyProfileSubset({ requirements: ['>=7.1', '<8.2'] }, '7.1', '7.3'), false);
 assert.equal(rubyProfileSubset({ requirements: ['~>8.1'] }, '8.0', '8.2'), false);
 assert.equal(rubyProfileSubset({}, '8.0', '8.2'), false);
 // A comma within one Gemfile string is not a native Gem::Requirement clause.
 for (const requirements of [['>=8.0, <8.2'], ['^8.1'], ['~>8.1.alpha'], ['~>9007199254740991'], Array(257).fill('>=0')]) { assert.equal(validRubyRequirements(requirements), false); assert.equal(satisfiesRubyRequirements('8.1.3.1', requirements), undefined); }
});

test('Real four-component lock selections qualify without truncating conflicts or unsupported profiles', async () => {
 const root = await repository(base);
 for (const [gemfile, lock, reviewed, handles] of [
  ['gem "rails"', locked('8.1.3.1'), true, 2],
  ['gem "rails", "~>8.1.3.1"', locked('8.1.3.2'), true, 2],
  ['gem "rails", "8.1.3"', locked('8.1.3.1'), false, 0],
  ['gem "rails", "8.1.3.0"', locked('8.1.3'), true, 2],
  ['gem "rails", ">=8.0", "<8.2", "!=8.1.3.1"', locked('8.1.3.1'), false, 0],
  ['gem "rails", ">=8.0, <8.2"', locked('8.1.3.1'), false, 0],
  ['gem "rails", "~>8.1"', '', false, 0],
  ['gem "rails", ">=7.1", "<8.2"', '', false, 0],
  ['gem "rails", "~>8.1.0"', locked('8.2.0.alpha'), false, 0],
  ['gem "rails", github: "rails/rails", branch: "main"', locked('8.1.3.1'), false, 0],
  ['gem "rails", "~>8.1.0"', locked('8.1.3.1') + '    rails (8.1.3.2)\n', false, 0],
  ['gem "rails", "~>8.1.0"', locked('8.1.3.0') + '    rails (8.1.3)\n', true, 2]
 ] as const) { await put(root, 'Gemfile', gemfile); await put(root, 'Gemfile.lock', lock); const graph = await index(root); assert.equal(profile(graph).reviewed, reviewed, gemfile + lock + JSON.stringify(profile(graph))); assert.equal(graph.relations.filter(edge => edge.type === 'handles').length, handles, gemfile + lock); if (reviewed) assert.equal(profile(graph).version, /rails \(([^)]+)/.exec(lock)?.[1]); }
});

test('Recorded Zeitwerk hotfix versions compare natively with locks and preserve configuration spelling', async () => {
 const root = await repository({ Gemfile: 'gem "zeitwerk", "~>2.7.0"', 'Gemfile.lock': 'GEM\n  specs:\n    zeitwerk (2.7.5)\n', 'main.rb': 'Widget.run', 'lib/widget.rb': 'class Widget; def self.run; end; end' });
 for (const [version, count] of [['2.7.5.0', 1], ['2.7.5.1', 0]] as const) { const graph = await index(root, [{ ...app, ruby: { autoload: { version, roots: [{ path: 'lib' }] } } }]); assert.equal(graph.relations.filter(edge => edge.type === 'calls').length, count); assert.equal(profile(graph).version, version); }
});

test('Static symbol arrays retain original route/callback sites; interpolation and escapes remain gaps', async () => {
 const root = await repository({ ...base, 'config/routes.rb': '# 😀 original\r\nRails.application.routes.draw do\r\n resources :users, only: %I[show update]\r\nend\r\n', 'app/controllers/users_controller.rb': 'class UsersController < ApplicationController\n before_action :auth, only: %i[show update]\n def show; end\n def update; end\n private\n def auth; end\nend' });
 const graph = await index(root); assert.equal(endpoints(graph).length, 2); assert.ok(endpoints(graph).every(route => handler(graph, route) && route.sourceRange?.startLine === 3)); assert.equal(graph.relations.filter(edge => edge.metadata?.role === 'action_callback').length, 2);
 for (const values of ['%I[show #{dynamic}]', '%i[sh\\ow update]']) { await put(root, 'config/routes.rb', `Rails.application.routes.draw do; resources :users, only: ${values}; end`); const unknown = await index(root); assert.equal(unknown.relations.filter(edge => edge.type === 'handles').length, 0, values); assert.ok(unknown.diagnostics.some(item => /resource action/.test(item.reason)), values); }
});

const releases = [['7.1.0', '2.6.18'], ['7.2.0', '2.7.1'], ['8.0.0', '2.7.2'], ['8.1.3.1', '2.7.5']] as const;
test('Underscore action requirements crossing the Rails 8.1.0 reversal retain uncertainty', async () => {
 const root = await repository({ ...base, 'config/routes.rb': 'Rails.application.routes.draw do; get "hidden", to: "users#_hidden"; end', 'app/controllers/users_controller.rb': 'class UsersController < ApplicationController; def _hidden; end; end' });
 for (const [requirement, count] of [['~>8.1.0', 0], ['~>8.1.1', 1], ['~>8.1.3.1', 1], ['8.1.0.1', 0]] as const) { await put(root, 'Gemfile', `gem "rails", "${requirement}"`); const graph = await index(root); assert.equal(graph.relations.filter(edge => edge.type === 'handles').length, count, requirement); }
});
test('Reviewed Rails release profiles retain native plural and singleton registration order', async () => {
 const all = ['index', 'create', 'new', 'edit', 'show', 'update', 'destroy'];
 const root = await repository({ ...base, 'config/routes.rb': 'Rails.application.routes.draw do; resources :users; resource :profile; end', 'app/controllers/users_controller.rb': `class UsersController < ApplicationController; ${all.map(action => `def ${action}; end`).join(';')}; end`, 'app/controllers/profiles_controller.rb': `class ProfilesController < ApplicationController; ${all.slice(1).map(action => `def ${action}; end`).join(';')}; end` });
 for (const [version, loader] of releases) { await put(root, 'Gemfile', `gem "rails", "${version}"`); await put(root, 'Gemfile.lock', locked(version, loader)); const graph = await index(root); assert.deepEqual(endpoints(graph).map(route => route.metadata.action), [...all, 'new', 'edit', 'show', 'update', 'destroy', 'create']); assert.ok(endpoints(graph).every(route => handler(graph, route) && !route.metadata.constraintsUnresolved)); }
});

test('TS/Vue/Svelte/Astro reach original Rails actions and callback references across four version profiles', async () => {
 const files: Record<string, string> = {}, applications: ApplicationInput[] = [{ name: 'ts', path: 'ts', ecosystems: ['node'] }, { name: 'vue', path: 'vue', frameworks: ['vue'] }, { name: 'svelte', path: 'svelte', frameworks: ['svelte'] }, { name: 'astro', path: 'astro', frameworks: ['astro'] }];
 const calls: string[] = [];
 for (const [i, [version, loader]] of releases.entries()) { const prefix = `rails${i}`, origin = `https://rails${i}.test`; applications.push({ name: prefix, path: prefix, ecosystems: ['ruby'], apiOrigins: [origin] }); for (const [file, text] of Object.entries(base)) files[`${prefix}/${file}`] = text;
  files[`${prefix}/Gemfile`] = `gem "rails", "${version}"`; files[`${prefix}/Gemfile.lock`] = locked(version, loader);
  files[`${prefix}/config/routes.rb`] = '# 😀 route proof\r\nRails.application.routes.draw do\r\n namespace :admin do\r\n resources :users, only: %i[show update]\r\n end\r\nend'; delete files[`${prefix}/app/controllers/users_controller.rb`];
  files[`${prefix}/app/controllers/application_controller.rb`] = 'class ApplicationController < ActionController::Base\r\n before_action :auth, only: %i[show update]\r\n private\r\n def auth; end\r\nend';
  files[`${prefix}/app/controllers/admin/users_controller.rb`] = '# 😀 action proof\r\nclass Admin::UsersController < ApplicationController\r\n def show; end\r\n def update; end\r\nend';
  calls.push(`fetch('${origin}/admin/users/12.json')`, `fetch('${origin}/admin/users/12',{method:'PATCH'})`);
 }
 files['ts/client.ts'] = calls.map((call, i) => `export function call${i}(){return ${call};}`).join('\n');
 files['vue/package.json'] = '{"dependencies":{"vue":"^3.5.0"}}'; files['vue/App.vue'] = '<script setup>const native=fetch;</script><template>' + calls.map(call => `<button @click="${call.replace('fetch(', 'native(')}"/>`).join('') + '</template>';
 files['svelte/package.json'] = '{"dependencies":{"svelte":"^5.57.2"}}'; files['svelte/App.svelte'] = '<script>const native=fetch;</script>' + calls.map(call => `<button onclick={()=>${call.replace('fetch(', 'native(')}}>Load</button>`).join('');
 files['astro/package.json'] = '{"dependencies":{"astro":"^7.3.8"}}'; files['astro/astro.config.mjs'] = 'export default {output:"server"};'; files['astro/src/pages/index.astro'] = calls.map(call => `{${call}}`).join('\n');
 const root = await repository(files), state = await repository({}); const cold = await index(root, applications, new AnalysisCache(state)), warm = await index(root, applications, new AnalysisCache(state)), revision = await index(root, applications, undefined, 'recorded'); assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision));
 assert.equal(endpoints(cold).length, 8); assert.equal(cold.relations.filter(edge => edge.type === 'handles').length, 8); assert.equal(cold.relations.filter(edge => edge.metadata?.role === 'action_callback').length, 8);
 for (const prefix of ['ts/', 'vue/', 'svelte/', 'astro/']) { const requests = cold.relations.filter(edge => edge.type === 'requests' && cold.entities.find(entity => entity.id === edge.from)?.path?.startsWith(prefix)); assert.equal(requests.length, 8, prefix + JSON.stringify(cold.diagnostics.filter(item => item.file?.startsWith(prefix)))); assert.deepEqual(requests.map(edge => edge.metadata?.method).sort(), Array(4).fill('GET').concat(Array(4).fill('PATCH'))); }
 const store = new GraphStore(':memory:'); try { store.save(cold); const projection = new ProjectionService(store, { root }); for (const route of endpoints(cold)) { const action = handler(cold, route)!; assert.equal(action.path, `${route.path!.split('/')[0]}/app/controllers/admin/users_controller.rb`); assert.equal(action.sourceRange?.startLine, route.metadata.action === 'show' ? 3 : 4); const edge = cold.relations.find(item => item.type === 'handles' && item.from === route.id)!; assert.ok(edge.evidence.some(item => item.file === route.path && item.line === 4)); const flow = await projection.requestFlow(route.id, { maxFileBytes: 1 << 20 }); assert.equal(flow.nodes.find(node => node.kind === 'handler')?.node?.id, action.id); const callback = cold.relations.find(item => item.from === action.id && item.metadata?.role === 'action_callback')!; assert.equal(cold.entities.find(item => item.id === callback.to)?.sourceRange?.startLine, 4); assert.ok(!cold.relations.some(item => item.type === 'calls' && item.from === action.id && item.to === callback.to)); } } finally { store.close(); }
});

test('Rails cross-file cache inputs invalidate routes, original actions, callback filters, versions and denied sources', async () => {
 const root = await repository({ ...base, 'config/routes.rb': 'Rails.application.routes.draw do; draw :extra; end', 'config/routes/extra.rb': 'resources :users, only: %i[show update]', 'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base; before_action :auth, only: %i[show]; private; def auth; end; end' }), state = await repository({});
 async function replay(applications = [app], ignore?: string[]) { const cached = await index(root, applications, new AnalysisCache(state), undefined, ignore), cold = await index(root, applications, undefined, 'recorded', ignore); assert.equal(shape(cached), shape(cold)); return cached; }
 let graph = await replay(); assert.equal(graph.relations.filter(edge => edge.metadata?.role === 'action_callback').length, 1);
 await put(root, 'config/routes/extra.rb', 'resources :users, path: "people", only: %i[show]'); graph = await replay(); assert.deepEqual(endpoints(graph).map(route => route.metadata.routePath), ['/people/:id']);
 await put(root, 'app/controllers/users_controller.rb', '# 😀\r\nclass UsersController < ApplicationController\r\n private\r\n def show; end\r\nend'); graph = await replay(); assert.equal(graph.relations.filter(edge => edge.type === 'handles').length, 0);
 await put(root, 'app/controllers/users_controller.rb', '# 😀\r\nclass UsersController < ApplicationController\r\n def show; end\r\nend'); await put(root, 'app/controllers/application_controller.rb', 'class ApplicationController < ActionController::Base; before_action :auth, only: %i[update]; private; def auth; end; end'); graph = await replay(); assert.equal(handler(graph, endpoints(graph)[0]!)?.sourceRange?.startLine, 3); assert.equal(graph.relations.filter(edge => edge.metadata?.role === 'action_callback').length, 0);
 await put(root, 'Gemfile.lock', locked('8.1.3.1')); graph = await replay(); assert.equal(profile(graph).version, '8.1.3.1'); assert.ok(handler(graph, endpoints(graph)[0]!));
 graph = await replay([{ ...app, apiOrigins: ['https://other.test'] }]); assert.ok(handler(graph, endpoints(graph)[0]!));
 graph = await replay([app], ['app/controllers/users_controller.rb']); assert.equal(graph.relations.filter(edge => edge.type === 'handles').length, 0);
 await put(root, 'Gemfile.lock', locked('9.0.0')); graph = await replay(); assert.equal(graph.relations.filter(edge => edge.type === 'handles').length, 0); assert.equal(profile(graph).reviewed, false);
});

test('Distinct Ruby applications cannot borrow another original controller or selected Rails profile', async () => {
 const files: Record<string, string> = {}; for (const prefix of ['a', 'b']) for (const [file, text] of Object.entries(base)) files[`${prefix}/${file}`] = text;
 files['a/Gemfile.lock'] = locked('8.1.3.1'); files['b/Gemfile.lock'] = locked('9.0.0'); delete files['b/app/controllers/users_controller.rb'];
 const root = await repository(files), applications = ['a', 'b'].map(prefix => ({ ...app, name: prefix, path: prefix, apiOrigins: [`https://${prefix}.test`] })); const graph = await index(root, applications);
 assert.equal(endpoints(graph).length, 4); assert.ok(endpoints(graph).filter(route => route.path?.startsWith('a/')).every(route => handler(graph, route)?.path === 'a/app/controllers/users_controller.rb'), JSON.stringify(graph.diagnostics.filter(item => item.file?.startsWith('a/')))); assert.ok(endpoints(graph).filter(route => route.path?.startsWith('b/')).every(route => !handler(graph, route) && route.metadata.constraintsUnresolved));
});
