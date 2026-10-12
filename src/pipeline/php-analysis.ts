import type {AnalysisContext,Analyzer} from '../core/analyzer.js';
import {IndexedSources} from '../analysis/indexed-sources.js';
import {phpStructureAnalyzer,phpLaravelStructureAnalyzer} from '../analysis/languages/php.js';
import {phpImportsAnalyzer} from '../analysis/languages/php-imports.js';
import {phpSymbolsAnalyzer} from '../analysis/languages/php-symbols.js';
import {laravelAnalyzer} from '../analyzers/laravel.js';
import {PHP_PARSER_VERSION,PHP_SOURCE_PROFILE,PHP_SOURCE_PROVIDER_VERSION} from '../analysis/php/version.js';
import {PhpSources} from '../analysis/php/sources.js';
import {fileKey} from './cache.js';

export const PHP_ANALYSIS_CACHE_VERSION='php-qualified-analysis:1';
export const phpAnalysisServices:Analyzer[]=[phpStructureAnalyzer,phpImportsAnalyzer,laravelAnalyzer,phpLaravelStructureAnalyzer,phpSymbolsAnalyzer];
export function phpAnalysisInputs(context:AnalysisContext) {
 return {version:PHP_ANALYSIS_CACHE_VERSION,services:phpAnalysisServices.map(({name,version})=>[name,version]),provider:PHP_SOURCE_PROVIDER_VERSION,parser:PHP_PARSER_VERSION,profile:PHP_SOURCE_PROFILE,
  config:context.config,applications:[...context.applicationIds],files:[...context.files.values()].map(file=>fileKey(context,file.path)),
  observed:[...context.fileInventory??[]].sort(),directories:[...context.directoryInventory??[]].sort(),scanned:[...context.scannedDirectories??[]].sort()};
}

/** PHP's structure/import/Laravel/binding output is one graph transaction.
 * Replay skips native-tree hydration, not source validation. Dependencies
 * include every actual indexed read, including custom Composer manifests and
 * literal loads without a PHP extension. Other languages still run normally. */
export async function analyzePhp(context:AnalysisContext,onProgress?: (name:string)=>void):Promise<void> {
 const files=[...context.files.values()].filter(file=>file.language==='php'&&file.analyzable);
 const run=async(notified=false)=>{
  if(files.length)(context.phpSources??=new PhpSources(context)).prepare(files);
  for(const analyzer of phpAnalysisServices){if(!notified)onProgress?.(analyzer.name);await analyzer.analyze(context);}
 };
 if(!context.cache||!files.length){await run();return;}
 const inputs=phpAnalysisInputs(context),reads=new Set<string>(),previous=context.sourceReads;
 const sources=new IndexedSources(context);let notified=false;
 const validate=(paths:string[]|undefined)=>{
  if(!paths)return false;
  const dependencies=new Set(paths);
  if(files.some(file=>!dependencies.has(file.path)))return false;
  try{for(const file of paths)sources.readText(file,{revalidate:true});return true;}catch{return false;}
 };
 context.sourceReads=reads;
 try{
  await context.cache.unit(context,'php-analysis','repository',inputs,()=>run(notified),{
   beforeReplay:paths=>{
    // A hit represents all five stages atomically. Notify before validation,
    // so a source changed by a progress callback cannot replay stale facts.
    for(const analyzer of phpAnalysisServices)onProgress?.(analyzer.name);notified=true;
    return validate(paths);
   },
   shouldStore:()=>files.every(file=>{
    return context.phpSources?.hasQualified(file.path)??false;
   })&&validate([...reads]),
   inputs:()=>[...reads].sort(),
  });
 }finally{
  if(previous){for(const file of reads)previous.add(file);context.sourceReads=previous;}else delete context.sourceReads;
 }
}
