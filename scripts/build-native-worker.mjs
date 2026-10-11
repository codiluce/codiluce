// Bundle only Codiluce's own parser helpers. Never build or execute target code.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import ts from 'typescript';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const output='src/analysis/tree-sitter/native-worker.mjs';
const inputs=[
  "src/analysis/languages/rust-cfg.ts",
  "src/analysis/source-map.ts",
  "src/analysis/tree-sitter/cfamily-source.ts",
  "src/analysis/tree-sitter/cfamily-structure.ts",
  "src/analysis/tree-sitter/csharp-semantic.ts",
  "src/analysis/tree-sitter/csharp-syntax.ts",
  "src/analysis/tree-sitter/embedded-host.ts",
  "src/analysis/tree-sitter/erb-script.ts",
  "src/analysis/tree-sitter/erb-structure.ts",
  "src/analysis/tree-sitter/extract.ts",
  "src/analysis/tree-sitter/fsharp-structure.ts",
  "src/analysis/tree-sitter/go-imports.ts",
  "src/analysis/tree-sitter/go-syntax.ts",
  "src/analysis/tree-sitter/grammars.ts",
  "src/analysis/tree-sitter/groovy-structure.ts",
  "src/analysis/tree-sitter/jvm-semantic.ts",
  "src/analysis/tree-sitter/jvm-syntax.ts",
  "src/analysis/tree-sitter/liquid-structure.ts",
  "src/analysis/tree-sitter/objc-cpp.ts",
  "src/analysis/tree-sitter/objc-macros.ts",
  "src/analysis/tree-sitter/objc-regions.ts",
  "src/analysis/tree-sitter/objc-structure.ts",
  "src/analysis/tree-sitter/python-imports.ts",
  "src/analysis/tree-sitter/razor-structure.ts",
  "src/analysis/tree-sitter/ruby-syntax.ts",
  "src/analysis/tree-sitter/rust-semantic.ts",
  "src/analysis/tree-sitter/rust-syntax.ts",
  "src/analysis/tree-sitter/scala-structure.ts",
  "src/analysis/tree-sitter/swift-structure.ts",
  "src/analysis/tree-sitter/template-facts.ts",
  "src/analysis/tree-sitter/vbnet-source.ts",
  "src/analysis/tree-sitter/vbnet-structure.ts",
  "src/analysis/tree-sitter/worker.ts"
];

export async function nativeWorkerBundle(){
  const result=await build({absWorkingDir:root,entryPoints:['src/analysis/tree-sitter/worker.ts'],outfile:output,bundle:true,format:'esm',platform:'node',target:'node22.12',packages:'external',write:false,metafile:true,legalComments:'inline',banner:{js:'// Generated from Codiluce’s typed source-only parser. Do not edit.\n// Rebuild: npm run build:native-worker'}});
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(),inputs,'Native worker must include only the approved source-only helpers');
  const imports=Object.values(result.metafile.outputs).flatMap(item=>item.imports);
  assert.deepEqual(imports.map(({path,kind,external})=>({path,kind,external})),[
    ...['web-tree-sitter','node:crypto','node:fs','node:url'].map(path=>({path,kind:'import-statement',external:true})),
    ...Array.from({length:3},()=>({path:'typescript',kind:'dynamic-import',external:true})),
  ]);
  const text=result.outputFiles[0].text,source=ts.createSourceFile('owned-native-worker.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let compilerImports=0;
  function visit(node){
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){
      let owner=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
      assert.equal(owner?.name?.text,'handle','Optional compiler import must run inside a source job, never during bootstrap');compilerImports++;
    }
    ts.forEachChild(node,visit);
  }
  visit(source);assert.equal(compilerImports,3);
  // Only grammars.ts uses import.meta.url, and it shares the output directory.
  for(const input of inputs) if((await readFile(path.join(root,input),'utf8')).includes('import.meta.url'))assert.equal(input,'src/analysis/tree-sitter/grammars.ts');
  return text;
}
export async function verifyNativeWorkerBundle(){
  assert.equal(await readFile(path.join(root,output),'utf8'),await nativeWorkerBundle(),'Parser bundle drift: run npm run build:native-worker');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--check'))await verifyNativeWorkerBundle();
  else await writeFile(path.join(root,output),await nativeWorkerBundle());
}
