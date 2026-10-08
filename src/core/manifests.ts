// Application manifests: what a directory is built with, read from the
// manifests at its root without executing or installing anything.
//
// A manifest names an ecosystem (package.json → node, composer.json → php,
// go.mod → go…) and declares dependencies; a dependency that is a known
// framework names that framework. Recognition is by declared package name
// (build scripts — Maven, Gradle, sbt, MSBuild — by the coordinates in their
// text): it says what an application is built on, never what its code does.
// A manifest can also declare only a workspace (packages built together, each
// with its own manifest below) or only tooling (a root package.json for
// linters and Git hooks); a directory whose manifests are all of that kind is
// not an application.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** In priority order: when a directory has several manifests, the first names it (node last: its package.json is often the asset build of a server application). */
export const ECOSYSTEMS = ['php', 'python', 'ruby', 'go', 'rust', 'jvm', 'dotnet', 'swift', 'xcode', 'native', 'shopify', 'node'] as const;
export type Ecosystem = typeof ECOSYSTEMS[number];
/** Legacy owning applications can also be workspace roots. Pack capability
 * does not control discovery or hide nested applications. */
const OWNING_NODE_FRAMEWORKS = new Set(['nextjs', 'laravel']);
/**
 * Known frameworks by rank: 0 an application framework (it shapes the whole
 * application), 1 a library an application is served or extended with, 2 a
 * UI library. Frameworks are listed by rank, so the first says what an
 * application is.
 */
const RANK: Record<string, number> = {
  nextjs: 0, nuxt: 0, sveltekit: 0, astro: 0, remix: 0, nestjs: 0, angular: 0, expo: 0, 'react-native': 0, electron: 0, capacitor: 0, tauri: 0,
  laravel: 0, symfony: 0, cakephp: 0, yii: 0, drupal: 0, django: 0, rails: 0, hanami: 0, jekyll: 0, 'spring-boot': 0, quarkus: 0, micronaut: 0,
  android: 0, play: 0, aspnetcore: 0, blazor: 0, maui: 0, wpf: 0, winforms: 0, vapor: 0, 'shopify-theme': 0,
  express: 1, fastify: 1, koa: 1, hono: 1, inertia: 1, livewire: 1, slim: 1, fastapi: 1, flask: 1, celery: 1, sinatra: 1, sidekiq: 1,
  gin: 1, echo: 1, chi: 1, fiber: 1, 'gorilla-mux': 1, axum: 1, 'actix-web': 1, rocket: 1, warp: 1, ktor: 1, 'akka-http': 1, http4s: 1,
  react: 2, vue: 2, svelte: 2,
};
const NODE: Record<string, string> = {
  next: 'nextjs', nuxt: 'nuxt', '@sveltejs/kit': 'sveltekit', astro: 'astro', '@remix-run/react': 'remix', '@remix-run/node': 'remix', '@nestjs/core': 'nestjs',
  '@angular/core': 'angular', expo: 'expo', 'react-native': 'react-native', electron: 'electron', '@capacitor/core': 'capacitor', '@tauri-apps/api': 'tauri',
  express: 'express', fastify: 'fastify', koa: 'koa', hono: 'hono',
  '@inertiajs/react': 'inertia', '@inertiajs/vue3': 'inertia', '@inertiajs/svelte': 'inertia', '@inertiajs/inertia': 'inertia',
  react: 'react', vue: 'vue', svelte: 'svelte',
};
const PHP: Record<string, string> = {
  'laravel/framework': 'laravel', 'symfony/framework-bundle': 'symfony', 'cakephp/cakephp': 'cakephp', 'yiisoft/yii2': 'yii', 'drupal/core': 'drupal',
  'drupal/core-recommended': 'drupal', 'inertiajs/inertia-laravel': 'inertia', 'livewire/livewire': 'livewire', 'slim/slim': 'slim',
};
const PYTHON: Record<string, string> = { django: 'django', fastapi: 'fastapi', flask: 'flask', celery: 'celery' };
const RUBY: Record<string, string> = { rails: 'rails', hanami: 'hanami', jekyll: 'jekyll', sinatra: 'sinatra', sidekiq: 'sidekiq' };
/** Gems of a Gemfile that only builds or checks something else (iOS releases, linters). */
const TOOLING_GEMS = /^(fastlane|cocoapods(-.+)?|danger|xcpretty|xcodeproj|xcov|slather|jazzy|rubocop(-.+)?|overcommit|rake|bundler)$/;
/** Go module paths, also matched with a major-version suffix (`/v5`). */
const GO: Record<string, string> = { 'github.com/gin-gonic/gin': 'gin', 'github.com/labstack/echo': 'echo', 'github.com/go-chi/chi': 'chi', 'github.com/gofiber/fiber': 'fiber', 'github.com/gorilla/mux': 'gorilla-mux' };
const RUST: Record<string, string> = { axum: 'axum', 'actix-web': 'actix-web', rocket: 'rocket', warp: 'warp', tauri: 'tauri' };
const JVM: [RegExp, string][] = [
  [/org\.springframework\.boot/, 'spring-boot'], [/io\.quarkus/, 'quarkus'], [/io\.micronaut/, 'micronaut'], [/io\.ktor/, 'ktor'],
  [/com\.android\.(application|library)|plugins\.android\.(application|library)/, 'android'], [/com\.typesafe\.play|org\.playframework/, 'play'],
  [/akka-http/, 'akka-http'], [/http4s/, 'http4s'],
];
const DOTNET: [RegExp, string][] = [
  [/Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"|Microsoft\.AspNetCore\.Components\.WebAssembly/i, 'blazor'],
  [/Sdk="Microsoft\.NET\.Sdk\.Web"|Include="Microsoft\.AspNetCore\./i, 'aspnetcore'],
  [/<UseMaui>\s*true/i, 'maui'], [/<UseWPF>\s*true/i, 'wpf'], [/<UseWindowsForms>\s*true/i, 'winforms'],
];

export interface DirectoryManifests {
  /** Ecosystems of the manifests found, by priority. */
  ecosystems: Ecosystem[];
  /** Frameworks they declare, by rank, then ecosystem priority. */
  frameworks: string[];
  /** Some manifest declares an application: not only a workspace or tooling. */
  application: boolean;
}
type Role = 'application' | 'workspace' | 'tooling';
interface Found { ecosystem: Ecosystem; role: Role; frameworks: string[] }

/**
 * The manifests of one directory, given its entry names; undefined when it
 * has none. `label` is the directory's repository-relative path, for errors:
 * a manifest that cannot be parsed is an error, as an unread one would
 * silently change what is analyzed.
 */
export async function readManifests(directory: string, entries: string[], label: string): Promise<DirectoryManifests | undefined> {
  const names = new Set(entries);
  const text = (name: string) => readFile(path.join(directory, name), 'utf8');
  const invalid = (name: string) => new Error(`Invalid manifest: ${label === '.' ? name : `${label}/${name}`}`);
  const json = async (name: string): Promise<Record<string, unknown>> => {
    try { const value: unknown = JSON.parse(await text(name)); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* reported below */ }
    throw invalid(name);
  };
  const toml = async (name: string): Promise<Record<string, unknown>> => { try { return parseToml(await text(name)) as Record<string, unknown>; } catch { throw invalid(name); } };
  const found: Found[] = [];
  const add = (ecosystem: Ecosystem, role: Role, frameworks: string[] = []) => found.push({ ecosystem, role, frameworks });

  if (names.has('package.json')) {
    const manifest = await json('package.json');
    const frameworks = recognized([manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].flatMap(keys), NODE);
    const workspace = names.has('pnpm-workspace.yaml') || names.has('lerna.json') || (Array.isArray(manifest.workspaces) ? manifest.workspaces.length > 0 : !!manifest.workspaces);
    const runtime = [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies].some(value => keys(value).length > 0);
    const entry = ['main', 'module', 'exports', 'bin', 'types', 'typings', 'browser'].some(key => manifest[key] !== undefined);
    // A workspace root is not an application, unless it is a Next.js or Laravel application itself.
    add('node', frameworks.some(framework => OWNING_NODE_FRAMEWORKS.has(framework)) ? 'application' : workspace ? 'workspace' : frameworks.length || runtime || entry ? 'application' : 'tooling', frameworks);
  } else if (names.has('pnpm-workspace.yaml')) add('node', 'workspace');
  if (names.has('composer.json')) {
    const manifest = await json('composer.json');
    const required = keys(manifest.require);
    const frameworks = recognized(required, PHP);
    const runtime = required.some(name => !/^(php|ext-.+|lib-.+|composer-.+)$/.test(name));
    add('php', frameworks.length || runtime || manifest.autoload !== undefined ? 'application' : 'tooling', frameworks);
  }
  const requirements = entries.filter(name => /^requirements[\w.-]*\.txt$/i.test(name));
  if (names.has('pyproject.toml') || names.has('Pipfile') || names.has('setup.py') || names.has('setup.cfg') || requirements.length || names.has('manage.py')) {
    const dependencies: string[] = [];
    let declared = false, workspace = false;
    if (names.has('pyproject.toml')) {
      const manifest = await toml('pyproject.toml');
      const project = record(manifest.project), tool = record(manifest.tool), poetry = record(tool.poetry);
      declared = manifest.project !== undefined || tool.poetry !== undefined;
      workspace = !declared && record(tool.uv).workspace !== undefined;
      dependencies.push(...strings(project.dependencies), ...Object.values(record(project['optional-dependencies'])).flatMap(strings), ...keys(poetry.dependencies));
    }
    if (names.has('Pipfile')) { const manifest = await toml('Pipfile'); dependencies.push(...keys(manifest.packages), ...keys(manifest['dev-packages'])); }
    for (const name of requirements) dependencies.push(...(await text(name)).split('\n').map(line => line.replace(/#.*/, '').trim()).filter(line => line && !line.startsWith('-')));
    // setup.py is code and setup.cfg free-form: their requirements are matched by name in the text, as build scripts are.
    for (const name of ['setup.py', 'setup.cfg']) if (names.has(name)) dependencies.push(...(await text(name)).match(/[A-Za-z][\w.-]*/g) ?? []);
    const frameworks = recognized(dependencies.map(pythonPackage), PYTHON);
    if (names.has('manage.py') && (await text('manage.py')).includes('DJANGO_SETTINGS_MODULE') && !frameworks.includes('django')) frameworks.unshift('django');
    const other = names.has('Pipfile') || names.has('setup.py') || names.has('setup.cfg') || requirements.length > 0 || names.has('manage.py');
    add('python', declared || other || frameworks.length ? 'application' : workspace ? 'workspace' : 'tooling', frameworks);
  }
  const gemspec = entries.some(name => name.endsWith('.gemspec'));
  if (names.has('Gemfile') || gemspec) {
    const gems = names.has('Gemfile') ? [...(await text('Gemfile')).matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map(match => match[1]!) : [];
    const frameworks = recognized(gems, RUBY);
    add('ruby', frameworks.length || gemspec || gems.some(gem => !TOOLING_GEMS.test(gem)) ? 'application' : 'tooling', frameworks);
  }
  if (names.has('go.mod')) {
    const modules = [...(await text('go.mod')).matchAll(/^\s*(?:require\s+)?([a-z0-9][\w.-]*\.[a-z]{2,}\/[^\s]+)\s+v[\d.]/gm)].map(match => match[1]!.replace(/\/v\d+$/, ''));
    add('go', 'application', recognized(modules, GO));
  } else if (names.has('go.work')) add('go', 'workspace');
  if (names.has('Cargo.toml')) {
    const manifest = await toml('Cargo.toml');
    const workspace = record(manifest.workspace);
    const frameworks = recognized([...keys(manifest.dependencies), ...keys(workspace.dependencies)], RUST);
    add('rust', manifest.package !== undefined || manifest.workspace === undefined ? 'application' : 'workspace', frameworks);
  }
  const gradle = entries.filter(name => /^build\.gradle(\.kts)?$/.test(name));
  const settings = entries.find(name => /^settings\.gradle(\.kts)?$/.test(name));
  if (names.has('pom.xml') || gradle.length || settings || names.has('build.sbt')) {
    let source = '';
    for (const name of ['pom.xml', ...gradle, 'build.sbt']) if (names.has(name)) source += `${await text(name)}\n`;
    if (names.has('project')) source += await text('project/plugins.sbt').catch(() => '');
    const pom = names.has('pom.xml') ? await text('pom.xml') : '';
    const aggregator = /<packaging>\s*pom\s*<\/packaging>/.test(pom) && /<modules>/.test(pom);
    const multiProject = settings ? /^\s*include\b|\binclude\s*\(/m.test(await text(settings)) : false;
    const frameworks = JVM.filter(([pattern]) => pattern.test(source)).map(([, framework]) => framework);
    add('jvm', frameworks.length === 0 && (aggregator || multiProject) ? 'workspace' : 'application', frameworks);
  }
  const projects = entries.filter(name => /\.(csproj|fsproj|vbproj)$/.test(name));
  if (projects.length) {
    let source = '';
    for (const name of projects) source += `${await text(name)}\n`;
    add('dotnet', 'application', DOTNET.filter(([pattern]) => pattern.test(source)).map(([, framework]) => framework));
  } else if (entries.some(name => /\.slnx?$/.test(name))) add('dotnet', 'workspace');
  if (names.has('Package.swift')) add('swift', 'application', /github\.com\/vapor\/vapor/.test(await text('Package.swift')) ? ['vapor'] : []);
  if (entries.some(name => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))) add('xcode', 'application');
  if (names.has('CMakeLists.txt') || names.has('meson.build')) add('native', 'application');
  if (names.has('layout') && (names.has('sections') || names.has('templates')) && await text('layout/theme.liquid').then(() => true, () => false)) add('shopify', 'application', ['shopify-theme']);

  if (!found.length) return undefined;
  const priority = (ecosystem: Ecosystem) => ECOSYSTEMS.indexOf(ecosystem);
  found.sort((a, b) => priority(a.ecosystem) - priority(b.ecosystem));
  const frameworks = found.flatMap(item => item.frameworks.map(framework => ({ framework, rank: RANK[framework] ?? 1, priority: priority(item.ecosystem) })))
    .sort((a, b) => a.rank - b.rank || a.priority - b.priority);
  return {
    ecosystems: [...new Set(found.map(item => item.ecosystem))],
    frameworks: [...new Set(frameworks.map(item => item.framework))],
    application: found.some(item => item.role === 'application'),
  };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function keys(value: unknown): string[] { return Object.keys(record(value)); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
/** A Python requirement's distribution name, normalized (PEP 503): `Django[argon2]>=4.2` → `django`. */
function pythonPackage(requirement: string): string { return (requirement.trim().split(/[\s<>=!~;[(@]/)[0] ?? '').toLowerCase().replace(/[-_.]+/g, '-'); }
/** Known frameworks among declared package names, in the table's order. */
function recognized(packages: string[], table: Record<string, string>): string[] {
  const declared = new Set(packages);
  const result: string[] = [];
  for (const [name, framework] of Object.entries(table)) if (declared.has(name) && !result.includes(framework)) result.push(framework);
  return result;
}
