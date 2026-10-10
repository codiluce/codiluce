import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,ParseIssue,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_NODES=200_000,MAX_DECLARATIONS=20_000,MAX_ISSUES=100,MAX_DIRECTIVES=4096;
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
const typeKinds=new Map([['class_specifier','class'],['struct_specifier','struct'],['union_specifier','union'],['enum_specifier','enum'],['namespace_definition','namespace']]);
const callableKinds=new Set(['function','qualified-function','method','constructor','destructor']);
const scopeKinds=new Set([...typeKinds.values(),...callableKinds]);
const directiveKinds=new Set(['preproc_if','preproc_ifdef','preproc_elif','preproc_elifdef','preproc_else','preproc_include','preproc_def','preproc_function_def','preproc_call']);
const conditionKinds=new Set(['preproc_if','preproc_ifdef','preproc_elif','preproc_elifdef','preproc_else']);
interface Declarator {name:Node;text:string;display:string;operators:Node[]}
/** Operators are ordered outwards from the original name. The first operator
 * distinguishes a function from a variable that points to a function. */
function declarator(node:Node|undefined,depth=0):Declarator|undefined {
 if(!node||depth>64||node.hasError||node.isMissing)return;
 if(node.type==='qualified_identifier'){
  const scope=node.childForFieldName('scope'),selected=declarator(node.childForFieldName('name')??undefined,depth+1);if(!selected)return;
  return {...selected,text:`${scope?`${scope.text}::`:node.text.startsWith('::')?'::':''}${selected.text}`};
 }
 if(['identifier','field_identifier','type_identifier','namespace_identifier','destructor_name','operator_name','template_function'].includes(node.type))return {name:node,text:node.text,display:node.text,operators:[]};
 if(node.type==='operator_cast'){
  const type=node.childForFieldName('type'),fn=node.childForFieldName('declarator');
  if(type&&fn?.type==='abstract_function_declarator')return {name:type,text:`operator ${type.text}`,display:`operator ${type.text}`,operators:[fn]};
  return;
 }
 const inner=node.childForFieldName('declarator')??(['parenthesized_declarator','attributed_declarator','reference_declarator'].includes(node.type)?node.namedChildren.find(child=>!/attribute/.test(child.type)):undefined);
 const selected=declarator(inner,depth+1);if(!selected)return;
 return {...selected,operators:[...selected.operators,...['function_declarator','pointer_declarator','reference_declarator','array_declarator'].includes(node.type)?[node]:[]]};
}
function owner(node:Node):Node {return node.parent?.type==='template_declaration'?node.parent:node;}
function body(node:Node):Node|undefined{return node.childForFieldName('body')??undefined;}
function header(node:Node):string {
 const nested=node.type==='template_declaration'?node.namedChildren.find(child=>typeKinds.has(child.type)||child.type==='function_definition'):undefined;
 return compact(node.text.slice(0,(body(node)?.startIndex??(nested?body(nested)?.startIndex:undefined)??node.endIndex)-node.startIndex));
}
function context(node:Node):string[]{
 const values:string[]=[];let depth=0;
 for(let parent=node.parent;parent&&++depth<=128;parent=parent.parent)if(conditionKinds.has(parent.type))values.unshift(parent.text.split('\n')[0]!.trim().slice(0,8192));
 return values;
}
function modifiers(node:Node):string[]{
 const values=node.namedChildren.filter(child=>/^(?:storage_class_specifier|type_qualifier|function_specifier|explicit_function_specifier|ms_call_modifier)$/.test(child.type)).map(child=>child.text);
 for(const child of node.children)if(['virtual','explicit','constexpr','consteval','inline','friend','thread_local'].includes(child.type))values.push(child.text);
 if(node.parent?.type==='friend_declaration')values.push('friend');
 for(let parent=node.parent,depth=0;parent&&++depth<=64;parent=parent.parent){
  if(parent.type==='linkage_specification'){const value=parent.childForFieldName('value');if(value)values.push(`extern ${value.text}`);}
  if(['function_definition','class_specifier','struct_specifier','namespace_definition'].includes(parent.type))break;
 }
 return [...new Set(values)];
}
function access(node:Node,parent:DeclarationFact|undefined):string|undefined {
 if(!parent||!['class','struct','union'].includes(parent.kind))return;
 let member=node;for(let depth=0;member.parent?.type!=='field_declaration_list'&&member.parent&&++depth<=64;)member=member.parent;
 for(let previous=member.previousNamedSibling,count=0;previous&&++count<=4096;previous=previous.previousNamedSibling)if(previous.type==='access_specifier')return previous.text;
 return parent.kind==='class'?'private':'public';
}
/** Original source structure only: no preprocessing, includes, macro expansion,
 * compiler, template instantiation, overload or translation-unit binding. */
export function extractCfamilyStructure(root:Node,query:Query,language:'c'|'cpp',content:string):StructureFacts {
 const source=new SourceText(content),issues:ParseIssue[]=[],preprocessor:NonNullable<StructureFacts['cfamily']>['preprocessor']=[],damaged:{start:number;end:number}[]=[];
 let truncated=false,visited=0;
 const range=(node:Node)=>source.range(Math.min(node.startIndex,content.length),Math.min(node.endIndex,content.length));
 const issue=(code:string,reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code,reason,...node?{range:range(node)}:{}});else truncated=true;};
 const pending=[root];while(pending.length){
  const node=pending.pop()!;if(++visited>MAX_NODES){truncated=true;break;}
  if(node.isError||node.isMissing){damaged.push({start:node.startIndex,end:node.endIndex});issue('syntax-parse-error',node.isMissing?`Missing ${node.type}`:'Parser recovered from invalid syntax',node);}
  if(directiveKinds.has(node.type)){
   if(preprocessor.length>=MAX_DIRECTIVES)truncated=true;
   else {const text=(conditionKinds.has(node.type)?node.text.split('\n')[0]!:content.slice(node.startIndex,node.endIndex)).trim();preprocessor.push({kind:node.type,text:text.slice(0,8192),range:range(node)});if(text.length>8192)issue('syntax-extraction-gap','Original preprocessor text exceeds the retained syntax limit',node);}
  }
  for(let index=node.namedChildCount-1;index>=0;index--){const child=node.namedChild(index);if(child)pending.push(child);}
 }
 const nodes=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')nodes.set(capture.node.id,capture.node);
 if(query.didExceedMatchLimit())truncated=true;
 const candidates=[...nodes.values()].sort((a,b)=>owner(a).startIndex-owner(b).startIndex||b.endIndex-a.endIndex);
 const declarations:DeclarationFact[]=[],byNode=new Map<number,DeclarationFact>(),originalNodes=new Map<string,Node>();
 const parentFor=(node:Node,friend=false):DeclarationFact|undefined=>{let depth=0;for(let current=node.parent;current&&++depth<=128;current=current.parent){const selected=byNode.get(current.id);if(selected&&(!friend||!['class','struct','union'].includes(selected.kind)))return selected;}return;};
 const add=(node:Node,name:Node|undefined,text:string,kind:string,signature:string,form:DeclarationFact['declarationForm'],friend=false,display?:string):DeclarationFact|undefined=>{
  if(declarations.length>=MAX_DECLARATIONS){truncated=true;return;}
  const original=owner(node),headerEnd=body(node)?.startIndex??node.endIndex;
  if(name?.hasError||name?.isMissing||damaged.some(item=>item.start<headerEnd&&item.end>=original.startIndex))return;
  const parent=parentFor(node,friend),mods=modifiers(node),annotations=node.namedChildren.filter(child=>/attribute/.test(child.type)).map(child=>child.text),conditions=context(node);
  if(!name){mods.push('anonymous');annotations.push('Anonymous original syntax scope; no identifier is synthesized');}
  let qualifiedName=text.startsWith('::')?text.slice(2):[parent?.qualifiedName,text].filter(Boolean).join('::');
  const callable=callableKinds.has(kind),method=kind==='function'&&language==='cpp'&&parent&&['class','struct','union'].includes(parent.kind);
  if(method)kind=text===parent!.name?'constructor':text===`~${parent!.name}`?'destructor':'method';
  const fact:DeclarationFact={key:`${node.startIndex}:${node.endIndex}:${kind}:${name?.startIndex??node.startIndex}`,name:display??(name?.type==='qualified_identifier'?name.childForFieldName('name')?.text??text:text),qualifiedName,kind,entityType:callable?(kind==='function'?'function':'method'):kind==='property'?'method':'class',signature:compact(signature),range:range(original),start:original.startIndex,end:Math.min(original.endIndex,content.length),nameEnd:name?.endIndex??Math.min(node.startIndex+node.type.split('_')[0]!.length,content.length),declarationForm:form,...parent?{parent:parent.key}:{},...mods.length?{modifiers:mods}:{},...annotations.length?{annotations}:{},...conditions.length?{sourceConditions:conditions}:{},...!friend&&access(node,parent)?{visibility:access(node,parent)}:{}};
  declarations.push(fact);originalNodes.set(fact.key,node);
  if(scopeKinds.has(kind)&&body(node)){byNode.set(node.id,fact);if(original!==node)byNode.set(original.id,fact);}
  return fact;
 };
 for(const node of candidates){
  const kind=typeKinds.get(node.type);
  if(kind){
   const name=node.childForFieldName('name'),hasBody=!!body(node),standalone=node.parent?.type==='translation_unit'||['declaration_list','field_declaration_list','template_declaration','preproc_if','preproc_else','preproc_ifdef','preproc_elif'].includes(node.parent?.type??'')||(['declaration','field_declaration'].includes(node.parent?.type??'')&&node.parent!.childrenForFieldName('declarator').length===0);
   if(!hasBody&&!standalone)continue;
   if(!name&&!hasBody)continue;
   add(node,name??undefined,name?.text??`<anonymous ${kind}>`,kind,header(owner(node)),hasBody?'definition':'declaration');continue;
  }
  if(['alias_declaration','namespace_alias_definition','concept_definition','enumerator','preproc_def','preproc_function_def'].includes(node.type)){
   const name=node.childForFieldName('name');if(!name){issue('syntax-extraction-gap','Original named declaration has no reviewed name field',node);continue;}
   const type=node.type==='alias_declaration'?'type':node.type==='namespace_alias_definition'?'namespace-alias':node.type==='concept_definition'?'concept':node.type==='enumerator'?'enum-member':'macro';
   add(node,name,name.text,type,header(owner(node)),type==='type'||type==='namespace-alias'?'declaration':'definition');continue;
  }
  for(const selected of node.childrenForFieldName('declarator')){
   const selectedName=declarator(selected);if(!selectedName){issue('syntax-extraction-gap','Original declarator requires an additional structural profile; no name is guessed',selected);continue;}
   const name=selectedName.name,friend=node.parent?.type==='friend_declaration',parent=parentFor(node,friend),functionLike=selectedName.operators[0]?.type==='function_declarator'||selectedName.operators[0]?.type==='abstract_function_declarator';
   const alias=node.type==='type_definition',field=parent&&['class','struct','union'].includes(parent.kind),local=parent&&callableKinds.has(parent.kind);
   if(local&&!functionLike&&!alias)continue;
   const definition=node.type==='function_definition';let kind=alias?'type':functionLike?'function':field?'property':'variable';
   if(language==='c'&&field&&functionLike){kind='property';issue('syntax-extraction-gap','C field function syntax does not certify a callable or compiler validity',node);}
   const original=owner(node),prefix=original!==node?original.text.slice(0,node.startIndex-original.startIndex):'',typeNode=node.childForFieldName('type'),type=typeNode?(typeKinds.has(typeNode.type)?header(typeNode):typeNode.text):'';
   add(node,name,selectedName.text,kind,`${prefix}${modifiers(node).join(' ')} ${type} ${selected.text}`,definition?'definition':functionLike||alias||selected.type!=='init_declarator'?'declaration':'definition',friend,selectedName.display);
  }
 }
 // Attach exact non-templated out-of-line definitions only to a unique original
 // type in the same source file and directive context. No type binding is inferred.
 const types=new Map<string,DeclarationFact[]>();for(const declaration of declarations)if(['class','struct','union'].includes(declaration.kind)){const values=types.get(declaration.qualifiedName)??[];values.push(declaration);types.set(declaration.qualifiedName,values);}
 for(const declaration of declarations){
  const node=originalNodes.get(declaration.key)!;if(declaration.kind!=='function'||!node.childrenForFieldName('declarator').some(item=>declarator(item)?.text.includes('::')))continue;
  const prefix=declaration.qualifiedName.slice(0,declaration.qualifiedName.lastIndexOf('::')),owners=types.get(prefix)??[];
  if(owners.length===1&&JSON.stringify(owners[0]!.sourceConditions??[])===JSON.stringify(declaration.sourceConditions??[])){declaration.parent=owners[0]!.key;declaration.kind=declaration.name===owners[0]!.name?'constructor':declaration.name===`~${owners[0]!.name}`?'destructor':'method';declaration.entityType='method';}
  else {declaration.kind='qualified-function';declaration.sourceConditions=[...declaration.sourceConditions??[],'Qualified C++ callable scope owner requires translation-unit/type binding'];}
 }
 issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||(a.range?.startColumn??0)-(b.range?.startColumn??0)||a.reason.localeCompare(b.reason));
 if(truncated){if(issues.length===MAX_ISSUES)issues.pop();issues.push({code:'syntax-budget-exceeded',reason:'Structural extraction reached its node, declaration, directive, diagnostic or query limit'});}
 return {declarations,issues,truncated,cfamily:{preprocessor,complete:!truncated&&!issues.length}};
}
