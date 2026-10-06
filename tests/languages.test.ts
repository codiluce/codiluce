import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectApplications } from '../src/core/config.js';
import { headerLanguage, languageOf } from '../src/core/languages.js';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(directory => rm(directory, { recursive: true, force: true }))); });
async function repository(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-languages-')); temporary.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const execute = promisify(execFile);
const summary = (apps: Awaited<ReturnType<typeof detectApplications>>) => apps.map(app => `${app.path} ${app.name} [${app.frameworks.join(',')}] (${app.ecosystems.join(',')})`).sort();

test('applications are detected from the manifests of every ecosystem, nested around a shell at the root', async () => {
  const root = await repository({
    // A Capacitor shell at the root (real dependencies) around the applications it ships.
    'package.json': { name: 'shell', dependencies: { '@capacitor/core': '^8', express: '^4' }, devDependencies: { husky: '^9' } },
    'composer.json': { require: { 'google/cloud-translate': '^1' } },
    'frontend/package.json': { dependencies: { next: '16', react: '19' } },
    // A Next.js application owns its directory: nothing below it is another application.
    'frontend/docs/package.json': { dependencies: { astro: '5' } },
    'backend/composer.json': { require: { php: '^8.2', 'laravel/framework': '^12', 'inertiajs/inertia-laravel': '^2' } },
    'backend/package.json': { devDependencies: { '@inertiajs/react': '^2', react: '^19', vite: '^7' } },
    // A Gradle multi-project build is a workspace; its modules are the applications.
    'android/settings.gradle': "include ':app'\n",
    'android/build.gradle': "buildscript { dependencies { classpath 'com.android.tools.build:gradle:8.7.0' } }\n",
    'android/app/build.gradle': "apply plugin: 'com.android.application'\n",
    'ios/App/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n',
    'ios/Gemfile': "source 'https://rubygems.org'\ngem 'fastlane'\n",
    'builder/whisper/requirements.txt': "torch>=2.0\n# a comment\n-r base.txt\nDjango[argon2]==4.2 ; python_version > '3'\n",
    'tools/pyproject.toml': '[tool.ruff]\nline-length = 100\n',
    'services/api/go.mod': 'module example.com/api\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgithub.com/labstack/echo/v4 v4.12.0\n)\n',
    'crates/Cargo.toml': '[workspace]\nmembers = ["server"]\n',
    'crates/server/Cargo.toml': '[package]\nname = "server"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n',
    'dotnet/Shop.sln': '\n',
    'dotnet/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">\n</Project>\n',
    'tests/fixtures/app/package.json': { dependencies: { next: '16' } },
  });
  assert.deepEqual(summary(await detectApplications(root, 'shell')), [
    '. shell [capacitor,express] (php,node)',
    'android/app android-app [android] (jvm)',
    'backend backend [laravel,inertia,react] (php,node)',
    'builder/whisper builder-whisper [django] (python)',
    'crates/server crates-server [axum] (rust)',
    'dotnet/Api dotnet-Api [aspnetcore] (dotnet)',
    'frontend frontend [nextjs,react] (node)',
    'ios/App ios-App [] (xcode)',
    'services/api services-api [gin,echo] (go)',
  ]);
});

test('workspace and tooling roots are not applications; their packages are', async () => {
  const workspace = await repository({
    'package.json': { private: true, workspaces: ['apps/*', 'packages/*'], devDependencies: { prettier: '3', react: '19' } },
    'apps/web/package.json': { devDependencies: { '@sveltejs/kit': '2', svelte: '5' } },
    'apps/site/package.json': { dependencies: { astro: '5' } },
    'packages/ui/package.json': { name: 'ui', peerDependencies: { vue: '3' } },
    'packages/config/package.json': { name: 'config', devDependencies: { eslint: '9' } },
    'shop/layout/theme.liquid': '<html>{{ content_for_layout }}</html>\n',
    'shop/sections/header.liquid': '<header></header>\n',
  });
  assert.deepEqual(summary(await detectApplications(workspace)), [
    'apps/site apps-site [astro] (node)',
    'apps/web apps-web [sveltekit,svelte] (node)',
    'packages/ui packages-ui [vue] (node)',
    'shop shop [shopify-theme] (shopify)',
  ]);
  const tooling = await repository({
    'package.json': { scripts: { prepare: 'husky' }, devDependencies: { husky: '9' } },
    'composer.json': { 'require-dev': { 'friendsofphp/php-cs-fixer': '3' } },
    'site/Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'sidekiq'\n",
    'engine/CMakeLists.txt': 'project(engine)\n',
    'server/Package.swift': '.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")\n',
    'api/pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi>=0.110", "SQLAlchemy"]\n',
  });
  assert.deepEqual(summary(await detectApplications(tooling)), [
    'api api [fastapi] (python)',
    'engine engine [] (native)',
    'server server [vapor] (swift)',
    'site site [rails,sidekiq] (ruby)',
  ]);
  const broken = await repository({ 'api/Cargo.toml': '[package\nname = "api"\n' });
  await assert.rejects(detectApplications(broken), /Invalid manifest: api\/Cargo\.toml/);
});

test('directories Git ignores are not applications, as the scanner prunes them', async () => {
  const root = await repository({
    '.gitignore': 'generated/\n',
    'generated/plugins/build.gradle': "apply plugin: 'com.android.library'\n",
    'app/build.gradle': "apply plugin: 'com.android.application'\n",
  });
  await execute('git', ['init', '-q'], { cwd: root });
  assert.deepEqual(summary(await detectApplications(root)), ['app app [android] (jvm)']);
});

test('file languages come from well-known names and extensions; headers follow their application', () => {
  const cases: Record<string, string | undefined> = {
    'app/models.py': 'python', 'cmd/main.go': 'go', 'src/lib.rs': 'rust', 'App.java': 'java', 'build.gradle.kts': 'kotlin', 'Main.scala': 'scala',
    'Api/Program.cs': 'csharp', 'Views/Home/Index.cshtml': 'razor', 'Module.vb': 'vbnet', 'app/models/user.rb': 'ruby', 'Gemfile': 'ruby',
    'views/index.html.erb': 'erb', 'src/core.cpp': 'cpp', 'src/core.hpp': 'cpp', 'src/core.h': 'c', 'ios/AppDelegate.m': 'objective-c',
    'Sources/App/main.swift': 'swift', 'src/App.vue': 'vue', 'src/routes/+page.svelte': 'svelte', 'src/pages/index.astro': 'astro',
    'sections/header.liquid': 'liquid', 'Dockerfile': 'dockerfile', 'Dockerfile.dev': 'dockerfile', 'CMakeLists.txt': 'cmake', 'Makefile': 'makefile',
    'Cargo.toml': 'toml', 'README.md': 'markdown', 'logo.png': undefined, 'notes.txt': undefined,
  };
  for (const [file, language] of Object.entries(cases)) assert.equal(languageOf(file), language, file);
  assert.equal(headerLanguage(new Set(['c'])), 'c');
  assert.equal(headerLanguage(new Set(['c', 'cpp'])), 'cpp');
  assert.equal(headerLanguage(new Set(['swift', 'objective-c'])), 'objective-c');
});

test('a mixed repository: TypeScript is analyzed in any application, other languages are measured, and coverage leaves them out', async () => {
  const root = await repository({
    'api/package.json': { dependencies: { express: '4' } },
    'api/src/server.ts': "import { route } from './routes';\nexport function start() { return route(); }\n",
    'api/src/routes.ts': "export function route() { return 'ok'; }\n",
    'worker/pyproject.toml': '[project]\nname = "worker"\ndependencies = ["celery>=5"]\n',
    'worker/app/tasks.py': 'def run():\n    return 1\n',
    'worker/tests/test_tasks.py': 'def test_run():\n    assert True\n',
    'engine/CMakeLists.txt': 'project(engine)\n',
    'engine/src/core.cpp': '#include "core.h"\nint answer() { return 42; }\n',
    'engine/include/core.h': 'int answer();\n',
    'lib/legacy.c': 'int legacy(void) { return 0; }\n',
    'lib/legacy.h': 'int legacy(void);\n',
    'Dockerfile': 'FROM node:22\n',
    'scripts/seed.ts': 'export const seed = 1;\n',
  });
  const graph = await indexRepository(root);
  const byPath = (file: string) => { const found = graph.entities.find(entity => entity.path === file && entity.type !== 'application'); assert.ok(found, file); return found; };
  const app = (name: string) => { const found = graph.entities.find(entity => entity.type === 'application' && entity.name === name); assert.ok(found, name); return found; };
  // The TypeScript analyzer runs for a plain Node application, not only Next.js.
  const start = graph.entities.find(entity => entity.name === 'start' && entity.path === 'api/src/server.ts');
  const route = graph.entities.find(entity => entity.name === 'route' && entity.path === 'api/src/routes.ts');
  assert.ok(start && route);
  assert.ok(graph.relations.some(relation => relation.type === 'calls' && relation.from === start.id && relation.to === route.id));
  assert.deepEqual({ ...app('api').metadata, languages: undefined }, { framework: 'express', frameworks: ['express'], ecosystems: ['node'], languages: undefined });
  // Other languages: named and measured, not analyzed.
  const tasks = byPath('worker/app/tasks.py');
  assert.equal(tasks.language, 'python'); assert.equal(tasks.metrics?.loc, 2); assert.equal(tasks.metadata.analysisSkipped, undefined);
  assert.equal(app('worker').language, 'python');
  assert.deepEqual(app('worker').metadata.languages, { python: 4 });
  assert.equal(byPath('engine/include/core.h').language, 'cpp');
  assert.equal(byPath('lib/legacy.h').language, 'c');
  assert.equal(app('engine').language, 'cpp');
  assert.equal(app('engine').metadata.framework, undefined);
  assert.equal(byPath('Dockerfile').language, 'dockerfile');

  const store = new GraphStore(':memory:'); store.save(graph);
  try {
    const coverage = new ProjectionService(store).coverage();
    const category = (file: string) => coverage.files[byPath(file).id]?.category;
    assert.equal(category('worker/app/tasks.py'), 'unanalyzed');
    assert.equal(category('worker/tests/test_tasks.py'), 'unanalyzed', 'not analyzed comes before tests: neither is measured');
    assert.equal(category('engine/src/core.cpp'), 'unanalyzed');
    assert.equal(category('lib/legacy.c'), 'unanalyzed');
    assert.equal(category('scripts/seed.ts'), 'outside');
    assert.equal(category('api/src/routes.ts'), 'unreached');
    assert.equal(coverage.codeFiles, 3, 'only the TypeScript files are measured');
  } finally { store.close(); }
});
