import assert from 'node:assert/strict';
import { after, mock, test as registerTest } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createApplicationProgram, TypeScriptSourceCache, type TypeScriptCacheLimits } from '../src/analyzers/ts-program.js';
import { indexRepository } from '../src/pipeline/index.js';
import { isolatedTypescriptAnalyzer } from '../src/analyzers/typescript-isolated.js';
import { typescriptAnalyzer } from '../src/analyzers/typescript.js';
import { resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const roots: string[] = [], completedCases: string[] = [];
function test(name: string, work: () => void | Promise<void>) { return registerTest(name, async () => { await work(); completedCases.push(name); }); }
after(async () => { if (completedCases.length === 7) for (const root of roots) await rm(root, { recursive: true, force: true }); else console.error('Retained JSDoc cache fixture roots:', roots); });
const limits = (maxNodes: number): TypeScriptCacheLimits => ({ maxBytes: 64 * 1024 * 1024, maxNodes, maxEntries: 128 });
const documented = (properties = 1000) => '/**\n * @typedef {object} OriginalPayload\n' + Array.from({ length: properties }, (_, i) => ' * @property {number} p' + i + '\n').join('') +
    ' */\n/** @param {OriginalPayload} payload @returns {number} */\nexport function original(payload){ return payload.p0; }\n';
const parse = (text = documented(), parents = true, mode = ts.JSDocParsingMode.ParseAll) => ts.createSourceFile('/owned/original.js', text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: mode }, parents, ts.ScriptKind.JS);
// Independent exhaustive visitor for the exact original parser trees, with
// identity deduplication. It has no admission cutoff or compiler mutation.
function count(source: ts.SourceFile, includeDocuments: boolean): number {
    const seen = new Set<ts.Node>(), pending: ts.Node[] = [source];
    while (pending.length) {
        const node = pending.pop()!; if (seen.has(node)) continue; seen.add(node);
        ts.forEachChild(node, child => { pending.push(child); });
        if (includeDocuments) for (const document of (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []) pending.push(document);
    }
    return seen.size;
}
function put(cache: TypeScriptSourceCache, source: ts.SourceFile, key = source.fileName) { cache.put(key, 'owned-parse', source); }

test('Parsed JSDoc syntax beyond a sparse executable tree cannot escape the source cache node budget', () => {
    const source = parse(), syntax = count(source, false), owned = count(source, true), cache = new TypeScriptSourceCache(limits(syntax));
    assert.equal(syntax, 12); assert.ok(owned > 5000); put(cache, source);
    assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().bypasses, 1); assert.equal(cache.stats().nodes, 0);
    assert.equal(source.getFullText(), documented()); assert.equal(source.statements.length, 1);
});
test('All attached comment blocks count even when semantic JSDoc queries filter an earlier typedef and parent pointers are absent', () => {
    for (const parents of [false, true]) {
        const source = parse(undefined, parents), owned = count(source, true), attached = (source.statements[0] as ts.FunctionDeclaration & { jsDoc: readonly ts.JSDoc[] }).jsDoc;
        assert.equal(attached.length, 2); assert.equal(attached[0]!.tags!.length, 1);
        if (parents) assert.equal(ts.getJSDocCommentsAndTags(source.statements[0]!).length, 1);
        const cache = new TypeScriptSourceCache(limits(owned)); put(cache, source);
        assert.equal(cache.stats().nodes, owned); assert.equal(cache.get(source.fileName, source.text, 'owned-parse'), source);
        assert.equal(source.statements[0]!.parent === source, parents);
        const rejected = new TypeScriptSourceCache(limits(owned - 1)); put(rejected, source); assert.equal(rejected.stats().bypasses, 1);
    }
});
test('Aggregate JSDoc ownership evicts the oldest complete tree and replacement invalidation never retains an over-budget original', () => {
    const first = parse(documented(20)), second = parse(documented(20)), owned = count(first, true), cache = new TypeScriptSourceCache(limits(owned));
    put(cache, first, 'first'); put(cache, second, 'second'); assert.equal(cache.stats().evictions, 1); assert.equal(cache.stats().entries, 1); assert.equal(cache.stats().nodes, owned);
    assert.equal(cache.get('first', first.text, 'owned-parse'), undefined); assert.equal(cache.get('second', second.text, 'owned-parse'), second);
    put(cache, parse(documented(1000)), 'second'); assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().bypasses, 1); assert.equal(cache.stats().nodes, 0);
});
test('Parser modes with no JSDoc trees retain their exact admission and unfamiliar attachment layouts bypass reuse without compiler mutation', () => {
    const source = parse(undefined, true, ts.JSDocParsingMode.ParseNone), syntax = count(source, false), cache = new TypeScriptSourceCache(limits(syntax));
    assert.equal(count(source, true), syntax); put(cache, source); assert.equal(cache.stats().nodes, syntax);
    for (const attachment of [null, 'unreviewed', [null], [{ kind: ts.SyntaxKind.Identifier }]]) {
        const current = parse('export const original=1;'); Object.assign(current, { jsDoc: attachment });
        const denied = new TypeScriptSourceCache(limits(100)); put(denied, current);
        assert.equal(denied.stats().entries, 0); assert.equal(denied.stats().bypasses, 1); assert.equal((current as ts.SourceFile & { jsDoc: unknown }).jsDoc, attachment);
    }
});
test('Actual indexed compiler programs preserve original JSDoc parameter types, import aliases and diagnostics while oversized documentation bypasses cache ownership', () => {
    const root = path.resolve('/owned/jsdoc-program'), leaf = path.join(root, 'original.js'), entry = path.join(root, 'entry.ts');
    const texts = new Map([[leaf, documented()], [entry, 'import {original as read} from "./original.js"; export const original=read; throw new Error("Target never executes");']]);
    const run = (cache: TypeScriptSourceCache) => {
        const program = createApplicationProgram(texts, { noLib: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }, root, { sourceCache: cache });
        const source = program.getSourceFile(leaf)!, checker = program.getTypeChecker(), fn = source.statements[0] as ts.FunctionDeclaration;
        assert.equal(checker.typeToString(checker.getTypeAtLocation(fn.parameters[0]!)), 'OriginalPayload');
        assert.equal(checker.typeToString(checker.getTypeAtLocation(fn)), '(payload: OriginalPayload) => number');
        const imported = (program.getSourceFile(entry)!.statements[0] as ts.ImportDeclaration).importClause!.namedBindings as ts.NamedImports;
        assert.equal(checker.getAliasedSymbol(checker.getSymbolAtLocation(imported.elements[0]!.name)!).declarations![0]!.getSourceFile(), source);
        return { files: program.getSourceFiles().map(file => ({ file: file.fileName, text: file.text })), diagnostics: program.getSemanticDiagnostics().map(d => ({ code: d.code, start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })) };
    };
    const disabled = run(new TypeScriptSourceCache(limits(0))), cache = new TypeScriptSourceCache(limits(100));
    assert.deepEqual(run(cache), disabled); assert.deepEqual(run(cache), disabled); assert.ok(cache.stats().bypasses >= 2);
});
test('Compiler library documentation has the same independent ownership boundary while standard types and complete diagnostics remain exact', () => {
    const root = path.resolve('/owned/jsdoc-library'), file = path.join(root, 'original.ts'), texts = new Map([[file, 'export function original(value:string):number{return value.length;}']]);
    const baseline = createApplicationProgram(texts, { target: ts.ScriptTarget.ESNext, lib: ['lib.es5.d.ts'] }, root, { sourceCache: new TypeScriptSourceCache(limits(0)), libraryCache: new TypeScriptSourceCache(limits(0)) });
    const maximumSyntaxNodes = Math.max(...baseline.getSourceFiles().filter(file => file.isDeclarationFile).map(file => count(file, false)));
    assert.ok(baseline.getSourceFiles().some(file => file.isDeclarationFile && count(file, true) > maximumSyntaxNodes));
    const cache = new TypeScriptSourceCache(limits(maximumSyntaxNodes)), program = createApplicationProgram(texts, { target: ts.ScriptTarget.ESNext, lib: ['lib.es5.d.ts'] }, root, { libraryCache: cache });
    assert.ok(cache.stats().bypasses > 0);
    assert.deepEqual(program.getSourceFiles().map(file => ({ file: file.fileName, text: file.text })), baseline.getSourceFiles().map(file => ({ file: file.fileName, text: file.text })));
    assert.deepEqual(program.getSemanticDiagnostics(), baseline.getSemanticDiagnostics());
    assert.equal(program.getTypeChecker().typeToString(program.getTypeChecker().getTypeAtLocation((program.getSourceFile(file)!.statements[0] as ts.FunctionDeclaration).parameters[0]!)), 'string');
});
const whole = (graph: SoftwareGraph) => { const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy); };
test('Complete Express working-tree/cache/revision graphs keep original documented handlers and leaf calls when JSDoc cache ownership churns', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-jsdoc-cache-')); roots.push(root);
    const files = { 'package.json': JSON.stringify({ dependencies: { express: '5.1.0' } }), 'main.ts': 'import express from "express";import router from "./router";const app=express();app.use("/v1",router);app.listen(3000);',
        'router.ts': 'import {Router} from "express";import {original} from "./barrel";const router=Router();router.get("/:id",original);export default router;',
        'barrel.ts': 'export {original} from "./handlers.js";', 'handlers.js': documented().replace('/** @param {OriginalPayload} payload @returns {number} */\nexport function original(payload){ return payload.p0; }', '/** @param {any} req @param {any} res */\nexport function original(req,res){return leaf(req.params.id)}\nfunction leaf(value){return value;}\nthrow new Error("Target never executes");') };
    for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
    const config = await resolveConfig(root, { repository: { name: 'Original documented cache' } }), reference = await indexRepository(root, { config }), revision = 'c'.repeat(40), referenceRevision = await indexRepository(root, { config, revision });
    const originalGet = TypeScriptSourceCache.prototype.get, originalPut = TypeScriptSourceCache.prototype.put, replacements = new Map<TypeScriptSourceCache, TypeScriptSourceCache>();
    function replacement(cache: TypeScriptSourceCache) { let value = replacements.get(cache); if (!value) { value = new TypeScriptSourceCache(limits(1000)); replacements.set(cache, value); } return value; }
    const get = mock.method(TypeScriptSourceCache.prototype, 'get', function (this: TypeScriptSourceCache, ...args: Parameters<TypeScriptSourceCache['get']>) { return originalGet.call(replacement(this), ...args); });
    let documentedHandlerBypasses = 0;
    const put = mock.method(TypeScriptSourceCache.prototype, 'put', function (this: TypeScriptSourceCache, ...args: Parameters<TypeScriptSourceCache['put']>) {
        const cache = replacement(this); originalPut.call(cache, ...args);
        if (args[2].fileName === path.join(root, 'handlers.js')) {
            assert.ok(originalGet.call(cache, args[0], args[2].text, args[1]) === undefined, 'The complete original handler remains a live input while its parsed documentation denies cache ownership');
            documentedHandlerBypasses++;
        }
    });
    const execution = mock.method(isolatedTypescriptAnalyzer, 'analyze', typescriptAnalyzer.analyze);
    try {
        const cache = new AnalysisCache(path.join(root, '.codiluce/cache')), cold = await indexRepository(root, { config, cache }), warm = await indexRepository(root, { config, cache });
        assert.equal(whole(cold), whole(reference)); assert.equal(whole(warm), whole(reference)); assert.ok(cache.events.some(event => event.analyzer === 'typescript-nextjs' && event.hit));
        assert.equal(whole(await indexRepository(root, { config, revision })), whole(referenceRevision)); assert.ok(documentedHandlerBypasses >= 2);
        const route = cold.entities.find(e => e.type === 'api_endpoint' && e.name === 'GET /v1/:id')!, handler = cold.entities.find(e => e.name === 'original' && e.path === 'handlers.js')!, leaf = cold.entities.find(e => e.name === 'leaf' && e.path === 'handlers.js')!;
        assert.ok(route && handler && leaf); assert.ok(cold.relations.some(r => r.type === 'handles' && r.from === route.id && r.to === handler.id)); assert.ok(cold.relations.some(r => r.type === 'calls' && r.from === handler.id && r.to === leaf.id));
        for (const [file, text] of Object.entries(files)) assert.equal(await readFile(path.join(root, file), 'utf8'), text);
    } finally { execution.mock.restore(); get.mock.restore(); put.mock.restore(); }
});
