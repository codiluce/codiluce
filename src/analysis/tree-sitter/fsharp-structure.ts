import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,FsharpSyntaxFacts,ParseIssue,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_NODES=200_000,MAX_DECLARATIONS=20_000,MAX_METADATA=4096,MAX_ISSUES=100;
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
const typeKinds=new Set(['type','class','struct','record','union','enum','interface','delegate','type-alias','type-extension','exception']);
const bodies=new Set(['anon_type_defn','record_type_defn','union_type_defn','enum_type_defn','interface_type_defn','delegate_type_defn','type_abbrev_defn','type_declaration','type_extension']);
const direct=(node:Node,...types:string[])=>node.namedChildren.find(child=>types.includes(child.type));
const nameOf=(node:Node|undefined):Node|undefined=>{
 if(!node)return;
 if(['identifier','op_identifier','active_pattern'].includes(node.type))return node;
 if(node.type==='long_identifier'||node.type==='long_identifier_or_op')return node.namedChildren.length===1?nameOf(node.namedChildren[0]):undefined;
};
/** Original native syntax only. No FSI/compiler, project scripts, type providers,
 * quotations, file loads, signature/implementation merging or CLR synthesis. */
export function extractFsharpStructure(root:Node,query:Query,content:string,signatureFile=false):StructureFacts {
 const source=new SourceText(content),declarations:DeclarationFact[]=[],issues:ParseIssue[]=[],syntax:FsharpSyntaxFacts={sourceKind:signatureFile?'signature':'implementation',attributes:[],imports:[],directives:[],conditions:[],quotations:[],complete:true};
 const all:Node[]=[],damage:Node[]=[],comments:Node[]=[],pending=[root];let truncated=false;
 const range=(start:number,end:number)=>source.range(Math.min(start,content.length),Math.min(end,content.length));
 const issue=(code:string,reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code,reason,...node?{range:range(node.startIndex,node.endIndex)}:{}});else truncated=true;};
 while(pending.length){const node=pending.pop()!;if(all.length===MAX_NODES){truncated=true;break;}all.push(node);if(node.isError||node.isMissing){damage.push(node);issue('syntax-parse-error',node.isMissing?`Missing ${node.type}`:'F# parser recovered from unsupported or invalid syntax',node);}if(/comment/.test(node.type))comments.push(node);for(let i=node.childCount-1;i>=0;i--){const child=node.child(i);if(child)pending.push(child);}}
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')selected.set(capture.node.id,capture.node);if(query.didExceedMatchLimit())truncated=true;
 const byNode=new Map<number,DeclarationFact>(),unsafeOwners=new Set<number>(),ambiguousUnions=new Set<number>();
 const ancestors=(node:Node)=>{const parents:Node[]=[];for(let p=node.parent;p;p=p.parent){if(parents.length===128){truncated=true;break;}parents.push(p);}return parents;};
 const parentFor=(node:Node)=>{for(const parent of ancestors(node)){const fact=byNode.get(parent.id);if(fact)return fact;}return undefined;};
 const text=(node:Node)=>{if(node.endIndex-node.startIndex>8192)truncated=true;return content.slice(node.startIndex,Math.min(node.endIndex,node.startIndex+8192,content.length));};
 const append=<T>(target:T[],value:T)=>{if(target.length===MAX_METADATA)truncated=true;else target.push(value);};
 const header=(start:number,end:number)=>{let value='',at=start;for(const comment of comments.filter(n=>n.startIndex>=start&&n.endIndex<=end).sort((a,b)=>a.startIndex-b.startIndex)){value+=content.slice(at,comment.startIndex)+' ';at=comment.endIndex;}return compact(value+content.slice(at,end));};
 const conditions=(node:Node)=>ancestors(node).reverse().filter(p=>['preproc_if','preproc_else','interface_implementation','type_extension'].includes(p.type)).map(p=>{
  if(p.type==='preproc_if')return `Original #if ${compact(p.childForFieldName('condition')?.text??'')}; branch selection is unverified`;
  if(p.type==='preproc_else')return 'Original #else branch; branch selection is unverified';
  return `Original ${p.type==='type_extension'?'type extension':'explicit interface implementation'} context; type/member binding is unverified`;
 });
 const blocked=(node:Node)=>ancestors(node).some(p=>p.isError||p.isMissing||p.type==='literal_expression'||unsafeOwners.has(p.id));
 const add=(node:Node,nameNode:Node,kind:string,start=node.startIndex,end=node.endIndex,headerEnd=end,scope=false,explicitSignature?:string)=>{
  if(declarations.length===MAX_DECLARATIONS){truncated=true;return;}
  if(blocked(node)||nameNode.hasError||nameNode.isMissing||damage.some(n=>n.startIndex<headerEnd&&n.endIndex>=start))return;
  const parent=parentFor(node),mods=node.children.filter(n=>['access_modifier','mutable','inline','rec','static','abstract','override','default'].includes(n.type)).map(n=>n.text),attributeOwner=bodies.has(node.type)&&node.parent?.type==='type_definition'?node.parent:['function_declaration_left','value_declaration_left'].includes(node.type)&&node.parent?.type==='function_or_value_defn'?node.parent:node,attrs=attributeOwner.namedChildren.filter(n=>n.type==='attributes').map(n=>text(n));
  const fact:DeclarationFact={key:`fsharp:${start}:${end}:${kind}:${nameNode.startIndex}`,name:nameNode.text,qualifiedName:[parent?.qualifiedName,nameNode.text].filter(Boolean).join('.'),kind,entityType:['function','method','constructor','property'].includes(kind)?kind==='function'?'function':'method':'class',signature:explicitSignature??header(start,headerEnd),start,end:Math.min(end,content.length),nameEnd:nameNode.endIndex,range:range(start,end),declarationForm:signatureFile||kind==='abstract-method'||kind==='abstract-property'?'declaration':'definition',...parent?{parent:parent.key}:{},...mods.length?{modifiers:mods}:{},...attrs.length?{annotations:attrs}:{},sourceConditions:[...conditions(node),...(signatureFile?['Original F# signature declaration; agreement with implementation/project compile order is unverified']:[])]};
  const visibility=mods.find(m=>['private','internal','public'].includes(m));if(visibility)fact.visibility=visibility;
  declarations.push(fact);if(scope)byNode.set(node.id,fact);return fact;
 };
 // Capitalized source binding heads can denote union/exception patterns. Keep
 // those as an explicit gap rather than inventing a declaration from a reference.
 const bindingName=(name:Node|undefined,node:Node,explicit=false)=>{
  if(!name){issue('fsharp-pattern-gap','F# binding pattern has no independently qualified original name; no names are guessed',node);return;}
  const spelling=name.text.replace(/^``|``$/g,'');
  if(!explicit&&name.type==='identifier'&&!/^[\p{Ll}_]/u.test(spelling)){issue('fsharp-pattern-gap','Capitalized F# binding head may be a constructor/constant pattern; binding requires compiler context and is omitted',node);return;}
  return name;
 };
 const patternNames=(pattern:Node):Node[]=>{
  if(pattern.type==='identifier_pattern'){
   const head=direct(pattern,'long_identifier_or_op');if(pattern.namedChildren.length!==1){issue('fsharp-pattern-gap','Applied F# value pattern is ambiguous with a constructor pattern; names are omitted',pattern);return [];}
   const name=bindingName(nameOf(head),pattern);return name?[name]:[];
  }
  if(['paren_pattern','repeat_pattern','typed_pattern'].includes(pattern.type))return pattern.namedChildren.filter(n=>n.type.endsWith('_pattern')).flatMap(patternNames);
  if(pattern.type!=='wildcard_pattern')issue('fsharp-pattern-gap','This F# destructuring pattern requires additional qualification; no names are guessed',pattern);
  return [];
 };
 for(const node of all){
  if(blocked(node))continue;
  if(node.type==='attributes'){append(syntax.attributes,{text:text(node),range:range(node.startIndex,node.endIndex)});}
  else if(node.type==='extern_binding'){issue('fsharp-extern-gap','Original external F# declaration is outside the qualified profile; native library and callable binding remain unverified',node);}
  else if(node.type==='import_decl'){append(syntax.imports,{text:text(node),path:direct(node,'long_identifier')?.text??'',range:range(node.startIndex,node.endIndex)});}
  else if(['fsi_directive_decl','compiler_directive_decl'].includes(node.type)){append(syntax.directives,{text:text(node),range:range(node.startIndex,node.endIndex)});if(node.children.some(n=>['#load','#r','#I'].includes(n.type)))issue('fsharp-loading-gap','Original F# load/reference/search-path directive is source only; no file, package or assembly is loaded',node);}
  else if(['preproc_if','preproc_else'].includes(node.type)){append(syntax.conditions,{text:content.slice(node.startIndex,Math.min(node.endIndex,content.indexOf('\n',node.startIndex)<0?content.length:content.indexOf('\n',node.startIndex))),range:range(node.startIndex,node.endIndex)});}
  else if(node.type==='literal_expression'){append(syntax.quotations,{text:text(node),range:range(node.startIndex,node.endIndex)});issue('fsharp-quotation-gap','Original F# quotation retained; quoted declarations, evaluation and generated code are excluded',node);}
 }
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  if(blocked(node))continue;
  if(['namespace','named_module','module_defn','module_abbrev'].includes(node.type)){
   const name=node.childrenForFieldName('name').find(n=>n.isNamed)??direct(node,'identifier'),first=node.childrenForFieldName('block')[0]??node.namedChildren.find(n=>n.startIndex>(name?.endIndex??node.endIndex)&&n.type!=='attributes');
   if(name)add(node,name,node.type==='namespace'?'namespace':node.type==='module_abbrev'?'module-alias':'module',node.startIndex,node.endIndex,first?.startIndex??name.endIndex,true);continue;
  }
  if(node.type==='type_definition'){
   for(const body of node.namedChildren.filter(n=>bodies.has(n.type))){
    const typeName=direct(body,'type_name'),name=typeName?.childForFieldName('type_name');if(!name||!typeName)continue;
    const first=body.childrenForFieldName('block')[0]??direct(body,'union_type_cases','enum_type_cases','type_extension_elements'),explicitType=body.children.find(n=>['class','struct'].includes(n.type)),headerEnd=explicitType?.endIndex??first?.startIndex??typeName.endIndex;
    let kind=body.type==='anon_type_defn'?explicitType?.type??(direct(body,'primary_constr_args')?'class':'type'):({'record_type_defn':'record','union_type_defn':'union','enum_type_defn':'enum','interface_type_defn':'interface','delegate_type_defn':'delegate','type_abbrev_defn':'type-alias','type_extension':'type-extension'} as Record<string,string>)[body.type]??'type';
    if(kind==='union'){
     const cases=direct(body,'union_type_cases')?.namedChildren.filter(n=>n.type==='union_type_case')??[];
     if(cases.length===1&&!body.children.some(n=>n.type==='|')&&!direct(body,'union_type_cases')?.children.some(n=>n.type==='|')&&!direct(cases[0]!,'union_type_fields')&&!cases[0]!.children.some(n=>['of',':'].includes(n.type))){kind='type';ambiguousUnions.add(body.id);issue('fsharp-type-shape-gap','Native single bare F# union case is ambiguous with a type alias; the original type is retained and no case is invented',body);}
    }
    if(body.hasError){unsafeOwners.add(body.id);issue('fsharp-owner-recovery-gap','F# type body recovery makes member ownership uncertain; only an intact original type header is retained',body);}
    const fact=add(body,name,kind,body.startIndex,body.hasError?headerEnd:body.endIndex,['type-alias','delegate'].includes(kind)?body.endIndex:headerEnd,true);if(fact&&body.hasError){fact.declarationForm='declaration';fact.sourceConditions!.push('Original type header only; body/member ownership is unverified');}if(fact){const access=direct(typeName,'access_modifier');if(access)fact.visibility=access.text;}if(fact&&kind==='type-extension')fact.sourceConditions!.push('Original type extension region; no new type or logical type merging is inferred');
   }continue;
  }
  if(node.type==='exception_definition'){const name=node.childForFieldName('exception_name');if(name)add(node,name,'exception',node.startIndex,node.endIndex,direct(node,'type_extension_elements')?.startIndex??node.endIndex,true);continue;}
  if(['record_field','union_type_case','union_type_field','enum_type_case'].includes(node.type)){
   if(ancestors(node).some(n=>ambiguousUnions.has(n.id)))continue;
   const name=direct(node,'identifier');if(!name)continue;
   if(node.type==='union_type_field'&&!node.children.some(n=>n.type===':'))continue;
   const kind=node.type==='record_field'?'field':node.type==='union_type_field'?'union-field':node.type==='union_type_case'?'union-case':'enum-member';add(node,name,kind,node.startIndex,node.endIndex,node.children.find(n=>n.type==='=')?.startIndex??node.endIndex,node.type==='union_type_case');continue;
  }
  if(node.type==='function_or_value_defn'){
   if(signatureFile){issue('fsharp-signature-shape-gap','Implementation binding in a signature file is outside the qualified signature profile and is omitted',node);continue;}
   const lefts=node.namedChildren.filter(n=>['function_declaration_left','value_declaration_left'].includes(n.type)),right=node.childrenForFieldName('body');
   for(let i=0;i<lefts.length;i++){
    const left=lefts[i]!,body=right[i];if(!body){issue('fsharp-binding-gap','F# binding has no reviewed native body; declaration omitted',left);continue;}
    const pattern=direct(left,'identifier_pattern'),applied=pattern&&pattern.namedChildren.length>1;
    if(left.type==='function_declaration_left'||applied){
     if(ancestors(node).some(n=>['fun_expression','function_expression','brace_expression','ce_expression'].includes(n.type))){issue('fsharp-closure-owner-gap','Named F# binding inside an anonymous lambda/computation has unqualified ownership and is omitted',left);continue;}
     const name=bindingName(left.type==='function_declaration_left'?direct(left,'identifier','op_identifier','active_pattern'):nameOf(direct(pattern!,'long_identifier_or_op')),left);if(!name)continue;
     const prefix=node.children.filter(n=>['let','let!','rec','inline','mutable'].includes(n.type)).map(n=>n.text),fact=add(left,name,'function',left.startIndex,body.endIndex,body.startIndex,true,compact(`${prefix.join(' ')} ${header(left.startIndex,body.startIndex)}`));if(fact){byNode.set(body.id,fact);fact.modifiers=[...prefix.filter(m=>m!=='let'&&m!=='let!'),...left.children.filter(n=>['inline','mutable'].includes(n.type)).map(n=>n.text)];const access=direct(left,'access_modifier');if(access)fact.visibility=access.text;}
    }else{
     // Local values and primary-constructor bindings are not module declarations.
     if(ancestors(node).some(n=>['function_or_value_defn','method_or_prop_defn','fun_expression','member_defn','anon_type_defn','brace_expression'].includes(n.type)))continue;
     const valuePattern=left.namedChildren.find(n=>n.type.endsWith('_pattern'));if(!valuePattern)continue;
     for(const name of patternNames(valuePattern)){const prefix=node.children.filter(n=>['let','let!','rec','inline','mutable'].includes(n.type)).map(n=>n.text),fact=add(left,name,'variable',left.startIndex,body.endIndex,body.startIndex,false,compact(`${prefix.join(' ')} ${header(left.startIndex,body.startIndex)}`));if(fact){fact.modifiers=[...prefix.filter(m=>m!=='let'&&m!=='let!'),...left.children.filter(n=>['inline','mutable'].includes(n.type)).map(n=>n.text)];const access=direct(left,'access_modifier');if(access)fact.visibility=access.text;}}
    }
   }continue;
  }
  if(node.type==='value_definition'){
   const left=direct(node,'value_declaration_left'),pattern=left&&direct(left,'identifier_pattern'),name=bindingName(nameOf(pattern&&direct(pattern,'long_identifier_or_op')),node,true),spec=direct(node,'curried_spec');if(name&&spec)add(node,name,spec.namedChildren.some(n=>n.type==='arguments_spec')?'function':'variable',node.startIndex,node.endIndex,node.childForFieldName('body')?.startIndex??node.endIndex);continue;
  }
  if(node.type==='member_defn'){
   const parent=parentFor(node);if(!parent||!typeKinds.has(parent.kind)||ancestors(node).some(n=>n.type==='brace_expression')){issue('fsharp-anonymous-member-gap','Original F# member has no qualified named type owner; member omitted',node);continue;}
   const method=direct(node,'method_or_prop_defn'),prop=method?.childForFieldName('name')??direct(node,'property_or_ident'),spec=direct(node,'member_signature'),ctor=direct(node,'additional_constr_defn');
   const name=prop?.childForFieldName('method')??(prop&&direct(prop,'identifier','op_identifier','active_pattern'))??(spec&&direct(spec,'identifier'))??ctor?.children.find(n=>n.type==='new');
   if(!name){issue('fsharp-member-gap','F# native member name requires additional qualification; member omitted',node);continue;}
   const property=prop&&!method?.childForFieldName('args'),kind=ctor?'constructor':spec?direct(spec,'curried_spec')?.namedChildren.some(n=>n.type==='arguments_spec')?'method':'property':property?'property':'method';
   const equal=(ctor??method??node).children.find(n=>n.type==='='),headerEnd=equal?.startIndex??method?.childrenForFieldName('block')[0]?.startIndex??node.endIndex;
   const accessors=method?.childrenForFieldName('block').filter(n=>n.type==='property_accessor')??[],accessorHeaders=accessors.map(n=>header(n.startIndex,n.children.find(c=>c.type==='=')?.startIndex??n.endIndex)).join(' and ');
   const accessorTokens=node.children.filter(n=>['with','get','set',','].includes(n.type)).map(n=>n.text).join(' ');
   const fact=add(node,name,kind,node.startIndex,node.endIndex,headerEnd,true,property?compact(`${header(node.startIndex,headerEnd)} ${accessorHeaders||accessorTokens}`):undefined);if(fact&&spec)fact.declarationForm='declaration';continue;
  }
 }
 if(truncated){if(issues.length===MAX_ISSUES)issues.pop();issues.push({code:'syntax-budget-exceeded',reason:'F# extraction reached its node, declaration, metadata, diagnostic, context or query limit'});}
 syntax.complete=!truncated&&!issues.length;issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||a.reason.localeCompare(b.reason));return {declarations,issues,truncated,fsharp:syntax};
}
