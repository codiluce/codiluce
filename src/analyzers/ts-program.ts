// A TypeScript program per application, for type-aware call resolution.
//
// The compiler host sees only the application's indexed source files and the
// TypeScript compiler's own lib files: never node_modules, never files outside
// the index. A working-tree index and a history snapshot of the same commit
// (where no node_modules exists) therefore resolve identically, and a package
// type can never decide which indexed symbol a call reaches. Package imports
// resolve to nothing; calls into them count as external.
//
// Parsed source files are cached per process by path and text, so a history
// worker that analyzes consecutive commits reparses only the files that changed.
import ts from 'typescript';
import path from 'node:path';

const LIB_CACHE = new Map<string, ts.SourceFile>();
const FILE_CACHE = new Map<string, { text: string; key: string; source: ts.SourceFile }>();
const FILE_CACHE_LIMIT = 20_000;

export function scriptKind(fileName: string): ts.ScriptKind {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
/** Program options: the application's tsconfig, minus everything that would read outside the index or emit. */
export function programOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  return { ...options, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, types: [], typeRoots: [], declaration: false, composite: false, incremental: false, tsBuildInfoFile: undefined, plugins: undefined, sourceMap: false, noResolve: false };
}
export function createApplicationProgram(files: Map<string, string>, options: ts.CompilerOptions, currentDirectory: string): ts.Program {
  const compilerOptions = programOptions(options);
  const libDirectory = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
  const isLib = (fileName: string) => path.dirname(fileName) === libDirectory && fileName.endsWith('.d.ts');
  const directories = new Set<string>([libDirectory]);
  for (const file of files.keys()) for (let directory = path.dirname(file); !directories.has(directory); directory = path.dirname(directory)) { directories.add(directory); if (directory === path.dirname(directory)) break; }
  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersionOrOptions) {
      const key = JSON.stringify(languageVersionOrOptions);
      const text = files.get(fileName);
      if (text !== undefined) {
        const cached = FILE_CACHE.get(fileName);
        if (cached && cached.text === text && cached.key === key) return cached.source;
        const source = ts.createSourceFile(fileName, text, languageVersionOrOptions, true, scriptKind(fileName));
        if (FILE_CACHE.size > FILE_CACHE_LIMIT) FILE_CACHE.clear();
        FILE_CACHE.set(fileName, { text, key, source });
        return source;
      }
      if (!isLib(fileName)) return undefined;
      const libKey = `${fileName}\0${key}`;
      let source = LIB_CACHE.get(libKey);
      if (!source) {
        const content = ts.sys.readFile(fileName);
        if (content === undefined) return undefined;
        source = ts.createSourceFile(fileName, content, languageVersionOrOptions, false);
        LIB_CACHE.set(libKey, source);
      }
      return source;
    },
    getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
    writeFile: () => undefined,
    getCurrentDirectory: () => currentDirectory,
    getCanonicalFileName: fileName => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: fileName => files.has(fileName) || (isLib(fileName) && ts.sys.fileExists(fileName)),
    readFile: fileName => files.get(fileName) ?? (isLib(fileName) ? ts.sys.readFile(fileName) : undefined),
    directoryExists: directory => directories.has(directory),
    getDirectories: () => [],
    realpath: fileName => fileName,
  };
  return ts.createProgram({ rootNames: [...files.keys()].sort(), options: compilerOptions, host });
}
