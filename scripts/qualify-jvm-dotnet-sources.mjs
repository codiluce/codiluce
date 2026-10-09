// Pinned, unchanged upstream-source portfolio. No target tools or dependencies run.
// Checkouts must be at these exact commits; see the generated HTML for inputs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
for (const flag of ['--spring-rest', '--spring-reactive', '--aspnet-docs']) assert.ok(option(flag), `${flag} checkout path required`);
const spring = (name, flag, repository, commit, prefix, stack, scan) => ({ name, flag, repository, commit, prefix, script: 'qualify-jvm-source.mjs', inputs: { applications: [{ name: 'sample', path: prefix, jvm: { spring: { version: '7.0.0', stack, componentScan: [scan] } } }] } });
const microsoft = (name, prefix, subproject) => ({ name, flag: '--aspnet-docs', repository: 'dotnet/AspNetCore.Docs', commit: 'e073388af85c37ed5207ca8bed5ea3445fcefcdd', prefix, script: 'qualify-csharp-source.mjs', inputs: { applications: [{ name: 'sample', path: prefix, ...(subproject ? { dotnet: { project: subproject } } : {}) }] } });
const samples = [
  spring('Spring MVC Java', '--spring-rest', 'spring-guides/gs-rest-service', '3f4cef01152596c19bc4d37939409358812b1421', 'complete', 'mvc', 'com.example.restservice'),
  spring('Spring MVC Kotlin', '--spring-rest', 'spring-guides/gs-rest-service', '3f4cef01152596c19bc4d37939409358812b1421', 'complete-kotlin', 'mvc', 'com.example.restservice'),
  spring('Spring WebFlux Java', '--spring-reactive', 'spring-guides/gs-reactive-rest-service', 'a6f4ff0c651545a14ff5d1f731fde9a8d136e4d5', 'complete', 'webflux', 'com.example.reactivewebservice'),
  spring('Spring WebFlux Kotlin', '--spring-reactive', 'spring-guides/gs-reactive-rest-service', 'a6f4ff0c651545a14ff5d1f731fde9a8d136e4d5', 'complete-kotlin', 'webflux', 'com.example.reactivewebservice'),
  microsoft('.NET 8 minimal separate-file', 'aspnetcore/fundamentals/minimal-apis/8.0-samples/MinAPISeparateFile'),
  microsoft('.NET 8 MVC filters', 'aspnetcore/mvc/controllers/filters/samples/8.x/FiltersSample'),
  microsoft('.NET 9 MVC Mongo sample', 'aspnetcore/tutorials/first-mongo-app/samples/9.x/BookStoreApi'),
  microsoft('.NET 10 MVC source-project reference', 'aspnetcore/fundamentals/openapi/samples/10.x/aspnet-openapi-xml-controllers', 'api/Api.csproj'),
];
const run = promisify(execFile), results = [];
for (const sample of samples) {
  console.log(`Qualifying ${sample.name}`);
  const source = path.resolve(option(sample.flag));
  const { stdout } = await run(process.execPath, ['--experimental-sqlite', '--import', 'tsx', path.join(project, 'scripts', sample.script), '--source', source, '--commit', sample.commit, '--prefix', sample.prefix, '--inputs', JSON.stringify(sample.inputs)], { cwd: project, timeout: 300_000, maxBuffer: 32 << 20 });
  const evidence = JSON.parse(stdout); assert.equal(evidence.commit, sample.commit); assert.ok(evidence.cacheEqual && evidence.revisionEqual && /^[a-f\d]{64}$/.test(evidence.trackedBlobDigest));
  results.push({ name: sample.name, url: `https://github.com/${sample.repository}/tree/${sample.commit}/${sample.prefix}`, evidence });
}
const data = { measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, results };
const escaped = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const rows = results.map(({ name, url, evidence: e }) => {
  const aspnet = e.aspnet, endpoints = aspnet?.endpoints ?? e.springEndpoints, constrained = aspnet ? endpoints - (aspnet.registrations.selected ?? 0) : e.constrainedSpringEndpoints;
  const importCounts = Object.entries(e.imports).map(([status, count]) => `${status}: ${count}`).join(', ');
  return `<tr><th><a href="${escaped(url)}">${escaped(name)}</a><small>${escaped(e.commit.slice(0, 8))} · ${e.copiedFiles} tracked inputs</small></th><td>${typeof e.files === 'number' ? e.files : Object.entries(e.files).map(([language, count]) => `${language}: ${count}`).join(', ')}</td><td>${e.declarations}</td><td>${escaped(importCounts)}</td><td>${e.callEdges}</td><td>${endpoints}<small>${constrained} constrained</small></td><td>${aspnet?.handlers ?? e.springHandlers}</td><td>Equal</td></tr>`;
}).join('');
const output = path.resolve(option('--output') ?? path.join(project, 'docs/jvm-dotnet-source-qualification.html'));
await writeFile(output, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JVM/.NET unchanged source qualification</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101822;color:#e5ecf4;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{line-height:1.2}p{max-width:1000px;color:#bdcbdc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344353;padding:12px;vertical-align:top}small{display:block;color:#9dafc4;font-weight:400}a,code{color:#79ced3}code{overflow-wrap:anywhere}.status{border:1px solid #5a7882;padding:16px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:18px}}</style><main><h1>JVM/.NET unchanged source qualification</h1><p>${escaped(data.measuredAt)} · ${escaped(data.node)} · ${escaped(data.platform)}.</p><p class="status"><strong>Eight pinned source snapshots: PASS</strong> — unchanged tracked-blob identity, original declarations/imports/calls/handlers, source ranges and exact cold/warm/revision graph equality. Counts below show integration outcomes; constrained or absent endpoints remain explicit gaps.</p><div class="scroll"><table><thead><tr><th>Original source</th><th>Source files</th><th>Declarations</th><th>Import outcomes</th><th>Direct calls</th><th>Endpoints</th><th>Original handlers</th><th>Replay</th></tr></thead><tbody>${rows}</tbody></table></div><p>Original Microsoft inputs cover .NET 8/9/10; original Spring guides cover Java/Kotlin MVC and WebFlux. The Spring 7.0.0 routing family and scan packages are recorded qualification assumptions, not a derived BOM, restored classpath or runtime claim. The raw inputs below retain every selected value, project model, dependency gap and route condition. Dual Maven/Gradle ownership, unavailable parents/BOMs/plugins, Kotlin compiler behavior, DI factories, filters, database/binary services, source metadata, OpenAPI generators and middleware remain unresolved. A source helper/handler edge does not certify request completion or runtime behavior. Broad recall, native Windows/macOS and release accuracy remain P10 gates.</p><p>The scripts verify checkout HEAD and tracked-file differences, copy only regular blobs directly from each pinned Git tree, include ancestor build metadata, retain a SHA-256 digest of copied paths/modes/bytes and validate original source ranges. They run Codiluce's own Node/parser/indexer only. No JVM/.NET/MSBuild/Maven/Gradle, target dependency, configuration, compiler or generator executes. No upstream source, manifest, TFM or plugin is rewritten.</p><p>Reproduce with exact pinned checkouts: <code>node scripts/qualify-jvm-dotnet-sources.mjs --spring-rest /path/to/gs-rest-service --spring-reactive /path/to/gs-reactive-rest-service --aspnet-docs /path/to/AspNetCore.Docs</code>. Each row links its immutable original source; full commits and inputs appear below. <a href="jvm-dotnet-compatibility-performance.html">Local performance</a> · <a href="language-framework-compatibility.html#implementation">Roadmap</a>.</p><details><summary>Raw source evidence and recorded inputs</summary><pre>${escaped(JSON.stringify(data, null, 2))}</pre></details></main></html>`);
console.log(JSON.stringify({ output, snapshots: results.length, cacheEqual: true, revisionEqual: true }, null, 2));
