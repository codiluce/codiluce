import type ts from 'typescript';
import type {DeclarationFact,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';
import {erbIssue} from './erb-structure.js';

/** Parse-only original literal scripts. No compiler output, virtual source file,
 * import execution/resolution, browser evaluation or rendered source is indexed. */
export function extractErbScripts(compiler:typeof ts,content:string,facts:StructureFacts):void {
 const original=new SourceText(content);let ordinal=0;
 for(const region of facts.erb!.host.regions.filter(r=>r.kind==='script')){
  const key=`script:${ordinal++}`;if(!region.supported||region.language!=='javascript')continue;
  const text=content.slice(region.bodyStart,region.bodyEnd),source=compiler.createSourceFile('original-inline-script.js',text,compiler.ScriptTarget.Latest,true,compiler.ScriptKind.JS),offset=region.bodyStart;
  if((source as ts.SourceFile&{parseDiagnostics:readonly ts.Diagnostic[]}).parseDiagnostics.length){region.supported=false;facts.erb!.host.complete=false;erbIssue(facts,'erb-script-parse-gap','Literal original JavaScript failed parsing; this script is quarantined without affecting other source regions',region.bodyRange);continue;}
  // The parser accepts TypeScript extensions in ScriptKind.JS. Its JavaScript
  // grammar diagnostics reject those extensions. The host exposes only these
  // original bytes: no libraries, filesystem reads, resolution or emit occurs.
  const program=compiler.createProgram([source.fileName],{allowJs:true,noResolve:true,noLib:true,noEmit:true},{getSourceFile:name=>name===source.fileName?source:undefined,getDefaultLibFileName:()=>'',writeFile:()=>{},getCurrentDirectory:()=>'',getDirectories:()=>[],fileExists:name=>name===source.fileName,readFile:name=>name===source.fileName?text:undefined,getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n'});
  if(program.getSyntacticDiagnostics(source).length){region.supported=false;facts.erb!.host.complete=false;erbIssue(facts,'erb-script-processor-gap','Literal script contains syntax outside JavaScript; a qualified source processor is required and this script is quarantined',region.bodyRange);continue;}
  if(compiler.isExternalModule(source)&&region.attributes.find(a=>a.name.toLowerCase()==='type')?.value?.trim().toLowerCase()!=='module'){region.supported=false;facts.erb!.host.complete=false;erbIssue(facts,'erb-script-module-gap','Literal import/export syntax requires an explicit module script type; client declarations are quarantined',region.bodyRange);continue;}
  let count=0;const claimedInitializers=new Set<ts.Node>(),pending:{node:ts.Node;parent?:DeclarationFact;blocked:boolean;depth:number}[]=[{node:source,blocked:false,depth:0}];
  while(pending.length){const item=pending.pop()!,node=item.node;let parent=item.parent,blocked=item.blocked;
   if(++count>200_000||item.depth>128||facts.declarations.length>=20_000){facts.truncated=true;region.supported=false;break;}
   const classNode=compiler.isClassDeclaration(node)||compiler.isClassExpression(node),functionNode=compiler.isFunctionDeclaration(node)||compiler.isFunctionExpression(node),method=compiler.isMethodDeclaration(node)||compiler.isGetAccessorDeclaration(node)||compiler.isSetAccessorDeclaration(node),constructor=compiler.isConstructorDeclaration(node),name=(classNode||functionNode||method)?node.name:undefined;
   let initializer=compiler.isVariableDeclaration(node)?node.initializer:undefined;while(initializer&&compiler.isParenthesizedExpression(initializer))initializer=initializer.expression;
   if(compiler.isVariableDeclaration(node)&&initializer&&(compiler.isFunctionExpression(initializer)||compiler.isArrowFunction(initializer))){
    const start=node.getStart(source),headerEnd=initializer.body.getStart(source);
    if(blocked||!compiler.isIdentifier(node.name)){blocked=true;erbIssue(facts,'erb-script-owner-gap','Callable source binding requires an original identifier and qualified lexical owner; descendants are quarantined',original.range(offset+start,offset+node.end));}
    else if(headerEnd-start>1200){blocked=true;region.supported=false;erbIssue(facts,'erb-script-header-gap','Original callable binding header exceeds the bounded signature profile; descendants are quarantined',original.range(offset+start,offset+headerEnd));}
    else{const nameText=node.name.getText(source),kind=compiler.isArrowFunction(initializer)?'arrow-binding':'function-binding',fact:DeclarationFact={key:`erb-${key}:${offset+start}:${offset+node.end}:${kind}`,name:nameText,qualifiedName:[parent?.qualifiedName??key,nameText].join('::'),kind,entityType:'function',signature:text.slice(start,headerEnd).trim(),start:offset+start,end:offset+node.end,nameEnd:offset+node.name.end,range:original.range(offset+start,offset+node.end),declarationForm:'definition',sourceConditions:['Original JavaScript variable initializer binding; assignment, aliases, mutation, rendered/browser execution and call binding remain unverified'],embeddedSource:{language:'javascript',executionContext:'browser',headerRange:original.range(offset+start,offset+headerEnd),regions:[original.range(offset+start,offset+node.end)]},...parent?{parent:parent.key}:{}};facts.declarations.push(fact);parent=fact;claimedInitializers.add(initializer);}
   }
   if(!claimedInitializers.has(node)&&(classNode||functionNode||method||constructor)){
    if(blocked||!name&&!constructor||((method||constructor)&&(!parent||parent.kind!=='class'))){erbIssue(facts,'erb-script-owner-gap','Unnamed JavaScript type/callback or object member has no qualified original source owner; nested declarations are quarantined',original.range(offset+node.getStart(source),offset+node.end));blocked=true;}
    else{
     const body=classNode?node.getChildren(source).find(n=>n.kind===compiler.SyntaxKind.OpenBraceToken):(node as ts.FunctionLikeDeclaration).body,start=node.getStart(source),headerEnd=body?.getStart(source)??node.end,nameStart=name?.getStart(source)??start,nameEnd=name?.end??start+'constructor'.length,nameText=name?.getText(source)??'constructor',kind=classNode?'class':functionNode?'function':constructor?'constructor':compiler.isGetAccessorDeclaration(node)?'get-accessor':compiler.isSetAccessorDeclaration(node)?'set-accessor':'method';
     if(headerEnd-start>1200){blocked=true;region.supported=false;erbIssue(facts,'erb-script-header-gap','Original JavaScript header exceeds the bounded signature profile; descendants are quarantined',original.range(offset+start,offset+headerEnd));}
     else{
      const fact:DeclarationFact={key:`erb-${key}:${offset+start}:${offset+node.end}:${kind}`,name:nameText,qualifiedName:[parent?.qualifiedName??key,nameText].join('::'),kind,entityType:classNode?'class':functionNode?'function':'method',signature:text.slice(start,headerEnd).trim(),start:offset+start,end:offset+node.end,nameEnd:offset+nameEnd,range:original.range(offset+start,offset+node.end),declarationForm:'definition',sourceConditions:['Original literal JavaScript declaration; rendered/browser execution, imports and call binding remain unverified'],embeddedSource:{language:'javascript',executionContext:'browser',headerRange:original.range(offset+start,offset+headerEnd),regions:[original.range(offset+start,offset+node.end)]},...parent?{parent:parent.key}:{}};
      // A constructor name is an actual source keyword, never an implicit helper.
      if(content.slice(offset+nameStart,offset+nameEnd)!==nameText){blocked=true;region.supported=false;erbIssue(facts,'erb-script-name-gap','JavaScript name has no exact original source spelling',fact.range);}else{facts.declarations.push(fact);parent=fact;}
     }
    }
   }else if(compiler.isArrowFunction(node)&&!claimedInitializers.has(node)){blocked=true;}
   const children:ts.Node[]=[];compiler.forEachChild(node,n=>{children.push(n);});for(let i=children.length-1;i>=0;i--)pending.push({node:children[i]!,parent,blocked,depth:item.depth+1});
  }
 }
}
