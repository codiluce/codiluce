// Bundle only Codiluce's own parser helpers. Never build or execute target code.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import ts from 'typescript';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const output='src/analysis/tree-sitter/native-script-worker.mjs';
const inputs=['src/analysis/source-map.ts','src/analysis/tree-sitter/erb-script.ts','src/analysis/tree-sitter/script-worker.ts','src/analysis/tree-sitter/template-facts.ts'];

export async function scriptWorkerBundle(){
  const result=await build({absWorkingDir:root,entryPoints:['src/analysis/tree-sitter/script-worker.ts'],outfile:output,bundle:true,format:'esm',platform:'node',target:'node22.12',packages:'external',write:false,metafile:true,legalComments:'inline',banner:{js:'// Generated from Codiluce’s typed source-only parser. Do not edit.\n// Rebuild: npm run build:script-worker'}});
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(),inputs,'Compiler bootstrap must include only the approved source-only helpers');
  const imports=Object.values(result.metafile.outputs).flatMap(item=>item.imports);
  assert.deepEqual(imports.map(({path,kind,external})=>({path,kind,external})),[{path:'typescript',kind:'dynamic-import',external:true}]);
  const text=result.outputFiles[0].text,source=ts.createSourceFile('owned-script-worker.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let compilerImports=0;
  function visit(node){
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){
      let owner=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
      assert.equal(owner?.name?.text,'handle','Optional compiler import must run inside a source job, never during bootstrap');compilerImports++;
    }
    ts.forEachChild(node,visit);
  }
  visit(source);assert.equal(compilerImports,1);
  return text;
}
export async function verifyScriptWorkerBundle(){
  assert.equal(await readFile(path.join(root,output),'utf8'),await scriptWorkerBundle(),'Parser bundle drift: run npm run build:script-worker');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--check'))await verifyScriptWorkerBundle();
  else await writeFile(path.join(root,output),await scriptWorkerBundle());
}
