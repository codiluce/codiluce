// Portable ordinary compiled qualification of the original assertions in
// tests/rails-callback-chain.test.ts; no target Ruby/application code runs.
import assert from 'node:assert/strict';
import { after, test as registerTest } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const sourceRoot = new URL(process.argv[2]);
assert.equal(sourceRoot.protocol, 'file:');
assert.ok(sourceRoot.pathname.endsWith('/'));
const completedCases = [];
function test(name, execute) {
    return registerTest(name, async () => {
        await execute();
        completedCases.push(name);
    });
}
const { indexRepository } = await import(new URL('pipeline/index.js', sourceRoot));
const { resolveConfig } = await import(new URL('core/config.js', sourceRoot));
const { AnalysisCache } = await import(new URL('pipeline/cache.js', sourceRoot));
const { canonicalJson } = await import(new URL('history/fingerprint.js', sourceRoot));
const roots = [];
after(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
    assert.equal(completedCases.length, 10, 'All original callback-chain cases must pass');
    const record = {schema:1,passed:true,sourceRoot:sourceRoot.href,completedCases,caseCount:completedCases.length,
        targetExecution:false,typescriptSourceLoader:false,
        scope:'Original Rails symbol callback replacement, kind/position, initialized skip identity, merged action groups, mandatory/optional initialization checks, conditional candidates, string refusal and complete cache invalidation assertions under the supplied ordinary compiled source root.'};
    if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(record,null,2)+'\n');
    console.log(JSON.stringify(record));
});
async function repository(parent, child, version = '8.1.1') {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rails-callback-chain-'));
    roots.push(root);
    const files = {
        Gemfile: `gem "rails", "${version}"`,
        'config/application.rb': 'module Shop; class Application < Rails::Application; end; end',
        'config/routes.rb': 'Rails.application.routes.draw do\n get "show", to: "photos#show"\n get "index", to: "photos#index"\nend',
        'app/controllers/application_controller.rb': `class ApplicationController < ActionController::Base\n${parent}\nprivate\ndef audit; end\ndef prepare; end\nend`,
        'app/controllers/photos_controller.rb': `class PhotosController < ApplicationController\n${child}\ndef show; end\ndef index; end\nend`,
    };
    for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
    }
    return root;
}
async function index(root, cache) {
    return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'callback-chain' }, applications: [{ name: 'server', path: '.', ecosystems: ['ruby'] }] }), cache });
}
function outcome(graph, action) {
    const endpoint = graph.entities.find(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'rails' && entity.metadata.action === action);
    assert.ok(endpoint, action);
    const handler = graph.entities.find(entity => entity.id === graph.relations.find(relation => relation.type === 'handles' && relation.from === endpoint.id)?.to);
    const callbacks = graph.relations.filter(relation => relation.from === handler?.id && relation.type === 'references' && relation.metadata?.role === 'action_callback' && relation.metadata?.endpoint === endpoint.id).sort((a, b) => Number(a.metadata?.order) - Number(b.metadata?.order));
    return { endpoint, handler, callbacks, names: callbacks.map(relation => graph.entities.find(entity => entity.id === relation.to).name) };
}
const shape = (graph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['indexer', 'git-metrics'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
test('Rails symbolic replacement removes the prior callback before selecting an action', async () => {
    for (const version of ['7.1.0', '7.2.0', '8.0.0', '8.1.1']) {
        const root = await repository('before_action :audit, only: :show', 'before_action :audit, only: :index', version), graph = await index(root);
        assert.ok(outcome(graph, 'show').handler, version);
        assert.ok(outcome(graph, 'index').handler, version);
        assert.deepEqual(outcome(graph, 'show').names, [], version);
        assert.deepEqual(outcome(graph, 'index').names, ['audit'], version);
        assert.equal(outcome(graph, 'index').callbacks[0].evidence[0].file, 'app/controllers/photos_controller.rb');
    }
});
test('Rails replacement of one callback kind preserves other kinds and final chain positions', async () => {
    const root = await repository('before_action :audit\nafter_action :audit\nbefore_action :prepare', 'prepend_before_action :audit, except: :show'), graph = await index(root);
    assert.deepEqual(outcome(graph, 'show').names, ['audit', 'prepare']);
    assert.deepEqual(outcome(graph, 'show').callbacks.map(item => item.metadata?.kind), ['after', 'before']);
    assert.deepEqual(outcome(graph, 'index').names, ['audit', 'audit', 'prepare']);
    assert.deepEqual(outcome(graph, 'index').callbacks.map(item => item.metadata?.kind), ['before', 'after', 'before']);
    assert.ok(!graph.relations.some(item => item.type === 'calls' && ['audit', 'prepare'].includes(graph.entities.find(entity => entity.id === item.to)?.name ?? '')));
});
test('Rails skip validates the initialized callback even when its action filter excludes the current action', async () => {
    const root = await repository('before_action :audit, only: :show', 'skip_before_action :audit, only: :index'), graph = await index(root);
    assert.ok(outcome(graph, 'show').handler);
    assert.ok(outcome(graph, 'index').handler);
    assert.deepEqual(outcome(graph, 'show').names, ['audit']);
    assert.deepEqual(outcome(graph, 'index').names, []);
    assert.ok(!graph.diagnostics.some(item => /Skipping/.test(item.reason)));
});
test('Rails filtered skips preserve chain identity for later skips and replacement', async () => {
    const root = await repository('before_action :audit', 'skip_before_action :audit, only: :show\nskip_before_action :audit, only: :show\nskip_before_action :audit, only: :index\nbefore_action :audit, only: :show'), graph = await index(root);
    assert.ok(outcome(graph, 'show').handler);
    assert.ok(outcome(graph, 'index').handler);
    assert.deepEqual(outcome(graph, 'show').names, ['audit']);
    assert.deepEqual(outcome(graph, 'index').names, []);
});
test('Rails skips merge only and except predicate groups independently', async () => {
    const graph = await index(await repository('before_action :audit', 'skip_before_action :audit, only: :index, except: :index'));
    assert.ok(outcome(graph, 'show').handler);
    assert.ok(outcome(graph, 'index').handler);
    assert.deepEqual(outcome(graph, 'show').names, []);
    assert.deepEqual(outcome(graph, 'index').names, []);
});
test('Rails mandatory missing skips fail initialization before action or invocation predicates', async () => {
    for (const options of ['only: :index', 'except: :show', 'if: :enabled?', 'only: :index, if: :enabled?']) {
        const graph = await index(await repository('', `skip_before_action :absent, ${options}`));
        assert.equal(outcome(graph, 'show').handler, undefined, options);
        assert.equal(outcome(graph, 'index').handler, undefined, options);
        assert.ok(graph.diagnostics.some(item => /Skipping/.test(item.reason)), options);
    }
    for (const raise of ['false', 'nil']) {
        const optional = await index(await repository('', `skip_before_action :absent, only: :index, raise: ${raise}`));
        assert.ok(outcome(optional, 'show').handler);
        assert.ok(outcome(optional, 'index').handler);
    }
    const truthy = await index(await repository('', 'skip_before_action :absent, only: :index, raise: 0'));
    assert.equal(outcome(truthy, 'show').handler, undefined);
    assert.equal(outcome(truthy, 'index').handler, undefined);
});
test('Rails conditionally initialized callbacks retain possible skip failures as conditions', async () => {
    const graph = await index(await repository('if enabled\n before_action :audit\nend', 'skip_before_action :audit'));
    for (const action of ['show', 'index']) {
        const result = outcome(graph, action);
        assert.ok(result.handler);
        assert.deepEqual(result.names, []);
        assert.ok(result.endpoint.metadata.routing.conditions.some(reason => /Skipping a conditionally registered callback/.test(reason)));
    }
});
test('Rails conditional replacement leaves prior action callbacks as guarded candidates', async () => {
    const graph = await index(await repository('before_action :audit, only: :show', 'if enabled\n before_action :audit, only: :index\nend'));
    const show = outcome(graph, 'show'), listing = outcome(graph, 'index');
    assert.deepEqual(show.names, ['audit']);
    assert.deepEqual(listing.names, ['audit']);
    assert.ok(show.callbacks.every(item => (item.metadata?.conditions).some(reason => /Conditional callback replacement/.test(reason))));
    assert.ok(listing.callbacks.every(item => (item.metadata?.conditions).some(reason => /Conditional callback declaration/.test(reason))));
});
test('Rails string callback registration cannot claim initialized original actions', async () => {
    const graph = await index(await repository('before_action "audit", only: :index', ''));
    assert.equal(outcome(graph, 'show').handler, undefined);
    assert.equal(outcome(graph, 'index').handler, undefined);
    assert.ok(graph.diagnostics.some(item => /string callback/i.test(item.reason)));
});
test('Rails callback replacement and skip edits invalidate the complete cached graph', async () => {
    const root = await repository('before_action :audit, only: :show', 'before_action :audit, only: :index'), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rails-callback-cache-'));
    roots.push(state);
    const cold = await index(root, new AnalysisCache(state)), warm = await index(root, new AnalysisCache(state));
    assert.equal(shape(cold), shape(warm));
    assert.deepEqual(outcome(warm, 'show').names, []);
    await writeFile(path.join(root, 'app/controllers/photos_controller.rb'), 'class PhotosController < ApplicationController\nskip_before_action :audit\ndef show; end\ndef index; end\nend');
    const edited = await index(root, new AnalysisCache(state)), fresh = await index(root);
    assert.equal(shape(edited), shape(fresh));
    assert.deepEqual(outcome(edited, 'show').names, []);
    assert.deepEqual(outcome(edited, 'index').names, []);
    assert.ok(outcome(edited, 'show').handler);
    assert.ok(outcome(edited, 'index').handler);
});
