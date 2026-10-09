import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { rubyGemRange } from '../src/analysis/languages/ruby-profile.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-autoload-')); roots.push(root); for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); } return root; }
const rails = { Gemfile: 'gem "rails", "~> 8.1.0"', 'config/application.rb': 'module Shop; class Application < Rails::Application; end; end' };
const generic: ApplicationInput = { name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['lib'] }, ruby: { autoload: { version: '2.7.5', roots: [{ path: 'lib' }] } } };
async function index(root: string, options: { apps?: ApplicationInput[]; cache?: AnalysisCache; revision?: string; ignore?: string[]; maxFileBytes?: number } = {}) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'fixture' }, applications: options.apps ?? [{ name: 'ruby', path: '.', ecosystems: ['ruby'], sourceRoots: { ruby: ['lib'] } }], ignore: options.ignore, maxFileBytes: options.maxFileBytes }), cache: options.cache, revision: options.revision }); }
const file = (graph: SoftwareGraph, name = 'main.rb') => graph.entities.find(entity => entity.type === 'file' && entity.path === name)!;
type Ref = { spelling: string; name?: string; kind: string; reason?: string; targets?: string[]; conditions: string[] };
type Call = { method: string; kind: string; target?: string; reason?: string; range: { startLine: number }; conditions: string[] };
const refs = (graph: SoftwareGraph, name = 'main.rb') => file(graph, name).metadata.rubyReferenceOutcomes as Ref[];
const calls = (graph: SoftwareGraph, name = 'main.rb') => file(graph, name).metadata.rubyCallOutcomes as Call[];
const targets = (graph: SoftwareGraph, name = 'main.rb') => calls(graph, name).filter(call => call.target).map(call => graph.entities.find(entity => entity.id === call.target)!);
const profiles = (graph: SoftwareGraph) => graph.entities.find(entity => entity.type === 'repository')!.metadata.rubyAutoloadProfiles as { profile: { reviewed: boolean; version?: string; range?: string }; roots: { path: string; namespace: string; loader: string }[]; gaps: string[] }[];
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('RubyGems pessimistic requirements and AND ranges retain Ruby version semantics', () => {
 assert.equal(rubyGemRange(['~> 8.1']), '>=8.1.0 <9.0.0'); assert.equal(rubyGemRange(['~> 8.1.0']), '>=8.1.0 <8.2.0'); assert.equal(rubyGemRange(['>= 7.1', '< 7.3']), '>=7.1.0 <7.3.0'); assert.equal(rubyGemRange(['8.1']), '8.1.0'); assert.equal(rubyGemRange(['latest']), undefined);
});

test('Ruby literal autoload stays lazy and later access binds the expected original constant/method', async () => {
 const root = await repository({ 'main.rb': `class Safe; def self.run; end; end\nautoload :Widget, 'widget'\nSafe.run\nWidget.run`, 'lib/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root);
 assert.deepEqual(targets(graph).map(entity => entity.path), ['main.rb', 'lib/widget.rb']); assert.ok(graph.relations.some(relation => relation.type === 'imports' && relation.metadata?.kind === 'autoload-trigger')); assert.equal((file(graph).metadata.rubyAutoloadOutcomes as any[]).filter(item => item.status === 'resolved').length, 1);
});

test('Ruby implicit and explicit module receiver autoload registrations retain their namespace', async () => {
 for (const registration of [`module Shop; autoload :Widget, 'widget'; end`, `module Shop; end; Shop.autoload :Widget, 'widget'`, `module Shop; self.autoload :Widget, 'widget'; end`]) {
  const root = await repository({ 'main.rb': `${registration}\nShop::Widget.run`, 'lib/widget.rb': 'module Shop; class Widget; def self.run; end; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 1, registration); assert.equal(refs(graph).at(-1)?.name, 'Shop::Widget'); assert.equal((file(graph).metadata.importOutcomes as any[])[0]?.outcome.status, 'resolved', registration);
 }
});

test('Ruby autoload mismatches and cyclic initialization remain explicit unresolved outcomes', async () => {
 const root = await repository({ 'main.rb': `autoload :Widget, 'widget'\nWidget.run`, 'lib/widget.rb': 'class Wrong; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 0); assert.match(refs(graph).at(-1)?.reason ?? '', /expected constant/);
 const cycle = await repository({ 'main.rb': `autoload :Widget, 'widget'\nWidget`, 'lib/widget.rb': 'Widget; class Widget; end' }); const cyclic = await index(cycle); assert.equal(targets(cyclic).length, 0); assert.ok((file(cyclic).metadata.rubyAutoloadOutcomes as any[]).some(item => item.reason?.includes('Cyclic')));
 const external = await repository({ 'main.rb': 'autoload :Widget, "widget"; Widget.run', 'lib/widget.rb': 'require "external"; class Widget; def self.run; end; end' }); const bounded = await index(external); assert.equal(targets(bounded).length, 0); assert.ok((file(bounded).metadata.rubyAutoloadOutcomes as any[]).every(item => item.status === 'unresolved'));
});

test('Generic recorded Zeitwerk roots activate implicit namespaces without invented graph declarations', async () => {
 const root = await repository({ 'main.rb': 'Admin::Widget.run', 'lib/admin/widget.rb': 'class Admin::Widget; def self.run; end; end' }); const graph = await index(root, { apps: [generic] }); assert.equal(targets(graph).length, 1); assert.equal(refs(graph).at(-1)?.name, 'Admin::Widget'); assert.ok(!graph.entities.some(entity => entity.type === 'class' && entity.name === 'Admin')); assert.ok((file(graph).metadata.rubyAutoloadOutcomes as any[]).some(item => item.kind === 'implicit')); assert.ok(calls(graph).at(-1)?.conditions.length);
 const unicode = await repository({ 'main.rb': 'Widget.run', 'lib/ǆir.rb': 'class Widget; def self.run; end; end' }); const unreviewed = await index(unicode, { apps: [generic] }); assert.equal(targets(unreviewed).length, 0); assert.match(profiles(unreviewed)[0]?.gaps.join('; ') ?? '', /unreviewed autoload basename/);
 const explicit = await index(unicode, { apps: [{ ...generic, ruby: { autoload: { ...generic.ruby!.autoload!, inflections: { 'ǆir': 'Widget' } } } }] }); assert.equal(targets(explicit).length, 1);
});

test('Explicit namespace files promote an implicit directory namespace and retain original method targets', async () => {
 const root = await repository({ 'main.rb': 'Admin::Widget.run', 'lib/admin.rb': 'module Admin; end', 'lib/admin/widget.rb': 'module Admin; class Widget; def self.run; end; end; end' }); const graph = await index(root, { apps: [generic] }); assert.equal(targets(graph).length, 1); assert.ok((file(graph).metadata.rubyAutoloadOutcomes as any[]).some(item => item.name === 'Admin' && item.kind === 'file')); assert.ok(graph.relations.some(item => item.type === 'references' && graph.entities.find(entity => entity.id === item.to)?.path === 'lib/admin/widget.rb'));
});

test('Zeitwerk ordered roots shadow later files and nested roots retain independent namespaces', async () => {
 const root = await repository({ 'main.rb': 'Widget.run; Shared.run; Concerns::Shared.run', 'first/widget.rb': 'class Widget; def self.run; end; end', 'second/widget.rb': 'class Widget; def self.run; end; end', 'first/concerns/shared.rb': 'module Shared; def self.run; end; end' }); const app: ApplicationInput = { ...generic, ruby: { autoload: { version: '2.7.5', roots: [{ path: 'first' }, { path: 'first/concerns' }, { path: 'second' }] } } };
 const graph = await index(root, { apps: [app] }); assert.deepEqual(targets(graph).map(entity => entity.path), ['first/widget.rb', 'first/concerns/shared.rb']); assert.equal(refs(graph).at(-1)?.kind, 'unknown'); assert.ok((file(graph, 'second/widget.rb').metadata.rubyAutoload as any).candidates[0]?.selected === false);
});

test('Recorded collapse/ignore/namespace/inflection inputs map exact basenames without leaking sibling applications', async () => {
 const root = await repository({ 'main.rb': 'module API; end; API::HTMLParser.run; API::Hidden.run', 'lib/actions/html_parser.rb': 'class API::HTMLParser; def self.run; end; end', 'lib/hidden.rb': 'class API::Hidden; def self.run; end; end', 'other/app/models/user.rb': 'class User; end' }); const app: ApplicationInput = { ...generic, ruby: { autoload: { version: '2.7.5', roots: [{ path: 'lib', namespace: 'API' }], collapse: ['lib/actions'], ignore: ['lib/hidden.rb'], inflections: { html_parser: 'HTMLParser' } } } };
 const graph = await index(root, { apps: [app, { name: 'other', path: 'other', ecosystems: ['ruby'] }] }); assert.equal(targets(graph).length, 1); assert.equal(refs(graph).at(-1)?.kind, 'unknown'); assert.ok(!profiles(graph)[0]?.roots.some(root => root.path.startsWith('other/')));
});

test('Rails app, custom directory and concerns roots exclude assets/javascript/views and default lib', async () => {
 const root = await repository({ ...rails, 'main.rb': 'Widget.run; Presenter.run; Shared.run; Asset.run; Client.run; View.run; Library.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end', 'app/presenters/presenter.rb': 'class Presenter; def self.run; end; end', 'app/models/concerns/shared.rb': 'module Shared; def self.run; end; end', 'app/assets/asset.rb': 'class Asset; def self.run; end; end', 'app/javascript/client.rb': 'class Client; def self.run; end; end', 'app/views/view.rb': 'class View; def self.run; end; end', 'lib/library.rb': 'class Library; def self.run; end; end' }); const graph = await index(root); assert.equal(profiles(graph)[0]?.profile.reviewed, true); assert.deepEqual(targets(graph).map(entity => entity.path), ['app/models/widget.rb', 'app/presenters/presenter.rb', 'app/models/concerns/shared.rb']); assert.equal((file(graph, 'app/models/widget.rb').metadata.analysis as any).features.framework.status, 'partial');
});

test('Rails source autoload_lib with percent-word ignore arrays and literal extra/once roots remains source backed', async () => {
 const root = await repository({ ...rails, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.autoload_lib(ignore: %w(assets tasks)); config.autoload_paths << Rails.root.join("extras"); config.autoload_once_paths << Rails.root.join("once"); end; end', 'main.rb': 'Library.run; Extra.run; Once.run; Task.run', 'lib/library.rb': 'class Library; def self.run; end; end', 'extras/extra.rb': 'class Extra; def self.run; end; end', 'once/once.rb': 'class Once; def self.run; end; end', 'lib/tasks/task.rb': 'class Task; def self.run; end; end' }); const graph = await index(root); assert.deepEqual(targets(graph).map(entity => entity.path), ['lib/library.rb', 'extras/extra.rb', 'once/once.rb']); assert.ok(profiles(graph)[0]?.roots.some(root => root.loader === 'once' && root.path === 'once'));
});

test('Rails config path precedence differs from source-call order and once membership survives eager roots', async () => {
 const root = await repository({ ...rails, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.eager_load_paths << Rails.root.join("eager"); config.autoload_paths << Rails.root.join("extra"); config.autoload_once_paths << Rails.root.join("once"); config.eager_load_paths << Rails.root.join("once"); end; end', 'main.rb': 'Widget.run; Once.run', 'eager/widget.rb': 'class Widget; def self.run; end; end', 'extra/widget.rb': 'class Widget; def self.run; end; end', 'app/models/widget.rb': 'class Widget; def self.run; end; end', 'once/once.rb': 'class Once; def self.run; end; end' }); const graph = await index(root); assert.deepEqual(targets(graph).map(entity => entity.path), ['extra/widget.rb', 'once/once.rb']); assert.equal(profiles(graph)[0]?.roots.find(root => root.path === 'once')?.loader, 'once');
 const reset = await repository({ ...rails, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.eager_load_paths << Rails.root.join("eager"); config.autoload_paths << Rails.root.join("old"); config.autoload_paths = [Rails.root.join("extra")]; end; end', 'main.rb': 'Widget.run; Old.run; Eager.run', 'extra/widget.rb': 'class Widget; def self.run; end; end', 'old/old.rb': 'class Old; def self.run; end; end', 'eager/eager.rb': 'class Eager; def self.run; end; end' }); assert.deepEqual(targets(await index(reset)).map(entity => entity.path), ['extra/widget.rb', 'eager/eager.rb']);
});

test('Rails 7.1 and 7.2+ preserve their distinct eager-path append and setter defaults', async () => {
 for (const version of ['7.1.0', '7.2.0', '8.0.0', '8.1.0']) {
  const sources = { ...rails, Gemfile: `gem "rails", "${version}"`, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end', 'eager/widget.rb': 'class Widget; def self.run; end; end' };
  const root = await repository({ ...sources, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.eager_load_paths << Rails.root.join("eager"); end; end' }); assert.equal(targets(await index(root))[0]?.path, version === '7.1.0' ? 'app/models/widget.rb' : 'eager/widget.rb', version);
  const reset = await repository({ ...sources, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.eager_load_paths = []; end; end' }); const graph = await index(reset); assert.equal(targets(graph).length, version === '7.1.0' ? 0 : 1, version);
 }
 const crossing = await repository({ ...rails, Gemfile: 'gem "rails", ">=7.1", "<7.3"', 'config/application.rb': 'module Shop; class Application < Rails::Application; config.eager_load_paths << Rails.root.join("eager"); end; end', 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end', 'eager/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(crossing); assert.equal(targets(graph).length, 0); assert.match(profiles(graph)[0]?.gaps.join('; ') ?? '', /ordering profiles/);
});

test('Rails preview defaults retain version-specific ordering and collection mutations require literal arrays', async () => {
 for (const version of ['7.1.0', '7.2.0', '8.1.0']) {
  const root = await repository({ ...rails, Gemfile: `gem "rails", "${version}"`, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.autoload_paths << Rails.root.join("extra"); end; end', 'main.rb': 'Widget.run', 'test/mailers/previews/widget.rb': 'class Widget; def self.run; end; end', 'extra/widget.rb': 'class Widget; def self.run; end; end' }); assert.equal(targets(await index(root))[0]?.path, version === '7.1.0' ? 'test/mailers/previews/widget.rb' : 'extra/widget.rb', version);
 }
 for (const setup of ['config.autoload_paths = Rails.root.join("extra")', 'config.autoload_paths.push([Rails.root.join("extra")])', 'config.autoload_paths.concat(Rails.root.join("extra"))']) {
  const root = await repository({ ...rails, 'config/application.rb': `module Shop; class Application < Rails::Application; ${setup}; end; end`, 'main.rb': 'Extra.run', 'extra/extra.rb': 'class Extra; def self.run; end; end' }); assert.equal(targets(await index(root)).length, 0, setup);
 }
});

test('Loader-specific ignore rules stay separate and selected environments configure once paths before setup', async () => {
 const root = await repository({ ...rails, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.autoload_once_paths << Rails.root.join("once"); Rails.autoloaders.main.ignore(Rails.root.join("once/widget.rb")); end; end', 'main.rb': 'Widget.run', 'once/widget.rb': 'class Widget; def self.run; end; end' }); assert.equal(targets(await index(root)).length, 1);
 const environment = await repository({ ...rails, 'config/environments/production.rb': 'Rails.application.configure do; config.autoload_once_paths << Rails.root.join("once"); Rails.autoloaders.once.inflector.inflect("html_parser" => "HTMLParser"); end', 'config/initializers/use.rb': 'HTMLParser.run', 'once/html_parser.rb': 'class HTMLParser; def self.run; end; end' }); const graph = await index(environment, { apps: [{ name: 'ruby', path: '.', ecosystems: ['ruby'], ruby: { environment: 'production' } }] }); assert.equal(targets(graph, 'config/initializers/use.rb').length, 1);
 const late = await repository({ ...rails, 'config/initializers/late.rb': 'Rails.application.configure do; config.autoload_paths << Rails.root.join("extra"); end', 'main.rb': 'Extra.run', 'extra/extra.rb': 'class Extra; def self.run; end; end' }); const lateGraph = await index(late); assert.equal(targets(lateGraph).length, 0); assert.match(profiles(lateGraph)[0]?.gaps.join('; ') ?? '', /after path setup/);
});

test('Rails literal loader-specific inflections and ActiveSupport acronyms use exact basename semantics', async () => {
 const root = await repository({ ...rails, 'config/initializers/inflections.rb': 'ActiveSupport::Inflector.inflections(:en) do |inflect| inflect.acronym "API"; end\nRails.autoloaders.each do |loader| loader.inflector.inflect("html_parser" => "HTMLParser"); end', 'main.rb': 'APIClient.run; HTMLParser.run; HtmlParser.run', 'app/services/api_client.rb': 'class APIClient; def self.run; end; end', 'app/services/html_parser.rb': 'class HTMLParser; def self.run; end; end' }); const graph = await index(root); assert.deepEqual(targets(graph).map(entity => entity.name), ['run', 'run']); assert.equal(refs(graph).at(-1)?.kind, 'unknown');
});

test('Rails deterministic Zeitwerk inflector assignment clears previous overrides and stops acronym fallback', async () => {
 const root = await repository({ ...rails, 'config/initializers/zeitwerk.rb': 'ActiveSupport::Inflector.inflections(:en) do |inflect| inflect.acronym "API"; end\nRails.autoloaders.main.inflector.inflect("widget" => "OldWidget")\nRails.autoloaders.main.inflector = Zeitwerk::Inflector.new\nRails.autoloaders.main.inflector.inflect("html_parser" => "HTMLParser")', 'main.rb': 'ApiClient.run; Widget.run; HTMLParser.run; APIClient.run; OldWidget.run', 'app/services/api_client.rb': 'class ApiClient; def self.run; end; end', 'app/models/widget.rb': 'class Widget; def self.run; end; end', 'app/services/html_parser.rb': 'class HTMLParser; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 3);
});

test('Rails custom root namespaces retain original initializer modules and source collapse paths', async () => {
 const root = await repository({ ...rails, 'config/initializers/autoload.rb': 'module Services; end\nRails.autoloaders.main.push_dir(Rails.root.join("app/services"), namespace: Services)\nRails.autoloaders.main.collapse(Rails.root.join("app/services/actions"))', 'main.rb': 'Services::Signup.run; Signup.run', 'app/services/actions/signup.rb': 'class Services::Signup; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 1); assert.equal(refs(graph).at(-1)?.kind, 'unknown'); assert.ok(refs(graph)[0]?.targets?.every(id => graph.entities.some(entity => entity.id === id)));
});

test('Rails main autoloading is constrained during initializers while deferred references retain invocation conditions', async () => {
 const root = await repository({ ...rails, 'config/initializers/check.rb': 'Widget\ndef later; Widget; end', 'app/models/widget.rb': 'class Widget; end' }); const graph = await index(root); const references = refs(graph, 'config/initializers/check.rb'); assert.match(references[0]?.reason ?? '', /during.*boot/); assert.equal(references[1]?.kind, 'unknown', 'earlier failed startup remains a barrier for this snapshot');
});

test('Autoload version profiles retain broad/unknown/old ranges, conflicting locks and local gem sources as gaps', async () => {
 for (const gemfile of ['gem "rails"', 'gem "rails", "~> 8.1"', 'gem "rails", "~> 6.1.0"', 'gem "rails", "~> 8.1.0", path: "vendor/rails"', 'gem "rails", ">8.1.0", "<8.1.0"']) {
  const root = await repository({ ...rails, Gemfile: gemfile, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 0, gemfile); assert.ok(profiles(graph)[0]?.gaps.length);
 }
 const root = await repository({ ...rails, 'Gemfile.lock': 'GEM\n  specs:\n    rails (8.0.0)\n', 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.match(profiles(graph)[0]?.gaps.join('; ') ?? '', /conflicts/);
});

test('A selected lock version qualifies a broader literal requirement without executing Bundler', async () => {
 const root = await repository({ ...rails, Gemfile: 'gem "rails", "~> 8.1"', 'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (8.1.0)\n', 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 1); assert.equal(profiles(graph)[0]?.profile.version, '8.1.0');
});

test('Reviewed Rails and Zeitwerk release lines share the bounded source contract', async () => {
 for (const version of ['7.1.0', '7.2.0', '8.0.0', '8.1.0']) {
  const root = await repository({ ...rails, Gemfile: `gem "rails", "${version}"`, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 1, version); assert.equal(profiles(graph)[0]?.profile.reviewed, true);
 }
 for (const version of ['2.6.0', '2.7.5', '2.8.0']) {
  const root = await repository({ 'main.rb': 'Widget.run', 'lib/widget.rb': 'class Widget; def self.run; end; end' }); const app = { ...generic, ruby: { autoload: { version, roots: [{ path: 'lib' }] } } }; assert.equal(targets(await index(root, { apps: [app] })).length, version === '2.8.0' ? 0 : 1, version);
 }
});

test('Rails retains its separate locked Zeitwerk version and rejects an unreviewed transitive loader', async () => {
 for (const version of ['2.7.5', '2.8.0']) {
  const root = await repository({ ...rails, 'Gemfile.lock': `GEM\n  specs:\n    rails (8.1.0)\n    zeitwerk (${version})\n`, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, version === '2.7.5' ? 1 : 0); assert.equal((profiles(graph)[0] as any).loaderProfile.version, version);
 }
});

test('Immutable loader aliases preserve Ruby local boundaries and reject incorrect or mutable facades', async () => {
 const sources = { ...rails, 'main.rb': 'HTMLParser.run', 'app/services/html_parser.rb': 'class HTMLParser; def self.run; end; end' };
 const valid = await repository({ ...sources, 'config/initializers/inflect.rb': 'loader = Rails.autoloaders.main\nloader.inflector.inflect("html_parser" => "HTMLParser")' }); assert.equal(targets(await index(valid)).length, 1);
 for (const setup of [
  'loader = Rails.autoloaders.main\nclass Wrapper; loader.inflector.inflect("html_parser" => "HTMLParser"); end',
  'loader = Rails.autoloaders.main\nloader = replacement\nloader.inflector.inflect("html_parser" => "HTMLParser")',
  'Rails.autoloaders.main.inflect("html_parser" => "HTMLParser")',
  'Rails.autoloaders.main.inflector.push_dir(Rails.root.join("app/services"))',
  'Rails.autoloaders.each { |loader| loader = replacement; loader.inflector.inflect("html_parser" => "HTMLParser") }',
 ]) { const root = await repository({ ...sources, 'config/initializers/inflect.rb': setup }); const graph = await index(root); assert.equal(targets(graph).length, 0, setup); assert.ok(profiles(graph)[0]?.gaps.length); }
});

test('Executable dependency DSL and reflective/path mutations cannot qualify an autoload facade', async () => {
 for (const manifest of ['def gem(*args); end; gem "rails", "8.1.0"', 'eval_gemfile "other"; gem "rails", "8.1.0"', 'registry.gem "rails", "8.1.0"']) {
  const root = await repository({ ...rails, Gemfile: manifest, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); assert.equal(targets(await index(root)).length, 0, manifest);
 }
 for (const setup of ['Rails.autoloaders.main.on_load { |name| mutate(name) }', 'Rails.autoloaders.main.instance_eval { configure }', 'config.autoload_paths.clear', 'config.root = "elsewhere"', 'def config; replacement; end']) {
  const root = await repository({ ...rails, 'config/application.rb': `module Shop; class Application < Rails::Application; ${setup}; end; end`, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 0, setup); assert.ok(profiles(graph)[0]?.gaps.length);
 }
 const root = await repository({ ...rails, 'config/initializers/paths.rb': 'module File; end; Rails.autoloaders.main.push_dir(File.join(__dir__, "../extras"))', 'main.rb': 'Extra.run', 'extras/extra.rb': 'class Extra; def self.run; end; end' }); assert.equal(targets(await index(root)).length, 0);
 for (const [declaration, expected] of [['Gem::Specification.new { |s| s.add_dependency "rails", "8.1.0" }', 1], ['registry.add_dependency "rails", "8.1.0"', 0]] as const) {
  const gemspec = await repository({ 'widget.gemspec': declaration, 'config/application.rb': rails['config/application.rb'], 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(gemspec, { apps: [{ name: 'ruby', path: '.', ecosystems: ['ruby'], frameworks: ['rails'] }] }); assert.equal(targets(graph).length, expected, declaration);
 }
});

test('Once-loader roots work before main setup but late inflections and acronyms remain visible gaps', async () => {
 const sources = { ...rails, 'config/application.rb': 'module Shop; class Application < Rails::Application; config.autoload_once_paths << Rails.root.join("once"); end; end', 'once/api_client.rb': 'class ApiClient; def self.run; end; end', 'config/initializers/use.rb': 'ApiClient.run' };
 const root = await repository(sources); assert.equal(targets(await index(root), 'config/initializers/use.rb').length, 1);
 for (const setup of ['Rails.autoloaders.once.inflector.inflect("api_client" => "ApiClient")', 'Rails.autoloaders.once.inflector = Zeitwerk::Inflector.new', 'ActiveSupport::Inflector.inflections(:en) { |inflect| inflect.acronym "API" }']) {
  const altered = await repository({ ...sources, 'config/initializers/early.rb': setup }); const graph = await index(altered); assert.equal(targets(graph, 'config/initializers/use.rb').length, 0); assert.match(profiles(graph)[0]?.gaps.join('; ') ?? '', /after once setup/);
 }
});

test('Ruby core Module mutation withholds literal autoload while unused pending loads remain lazy', async () => {
 const root = await repository({ 'main.rb': 'class Module; def autoload(*args); end; end\nmodule Shop; end; Shop.autoload :Widget, "widget"\nShop::Widget.run', 'lib/widget.rb': 'class Shop::Widget; def self.run; end; end' }); assert.equal(targets(await index(root)).length, 0);
 const lazy = await repository({ 'main.rb': 'autoload :Widget, "widget"\nclass Safe; def self.run; end; end; Safe.run', 'lib/widget.rb': 'raise "do not execute"; class Widget; end' }); const graph = await index(lazy); assert.equal(targets(graph).length, 1); assert.equal((file(graph).metadata.rubyAutoloadOutcomes as any[]).length, 0);
});

test('Autoload filename mismatch, excluded first roots and incomplete sources cannot fall back to later definitions', async () => {
 const app: ApplicationInput = { ...generic, ruby: { autoload: { version: '2.7.5', roots: [{ path: 'first' }, { path: 'second' }] } } };
 const root = await repository({ 'main.rb': 'Widget.run', 'first/widget.rb': 'class Wrong; end', 'second/widget.rb': 'class Widget; def self.run; end; end' }); assert.equal(targets(await index(root, { apps: [app] })).length, 0);
 const denied = await index(root, { apps: [app], ignore: ['first/widget.rb'] }); assert.equal(targets(denied).length, 0); assert.match(refs(denied).at(-1)?.reason ?? '', /excluded/);
 await writeFile(path.join(root, 'first/widget.rb'), 'class Widget; def self.run('); const broken = await index(root, { apps: [app] }); assert.equal(targets(broken).length, 0); assert.match(refs(broken).at(-1)?.reason ?? '', /Incomplete/);
});

test('Explicit loader ignore permits later root selection while scanner exclusions and symlink boundaries remain denied', async () => {
 const root = await repository({ 'main.rb': 'Widget.run', 'first/widget.rb': 'class Wrong; end', 'second/widget.rb': 'class Widget; def self.run; end; end' }); const app: ApplicationInput = { ...generic, ruby: { autoload: { version: '2.7.5', roots: [{ path: 'first' }, { path: 'second' }], ignore: ['first/widget.rb'] } } }; assert.equal(targets(await index(root, { apps: [app] })).length, 1);
 await symlink('../second', path.join(root, 'first/linked')); const unindexed = await index(root, { apps: [app] }); assert.equal(targets(unindexed).length, 0); assert.match(profiles(unindexed)[0]?.gaps.join('; ') ?? '', /symlink boundary/);
});

test('Rails conditional/dynamic/custom inflectors, unknown environments and namespace shadows withhold mappings', async () => {
 for (const setup of ['Rails.autoloaders.main.inflector = CustomInflector.new', 'Rails.autoloaders.main.inflector.inflect(mapping)', 'Rails.autoloaders.main.collapse(Rails.root.join("app/services")) if enabled', 'module Rails; end']) {
  const root = await repository({ ...rails, 'config/initializers/custom.rb': setup, 'main.rb': 'Widget.run', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }); const graph = await index(root); assert.equal(targets(graph).length, 0, setup); assert.ok(profiles(graph)[0]?.gaps.length);
 }
 const root = await repository({ ...rails, 'config/environments/production.rb': 'Rails.application.configure do; config.autoload_paths << Rails.root.join("extras"); end', 'main.rb': 'Extra.run', 'extras/extra.rb': 'class Extra; def self.run; end; end' }); assert.equal(targets(await index(root)).length, 0); const selected = await index(root, { apps: [{ name: 'ruby', path: '.', ecosystems: ['ruby'], ruby: { environment: 'production' } }] }); assert.equal(targets(selected).length, 1);
});

test('Ruby autoload configuration rejects malformed versions, namespaces, paths and nonliteral overrides', async () => {
 const root = await repository({ 'main.rb': '' }); for (const autoload of [{ version: 'latest' }, { roots: [{ path: '/tmp' }] }, { roots: [{ path: '../outside' }] }, { roots: [{ path: 'lib', namespace: 'api' }] }, { inflections: { user: 'Api::User' } }, { collapse: ['lib/*'] }, { roots: 'lib' }]) await assert.rejects(resolveConfig(root, { applications: [{ name: 'ruby', path: '.', ruby: { autoload: autoload as any } }] }));
});

test('Autoload cache replay preserves original ranges and invalidates inflector, root and lockfile changes', async () => {
 const root = await repository({ ...rails, 'main.rb': '# 😀\r\nWidget.run\r\n', 'app/models/widget.rb': 'class Widget; def self.run; end; end' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-autoload-cache-')); roots.push(state);
 const cold = await index(root, { cache: new AnalysisCache(state) }), warm = await index(root, { cache: new AnalysisCache(state) }), revision = await index(root, { revision: 'pinned' }); assert.equal(shape(cold), shape(warm)); assert.equal(shape(cold), shape(revision)); assert.equal(calls(cold).at(-1)?.range.startLine, 2);
 await mkdir(path.join(root, 'config/initializers'), { recursive: true }); await writeFile(path.join(root, 'config/initializers/inflect.rb'), 'Rails.autoloaders.main.inflector.inflect("widget" => "Other")'); const changed = await index(root, { cache: new AnalysisCache(state) }); assert.equal(targets(changed).length, 0);
 await writeFile(path.join(root, 'Gemfile.lock'), 'GEM\n  specs:\n    rails (9.0.0)\n'); const locked = await index(root, { cache: new AnalysisCache(state) }); assert.equal(targets(locked).length, 0); assert.ok(profiles(locked)[0]?.gaps.length);
 const alternate = await repository({ 'main.rb': 'Widget.run', 'lib/widget.rb': 'class Widget; def self.run; end; end', 'extras/widget.rb': 'class Widget; def self.run; end; end' });
 const first = await index(alternate, { apps: [generic], cache: new AnalysisCache(state) }); assert.equal(targets(first)[0]?.path, 'lib/widget.rb');
 const app = { ...generic, ruby: { autoload: { version: '2.7.5', roots: [{ path: 'extras' }] } } };
 const moved = await index(alternate, { apps: [app], cache: new AnalysisCache(state) }); assert.equal(targets(moved)[0]?.path, 'extras/widget.rb');
 const ignored = await index(alternate, { apps: [{ ...app, ruby: { autoload: { ...app.ruby.autoload, ignore: ['extras/widget.rb'] } } }], cache: new AnalysisCache(state) }); assert.equal(targets(ignored).length, 0);
});
