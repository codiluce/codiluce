import path from 'node:path';
import type {Analyzer} from '../../core/analyzer.js';
import {evidence,type Evidence} from '../../core/graph.js';
import {fileAnalysis,type ImportOutcome} from '../facts.js';
import {IndexedSources} from '../indexed-sources.js';

export const LIQUID_IMPORT_VERSION='liquid-template-imports:1';
/** Source dependencies in one declared/indexed Shopify theme. No rendering,
 * engine loading, app-block lookup, parameter binding or implicit layout edge. */
export const liquidAnalyzer:Analyzer={name:'liquid-template-imports',version:LIQUID_IMPORT_VERSION,async analyze(context){
 const sources=context.sources??new IndexedSources(context);
 for(const file of [...context.files.values()].filter(f=>f.language==='liquid'&&f.analyzable).sort((a,b)=>a.path.localeCompare(b.path,'en'))){
  const entity=context.graph.entities.get(file.id)!,analysis=fileAnalysis(entity.metadata.analysis);if(!analysis)continue;
  const syntax=context.syntax?.get(file.path)?.facts.liquid;
  if(!syntax){analysis.features.imports={status:'failed',reason:'Original Liquid syntax facts are unavailable'};continue;}
  const profile=entity.metadata.liquidProfile as {engine:string;root?:string;reason:string;lookup:boolean};
  const outcomes:unknown[]=[];
  entity.metadata.importResolver={adapter:'liquid',version:LIQUID_IMPORT_VERSION,engine:profile.engine,...profile.root!==undefined?{root:profile.root}:{},reason:profile.reason};
  for(const site of syntax.imports){
   const proof:Evidence[]=[{...evidence('syntax',this.name,file.path,site.range.startLine,`Original Liquid ${site.kind} template dependency`),analyzerVersion:LIQUID_IMPORT_VERSION,endLine:site.range.endLine}];
   let outcome:ImportOutcome;
   const directory=site.kind==='render'||site.kind==='include'?'snippets':site.kind==='section'?'sections':site.kind==='layout'?'layout':undefined;
   if(!site.supported||!site.specifier)outcome={status:'unsupported',reason:'Dynamic, unquoted, recovered or incomplete native template source; no target is inferred'};
   else if(profile.engine!=='shopify'||profile.root===undefined||!profile.lookup)outcome={status:'unsupported',reason:'Liquid template lookup is engine-specific; no indexed/configured Shopify theme root is qualified'};
   else if(!directory)outcome={status:'unsupported',reason:'Jekyll include_relative and Shopify JSON section-group expansion need separate qualified lookup profiles'};
   else if(!/^[A-Za-z0-9_-]+$/.test(site.specifier))outcome={status:'unsupported',reason:'Only original extensionless Shopify filenames are qualified; paths, app blocks and alternate engines remain unsupported'};
   else{
    const targetPath=path.posix.join(profile.root,directory,site.specifier+'.liquid'),target=context.files.get(targetPath);
    if(!target)outcome={status:context.fileInventory?.has(targetPath)?'excluded':'unresolved',reason:`Template target is not available in the indexed source set: ${targetPath}`};
    else if(!target.analyzable||target.language!=='liquid'||target.application?.name!==file.application?.name||target.application?.path!==profile.root)outcome={status:'excluded',reason:'Template target is unreadable, excluded or belongs to a different application boundary'};
    else if(sources.readFile(targetPath)===undefined)outcome={status:'excluded',reason:'Template target changed, became a symlink or failed the indexed readable-source boundary'};
    else{proof.push(evidence('filesystem',this.name,targetPath,1,`Indexed original Shopify ${directory} file within application ${file.application!.name}; ${profile.reason}`));outcome={status:'resolved',targets:[target.id],proof};}
   }
   const metadata={adapter:'liquid',version:LIQUID_IMPORT_VERSION,kind:site.kind,text:site.text,...site.specifier!==undefined?{specifier:site.specifier}:{},range:site.range,conditions:site.conditions,engine:profile.engine,...profile.root!==undefined?{root:profile.root}:{}};
   outcomes.push({...metadata,outcome});
   if(outcome.status==='resolved')context.graph.relate(file.id,outcome.targets[0]!,'imports',proof,metadata,JSON.stringify([site.kind,site.start,site.end,site.specifier]));
   else context.graph.diagnose({analyzer:this.name,severity:'warning',code:`liquid-import-${outcome.status}`,file:file.path,entityId:file.id,line:site.range.startLine,reason:'reason' in outcome?outcome.reason:'Unqualified source template dependency'});
  }
  entity.metadata.importOutcomes=outcomes;
  analysis.features.imports={status:profile.engine==='shopify'?'partial':'unsupported',reason:profile.engine==='shopify'?'Original quoted render/include/section/layout source dependencies in one indexed theme; section groups, app blocks, implicit layouts, variable scopes and rendered execution remain unqualified':'Template lookup requires an engine-specific indexed application profile'};
 }
}};
