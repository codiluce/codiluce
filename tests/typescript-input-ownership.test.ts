import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import {createApplicationProgram,TypeScriptSourceCache} from '../src/analyzers/ts-program.js';

const options:ts.CompilerOptions={noLib:true,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,target:ts.ScriptTarget.ESNext};
const diagnostics=(program:ts.Program)=>program.getSemanticDiagnostics().map(d=>({code:d.code,file:d.file?.fileName,start:d.start,length:d.length,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
test('registered compiler roots preserve complete map-host source, imports, globals, direct aliases and diagnostics under disabled and evicting AST admission',()=>{
 const root=path.resolve('owned-registered-compiler-roots'),entry=path.join(root,'entry.ts'),leaf=path.join(root,'leaf.ts'),texts=new Map([[entry,'// é😀 original\r\nimport {leaf as read} from "./leaf";export const original=read(1);missingOriginal();throw new Error("Target never executes");'],[leaf,'export function leaf(value:number):number{return value+1;}'],[path.join(root,'globals.d.ts'),'declare function missingOriginal():void;']]);
 for(const maxEntries of [0,1,20]){
  const sourceCache=new TypeScriptSourceCache({maxBytes:100000,maxNodes:10000,maxEntries}),map=createApplicationProgram(texts,options,root,{sourceCache}),reads:string[]=[],registered=createApplicationProgram(new Set(texts.keys()),options,root,{sourceCache,readSource:file=>{reads.push(file);return texts.get(file);}});
  assert.deepEqual(registered.getRootFileNames(),map.getRootFileNames());assert.deepEqual(registered.getSourceFiles().map(f=>({file:f.fileName,text:f.text})),map.getSourceFiles().map(f=>({file:f.fileName,text:f.text})));assert.deepEqual(diagnostics(registered),diagnostics(map));assert.ok(reads.includes(entry)&&reads.includes(leaf));
  const source=registered.getSourceFile(entry)!,checker=registered.getTypeChecker();let call:ts.CallExpression|undefined;const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(source)==='read')call=node;ts.forEachChild(node,visit);};visit(source);assert.ok(call);const alias=checker.getSymbolAtLocation(call.expression)!;assert.ok(alias.flags&ts.SymbolFlags.Alias);assert.equal(checker.getAliasedSymbol(alias).declarations![0]!.getSourceFile().fileName,leaf);assert.equal(checker.typeToString(checker.getTypeAtLocation(call)),'number');
 }
});
test('registered roots reload original text before AST reuse and unchanged compiler roots do not authorize stale cached input',()=>{
 const root=path.resolve('owned-root-text-revalidation'),file=path.join(root,'original.ts'),roots=new Set([file]),cache=new TypeScriptSourceCache({maxBytes:100000,maxNodes:10000,maxEntries:10});let text:string|undefined='export const original=1;',reads=0;const make=()=>createApplicationProgram(roots,options,root,{sourceCache:cache,readSource:name=>{if(name===file){reads++;return text;}return undefined;}});
 const first=make();assert.equal(make().getSourceFile(file),first.getSourceFile(file));assert.ok(reads>=2);text='export const original="changed é😀";';const changed=make();assert.equal(changed.getSourceFile(file)!.text,text);assert.notEqual(changed.getSourceFile(file),first.getSourceFile(file));assert.equal(cache.stats().invalidations,1);text=undefined;assert.equal(make().getSourceFile(file),undefined);
});
test('registered compiler roots preserve trusted library reads and original function types',()=>{
 const root=path.resolve('owned-root-libraries'),file=path.join(root,'original.ts'),text='export function original(value:string):number{return value.length;}';const references:string[]=[];
 const program=createApplicationProgram(new Set([file]),{...options,noLib:false,lib:['lib.es5.d.ts']},root,{readSource:name=>{references.push(name);return name===file?text:undefined;},moduleHost:{fileExists:()=>false,readFile:()=>undefined}}),source=program.getSourceFile(file)!,checker=program.getTypeChecker(),fn=source.statements[0]as ts.FunctionDeclaration;
 assert.equal(checker.typeToString(checker.getTypeAtLocation(fn)),'(value: string) => number');assert.ok(program.getSourceFiles().some(f=>f.fileName.endsWith('lib.es5.d.ts')));assert.ok(references.includes(file));assert.deepEqual(program.getSyntacticDiagnostics(),[]);
});
