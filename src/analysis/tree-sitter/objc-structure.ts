import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,ObjcSyntaxFacts,ParseIssue,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';
import {context,declarator,extractCfamilyStructure,type CfamilySeed} from './cfamily-structure.js';

const MAX_DECLARATIONS=20_000,MAX_NODES=200_000,MAX_METADATA=4096,MAX_ISSUES=100;
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
const containers=new Set(['class_interface','class_implementation','protocol_declaration']);
const members=new Set(['instance_variables','method_declaration','implementation_definition','property_declaration','declaration','type_definition','function_definition','qualified_protocol_interface_declaration','preproc_if','preproc_ifdef','preproc_def','preproc_call','preproc_undef']);
const identifiers=new Set(['identifier','keyword_identifier']);

/** Retain source declarations and selector spelling, never property-generated
 * accessors, synthesized ivars, message dispatch, header or runtime binding. */
export function extractObjcStructure(root:Node,query:Query,content:string):StructureFacts {
 const source=new SourceText(content),seeds:CfamilySeed[]=[],byNode=new Map<number,DeclarationFact>(),issues:ParseIssue[]=[],damage:Node[]=[];
 const syntax:ObjcSyntaxFacts={propertyImplementations:[],moduleImports:[],complete:true};
 let truncated=false,visited=0;
 const range=(node:Node)=>source.range(Math.min(node.startIndex,content.length),Math.min(node.endIndex,content.length));
 const issue=(reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code:'syntax-extraction-gap',reason,...node?{range:range(node)}:{}});else truncated=true;};
 const pending=[root];while(pending.length){const node=pending.pop()!;if(++visited>MAX_NODES){truncated=true;break;}if(node.isError||node.isMissing)damage.push(node);for(let index=node.namedChildCount-1;index>=0;index--){const child=node.namedChild(index);if(child)pending.push(child);}}
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='objc_declaration')selected.set(capture.node.id,capture.node);
 if(query.didExceedMatchLimit())truncated=true;
 const candidates=[...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex);
 const parentFor=(node:Node):DeclarationFact|undefined=>{let depth=0;for(let current=node.parent;current&&++depth<=128;current=current.parent){const parent=byNode.get(current.id);if(parent)return parent;}return;};
 const headerEnd=(node:Node)=>{
  if(!containers.has(node.type))return node.namedChildren.find(child=>child.type==='compound_statement')?.startIndex??node.endIndex;
  const boundary=node.children.find(child=>members.has(child.type)||child.type==='@end')?.startIndex??node.endIndex;
  return node.children.filter(child=>child.startIndex<boundary&&child.type!=='comment').at(-1)?.endIndex??boundary;
 };
 const valid=(node:Node,end=headerEnd(node))=>!damage.some(error=>error.startIndex<end&&error.endIndex>=node.startIndex);
 const attributes=(node:Node)=>node.namedChildren.filter(child=>/attribute/.test(child.type)).map(child=>child.text);
 const add=(node:Node,nameNode:Node,text:string,kind:string,form:DeclarationFact['declarationForm'],signature:string,options:{scope?:boolean;modifiers?:string[];annotations?:string[];visibility?:string;selector?:string;dispatch?:'class'|'instance'}={}):DeclarationFact|undefined=>{
  if(seeds.length>=MAX_DECLARATIONS){truncated=true;return;}
  if(nameNode.hasError||nameNode.isMissing||!valid(node))return;
  const parent=parentFor(node),conditions=context(node),annotations=[...attributes(node),...options.annotations??[]];
  const fact:DeclarationFact={key:`objc:${node.startIndex}:${node.endIndex}:${kind}:${nameNode.startIndex}`,name:text,qualifiedName:[parent?.qualifiedName,`${options.dispatch?options.dispatch==='class'?'+':'-':''}${text}`].filter(Boolean).join('::'),kind,entityType:kind==='method'||kind==='property'?'method':'class',signature:compact(signature),range:range(node),start:node.startIndex,end:Math.min(node.endIndex,content.length),nameEnd:nameNode.endIndex,declarationForm:form,...parent?{parent:parent.key}:{},...conditions.length?{sourceConditions:conditions}:{},...annotations.length?{annotations}:{},...options.modifiers?.length?{modifiers:options.modifiers}:{},...options.visibility?{visibility:options.visibility}:{},...options.selector?{selector:options.selector,dispatch:options.dispatch}:{}};
  seeds.push({node,declaration:fact,scope:options.scope});if(options.scope)byNode.set(node.id,fact);return fact;
 };
 const originalHeader=(node:Node)=>content.slice(node.startIndex,Math.min(headerEnd(node),content.length));
 for(const node of candidates){
  if(containers.has(node.type)){
   const name=node.namedChildren.find(child=>child.type==='identifier');if(!name){issue('Original Objective-C container has no reviewed identifier; no owner is guessed',node);continue;}
   const category=node.childForFieldName('category'),extension=node.children.some(child=>child.type==='(')&&!category;
   const text=category?`${name.text}(${category.text})`:extension?`${name.text}()`:name.text;
   const kind=node.type==='protocol_declaration'?'protocol':node.type==='class_interface'?'class-interface':'class-implementation';
   const annotations=node.namedChildren.filter(child=>['protocol_reference_list','parameterized_arguments'].includes(child.type)).map(child=>child.text),superclass=node.childForFieldName('superclass');if(superclass)annotations.push(`Original superclass syntax: ${superclass.text}`);
   add(node,name,text,kind,node.type==='class_implementation'?'definition':'declaration',originalHeader(node),{scope:true,annotations,modifiers:category?['category']:extension?['class-extension']:[]});continue;
  }
  if(node.type==='class_declaration'||node.type==='protocol_forward_declaration'){
   for(const name of node.namedChildren.filter(child=>child.type==='identifier'))add(node,name,name.text,node.type==='class_declaration'?'class-forward':'protocol-forward','declaration',node.text);continue;
  }
  if(node.type==='compatibility_alias_declaration'){
   const names=node.namedChildren.filter(child=>child.type==='identifier');if(names.length!==2){issue('Original compatibility alias requires two reviewed source identifiers',node);continue;}
   // The upstream grammar's field labels reverse the native alias/target order.
   add(node,names[0]!,names[0]!.text,'class-alias','declaration',node.text,{annotations:[`Original alias target syntax: ${names[1]!.text}`]});continue;
  }
  if(node.type==='method_declaration'||node.type==='method_definition'){
   const dispatch=node.children.find(child=>child.type==='+'||child.type==='-')?.type;
   let selector='',part:Node|undefined,name:Node|undefined;
   for(const child of node.namedChildren){
    if(child.type==='compound_statement')break;
    if(identifiers.has(child.type)){part=child;name??=child;}
    else if(child.type==='method_parameter'&&child.children.some(token=>token.type===':')){selector+=`${part?.text??''}:`;name??=child.children.find(token=>token.type===':');part=undefined;}
   }
   if(!selector&&part)selector=part.text;
   if(!name||!selector||!dispatch){issue('Original Objective-C method has no complete reviewed selector; no name is guessed',node);continue;}
   if(!parentFor(node)){issue('Original Objective-C method has no retained source container; no owner is guessed',node);continue;}
   const qualification=node.parent?.type==='qualified_protocol_interface_declaration'?node.parent.children.find(child=>child.type==='@optional'||child.type==='@required')?.text.slice(1):undefined;
   add(node,name,selector,'method',node.type==='method_definition'?'definition':'declaration',originalHeader(node),{scope:true,selector,dispatch:dispatch==='+'?'class':'instance',modifiers:[dispatch==='+'?'class-method':'instance-method',...qualification?[qualification]:[]]});continue;
  }
  if(node.type==='property_declaration'||node.type==='instance_variables'){
   const declarations:Node[]=[];const members=[node];let examined=0;
   while(members.length){const child=members.pop()!;if(++examined>MAX_NODES){truncated=true;break;}if(child.type==='struct_declaration'||child.type==='atomic_declaration')declarations.push(child);else for(const nested of child.namedChildren)members.push(nested);}
   for(const declaration of declarations.sort((a,b)=>a.startIndex-b.startIndex)){
    if(!valid(declaration,declaration.endIndex))continue;
    const conditional=context(declaration).length>0,visibility=node.type==='instance_variables'&&!conditional?ivarVisibility(declaration,node):undefined;
    const propertyAttributes=node.namedChildren.find(child=>child.type==='property_attributes_declaration')?.namedChildren.map(child=>child.text)??[];
    if(conditional&&node.type==='instance_variables')propertyAttributes.push('Conditional ivar access syntax remains unevaluated');
    if(declaration.type==='atomic_declaration'){
     const name=declaration.namedChildren.find(child=>['identifier','field_identifier'].includes(child.type));
     if(name)add(node.type==='property_declaration'?node:declaration,name,name.text,'property','declaration',node.type==='property_declaration'?node.text:declaration.text,{modifiers:[node.type==='property_declaration'?'objc-property':'ivar'],annotations:propertyAttributes,visibility});else issue('Original atomic property/ivar has no reviewed name',declaration);continue;
    }
    const firstDeclarator=declaration.namedChildren.find(child=>child.type==='struct_declarator');
    for(const item of declaration.namedChildren.filter(child=>child.type==='struct_declarator')){
     if(item.children[0]?.type===':')continue;
     const original=item.namedChildren.find(child=>!child.type.includes('attribute')&&child.type!=='bitfield_clause'),name=declarator(original);
     if(!name){issue('Original Objective-C property/ivar requires an additional declarator profile; no name is guessed',item);continue;}
     const enclosing=node.type==='property_declaration'?node:declaration,prefix=content.slice(enclosing.startIndex,firstDeclarator!.startIndex),parent=parentFor(node);
     if(!parent){issue('Original Objective-C property/ivar has no retained source container',enclosing);continue;}
     add(enclosing,name.name,name.display,'property','declaration',`${prefix}${item.text}`,{modifiers:[node.type==='property_declaration'?'objc-property':'ivar'],annotations:propertyAttributes,visibility});
    }
   }continue;
  }
  if(node.type==='property_implementation'){
   if(syntax.propertyImplementations.length>=MAX_METADATA){truncated=true;continue;}
   syntax.propertyImplementations.push({kind:node.children.some(child=>child.type==='@dynamic')?'dynamic':'synthesize',text:content.slice(node.startIndex,Math.min(node.endIndex,content.length)),names:node.namedChildren.filter(child=>child.type==='identifier').map(child=>child.text),range:range(node)});continue;
  }
  if(node.type==='module_import'){
   if(syntax.moduleImports.length>=MAX_METADATA){truncated=true;continue;}
   syntax.moduleImports.push({text:content.slice(node.startIndex,Math.min(node.endIndex,content.length)),path:node.childrenForFieldName('path').filter(child=>child.type==='identifier').map(child=>child.text),range:range(node)});
  }
 }
 const facts=extractCfamilyStructure(root,query,'c',content,seeds);
 facts.declarations.sort((a,b)=>a.start-b.start||b.end-a.end||a.key.localeCompare(b.key));
 facts.issues.push(...issues);if(facts.issues.length>MAX_ISSUES){facts.issues.length=MAX_ISSUES;truncated=true;}
 if(truncated&&!facts.issues.some(issue=>issue.code==='syntax-budget-exceeded')){if(facts.issues.length===MAX_ISSUES)facts.issues.pop();facts.issues.push({code:'syntax-budget-exceeded',reason:'Objective-C structure reached its node, declaration, syntax-metadata, diagnostic or query limit'});}
 facts.truncated||=truncated;syntax.complete=!facts.truncated&&!facts.issues.length;if(facts.cfamily)facts.cfamily.complete=syntax.complete;
 facts.issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||a.reason.localeCompare(b.reason));
 return {...facts,objc:syntax};
}

function ivarVisibility(member:Node,container:Node):string {
 let visibility='protected';
 for(const node of container.namedChildren){if(node.startIndex>member.startIndex)break;const token=node.namedChildren.find(child=>child.type==='visibility_specification');if(token)visibility=token.text.slice(1);}
 return visibility;
}
