import path from 'node:path';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { PhpRuntimeConfig } from '../../core/config.js';
import { matchesGlob } from '../../core/config.js';
import { ANALYZER_VERSION, evidence, type Evidence } from '../../core/graph.js';
import type { DeclarationFact, ImportOutcome, PhpImportFact, PhpPathExpression, PhpSyntaxFacts } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';

export const PHP_RESOLVER_VERSION = `${ANALYZER_VERSION}:php-indexed-imports:1`;
const ROOT = '/__codiluce_php_repository__', MAX_MAPS = 4096, MAX_PROJECTS = 256, MAX_REACHABLE = 4096;
type ObjectValue = Record<string,unknown>;
const object = (value: unknown): ObjectValue|undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const strings = (value: unknown): string[]|undefined => typeof value === 'string' ? [value] : Array.isArray(value) && value.length <= MAX_MAPS && value.every(item => typeof item === 'string') ? value : undefined;
const inside = (file: string, directory: string) => directory === '.' || file === directory || file.startsWith(`${directory}/`);
const phpFold=(name:string)=>name.replace(/[A-Z]/g,letter=>letter.toLowerCase());
const constantKey=(name:string)=>{const last=name.lastIndexOf('\\');return last<0?name:phpFold(name.slice(0,last))+name.slice(last);};
function relative(base: string, input: string, patterns = false): string|undefined {
  if (input.length > 2048 || /[\\\0\r\n:?\[\]{}]/.test(input) || input.startsWith('/') || !patterns && /\*/.test(input)) return;
  const result = path.posix.normalize(path.posix.join(base,input));
  return result === '..' || result.startsWith('../') || result.startsWith('/') ? undefined : result;
}
interface Mapping {kind:'psr-4'|'psr-0';prefix:string;roots:string[];manifest:string;dev:boolean;active:boolean|'unknown'}
interface Classmap {paths:string[];exclude:string[];manifest:string;dev:boolean;active:boolean|'unknown'}
interface FilesMap {paths:string[];manifest:string;dev:boolean;active:boolean|'unknown'}
interface Project {id:string;root:string;manifest?:string;name?:string;runtime:PhpRuntimeConfig;maps:Mapping[];classmaps:Classmap[];files:FilesMap[];gaps:string[];dependencies:string[];localPackages:{manifest:string;name:string}[];external:{name:string;prefixes:string[];dev:boolean}[]}
interface SymbolSite {file:string;id:string;fact:DeclarationFact}
type Availability = {status:'available';file:ScannedFile} | {status:'absent'|'excluded'|'unsupported';reason:string};
export interface PhpLoad {site:PhpSyntaxFacts['loads'][number];outcome:ImportOutcome}
interface Reachability {files:Map<string,Evidence[]>;gaps:string[]}
interface ClassCatalog {items:Map<string,{site:SymbolSite;manifest:string;active:boolean|'unknown'}[]>;gaps:string[]}

/** Composer and PHP source contracts only. Target runtimes, plugins, generated
 * vendor loaders and host include paths are never consulted or executed. */
export class PhpResolver {
  private readonly sources:IndexedSources;
  private readonly projects = new Map<string,Project>();
  private readonly owners = new Map<string,Project>();
  private readonly symbols = new Map<string,SymbolSite[]>();
  private readonly loadCache = new Map<string,PhpLoad[]>();
  private readonly reachCache = new Map<string,Reachability>();
  private readonly classCache = new Map<string,ClassCatalog>();
  constructor(private readonly context:AnalysisContext) {
    this.sources = context.sources ?? new IndexedSources(context);
    for (const [file,syntax] of context.syntax ?? []) if (syntax.facts.php && !syntax.facts.truncated && !syntax.facts.issues.some(issue=>issue.code==='php-original-token-gap')) {
      const items:SymbolSite[] = [];
      for (const fact of syntax.facts.declarations) {
        const id = syntax.declarations.get(fact.key);
        if (id && ['class','interface','trait','enum','function','constant'].includes(fact.kind)) items.push({file,id,fact});
      }
      this.symbols.set(file,items);
    }
  }
  private proof(file:string,reason:string,line?:number):Evidence { return {...evidence('php','php-imports',file,line,reason),analyzerVersion:PHP_RESOLVER_VERSION}; }
  facts(file:string):PhpSyntaxFacts|undefined {
    const syntax = this.context.syntax?.get(file)?.facts;
    return syntax?.php && !syntax.truncated && !syntax.issues.some(issue=>issue.code==='php-original-token-gap') ? syntax.php : undefined;
  }
  private availability(file:string):Availability {
    const target = this.context.files.get(file);
    if (target) {
      if (!target.analyzable) return {status:'excluded',reason:`Indexed target is not readable: ${file}`};
      try { this.sources.readText(file); return {status:'available',file:target}; }
      catch(error) { return {status:'unsupported',reason:error instanceof Error?error.message:String(error)}; }
    }
    if (this.context.config.ignore.some(glob=>matchesGlob(file,glob))) return {status:'excluded',reason:`Target is excluded by the scan profile: ${file}`};
    const parts = file.split('/');
    for (let i=1;i<=parts.length;i++) {
      const current = parts.slice(0,i).join('/'), parent = i===1?'.':parts.slice(0,i-1).join('/');
      if (this.context.fileInventory?.has(current)) return {status:'excluded',reason:`Observed input was excluded, a symlink or a non-directory ancestor: ${current}`};
      if (!this.context.directoryInventory?.has(current)) return this.context.scannedDirectories?.has(parent) ? {status:'absent',reason:`Scan proves target absent: ${file}`} : {status:'unsupported',reason:`Target absence is unproven below an unenumerated directory: ${current}`};
      if (!this.context.scannedDirectories?.has(current)) return {status:'excluded',reason:`Target is below an unenumerated/pruned directory: ${current}`};
    }
    return {status:'unsupported',reason:`Target is a directory: ${file}`};
  }
  private manifest(file:string):ObjectValue|undefined {
    const available=this.availability(file);
    if (available.status!=='available') return;
    try { return object(JSON.parse(this.sources.readText(file))); } catch { return; }
  }
  prepare(files:ScannedFile[]):void { for (const file of files) this.owner(file.path); }
  owner(file:string):Project {
    const cached=this.owners.get(file);if(cached)return cached;
    const application=this.context.files.get(file)?.application, runtime=application?.php ?? {};
    let manifest=runtime.composer===undefined?undefined:relative(application?.path??'.',runtime.composer);
    if (runtime.composer===undefined) {
      let directory=path.posix.dirname(file);
      while (true) {
        const candidate=path.posix.join(directory,'composer.json');
        if (this.context.fileInventory?.has(candidate)||this.context.files.has(candidate)) {manifest=candidate;break;}
        if(directory==='.'||application && directory===application.path)break;
        directory=path.posix.dirname(directory);
      }
    }
    const root=manifest?path.posix.dirname(manifest):application?.path??'.';
    const key=JSON.stringify([manifest??root,application?.name??'',runtime]);
    let project=this.projects.get(key);
    if(!project) {
      project={id:this.context.graph.id('project','php',key),root,manifest,runtime,maps:[],classmaps:[],files:[],gaps:[],dependencies:[],localPackages:[],external:[]};
      if(this.projects.size>=MAX_PROJECTS) project.gaps.push('Composer project budget exceeded');
      else {this.projects.set(key,project);if(manifest)this.readProject(project,manifest,true,new Set());}
    }
    this.owners.set(file,project);return project;
  }
  describe():unknown[] {return [...this.projects.values()].map(p=>({...p,language:'php',executionUnverified:true,installUnverified:true,lookupProfile:'indexed-posix-source-contract'}));}
  private readProject(project:Project,manifest:string,root:boolean,visited:Set<string>,activation:boolean|'unknown'=true,devDependency=false):void {
    if(project.gaps.length>=100)return;
    const visitKey=JSON.stringify([manifest,activation]);
    if(visited.has(visitKey)||activation==='unknown'&&visited.has(JSON.stringify([manifest,true])))return;
    if(visited.size>=MAX_PROJECTS){project.gaps.push('Composer dependency traversal budget exceeded');return;}visited.add(visitKey);
    const value=this.manifest(manifest);
    if(!value){project.gaps.push(`Composer manifest is unavailable or invalid: ${manifest}`);return;}
    if(root&&typeof value.name==='string')project.name=value.name;
    const directory=path.posix.dirname(manifest);
    if(value['target-dir']!==undefined)project.gaps.push(`Legacy Composer target-dir requires a separate path profile: ${manifest}`);
    const readAutoload=(input:unknown,dev:boolean,active:boolean|'unknown')=>{
      if(input===undefined)return;const autoload=object(input);
      if(!autoload){project.gaps.push(`Invalid autoload object in ${manifest}`);return;}
      for(const kind of ['psr-4','psr-0'] as const) {
        if(autoload[kind]===undefined)continue;const entries=object(autoload[kind]);
        if(!entries||Object.keys(entries).length>MAX_MAPS){project.gaps.push(`Invalid/bounded ${kind} map in ${manifest}`);continue;}
        for(const [prefix,inputPaths] of Object.entries(entries)) {
          if(project.gaps.length>=100)break;
          const paths=strings(inputPaths), roots=paths?.map(input=>relative(directory,input));
          if(prefix.length>2048||/[\0\r\n/]/.test(prefix)||prefix.startsWith('\\')||kind==='psr-4'&&prefix!==''&&!prefix.endsWith('\\')||!roots||!roots.length||roots.some(item=>item===undefined)) {project.gaps.push(`Unsupported ${kind} mapping ${prefix} in ${manifest}`);continue;}
          if(project.maps.reduce((count,map)=>count+map.roots.length,0)+roots.length>MAX_MAPS){project.gaps.push('Composer mapping/root budget exceeded');break;}
          project.maps.push({kind,prefix,roots:roots as string[],manifest,dev,active});
        }
      }
      const excludes=strings(autoload['exclude-from-classmap']??[]);
      const normalized=excludes?.map(input=>relative(directory,input.replace(/^\//,''),true));
      const paths=strings(autoload.classmap??[]), normalizedPaths=paths?.map(input=>relative(directory,input,true));
      if(!normalized||normalized.some(item=>item===undefined)||!normalizedPaths||normalizedPaths.some(item=>item===undefined))project.gaps.push(`Unsupported classmap/exclusion paths in ${manifest}`);
      else if(normalizedPaths.length||normalized.length) {
        if(project.classmaps.reduce((count,map)=>count+map.paths.length,0)+normalizedPaths.length>MAX_MAPS)project.gaps.push('Composer aggregate classmap path budget exceeded');
        else project.classmaps.push({paths:normalizedPaths as string[],exclude:normalized as string[],manifest,dev,active});
      }
      const filePaths=strings(autoload.files??[]),normalizedFiles=filePaths?.map(input=>relative(directory,input));
      if(!normalizedFiles||normalizedFiles.some(item=>item===undefined))project.gaps.push(`Unsupported Composer files paths in ${manifest}`);
      else if(normalizedFiles.length) {
        if(project.files.reduce((count,map)=>count+map.paths.length,0)+normalizedFiles.length>MAX_MAPS)project.gaps.push('Composer aggregate files path budget exceeded');
        else project.files.push({paths:normalizedFiles as string[],manifest,dev,active});
      }
      for(const key of Object.keys(autoload))if(!['psr-4','psr-0','classmap','files','exclude-from-classmap'].includes(key))project.gaps.push(`Unsupported Composer autoload field ${key} in ${manifest}`);
    };
    readAutoload(value.autoload,devDependency,activation);
    if(root)readAutoload(value['autoload-dev'],true,project.runtime.autoloadDev??'unknown');
    const required=object(value.require)??{},devRequired=root&&project.runtime.autoloadDev!==false?object(value['require-dev'])??{}:{};
    if(Object.keys(required).length>MAX_MAPS){project.gaps.push(`Composer requirement budget exceeded in ${manifest}`);return;}
    // Composer only consumes repository definitions from the root package.
    const repositories=root?(Array.isArray(value.repositories)?value.repositories:Object.values(object(value.repositories)??{})):[];
    if(repositories.length>MAX_MAPS){project.gaps.push(`Composer repository budget exceeded in ${manifest}`);return;}
    for(const repository of repositories) {
      const entry=object(repository);if(entry?.type!=='path'||typeof entry.url!=='string')continue;
      const pattern=relative(directory,entry.url,true);
      if(!pattern){project.gaps.push(`Unsupported Composer path repository in ${manifest}`);continue;}
      const candidates=[...this.context.files.keys()].filter(file=>path.posix.basename(file)==='composer.json'&&matchesGlob(path.posix.dirname(file),pattern));
      for(const candidate of candidates.slice(0,MAX_PROJECTS)) {
        const dependency=this.manifest(candidate);
        if(typeof dependency?.name==='string')project.localPackages.push({manifest:candidate,name:dependency.name});
      }
      if(candidates.length>MAX_PROJECTS)project.gaps.push('Composer path repository expansion budget exceeded');
    }
    for(const [requirements,active,dev] of [[required,activation,devDependency],[devRequired,project.runtime.autoloadDev??'unknown',true]] as const)for(const dependency of project.localPackages)if(Object.hasOwn(requirements,dependency.name)) {
      if(!project.dependencies.includes(dependency.manifest))project.dependencies.push(dependency.manifest);
      this.readProject(project,dependency.manifest,false,visited,active,dev);
    }
    if(root) {
      const lock=path.posix.join(directory,'composer.lock'), locked=this.manifest(lock);
      if(locked)for(const [field,dev] of [['packages',false],['packages-dev',true]] as const) {
        const packages=locked[field];if(!Array.isArray(packages)||packages.length>MAX_MAPS)continue;
        for(const item of packages) {
          const pkg=object(item),autoload=object(pkg?.autoload);if(typeof pkg?.name!=='string')continue;
          const prefixes=[...Object.keys(object(autoload?.['psr-4'])??{}),...Object.keys(object(autoload?.['psr-0'])??{})].filter(prefix=>prefix.length>0&&prefix.length<=2048);
          project.external.push({name:pkg.name,prefixes,dev});
        }
      }
    }
  }
  private evaluate(expression:PhpPathExpression,file:string,site:PhpSyntaxFacts['loads'][number]):{value:string;anchored:boolean}|{reason:string} {
    if(expression.kind==='unknown')return {reason:expression.reason};
    if(expression.kind==='literal')return {value:expression.value,anchored:false};
    if(expression.kind==='dir'||expression.kind==='file')return {value:path.posix.join(ROOT,expression.kind==='dir'?path.posix.dirname(file):file),anchored:true};
    if(expression.kind==='concat') {
      const left=this.evaluate(expression.left,file,site),right=this.evaluate(expression.right,file,site);
      return 'reason'in left?left:'reason'in right?right:{value:left.value+right.value,anchored:left.anchored};
    }
    if(expression.name.toLowerCase()!=='\\dirname') {
      const shadow=(this.facts(file)?.imports??[]).some(imported=>imported.kind==='function'&&imported.scope===site.scope&&imported.alias.toLowerCase()==='dirname') || [...this.symbols.values()].some(items=>items.some(item=>item.fact.kind==='function'&&[`${site.namespace?site.namespace+'\\':''}dirname`,'dirname'].some(name=>item.fact.qualifiedName.toLowerCase()===name.toLowerCase())));
      if(shadow)return {reason:'Unqualified dirname is shadowed by an original function import/declaration'};
    }
    const argument=this.evaluate(expression.argument,file,site);if('reason'in argument)return argument;
    let value=argument.value;for(let i=0;i<expression.levels;i++) {
      value=path.posix.dirname(value);
      if(argument.anchored&&value!==ROOT&&!value.startsWith(`${ROOT}/`))return {reason:'Original dirname expression leaves the repository source anchor'};
    }
    return {value,anchored:argument.anchored};
  }
  loads(file:string):PhpLoad[] {
    const cached=this.loadCache.get(file);if(cached)return cached;
    const facts=this.facts(file),project=this.owner(file),application=this.context.files.get(file)?.application;
    const cwd=project.runtime.cwd===undefined?undefined:relative(application?.path??'.',project.runtime.cwd);
    const results=(facts?.loads??[]).map(site=>{
      const result=this.evaluate(site.path,file,site);let outcome:ImportOutcome;
      if('reason'in result)outcome={status:'unsupported',reason:result.reason};
      else if(/[\\\0\r\n:]/.test(result.value))outcome={status:'unsupported',reason:'Streams, NUL, target platform separators or special path bytes require a separate profile'};
      else {
        const value=result.value;let candidates:string[]|undefined;
        if(value.startsWith('/')) {
          const normalized=path.posix.normalize(value);
          if(result.anchored&&normalized.startsWith(`${ROOT}/`))candidates=[normalized.slice(ROOT.length+1)];
          else outcome={status:'unsupported',reason:'Original absolute/concatenated path is outside the repository source anchor'};
        } else if(facts?.loaderChanges.some(change=>/^(?:.*\\)?(?:chdir|set_include_path|restore_include_path|ini_set|ini_restore)$/i.test(change.name)))outcome={status:'unsupported',reason:'Original runtime cwd/include-path mutation prevents static relative lookup'};
        else if(value.startsWith('./')||value.startsWith('../')||project.runtime.includePath?.length===0) {
          const candidate=cwd===undefined?undefined:relative(cwd,value);
          if(candidate)candidates=[candidate];else outcome={status:'unsupported',reason:'Explicit relative/empty include-path lookup requires a recorded repository-bound PHP cwd'};
        } else if(project.runtime.includePath===undefined)outcome={status:'unsupported',reason:'Bare PHP load needs an explicitly recorded include-path profile'};
        else {
          const roots=project.runtime.includePath.map(input=>relative(application?.path??'.',input));
          const paths=roots.map(root=>root===undefined?undefined:relative(root,value));
          const caller=relative(path.posix.dirname(file),value),fallback=cwd===undefined?undefined:relative(cwd,value);
          if(paths.some(item=>item===undefined)||caller===undefined)outcome={status:'unsupported',reason:'PHP search path leaves the indexed repository'};
          else candidates=[...paths as string[],caller,...fallback?[fallback]:[]];
        }
        if(candidates) {
          outcome=this.resolveFiles(candidates,file,`Original ${site.kind} path contract at line ${site.range.startLine}; ${site.conditions.join('; ')||'runtime activation unverified'}`);
          if(outcome.status==='unresolved'&&!result.anchored&&!value.startsWith('./')&&!value.startsWith('../')&&project.runtime.includePath?.length!==0&&cwd===undefined)outcome={status:'unsupported',reason:'Recorded include-path/caller candidates are absent; final cwd fallback is unrecorded'};
        }
      }
      return {site,outcome:outcome!};
    });this.loadCache.set(file,results);return results;
  }
  private resolveFiles(candidates:string[],consumer:string,reason:string):ImportOutcome {
    for(const candidate of [...new Set(candidates)]) {
      const available=this.availability(candidate);
      if(available.status==='absent')continue;
      if(available.status!=='available')return {status:available.status,reason:available.reason};
      return {status:'resolved',targets:[available.file.id],proof:[this.proof(consumer,reason),this.proof(candidate,'First indexed readable file in the ordered source lookup; runtime activation is unverified')]};
    }
    return {status:'unresolved',reason:`No original indexed target in the recorded lookup: ${candidates.join(', ')}`};
  }
  private reachable(file:string):Reachability {
    const cached=this.reachCache.get(file);if(cached)return cached;
    const result:Reachability={files:new Map([[file,[]]]),gaps:[]},project=this.owner(file);
    const queue=[file];
    for(const map of project.files)if(map.active!==false)for(const input of map.paths) {
      if(map.active==='unknown'){result.gaps.push(`Composer autoload-dev files are not selected: ${map.manifest}`);continue;}
      const available=this.availability(input);
      if(available.status==='available') {if(!result.files.has(input)) {
        if(result.files.size>=MAX_REACHABLE){result.gaps.push('PHP Composer files reachability budget exceeded');continue;}
        result.files.set(input,[this.proof(map.manifest,'Indexed Composer files autoload source contract'),this.proof(input,'Original Composer files target; execution/order unverified')]);queue.push(input);
      }}
      else result.gaps.push(available.reason);
    }
    let visited=0;
    while(queue.length&&visited++<MAX_REACHABLE) {
      const current=queue.shift()!;
      if(!this.facts(current)){result.gaps.push(`Original PHP facts unavailable for loaded source: ${current}`);continue;}
      for(const load of this.loads(current))if(load.outcome.status==='resolved') {
        for(const id of load.outcome.targets) {
          const target=this.context.graph.entities.get(id)?.path;if(!target||result.files.has(target))continue;
          if(result.files.size>=MAX_REACHABLE){result.gaps.push('PHP source load reachability budget exceeded');queue.length=0;break;}
          const proof=[...result.files.get(current)??[],...load.outcome.proof];
          if(proof.length>128){result.gaps.push('PHP source load proof-hop budget exceeded');continue;}
          result.files.set(target,proof);queue.push(target);
        }
      }
    }
    if(queue.length)result.gaps.push('PHP source load traversal budget exceeded');
    this.reachCache.set(file,result);return result;
  }
  private match(items:SymbolSite[],imported:PhpImportFact,exact=false):SymbolSite[] {
    const kinds=imported.kind==='class'?['class','interface','trait','enum']:imported.kind==='function'?['function']:['constant'];
    return items.filter(item=>kinds.includes(item.fact.kind)&&(exact?item.fact.qualifiedName===imported.specifier:imported.kind==='const'?constantKey(item.fact.qualifiedName)===constantKey(imported.specifier):phpFold(item.fact.qualifiedName)===phpFold(imported.specifier)));
  }
  private finish(items:SymbolSite[],proof:Evidence[]):ImportOutcome|undefined {
    const unique=[...new Map(items.map(item=>[item.id,item])).values()];
    if(unique.length>1)return {status:'ambiguous',candidates:unique.map(item=>item.id).sort(),reason:'Multiple original PHP declarations match this source contract; no runtime winner is inferred'};
    if(unique.length===1)return {status:'resolved',targets:[unique[0]!.id],proof:[...proof,this.proof(unique[0]!.file,'Original declaration matched by PHP name/kind; activation remains unverified',unique[0]!.fact.range.startLine)]};
  }
  private classCatalog(project:Project):ClassCatalog {
    const cached=this.classCache.get(project.id);if(cached)return cached;
    const catalog:ClassCatalog={items:new Map(),gaps:[]};
    const excludes=project.classmaps.filter(map=>map.active===true).flatMap(map=>map.exclude);
    const unknownExcludes=project.classmaps.filter(map=>map.active==='unknown').flatMap(map=>map.exclude);
    const excluded=(candidate:string)=>excludes.some(exclude=>matchesGlob(candidate,exclude)||matchesGlob(candidate,`${exclude.replace(/\/$/,'')}/**`));
    let work=0;
    for(const map of project.classmaps)if(map.active!==false)for(const input of map.paths) {
      const selected=(candidate:string)=>input.includes('*')?matchesGlob(candidate,input)||matchesGlob(candidate,`${input.replace(/\/$/,'')}/**`):inside(candidate,input);
      if(!input.includes('*')&&!this.context.scannedDirectories?.has(input)) {
        const available=this.availability(input);
        if(available.status!=='available')catalog.gaps.push(available.reason);
      }
      const prefix=input.includes('*')?path.posix.dirname(input.slice(0,input.indexOf('*'))+'placeholder'):input;
      for(const directory of this.context.directoryInventory??[])if((selected(directory)||input.includes('*')&&(inside(directory,prefix)||inside(prefix,directory)))&&!excluded(directory)&&!this.context.scannedDirectories?.has(directory))catalog.gaps.push(`Classmap directory is excluded/unavailable: ${directory}`);
      for(const candidate of this.context.fileInventory??[]) {
        if(++work>1_000_000){catalog.gaps.push('Composer classmap discovery work budget exceeded');break;}
        if(!selected(candidate)||excluded(candidate)||! /\.(?:php|inc|hh)$/i.test(candidate))continue;
        if(/\.hh$/i.test(candidate)){catalog.gaps.push(`Composer HH classmap input needs an explicit PHP source-language profile: ${candidate}`);continue;}
        const available=this.availability(candidate);
        if(available.status!=='available'){catalog.gaps.push(available.reason);continue;}
        if(!this.facts(candidate)){catalog.gaps.push(`Original classmap facts unavailable: ${candidate}`);continue;}
        for(const site of this.symbols.get(candidate)??[])if(['class','interface','trait','enum'].includes(site.fact.kind)) {
          const key=site.fact.qualifiedName,items=catalog.items.get(key)??[];
          if(items.length>=MAX_MAPS){catalog.gaps.push('Composer classmap declaration budget exceeded');break;}
          const active=map.active===true&&unknownExcludes.some(exclude=>matchesGlob(candidate,exclude)||matchesGlob(candidate,`${exclude.replace(/\/$/,'')}/**`))?'unknown':map.active;
          items.push({site,manifest:map.manifest,active});catalog.items.set(key,items);
        }
      }
      if(work>1_000_000||catalog.gaps.length>=100)break;
    }
    catalog.gaps=[...new Set(catalog.gaps)].slice(0,100);this.classCache.set(project.id,catalog);return catalog;
  }
  resolve(file:string,imported:PhpImportFact):ImportOutcome {
    if(imported.conditions.length)return {status:'unsupported',reason:'PHP namespace imports must occur in original outermost namespace scope'};
    const siblings=(this.facts(file)?.imports??[]).filter(item=>item.scope===imported.scope&&item.kind===imported.kind&&(imported.kind==='const'?item.alias===imported.alias:phpFold(item.alias)===phpFold(imported.alias)));
    if(siblings.length>1)return {status:'ambiguous',candidates:siblings.map(item=>item.specifier),reason:'Duplicate original aliases in the same namespace import table'};
    const reachable=this.reachable(file),loadedSites=[...reachable.files.keys()].flatMap(input=>this.match(this.symbols.get(input)??[],imported));
    const loaded=this.finish(loadedSites,loadedSites.length===1?reachable.files.get(loadedSites[0]!.file)??[]:[]);
    if(loaded)return loaded;
    const project=this.owner(file);
    if(project.gaps.length)return {status:'unsupported',reason:project.gaps.join('; ')};
    if(imported.kind==='class') {
      const catalog=this.classCatalog(project),classmap=catalog.items.get(imported.specifier)??[];
      if(catalog.gaps.length)return {status:'unsupported',reason:catalog.gaps.join('; ')};
      if(classmap.some(item=>item.active==='unknown'))return {status:'unsupported',reason:'Matching Composer classmap requires explicit autoloadDev selection'};
      if(classmap.length)return this.finish(classmap.map(item=>item.site),classmap.map(item=>this.proof(item.manifest,'Indexed Composer classmap contract')))!;
      const candidates:SymbolSite[]=[],proof:Evidence[]=[],gaps:ImportOutcome[]=[];
      for(const kind of ['psr-4','psr-0'] as const) {
        const maps=project.maps.filter(map=>map.kind===kind&&map.active!==false&&(map.prefix===''||imported.specifier.startsWith(map.prefix))).sort((a,b)=>b.prefix.length-a.prefix.length);
        // Longest PSR-4 prefix is tried first, followed by parent/fallback
        // prefixes, preserving each manifest's ordered directory list.
        const prefixes=[...new Set(maps.map(map=>map.prefix))];
        for(const prefix of prefixes) {
          const groups=new Map<string,Mapping[]>();
          for(const map of maps.filter(item=>item.prefix===prefix))groups.set(map.manifest,[...groups.get(map.manifest)??[],map]);
          // Root mappings precede dependency mappings for an equal prefix.
          const ordered=[...groups].sort(([a],[b])=>Number(b===project.manifest)-Number(a===project.manifest));
          for(const [manifest,group] of ordered) {
            let selected=false;
            for(const map of group) {
              const full=kind==='psr-4'?imported.specifier.slice(map.prefix.length):imported.specifier;
              const separator=full.lastIndexOf('\\'),suffix=kind==='psr-4'?full.replaceAll('\\','/'):(separator<0?'':full.slice(0,separator+1).replaceAll('\\','/'))+full.slice(separator+1).replaceAll('_','/');
              if(/[\0\r\n/:]/.test(full)){gaps.push({status:'unsupported',reason:'Invalid original PHP qualified import path'});continue;}
              for(const root of map.roots) {
                const candidate=relative(root,`${suffix}.php`);if(!candidate){gaps.push({status:'unsupported',reason:'PSR target leaves repository'});break;}
                const available=this.availability(candidate);if(available.status==='absent')continue;
                selected=true;
                if(available.status!=='available'){gaps.push({status:available.status,reason:available.reason});break;}
                if(map.active==='unknown'){gaps.push({status:'unsupported',reason:`Matching PSR map requires explicit autoloadDev selection: ${map.manifest}`});break;}
                const found=this.match(this.symbols.get(candidate)??[],imported,true);
                if(!this.facts(candidate))gaps.push({status:'unsupported',reason:`Original PSR target facts unavailable: ${candidate}`});
                else if(!found.length)gaps.push({status:'unresolved',reason:`First existing PSR file does not declare the requested exact original type: ${candidate}`});
                else {candidates.push(...found);proof.push(this.proof(map.manifest,`Indexed Composer ${kind} prefix ${map.prefix||'(fallback)'} and ordered roots`));}
                break;
              }
              if(selected)break;
            }
            if(selected&&manifest===project.manifest)break;
          }
          if(candidates.length||gaps.length)break;
        }
        if(candidates.length||gaps.length)break;
      }
      const resolved=this.finish(candidates,proof);
      if(resolved&&gaps.length)return {status:'unsupported',reason:'A competing Composer source mapping is unavailable or unselected; a runtime/source winner cannot be established'};
      if(resolved)return resolved;
      if(gaps.length)return gaps[0]!;
      if(project.runtime.autoloadDev===undefined&&project.external.some(pkg=>pkg.dev&&pkg.prefixes.some(prefix=>imported.specifier.startsWith(prefix))))return {status:'unsupported',reason:'Matching locked dev package requires explicit autoloadDev selection'};
      const external=project.external.filter(pkg=>(!pkg.dev||project.runtime.autoloadDev===true)&&pkg.prefixes.some(prefix=>imported.specifier.startsWith(prefix)));
      if(external.length===1)return {status:'external',dependency:external[0]!.name,proof:[this.proof(path.posix.join(project.root,'composer.lock'),'Exact indexed lock package namespace prefix; installed vendor source is not inspected')]};
      if(external.length>1)return {status:'ambiguous',candidates:external.map(pkg=>pkg.name),reason:'Multiple indexed locked packages advertise this namespace prefix'};
    }
    if(reachable.gaps.length)return {status:'unsupported',reason:reachable.gaps.join('; ')};
    if(imported.kind==='class'&&[...this.symbols.values()].some(items=>items.some(item=>item.fact.qualifiedName.startsWith(`${imported.specifier}\\`))))return {status:'unsupported',reason:'Original namespace alias needs a concrete qualified use site; namespace aliasing itself does not autoload a class'};
    return {status:'unresolved',reason:`No indexed original ${imported.kind} declaration is reachable through the recorded Composer/literal-load source contracts: ${imported.specifier}`};
  }
  composerFiles(file:string):{specifier:string;manifest:string;outcome:ImportOutcome;dev:boolean}[] {
    return this.owner(file).files.flatMap(map=>map.active===false?[]:map.paths.map(specifier=>({specifier,manifest:map.manifest,dev:map.dev,outcome:map.active==='unknown'?{status:'unsupported' as const,reason:'Composer autoload-dev files require explicit autoloadDev selection'}:this.resolveFiles([specifier],file,'Indexed Composer files source dependency; loader execution is unverified')})));
  }
}
