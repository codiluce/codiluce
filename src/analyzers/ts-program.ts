// A TypeScript program per project, for type-aware call resolution.
//
// The compiler host sees only the project's roots, its indexed dependencies and the
// TypeScript compiler's own lib files: never node_modules, never files outside
// the index. A working-tree index and a history snapshot of the same commit
// (where no node_modules exists) therefore resolve identically, and a package
// type can never decide which indexed symbol a call reaches. Only declared
// local packages are visible; installed packages remain external.
//
// Parsed source files are cached per process by path and text, so a history
// worker that analyzes consecutive commits reparses only the files that changed.
import ts from 'typescript';
import path from 'node:path';

export interface TypeScriptCacheLimits {maxBytes:number;maxNodes:number;maxEntries:number}
export const TYPESCRIPT_SOURCE_CACHE_LIMITS:Readonly<TypeScriptCacheLimits>=Object.freeze({maxBytes:32*1024*1024,maxNodes:1_000_000,maxEntries:4096});
export const TYPESCRIPT_LIBRARY_CACHE_LIMITS:Readonly<TypeScriptCacheLimits>=Object.freeze({maxBytes:16*1024*1024,maxNodes:500_000,maxEntries:128});
interface CachedSource {source:ts.SourceFile;parseKey:string;bytes:number;nodes:number}

/** Process-owned parse reuse, bounded separately from live compiler programs.
 * UTF-16 source/key payload and compiler child-visitor nodes are admission
 * measures, not JS object size, checker memory or an RSS cap. An oversized
 * original remains a valid program input; only its cached ownership is denied. */
export class TypeScriptSourceCache {
  private readonly entries=new Map<string,CachedSource>();
  private bytes=0;private nodes=0;private peakBytes=0;private peakNodes=0;private peakEntries=0;
  private hits=0;private misses=0;private evictions=0;private invalidations=0;private bypasses=0;
  readonly limits:Readonly<TypeScriptCacheLimits>;
  constructor(limits:TypeScriptCacheLimits=TYPESCRIPT_SOURCE_CACHE_LIMITS){
    for(const name of ['maxBytes','maxNodes','maxEntries']as const)if(!Number.isSafeInteger(limits[name])||limits[name]<0)throw Error('TypeScript source cache limits require nonnegative safe integers');
    this.limits=Object.freeze({...limits});
  }
  stats(){return {limits:this.limits,bytes:this.bytes,nodes:this.nodes,entries:this.entries.size,peakBytes:this.peakBytes,peakNodes:this.peakNodes,peakEntries:this.peakEntries,hits:this.hits,misses:this.misses,evictions:this.evictions,invalidations:this.invalidations,bypasses:this.bypasses};}
  get(cacheKey:string,text:string|undefined,parseKey:string):ts.SourceFile|undefined {
    const cached=this.entries.get(cacheKey);
    if(!cached){this.misses++;return undefined;}
    if(cached.parseKey!==parseKey||text!==undefined&&cached.source.text!==text){this.forget(cacheKey);this.invalidations++;this.misses++;return undefined;}
    this.entries.delete(cacheKey);this.entries.set(cacheKey,cached);this.hits++;return cached.source;
  }
  put(cacheKey:string,parseKey:string,source:ts.SourceFile):void {
    this.forget(cacheKey);
    const bytes=2*(cacheKey.length+parseKey.length+source.fileName.length+source.text.length);
    if(!this.limits.maxEntries||bytes>this.limits.maxBytes){this.bypasses++;return;}
    // Stop admission counting once this cache cannot retain the tree. No
    // parent links, checker symbols or compiler token caches are traversed.
    let nodes=0;const pending:ts.Node[]=[source];
    while(pending.length){const node=pending.pop()!;if(++nodes>this.limits.maxNodes){this.bypasses++;return;}const overflow=ts.forEachChild(node,child=>{if(nodes+pending.length>=this.limits.maxNodes)return true;pending.push(child);return undefined;});if(overflow){this.bypasses++;return;}}
    while(this.entries.size>=this.limits.maxEntries||this.bytes+bytes>this.limits.maxBytes||this.nodes+nodes>this.limits.maxNodes){this.forget(this.entries.keys().next().value!);this.evictions++;}
    this.entries.set(cacheKey,{source,parseKey,bytes,nodes});this.bytes+=bytes;this.nodes+=nodes;
    this.peakBytes=Math.max(this.peakBytes,this.bytes);this.peakNodes=Math.max(this.peakNodes,this.nodes);this.peakEntries=Math.max(this.peakEntries,this.entries.size);
  }
  private forget(cacheKey:string):void {const cached=this.entries.get(cacheKey);if(cached){this.entries.delete(cacheKey);this.bytes-=cached.bytes;this.nodes-=cached.nodes;}}
  clear():void {this.entries.clear();this.bytes=0;this.nodes=0;}
}
const LIB_CACHE = new TypeScriptSourceCache(TYPESCRIPT_LIBRARY_CACHE_LIMITS);
const FILE_CACHE = new TypeScriptSourceCache();
export function applicationSourceCacheStats(){return {source:FILE_CACHE.stats(),libraries:LIB_CACHE.stats()};}

export function scriptKind(fileName: string): ts.ScriptKind {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.json' ? ts.ScriptKind.JSON : extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
/** Program options: the application's tsconfig, minus everything that would read outside the index or emit. */
export function programOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  return { ...options, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, types: [], typeRoots: [], declaration: false, composite: false, incremental: false, tsBuildInfoFile: undefined, plugins: undefined, sourceMap: false, noResolve: false };
}
export interface ProgramInputs {
  rootNames?: string[];
  readSource?: (fileName: string) => string | undefined;
  moduleHost?: ts.ModuleResolutionHost;
  resolveModuleNameLiterals?: ts.CompilerHost['resolveModuleNameLiterals'];
  /** Owned parser-cache profiles; changing admission never changes inputs. */
  sourceCache?:TypeScriptSourceCache;
  libraryCache?:TypeScriptSourceCache;
}
/** A registered source set keeps compiler-host ownership to file identities.
 * Its text provider remains the indexed read boundary; AST/cache/checker text
 * ownership is separate. Explicit text maps remain supported for callers. */
export function createApplicationProgram(files: ReadonlyMap<string, string> | ReadonlySet<string>, options: ts.CompilerOptions, currentDirectory: string, inputs: ProgramInputs = {}): ts.Program {
  const compilerOptions = programOptions(options);
  const libDirectory = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
  const isLib = (fileName: string) => path.dirname(fileName) === libDirectory && fileName.endsWith('.d.ts');
  const directories = new Set<string>([libDirectory]);
  for (const file of files.keys()) for (let directory = path.dirname(file); !directories.has(directory); directory = path.dirname(directory)) { directories.add(directory); if (directory === path.dirname(directory)) break; }
  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersionOrOptions) {
      const parseKey = JSON.stringify(languageVersionOrOptions);
      const key = JSON.stringify([currentDirectory, parseKey, compilerOptions.moduleDetection, compilerOptions.module, compilerOptions.jsx]);
      const text = ('get' in files ? files.get(fileName) : undefined) ?? inputs.readSource?.(fileName);
      if (text !== undefined) {
        const cacheKey = `${currentDirectory}\0${fileName}`;
        const cache=inputs.sourceCache??FILE_CACHE,cached=cache.get(cacheKey,text,key);
        if (cached) return cached;
        const source = ts.createSourceFile(fileName, text, languageVersionOrOptions, true, scriptKind(fileName));
        cache.put(cacheKey,key,source);
        return source;
      }
      if (!isLib(fileName)) return undefined;
      // Compiler-owned declaration libraries are safe to share, as in the
      // original host. Project source ASTs keep their own scope/cache key.
      const libKey = fileName,cache=inputs.libraryCache??LIB_CACHE;
      let source = cache.get(libKey,undefined,parseKey);
      if (!source) {
        const content = ts.sys.readFile(fileName);
        if (content === undefined) return undefined;
        source = ts.createSourceFile(fileName, content, languageVersionOrOptions, false);
        cache.put(libKey,parseKey,source);
      }
      return source;
    },
    getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
    writeFile: () => undefined,
    getCurrentDirectory: () => currentDirectory,
    getCanonicalFileName: fileName => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: fileName => files.has(fileName) || !!inputs.moduleHost?.fileExists(fileName) || (isLib(fileName) && ts.sys.fileExists(fileName)),
    readFile: fileName => ('get' in files ? files.get(fileName) : files.has(fileName) ? inputs.readSource?.(fileName) : undefined) ?? inputs.moduleHost?.readFile(fileName) ?? (isLib(fileName) ? ts.sys.readFile(fileName) : undefined),
    directoryExists: directory => directories.has(directory) || !!inputs.moduleHost?.directoryExists?.(directory),
    getDirectories: () => [],
    realpath: fileName => fileName,
    ...(inputs.resolveModuleNameLiterals ? { resolveModuleNameLiterals: inputs.resolveModuleNameLiterals } : {}),
  };
  return ts.createProgram({ rootNames: inputs.rootNames ?? [...files.keys()].sort(), options: compilerOptions, host });
}
