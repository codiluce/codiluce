import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,GroovySyntaxFacts,ParseIssue,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_NODES=200_000,MAX_DECLARATIONS=20_000,MAX_METADATA=4096,MAX_ISSUES=100;
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
const modifiers=new Set(['public','private','protected','static','final','abstract','synchronized','native','transient','volatile','strictfp','sealed','non-sealed']);
const types=new Set(['class','trait','interface','annotation','enum','record']);
const reservedNames=new Set(['boolean','byte','char','double','float','int','long','short','void','class','interface','trait','enum','def','package','import','return','throw','throws','new','this','super','true','false','null',...modifiers]);
const transforms=new Set(['Grab','Grapes','GrabConfig','GrabResolver','ASTTest','ASTTransformation','ASTTransformationClass','Field','Immutable','ImmutableBase','ImmutableOptions','Canonical','TupleConstructor','MapConstructor','NamedVariant','InheritConstructors','AutoClone','AutoExternalize','EqualsAndHashCode','ToString','Delegate','Builder','Lazy','Singleton','Memoized','RecordType','Sortable','Category','Mixin','Newify','BaseScript','PackageScope','PropertyOptions']);
/** Original Groovy syntax only. No JVM/compiler, AST transformations, Grape,
 * Gradle/Jenkins execution, generated script classes or closure/DSL binding. */
export function extractGroovyStructure(root:Node,query:Query,content:string):StructureFacts {
 const source=new SourceText(content),declarations:DeclarationFact[]=[],issues:ParseIssue[]=[],syntax:GroovySyntaxFacts={packages:[],imports:[],annotations:[],dsl:[],complete:true};
 const all:Node[]=[],damage:Node[]=[],comments:Node[]=[],pending=[root];let visited=0,truncated=false;
 const range=(start:number,end:number)=>source.range(Math.min(start,content.length),Math.min(end,content.length));
 const issue=(code:string,reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code,reason,...node?{range:range(node.startIndex,node.endIndex)}:{}});else truncated=true;};
 while(pending.length){const node=pending.pop()!;if(++visited>MAX_NODES){truncated=true;break;}all.push(node);if(node.isError||node.isMissing){damage.push(node);issue('syntax-parse-error',node.isMissing?`Missing ${node.type}`:'Groovy parser recovered from invalid or unqualified syntax',node);}if(/comment/.test(node.type))comments.push(node);for(let at=node.childCount-1;at>=0;at--){const child=node.child(at);if(child)pending.push(child);}}
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')selected.set(capture.node.id,capture.node);if(query.didExceedMatchLimit())truncated=true;
 const byNode=new Map<number,DeclarationFact>(),unsafeBodies=new Set(all.filter(n=>['class_body','enum_body'].includes(n.type)&&n.children.some(c=>c.isError||c.isMissing)).map(n=>n.id)),invalidHeaders=new Set<number>();
 for(const parameter of all.filter(n=>n.type==='formal_parameter'&&reservedNames.has(n.childForFieldName('name')?.text??''))){const owner=parameter.parent?.parent;if(owner)invalidHeaders.add(owner.id);issue('groovy-header-gap','A reserved Groovy keyword cannot establish an original parameter name; callable header omitted',parameter);}
 for(const body of all.filter(n=>unsafeBodies.has(n.id)))issue('groovy-owner-recovery-gap','Recovered Groovy member ownership is ambiguous; retain the original type header and omit uncertain members',body);
 const ancestors=(node:Node)=>{const parents:Node[]=[];for(let current=node.parent;current;current=current.parent){if(parents.length===128){truncated=true;break;}parents.push(current);}return parents;};
 const packages=all.filter(n=>n.type==='package_declaration'&&n.parent?.id===root.id).sort((a,b)=>a.startIndex-b.startIndex);
 if(packages.length>1)issue('groovy-package-gap','Multiple original package clauses require language validation; no compiler executes',packages[1]);
 const parentFor=(node:Node)=>{const parents=ancestors(node);for(const parent of parents){const fact=byNode.get(parent.id);if(fact)return fact;}const preceding=packages.filter(p=>p.startIndex<node.startIndex).at(-1);return preceding?byNode.get(preceding.id):undefined;};
 const header=(start:number,end:number)=>{let text='',at=start;for(const comment of comments.filter(c=>c.startIndex>=start&&c.endIndex<=end).sort((a,b)=>a.startIndex-b.startIndex)){text+=content.slice(at,comment.startIndex)+' ';at=comment.endIndex;}return compact(text+content.slice(at,end));};
 const append=<T>(target:T[],value:T)=>{if(target.length>=MAX_METADATA)truncated=true;else target.push(value);};
 const site=(node:Node,end=node.endIndex)=>{if(end-node.startIndex>8192)truncated=true;return {text:content.slice(node.startIndex,Math.min(end,node.startIndex+8192,content.length)),range:range(node.startIndex,end)};};
 for(const node of all){
  if(node.type==='package_declaration')append(syntax.packages,{...site(node),name:node.childForFieldName('name')?.text??''});
  else if(node.type==='import_declaration'){const stat=node.children.some(c=>c.type==='static'),star=node.children.some(c=>c.type==='.*'),alias=node.childForFieldName('alias');append(syntax.imports,{...site(node),path:node.childForFieldName('name')?.text??'',kind:stat?star?'static-star':'static':star?'star':'single',...alias?{alias:alias.text}:{}});}
  else if(node.type==='annotation'){const name=node.childForFieldName('name')?.text??'',generationUnverified=transforms.has(name.split('.').at(-1)!);append(syntax.annotations,{...site(node),name,generationUnverified});if(generationUnverified)issue('groovy-generation-gap','Original annotation retained; AST transformation, generated declarations and dependency loading remain unverified',node);}
  else if(['pipeline_statement','command_chain'].includes(node.type)){const end=node.childForFieldName('body')?.startIndex??node.namedChildren.find(c=>c.type==='closure')?.startIndex??node.endIndex;append(syntax.dsl,{...site(node,end),kind:node.type});}
 }
 const add=(node:Node,nameNode:Node,kind:string,end=node.childForFieldName('body')?.startIndex??node.endIndex,scope=false,signature?:string)=>{
  if(declarations.length>=MAX_DECLARATIONS){truncated=true;return;}
  const parents=ancestors(node);if(nameNode.hasError||nameNode.isMissing||invalidHeaders.has(node.id)||parents.some(p=>p.isError||unsafeBodies.has(p.id)||invalidHeaders.has(p.id))||damage.some(n=>n.startIndex>=node.startIndex&&n.startIndex<end&&n.endIndex>=node.startIndex))return;
  // A recovered class body can end too early and spill members into script
  // scope. Until qualified, no member/script binding gets a guessed owner.
  if(unsafeBodies.size&&!types.has(kind)&&kind!=='namespace')return;
  const parent=parentFor(node),mods=node.children.filter(n=>modifiers.has(n.type)).map(n=>n.text),annotations=node.namedChildren.filter(n=>n.type==='annotation').map(n=>n.text),conditions:string[]=[];
  if(parents.some(n=>n.type==='closure'))conditions.push('Original named declaration inside a Groovy closure; receiver/delegate and runtime binding remain unverified');
  if(annotations.length)conditions.push('Original annotation spelling only; annotation resolution and AST transformation remain unverified');
  const uncertainBody=!!node.childForFieldName('body')&&unsafeBodies.has(node.childForFieldName('body')!.id),sourceEnd=uncertainBody?end:node.endIndex;if(uncertainBody)conditions.push('Original Groovy type header only; recovered body extent and member ownership remain unverified');
  const name=nameNode.text,fact:DeclarationFact={key:`groovy:${node.startIndex}:${node.endIndex}:${kind}:${nameNode.startIndex}`,name,qualifiedName:[parent?.qualifiedName,name].filter(Boolean).join('.'),kind,entityType:kind==='function'?'function':['method','constructor','property','field','variable','record-component'].includes(kind)?'method':'class',signature:signature??header(node.startIndex,end),range:range(node.startIndex,sourceEnd),start:node.startIndex,end:Math.min(sourceEnd,content.length),nameEnd:nameNode.endIndex,declarationForm:uncertainBody?'declaration':kind==='method'||kind==='function'?node.childForFieldName('body')?'definition':'declaration':'definition',...parent?{parent:parent.key}:{},...mods.length?{modifiers:mods}:{},...annotations.length?{annotations}:{},...conditions.length?{sourceConditions:conditions}:{}};
  const visibility=mods.find(m=>['public','private','protected'].includes(m));if(visibility)fact.visibility=visibility;
  declarations.push(fact);if(scope)byNode.set(node.id,fact);return fact;
 };
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  const name=node.childForFieldName('name');
  if(['package_declaration','class_declaration','trait_declaration','interface_declaration','annotation_type_declaration','enum_declaration','enum_constant','record_declaration','record_component'].includes(node.type)){
   if(!name){issue('syntax-extraction-gap','Groovy declaration lacks a reviewed original name',node);continue;}
   const kind=node.type==='package_declaration'?'namespace':node.type==='annotation_type_declaration'?'annotation':node.type==='enum_constant'?'enum-member':node.type==='record_component'?'record-component':node.type.replace('_declaration','');add(node,name,kind,undefined,node.type!=='record_component');continue;
  }
  if(['constructor_declaration','method_declaration'].includes(node.type)){
   if(!name){issue('syntax-extraction-gap','Groovy callable lacks a reviewed original name',node);continue;}
   if(name.type==='quoted_identifier'&&name.namedChildren.some(n=>n.type.startsWith('gstring_'))){issue('groovy-dynamic-name-gap','Interpolated Groovy callable name has no verified fixed source binding; no named declaration is guessed',name);continue;}
   const parent=parentFor(node);let kind=parent&&types.has(parent.kind)?'method':'function';
   // This grammar labels all untyped class-body callables as constructors.
   // Groovy constructors must spell the enclosing original type's name.
   if(node.type==='constructor_declaration'&&parent&&types.has(parent.kind)&&parent.name===name.text)kind='constructor';
   add(node,name,kind,undefined,true);continue;
  }
  if(node.type==='field_declaration'||['local_variable_declaration','multi_assignment_declaration'].includes(node.type)){
   if(node.type!=='field_declaration'&&node.parent?.id!==root.id)continue;
   const names=[...node.namedChildren.filter(n=>n.type==='variable_declarator').flatMap(n=>n.childrenForFieldName('name').filter(c=>c.isNamed)),...node.childrenForFieldName('name').filter(n=>n.isNamed)].sort((a,b)=>a.startIndex-b.startIndex);
   const type=node.childForFieldName('type');if(type&&['class','trait','interface','enum','record','def','package','import'].includes(type.text))continue;
   const explicitAccess=node.children.some(n=>['public','private','protected'].includes(n.type));
   for(const name of names){const end=type?.endIndex??names[0]!.startIndex,signature=compact(`${header(node.startIndex,end)} ${name.text}`);add(node,name,node.type==='field_declaration'?explicitAccess?'field':'property':'variable',name.endIndex,names.length===1,signature);}
  }
 }
 if(truncated){if(issues.length>=MAX_ISSUES)issues.pop();issues.push({code:'syntax-budget-exceeded',reason:'Groovy extraction reached its node, declaration, metadata, diagnostic, context or query limit'});}
 issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||a.reason.localeCompare(b.reason));syntax.complete=!truncated&&!issues.length;return {declarations,issues,truncated,groovy:syntax};
}
