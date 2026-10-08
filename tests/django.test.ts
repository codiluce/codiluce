import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { indexRepository } from '../src/pipeline/index.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { compileDjangoPath, djangoRegexRoute, matchRoutePattern } from '../src/analysis/routes/contracts.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-django-')); temporary.push(root);
  for (const [file, content] of Object.entries({ 'requirements.txt': 'Django==5.2.7\n', 'settings.py': 'ROOT_URLCONF = "urls"\n', ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string, applications: ApplicationInput[] = [{ name: 'api', path: '.', frameworks: ['django'] }]) {
  const config = await resolveConfig(root, { repository: { name: 'django' }, applications }); return indexRepository(root, { config, cache, revision });
}
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(item => item.type === 'api_endpoint' && item.metadata.framework === 'django');
const views = (graph: SoftwareGraph) => endpoints(graph).filter(item => !item.metadata.automaticResponse);
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Django composes aliases, imported and inline includes, namespace tuples and exact function views', async () => {
  const root = await repository({
    'urls.py': 'from django.urls import path as route, include as nested\nfrom shop import urls as shop\nurlpatterns = [\n    route("v1/", nested(shop, namespace="one")),\n    route("v2/", nested((shop, "shop"), namespace="two")),\n]\n',
    'shop/__init__.py': '',
    'shop/urls.py': 'from django.urls import path, include\nfrom .handlers import detail as view\napp_name = "shop"\nurlpatterns = [path("items/", include([path("<int:id>/", view, {"mode": "full"}, name="detail")]))]\n',
    'shop/handlers.py': 'def helper():\n    return 1\ndef detail(request, id, mode):\n    return helper()\n',
  });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name).sort(), ['* /v1/items/<int:id>/', '* /v2/items/<int:id>/']);
  assert.deepEqual(views(graph).map(item => item.metadata.urlName).sort(), ['one:detail', 'two:detail']);
  for (const endpoint of views(graph)) { assert.equal(endpoint.metadata.constraintsUnresolved, undefined); assert.equal((endpoint.metadata.routing as any).mounts.length, 2); assert.deepEqual(endpoint.metadata.defaultArgumentNames, ['mode']); assert.equal((endpoint.metadata.routing as any).methods, '*'); }
  const detail = graph.entities.find(item => item.name === 'detail')!, helper = graph.entities.find(item => item.name === 'helper')!;
  assert.equal(graph.relations.filter(item => item.type === 'handles' && item.to === detail.id).length, 2); assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === detail.id && item.to === helper.id));
  assert.equal(views(graph)[0]!.sourceRange!.startLine, 4);
});

test('Django explicit URLconf roots keep unused modules private and setting alternatives constrained', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n', 'unused.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("unused/", view)]\n', 'views.py': 'def view(request):\n    return 1\n', 'other_settings.py': 'ROOT_URLCONF = "unused"\n' });
  const alternatives = await index(root); assert.equal(views(alternatives).length, 2); assert.ok(views(alternatives).every(item => item.metadata.constraintsUnresolved));
  const configured = await index(root, undefined, undefined, [{ name: 'api', path: '.', entrypoints: { django: ['urls'] } }]); assert.deepEqual(views(configured).map(item => item.name), ['* /one/']); assert.equal(views(configured)[0]!.metadata.constraintsUnresolved, undefined); assert.ok(views(configured)[0]!.evidence.some(item => item.explanation?.includes('Configured Django entrypoint')));
});

test('Django launcher settings defaults select indexed ROOT_URLCONF without executing management code', async () => {
  const root = await repository({ 'settings.py': 'ROOT_URLCONF = "unused"\n', 'project/__init__.py': '', 'project/settings.py': 'ROOT_URLCONF = "project.urls"\n', 'project/urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("selected/", view)]\n', 'unused.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("unused/", view)]\n', 'views.py': 'def view(request):\n    return 1\n', 'manage.py': 'import os\nfrom django.core.management import execute_from_command_line\ndef main():\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")\n    execute_from_command_line([])\nif __name__ == "__main__":\n    main()\n' });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name), ['* /selected/']); assert.equal(views(graph)[0]!.metadata.constraintsUnresolved, undefined);
});

test('Django function method guards preserve exact execution and separate 405 responses without implicit HEAD', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import get, safe, post, generic\nurlpatterns = [path("get/", get), path("safe/", safe), path("post/", post), path("any/", generic)]\n', 'views.py': 'from django.views.decorators.http import require_GET, require_safe, require_http_methods\nfrom django.views.decorators.csrf import csrf_exempt\n@require_GET\ndef get(request):\n    return 1\n@require_safe\ndef safe(request):\n    return 2\n@csrf_exempt\n@require_http_methods(["POST", "PUT"])\ndef post(request):\n    return 3\ndef generic(request):\n    return 4\n' });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name).sort(), ['* /any/', 'GET /get/', 'GET /safe/', 'POST /post/']);
  assert.deepEqual((views(graph).find(item => item.name === 'GET /get/')!.metadata.routing as any).methods, ['GET']); assert.deepEqual((views(graph).find(item => item.name === 'GET /safe/')!.metadata.routing as any).methods, ['GET', 'HEAD']);
  const rejected = endpoints(graph).filter(item => item.metadata.automaticResponse); assert.equal(rejected.length, 3); assert.ok(rejected.every(item => item.metadata.statusCode === 405 && !graph.relations.some(edge => edge.from === item.id && edge.type === 'handles')));
  assert.ok(endpoints(graph).every(item => !item.metadata.constraintsUnresolved));
});

test('Django direct and indexed-inherited View classes bind per-method dispatch, HEAD fallback, OPTIONS and 405', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Child, Limited\nurlpatterns = [path("items/", Child.as_view()), path("limited/", Limited.as_view(http_method_names=["get"]))]\n', 'views.py': 'from django.views import View\nclass Base(View):\n    def get(self, request):\n        return 1\nclass Child(Base):\n    def post(self, request):\n        return 2\nclass Limited(View):\n    def get(self, request):\n        return 3\n' });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name).sort(), ['GET /items/', 'GET /limited/', 'HEAD /items/', 'POST /items/']);
  assert.ok(endpoints(graph).every(item => !item.metadata.constraintsUnresolved));
  const handled = (name: string) => graph.entities.find(item => item.id === graph.relations.find(edge => edge.type === 'handles' && edge.from === views(graph).find(item => item.name === name)!.id)!.to)!.metadata.qualifiedName;
  assert.equal(handled('GET /items/'), 'Base.get'); assert.equal(handled('HEAD /items/'), 'Base.get'); assert.equal(handled('POST /items/'), 'Child.post');
  assert.ok(endpoints(graph).some(item => item.name === 'OPTIONS /items/' && item.metadata.statusCode === 200)); assert.equal(endpoints(graph).some(item => item.name === 'HEAD /limited/' || item.name === 'OPTIONS /limited/'), false);
  assert.equal(endpoints(graph).filter(item => item.metadata.statusCode === 405).length, 2);
});

test('Django generic view classes retain exact class entrypoints without manufacturing get_queryset calls', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Index, Detail\nurlpatterns = [path("index/", Index.as_view()), path("<int:pk>/", Detail.as_view())]\n', 'views.py': 'from django.views import generic\nclass Index(generic.ListView):\n    template_name = "index.html"\n    def get_queryset(self):\n        return []\nclass Detail(generic.DetailView):\n    model = Object\n' });
  const graph = await index(root); assert.ok(views(graph).every(item => !item.metadata.constraintsUnresolved));
  for (const endpoint of views(graph)) { const handler = graph.relations.find(item => item.type === 'handles' && item.from === endpoint.id)!; assert.equal(graph.entities.find(item => item.id === handler.to)!.type, 'class'); }
  assert.equal(graph.relations.some(item => item.type === 'calls' && views(graph).some(endpoint => endpoint.id === item.from)), false);
});

test('Django literal URL list concatenation, append/extend and augmentation retain registration order', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import view\nbase = [path("first/", view)]\nurlpatterns = base + [path("second/", view)]\nurlpatterns.append(path("third/", view))\nurlpatterns.extend([path("fourth/", view)])\nurlpatterns += [path("fifth/", view)]\n', 'views.py': 'def view(request):\n    return 1\n' });
  const graph = await index(root); assert.deepEqual(views(graph).sort((a,b) => (a.metadata.urlOrder as number[])[0]! - (b.metadata.urlOrder as number[])[0]!).map(item => item.name), ['* /first/', '* /second/', '* /third/', '* /fourth/', '* /fifth/']); assert.ok(endpoints(graph).every(item => !item.metadata.constraintsUnresolved));
});

test('Django converters and bounded anchored regex translation preserve numeric/slug/lowercase UUID/slash semantics', async () => {
  const uuid = compileDjangoPath('/<uuid:id>/'); assert.ok(matchRoutePattern(uuid, '/123e4567-e89b-12d3-a456-426614174000/')); assert.equal(matchRoutePattern(uuid, '/123E4567-E89B-12D3-A456-426614174000/'), false);
  assert.ok(matchRoutePattern(compileDjangoPath('/<slug:id>/'), '/alpha-1_2/')); assert.equal(matchRoutePattern(compileDjangoPath('/<slug:id>/'), '/café/'), false);
  assert.ok(matchRoutePattern(compileDjangoPath('/files/<path:p>/'), '/files//x/')); assert.equal(matchRoutePattern(compileDjangoPath('/files/<path:p>/'), '/files//'), false);
  assert.equal(matchRoutePattern(compileDjangoPath('/Items/<int:id>/'), '/items/1/'), false); assert.equal(matchRoutePattern(compileDjangoPath('/Items/<int:id>/'), '/Items/1'), false);
  assert.equal(djangoRegexRoute('^items/(?P<id>[0-9]+)/$'), 'items/<int:id>/'); assert.equal(djangoRegexRoute('^api/', true), 'api/');
  assert.equal(djangoRegexRoute('^api/$', true), undefined); assert.equal(djangoRegexRoute('^api/\\Z', true), undefined); assert.equal(compileDjangoPath('/<int:id>/<slug:id>/').status, 'partial');
  for (const regex of ['items/$', '^x/(a|b)/$', '^items/(?P<id>[0-9]{4})/$', '^x/.*$', '^(a+)+$']) assert.equal(djangoRegexRoute(regex), undefined);
  const root = await repository({ 'urls.py': 'from django.urls import path, re_path, include\nfrom views import view\nurlpatterns = [re_path(r"^api/", include([re_path(r"^items/(?P<id>[0-9]+)/$", view)])), re_path(r"^wild/.*$", view)]\n', 'views.py': 'def view(request, id=None):\n    return 1\n' });
  const graph = await index(root), exact = views(graph).find(item => item.name === '* /api/items/<int:id>/')!; assert.equal(exact.metadata.constraintsUnresolved, undefined); assert.equal((exact.metadata.routing as any).pattern.dialect, 'django-re-path'); assert.ok(views(graph).some(item => item.metadata.constraintsUnresolved));
});

test('Django configured settings roots retain middleware declarations and constrain explicit URLconf overrides', async () => {
  const root = await repository({ 'settings.py': 'ROOT_URLCONF = "urls"\nMIDDLEWARE = ["middleware.Custom"]\n', 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n', 'views.py': 'def view(request):\n    return 1\n', 'middleware.py': 'class Custom:\n    def __init__(self, get_response):\n        self.get_response = get_response\n    def __call__(self, request):\n        return self.get_response(request)\n' });
  const config: ApplicationInput[] = [{ name: 'api', path: '.', entrypoints: { django: ['settings:ROOT_URLCONF'] } }];
  const graph = await index(root, undefined, undefined, config); assert.equal(views(graph)[0]!.metadata.constraintsUnresolved, undefined); assert.ok(graph.relations.some(item => item.type === 'references' && item.metadata?.role === 'middleware'));
  await writeFile(path.join(root, 'middleware.py'), 'class Custom:\n    def __call__(self, request):\n        request.urlconf = "other.urls"\n');
  const changed = await index(root, undefined, undefined, config); assert.ok(views(changed).every(item => item.metadata.constraintsUnresolved)); assert.ok(changed.diagnostics.some(item => item.code === 'django-middleware-urlconf-override'));
});

test('Django missing roots, cycles, dynamic settings/URL lists and unknown includes produce explicit candidates', async () => {
  const root = await repository({ 'settings.py': '', 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("private/", view)]\n', 'views.py': 'def view(request):\n    return 1\n' });
  const privateGraph = await index(root); assert.equal(endpoints(privateGraph).length, 0); assert.ok(privateGraph.diagnostics.some(item => item.code === 'django-url-root-missing'));
  await writeFile(path.join(root, 'settings.py'), 'ROOT_URLCONF = dynamic\n'); const dynamic = await index(root); assert.ok(endpoints(dynamic).every(item => item.metadata.constraintsUnresolved)); assert.ok(endpoints(dynamic).length);
  const cyclic = await repository({ 'urls.py': 'from django.urls import path, include\nurlpatterns = [path("cycle/", include("urls"))]\n' }); const cycled = await index(cyclic); assert.ok(endpoints(cycled).every(item => item.metadata.constraintsUnresolved)); assert.ok(endpoints(cycled).length);
});

test('Django type-only imports, local/excluded lookalikes, custom wrappers and mutated classes do not prove handlers', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import custom, Items\nurlpatterns = [path("custom/", custom), path("class/", Items.as_view())]\n', 'views.py': 'from django.views import View\n@custom_wrapper\ndef custom(request):\n    return 1\nclass Items(View):\n    def get(self, request):\n        return 1\nAlias = Items\nAlias.get = other\n' });
  const graph = await index(root); assert.ok(views(graph).every(item => item.metadata.constraintsUnresolved)); assert.equal(graph.relations.filter(item => item.type === 'handles').length, 0);
  for (const body of ['def path(*args):\n    return args\n', '# opaque\n'.repeat(200_000)]) {
    const local = await repository({ 'django/__init__.py': '', 'django/urls.py': body, 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("fake/", view)]\n', 'views.py': 'def view(request):\n    return 1\n' });
    assert.equal(endpoints(await index(local)).filter(item => item.metadata.registration === 'registered').length, 0);
  }
});

test('Django cache/revision parity, entrypoint changes and inserted lines preserve endpoint identity', async () => {
  const source = 'from django.urls import path\nfrom views import view\nurlpatterns = [\n    path("one/", view),\n]\n', root = await repository({ 'urls.py': source, 'views.py': 'def view(request):\n    return 1\n' }), cache = new AnalysisCache(path.join(root, '.cache'));
  const cold = await index(root, cache); assert.equal(stored(await index(root, cache)), stored(cold)); assert.equal(stored(await index(root, undefined, 'fixture-revision')), stored(cold)); assert.ok(cache.events.some(item => item.analyzer === 'python-imports' && item.hit));
  await writeFile(path.join(root, 'urls.py'), `# shifted\n\n${source}`); const shifted = await index(root, cache); assert.deepEqual(endpoints(shifted).map(item => item.id), endpoints(cold).map(item => item.id)); assert.equal(stored(shifted), stored(await index(root)));
});

test('TS frontend matches Django all-method views and 405 guards only through explicit origins; opaque competitors block false matches', async () => {
  const source = 'from django.urls import path\nfrom views import view, guarded\nurlpatterns = [path("items/<int:id>/", view), path("guard/", guarded)]\n';
  const root = await repository({ 'api/requirements.txt': 'Django==5.2.7\n', 'api/urls.py': source, 'api/views.py': 'from django.views.decorators.http import require_GET\ndef view(request, id):\n    return 1\n@require_GET\ndef guarded(request):\n    return 1\n', 'web/package.json': '{"dependencies":{"next":"^16.0.0"}}', 'web/client.ts': 'export function load() { fetch("https://api.example/items/12/", { method: "POST" }); fetch("https://api.example/guard/", { method: "POST" }); }' });
  const applications: ApplicationInput[] = [{ name: 'api', path: 'api', entrypoints: { django: ['urls'] }, apiOrigins: ['https://api.example'] }, { name: 'web', path: 'web', frameworks: ['nextjs'] }];
  const graph = await index(root, undefined, undefined, applications); assert.equal(graph.relations.filter(item => item.type === 'requests').length, 2);
  assert.ok(graph.relations.some(item => item.type === 'requests' && endpoints(graph).find(endpoint => endpoint.id === item.to)?.metadata.statusCode === 405));
  await writeFile(path.join(root, 'api/urls.py'), `${source}\nurlpatterns.append(path(dynamic, view))\n`);
  const ambiguous = await index(root, undefined, undefined, applications); assert.equal(ambiguous.relations.filter(item => item.type === 'requests').length, 0); assert.ok(ambiguous.diagnostics.some(item => item.code === 'ambiguous-http-match'));
});

test('Django converter registration and unsupported view construction retain constrained competitors', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path, register_converter\nfrom views import view, Items\nregister_converter(Custom, "int")\nurlpatterns = [path("<int:id>/", view), path("class/", Items.as_view(unsupported=True))]\n', 'views.py': 'from django.views import View\ndef view(request, id):\n    return 1\nclass Items(View):\n    def get(self, request):\n        return 1\n' });
  const graph = await index(root); assert.ok(views(graph).every(item => item.metadata.constraintsUnresolved)); assert.ok(views(graph).find(item => item.name === '* /<int:id>/')!.metadata.constraintsUnresolved);
});

test('Django imported settings and middleware retain bootstrap defaults and exact registration proof', async () => {
  const root = await repository({ 'settings.py': '', 'project/__init__.py': '', 'project/base.py': 'ROOT_URLCONF = "urls"\nMIDDLEWARE = ["middleware.Custom"]\n', 'project/settings.py': 'from .base import ROOT_URLCONF, MIDDLEWARE\n', 'project/wsgi.py': 'import os\nfrom django.core.wsgi import get_wsgi_application\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")\napplication = get_wsgi_application()\n', 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n', 'views.py': 'def view(request):\n    return 1\n', 'middleware.py': 'class Custom:\n    def __call__(self, request):\n        return request\n' });
  const graph = await index(root); assert.deepEqual(views(graph).map(item => item.name), ['* /one/']); assert.equal(views(graph)[0]!.metadata.constraintsUnresolved, undefined);
  assert.ok(views(graph)[0]!.evidence.some(item => item.file === 'project/wsgi.py' && item.explanation?.includes('startup default'))); assert.ok(graph.relations.some(item => item.metadata?.role === 'middleware'));
});

test('Django dynamic child URL lists preserve unknown candidates within their include prefix', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path, include\nfrom views import view\nurlpatterns = [path("api/", include("child")), path("api/new/", view), path("public/", view)]\n', 'child.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("old/", view)]\nurlpatterns += dynamic_patterns\n', 'views.py': 'def view(request):\n    return 1\n', 'web/package.json': '{"dependencies":{"next":"^16.0.0"}}', 'web/client.ts': 'export function load() { fetch("https://api.example/api/new/"); fetch("https://api.example/public/"); }' });
  const applications: ApplicationInput[] = [{ name: 'api', path: '.', apiOrigins: ['https://api.example'] }, { name: 'web', path: 'web', frameworks: ['nextjs'] }];
  const graph = await index(root, undefined, undefined, applications); assert.equal(graph.relations.filter(item => item.type === 'requests').length, 1); assert.ok(graph.relations.some(item => item.type === 'requests' && endpoints(graph).find(endpoint => endpoint.id === item.to)?.metadata.routePath === '/public/')); assert.ok(graph.diagnostics.some(item => item.code === 'ambiguous-http-match'));
});

test('Django URL list aliases, escapes and external module assignments cannot establish confirmed routes', async () => {
  for (const mutation of ['alias = urlpatterns\nalias.insert(0, dynamic)', 'install(urlpatterns)']) {
    const root = await repository({ 'urls.py': `from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n${mutation}\n`, 'views.py': 'def view(request):\n    return 1\n' });
    const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved)); assert.ok(graph.diagnostics.some(item => item.code === 'django-url-list-escape'));
  }
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n', 'bootstrap.py': 'import urls as alias\nalias.urlpatterns = other\n', 'views.py': 'def view(request):\n    return 1\n' });
  assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved));
});

test('Django assigned method/dispatch callables bind while opaque attributes, protected kwargs and escaped classes stay constrained', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Items, Dispatch\nurlpatterns = [path("items/", Items.as_view()), path("dispatch/", Dispatch.as_view())]\n', 'views.py': 'from django.views import View\ndef handler(self, request):\n    return 1\nclass Items(View):\n    get = handler\nclass Dispatch(View):\n    dispatch = handler\n' });
  const graph = await index(root); assert.ok(views(graph).every(item => !item.metadata.constraintsUnresolved)); assert.ok(graph.relations.filter(item => item.type === 'handles').every(item => graph.entities.find(entity => entity.id === item.to)!.name === 'handler'));
  for (const extra of ['class Items(View):\n    get = None\n', 'class Items(View):\n    def get(self, request):\n        return 1\ninstall(Items)\n']) {
    const uncertain = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Items\nurlpatterns = [path("items/", Items.as_view())]\n', 'views.py': `from django.views import View\n${extra}` }); assert.ok(views(await index(uncertain)).every(item => item.metadata.constraintsUnresolved));
  }
});

test('Django method-name case and unknown external middleware do not manufacture HEAD/OPTIONS or handler execution', async () => {
  const root = await repository({ 'settings.py': 'ROOT_URLCONF = "urls"\nMIDDLEWARE = ["tenant.Unknown"]\n', 'urls.py': 'from django.urls import path\nfrom views import lower, Items\nurlpatterns = [path("lower/", lower), path("class/", Items.as_view())]\n', 'views.py': 'from django.views import View\nfrom django.views.decorators.http import require_http_methods\n@require_http_methods(["get"])\ndef lower(request):\n    return 1\nclass Items(View):\n    http_method_names = ["GET"]\n    def get(self, request):\n        return 1\n' });
  const graph = await index(root); assert.ok(views(graph).every(item => item.metadata.constraintsUnresolved)); assert.equal(graph.relations.filter(item => item.type === 'handles').length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'django-unreviewed-middleware'));
});

test('Django runtime import-path/namespace mutations and failed syntax remain unresolved with capability outcomes', async () => {
  for (const settings of ['import sys\nsys.path.append(dynamic)\nROOT_URLCONF = "urls"\n', 'ROOT_URLCONF = "urls"\nexec(dynamic)\n']) {
    const root = await repository({ 'settings.py': settings, 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n', 'views.py': 'def view(request):\n    return 1\n' });
    const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved));
  }
  const broken = await repository({ 'urls.py': 'from django.urls import path\nurlpatterns = [path(\n' }); const graph = await index(broken), file = graph.entities.find(item => item.type === 'file' && item.path === 'urls.py')!;
  assert.equal((file.metadata.analysis as any).features.framework.status, 'failed'); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved));
});

test('Django invalid argument binding and called view decorators cannot establish an executable registration', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path, include\nfrom views import view, guarded, csrf\nurlpatterns = [path("one/", view, route="other/"), path("two/", include([], arg=[])), path("guard/", guarded), path("csrf/", csrf)]\n', 'views.py': 'from django.views.decorators.http import require_GET\nfrom django.views.decorators.csrf import csrf_exempt\ndef view(request):\n    return 1\n@require_GET()\ndef guarded(request):\n    return 1\n@csrf_exempt()\ndef csrf(request):\n    return 1\n' });
  const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved)); assert.equal(graph.relations.filter(item => item.type === 'handles' && ['guarded', 'csrf'].includes(graph.entities.find(entity => entity.id === item.to)?.name ?? '')).length, 0);
});

test('Django assigned setup is opaque while a literal rejection callable replaces the standard 405 response', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Custom, Setup\nurlpatterns = [path("custom/", Custom.as_view()), path("setup/", Setup.as_view())]\n', 'views.py': 'from django.views import View\ndef reject(self, request, *args, **kwargs):\n    return 1\nclass Custom(View):\n    http_method_not_allowed = reject\nclass Setup(View):\n    setup = unknown\n    def get(self, request):\n        return 1\n' });
  const graph = await index(root), custom = endpoints(graph).filter(item => item.metadata.routePath === '/custom/'); assert.ok(custom.every(item => !item.metadata.constraintsUnresolved)); assert.equal(custom.some(item => item.metadata.statusCode === 405), false);
  const rejection = custom.find(item => item.metadata.method === '*')!; assert.ok(graph.relations.some(item => item.type === 'handles' && item.from === rejection.id && graph.entities.find(entity => entity.id === item.to)?.name === 'reject'));
  assert.ok(endpoints(graph).filter(item => item.metadata.routePath === '/setup/').every(item => item.metadata.constraintsUnresolved));
});

test('Django assigned unreviewed calls receiving view classes or URL lists invalidate deployment certainty', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Items\nurlpatterns = [path("items/", Items.as_view())]\nresult = configure(urlpatterns)\n', 'views.py': 'from django.views import View\nclass Items(View):\n    def get(self, request):\n        return 1\nresult = configure(Items)\n' });
  const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved)); assert.equal(graph.relations.filter(item => item.type === 'handles').length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'django-url-list-escape'));
});

test('Django async handlers cannot override inherited synchronous generic dispatch without a gap', async () => {
  const root = await repository({ 'urls.py': 'from django.urls import path\nfrom views import Items\nurlpatterns = [path("items/", Items.as_view())]\n', 'views.py': 'from django.views.generic import TemplateView\nclass Items(TemplateView):\n    async def post(self, request):\n        return 1\n' });
  const graph = await index(root); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved)); assert.equal(graph.relations.filter(item => item.type === 'handles').length, 0);
  await writeFile(path.join(root, 'views.py'), 'from django.views.generic import TemplateView\nclass Items(TemplateView):\n    async def get(self, request):\n        return 1\n');
  const asyncOnly = await index(root); assert.ok(endpoints(asyncOnly).every(item => !item.metadata.constraintsUnresolved)); assert.ok(asyncOnly.relations.some(item => item.type === 'handles' && asyncOnly.entities.find(entity => entity.id === item.from)?.metadata.routePath === '/items/'));
});

test('Django profiles use the exact distribution name and keep absent or broad versions constrained', async () => {
  const source = { 'urls.py': 'from django.urls import path\nfrom views import view\nurlpatterns = [path("one/", view)]\n', 'views.py': 'def view(request):\n    return 1\n' };
  const pinned = await repository({ ...source, 'requirements.txt': 'Django==5.2.7\ndjango-hosts==7.0.0\n' }); assert.ok(endpoints(await index(pinned)).every(item => !item.metadata.constraintsUnresolved));
  for (const declaration of ['', 'Django>=5.2\n', 'django-fake==5.2.7\n']) { const root = await repository({ ...source, 'requirements.txt': declaration }); assert.ok(endpoints(await index(root)).every(item => item.metadata.constraintsUnresolved)); }
});
