// Exercise the release tarball with production dependencies, outside this
// checkout. No install scripts, TypeScript loader, or Next.js runtime is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package');
const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-package-'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const run = (command, args, cwd = root) => execute(command, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);

async function checkSession(bin, repo, args = [], signal = 'SIGINT') {
  const child = spawn(process.execPath, [bin, 'start', ...args, '--port', '0', '--no-open'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 30_000);
  try {
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /Visualizer: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match) resolve(match[1]);
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Packaged launcher exited before listening:\n${output}`)));
    });
    assert.doesNotMatch(output, /Building the visualizer/);
    const html = await (await fetch(url)).text();
    assert.match(html, /Codiluce/);
    // The exported page needs its actual JS, CSS and font assets, not just HTML.
    const assets = [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map(match => match[1]);
    assert.ok(assets.length > 0, 'the static visualizer includes its scripts and styles');
    for (const asset of assets) assert.equal((await fetch(new URL(asset, url))).status, 200, asset);
    const summary = await (await fetch(`${url}api/summary`)).json();
    assert.ok(summary.counts.entities > 0 && summary.counts.relations > 0);
    const search = await (await fetch(`${url}api/projection/search?q=LoginForm`)).json();
    assert.ok(search.items.some(item => item.name.includes('LoginForm')));
    for (const language of ['python', 'go', 'ruby', 'rust', 'java', 'csharp', 'kotlin']) {
      const name = `Structure${language.charAt(0).toUpperCase()}${language.slice(1)}`;
      const found = await (await fetch(`${url}api/projection/search?q=${name}`)).json();
      const symbol = found.items.find(item => item.name === name && item.type === 'class');
      assert.ok(symbol, `installed grammar did not extract ${language}`);
      const entity = await (await fetch(`${url}api/entities/${symbol.id}`)).json();
      assert.equal(entity.evidence[0].source, 'syntax');
      const source = await (await fetch(`${url}api/source?entity=${symbol.id}`)).json();
      assert.equal(source.file.language, language);
      assert.equal(source.focus.startLine, entity.sourceRange.startLine);
      const file = await (await fetch(`${url}api/projection/locate/${source.file.id}`)).json();
      assert.equal(file.node.analysis.features.structure.status, 'supported');
      assert.equal(file.node.analysis.features.references.status, ['python', 'go'].includes(language) ? 'partial' : 'unsupported');
    }
    for (const [name, handlerPath, line] of [
      ['GET /package-svelte-api', 'svelte-ui/src/routes/package-svelte-api/+server.ts', 1],
      ['POST /package-svelte?/save', 'svelte-ui/src/routes/(app)/package-svelte/+page.server.ts', 1],
      ['GET /package-astro-api', 'astro-ui/src/pages/package-astro-api.ts', 2],
      ['GET|HEAD /package-go-http/{id}', 'go-http/handlers/handler.go', 3],
      ['GET /package-go-chi/child', 'go-chi/main.go', 3],
      ['GET /package-go-gin/:id', 'go-gin/main.go', 3],
      ['GET /package-go-echo4/:id', 'go-echo4/main.go', 3],
      ['GET /package-go-echo5/:id', 'go-echo5/main.go', 3],
      ['GET|HEAD /package-go-fiber2/items', 'go-fiber2/main.go', 3],
      ['GET /package-go-fiber3/items', 'go-fiber3/main.go', 3],
      ['GET /package-go-gorilla/items/{id}', 'go-gorilla/main.go', 3],
    ]) {
      const found = await (await fetch(`${url}api/entities?search=${encodeURIComponent(name)}&type=api_endpoint`)).json();
      const endpoint = found.items.find(item => item.name === name); assert.ok(endpoint);
      const response = await fetch(`${url}api/projection/request-flows/${endpoint.id}`); assert.equal(response.status, 200);
      const flow = await response.json(); assert.equal(flow.stages.handler, true, `${name} reaches its original server callback`);
      const handler = flow.nodes.find(item => item.kind === 'handler'); assert.ok(handler);
      assert.equal(handler.node.path, handlerPath); assert.equal(handler.node.sourceRange.startLine, line);
      assert.ok(flow.edges.some(edge => edge.kind === 'handles' && edge.hops.some(hop => hop.type === 'handles' && hop.to === handler.node.id)));
    }
    assert.equal((await fetch(`${url}licenses/fontsource-variable-nunito.txt`)).status, 200);
    child.kill(signal);
    assert.deepEqual(await exited, [0, null], output);
    await assert.rejects(fetch(url));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
  }
}

try {
  console.log('Building and packing the release…');
  await npm(['pack', '--pack-destination', temporary, '--loglevel=error']);
  const tarballs = (await readdir(temporary)).filter(name => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  const tarball = path.join(temporary, tarballs[0]);
  const report = JSON.parse((await npm(['pack', '--dry-run', '--ignore-scripts', '--json'])).stdout)[0];
  const files = report.files.map(file => file.path);
  for (const required of ['bin/codiluce.js', 'dist/src/cli.js', 'dist/src/history/worker.js', 'web/out/index.html', 'LICENSE', 'web/out/licenses/react.txt']) {
    assert.ok(files.includes(required), `tarball is missing ${required}`);
  }
  const grammarManifest = JSON.parse(await readFile(path.join(root, 'grammars/manifest.json'), 'utf8'));
  for (const grammar of grammarManifest.grammars) {
    for (const asset of [grammar.file, grammar.licenseFile, `queries/${grammar.language}/declarations.scm`]) assert.ok(files.includes(`dist/grammars/${asset}`), `tarball is missing ${asset}`);
  }
  assert.ok(files.includes('dist/grammars/manifest.json'));
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:\.env(?:\..*)?|\.codiluce|node_modules|tests|test-results|brand-explorations)(?:\/|$)|\.(?:db|sqlite|tgz|ts|tsx|tsbuildinfo)$/, `unexpected package file: ${file}`);
  }
  console.log(`Tarball: ${(report.size / 1024 / 1024).toFixed(2)} MB, ${files.length} files.`);

  const consumer = path.join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  console.log('Installing with production dependencies and install scripts disabled…');
  await npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);
  const installed = path.join(consumer, 'node_modules', ...manifest.name.split('/'));
  const bin = path.join(installed, 'bin/codiluce.js');
  for (const grammar of grammarManifest.grammars) assert.equal(createHash('sha256').update(await readFile(path.join(installed, 'dist/grammars', grammar.file))).digest('hex'), grammar.sha256);
  const dependencies = JSON.parse((await npm(['ls', '--omit=dev', '--all', '--json'], consumer)).stdout).dependencies[manifest.name].dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(), Object.keys(manifest.dependencies).sort());
  const help = (await npm(['exec', '--offline', '--no', '--', 'codiluce', '--help'], consumer)).stdout;
  assert.match(help, /Code and architecture visualizer/);
  assert.equal((await npm(['exec', '--offline', '--no', '--', 'codiluce', '--version'], consumer)).stdout.trim(), manifest.version);

  const repo = path.join(consumer, 'repository with spaces');
  await cp(path.join(root, 'tests/fixtures/repository'), repo, { recursive: true });
  await cp(path.join(root, 'tests/fixtures/structure'), path.join(repo, 'structure'), { recursive: true });
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ private: true, workspaces: ['shared-workspace/**'] }));
  const workspaceConsumer = path.join(repo, 'shared-workspace/deep/consumer'), workspaceShared = path.join(repo, 'shared-workspace/deep/shared');
  await mkdir(workspaceConsumer, { recursive: true }); await mkdir(workspaceShared, { recursive: true });
  await writeFile(path.join(workspaceConsumer, 'package.json'), JSON.stringify({ name: 'consumer', dependencies: { '@package-test/shared': 'workspace:*' } }));
  await writeFile(path.join(workspaceConsumer, 'source.ts'), 'import { WorkspaceShared as shared } from "@package-test/shared"; export function WorkspaceConsumer() { return shared(); }');
  await writeFile(path.join(workspaceShared, 'package.json'), JSON.stringify({ name: '@package-test/shared', exports: './source.ts' }));
  await writeFile(path.join(workspaceShared, 'source.ts'), 'export function WorkspaceShared() { return 1; }');
  const expressServer = path.join(repo, 'express-server');
  await mkdir(expressServer);
  await writeFile(path.join(expressServer, 'package.json'), JSON.stringify({ dependencies: { express: '^5.1.0' } }));
  await writeFile(path.join(expressServer, 'main.ts'), 'import express from "express"; import router from "./router"; const app = express(); app.use("/package-express", router);');
  await writeFile(path.join(expressServer, 'router.ts'), 'import { Router } from "express"; const router = Router(); export function PackagedExpressHandler() { return "ok"; } router.get("/items/:id", () => PackagedExpressHandler()); export default router;');
  const nestServer = path.join(repo, 'nest-server');
  await mkdir(nestServer);
  await writeFile(path.join(nestServer, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^11.1.0', '@nestjs/common': '^11.1.0' } }));
  await writeFile(path.join(nestServer, 'main.ts'), 'import { NestFactory } from "@nestjs/core"; import { Module, Controller, Get } from "@nestjs/common"; @Controller("package-nest") class PackagedNestController { @Get(":id") PackagedNestHandler() { return "ok"; } } @Module({ controllers: [PackagedNestController] }) class Root {} async function bootstrap() { await NestFactory.create(Root); } bootstrap();');
  const pythonServer = path.join(repo, 'python-server'), pythonPackage = path.join(pythonServer, 'src/packaged_service');
  await mkdir(pythonPackage, { recursive: true });
  await writeFile(path.join(pythonServer, 'pyproject.toml'), '[project]\nname="distribution-not-import-name"\nversion="1.0.0"\n[tool.setuptools.package-dir]\n""="src"\n');
  await writeFile(path.join(pythonPackage, '__init__.py'), '');
  await writeFile(path.join(pythonPackage, 'main.py'), 'from fastapi import FastAPI\nfrom .handler import PackagedPythonHandler as handler\napp = FastAPI()\napp.add_api_route("/package-python/{id:int}", handler, methods=["GET"])\n');
  await writeFile(path.join(pythonPackage, 'handler.py'), 'def PackagedPythonLeaf():\n    return "ok"\ndef PackagedPythonHandler():\n    return PackagedPythonLeaf()\n');
  const flaskServer = path.join(repo, 'flask-server');
  await mkdir(flaskServer);
  await writeFile(path.join(flaskServer, 'requirements.txt'), 'Flask==3.1.2\n');
  await writeFile(path.join(flaskServer, 'main.py'), 'from flask import Flask, Blueprint\nfrom handlers import PackagedFlaskHandler\nbp = Blueprint("package", __name__, url_prefix="/ignored")\nbp.add_url_rule("/<int:id>", view_func=PackagedFlaskHandler)\napp = Flask(__name__, static_folder=None)\napp.register_blueprint(bp, url_prefix="/package-flask")\n');
  await writeFile(path.join(flaskServer, 'handlers.py'), 'def PackagedFlaskLeaf():\n    return "ok"\ndef PackagedFlaskHandler(id):\n    return PackagedFlaskLeaf()\n');
  const djangoServer = path.join(repo, 'django-server');
  await mkdir(djangoServer);
  await writeFile(path.join(djangoServer, 'requirements.txt'), 'Django==5.2.7\n');
  await writeFile(path.join(djangoServer, 'settings.py'), 'ROOT_URLCONF = "urls"\n');
  await writeFile(path.join(djangoServer, 'urls.py'), 'from django.urls import path, include\nfrom handlers import PackagedDjangoHandler, PackagedDjangoView\nurlpatterns = [path("package-django/", include(([path("items/<int:id>/", PackagedDjangoHandler, name="item"), path("class/", PackagedDjangoView.as_view())], "package"), namespace="installed"))]\n');
  await writeFile(path.join(djangoServer, 'handlers.py'), 'from django.views import View\nfrom django.views.decorators.http import require_GET\ndef PackagedDjangoLeaf():\n    return "ok"\n@require_GET\ndef PackagedDjangoHandler(request, id):\n    return PackagedDjangoLeaf()\nclass PackagedDjangoView(View):\n    def get(self, request):\n        return PackagedDjangoLeaf()\n');
  const embeddedUi = path.join(repo, 'embedded-ui');
  await mkdir(embeddedUi);
  await writeFile(path.join(embeddedUi, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0', 'vue-router': '^5.3.1', svelte: '^5.0.0', astro: '^5.0.0' } }));
  await writeFile(path.join(embeddedUi, 'helper.ts'), 'export function PackagedEmbeddedLeaf() { return 1; }');
  await writeFile(path.join(embeddedUi, 'Widget.vue'), '<template><PackagedChild/><button @click="PackagedVueSave"/></template>\n<script setup lang="ts">import PackagedChild from "./PackagedChild.vue"; import { PackagedEmbeddedLeaf } from "./helper";\nfunction PackagedVueSave() { return PackagedEmbeddedLeaf(); }\n</script>');
  await writeFile(path.join(embeddedUi, 'PackagedChild.vue'), '<template><span/></template>');
  await writeFile(path.join(embeddedUi, 'main.ts'), 'import {createApp} from "vue"; import Widget from "./Widget.vue"; import router from "./router"; createApp(Widget).use(router);');
  await writeFile(path.join(embeddedUi, 'router.ts'), 'import {createRouter,createWebHistory} from "vue-router"; export default createRouter({history:createWebHistory(),routes:[{path:"/package-vue",children:[{path:"page",component:()=>import("./Widget.vue")}]}]});');
  await writeFile(path.join(embeddedUi, 'Counter.svelte'), '<script module lang="ts">import { PackagedEmbeddedLeaf } from "./helper";\nexport function PackagedSvelteShared() { return PackagedEmbeddedLeaf(); }\n</script>');
  await writeFile(path.join(embeddedUi, 'Page.astro'), '---\nimport { PackagedEmbeddedLeaf } from "./helper";\nfunction PackagedAstroLoad() { return PackagedEmbeddedLeaf(); }\n---\n<script>import { PackagedEmbeddedLeaf } from "./helper";\nfunction PackagedAstroClick() { return PackagedEmbeddedLeaf(); }\n</script>');
  await writeFile(path.join(embeddedUi, 'consumer.ts'), 'import { PackagedSvelteShared } from "./Counter.svelte"; export function PackagedSvelteConsumer() { return PackagedSvelteShared(); }');
  const svelteUi = path.join(repo, 'svelte-ui');
  await mkdir(path.join(svelteUi, 'src/routes/(app)/package-svelte'), { recursive: true });
  await mkdir(path.join(svelteUi, 'src/routes/package-svelte-api'), { recursive: true });
  await mkdir(path.join(svelteUi, 'src/lib'), { recursive: true });
  await writeFile(path.join(svelteUi, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.57.2', '@sveltejs/kit': '^3.0.1', vite: '^8.0.12' }, imports: { '#lib/*': './src/lib/*' } }));
  await writeFile(path.join(svelteUi, 'vite.config.js'), 'import {sveltekit} from "@sveltejs/kit/vite"; export default {plugins:[sveltekit()]};');
  await writeFile(path.join(svelteUi, 'src/routes/(app)/package-svelte/+page.svelte'), '<script>import Child from "#lib/Child.svelte";</script><Child/>');
  await writeFile(path.join(svelteUi, 'src/lib/Child.svelte'), '<script>export function PackagedSvelteSave(){return fetch("/package-svelte-api");}</script><button onclick={PackagedSvelteSave}/>');
  await writeFile(path.join(svelteUi, 'src/routes/(app)/package-svelte/+page.ts'), 'export const load=({fetch})=>fetch("/package-svelte-api");');
  await writeFile(path.join(svelteUi, 'src/routes/(app)/package-svelte/+page.server.ts'), 'export const actions={save:()=>({ok:true})};');
  await writeFile(path.join(svelteUi, 'src/routes/package-svelte-api/+server.ts'), 'export function GET(){return new Response("ok");}');
  const astroUi = path.join(repo, 'astro-ui');
  await mkdir(path.join(astroUi, 'src/pages'), { recursive: true }); await mkdir(path.join(astroUi, 'src/components'), { recursive: true });
  await writeFile(path.join(astroUi, 'package.json'), JSON.stringify({ dependencies: { astro: '^7.3.8', svelte: '^5.57.2', '@astrojs/svelte': '^9.0.1', '@astrojs/node': '^11.0.0' } }));
  await writeFile(path.join(astroUi, 'astro.config.mjs'), 'import {defineConfig} from "astro/config";import node from "@astrojs/node";import svelte from "@astrojs/svelte";export default defineConfig({adapter:node({mode:"standalone"}),integrations:[svelte()]});');
  await writeFile(path.join(astroUi, 'src/pages/package-astro.astro'), '---\nimport Layout from "../components/Layout.astro";import Counter from "../components/Counter.svelte";\n---\n<Layout><Counter client:load/></Layout>');
  await writeFile(path.join(astroUi, 'src/components/Layout.astro'), '<main><slot/></main>');
  await writeFile(path.join(astroUi, 'src/components/Counter.svelte'), '<script>function PackagedAstroIslandSave(){return fetch("/package-astro-api");}</script><button onclick={PackagedAstroIslandSave}/>');
  await writeFile(path.join(astroUi, 'src/pages/package-astro-api.ts'), 'export const prerender = false;\nexport function GET(){return new Response("ok");}');
  await writeFile(path.join(astroUi, 'src/pages/package-astro-static.json.ts'), 'export function GET(){return new Response("static output");}');
  const nuxtUi = path.join(repo, 'nuxt-ui');
  await mkdir(path.join(nuxtUi, 'app/pages/package-nuxt'), { recursive: true }); await mkdir(path.join(nuxtUi, 'app/components'), { recursive: true }); await mkdir(path.join(nuxtUi, 'server/api'), { recursive: true });
  await writeFile(path.join(nuxtUi, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^4.6.0' } }));
  await writeFile(path.join(nuxtUi, 'nuxt.config.ts'), 'export default defineNuxtConfig({});');
  await writeFile(path.join(nuxtUi, 'app/pages/package-nuxt.vue'), '<template><NuxtPage/></template>');
  await writeFile(path.join(nuxtUi, 'app/pages/package-nuxt/[id].vue'), '<template><PackagedNuxtCard/></template>');
  await writeFile(path.join(nuxtUi, 'app/components/PackagedNuxtCard.vue'), '<script setup>\nfunction PackagedNuxtSave(){return $fetch("/api/package-nuxt",{method:"POST"});}\n</script>\n<template><button @click="PackagedNuxtSave"/></template>');
  await writeFile(path.join(nuxtUi, 'server/api/package-nuxt.post.ts'), 'export default defineEventHandler(\n(event)=>({ok:true}));');
  const goConsumer = path.join(repo, 'go-workspace/deep/consumer'), goShared = path.join(repo, 'go-workspace/deep/shared');
  await mkdir(goConsumer, { recursive: true }); await mkdir(goShared, { recursive: true });
  await writeFile(path.join(repo, 'go.work'), 'go 1.25\nuse (\n ./go-workspace/deep/consumer\n ./go-workspace/deep/shared\n ./go-http\n ./go-chi\n ./go-gin\n ./go-echo4\n ./go-echo5\n ./go-fiber2\n ./go-fiber3\n ./go-gorilla\n)\n');
  await writeFile(path.join(goConsumer, 'go.mod'), 'module example.com/consumer\ngo 1.25\n');
  await writeFile(path.join(goConsumer, 'consumer.go'), 'package consumer\nimport "example.com/shared/v2"\nimport h "example.com/shared/v2/handlers"\nfunc PackagedGoConsumer(){routing.PackagedGoShared();h.PackagedGoHandler();v:=h.PackagedGoNew();f:=v.PackagedGoServe;f()}');
  await writeFile(path.join(goShared, 'go.mod'), 'module example.com/shared/v2\ngo 1.25\n');
  await writeFile(path.join(goShared, 'shared.go'), 'package routing\nfunc PackagedGoShared(){}');
  await writeFile(path.join(goShared, 'platform_linux.go'), 'package routing\ntype PackagedGoLinux struct{}');
  await mkdir(path.join(goShared, 'handlers'), { recursive: true });
  await writeFile(path.join(goShared, 'handlers', 'handler.go'), 'package handlers\ntype PackagedGoService struct{}\nfunc PackagedGoHandler(){}\nfunc PackagedGoNew()*PackagedGoService{return &PackagedGoService{}}');
  await writeFile(path.join(goShared, 'handlers', 'methods.go'), 'package handlers\nfunc(s *PackagedGoService)PackagedGoServe(){PackagedGoHandler()}');
  for (const [directory, requirement, source] of [
    ['go-http', '', 'package main\nimport("net/http";"example.com/package-http/handlers")\nfunc main(){m:=http.NewServeMux();m.HandleFunc("GET /package-go-http/{id}",handlers.PackagedGoHTTP);http.ListenAndServe(":8080",m)}\n'],
    ['go-chi', 'require github.com/go-chi/chi/v5 v5.2.1\n', 'package main\nimport("net/http";"github.com/go-chi/chi/v5")\nfunc PackagedGoChi(w http.ResponseWriter,r *http.Request){}\nfunc Install(r chi.Router){r.Get("/child",PackagedGoChi)}\nfunc main(){r:=chi.NewRouter();r.Route("/package-go-chi",Install);http.ListenAndServe(":8080",r)}\n'],
    ['go-gin', 'require github.com/gin-gonic/gin v1.11.0\n', 'package main\nimport "github.com/gin-gonic/gin"\nfunc PackagedGoGin(c *gin.Context){}\nfunc Router()*gin.Engine{r:=gin.Default();r.Group("/package-go-gin").GET("/:id",PackagedGoGin);return r}\nfunc main(){Router().Run()}\n'],
    ['go-echo4', 'require github.com/labstack/echo/v4 v4.13.4\n', 'package main\nimport "github.com/labstack/echo/v4"\nfunc PackagedGoEcho4(c echo.Context)error{return nil}\nfunc main(){e:=echo.New();e.Group("/package-go-echo4").GET("/:id",PackagedGoEcho4);e.Start(":8080")}\n'],
    ['go-echo5', 'require github.com/labstack/echo/v5 v5.4.0\n', 'package main\nimport "github.com/labstack/echo/v5"\nfunc PackagedGoEcho5(c *echo.Context)error{return nil}\nfunc main(){e:=echo.New();e.Group("/package-go-echo5").GET("/:id",PackagedGoEcho5);e.Start(":8080")}\n'],
    ['go-fiber2', 'require github.com/gofiber/fiber/v2 v2.52.9\n', 'package main\nimport "github.com/gofiber/fiber/v2"\nfunc PackagedGoFiber2(c *fiber.Ctx)error{return nil}\nfunc main(){a:=fiber.New();child:=fiber.New();child.Get("/items",PackagedGoFiber2);a.Mount("/package-go-fiber2",child);a.Listen(":8080")}\n'],
    ['go-fiber3', 'require github.com/gofiber/fiber/v3 v3.5.0\n', 'package main\nimport "github.com/gofiber/fiber/v3"\nfunc PackagedGoFiber3(c fiber.Ctx)error{return nil}\nfunc main(){a:=fiber.New();child:=fiber.New();child.RouteChain("/items").Get(PackagedGoFiber3);a.Use("/package-go-fiber3",child);a.Listen(":8080")}\n'],
    ['go-gorilla', 'require github.com/gorilla/mux v1.8.1\n', 'package main\nimport("net/http";"github.com/gorilla/mux")\nfunc PackagedGoGorilla(w http.ResponseWriter,r *http.Request){}\nfunc main(){r:=mux.NewRouter();r.PathPrefix("/package-go-gorilla").Subrouter().HandleFunc("/items/{id}",PackagedGoGorilla).Methods("GET");http.ListenAndServe(":8080",r)}\n'],
  ]) {
    await mkdir(path.join(repo, directory), { recursive: true });
    await writeFile(path.join(repo, directory, 'go.mod'), `module example.com/package-${directory.slice(3)}\ngo 1.25\n${requirement}`);
    await writeFile(path.join(repo, directory, 'main.go'), source);
  }
  await mkdir(path.join(repo, 'go-http/handlers'), { recursive: true });
  await writeFile(path.join(repo, 'go-http/handlers/handler.go'), 'package handlers\nimport "net/http"\nfunc PackagedGoHTTP(w http.ResponseWriter,r *http.Request){}\n');
  console.log('Starting the installed executable from a repository with spaces…');
  await checkSession(bin, repo);
  assert.ok((await readdir(path.join(repo, '.codiluce'))).includes('codiluce.db'));
  const summary = JSON.parse((await run(process.execPath, [bin, 'inspect', 'summary'], repo)).stdout);
  assert.ok(summary.counts.entities > 0);
  assert.deepEqual(JSON.parse((await run(process.execPath, ['--experimental-sqlite', bin, 'inspect', 'summary'], repo)).stdout), summary);
  const goSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'PackagedGo'], repo)).stdout).items;
  const goConsumerSymbol = goSymbols.find(entity => entity.name === 'PackagedGoConsumer'), goSharedSymbol = goSymbols.find(entity => entity.name === 'PackagedGoShared'); assert.ok(goConsumerSymbol && goSharedSymbol);
  const goFile = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', goConsumerSymbol.parentId], repo)).stdout);
  const goImport = goFile.metadata.importOutcomes.find(item => item.specifier === 'example.com/shared/v2'); assert.ok(goImport);
  assert.equal(goImport.local, 'routing'); assert.equal(goImport.range.startLine, 2); assert.equal(goImport.outcome.status, 'resolved'); assert.equal(goImport.outcome.targets.length, 2);
  assert.ok(goImport.conditions.some(reason => reason.includes('Unknown build')), 'installed resolver retains the unconfigured platform alternative');
  const goEdges = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', goFile.id, '--type', 'imports'], repo)).stdout).items;
  assert.ok(goEdges.some(edge => edge.to === goSharedSymbol.parentId)); assert.equal(goFile.metadata.analysis.features.imports.status, 'partial'); assert.equal(goFile.metadata.analysis.features.references.status, 'partial');
  const goHandler = goSymbols.find(entity => entity.name === 'PackagedGoHandler'), goService = goSymbols.find(entity => entity.name === 'PackagedGoService'), goServe = goSymbols.find(entity => entity.name === 'PackagedGoServe'); assert.ok(goHandler && goService && goServe);
  assert.equal(goServe.parentId, goService.id, 'installed Go receiver methods attach across original package files');
  const goCalls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', goConsumerSymbol.id, '--type', 'calls'], repo)).stdout).items;
  const goHandlerCall = goCalls.find(edge => edge.to === goHandler.id); assert.ok(goHandlerCall, 'installed Go member calls bind the original exported handler');
  const goCallDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relation', '--id', goHandlerCall.id], repo)).stdout);
  assert.ok(goCallDetail.evidence.some(fact => fact.file.endsWith('consumer.go') && fact.line === 4), 'installed Go member calls retain original source evidence');
  assert.ok(goCalls.some(edge => edge.to === goServe.id), 'installed Go factory result and method callback bind the original method');
  assert.ok(!goCalls.some(edge => edge.to === goSharedSymbol.id), 'unconfigured provider build alternatives cannot prove a runtime callback');
  const workspaceSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'Workspace'], repo)).stdout).items;
  const consumerSymbol = workspaceSymbols.find(entity => entity.name === 'WorkspaceConsumer' && entity.type === 'function'), sharedSymbol = workspaceSymbols.find(entity => entity.name === 'WorkspaceShared' && entity.type === 'function');
  assert.ok(consumerSymbol && sharedSymbol, 'installed project services extract deep workspace declarations');
  const workspaceCalls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', consumerSymbol.id, '--type', 'calls'], repo)).stdout).items;
  assert.ok(workspaceCalls.some(relation => relation.from === consumerSymbol.id && relation.to === sharedSymbol.id), 'installed workspace resolver binds the shared declaration');
  const expressEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-express'], repo)).stdout).items;
  const expressEndpoint = expressEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-express/items/:id');
  assert.ok(expressEndpoint, 'installed framework pack composes the Express mount path');
  const handlers = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', expressEndpoint.id, '--type', 'handles'], repo)).stdout).items;
  assert.equal(handlers.length, 1);
  const expressCalls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', handlers[0].to, '--type', 'calls'], repo)).stdout).items;
  const packagedHandlers = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'PackagedExpressHandler'], repo)).stdout).items;
  assert.ok(expressCalls.some(relation => relation.from === handlers[0].to && relation.to === packagedHandlers.find(entity => entity.name === 'PackagedExpressHandler')?.id), 'installed inline handler owns its bound calls');
  const nestEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-nest'], repo)).stdout).items;
  const nestEndpoint = nestEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-nest/:id');
  assert.ok(nestEndpoint, 'installed Nest pack resolves bootstrap/module/controller registration');
  const nestHandlers = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', nestEndpoint.id, '--type', 'handles'], repo)).stdout).items;
  const nestSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'PackagedNestHandler'], repo)).stdout).items;
  assert.ok(nestHandlers.some(relation => relation.to === nestSymbols.find(entity => entity.name === 'PackagedNestHandler')?.id), 'installed Nest endpoint binds its exact method declaration');
  const pythonEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'python-server/src/packaged_service'], repo)).stdout).items;
  const pythonMain = pythonEntities.find(entity => entity.type === 'file' && entity.path.endsWith('/main.py')), pythonHandler = pythonEntities.find(entity => entity.type === 'file' && entity.path.endsWith('/handler.py'));
  assert.ok(pythonMain && pythonHandler, 'installed Python parser extracts source-layout files');
  const pythonImports = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', pythonMain.id, '--type', 'imports'], repo)).stdout).items;
  assert.ok(pythonImports.some(relation => relation.to === pythonHandler.id), 'installed Python resolver links a relative import under the manifest src root');
  const pythonDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', pythonMain.id], repo)).stdout);
  assert.equal(pythonDetail.metadata.analysis.features.imports.status, 'partial');
  assert.equal(pythonDetail.metadata.analysis.features.references.status, 'partial');
  const pythonEndpoints = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-python'], repo)).stdout).items;
  const pythonEndpoint = pythonEndpoints.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-python/{id:int}');
  assert.ok(pythonEndpoint, 'installed FastAPI pack resolves its imported handler');
  const pythonHandlers = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', pythonEndpoint.id, '--type', 'handles'], repo)).stdout).items;
  assert.equal(pythonHandlers.length, 1);
  const pythonCalls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', pythonHandlers[0].to, '--type', 'calls'], repo)).stdout).items;
  const pythonSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'PackagedPythonLeaf'], repo)).stdout).items;
  assert.ok(pythonCalls.some(relation => relation.from === pythonHandlers[0].to && relation.to === pythonSymbols.find(entity => entity.name === 'PackagedPythonLeaf')?.id), 'installed Python handler owns its exact local call');
  const flaskEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-flask'], repo)).stdout).items;
  const flaskEndpoint = flaskEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-flask/<int:id>');
  assert.ok(flaskEndpoint, 'installed Flask pack composes the blueprint prefix override');
  const flaskDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', flaskEndpoint.id], repo)).stdout);
  assert.equal(flaskDetail.metadata.constraintsUnresolved, undefined);
  assert.deepEqual(flaskDetail.metadata.routing.methods, ['GET', 'HEAD']);
  const flaskHandlers = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', flaskEndpoint.id, '--type', 'handles'], repo)).stdout).items;
  assert.equal(flaskHandlers.length, 1);
  const flaskSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'PackagedFlask'], repo)).stdout).items;
  const flaskCalls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', flaskHandlers[0].to, '--type', 'calls'], repo)).stdout).items;
  assert.ok(flaskCalls.some(relation => relation.to === flaskSymbols.find(entity => entity.name === 'PackagedFlaskLeaf')?.id), 'installed Flask handler owns its exact local call');
  const flaskOptions = flaskEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'OPTIONS /package-flask/<int:id>');
  assert.ok(flaskOptions);
  assert.equal(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', flaskOptions.id, '--type', 'handles'], repo)).stdout).items.length, 0, 'automatic OPTIONS does not claim to execute the view');
  const djangoEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-django'], repo)).stdout).items;
  const djangoEndpoint = djangoEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-django/items/<int:id>/');
  assert.ok(djangoEndpoint, 'installed Django pack expands its namespaced URL include');
  const djangoDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', djangoEndpoint.id], repo)).stdout);
  assert.equal(djangoDetail.metadata.constraintsUnresolved, undefined);
  assert.equal(djangoDetail.metadata.urlName, 'installed:item');
  assert.deepEqual(djangoDetail.metadata.routing.methods, ['GET']);
  const djangoHandlers = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', djangoEndpoint.id, '--type', 'handles'], repo)).stdout).items;
  assert.equal(djangoHandlers.length, 1);
  const djangoSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'PackagedDjango'], repo)).stdout).items;
  const djangoCalls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', djangoHandlers[0].to, '--type', 'calls'], repo)).stdout).items;
  assert.ok(djangoCalls.some(relation => relation.to === djangoSymbols.find(entity => entity.name === 'PackagedDjangoLeaf')?.id), 'installed Django view owns its exact local call');
  const djangoClassGet = djangoEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-django/class/');
  const djangoClassHead = djangoEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'HEAD /package-django/class/');
  assert.ok(djangoClassGet && djangoClassHead);
  for (const endpoint of [djangoClassGet, djangoClassHead]) {
    const edges = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', endpoint.id, '--type', 'handles'], repo)).stdout).items;
    assert.equal(edges.length, 1);
    const method = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', edges[0].to], repo)).stdout);
    assert.equal(method.metadata.qualifiedName, 'PackagedDjangoView.get');
  }
  const djangoOptions = djangoEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'OPTIONS /package-django/class/');
  assert.ok(djangoOptions);
  assert.equal(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', djangoOptions.id, '--type', 'handles'], repo)).stdout).items.length, 0, 'Django default OPTIONS carries no view handler');
  const embeddedSymbols = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'Packaged'], repo)).stdout).items;
  const embeddedLeaf = embeddedSymbols.find(entity => entity.name === 'PackagedEmbeddedLeaf');
  assert.ok(embeddedLeaf);
  for (const [name, file, line, context] of [['PackagedVueSave', 'Widget.vue', 3, 'unknown'], ['PackagedSvelteShared', 'Counter.svelte', 2, 'unknown'], ['PackagedAstroLoad', 'Page.astro', 3, 'server'], ['PackagedAstroClick', 'Page.astro', 6, 'browser']]) {
    const symbol = embeddedSymbols.find(entity => entity.name === name);
    assert.ok(symbol, `installed embedded adapter extracts ${name}`);
    const detail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', symbol.id], repo)).stdout);
    assert.equal(detail.path, `embedded-ui/${file}`);
    assert.equal(detail.sourceRange.startLine, line);
    assert.equal(detail.metadata.executionContext, context);
    const calls = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', symbol.id, '--type', 'calls'], repo)).stdout).items;
    assert.ok(calls.some(edge => edge.to === embeddedLeaf.id), `installed ${file} script binds its imported TS declaration`);
  }
  const svelteConsumer = embeddedSymbols.find(entity => entity.name === 'PackagedSvelteConsumer'), svelteShared = embeddedSymbols.find(entity => entity.name === 'PackagedSvelteShared');
  assert.ok(svelteConsumer && svelteShared);
  assert.ok(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', svelteConsumer.id, '--type', 'calls'], repo)).stdout).items.some(edge => edge.to === svelteShared.id), 'installed component facade retains exact public module exports');
  const vueRoutes = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--type', 'route', '--search', '/package-vue'], repo)).stdout).items;
  const vuePage = vueRoutes.find(entity => entity.name === '/package-vue/page'); assert.ok(vuePage, 'installed Vue Router pack expands the nested lazy route');
  const vueTargets = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', vuePage.id, '--type', 'routes_to'], repo)).stdout).items;
  const vueEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--type', 'component'], repo)).stdout).items;
  const vueWidget = vueEntities.find(entity => entity.path === 'embedded-ui/Widget.vue'), vueChild = vueEntities.find(entity => entity.path === 'embedded-ui/PackagedChild.vue'); assert.ok(vueWidget && vueChild);
  assert.ok(vueTargets.some(edge => edge.to === vueWidget.id));
  assert.ok(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', vueWidget.id, '--type', 'renders'], repo)).stdout).items.some(edge => edge.to === vueChild.id), 'installed Vue template pack resolves its component');
  const eventEdges = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', vueWidget.id, '--type', 'references'], repo)).stdout).items;
  const event = eventEdges.find(edge => edge.metadata?.events?.includes('click')); assert.ok(event);
  const eventDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', event.to], repo)).stdout); assert.equal(eventDetail.sourceRange.startLine, 1); assert.equal(eventDetail.metadata.executionContext, 'browser');
  assert.ok(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', event.to, '--type', 'calls'], repo)).stdout).items.some(edge => edge.to === embeddedSymbols.find(entity => entity.name === 'PackagedVueSave').id), 'installed Vue callback calls its exact original method');
  const kitEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-svelte'], repo)).stdout).items;
  const kitPage = kitEntities.find(entity => entity.type === 'route' && entity.name === '/package-svelte'), kitEndpoint = kitEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-svelte-api'), kitAction = kitEntities.find(entity => entity.name === 'POST /package-svelte?/save');
  assert.ok(kitPage && kitEndpoint && kitAction, 'installed SvelteKit pack retains pages, HTTP handlers and named POST operations');
  const kitTargets = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', kitPage.id, '--type', 'routes_to'], repo)).stdout).items;
  const kitView = vueEntities.find(entity => entity.path === 'svelte-ui/src/routes/(app)/package-svelte/+page.svelte'), kitChild = vueEntities.find(entity => entity.path === 'svelte-ui/src/lib/Child.svelte'); assert.ok(kitView && kitChild); assert.ok(kitTargets.some(edge => edge.to === kitView.id));
  assert.ok(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', kitView.id, '--type', 'renders'], repo)).stdout).items.some(edge => edge.to === kitChild.id), 'installed official parser and #lib resolution bind the original child');
  const kitEvents = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', kitChild.id, '--type', 'references'], repo)).stdout).items;
  const kitEvent = kitEvents.find(edge => edge.metadata?.events?.includes('click')); assert.ok(kitEvent);
  assert.ok(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', kitEvent.to, '--type', 'requests'], repo)).stdout).items.some(edge => edge.to === kitEndpoint.id), 'installed Svelte callback supplies browser context to its source-backed request');
  const kitLoad = kitTargets.find(edge => edge.metadata?.role === 'universal-load'); assert.ok(kitLoad);
  assert.ok(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', kitLoad.to, '--type', 'requests'], repo)).stdout).items.some(edge => edge.to === kitEndpoint.id && edge.metadata?.resolution === 'sveltekit-fetch'), 'installed RequestEvent.fetch replaces an unqualified parameter spelling with framework proof');
  const astroEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', '/package-astro'], repo)).stdout).items;
  const astroPage = astroEntities.find(entity => entity.type === 'route' && entity.name === '/package-astro'), astroEndpoint = astroEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /package-astro-api'), astroStatic = astroEntities.find(entity => entity.type === 'route' && entity.name === 'GET /package-astro-static.json');
  assert.ok(astroPage && astroEndpoint && astroStatic, 'installed Astro parser preserves pages, runtime APIs and separate static build operations');
  const astroStaticDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', astroStatic.id], repo)).stdout); assert.equal(astroStaticDetail.metadata.operationKind, 'static-endpoint');
  assert.equal(JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', astroStatic.id, '--type', 'handles'], repo)).stdout).items.length, 0, 'Astro static output is not a runtime server handler');
  const astroPageTargets = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', astroPage.id, '--type', 'routes_to'], repo)).stdout).items; assert.equal(astroPageTargets.length, 1);
  const astroReferences = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', astroPageTargets[0].to, '--type', 'references'], repo)).stdout).items, astroIsland = astroReferences.find(edge => edge.metadata?.role === 'hydrated-island'); assert.ok(astroIsland);
  const astroIslandDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', astroIsland.to], repo)).stdout); assert.equal(astroIslandDetail.sourceRange.startLine, 4); assert.equal(astroIslandDetail.metadata.executionContext, 'browser'); assert.equal(astroIslandDetail.metadata.renderer, 'svelte');
  const astroRequests = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', astroIsland.to, '--type', 'requests'], repo)).stdout).items, astroRequest = astroRequests.find(edge => edge.to === astroEndpoint.id); assert.ok(astroRequest, 'installed hydrated island supplies the Astro application origin');
  const astroRequestDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relation', '--id', astroRequest.id], repo)).stdout); assert.ok(astroRequestDetail.evidence.some(fact => fact.file === 'astro-ui/src/components/Counter.svelte'), 'installed Astro invocation preserves original Svelte call evidence');
  const nuxtEntities = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'package-nuxt'], repo)).stdout).items;
  const nuxtPage = nuxtEntities.find(entity => entity.type === 'route' && entity.name === '/package-nuxt/[id]'), nuxtEndpoint = nuxtEntities.find(entity => entity.type === 'api_endpoint' && entity.name === 'POST /api/package-nuxt'); assert.ok(nuxtPage && nuxtEndpoint, 'installed Nuxt pack registers indexed nested pages and method-suffixed server routes');
  const nuxtTargets = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', nuxtPage.id, '--type', 'routes_to'], repo)).stdout).items; assert.equal(nuxtTargets.length, 2);
  const nuxtView = vueEntities.find(entity => entity.path === 'nuxt-ui/app/pages/package-nuxt/[id].vue'), nuxtCard = vueEntities.find(entity => entity.path === 'nuxt-ui/app/components/PackagedNuxtCard.vue'); assert.ok(nuxtView && nuxtCard);
  const nuxtRender = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', nuxtView.id, '--type', 'renders'], repo)).stdout).items.find(edge => edge.to === nuxtCard.id); assert.ok(nuxtRender, 'installed Nuxt auto-import convention reaches the original Vue component');
  const nuxtEvents = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', nuxtCard.id, '--type', 'references'], repo)).stdout).items, nuxtEvent = nuxtEvents.find(edge => edge.metadata?.events?.includes('click')); assert.ok(nuxtEvent);
  const nuxtRequest = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', nuxtEvent.to, '--type', 'requests'], repo)).stdout).items.find(edge => edge.to === nuxtEndpoint.id); assert.ok(nuxtRequest, 'installed Nuxt fetch transport reaches its own application endpoint');
  const nuxtRequestDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relation', '--id', nuxtRequest.id], repo)).stdout); assert.ok(nuxtRequestDetail.evidence.some(fact => fact.file === 'nuxt-ui/app/components/PackagedNuxtCard.vue' && fact.line === 2));
  const nuxtHandler = JSON.parse((await run(process.execPath, [bin, 'inspect', 'relations', '--id', nuxtEndpoint.id, '--type', 'handles'], repo)).stdout).items[0]; assert.ok(nuxtHandler);
  const nuxtHandlerDetail = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entity', '--id', nuxtHandler.to], repo)).stdout); assert.equal(nuxtHandlerDetail.path, 'nuxt-ui/server/api/package-nuxt.post.ts'); assert.equal(nuxtHandlerDetail.sourceRange.startLine, 2); assert.equal(nuxtHandlerDetail.metadata.executionContext, 'server');
  await assert.rejects(run(process.execPath, [bin, 'start', '--build-ui', '--no-open'], repo), error => error.code === 1 && /only available in a Codiluce source checkout/.test(error.stderr));
  await assert.rejects(run(process.execPath, [bin, 'unknown-command'], repo), error => error.code === 1);
  const broken = path.join(repo, 'frontend/src/broken.ts');
  await writeFile(broken, 'export function broken( {');
  await assert.rejects(run(process.execPath, [bin, 'index', '--state-dir', path.join(temporary, 'error state')], repo), error => error.code === 2);
  await rm(broken);

  console.log('Checking compiled history workers…');
  await writeFile(path.join(repo, '.gitignore'), '.codiluce/\n');
  await run('git', ['init', '--quiet'], repo);
  await run('git', ['add', '.'], repo);
  const commitArgs = ['-c', 'user.name=Codiluce package test', '-c', 'user.email=package@example.test', 'commit', '--quiet'];
  await run('git', [...commitArgs, '-m', 'Initial fixture'], repo);
  await writeFile(path.join(repo, 'README.md'), '# Packaged history fixture\n');
  await run('git', ['add', 'README.md'], repo);
  await run('git', [...commitArgs, '-m', 'Add readme'], repo);
  const history = JSON.parse((await run(process.execPath, [bin, 'history', 'index', '--jobs', '2'], repo)).stdout);
  assert.equal(history.failed, 0);
  assert.equal(history.indexed, 2);

  console.log('Checking missing parser assets leave semantic analysis usable…');
  const pythonAsset = path.join(installed, 'dist/grammars', grammarManifest.grammars.find(grammar => grammar.language === 'python').file);
  const grammarRoot = path.join(installed, 'dist/grammars');
  for (const asset of [pythonAsset, path.join(grammarRoot, 'queries/python/declarations.scm'), path.join(grammarRoot, 'manifest.json')]) {
    const bytes = await readFile(asset);
    try {
      await rm(asset);
      await run(process.execPath, [bin, 'index'], repo);
      const diagnostics = JSON.parse((await run(process.execPath, [bin, 'inspect', 'diagnostics', '--code', 'syntax-analysis-failed'], repo)).stdout);
      assert.ok(diagnostics.items.some(item => item.file === 'structure/python.py'), asset);
      const semantic = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'LoginForm'], repo)).stdout);
      assert.ok(semantic.items.some(item => item.name === 'LoginForm'), asset);
      if (!asset.endsWith('manifest.json')) {
        const rust = JSON.parse((await run(process.execPath, [bin, 'inspect', 'entities', '--search', 'StructureRust'], repo)).stdout);
        assert.ok(rust.items.some(item => item.name === 'StructureRust'), asset);
      }
    } finally { await writeFile(asset, bytes); }
  }

  // A scoped fallback must still locate its own bundled assets.
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ ...manifest, name: '@package-test/codiluce' }));
  await checkSession(bin, repo, [], 'SIGTERM');

  const standalone = path.join(temporary, 'standalone repository');
  await mkdir(standalone);
  console.log('Checking npm exec against the tarball without a local installation…');
  assert.equal((await npm(['exec', '--yes', `--package=${tarball}`, '--', 'codiluce', '--version'], standalone)).stdout.trim(), manifest.version);
  assert.match((await npm(['exec', '--yes', `--package=${tarball}`, '--', 'codiluce', '--help'], standalone)).stdout, /Code and architecture visualizer/);
  console.log('Package installation, seven grammars, workspace binding, Go imports/build alternatives/lexical calls/concrete callbacks and net/http/Chi/Gin/Echo 4–5/Fiber 2–3/Gorilla router mounts/factories/original-handler flows, Vue/Svelte/Astro embedded scripts, Vue templates/events/nested lazy routes, Svelte callbacks/Kit v3 pages/loads/actions/HTTP handlers, Astro 7 pages/layouts/islands/runtime APIs/static output, Nuxt 4 nested pages/auto-components/fetch/original handlers, Express/Nest/FastAPI/Flask/Django registrations/handlers, Python imports/calls, static UI, API, history workers, signals and npm exec passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
