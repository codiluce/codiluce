import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { compileWerkzeugPath, matchRoutePattern } from '../src/analysis/routes/contracts.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-flask-')); temporary.push(root);
  for (const [file, content] of Object.entries({ 'requirements.txt': 'Flask==3.1.2\n', ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string, applications: ApplicationInput[] = [{ name: 'api', path: '.', frameworks: ['flask'] }]) {
  const config = await resolveConfig(root, { repository: { name: 'flask' }, applications }); return indexRepository(root, { config, cache, revision });
}
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'api_endpoint' && item.metadata.framework === 'flask' && !item.metadata.frameworkResource);
const views = (graph: SoftwareGraph) => endpoints(graph).filter(item => !item.metadata.automaticResponse);
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Flask imported blueprint aliases, nested prefixes and registration overrides preserve exact handlers', async () => {
  const root = await repository({
    'main.py': 'from flask import Flask as Make\nfrom shop import bp\napp = Make(__name__)\napp.register_blueprint(bp, url_prefix="/v1", name="one")\napp.register_blueprint(bp, url_prefix="/v2", name="two")\n',
    'shop/__init__.py': 'from .routes import bp\n',
    'shop/routes.py': 'from flask import Blueprint as BP\nfrom .handlers import leaf as handler\nchild = BP("items", __name__, url_prefix="/old")\nchild.add_url_rule("/<int:id>", "detail", handler, methods=["get", "POST"])\nbp = BP("shop", __name__, url_prefix="/ignored")\nbp.register_blueprint(child, url_prefix="/items")\n',
    'shop/handlers.py': 'def helper():\n    return 1\ndef leaf():\n    return helper()\n',
  });
  const graph = await index(root);
  assert.deepEqual(views(graph).map(item => item.name).sort(), ['GET /v1/items/<int:id>', 'GET /v2/items/<int:id>']);
  for (const endpoint of endpoints(graph)) assert.equal(endpoint.metadata.constraintsUnresolved, undefined, endpoint.name);
  for (const endpoint of views(graph)) { assert.deepEqual((endpoint.metadata.routing as any).methods, ['GET', 'POST', 'HEAD']); assert.equal((endpoint.metadata.routing as any).mounts.length, 2); }
  assert.deepEqual(views(graph).map(item => item.metadata.endpointName).sort(), ['one.items.detail', 'two.items.detail']);
  const leaf = graph.entities.find(item => item.name === 'leaf')!, helper = graph.entities.find(item => item.name === 'helper')!;
  assert.equal(graph.relations.filter(item => item.type === 'handles' && item.to === leaf.id).length, 2);
  assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === leaf.id && item.to === helper.id));
});

test('Flask distinguishes GET/HEAD execution from automatic OPTIONS, explicit OPTIONS and disabled automatic responses', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask\napp = Flask(__name__)\n@app.route("/default")\ndef default():\n    return 1\n@app.route("/explicit", methods=["OPTIONS"])\ndef options():\n    return 2\n@app.post("/post", provide_automatic_options=False)\ndef post():\n    return 3\n@app.route("/forced", methods=["OPTIONS"], provide_automatic_options=True)\ndef forced():\n    return 4\n' });
  const graph = await index(root), generated = endpoints(graph).filter(item => item.metadata.automaticResponse);
  assert.deepEqual(generated.map(item => item.name).sort(), ['OPTIONS /default', 'OPTIONS /forced']);
  assert.ok(generated.every(item => !graph.relations.some(edge => edge.from === item.id && edge.type === 'handles')));
  assert.deepEqual((views(graph).find(item => item.name === 'GET /default')!.metadata.routing as any).methods, ['GET', 'HEAD']);
  assert.ok(views(graph).some(item => item.name === 'OPTIONS /explicit'));
  assert.ok(views(graph).some(item => item.name === 'POST /post'));
  assert.equal(views(graph).some(item => item.metadata.routePath === '/forced'), false);
});

test('Flask invoked factories and registration helper parameters expose only reachable applications', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask, Blueprint\ndef register(app, prefix="/health"):\n    @app.get(prefix)\n    def health():\n        return 1\ndef create_app():\n    app = Flask(__name__)\n    register(app)\n    return app\napp = create_app()\ndef unused():\n    app = Flask(__name__)\n    @app.get("/unused")\n    def hidden():\n        return 0\n    return app\nbp = Blueprint("private", __name__)\n@bp.get("/private")\ndef private():\n    return 0\n' });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name), ['GET /health']);
  assert.ok(graph.relations.some(item => item.type === 'handles' && graph.entities.find(entity => entity.id === item.to)?.metadata.qualifiedName === 'register.health'));
});

test('Flask configured CLI entrypoints select indexed zero-argument factories and invalidate caches', async () => {
  const root = await repository({ 'shop/__init__.py': 'from flask import Flask\ndef create_app():\n    app = Flask(__name__)\n    @app.get("/factory")\n    def factory():\n        return 1\n    return app\n' }), cache = new AnalysisCache(path.join(root, '.cache'));
  assert.equal(endpoints(await index(root, cache)).length, 0);
  const applications: ApplicationInput[] = [{ name: 'api', path: '.', frameworks: ['flask'], entrypoints: { flask: ['shop:create_app'] } }];
  const graph = await index(root, cache, undefined, applications); assert.deepEqual(views(graph).map(item => item.name), ['GET /factory']);
  assert.equal(stored(await index(root, cache, undefined, applications)), stored(graph));
  const missing = await index(root, undefined, undefined, [{ ...applications[0]!, entrypoints: { flask: ['shop:missing'] } }]);
  assert.equal(endpoints(missing).length, 0); assert.ok(missing.diagnostics.some(item => item.code === 'flask-entrypoint-unresolved'));
  for (const invalid of ['shop:create_app()', '../shop:app', 'shop:app;bad']) await assert.rejects(resolveConfig(root, { applications: [{ ...applications[0]!, entrypoints: { flask: [invalid] } }] }), /entrypoints/);
});

test('Flask MethodView resolves per-method handlers and HEAD fallback without assigning automatic OPTIONS to methods', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask\nfrom flask.views import MethodView as MV, View\nclass Items(MV):\n    def get(self, id):\n        return id\n    def post(self, id):\n        return id\nclass Other(View):\n    methods = ["PUT"]\n    def dispatch_request(self):\n        return 1\napp = Flask(__name__)\napp.add_url_rule("/items/<int:id>", view_func=Items.as_view("items"))\napp.add_url_rule("/other", view_func=Other.as_view("other"))\n' });
  const graph = await index(root);
  assert.deepEqual(views(graph).map(item => item.name).sort(), ['GET /items/<int:id>', 'HEAD /items/<int:id>', 'POST /items/<int:id>', 'PUT /other']);
  for (const endpoint of endpoints(graph)) assert.equal(endpoint.metadata.constraintsUnresolved, undefined, endpoint.name);
  const handler = (name: string) => graph.entities.find(item => item.id === graph.relations.find(edge => edge.from === views(graph).find(item => item.name === name)!.id && edge.type === 'handles')!.to)!.metadata.qualifiedName;
  assert.equal(handler('GET /items/<int:id>'), 'Items.get'); assert.equal(handler('HEAD /items/<int:id>'), 'Items.get'); assert.equal(handler('POST /items/<int:id>'), 'Items.post'); assert.equal(handler('PUT /other'), 'Other.dispatch_request');
});

test('Flask endpoint bindings and decorator order preserve registered functions but constrain custom view wrappers', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask\napp = Flask(__name__)\napp.add_url_rule("/late", endpoint="late")\n@app.endpoint("late")\ndef late():\n    return 1\n@custom\n@app.get("/original")\ndef original():\n    return 2\n@app.get("/wrapped")\n@custom\ndef wrapped():\n    return 3\n' });
  const graph = await index(root), handles = (name: string) => graph.relations.filter(item => item.type === 'handles' && item.from === views(graph).find(item => item.name === name)!.id);
  assert.equal(handles('GET /late').length, 1); assert.equal(handles('GET /original').length, 1); assert.equal(handles('GET /wrapped').length, 0);
  assert.ok(views(graph).find(item => item.name === 'GET /wrapped')!.metadata.constraintsUnresolved);
});

test('Flask seals blueprint setup at app registration and rejects duplicate names while preserving early candidates', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask, Blueprint\napp = Flask(__name__)\nbp = Blueprint("bp", __name__)\n@bp.get("/early")\ndef early():\n    return 1\napp.register_blueprint(bp, url_prefix="/one")\n@bp.get("/late")\ndef late():\n    return 2\napp.register_blueprint(bp, url_prefix="/two")\n' });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name), ['GET /one/early']);
  assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved));
  assert.ok(graph.diagnostics.some(item => item.code === 'flask-late-blueprint-setup')); assert.ok(graph.diagnostics.some(item => item.code === 'flask-blueprint-name-collision'));
});

test('Flask local lookalikes, excluded modules, type-only imports and overwritten receivers cannot prove routes', async () => {
  for (const source of [
    'class Flask:\n    pass\napp = Flask()\n@app.get("/fake")\ndef fake():\n    pass\n',
    'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from flask import Flask\napp = Flask(__name__)\n@app.get("/fake")\ndef fake():\n    pass\n',
    'from flask import Flask\napp = Flask(__name__)\napp = other\n@app.get("/fake")\ndef fake():\n    pass\n',
  ]) assert.equal(endpoints(await index(await repository({ 'main.py': source }))).length, 0);
  for (const body of ['class Flask:\n    pass\n', '# opaque\n'.repeat(200_000)]) {
    const root = await repository({ 'flask.py': body, 'main.py': 'from flask import Flask\napp = Flask(__name__)\n@app.get("/fake")\ndef fake():\n    pass\n' }); assert.equal(endpoints(await index(root)).length, 0);
  }
});

test('Werkzeug built-ins preserve literal braces, case, slash and numeric converter semantics', () => {
  const rule = compileWerkzeugPath('/Items/<int:id>/');
  assert.ok(matchRoutePattern(rule, '/Items/12/')); assert.equal(matchRoutePattern(rule, '/items/12/'), false); assert.equal(matchRoutePattern(rule, '/Items/12'), false); assert.equal(matchRoutePattern(rule, '/Items/-1/'), false);
  assert.ok(matchRoutePattern(compileWerkzeugPath('/<float:n>'), '/1.2')); assert.equal(matchRoutePattern(compileWerkzeugPath('/<float:n>'), '/1'), false);
  assert.ok(matchRoutePattern(compileWerkzeugPath('/files/<path:p>'), '/files/a/b')); assert.equal(matchRoutePattern(compileWerkzeugPath('/files/<path:p>'), '/files/'), false);
  assert.ok(matchRoutePattern(compileWerkzeugPath('/<uuid:id>'), '/123e4567-e89b-12d3-a456-426614174000'));
  assert.ok(matchRoutePattern(compileWerkzeugPath('/literal/{id}'), '/literal/{id}')); assert.equal(matchRoutePattern(compileWerkzeugPath('/literal/{id}'), '/literal/value'), false);
  for (const path of ['/<int(min=1):id>', '/<any(a,b):id>', '/<custom:id>', '/file-<path:p>']) assert.equal(compileWerkzeugPath(path).status, 'partial');
  assert.ok(matchRoutePattern(compileWerkzeugPath('/loose/', false), '/loose')); assert.ok(matchRoutePattern(compileWerkzeugPath('/loose/', false), '/loose/'));
});

test('Flask dynamic configuration, rules, methods, receiver mutations and includes remain constrained', async () => {
  for (const mutation of ['app.url_map = other', 'app.config.from_object(Settings)', 'app.register_blueprint(unknown)']) {
    const root = await repository({ 'main.py': `from flask import Flask\napp = Flask(__name__)\n${mutation}\n@app.get("/one")\ndef one():\n    return 1\n` }); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved), mutation);
  }
  const root = await repository({ 'main.py': 'from flask import Flask\napp = Flask(__name__)\n@app.route(rule, methods=methods)\ndef dynamic():\n    return 1\nif flag:\n    @app.get("/conditional")\n    def conditional():\n        return 2\n@app.route("/<custom:id>")\ndef custom():\n    return 3\n' });
  assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
});

test('Flask literal automatic OPTIONS configuration is applied at blueprint registration', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask, Blueprint\nbp = Blueprint("bp", __name__)\n@bp.get("/one")\ndef one():\n    return 1\napp = Flask(__name__)\napp.config.from_mapping(PROVIDE_AUTOMATIC_OPTIONS=False)\napp.register_blueprint(bp)\n@app.get("/two")\ndef two():\n    return 2\n' });
  const graph = await index(root); assert.deepEqual(endpoints(graph).map(item => item.name).sort(), ['GET /one', 'GET /two']); assert.ok(endpoints(graph).every(item => !item.metadata.constraintsUnresolved));
});

test('TS frontend matches a Flask endpoint through a configured origin and blocks opaque competing rules', async () => {
  const source = 'from flask import Flask\napp = Flask(__name__)\n@app.get("/items/<int:id>")\ndef item():\n    return 1\n';
  const root = await repository({ 'api/main.py': source, 'api/requirements.txt': 'Flask==3.1.2\n', 'web/package.json': '{"dependencies":{"next":"^16.0.0"}}', 'web/client.ts': 'export function load() { return fetch("https://api.example/items/12"); }' });
  const applications: ApplicationInput[] = [{ name: 'api', path: 'api', frameworks: ['flask'], apiOrigins: ['https://api.example'] }, { name: 'web', path: 'web', frameworks: ['nextjs'] }];
  const graph = await index(root, undefined, undefined, applications); assert.equal(graph.relations.filter(item => item.type === 'requests').length, 1);
  await writeFile(path.join(root, 'api/main.py'), `${source}\n@app.get(rule)\ndef dynamic():\n    return 1\n`);
  const ambiguous = await index(root, undefined, undefined, applications); assert.equal(ambiguous.relations.filter(item => item.type === 'requests').length, 0); assert.ok(ambiguous.diagnostics.some(item => item.code === 'ambiguous-http-match'));
});

test('Flask factory instances, cache/revision replay and line insertion keep registration identities stable', async () => {
  const source = 'from flask import Flask\ndef make():\n    app = Flask(__name__)\n    @app.get("/one")\n    def one():\n        return 1\n    return app\na = make()\nb = make()\n';
  const root = await repository({ 'main.py': source }), cache = new AnalysisCache(path.join(root, '.cache')), cold = await index(root, cache);
  assert.equal(views(cold).length, 2); assert.equal(stored(await index(root, cache)), stored(cold)); assert.equal(stored(await index(root, undefined, 'fixture-revision')), stored(cold));
  assert.ok(cache.events.some(event => event.analyzer === 'python-imports' && event.hit));
  await writeFile(path.join(root, 'main.py'), `# moved\n\n${source}`);
  const moved = await index(root, cache); assert.deepEqual(endpoints(moved).map(item => item.id).sort(), endpoints(cold).map(item => item.id).sort()); assert.equal(stored(moved), stored(await index(root)));
});

test('Flask unknown version ranges and custom MethodView dispatch are explicit gaps', async () => {
  const root = await repository({ 'requirements.txt': 'Flask>=2.0\n', 'main.py': 'from flask import Flask\nfrom flask.views import MethodView\nclass Items(MethodView):\n    def get(self):\n        return 1\n    def dispatch_request(self):\n        return 2\napp = Flask(__name__)\napp.add_url_rule("/one", view_func=Items.as_view("items"))\n' });
  const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved)); assert.ok(graph.diagnostics.some(item => item.code === 'flask-version-profile'));
  assert.equal(graph.relations.filter(item => item.type === 'handles' && endpoints(graph).some(endpoint => endpoint.id === item.from)).length, 0);
});

test('Flask static resources retain competing candidates and explicit constructor disabling removes them', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask, Blueprint\napp = Flask(__name__, static_url_path="/assets")\nbp = Blueprint("bp", __name__, "public", "/resources", "/api")\napp.register_blueprint(bp)\n@app.get("/assets/<path:filename>")\ndef asset():\n    return 1\n' });
  const graph = await index(root), resources = graph.entities.filter(item => item.metadata.frameworkResource && !item.metadata.automaticResponse);
  assert.deepEqual(resources.map(item => item.name).sort(), ['GET /api/resources/<path:filename>', 'GET /assets/<path:filename>']);
  assert.ok(resources.every(item => item.metadata.constraintsUnresolved));
  assert.ok(resources.every(item => !graph.relations.some(edge => edge.from === item.id && edge.type === 'handles')));
  const disabled = await repository({ 'main.py': 'from flask import Flask\napp = Flask(__name__, static_folder=None)\n@app.get("/one")\ndef one():\n    return 1\n' });
  assert.equal((await index(disabled)).entities.filter(item => item.metadata.frameworkResource).length, 0);
});

test('Flask view attribute mutations through imported aliases retain unknown method competitors', async () => {
  const root = await repository({ 'handlers.py': 'def leaf():\n    return 1\n', 'main.py': 'from flask import Flask\nfrom handlers import leaf as alias\nalias.methods = ["POST"]\napp = Flask(__name__)\napp.add_url_rule("/one", view_func=alias)\n' });
  const endpoint = views(await index(root))[0]!;
  assert.equal((endpoint.metadata.routing as any).methods, '*'); assert.equal(endpoint.metadata.constraintsUnresolved, true);
  const mutated = await repository({ 'views.py': 'from flask.views import MethodView\nclass Items(MethodView):\n    def get(self):\n        return 1\n', 'main.py': 'from flask import Flask\nfrom views import Items as Alias\nAlias.get = other\napp = Flask(__name__)\napp.add_url_rule("/one", view_func=Alias.as_view("items"))\n' });
  const graph = await index(mutated); assert.ok(views(graph).every(item => item.metadata.constraintsUnresolved));
  assert.equal(graph.relations.filter(item => item.type === 'handles' && views(graph).some(endpoint => endpoint.id === item.from)).length, 0);
});

test('Flask hooks retain blueprint scope and unknown extension registration constrains application routes', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask, Blueprint\napp = Flask(__name__)\nbp = Blueprint("bp", __name__)\n@bp.before_request\ndef scoped():\n    return None\n@bp.before_app_request\ndef global_hook():\n    return None\n@bp.get("/inside")\ndef inside():\n    return 1\napp.register_blueprint(bp)\n@app.get("/outside")\ndef outside():\n    return 1\n' });
  const graph = await index(root), refs = (name: string) => graph.relations.filter(item => item.type === 'references' && item.from === views(graph).find(item => item.name === name)!.id && item.metadata?.framework === 'flask').map(item => graph.entities.find(entity => entity.id === item.to)!.name).sort();
  assert.deepEqual(refs('GET /inside'), ['global_hook', 'scoped']); assert.deepEqual(refs('GET /outside'), ['global_hook']);
  const opaque = await repository({ 'main.py': 'from flask import Flask\nfrom extension import init_app\napp = Flask(__name__)\ninit_app(app)\n@app.get("/one")\ndef one():\n    return 1\n' });
  const constrained = await index(opaque); assert.ok(endpoints(constrained).every(item => item.metadata.constraintsUnresolved)); assert.ok(constrained.diagnostics.some(item => item.code === 'flask-opaque-registration-call'));
});

test('Flask explicit entrypoints select deployment roots and required factory arguments are not fabricated', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask\nunused = Flask(__name__)\n@unused.get("/unused")\ndef unused_view():\n    return 1\ndef make(required):\n    return Flask(__name__)\ndef create_app():\n    app = Flask(__name__)\n    @app.get("/selected")\n    def selected():\n        return 1\n    return app\n' });
  const applications: ApplicationInput[] = [{ name: 'api', path: '.', entrypoints: { flask: ['main:create_app'] } }];
  const graph = await index(root, undefined, undefined, applications); assert.deepEqual(views(graph).map(item => item.name), ['GET /selected']);
  assert.equal(views(graph)[0]!.metadata.configuredEntrypoint, 'main:create_app'); assert.ok(views(graph)[0]!.evidence.some(item => item.explanation?.includes('Configured Flask entrypoint')));
  const required = await index(root, undefined, undefined, [{ ...applications[0]!, entrypoints: { flask: ['main:make'] } }]); assert.equal(endpoints(required).length, 0); assert.ok(required.diagnostics.some(item => item.code === 'flask-factory-arguments'));
});

test('Python comments in factory parameters, calls and method lists do not become registration arguments', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask\ndef create_app(\n    # optional factory parameter\n    prefix="/comments",\n):\n    app = Flask(\n        # application import name\n        __name__,\n        static_folder=None,\n    )\n    app.config.from_mapping(\n        # framework configuration\n        PROVIDE_AUTOMATIC_OPTIONS=False,\n    )\n    @app.route(\n        # bound rule\n        prefix,\n        methods=[\n            "GET", # execution method\n            "POST",\n        ],\n    )\n    def comments():\n        return 1\n    return app\napp = create_app()\n' });
  const graph = await index(root); assert.deepEqual(endpoints(graph).map(item => item.name), ['GET /comments']);
  assert.deepEqual((views(graph)[0]!.metadata.routing as any).methods, ['GET', 'POST', 'HEAD']); assert.equal(views(graph)[0]!.metadata.constraintsUnresolved, undefined);
});

test('Flask invoked helper mutations invalidate receivers while unused factory mutations stay private', async () => {
  const source = 'from flask import Flask\napp = Flask(__name__)\ndef mutate(receiver):\n    receiver.url_map = other\ndef unused():\n    app = Flask(__name__)\n    app.url_map = other\n    return app\n@app.get("/one")\ndef one():\n    return 1\n';
  const root = await repository({ 'main.py': source }); assert.equal(views(await index(root))[0]!.metadata.constraintsUnresolved, undefined);
  await writeFile(path.join(root, 'main.py'), `${source}\nmutate(app)\n`);
  const mutated = await index(root); assert.ok(endpoints(mutated).every(item => item.metadata.constraintsUnresolved)); assert.ok(mutated.diagnostics.some(item => item.code === 'flask-receiver-mutation'));
});

test('Flask unbounded helper arguments, unknown views and redirect-only rules cannot establish unique handler execution', async () => {
  const root = await repository({ 'main.py': 'from flask import Flask\napp = Flask(__name__)\ndef register(app, **options):\n    app.add_url_rule("/hidden", view_func=unknown)\nregister(app, **options)\ndef handler():\n    return 1\napp.add_url_rule("/redirect", view_func=handler, redirect_to="/other")\napp.add_url_rule("/unknown", view_func=dynamic)\n' });
  const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved));
  const redirect = views(graph).find(item => item.metadata.routePath === '/redirect')!; assert.equal(graph.relations.some(item => item.type === 'handles' && item.from === redirect.id), false);
  const unknown = views(graph).find(item => item.metadata.routePath === '/unknown')!; assert.equal((unknown.metadata.routing as any).methods, '*'); assert.ok(graph.diagnostics.some(item => item.code === 'flask-opaque-registration-call'));
});

test('Flask invalid registration keywords, shortcut methods and missing import names remain constrained', async () => {
  for (const source of [
    'app = Flask()\n@app.get("/one")\ndef one():\n    return 1\n',
    'app = Flask(__name__, unsupported=True)\n@app.get("/one")\ndef one():\n    return 1\n',
    'app = Flask(__name__)\n@app.get("/one", methods=["POST"])\ndef one():\n    return 1\n',
    'app = Flask(__name__)\n@app.route("/one", unsupported=True)\ndef one():\n    return 1\n',
  ]) {
    const graph = await index(await repository({ 'main.py': `from flask import Flask\n${source}` })); assert.ok(endpoints(graph).length); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved));
  }
});

test('Flask shared factory source keeps each invoking application as the deployment owner', async () => {
  const root = await repository({
    'shared/requirements.txt': 'Flask==3.1.2\n',
    'shared/factory.py': 'from flask import Flask\ndef make():\n    app = Flask(__name__, static_folder=None)\n    @app.get("/one")\n    def one():\n        return 1\n    return app\n',
    'first/main.py': 'from factory import make\napp = make()\n', 'second/main.py': 'from factory import make\napp = make()\n',
  });
  const applications: ApplicationInput[] = [{ name: 'first', path: 'first', sourceRoots: { python: ['.', '../shared'] } }, { name: 'second', path: 'second', sourceRoots: { python: ['.', '../shared'] } }, { name: 'shared', path: 'shared' }];
  const graph = await index(root, undefined, undefined, applications), selected = views(graph);
  assert.equal(selected.length, 2); assert.deepEqual(selected.map(item => graph.entities.find(entity => entity.id === item.parentId)!.name).sort(), ['first', 'second']);
  assert.ok(selected.every(item => item.path === 'shared/factory.py' && !item.metadata.constraintsUnresolved)); assert.equal(new Set(selected.map(item => item.id)).size, 2);
});

test('Flask factory binding honors positional-only and keyword-only parameters and rejects duplicate arguments', async () => {
  const source = 'from flask import Flask\ndef make(prefix, /, *, suffix="/one"):\n    app = Flask(__name__)\n    @app.get(suffix)\n    def one():\n        return 1\n    return app\n';
  const root = await repository({ 'main.py': `${source}\napp = make("p", suffix="/valid")\n` }); assert.deepEqual(views(await index(root)).map(item => item.name), ['GET /valid']);
  for (const invocation of ['make(prefix="p")', 'make("p", "/invalid")', 'make("p", suffix="/a", suffix="/b")']) {
    await writeFile(path.join(root, 'main.py'), `${source}\napp = ${invocation}\n`);
    const graph = await index(root); assert.equal(endpoints(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'flask-factory-arguments'));
  }
});
