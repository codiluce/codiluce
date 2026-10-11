import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { ANALYZER_VERSION, declarationHashes, evidence } from '../../core/graph.js';
import type { DeclarationFact, FileAnalysis, StructureFacts } from '../facts.js';
import { featureOutcomes } from '../facts.js';
import { AnalysisRegistry } from '../registry.js';
import { GRAMMAR_CATALOG_VERSION, STRUCTURAL_LANGUAGES, grammarCatalog, grammarManifest, grammarManifestError, hashText, queryText, verifiedGrammar } from './grammars.js';
import { StructureParser } from './client.js';
import { fileKey } from '../../pipeline/cache.js';
import { IndexedSources } from '../indexed-sources.js';
import {objectiveCppSource} from './objc-cpp.js';
import path from 'node:path';
import {SourceText} from '../source-map.js';
import {selectErbHost} from './erb-structure.js';
import ts from 'typescript';

export const STRUCTURE_VERSION = `${ANALYZER_VERSION}:${GRAMMAR_CATALOG_VERSION}:56`;
export const analysisRegistry = new AnalysisRegistry();
analysisRegistry.registerLanguage({ id: 'typescript', version: ANALYZER_VERSION, languages: ['typescript', 'javascript'], features: { structure: 'supported', imports: 'partial', references: 'partial', effects: 'partial', guards: 'supported' } });
analysisRegistry.registerLanguage({ id: 'php', version: ANALYZER_VERSION, languages: ['php'], features: { structure: 'partial', imports: 'partial', references: 'partial', effects: 'partial', guards: 'supported' } });
for (const language of STRUCTURAL_LANGUAGES) analysisRegistry.registerLanguage({ id: `syntax-${language}`, version: STRUCTURE_VERSION, languages: [language], features: { structure: 'supported', ...(['python', 'go', 'ruby','rust','java','kotlin','csharp'].includes(language) ? { imports: 'partial', ...(['csharp','rust'].includes(language)?{references:'partial' as const}:{}) } : {}) } });

export const structureAnalyzer: Analyzer = {
  name: 'tree-sitter-structure', version: STRUCTURE_VERSION,
  async analyze(context): Promise<void> {
    const parser = new StructureParser();
    const sources = context.sources ?? new IndexedSources(context);
    const integrity = new Map<string, string | undefined>();
    try {
      for (const file of [...context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
        const grammar = grammarCatalog.get(file.language==='fsharp'&&file.path.toLowerCase().endsWith('.fsi')?'fsharp-signature':file.language ?? '');
        if (!(STRUCTURAL_LANGUAGES as readonly string[]).includes(file.language ?? '') || !file.analyzable) continue;
        const fileEntity = context.graph.entities.get(file.id)!;
        const analysis: FileAnalysis = {
          version: 1, adapter: `syntax-${file.language}`, adapterVersion: STRUCTURE_VERSION,
          features: featureOutcomes('unsupported', 'This language adapter currently extracts declarations only'),
        };
        fileEntity.metadata.analysis = analysis;
        if(file.language==='erb'||file.language==='razor'){
          const template=file.language,executionContext=template==='erb'||file.path.toLowerCase().endsWith('.cshtml')?'server':'unknown';
          const original=sources.readFile(file.absolutePath);if(original!==undefined){const id=context.graph.id('component',template,file.application?.name??'.',file.path);context.graph.contain({id,type:'component',name:path.basename(file.path,path.extname(file.path)),path:file.path,language:template,parentId:file.id,sourceRange:new SourceText(original).range(0,original.length),metadata:{role:'template',templateLanguage:template,componentFile:true,synthetic:false,executionContext,executionUnverified:true,registration:'original-file'},evidence:[evidence('syntax',this.name,file.path,1,`Original ${template.toUpperCase()} template file identity; no compiled render function or generated class is invented`)]});fileEntity.metadata.component=id;}
        }
        try {
          if (grammarManifestError) throw new Error(grammarManifestError);
          if (!grammar) throw new Error(`Grammar missing from catalog: ${file.language}`);
          analysis.parser = { name: 'tree-sitter', version: grammarManifest.runtime.version, grammar: grammar.sourceRevision, grammarHash: grammar.sha256, queryHash: hashText(queryText(grammar.language)), abi: grammar.abi };
          // Check assets even on a warm fact-cache hit. One missing grammar
          // affects its own files, while other adapters remain usable.
          if (!integrity.has(grammar.language)) {
            try { verifiedGrammar(grammar); integrity.set(grammar.language, undefined); }
            catch (error) { integrity.set(grammar.language, error instanceof Error ? error.message : String(error)); }
          }
          if (integrity.get(grammar.language)) throw new Error(integrity.get(grammar.language));
          const content = sources.readText(file.path);
          const razorKind=file.language==='razor'?(file.path.toLowerCase().endsWith('.cshtml')?'view':'component'):undefined;
          const hostSelection=file.language==='erb'?selectErbHost(file.path,content):undefined,erbHost=hostSelection?.language;
          if(hostSelection)fileEntity.metadata.erbHostSelection=hostSelection;
          if(file.language==='erb'||file.language==='razor'){
            analysis.parser.auxiliary=[];
            // Main indexing already uses TypeScript; parser children still load
            // it lazily only for qualified literal scripts. Record the potential
            // provider before fact lookup, including upgraded compiler versions.
            if(erbHost==='html'||razorKind)analysis.parser.embedded=[{language:'javascript',name:'typescript',version:ts.version,profile:`${file.language}-original-literal-js-v1`}];
            for(const language of [...file.language==='erb'?['ruby']:[],...erbHost==='html'||razorKind?['html']:[]]){const auxiliary=grammarCatalog.get(language);if(!auxiliary)throw Error(`Auxiliary ${language} grammar missing from catalog`);let queryHash=hashText(`${language}:query-unavailable`);try{queryHash=hashText(queryText(language));if(!integrity.has(language)){verifiedGrammar(auxiliary);integrity.set(language,undefined);}}catch(error){integrity.set(language,error instanceof Error?error.message:String(error));}analysis.parser.auxiliary.push({language,grammar:auxiliary.sourceRevision,grammarHash:auxiliary.sha256,queryHash,abi:auxiliary.abi,...integrity.get(language)?{unavailable:integrity.get(language)}:{}});}
          }
          const objectiveCpp=grammar.language==='objective-c'&&(file.path.toLowerCase().endsWith('.mm')||objectiveCppSource(content));
          if(objectiveCpp){
            const cpp=grammarCatalog.get('cpp');if(!cpp)throw new Error('Auxiliary C++ grammar missing from catalog');
            let queryHash=hashText('cpp:query-unavailable');
            try{queryHash=hashText(queryText('cpp'));if(!integrity.has('cpp')){verifiedGrammar(cpp);integrity.set('cpp',undefined);}}
            catch(error){integrity.set('cpp',error instanceof Error?error.message:String(error));}
            analysis.parser.auxiliary=[{language:'cpp',grammar:cpp.sourceRevision,grammarHash:cpp.sha256,queryHash,abi:cpp.abi,...integrity.get('cpp')?{unavailable:integrity.get('cpp')}:{}}];
          }
          const compute = () => parser.parse(grammar.language, content, {objectiveCpp,...erbHost?{erbHost}:{},...razorKind?{razorKind}:{}});
          const facts = context.cache ? await context.cache.value('syntax-facts', file.path, { version: STRUCTURE_VERSION, file: fileKey(context, file.path), parser: analysis.parser }, compute) : await compute();
          const declarations = declare(context, file, content, facts,file.language==='erb'||file.language==='razor'?fileEntity.metadata.component as string|undefined:undefined);
          if(facts.cfamily)fileEntity.metadata.cfamilySyntax=facts.cfamily;
          if(facts.swift)fileEntity.metadata.swiftSyntax=facts.swift;
          if(facts.scala)fileEntity.metadata.scalaSyntax=facts.scala;
          if(facts.groovy)fileEntity.metadata.groovySyntax=facts.groovy;
          if(facts.fsharp)fileEntity.metadata.fsharpSyntax=facts.fsharp;
          if(facts.vbnet)fileEntity.metadata.vbnetSyntax=facts.vbnet;
          if(facts.erb)fileEntity.metadata.erbSyntax=facts.erb;
          if(facts.razor)fileEntity.metadata.razorSyntax=facts.razor;
          if(facts.objc)fileEntity.metadata.objcSyntax={...facts.objc,sourceProfile:objectiveCpp?'objective-cpp-partial':'objective-c'};
          if (facts.python || facts.go || facts.ruby || facts.jvm || facts.csharp || facts.rust) { context.syntax ??= new Map(); context.syntax.set(file.path, { facts, declarations }); }
          analysis.features.structure = { status: facts.issues.length ? 'partial' : 'supported', ...(facts.issues.length ? { reason: `${facts.issues.length} syntax or extraction finding(s); valid declarations retained` } : {}) };
          if(facts.objc&&objectiveCpp){
            const reason='Original Objective-C/C++ source profiles retain declarations; shared types, macros and cross-language binding remain unverified';
            analysis.features.structure={status:'partial',reason};if(!facts.issues.some(issue=>issue.code==='objc-cpp-structure-gap'))context.graph.diagnose({analyzer:'tree-sitter-structure',severity:'warning',code:'objc-cpp-structure-gap',file:file.path,entityId:file.id,reason});
          }
          for (const issue of facts.issues) context.graph.diagnose({ analyzer: 'tree-sitter-structure', severity: 'warning', code: issue.code, file: file.path, entityId: file.id, ...(issue.range ? { line: issue.range.startLine } : {}), reason: issue.reason });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          analysis.features.structure = { status: 'failed', reason };
          context.graph.diagnose({ analyzer: 'tree-sitter-structure', severity: 'warning', code: 'syntax-analysis-failed', file: file.path, entityId: file.id, reason });
        }
      }
    } finally { parser.close(); }
  },
};

function declare(context: AnalysisContext, file: ScannedFile, content: string, facts: StructureFacts,rootParent?:string): Map<string, string> {
  const { graph } = context;
  const ids = new Map<string, string>(), occurrences = new Map<string, number>();
  for (const declaration of facts.declarations) {
    const identity = [file.language!, file.application?.name ?? '', file.path, declaration.vbnetIdentity?.qualifiedName??declaration.qualifiedName, declaration.kind, declaration.vbnetIdentity?.signature??declaration.signature,...declaration.declarationForm?[declaration.declarationForm]:[]];
    const base = JSON.stringify(identity), ordinal = occurrences.get(base) ?? 0;
    occurrences.set(base, ordinal + 1);
    ids.set(declaration.key, graph.id('symbol', ...identity, ...(ordinal ? [`declaration:${ordinal + 1}`] : [])));
  }
  for (const declaration of facts.declarations) {
    const fact = { ...evidence('syntax', 'tree-sitter-structure', file.path, declaration.range.startLine, `${file.language} ${declaration.kind} declaration`), analyzerVersion: STRUCTURE_VERSION, endLine: declaration.range.endLine };
    graph.contain({
      id: ids.get(declaration.key)!, type: declaration.entityType, name: declaration.name, path: file.path, language: file.language,
      parentId: declaration.parent ? ids.get(declaration.parent) ?? rootParent??file.id : rootParent??file.id,
      sourceRange: declaration.range, metrics: { loc: declaration.range.endLine - declaration.range.startLine + 1 },
      metadata: declarationMetadata(declaration, content), evidence: [fact],
    });
  }
  return ids;
}
function declarationMetadata(declaration: DeclarationFact, content: string): Record<string, unknown> {
  return {
    qualifiedName: declaration.qualifiedName, declarationKind: declaration.kind, role: declaration.kind,
    signature: declaration.signature,
    ...(declaration.declarationForm?{declarationForm:declaration.declarationForm}:{}),
    ...(declaration.sourceConditions?.length?{sourceConditions:declaration.sourceConditions}:{}),
    ...(declaration.selector?{selector:declaration.selector,dispatch:declaration.dispatch}:{}),
    ...(declaration.swiftName?{swiftName:declaration.swiftName}:{}),
    ...(declaration.scalaExtension?{scalaExtension:declaration.scalaExtension}:{}),
    ...(declaration.embeddedSource?{embeddedSource:declaration.embeddedSource}:{}),
    ...(declaration.visibility ? { visibility: declaration.visibility } : {}),
    ...(declaration.exported !== undefined ? { exported: declaration.exported } : {}),
    ...(declaration.modifiers ? { modifiers: declaration.modifiers } : {}),
    ...(declaration.annotations ? { annotations: declaration.annotations } : {}),
    ...declarationHashes(content.slice(declaration.start, declaration.end), declaration.nameEnd - declaration.start),
  };
}
