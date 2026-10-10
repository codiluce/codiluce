import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,ParseIssue,StructureFacts,SwiftSyntaxFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_NODES=200_000,MAX_DECLARATIONS=20_000,MAX_METADATA=4096,MAX_ISSUES=100;
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
const callableKinds=new Set(['function','method','constructor','destructor','subscript']);
const typeKinds=new Set(['class','struct','enum','actor','protocol','extension']);
const names=new Set(['simple_identifier','type_identifier','custom_operator']);
const knownAttributes=new Set(['attached','freestanding','available','objc','objcMembers','MainActor','Sendable','preconcurrency','inlinable','usableFromInline','discardableResult','propertyWrapper','resultBuilder','unchecked','escaping','autoclosure','convention','noescape','nonobjc','frozen','unknown','_spi','_alwaysEmitIntoClient','_disfavoredOverload','_transparent','_specialize','_cdecl']);
/** Original declarations only: no SwiftPM evaluation, SDK/compiler, extension
 * merging, imports/type binding, macro expansion or synthesized members. */
export function extractSwiftStructure(root:Node,query:Query,content:string):StructureFacts {
 const source=new SourceText(content),declarations:DeclarationFact[]=[],issues:ParseIssue[]=[],syntax:SwiftSyntaxFacts={imports:[],directives:[],macroInvocations:[],complete:true};
 const damage:Node[]=[],comments:Node[]=[],all:Node[]=[],pending=[root];let truncated=false,visited=0;
 const range=(start:number,end:number)=>source.range(Math.min(start,content.length),Math.min(end,content.length));
 const issue=(code:string,reason:string,node?:Node)=>{if(issues.length<MAX_ISSUES)issues.push({code,reason,...node?{range:range(node.startIndex,node.endIndex)}:{}});else truncated=true;};
 while(pending.length){const node=pending.pop()!;if(++visited>MAX_NODES){truncated=true;break;}all.push(node);if(node.isError||node.isMissing){damage.push(node);issue('syntax-parse-error',node.isMissing?`Missing ${node.type}`:'Swift parser recovered from invalid syntax',node);}if(/comment/.test(node.type))comments.push(node);for(let n=node.childCount-1;n>=0;n--){const child=node.child(n);if(child)pending.push(child);}}
 const directives=all.filter(n=>n.type==='directive').sort((a,b)=>a.startIndex-b.startIndex),contexts:{end:number;values:string[]}[]=[],conditions:string[]=[];let depth=0;
 for(const node of directives){
  const text=content.slice(node.startIndex,Math.min(node.endIndex,content.length));
  if(syntax.directives.length>=MAX_METADATA){truncated=true;break;}syntax.directives.push({text:text.slice(0,8192),range:range(node.startIndex,node.endIndex)});if(text.length>8192)truncated=true;
  if(/^#if\b/.test(text)){depth++;if(depth<=128)conditions.push(text.slice(0,8192));else truncated=true;}
  else if(/^#(?:elseif|else)\b/.test(text)&&depth<=128&&conditions.length)conditions[conditions.length-1]=`${conditions.at(-1)} | ${text}`.slice(0,8192);
  else if(/^#endif\b/.test(text)){if(depth<=128)conditions.pop();depth=Math.max(0,depth-1);}
  contexts.push({end:node.endIndex,values:[...conditions]});
 }
 const context=(start:number)=>{let low=0,high=contexts.length;while(low<high){const middle=(low+high)>>>1;if(contexts[middle]!.end<=start)low=middle+1;else high=middle;}return [...contexts[low-1]?.values??[]];};
 for(const node of all){
  if(node.type==='import_declaration'){
   if(syntax.imports.length>=MAX_METADATA){truncated=true;continue;}
   const path=node.namedChildren.find(n=>n.type==='identifier');if(!path||node.hasError)continue;
   const kind=node.children.find(n=>['class','struct','enum','protocol','func','var','let','typealias'].includes(n.type))?.text;
   syntax.imports.push({text:content.slice(node.startIndex,Math.min(node.endIndex,content.length)),path:path.text,...kind?{kind}:{},range:range(node.startIndex,node.endIndex)});
  }else if(node.type==='macro_invocation'){
   if(syntax.macroInvocations.length>=MAX_METADATA){truncated=true;continue;}
   const name=node.namedChildren.find(n=>n.type==='simple_identifier');if(!name)continue;
   syntax.macroInvocations.push({text:content.slice(node.startIndex,Math.min(node.endIndex,content.length)).slice(0,8192),name:name.text,range:range(node.startIndex,node.endIndex)});
   issue('swift-macro-expansion-gap','Original Swift macro invocation retained; generated declarations and compiler-plugin expansion remain unverified',node);
  }
 }
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')selected.set(capture.node.id,capture.node);if(query.didExceedMatchLimit())truncated=true;
 const byNode=new Map<number,DeclarationFact>();
 const parentFor=(node:Node)=>{for(let current=node.parent,depth=0;current&&++depth<=128;current=current.parent){const parent=byNode.get(current.id);if(parent)return parent;}return undefined;};
 const body=(node:Node)=>node.childForFieldName('body')??node.childForFieldName('computed_value')??node.namedChildren.find(n=>['computed_property','willset_didset_block'].includes(n.type));
 const header=(start:number,end:number)=>{let text='',at=start;for(const comment of comments.filter(c=>c.startIndex>=start&&c.endIndex<=end).sort((a,b)=>a.startIndex-b.startIndex)){text+=content.slice(at,comment.startIndex)+' ';at=comment.endIndex;}return compact(text+content.slice(at,end));};
 const add=(node:Node,nameNode:Node,name:string,kind:string,start=node.startIndex,end=node.endIndex,signatureEnd=body(node)?.startIndex??end,scope=false,swiftName?:string)=>{
  if(declarations.length>=MAX_DECLARATIONS){truncated=true;return;}
  if(nameNode.isMissing||nameNode.hasError||damage.some(error=>error.startIndex<signatureEnd&&error.endIndex>start))return;
  const parent=parentFor(node),mods=node.namedChildren.filter(n=>/modifier/.test(n.type)).flatMap(n=>n.type==='modifiers'?n.namedChildren.filter(c=>c.type!=='attribute'): [n]).map(n=>n.text);
  const attributes=node.namedChildren.flatMap(n=>n.type==='modifiers'?n.namedChildren.filter(c=>c.type==='attribute'):n.type==='attribute'?[n]:[]),annotations=attributes.map(n=>n.text),sourceConditions=context(start);
  for(const attr of attributes){const attributeName=/^@([\w.]+)/.exec(attr.text)?.[1];if(attributeName&&!knownAttributes.has(attributeName)){sourceConditions.push('Original Swift attribute syntax retained; attached macro/property-wrapper expansion remains unverified');issue('swift-attribute-expansion-gap','Original Swift attribute may generate members; expansion and synthesized declarations remain unverified',attr);}}
  if(kind==='function'&&parent&&typeKinds.has(parent.kind))kind='method';
  for(let current=node.parent,depth=0;current&&++depth<=128;current=current.parent)if(current.type==='lambda_literal'){sourceConditions.push('Original named declaration inside an anonymous Swift closure; closure/type binding remains unverified');break;}
  const fact:DeclarationFact={key:`swift:${start}:${end}:${kind}:${nameNode.startIndex}`,name,qualifiedName:[parent?.qualifiedName,name].filter(Boolean).join('.'),kind,entityType:callableKinds.has(kind)?kind==='function'?'function':'method':kind==='property'?'method':'class',signature:header(start,signatureEnd),range:range(start,end),start,end:Math.min(end,content.length),nameEnd:nameNode.endIndex,declarationForm:body(node)?'definition':'declaration',...parent?{parent:parent.key}:{},...mods.length?{modifiers:mods}:{},...annotations.length?{annotations}:{},...sourceConditions.length?{sourceConditions}:{},...swiftName?{swiftName}:{}};
  const visibility=mods.find(m=>/^(?:open|public|package|internal|fileprivate|private)$/.test(m));if(visibility)fact.visibility=visibility;
  declarations.push(fact);if(scope)byNode.set(node.id,fact);return fact;
 };
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  const fields=node.childrenForFieldName('name');
  if(['class_declaration','protocol_declaration'].includes(node.type)){
   const token=node.children.find(n=>['class','struct','enum','actor','extension','protocol'].includes(n.type)),name=fields[0];if(!token||!name){issue('syntax-extraction-gap','Swift type/extension has no reviewed original name',node);continue;}add(node,name,name.text,token.text,node.startIndex,node.endIndex,body(node)?.startIndex??node.endIndex,true);continue;
  }
  if(['function_declaration','protocol_function_declaration','init_declaration','deinit_declaration','subscript_declaration'].includes(node.type)){
   const keyword=node.type==='init_declaration'?'init':node.type==='deinit_declaration'?'deinit':node.type==='subscript_declaration'?'subscript':undefined;
   const name=keyword?node.children.find(n=>n.type===keyword):fields.find(n=>names.has(n.type)||!n.isNamed&&/^[^\p{ID_Continue}\s()[\]{}:;,]+$/u.test(n.text)&&n.text!=='->');if(!name){issue('syntax-extraction-gap','Swift callable has no reviewed original name',node);continue;}
   const kind=keyword==='init'?'constructor':keyword==='deinit'?'destructor':keyword==='subscript'?'subscript':'function',parameters=node.namedChildren.filter(n=>n.type==='parameter'),labels:string[]=[];
   for(const parameter of parameters){const explicit=parameter.childForFieldName('external_name'),local=parameter.childrenForFieldName('name').find(n=>n.type==='simple_identifier');if(!explicit&&!local){issue('syntax-extraction-gap','Swift parameter label has no reviewed original identifier',parameter);break;}labels.push(explicit?.text??(keyword==='subscript'||name.type==='custom_operator'||!name.isNamed?'_':local!.text));}
   const nativeName=kind==='destructor'?'deinit':labels.length===parameters.length?`${name.text}(${labels.map(label=>label+':').join('')})`:undefined;
   add(node,name,name.text,kind,node.startIndex,node.endIndex,body(node)?.startIndex??node.endIndex,true,nativeName);continue;
  }
  if(['property_declaration','protocol_property_declaration'].includes(node.type)){
   let local=false;for(let current=node.parent,depth=0;current&&++depth<=128;current=current.parent){if(['class_body','enum_class_body','protocol_body'].includes(current.type))break;if(['statements','lambda_literal','function_body'].includes(current.type)){local=true;break;}}if(local)continue;
   for(const pattern of fields.filter(n=>n.type==='pattern')){
    const identifiers:Node[]=[],pending=[pattern];while(pending.length){const part=pending.pop()!;if(part.type==='simple_identifier')identifiers.push(part);else if(part.type==='pattern')for(const nested of part.namedChildren)pending.push(nested);}
    for(const name of identifiers.sort((a,b)=>a.startIndex-b.startIndex)){
     const parent=parentFor(node),type=node.namedChildren.find(n=>n.type==='type_annotation'&&n.startIndex>=pattern.endIndex&&n.startIndex<(fields.find(p=>p.startIndex>pattern.startIndex)?.startIndex??node.endIndex));
     const fact=add(node,name,name.text,parent&&typeKinds.has(parent.kind)?'property':'variable',node.startIndex,node.endIndex,body(node)?.startIndex??Math.min(node.childForFieldName('value')?.startIndex??node.endIndex,type?.endIndex??pattern.endIndex));
     if(fact){fact.signature=compact(`${node.namedChildren.find(n=>n.type==='value_binding_pattern')?.text??pattern.namedChildren.find(n=>n.type==='value_binding_pattern')?.text??''} ${name.text}${type?type.text:''}`);if(node.childForFieldName('value'))fact.declarationForm='definition';}
    }
   }continue;
  }
  if(node.type==='enum_entry'){
   const entries=fields.filter(n=>n.type==='simple_identifier');for(let at=0;at<entries.length;at++){const name=entries[at]!,next=entries[at+1],last=node.children.filter(n=>n.startIndex>=name.startIndex&&(!next||n.endIndex<=next.startIndex)&&n.type!==',').at(-1);const fact=add(node,name,name.text,'enum-member',at===0?node.startIndex:name.startIndex,last?.endIndex??name.endIndex,last?.endIndex??name.endIndex);if(fact)fact.declarationForm='definition';}continue;
  }
  const name=node.type==='macro_declaration'||node.type==='precedence_group_declaration'?node.namedChildren.find(n=>n.type==='simple_identifier'):node.type==='operator_declaration'?node.namedChildren.find(n=>n.type==='custom_operator'||n.type==='bang'):fields.find(n=>names.has(n.type));
  if(!name){issue('syntax-extraction-gap','Swift named declaration requires an additional structural profile; no name is guessed',node);continue;}
  const kind=node.type==='typealias_declaration'?'type':node.type==='associatedtype_declaration'?'associatedtype':node.type==='macro_declaration'?'macro':node.type==='operator_declaration'?'operator':'precedencegroup';
  const definition=node.childForFieldName('definition');const fact=add(node,name,name.text,kind,node.startIndex,node.endIndex,definition?node.children.find(n=>n.type==='=')?.startIndex??definition.startIndex:node.endIndex);
  if(fact&&kind==='macro')fact.sourceConditions=[...fact.sourceConditions??[],'Original Swift macro declaration only; compiler-plugin expansion and generated declarations remain unverified'];
 }
 if(truncated){if(issues.length>=MAX_ISSUES)issues.pop();issues.push({code:'syntax-budget-exceeded',reason:'Swift extraction reached its node, declaration, directive/context, metadata, diagnostic or query limit'});}
 issues.sort((a,b)=>(a.range?.startLine??0)-(b.range?.startLine??0)||a.reason.localeCompare(b.reason));syntax.complete=!truncated&&!issues.length;
 return {declarations,issues,truncated,swift:syntax};
}
