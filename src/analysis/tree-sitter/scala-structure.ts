import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,ParseIssue,ScalaSyntaxFacts,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_NODES=200_000,MAX_DECLARATIONS=20_000,MAX_METADATA=4096,MAX_ISSUES=100;
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
const typeKinds=new Set(['class','trait','object','package-object','enum','enum-member','given']);
const callKinds=new Set(['function','method','constructor','extension-method']);
const stagedKinds=new Set(['macro_body','quote_expression','splice_expression']);
const modifierTokens=new Set(['case','implicit','final','sealed','abstract','override','lazy']);
/** Native original declarations only. No Scala compiler, sbt/Scala CLI, JVM,
 * implicit search, companion/accessor synthesis, derives or macro evaluation. */
export function extractScalaStructure(root:Node,query:Query,content:string):StructureFacts {
 const source=new SourceText(content),declarations:DeclarationFact[]=[],issues:ParseIssue[]=[],syntax:ScalaSyntaxFacts={packages:[],imports:[],exports:[],extensions:[],givens:[],staged:[],directives:[],complete:true};
 const all:Node[]=[],damage:Node[]=[],comments:Node[]=[],pending=[root];let visited=0,truncated=false;
 const range=(start:number,end:number)=>source.range(Math.min(start,content.length),Math.min(end,content.length));
 const issue=(code:string,reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code,reason,...node?{range:range(node.startIndex,node.endIndex)}:{}});else truncated=true;};
 while(pending.length){const node=pending.pop()!;if(++visited>MAX_NODES){truncated=true;break;}all.push(node);if(node.isError||node.isMissing){damage.push(node);issue('syntax-parse-error',node.isMissing?`Missing ${node.type}`:'Scala parser recovered from invalid syntax',node);}if(/comment/.test(node.type))comments.push(node);for(let at=node.childCount-1;at>=0;at--){const child=node.child(at);if(child)pending.push(child);}}
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')selected.set(capture.node.id,capture.node);if(query.didExceedMatchLimit())truncated=true;
 const byNode=new Map<number,DeclarationFact>(),packages=new Map<number,Node[]>(),anonymousOwners=new Set<number>();
 for(const node of all)if(node.type==='package_clause'&&!node.childForFieldName('body')&&node.parent){const clauses=packages.get(node.parent.id)??[];clauses.push(node);packages.set(node.parent.id,clauses);}
 for(const clauses of packages.values())clauses.sort((a,b)=>a.startIndex-b.startIndex);
 const header=(start:number,end:number)=>{let text='',at=start;for(const comment of comments.filter(c=>c.startIndex>=start&&c.endIndex<=end).sort((a,b)=>a.startIndex-b.startIndex)){text+=content.slice(at,comment.startIndex)+' ';at=comment.endIndex;}return compact(text+content.slice(at,end));};
 const parentFor=(node:Node)=>{for(let current:Node|undefined=node,depth=0;current?.parent&&++depth<=128;current=current.parent){const parent=current.parent,owner=byNode.get(parent.id);if(owner)return owner;const clauses=packages.get(parent.id);if(clauses){let low=0,high=clauses.length;while(low<high){const middle=(low+high)>>>1;if(clauses[middle]!.startIndex<current.startIndex)low=middle+1;else high=middle;}const preceding=clauses[low-1],fact=preceding&&byNode.get(preceding.id);if(fact)return fact;}}return undefined;};
 const ancestors=(node:Node)=>{const parents:Node[]=[];for(let current=node.parent;current;current=current.parent){if(parents.length===128){truncated=true;break;}parents.push(current);}return parents;};
 const boundText=(node:Node)=>{if(node.endIndex-node.startIndex>8192)truncated=true;return content.slice(node.startIndex,Math.min(node.endIndex,node.startIndex+8192,content.length));};
 const append=<T>(target:T[],value:T)=>{if(target.length>=MAX_METADATA)truncated=true;else target.push(value);};
 const extensionHeader=(node:Node)=>{const end=node.children.find(n=>n.type==='{')?.startIndex??node.childrenForFieldName('body')[0]?.startIndex??node.endIndex;return {signature:header(node.startIndex,end),range:range(node.startIndex,end)};};
 for(const node of all){
  if(!['package_clause','import_declaration','export_declaration','extension_definition','given_definition','using_directive',...stagedKinds].includes(node.type))continue;
  if(node.type==='package_clause'){const end=node.childForFieldName('body')?.startIndex??node.endIndex;append(syntax.packages,{text:content.slice(node.startIndex,Math.min(end,node.startIndex+8192)),range:range(node.startIndex,end),name:node.childForFieldName('name')?.text??'',explicitBody:!!node.childForFieldName('body')});if(end-node.startIndex>8192)truncated=true;continue;}
  const site={text:boundText(node),range:range(node.startIndex,node.endIndex)};
  if(node.type==='import_declaration'||node.type==='export_declaration'){const path=node.childrenForFieldName('path').filter(n=>n.isNamed);append(node.type==='import_declaration'?syntax.imports:syntax.exports,{...site,path:path.length?content.slice(path[0]!.startIndex,path.at(-1)!.endIndex):''});}
  else if(node.type==='extension_definition'){const h=extensionHeader(node);append(syntax.extensions,{...site,signature:h.signature,headerRange:h.range});}
  else if(node.type==='given_definition')append(syntax.givens,{...site,...node.childForFieldName('name')?{name:node.childForFieldName('name')!.text}:{},signature:header(node.startIndex,node.childForFieldName('body')?.startIndex??node.endIndex)});
  else if(stagedKinds.has(node.type)){append(syntax.staged,{...site,kind:node.type});issue('scala-staged-code-gap','Original Scala macro/quote/splice syntax retained; expansion, execution and generated declarations remain unverified',node);}
  else if(node.type==='using_directive')append(syntax.directives,site);
 }
 const add=(node:Node,nameNode:Node,name:string,kind:string,signatureEnd=node.childForFieldName('body')?.startIndex??node.childForFieldName('value')?.startIndex??node.endIndex,scope=false)=>{
  if(declarations.length>=MAX_DECLARATIONS){truncated=true;return;}
  const parents=ancestors(node);if(parents.some(n=>stagedKinds.has(n.type)))return;
  if(nameNode.hasError||nameNode.isMissing||damage.some(n=>n.startIndex>=node.startIndex&&n.startIndex<signatureEnd&&n.endIndex>=node.startIndex))return;
  // A class's access modifier after its name belongs to the primary constructor.
  // Native modifiers also include anonymous keyword tokens inside `modifiers`.
  const parent=parentFor(node),mods=node.namedChildren.filter(n=>n.type==='modifiers'||n.type==='opaque_modifier'||n.type==='access_modifier'&&n.startIndex<nameNode.startIndex).flatMap(n=>n.type==='modifiers'?n.children.filter(c=>c.isNamed||modifierTokens.has(c.type)):[n]).map(n=>n.text),annotations=node.namedChildren.filter(n=>n.type==='annotation').map(n=>n.text),conditions:string[]=[];
  for(const keyword of ['case','implicit','final','sealed','abstract','override','lazy'])if(node.children.some(n=>n.type===keyword)&&!mods.includes(keyword))mods.push(keyword);
  if(kind==='function'&&parent&&typeKinds.has(parent.kind))kind='method';
  const extension=parents.find(n=>n.type==='extension_definition');if(extension&&callKinds.has(kind)){kind='extension-method';conditions.push('Original Scala extension receiver/context syntax; type binding and extension dispatch remain unverified');}
  const anonymous=parents.find(n=>n.type==='given_definition'&&!n.childForFieldName('name'));if(anonymous){conditions.push('Original member of an anonymous Scala given; no generated owner name or implicit binding is inferred');if(!anonymousOwners.has(anonymous.id)){anonymousOwners.add(anonymous.id);issue('scala-anonymous-owner-gap','Original anonymous given members retained; lexical source has no named owner',anonymous);}}
  const instance=parents.find(n=>n.type==='instance_expression'&&n.namedChildren.some(c=>['template_body','with_template_body'].includes(c.type)));if(instance){conditions.push('Original member of an anonymous Scala instance; no generated class name or type binding is inferred');if(!anonymousOwners.has(instance.id)){anonymousOwners.add(instance.id);issue('scala-anonymous-owner-gap','Original anonymous instance members retained; lexical source has no named owner',instance);}}
  if(kind==='function'&&(anonymous||instance)){const originalOwner=parents.findIndex(n=>byNode.has(n.id)),anonymousOwner=parents.findIndex(n=>n.id===anonymous?.id||n.id===instance?.id);if(originalOwner<0||anonymousOwner<originalOwner)kind='method';}
  if(parents.some(n=>n.type==='lambda_expression'))conditions.push('Original named declaration inside a Scala lambda; closure/runtime binding remains unverified');
  if(node.childForFieldName('derive')){conditions.push('Original Scala derives clause retained; generated instances remain unverified');issue('scala-derivation-gap','Original derives syntax does not establish generated instances',node.childForFieldName('derive')!);}
  const originalHeader=header(node.startIndex,signatureEnd),extensionContext=extension&&callKinds.has(kind)?extensionHeader(extension):undefined;
  const fact:DeclarationFact={key:`scala:${node.startIndex}:${node.endIndex}:${kind}:${nameNode.startIndex}`,name,qualifiedName:[parent?.qualifiedName,name].filter(Boolean).join('.'),kind,entityType:callKinds.has(kind)?kind==='function'?'function':'method':kind==='property'?'method':'class',signature:extensionContext?compact(`${extensionContext.signature} ${originalHeader}`):originalHeader,range:range(node.startIndex,node.endIndex),start:node.startIndex,end:Math.min(node.endIndex,content.length),nameEnd:nameNode.endIndex,declarationForm:node.childForFieldName('body')||node.childForFieldName('value')||['class','trait','object','package-object','enum','enum-member','namespace'].includes(kind)||node.children.some(n=>n.type==='=')?'definition':'declaration',...parent?{parent:parent.key}:{},...mods.length?{modifiers:mods}:{},...annotations.length?{annotations}:{},...conditions.length?{sourceConditions:conditions}:{},...extensionContext?{scalaExtension:extensionContext}:{}};
  const visibility=mods.find(m=>/^(?:private|protected)\b/.test(m));if(visibility)fact.visibility=visibility;
  declarations.push(fact);if(scope)byNode.set(node.id,fact);return fact;
 };
 const localValue=(node:Node)=>{for(const parent of ancestors(node)){if(['template_body','enum_body','with_template_body','class_definition','trait_definition','object_definition','package_object'].includes(parent.type))return false;if(['function_definition','lambda_expression','block','indented_block','case_clause','enumerator'].includes(parent.type))return true;}return false;};
 const bindings=(pattern:Node):Node[]=>{
  const names:Node[]=[],queue=[pattern];while(queue.length){const part=queue.pop()!;
   if(['identifier','operator_identifier'].includes(part.type))names.push(part);
   else if(['tuple_pattern','identifiers','named_tuple_pattern'].includes(part.type))queue.push(...part.namedChildren);
   else if(part.type==='named_pattern'){const value=part.namedChildren.at(-1);if(value)queue.push(value);}
   else if(['capture_pattern','typed_pattern','repeat_pattern'].includes(part.type)){const name=part.childForFieldName('name'),nested=part.childForFieldName('pattern');if(name&&name.type!=='wildcard')names.push(name);if(nested)queue.push(nested);}
   else if(part.type==='case_class_pattern')queue.push(...part.childrenForFieldName('pattern').filter(n=>n.isNamed));
   else if(part.type==='infix_pattern')queue.push(...part.childrenForFieldName('left'),...part.childrenForFieldName('right'));
   else if(!['wildcard','stable_identifier','boolean_literal','null_literal','integer_literal','floating_point_literal','character_literal','string','unit'].includes(part.type))issue('scala-pattern-gap','Scala source binding pattern requires additional qualification; no names are guessed',part);
  }return names.sort((a,b)=>a.startIndex-b.startIndex);
 };
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  const name=node.childForFieldName('name');
  if(['package_clause','class_definition','trait_definition','object_definition','package_object','enum_definition','simple_enum_case','full_enum_case'].includes(node.type)){
   if(!name){issue('syntax-extraction-gap','Scala type/package/case lacks a reviewed original name',node);continue;}
   const kind=node.type==='package_clause'?'namespace':node.type==='package_object'?'package-object':node.type.endsWith('enum_case')?'enum-member':node.type.replace('_definition','');add(node,name,name.text,kind,undefined,true);continue;
  }
  if(['function_definition','function_declaration','given_definition','type_definition'].includes(node.type)){
   if(!name){if(node.type!=='given_definition')issue('syntax-extraction-gap','Scala named declaration lacks a reviewed original name',node);continue;}
   const kind=node.type==='given_definition'?'given':node.type==='type_definition'?node.namedChildren.some(n=>n.type==='opaque_modifier')?'opaque-type':'type':name.text==='this'?'constructor':'function';add(node,name,name.text,kind,undefined,true);continue;
  }
  if(node.type==='class_parameter'){
   if(!name||!node.children.some(n=>['val','var'].includes(n.type)))continue;
   const owner=parentFor(node);if(!owner||!typeKinds.has(owner.kind))continue;add(node,name,name.text,'property',node.childForFieldName('default_value')?.startIndex??node.endIndex);continue;
  }
  if(['val_definition','var_definition','val_declaration','var_declaration'].includes(node.type)){
   if(localValue(node))continue;const pattern=node.childForFieldName('pattern'),names=pattern?bindings(pattern):node.childrenForFieldName('name').filter(n=>n.isNamed),type=node.childForFieldName('type'),keyword=node.type.startsWith('val')?'val':'var';
   for(const name of names){const owner=parentFor(node),fact=add(node,name,name.text,owner&&typeKinds.has(owner.kind)?'property':'variable',type?.endIndex??pattern?.endIndex??name.endIndex,names.length===1);if(fact)fact.signature=compact(`${fact.modifiers?.join(' ')??''} ${keyword} ${name.text}${type?`: ${type.text}`:''}`);}continue;
  }
 }
 if(truncated){if(issues.length>=MAX_ISSUES)issues.pop();issues.push({code:'syntax-budget-exceeded',reason:'Scala extraction reached its node, declaration, metadata, diagnostic, context or query limit'});}
 issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||a.reason.localeCompare(b.reason));syntax.complete=!truncated&&!issues.length;return {declarations,issues,truncated,scala:syntax};
}
