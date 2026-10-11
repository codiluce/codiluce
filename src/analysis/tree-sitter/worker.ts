// A cancellable parser process. A pathological grammar/query cannot block the
// indexer, and all WASM resources disappear when this process is terminated.
import { Parser, Language, Query } from 'web-tree-sitter';
import { grammarCatalog, queryText, verifiedGrammar } from './grammars.js';
import { extractStructure } from './extract.js';
import {recoverObjcRegions} from './objc-regions.js';
import {extractObjcMacroProfiles} from './objc-macros.js';
import {composeObjcCpp,recoverOriginalCppMethods,originalObjcDeclarations} from './objc-cpp.js';
import {erbHostProjection,erbIssue,erbRubyProjection,extractErbHost,extractErbRegions,extractErbRuby,finishErb} from './erb-structure.js';
import {extractErbScripts,extractLiteralScripts} from './erb-script.js';
import {extractRazor,razorHostProjection,razorIssue,finishRazor} from './razor-structure.js';
import {extractLiquid,liquidHostProjection,liquidIssue,extractLiquidBodyHosts,finishLiquid} from './liquid-structure.js';
import {extractTemplateHost} from './embedded-host.js';

const loaded = new Map<string, { parser: Parser; query: Query }>();
const initialized = Parser.init();
async function load(language: string): Promise<{ parser: Parser; query: Query }> {
  await initialized;
  let entry = loaded.get(language);
  if (entry) return entry;
  const spec = grammarCatalog.get(language);
  if (!spec) throw new Error(`Unknown grammar: ${language}`);
  const grammar = await Language.load(verifiedGrammar(spec));
  if (grammar.abiVersion !== spec.abi) throw new Error(`Grammar ABI mismatch: ${language}`);
  const query = new Query(grammar, queryText(language));
  const parser = new Parser(); parser.setLanguage(grammar);
  entry = { parser, query }; loaded.set(language, entry);
  return entry;
}
async function handle(job: { id: number; language: string; content: string; objectiveCpp?:boolean;erbHost?:'html'|'javascript'|'css'|'unknown';razorKind?:'component'|'view';liquidHost?:'html'|'javascript'|'css'|'unknown';liquidEngine?:'shopify'|'unknown';liquidBodyTags?:boolean }): Promise<void> {
  try {
    const { parser, query } = await load(job.language);
    parser.reset();
    // Go's EOF semicolon, C-family/C# directives and VB statement terminators
    // need a terminal newline; positions still map to the original input.
    const input = ['go','csharp','c','cpp','objective-c','vbnet'].includes(job.language) && !job.content.endsWith('\n') ? `${job.content}\n` : job.content;
    const tree = parser.parse(input);
    if (!tree) throw new Error('Parser returned no tree');
    try {
      let facts=job.language==='erb'?extractErbRegions(tree.rootNode,query,job.content,job.erbHost):job.language==='razor'?extractRazor(tree.rootNode,query,job.content,job.razorKind):job.language==='liquid'?extractLiquid(tree.rootNode,query,job.content,job.liquidHost,job.liquidEngine):extractStructure(tree.rootNode, query, job.language, job.content);
      if(job.language==='erb'){
        const projection=erbRubyProjection(job.content,facts);
        if(projection?.trim())try{const ruby=await load('ruby');ruby.parser.reset();const rubyTree=ruby.parser.parse(projection);if(!rubyTree)throw Error('Ruby projection returned no tree');try{extractErbRuby(rubyTree.rootNode,ruby.query,job.content,facts);}finally{rubyTree.delete();}}
        catch(error){if(error instanceof WebAssembly.RuntimeError)throw error;facts.erb!.rubyComplete=false;erbIssue(facts,'erb-ruby-unavailable',`Original ERB regions retained; Ruby grammar/query unavailable: ${error instanceof Error?error.message:String(error)}`);}
        if(job.erbHost==='html')try{const html=await load('html');html.parser.reset();const htmlTree=html.parser.parse(erbHostProjection(job.content,facts));if(!htmlTree)throw Error('HTML projection returned no tree');try{extractErbHost(htmlTree.rootNode,html.query,job.content,facts);}finally{htmlTree.delete();}}
        catch(error){if(error instanceof WebAssembly.RuntimeError)throw error;facts.erb!.host.complete=false;erbIssue(facts,'erb-html-unavailable',`Original ERB/Ruby regions retained; HTML grammar/query unavailable: ${error instanceof Error?error.message:String(error)}`);}
        if(facts.erb!.host.regions.some(r=>r.kind==='script'&&r.supported&&r.language==='javascript')){const compiler=(await import('typescript')).default;extractErbScripts(compiler,job.content,facts);}
        facts=finishErb(facts);
      }
      if(job.language==='razor'){
        if(facts.truncated)facts.razor!.host.complete=false;
        else try{const html=await load('html');html.parser.reset();const host=html.parser.parse(razorHostProjection(tree.rootNode,query,job.content,facts));if(!host)throw Error('HTML projection returned no tree');try{extractTemplateHost(host.rootNode,html.query,job.content,facts,'razor');}finally{host.delete();}}
        catch(error){if(error instanceof WebAssembly.RuntimeError)throw error;facts.razor!.host.complete=false;razorIssue(facts,'razor-html-unavailable',`Original Razor/C# source retained; HTML grammar/query unavailable: ${error instanceof Error?error.message:String(error)}`);}
        if(!facts.truncated&&facts.razor!.host.regions.some(r=>r.kind==='script'&&r.supported&&r.language==='javascript')){const compiler=(await import('typescript')).default;extractLiteralScripts(compiler,job.content,facts,'razor');}
        facts=finishRazor(facts);
      }
      if(job.language==='liquid'){
        if(!facts.truncated&&facts.liquid!.nativeComplete&&job.liquidHost==='html')try{const html=await load('html');html.parser.reset();const host=html.parser.parse(liquidHostProjection(job.content,facts));if(!host)throw Error('HTML projection returned no tree');try{extractTemplateHost(host.rootNode,html.query,job.content,facts,'liquid');}finally{host.delete();}}
        catch(error){if(error instanceof WebAssembly.RuntimeError)throw error;facts.liquid!.host.complete=false;liquidIssue(facts,'liquid-html-unavailable',`Original Liquid regions retained; HTML grammar/query unavailable: ${error instanceof Error?error.message:String(error)}`);}
        extractLiquidBodyHosts(job.content,facts,job.liquidBodyTags);
        if(!facts.truncated&&facts.liquid!.host.regions.some(r=>r.kind==='script'&&r.supported&&r.language==='javascript')){const compiler=(await import('typescript')).default;extractLiteralScripts(compiler,job.content,facts,'liquid');}
        facts=finishLiquid(facts);
      }
      if(job.language==='objective-c'){
        facts=recoverObjcRegions(facts,job.content,parser,query);
        if(job.objectiveCpp){
          recoverOriginalCppMethods(facts,job.content);
          try {const cpp=await load('cpp');cpp.parser.reset();const cppTree=cpp.parser.parse(input);if(!cppTree)throw new Error('C++ parser returned no tree');try{facts=composeObjcCpp(facts,cppTree.rootNode,cpp.query,job.content);}finally{cppTree.delete();}}
          catch(error){facts.declarations=[...originalObjcDeclarations(facts.declarations),...facts.declarations.filter(f=>f.kind==='macro')];if(facts.issues.length>=100){facts.issues.pop();facts.truncated=true;}facts.issues.push({code:'objc-cpp-grammar-unavailable',reason:`Original Objective-C declarations retained; auxiliary C++ grammar unavailable: ${error instanceof Error?error.message:String(error)}`});if(facts.objc)facts.objc.complete=false;}
        }
        facts=extractObjcMacroProfiles(facts,job.content);
      }
      process.send?.({id:job.id,facts});
    }
    finally { tree.delete(); }
  } catch (error) { process.send?.({ id: job.id, error: error instanceof Error ? error.message : String(error) }); }
}
let pending = Promise.resolve();
process.on('message', (job: { id: number; language: string; content: string; objectiveCpp?:boolean;erbHost?:'html'|'javascript'|'css'|'unknown';razorKind?:'component'|'view';liquidHost?:'html'|'javascript'|'css'|'unknown';liquidEngine?:'shopify'|'unknown';liquidBodyTags?:boolean }) => { pending = pending.then(() => handle(job)); });
process.once('disconnect', () => {
  for (const { parser, query } of loaded.values()) { query.delete(); parser.delete(); }
  process.exit(0);
});
