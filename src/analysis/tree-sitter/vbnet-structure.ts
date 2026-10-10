import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,ParseIssue,StructureFacts,VbnetSyntaxFacts} from '../facts.js';
import {SourceText} from '../source-map.js';
import {vbFold,vbHeader,vbHeaderIdentity,vbName,type VbToken} from './vbnet-source.js';

const MAX_NODES=200_000,MAX_DECLARATIONS=20_000,MAX_METADATA=4096,MAX_ISSUES=100;
const owners=new Map([['namespace_block','namespace'],['module_block','module'],['class_block','class'],['structure_block','struct'],['interface_block','interface'],['enum_block','enum']]);
const procedures=new Set(['method_declaration','constructor_declaration','get_accessor','set_accessor','lambda_expression']);
// Reserved words from Microsoft's lexical grammar; contextual words remain identifiers.
// https://learn.microsoft.com/en-us/dotnet/visual-basic/reference/language-specification/lexical-grammar
const reserved=new Set(('AddHandler AddressOf Alias And AndAlso As Boolean ByRef Byte ByVal Call Case Catch CBool CByte CChar CDate CDbl CDec Char CInt Class CLng CObj Const Continue CSByte CShort CSng CStr CType CUInt CULng CUShort Date Decimal Declare Default Delegate Dim DirectCast Do Double Each Else ElseIf End EndIf Enum Erase Error Event Exit False Finally For Friend Function Get GetType GetXmlNamespace Global GoSub GoTo Handles If Implements Imports In Inherits Integer Interface Is IsNot Let Lib Like Long Loop Me Mod Module MustInherit MustOverride MyBase MyClass Namespace Narrowing New Next Not Nothing NotInheritable NotOverridable Object Of On Operator Option Optional Or OrElse Overloads Overridable Overrides ParamArray Partial Private Property Protected Public RaiseEvent ReadOnly ReDim REM RemoveHandler Resume Return SByte Select Set Shadows Shared Short Single Static Step Stop String Structure Sub SyncLock Then Throw To True Try TryCast TypeOf UInteger ULong UShort Using Variant Wend When While Widening With WithEvents WriteOnly Xor').split(' ').map(vbFold));
const validName=(name:string)=>{
 const escaped=name.startsWith('[')&&name.endsWith(']'),suffix=!escaped&&/[$%&@#!]$/.test(name),inner=escaped?name.slice(1,-1):suffix?name.slice(0,-1):name;
 return /^[\p{L}\p{Nl}][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*$/u.test(inner)||/^[\p{Pc}][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]+$/u.test(inner)?escaped||suffix||!reserved.has(vbFold(inner)):false;
};
const compact=(text:string)=>text.replace(/\s+/g,' ').trim();
type Name={text:string;startIndex:number;endIndex:number;hasError?:boolean;isMissing?:boolean};
/** Native original declarations only. No .NET compiler, MSBuild, project execution,
 * root namespace inference, Imports binding, partial merging or CLR synthesis. */
export function extractVbnetStructure(root:Node,query:Query,content:string):StructureFacts {
 const source=new SourceText(content),declarations:DeclarationFact[]=[],issues:ParseIssue[]=[],syntax:VbnetSyntaxFacts={options:[],imports:[],attributes:[],directives:[],projectContextUnverified:true,complete:true};
 const all:Node[]=[],damage:Node[]=[],pending=[root],byNode=new Map<number,DeclarationFact>(),unsafe=new Set<number>();let truncated=false;
 const range=(start:number,end:number)=>source.range(Math.min(start,content.length),Math.min(end,content.length));
 const issue=(code:string,reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code,reason,...node?{range:range(node.startIndex,node.endIndex)}:{}});else truncated=true;};
 const ancestors=(node:Node)=>{const result:Node[]=[];for(let p=node.parent;p;p=p.parent){if(result.length===128){truncated=true;break;}result.push(p);}return result;};
 while(pending.length){const node=pending.pop()!;if(all.length===MAX_NODES){truncated=true;break;}all.push(node);if(node.isError||node.isMissing){damage.push(node);issue('syntax-parse-error',node.isMissing?`Missing ${node.type}`:'VB.NET parser recovered from unsupported or invalid syntax',node);}for(let i=node.childCount-1;i>=0;i--){const child=node.child(i);if(child)pending.push(child);}}
 const fileRecovery=damage.some(n=>!ancestors(n).some(p=>owners.has(p.type)));
 if(fileRecovery)issue('vbnet-owner-recovery-gap','Recovery outside a qualified VB scope makes ownership uncertain; only intact outer scope headers are retained',root);
 const text=(node:Node)=>{if(node.endIndex-node.startIndex>8192)truncated=true;return content.slice(node.startIndex,Math.min(node.endIndex,node.startIndex+8192,content.length));};
 const append=<T>(target:T[],value:T)=>{if(target.length===MAX_METADATA)truncated=true;else target.push(value);};
 for(const node of all){
  if(node.type==='option_statements')append(syntax.options,{text:text(node),range:range(node.startIndex,node.endIndex)});
  else if(node.type==='imports_statement')append(syntax.imports,{text:text(node),paths:node.childrenForFieldName('namespace').filter(n=>!n.hasError).map(n=>n.text),range:range(node.startIndex,node.endIndex)});
  else if(node.type==='attribute_block')append(syntax.attributes,{text:text(node),range:range(node.startIndex,node.endIndex)});
  else if(node.type==='preprocessor_directive'){append(syntax.directives,{text:text(node),range:range(node.startIndex,node.endIndex)});issue('vbnet-preprocessor-gap','Original VB conditional directive retained; no branch or project DefineConstants value is evaluated',node);}
 }
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')selected.set(capture.node.id,capture.node);if(query.didExceedMatchLimit())truncated=true;
 const parentFor=(node:Node)=>ancestors(node).map(p=>byNode.get(p.id)).find(Boolean);
 const blocked=(node:Node)=>ancestors(node).some(p=>p.isError||p.isMissing||unsafe.has(p.id));
 const originalHeader=(node:Node,end=node.endIndex)=>vbHeader(content,node.startIndex,end);
 const add=(node:Node,name:Name,kind:string,header:{tokens:VbToken[];end:number;complete:boolean},scope=false,start=node.startIndex,end=node.endIndex,signature?:string,identityTokens=header.tokens)=>{
  if(declarations.length===MAX_DECLARATIONS){truncated=true;return;}
  if(blocked(node)||name.hasError||name.isMissing||!header.complete||header.tokens.length===0||header.end-start>1200||vbHeaderIdentity(identityTokens).length>1200){if(!header.complete||header.end-start>1200||vbHeaderIdentity(identityTokens).length>1200){truncated=true;issue('vbnet-header-budget-gap','Original VB declaration header exceeds the qualified lexical/signature budget or has an unfinished literal/continuation',node);}return;}
  if(damage.some(n=>n.startIndex<header.end&&n.endIndex>=start))return;
  if(kind!=='constructor'&&(kind==='namespace'?!name.text.split('.').every((part,i)=>i===0&&vbFold(part)==='global'||validName(part)):!validName(name.text))){issue('vbnet-identifier-gap','Native VB name violates the qualified original identifier profile; no declaration is guessed',node);return;}
  const parent=parentFor(node),qualifiedName=[parent?.qualifiedName,name.text].filter(Boolean).join('.');
  if(!owners.has(node.type)&&kind!=='delegate'&&!parent){issue('vbnet-owner-gap','Original VB member has no qualified named type/module owner and is omitted',node);return;}
  const modifierNode=(node.type==='variable_declarator'?node.parent:node)?.childForFieldName('modifiers'),mods=modifierNode?.namedChildren.map(n=>n.text)??[],conditions=['Original VB source only; project root namespace, references and compiler binding are unverified'];
  if(mods.some(m=>vbFold(m)==='partial'))conditions.push('Original partial source fragment; no logical type/member merging is inferred');
  if(header.tokens.some(t=>['handles','implements'].includes(vbFold(t.text))))conditions.push('Original Handles/Implements clause; event/interface binding is unverified');
  if(/[^\x00-\x7f]/.test(name.text))conditions.push('Non-ASCII source name retained; Unicode compiler case equivalence is unverified');
  if(/[$%&@#!]$/.test(name.text))conditions.push('Original identifier type character retained; declared type agreement and compiler identity are unverified');
  const attributeOwner=node.parent?.type==='type_declaration'?node.parent:node,attrs:string[]=[];
  for(let previous=attributeOwner.previousNamedSibling;previous?.type==='attribute_block';previous=previous.previousNamedSibling)if(!previous.hasError)attrs.unshift(text(previous));
  if(attrs.length)conditions.push('Original attributes retained; compiler/generated behavior is unverified');
  const fact:DeclarationFact={key:`vbnet:${start}:${end}:${kind}:${name.startIndex}`,name:name.text,qualifiedName,kind,entityType:kind==='function'?'function':['method','constructor','property','event'].includes(kind)?'method':'class',signature:signature??compact(content.slice(node.startIndex,header.end)),start,end:Math.min(end,content.length),nameEnd:name.endIndex,range:range(start,end),declarationForm:'definition',sourceConditions:conditions,vbnetIdentity:{qualifiedName:[parent?.vbnetIdentity?.qualifiedName,kind==='namespace'?name.text.split('.').map(vbName).join('.'):vbName(name.text)].filter(Boolean).join('.'),signature:vbHeaderIdentity(identityTokens)},...parent?{parent:parent.key}:{},...mods.length?{modifiers:mods}:{},...attrs.length?{annotations:attrs}:{}};
  const visibility=mods.filter(m=>['public','private','protected','friend'].includes(vbFold(m)));if(visibility.length)fact.visibility=visibility.map(vbFold).join(' ');
  declarations.push(fact);if(scope)byNode.set(node.id,fact);return fact;
 };
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  if(blocked(node))continue;
  if(owners.has(node.type)){
   const name=node.childForFieldName('name');if(!name)continue;const header=originalHeader(node),recovered=node.hasError||fileRecovery;
   const fact=add(node,name,owners.get(node.type)!,header,true,node.startIndex,recovered?header.end:node.endIndex);
   if(recovered){unsafe.add(node.id);issue('vbnet-owner-recovery-gap','VB scope body recovery makes original member ownership uncertain; only an intact source header is retained',node);if(fact){fact.declarationForm='declaration';fact.sourceConditions!.push('Original scope header only; body/member ownership is unverified');}}continue;
  }
  if(fileRecovery||ancestors(node).some(p=>procedures.has(p.type)||p.type==='statement'))continue;
  if(node.hasError){issue('vbnet-declaration-recovery-gap','Damaged original VB declaration is omitted',node);continue;}
  if(node.type==='variable_declarator'){
   if(node.parent?.type!=='field_declaration')continue;const name=node.childForFieldName('name');if(!name)continue;
   const end=node.children.find(n=>n.type==='=')?.startIndex??node.endIndex,header=vbHeader(content,node.startIndex,end),mod=node.parent.childForFieldName('modifiers'),prefix=mod?originalHeader(mod).tokens:[],tokens=[...prefix,...header.tokens];
   add(node,name,'field',header,false,node.startIndex,node.endIndex,compact(`${mod?.text??''} ${content.slice(node.startIndex,header.end)}`),tokens);continue;
  }
  if(node.type==='const_declaration'){
   const names=node.childrenForFieldName('name');for(let i=0;i<names.length;i++){
    const name=names[i]!,next=names[i+1],tail=node.namedChildren.filter(n=>n.startIndex>=name.endIndex&&n.endIndex<=(next?.startIndex??node.endIndex)),asClause=tail.find(n=>n.type==='as_clause'),header=vbHeader(content,name.startIndex,asClause?.endIndex??name.endIndex),prefix=originalHeader(node,name.startIndex).tokens;
    add(node,name,'constant',header,false,name.startIndex,next?.startIndex??node.endIndex,compact(`${content.slice(node.startIndex,names[0]!.startIndex)} ${content.slice(name.startIndex,header.end)}`),[...prefix.filter(t=>t.end<=(names[0]?.startIndex??0)),...header.tokens]);
   }continue;
  }
  const header=originalHeader(node);let name:Name|undefined=node.childForFieldName('name')??undefined,kind:string|undefined,scope=false;
  if(node.type==='constructor_declaration'){const sub=header.tokens.findIndex(t=>vbFold(t.text)==='sub'),newToken=header.tokens[sub+1];if(sub>=0&&newToken&&vbFold(newToken.text)==='new')name={text:newToken.text,startIndex:newToken.start,endIndex:newToken.end};kind='constructor';scope=true;}
  else if(node.type==='method_declaration'){kind=parentFor(node)?.kind==='module'?'function':'method';scope=true;}
  else if(node.type==='delegate_declaration')kind='delegate';
  else if(node.type==='event_declaration')kind='event';
  else if(node.type==='property_declaration')kind='property';
  else if(node.type==='enum_member')kind='enum-member';
  if(!kind||!name)continue;
  const initializer=node.children.find(n=>n.type==='='),main=initializer?vbHeader(content,node.startIndex,initializer.startIndex):header;
  const accessors=kind==='property'?node.namedChildren.filter(n=>['get_accessor','set_accessor'].includes(n.type)).map(n=>originalHeader(n)):[],tokens=[...main.tokens,...accessors.flatMap(a=>a.tokens)],signature=accessors.length?[compact(content.slice(node.startIndex,main.end)),...accessors.map(a=>a.tokens.map(t=>t.text).join(' '))].join(' '):undefined;
  const fact=add(node,name,kind,{...main,complete:main.complete&&accessors.every(a=>a.complete)},scope,node.startIndex,node.endIndex,signature,tokens);
  if(fact&&(['delegate','event','enum-member'].includes(kind)||parentFor(node)?.kind==='interface'||fact.modifiers?.some(m=>vbFold(m)==='mustoverride')))fact.declarationForm='declaration';
 }
 if(truncated){if(issues.length===MAX_ISSUES)issues.pop();issues.push({code:'syntax-budget-exceeded',reason:'VB extraction reached its node, declaration, metadata, diagnostic, context, header or query limit'});}
 syntax.complete=!truncated&&!issues.length;issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||a.reason.localeCompare(b.reason));return {declarations,issues,truncated,vbnet:syntax};
}
