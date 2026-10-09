import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import { readMsbuildXml, dotnetPath, dotnetGlob, msbuildCondition } from '../src/analysis/resolution/dotnet-data.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-csharp-'));
    roots.push(root);
    for (const [file, text] of Object.entries(files))
        await put(root, file, text);
    return root;
}
const sdk = (extra = '', props = '') => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>${props}</PropertyGroup>${extra}</Project>`;
async function index(root: string, applications?: ApplicationInput[], cache?: AnalysisCache, revision?: string, ignore?: string[]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'csharp-fixture' }, applications, ignore }), cache, revision }); }
const unit = (graph: SoftwareGraph, file: string) => graph.entities.find(entity => entity.type === 'file' && entity.path === file)!;
const imports = (graph: SoftwareGraph, file: string) => unit(graph, file).metadata.importOutcomes as {
    specifier: string;
    kind: string;
    origin: string;
    global: boolean;
    range: {
        startLine: number;
    };
    outcome: {
        status: string;
        reason?: string;
        targets?: string[];
        declarations?: string[];
        proof?: {
            file?: string;
            line?: number;
        }[];
    };
}[];
const statuses = (graph: SoftwareGraph, file: string) => imports(graph, file).map(item => item.outcome.status);
const names = (graph: SoftwareGraph, item: ReturnType<typeof imports>[number]) => (item.outcome.declarations ?? []).map(id => graph.entities.find(entity => entity.id === id)?.metadata.qualifiedName);
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
test('MSBuild data readers reject external entities, malformed XML, opaque paths and expressions', () => {
    assert.ok(readMsbuildXml('<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><X>a&amp;b</X></PropertyGroup></Project>'));
    for (const text of ['<!DOCTYPE Project SYSTEM "file:///tmp/secret"><Project/>', '<Project>&evil;</Project>', '<Project><A></Project>', '<project/>', '<Project xmlns="http://other/"/>', '<Project a=x/>'])
        assert.equal(readMsbuildXml(text), undefined, text);
    assert.equal(dotnetPath('app', '..\\shared\\Model.cs'), 'shared/Model.cs');
    for (const value of ['../../outside.cs', 'C:\\secret.cs', '\\\\server\\share.cs', '$(Files)', '%(Identity)', 'X%3B.cs'])
        assert.equal(dotnetPath('app', value), undefined, value);
    assert.ok(dotnetGlob('app/**/*.cs', 'app/A.cs'));
    assert.ok(dotnetGlob('app/**/*.cs', 'app/sub/A.cs'));
    assert.ok(!dotnetGlob('app/*.cs', 'app/sub/A.cs'));
    assert.equal(msbuildCondition("('Debug' == 'debug' And true) Or false", () => false), true);
    assert.equal(msbuildCondition("!Exists('unknown')", () => undefined), undefined);
    assert.equal(msbuildCondition("'$(Configuration)'=='Debug'", () => false), undefined);
    assert.equal(msbuildCondition("$([System.IO.File]::ReadAllText('secret'))", () => false), undefined);
});
test('C# facts retain original namespaces, using scopes, aliases, generic arity and partial fragments', async () => {
    const parser = new StructureParser();
    try {
        const source = '// 😀\r\nglobal using Shared = global::Demo.Tools;\r\nnamespace Api;\r\nusing Demo;\r\npublic partial class Controller<T> { public static int VALUE=1; private class Hidden{} public void Run(){} }';
        const facts = await parser.parse('csharp', source), syntax = facts.csharp!;
        assert.equal(syntax.complete, true);
        assert.deepEqual(syntax.gaps, []);
        assert.deepEqual(syntax.imports.map(item => [item.kind, item.specifier, item.namespace, item.range.startLine]), [['alias', 'global::Demo.Tools', '', 2], ['namespace', 'Demo', 'Api', 4]]);
        assert.equal(syntax.imports[0]!.global, true);
        const controller = syntax.declarations.find(item => item.name === 'Controller')!;
        assert.equal(controller.arity, 1);
        assert.equal(controller.partial, true);
        assert.equal(controller.qualifiedName, 'Api.Controller');
        const value = syntax.declarations.find(item => item.name === 'VALUE')!;
        assert.equal(value.visibility, 'public');
        assert.equal(value.static, true);
        assert.equal(value.parent, controller.key);
        assert.equal(syntax.declarations.find(item => item.name === 'Hidden')!.visibility, 'private');
    }
    finally {
        parser.close();
    }
});
test('SDK compile globs expose original namespace types but no nested namespaces or private exports', async () => {
    const root = await repository({ 'app/A.csproj': sdk(), 'app/Types.cs': 'namespace Demo { public class One {} internal class Local {} public class Outer { public class Nested {} private class Hidden {} } } namespace Demo.Child { public class Two {} }', 'app/Use.cs': '// 😀\r\nusing Demo;\r\nusing System.IO;\r\npublic class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'app/Use.cs'), ['resolved', 'external'], JSON.stringify(graph.diagnostics));
    assert.deepEqual(names(graph, imports(graph, 'app/Use.cs')[0]!).sort(), ['Demo.Local', 'Demo.One', 'Demo.Outer']);
    assert.equal(imports(graph, 'app/Use.cs')[0]!.range.startLine, 2);
    assert.ok(graph.relations.some(edge => edge.type === 'imports' && edge.from === unit(graph, 'app/Use.cs').id && edge.to === unit(graph, 'app/Types.cs').id));
    assert.equal((unit(graph, 'app/Use.cs').metadata.analysis as any).features.references.status, 'unsupported');
    assert.equal(graph.relations.filter(edge => edge.type === 'calls').length, 0);
});
test('C# aliases and static usings retain original type/member overload sets without inherited members', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Tools.cs': 'namespace Demo; public class Base { public static void Inherited(){} } public class Tools:Base { public static int VALUE=1; public static void Run(){} public static void Run(int x){} private static void Hidden(){} public void Instance(){} public class Nested{} }', 'Use.cs': 'using Alias=global::Demo.Tools; using static Demo.Tools; using N=Demo; using static Demo; using Demo.Tools; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved', 'resolved', 'resolved', 'unresolved', 'unresolved']);
    const staticNames = names(graph, imports(graph, 'Use.cs')[1]!);
    assert.equal(staticNames.filter(name => name === 'Demo.Tools.Run').length, 2);
    for (const name of ['Demo.Tools', 'Demo.Tools.VALUE', 'Demo.Tools.Nested'])
        assert.ok(staticNames.includes(name), name);
    for (const name of ['Demo.Base.Inherited', 'Demo.Tools.Hidden', 'Demo.Tools.Instance'])
        assert.ok(!staticNames.includes(name), name);
});
test('Block namespace directives resolve relative ancestors and global qualification', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Api.Demo { public class Local {} } namespace Demo { public class Global {} }', 'Use.cs': 'namespace Api { using Demo; namespace Child { using Demo; using global::Demo; public class Use{} } }' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved', 'resolved', 'resolved']);
    assert.deepEqual(names(graph, imports(graph, 'Use.cs')[1]!), ['Api.Demo.Local']);
    assert.deepEqual(names(graph, imports(graph, 'Use.cs')[2]!), ['Demo.Global']);
    assert.ok(imports(graph, 'Use.cs').every(item => (item as any).scopeStart >= 0));
});
test('ProjectReference traverses original SDK dependencies but excludes siblings and internal cross-assembly types', async () => {
    const root = await repository({ 'app/A.csproj': sdk('<ItemGroup><ProjectReference Include="..\\lib\\B.csproj"/></ItemGroup>'), 'lib/B.csproj': sdk('<ItemGroup><ProjectReference Include="../leaf/C.csproj"/></ItemGroup>'), 'leaf/C.csproj': sdk(), 'other/D.csproj': sdk(), 'lib/Types.cs': 'namespace Demo; public class Public{} internal class Hidden{}', 'leaf/Types.cs': 'namespace Leaf; public class End{}', 'other/Types.cs': 'namespace Other; public class Outside{}', 'app/Use.cs': 'using Demo; using H=Demo.Hidden; using Leaf; using Other; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'app/Use.cs'), ['resolved', 'unresolved', 'resolved', 'external']);
    assert.deepEqual(names(graph, imports(graph, 'app/Use.cs')[0]!), ['Demo.Public']);
    assert.ok(imports(graph, 'app/Use.cs')[0]!.outcome.proof?.some(item => item.file === 'lib/B.csproj'));
    assert.deepEqual(names(graph, imports(graph, 'app/Use.cs')[2]!), ['Leaf.End']);
});
test('DisableTransitiveProjectReferences and ReferenceOutputAssembly=false constrain original dependencies', async () => {
    const root = await repository({ 'a/A.csproj': sdk('<ItemGroup><ProjectReference Include="../b/B.csproj"/><ProjectReference Include="../d/D.csproj"><ReferenceOutputAssembly>false</ReferenceOutputAssembly></ProjectReference></ItemGroup>', '<DisableTransitiveProjectReferences>true</DisableTransitiveProjectReferences>'), 'b/B.csproj': sdk('<ItemGroup><ProjectReference Include="../c/C.csproj"/></ItemGroup>'), 'c/C.csproj': sdk(), 'd/D.csproj': sdk(), 'b/B.cs': 'namespace B; public class Type{}', 'c/C.cs': 'namespace C; public class Type{}', 'd/D.cs': 'namespace D; public class Type{}', 'a/Use.cs': 'using B; using C; using D; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'a/Use.cs'), ['resolved', 'external', 'external']);
});
test('Original global usings stay within a compilation and never leak from referenced projects', async () => {
    const root = await repository({ 'a/A.csproj': sdk('<ItemGroup><ProjectReference Include="../b/B.csproj"/></ItemGroup>'), 'b/B.csproj': sdk(), 'a/Global.cs': 'global using AAlias=B.Type; global using B;', 'b/Global.cs': 'global using Leaked=System.IO;', 'b/Types.cs': 'namespace B; public class Type{}', 'a/Use.cs': 'public class Use{}', 'b/Use.cs': 'public class Use{}' }), graph = await index(root);
    assert.deepEqual(imports(graph, 'a/Use.cs').map(item => [item.specifier, item.origin]), [['B.Type', 'a/Global.cs'], ['B', 'a/Global.cs']]);
    assert.ok(imports(graph, 'a/Use.cs').every(item => item.global && item.outcome.status === 'resolved'));
    assert.deepEqual(imports(graph, 'b/Use.cs').map(item => item.specifier), ['System.IO']);
});
test('MSBuild Using items retain original XML proof and do not fabricate generated source files', async () => {
    const root = await repository({ 'A.csproj': sdk('<ItemGroup><Using Include="Demo.Tools" Alias="Tools"/><Using Include="Demo.Tools" Static="true"/><Using Include="Demo"/></ItemGroup>'), 'Tools.cs': 'namespace Demo; public class Tools {public static void Run(){}}', 'Use.cs': 'public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved', 'resolved', 'resolved']);
    assert.ok(imports(graph, 'Use.cs').every(item => item.origin === 'A.csproj' && item.outcome.proof?.some(proof => proof.file === 'A.csproj')));
    assert.ok(!graph.entities.some(entity => entity.path?.includes('GlobalUsings.g.cs')));
});
test('Compile include/remove/exclude and literal linked Windows paths select originals', async () => {
    const root = await repository({ 'a/A.csproj': sdk('<ItemGroup><Compile Include="../shared/*.cs" Exclude="../shared/Skip.cs"/><Compile Remove="Removed.cs"/><Compile Update="Use.cs"><Visible>true</Visible></Compile></ItemGroup>'), 'a/Use.cs': 'using Shared; using Removed; public class Use{}', 'a/Removed.cs': 'namespace Removed; public class Hidden{}', 'shared/Types.cs': 'namespace Shared; public class Type{}', 'shared/Skip.cs': 'namespace Shared; public class Skip{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'a/Use.cs'), ['resolved', 'external']);
    assert.deepEqual(names(graph, imports(graph, 'a/Use.cs')[0]!), ['Shared.Type']);
    assert.deepEqual((unit(graph, 'a/Removed.cs').metadata.analysis as any).features.imports.status, 'disabled');
});
test('Nested SDK projects preserve overlapping compilation ownership and explicit dotnet.project selection', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'nested/B.csproj': sdk(), 'nested/Use.cs': 'using Demo; public class Use{}', 'Types.cs': 'namespace Demo; public class Outer{}', 'nested/Types.cs': 'namespace Demo; public class Inner{}' }), unknown = await index(root);
    assert.deepEqual(statuses(unknown, 'nested/Use.cs'), ['unsupported']);
    assert.equal((unit(unknown, 'nested/Use.cs').metadata.csharpCompilation as any).candidates.length, 2);
    const selected = await index(root, [{ name: 'app', path: '.', dotnet: { project: 'nested/B.csproj' } }]);
    assert.deepEqual(statuses(selected, 'nested/Use.cs'), ['resolved']);
    assert.deepEqual(names(selected, imports(selected, 'nested/Use.cs')[0]!), ['Demo.Inner']);
});
test('Linked sources retain original IDs across owning compilations and require a selected owner', async () => {
    const root = await repository({ 'a/A.csproj': sdk('<ItemGroup><Compile Include="..\\shared\\Types.cs"><Link>Types.cs</Link></Compile></ItemGroup>'), 'b/B.csproj': sdk('<ItemGroup><Compile Include="../shared/Types.cs"/></ItemGroup>'), 'shared/Types.cs': 'using System; namespace Shared; public class Type{}', 'a/Use.cs': 'using Shared; public class Use{}', 'b/Use.cs': 'using Shared; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'shared/Types.cs'), ['unsupported']);
    assert.deepEqual(statuses(graph, 'a/Use.cs'), ['resolved']);
    assert.deepEqual(imports(graph, 'a/Use.cs')[0]!.outcome.declarations, imports(graph, 'b/Use.cs')[0]!.outcome.declarations);
});
test('Explicit non-SDK compile items and configured source roots preserve original namespaces', async () => {
    const root = await repository({ 'legacy/Old.csproj': '<Project><ItemGroup><Compile Include="Types.cs;Use.cs"/></ItemGroup></Project>', 'legacy/Types.cs': 'namespace Actual; public class Type{}', 'legacy/Use.cs': 'using Actual; public class Use{}', 'legacy/Outside.cs': 'namespace Actual; public class Outside{}', 'configured/src/Types.cs': 'namespace Recorded; public class Type{}', 'configured/src/Use.cs': 'using Recorded; public class Use{}' }), graph = await index(root, [{ name: 'legacy', path: 'legacy' }, { name: 'configured', path: 'configured', sourceRoots: { csharp: ['src'] } }]);
    assert.deepEqual(statuses(graph, 'legacy/Use.cs'), ['resolved']);
    assert.deepEqual(names(graph, imports(graph, 'legacy/Use.cs')[0]!), ['Actual.Type']);
    assert.deepEqual(statuses(graph, 'configured/src/Use.cs'), ['resolved']);
});
test('Directory.Build nearest props/targets, literal imports and two-pass property/item order select sources', async () => {
    const root = await repository({ 'Directory.Build.props': '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>', 'app/Directory.Build.props': '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems><SourceDir>src</SourceDir></PropertyGroup><ItemGroup><Compile Include="$(SourceDir)/*.cs"/></ItemGroup></Project>', 'app/A.csproj': sdk('<Import Project="config/extra.props"/><PropertyGroup><SourceDir>final</SourceDir></PropertyGroup>'), 'app/config/extra.props': '<Project><ItemGroup><Compile Include="$(MSBuildThisFileDirectory)Added.cs"/></ItemGroup></Project>', 'app/Directory.Build.targets': '<Project><ItemGroup><Compile Remove="final/Removed.cs"/></ItemGroup></Project>', 'app/final/Use.cs': 'using Demo; public class Use{}', 'app/final/Types.cs': 'namespace Demo; public class Final{}', 'app/final/Removed.cs': 'namespace Demo; public class Removed{}', 'app/src/Wrong.cs': 'namespace Demo; public class Wrong{}', 'app/config/Added.cs': 'namespace Demo; public class Added{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'app/final/Use.cs'), ['resolved'], JSON.stringify(graph.diagnostics));
    assert.deepEqual(names(graph, imports(graph, 'app/final/Use.cs')[0]!).sort(), ['Demo.Added', 'Demo.Final']);
});
test('Directory.Build.props removals precede SDK default items; project removals follow them', async () => {
    const root = await repository({ 'Directory.Build.props': '<Project><ItemGroup><Compile Remove="Types.cs"/></ItemGroup></Project>', 'A.csproj': sdk(), 'Types.cs': 'namespace Demo; public class StillIncluded{}', 'Use.cs': 'using Demo; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved']);
    assert.deepEqual(names(graph, imports(graph, 'Use.cs')[0]!), ['Demo.StillIncluded']);
});
test('Multi-target and configuration conditions require recorded selections without host defaults', async () => {
    const root = await repository({ 'A.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net9.0;net10.0</TargetFrameworks></PropertyGroup><ItemGroup Condition="\'$(TargetFramework)\'==\'net10.0\' And \'$(Configuration)\'==\'Release\'"><Compile Remove="Other.cs"/></ItemGroup></Project>', 'Types.cs': 'namespace Demo; public class Selected{}', 'Other.cs': 'namespace Demo; public class Other{}', 'Use.cs': 'using Demo; public class Use{}' }), unknown = await index(root);
    assert.deepEqual(statuses(unknown, 'Use.cs'), ['unsupported']);
    const selected = await index(root, [{ name: 'app', path: '.', dotnet: { targetFramework: 'net10.0', configuration: 'Release' } }]);
    assert.deepEqual(statuses(selected, 'Use.cs'), ['resolved']);
    assert.deepEqual(names(selected, imports(selected, 'Use.cs')[0]!), ['Demo.Selected']);
});
test('Unknown conditions, functions, executable targets, SDKs and imports remain constrained without execution', async () => {
    for (const extra of ['<ItemGroup Condition="\'$(Unknown)\'==\'x\'"><Compile Remove="Types.cs"/></ItemGroup>', '<PropertyGroup><X>$([System.IO.File]::ReadAllText(\'secret\'))</X></PropertyGroup>', '<Target Name="Generate"><Exec Command="touch /tmp/codiluce-unwanted-msbuild"/></Target>', '<Import Project="missing.props"/>', '<Choose><When Condition="true"><ItemGroup/></When></Choose>']) {
        const root = await repository({ 'A.csproj': sdk(extra), 'Types.cs': 'namespace Demo; public class Type{}', 'Use.cs': 'using Demo; public class Use{}' }), graph = await index(root);
        assert.deepEqual(statuses(graph, 'Use.cs'), ['unsupported'], extra);
        assert.equal(graph.relations.filter(edge => edge.type === 'imports').length, 0);
    }
    const root = await repository({ 'A.csproj': '<Project Sdk="Unknown.Sdk"><ItemGroup><Compile Include="*.cs"/></ItemGroup></Project>', 'Types.cs': 'namespace Demo; public class Type{}', 'Use.cs': 'using Demo; public class Use{}' });
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
});
test('Duplicate compile items and cyclic project/import graphs cannot certify imports', async () => {
    const root = await repository({ 'A.csproj': sdk('<ItemGroup><Compile Include="Types.cs"/></ItemGroup>'), 'Types.cs': 'namespace Demo; public class Type{}', 'Use.cs': 'using Demo; public class Use{}' });
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
    const cycle = await repository({ 'a/A.csproj': sdk('<ItemGroup><ProjectReference Include="../b/B.csproj"/></ItemGroup>'), 'b/B.csproj': sdk('<ItemGroup><ProjectReference Include="../a/A.csproj"/></ItemGroup>'), 'a/Use.cs': 'using Demo; public class Use{}', 'b/Types.cs': 'namespace Demo; public class Type{}' });
    assert.deepEqual(statuses(await index(cycle), 'a/Use.cs'), ['unsupported']);
});
test('Unsupported project-reference aliases and target-framework negotiation remain explicit', async () => {
    for (const metadata of ['<Aliases>Custom</Aliases>', '<SetTargetFramework>TargetFramework=net10.0</SetTargetFramework>']) {
        const root = await repository({ 'a/A.csproj': sdk(`<ItemGroup><ProjectReference Include="../b/B.csproj">${metadata}</ProjectReference></ItemGroup>`), 'b/B.csproj': sdk(), 'a/Use.cs': 'using Demo; public class Use{}', 'b/Types.cs': 'namespace Demo; public class Type{}' });
        assert.deepEqual(statuses(await index(root), 'a/Use.cs'), ['unsupported']);
    }
    const mismatch = await repository({ 'a/A.csproj': sdk('<ItemGroup><ProjectReference Include="../b/B.csproj"/></ItemGroup>').replace('net10.0', 'net9.0'), 'b/B.csproj': sdk(), 'a/Use.cs': 'using Demo; public class Use{}', 'b/Types.cs': 'namespace Demo; public class Type{}' });
    assert.deepEqual(statuses(await index(mismatch), 'a/Use.cs'), ['unsupported']);
});
test('Excluded, malformed and conditionally compiled source alternatives cannot hide competing exports', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Demo; public class Type{}', 'Alternative.cs': 'namespace Demo; public class Type{}', 'Use.cs': 'using Alias=Demo.Type; public class Use{}' });
    assert.deepEqual(statuses(await index(root, undefined, undefined, undefined, ['Alternative.cs']), 'Use.cs'), ['unsupported']);
    await put(root, 'Alternative.cs', 'namespace Demo; public class');
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
    await put(root, 'Alternative.cs', '#if UNKNOWN\nnamespace Demo; public class Other{}\n#endif');
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
});
test('Pruned and symlinked compilation roots remain excluded without reading outside indexed sources', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Use.cs': 'using Demo; public class Use{}', 'hidden/Types.cs': 'namespace Demo; public class Type{}' });
    assert.deepEqual(statuses(await index(root, undefined, undefined, undefined, ['hidden/**']), 'Use.cs'), ['unsupported']);
    const outside = await repository({ 'Types.cs': 'namespace Demo; public class Type{}' });
    await symlink(outside, path.join(root, 'linked'));
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
});
test('Partial/duplicate type aliases remain ambiguous while namespace imports retain all original fragments', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'One.cs': 'namespace Demo; public partial class Type{}', 'Two.cs': 'namespace Demo; public partial class Type{}', 'Use.cs': 'using Demo; using Alias=Demo.Type; using static Demo.Type; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved', 'ambiguous', 'ambiguous']);
    assert.equal(imports(graph, 'Use.cs')[0]!.outcome.declarations?.length, 2);
    assert.equal(graph.entities.filter(entity => entity.metadata.qualifiedName === 'Demo.Type').length, 2);
});
test('File-local, nested visibility, root namespace and generic aliases are preserved conservatively', async () => {
    const root = await repository({ 'A.csproj': sdk('', '<RootNamespace>NotADeclaration</RootNamespace>'), 'Types.cs': 'namespace Actual; file class Local{} public class Outer {private class Private{} public class Public{} } public class Generic<T>{}', 'Use.cs': 'using Actual; using L=Actual.Local; using P=Actual.Outer.Private; using N=Actual.Outer.Public; using G=Actual.Generic<int>; using NotADeclaration; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved', 'unresolved', 'unresolved', 'resolved', 'unsupported', 'external']);
    assert.deepEqual(names(graph, imports(graph, 'Use.cs')[0]!).sort(), ['Actual.Generic', 'Actual.Outer']);
});
test('C# import and declaration IDs survive line shifts while original ranges update', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Demo; public class Type{}', 'Use.cs': 'using Demo; public class Use{}' }), before = await index(root);
    await put(root, 'Types.cs', '\n// 😀\nnamespace Demo; public class Type{}');
    await put(root, 'Use.cs', '// changed\nusing Demo; public class Use{}');
    const after = await index(root);
    assert.deepEqual(imports(before, 'Use.cs')[0]!.outcome.declarations, imports(after, 'Use.cs')[0]!.outcome.declarations);
    const a = before.relations.find(edge => edge.type === 'imports')!, b = after.relations.find(edge => edge.type === 'imports')!;
    assert.equal(a.id, b.id);
    assert.equal(imports(after, 'Use.cs')[0]!.range.startLine, 2);
    assert.ok(b.evidence.some(item => item.file === 'Types.cs' && item.line === 3));
});
test('C# cold/warm/revision replay agrees and project/global/source edits invalidate consumers', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Demo; public class Type{}', 'Global.cs': 'global using Demo;', 'Use.cs': 'public class Use{}' }), cache = new AnalysisCache(path.join(root, '.codiluce/cache')), cold = await index(root, undefined, cache), warm = await index(root, undefined, cache), revision = await index(root, undefined, cache, 'fixture-revision');
    assert.equal(shape(cold), shape(warm));
    assert.equal(shape(cold), shape(revision));
    await put(root, 'Types.cs', 'namespace Demo; public class Edited{}');
    const edited = await index(root, undefined, cache);
    assert.deepEqual(names(edited, imports(edited, 'Use.cs')[0]!), ['Demo.Edited']);
    assert.equal(shape(edited), shape(await index(root)));
    await put(root, 'Global.cs', 'global using Changed;');
    const global = await index(root, undefined, cache);
    assert.deepEqual(statuses(global, 'Use.cs'), ['external']);
    assert.equal(shape(global), shape(await index(root)));
    await put(root, 'A.csproj', sdk('<ItemGroup><Using Include="Demo"/></ItemGroup>'));
    const project = await index(root, undefined, cache);
    assert.deepEqual(statuses(project, 'Use.cs'), ['resolved', 'external']);
    assert.equal(shape(project), shape(await index(root)));
});
test('.NET recorded configuration validates target, project and bounded property inputs', async () => {
    const root = await repository({ 'A.csproj': sdk() });
    for (const dotnet of [{ project: '../../out.csproj' }, { project: 'C:\\out.csproj' }, { targetFramework: '$(Target)' }, { configuration: '$([Run])' }, { properties: { MSBuildProjectDirectory: 'other' } }, { properties: { TargetFramework: 'net10.0' } }, { properties: { X: '$(Secret)' } }, { unknown: true }])
        await assert.rejects(resolveConfig(root, { applications: [{ name: 'app', path: '.', dotnet: dotnet as any }] }));
    const result = await resolveConfig(root, { applications: [{ name: 'app', path: '.', dotnet: { project: 'A.csproj', targetFramework: 'net10.0', configuration: 'Release', platform: 'AnyCPU', properties: { Flavor: 'Demo' } } }] });
    assert.equal(result.applications[0]!.dotnet?.properties?.Flavor, 'Demo');
});
test('Nearer namespace qualifiers hide outer source targets instead of borrowing a matching full name', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Api.Demo {public class Other{}} namespace Demo {public class Type{}}', 'Use.cs': 'namespace Api; using Alias=Demo.Type; using G=global::Demo.Type; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['unresolved', 'resolved']);
});
test('SDK source/output/exclude overrides stay inside the reviewed original inventory', async () => {
    const root = await repository({ 'A.csproj': sdk('', '<BaseOutputPath>artifacts</BaseOutputPath><DefaultItemExcludesInProjectFolder>ignored/**</DefaultItemExcludesInProjectFolder>'), 'Types.cs': 'namespace Demo; public class Type{}', 'artifacts/Generated.cs': 'namespace Demo; public class Generated{}', 'ignored/Other.cs': 'namespace Demo; public class Other{}', 'Use.cs': 'using Demo; public class Use{}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'Use.cs'), ['resolved']);
    assert.deepEqual(names(graph, imports(graph, 'Use.cs')[0]!), ['Demo.Type']);
    await put(root, 'A.csproj', sdk('', '<DefaultLanguageSourceExtension>.custom</DefaultLanguageSourceExtension>'));
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
});
test('Escaped identifier alternatives and invalid using order cannot certify matching imports', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Demo; public class Type{} public class T\\u0079pe{}', 'Use.cs': 'using Alias=Demo.Type; public class Use{}' });
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
    await put(root, 'Types.cs', 'namespace Demo; public class Type{}');
    await put(root, 'Use.cs', 'public class Use{} using Demo;');
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['unsupported']);
});
test('Modern .NET source references accept lower modern targets and .NET Standard 2.0/2.1', async () => {
    for (const target of ['net8.0', 'netstandard2.0', 'netstandard2.1']) {
        const root = await repository({ 'a/A.csproj': sdk('<ItemGroup><ProjectReference Include="../b/B.csproj"/></ItemGroup>'), 'b/B.csproj': sdk().replace('net10.0', target), 'a/Use.cs': 'using Demo; public class Use{}', 'b/Types.cs': 'namespace Demo; public class Type{}' }), graph = await index(root);
        assert.deepEqual(statuses(graph, 'a/Use.cs'), ['resolved'], target);
        assert.deepEqual(names(graph, imports(graph, 'a/Use.cs')[0]!), ['Demo.Type']);
    }
});
test('Narrow Compile globs and configured roots cannot hide alternatives in pruned directories', async () => {
    const root = await repository({ 'A.csproj': sdk('<ItemGroup><Compile Include="hidden/Named*.cs"/></ItemGroup>', '<EnableDefaultCompileItems>false</EnableDefaultCompileItems>'), 'Use.cs': 'using Alias=Demo.Type; public class Use{}', 'Types.cs': 'namespace Demo; public class Type{}', 'hidden/Named.cs': 'namespace Demo; public class Type{}' });
    await put(root, 'A.csproj', sdk('<ItemGroup><Compile Include="Use.cs;Types.cs;hidden/Named*.cs"/></ItemGroup>', '<EnableDefaultCompileItems>false</EnableDefaultCompileItems>'));
    assert.deepEqual(statuses(await index(root, undefined, undefined, undefined, ['hidden/**']), 'Use.cs'), ['unsupported']);
    const configured = await repository({ 'src/Use.cs': 'using Demo; public class Use{}', 'src/Types.cs': 'namespace Demo; public class Type{}', 'src/hidden/Alternative.cs': 'namespace Demo; public class Type{}' });
    assert.deepEqual(statuses(await index(configured, [{ name: 'app', path: '.', sourceRoots: { csharp: ['src'] } }], undefined, undefined, ['src/hidden/**']), 'src/Use.cs'), ['unsupported']);
});
test('Harmless source region directives retain original .NET import proof', async () => {
    const root = await repository({ 'A.csproj': sdk(), 'Types.cs': 'namespace Demo; public class Type{}', 'Use.cs': 'using Demo;\n#region Detail\npublic class Use{}\n#endregion' });
    assert.deepEqual(statuses(await index(root), 'Use.cs'), ['resolved']);
});
test('MSBuild global Using ranges cover their original XML item instead of a generated directive', async () => {
    const project = sdk('<ItemGroup>\n  <Using Include="Demo.Tools"><Alias>T</Alias></Using>\n</ItemGroup>'), root = await repository({ 'A.csproj': project, 'Types.cs': 'namespace Demo; public class Tools{}', 'Use.cs': 'public class Use{}' }), graph = await index(root), item = imports(graph, 'Use.cs')[0]!, range = item.range as any;
    assert.equal(range.startLine, 2);
    assert.equal(range.startColumn, 3);
    assert.equal(range.endLine, 2);
    assert.equal(range.endColumn, project.split('\n')[1]!.length + 1);
    assert.equal(item.origin, 'A.csproj');
    assert.equal(item.outcome.status, 'resolved');
});
test('C# EOF directives use original offsets and do not invent a final source line', async () => {
    const parser = new StructureParser();
    try {
        const source = 'using Demo;\r\n#region Detail\r\npublic class Use{}\r\n#endregion', facts = await parser.parse('csharp', source);
        assert.equal(facts.csharp?.complete, true);
        assert.deepEqual(facts.issues, []);
        assert.deepEqual(facts.csharp?.gaps, []);
        for (const declaration of facts.declarations) {
            assert.ok(declaration.end <= source.length);
            assert.ok(declaration.range.endLine <= 4);
        }
        assert.equal(facts.csharp?.imports[0]!.end, 11);
    }
    finally {
        parser.close();
    }
});
