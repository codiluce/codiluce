import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';
import {extractCfamilyStructure} from './cfamily-structure.js';
import {cfamilySource,sourceConditions,sourceIdentifier,type CfamilySource} from './cfamily-source.js';
import {objcRegions} from './objc-regions.js';

const objcKinds=new Set(['class-interface','class-implementation','class-forward','class-alias','protocol','protocol-forward']);
export const originalObjcDeclarations=(declarations:readonly DeclarationFact[])=>declarations.filter(f=>objcKinds.has(f.kind)||!!f.selector||f.modifiers?.some(m=>['objc-property','ivar'].includes(m)));
export function objectiveCppSource(content:string):boolean {
 const {tokens}=cfamilySource(content);
 return tokens.some((t,at)=>!t.opaque&&(
  t.text==='namespace'&&(sourceIdentifier(tokens[at+1])||tokens[at+1]?.text==='{')||
  t.text==='template'&&tokens[at+1]?.text==='<'||
  t.text==='using'&&(tokens[at+1]?.text==='namespace'||sourceIdentifier(tokens[at+1])&&tokens[at+2]?.text==='=')||
  t.text==='class'&&tokens[at-1]?.text!=='@'&&sourceIdentifier(tokens[at+1])&&['{',':',';'].includes(tokens[at+2]?.text??'')||
  sourceIdentifier(t)&&tokens[at+1]?.text===':'&&tokens[at+2]?.text===':'&&sourceIdentifier(tokens[at+3])||
  ['static_cast','reinterpret_cast','dynamic_cast','const_cast'].includes(t.text)&&tokens[at+1]?.text==='<'
 ));
}
/** Separate grammars read the same original bytes. C++ facts never originate
 * inside Objective-C containers; only lexical namespace containment is shared. */
export function composeObjcCpp(facts:StructureFacts,root:Node,query:Query,content:string,lexical:CfamilySource=cfamilySource(content)):StructureFacts {
 const source=new SourceText(content),regions=objcRegions(content),cpp=extractCfamilyStructure(root,query,'cpp',content);
 const original=originalObjcDeclarations(facts.declarations);
 const intervals=[...regions.regions,...original.filter(f=>['class-forward','class-alias','protocol-forward'].includes(f.kind)).map(f=>({start:f.start,end:f.end}))];
 // Module-import syntax cannot be mistaken for a C++ variable or declaration.
 const {tokens}=lexical;for(let at=0;at<tokens.length-1;at++)if(tokens[at]!.text==='@'&&tokens[at+1]!.text==='import'){const end=tokens.findIndex((t,n)=>n>at&&t.text===';');if(end>=0)intervals.push({start:tokens[at]!.start,end:tokens[end]!.end});}
 const recoveredRegions:NonNullable<NonNullable<NonNullable<StructureFacts['objc']>['cppProfile']>['recoveredRegions']>=[];
 const captured=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='declaration')captured.set(capture.node.id,capture.node);
 if(query.didExceedMatchLimit())cpp.truncated=true;
 const known=new Set(cpp.declarations.map(f=>f.key)),recovered:{start:number;end:number}[]=[];
 for(const node of [...captured.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  if(recovered.some(r=>r.start<=node.startIndex&&r.end>=node.endIndex)||intervals.some(r=>node.startIndex<r.end&&node.endIndex>r.start&&!(node.type==='namespace_definition'&&node.startIndex<r.start&&node.endIndex>=r.end)))continue;
  let damaged=false;for(let parent=node.parent,depth=0;parent&&++depth<=128;parent=parent.parent)if(parent.isError){damaged=true;break;}
  if(!damaged)continue;
  if(recovered.length>=4096){cpp.truncated=true;break;}
  // The subtree is actual original AST syntax, without the surrounding ERROR
  // node. No bytes are rewritten and no synthetic declaration prefix is used.
  const isolated=extractCfamilyStructure(node,query,'cpp',content),reason='Original self-contained C++ AST subtree retained; surrounding parser/macro context remains unverified';
  const owner=cpp.declarations.filter(f=>['namespace','class','struct','union','function','method'].includes(f.kind)&&f.start<node.startIndex&&f.end>=node.endIndex).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  const additions=isolated.declarations.filter(f=>!known.has(f.key)&&!(f.kind==='variable'&&owner&&['function','method'].includes(owner.kind)));if(!additions.length)continue;
  if(owner){const rootFact=additions.find(f=>!f.parent);if(rootFact){const old=rootFact.qualifiedName;rootFact.parent=owner.key;for(const f of additions)if(f.qualifiedName===old||f.qualifiedName.startsWith(`${old}::`))f.qualifiedName=`${owner.qualifiedName}::${f.qualifiedName}`;}}
  for(const f of additions){f.sourceConditions=[...f.sourceConditions??[],reason];cpp.declarations.push(f);known.add(f.key);}
  recovered.push({start:node.startIndex,end:node.endIndex});recoveredRegions.push({range:source.range(Math.min(node.startIndex,content.length),Math.min(node.endIndex,content.length)),reason});
  cpp.truncated||=isolated.truncated||cpp.declarations.length>20_000;if(cpp.declarations.length>20_000){cpp.declarations.length=20_000;break;}
 }
 const native=cpp.declarations.filter(f=>!intervals.some(region=>f.start<region.end&&f.end>region.start&&!(f.kind==='namespace'&&f.start<region.start&&f.end>=region.end)));
 const keys=new Map(native.map(f=>[f.key,`objc-cpp:${f.key}`]));
 const cppDeclarations=native.map(f=>({...f,key:keys.get(f.key)!,...f.parent?{parent:keys.get(f.parent)}:{},sourceConditions:[...f.sourceConditions??[],'Original separate C++ grammar profile; Objective-C/C++ type and translation-unit binding remain unverified']}));
 for(const container of original.filter(f=>objcKinds.has(f.kind)&&!f.parent)){
  const namespace=cppDeclarations.filter(f=>f.kind==='namespace'&&f.start<container.start&&f.end>container.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  if(!namespace)continue;
  const oldName=container.qualifiedName;container.parent=namespace.key;container.qualifiedName=`${namespace.qualifiedName}::${oldName}`;
  for(const child of original)if(child!==container&&child.qualifiedName.startsWith(`${oldName}::`)&&child.start>=container.start&&child.end<=container.end)child.qualifiedName=`${namespace.qualifiedName}::${child.qualifiedName}`;
 }
 facts.declarations=[...original,...cppDeclarations];
 recoverOriginalCppMethods(facts,content,lexical);
 const preprocessor=[...facts.cfamily?.preprocessor??[],...cpp.cfamily?.preprocessor??[]];
 const unique=new Map(preprocessor.map(d=>[`${d.kind}:${d.range.startLine}:${d.range.startColumn}:${d.text}`,d]));
 const reason='Original Objective-C and C++ grammar profiles retain separate source declarations; shared types, macros and cross-language binding remain unverified';
 const issues=[...facts.issues,...cpp.issues,{code:'objc-cpp-structure-gap',reason}];
 facts.truncated||=cpp.truncated||regions.truncated||lexical.truncated||facts.declarations.length>20_000||issues.length>100||unique.size>4096;
 facts.declarations=facts.declarations.sort((a,b)=>a.start-b.start||b.end-a.end||a.key.localeCompare(b.key)).slice(0,20_000);
 facts.issues=issues.slice(0,100);facts.cfamily={preprocessor:[...unique.values()].slice(0,4096),complete:false};
 if(facts.objc){facts.objc.cppProfile={grammar:'cpp',declarations:cppDeclarations.length,methodHeaders:facts.declarations.filter(f=>f.modifiers?.includes('objc-cpp-method-header')).length,...recoveredRegions.length?{recoveredRegions}:{}};facts.objc.complete=false;}
 // Preserve a bounded explicit outcome even if parser recovery filled the list.
 if(!facts.issues.some(i=>i.code==='objc-cpp-structure-gap'))facts.issues[facts.issues.length-1]={code:'objc-cpp-structure-gap',reason};
 if(facts.truncated&&!facts.issues.some(i=>i.code==='syntax-budget-exceeded')){if(facts.issues.length>=100)facts.issues.pop();facts.issues.push({code:'syntax-budget-exceeded',reason:'Mixed Objective-C++ source extraction reached its declaration, syntax, region or diagnostic limit'});}
 return facts;
}

/** A bounded native selector header profile retains raw C++ parameter/return
 * types when the C-based Objective-C grammar cannot represent those types. */
export function recoverOriginalCppMethods(facts:StructureFacts,content:string,lexical:CfamilySource=cfamilySource(content)):void {
 const source=new SourceText(content),{tokens,pairs}=lexical;
 for(const owner of facts.declarations.filter(f=>['class-interface','class-implementation','protocol'].includes(f.kind))){
  let low=0,high=tokens.length;while(low<high){const middle=(low+high)>>>1;if(tokens[middle]!.start<owner.start)low=middle+1;else high=middle;}
  for(let at=low;at<tokens.length&&tokens[at]!.start<owner.end;at++){
   const sign=tokens[at]!;
   if(['{','(','['].includes(sign.text)){const end=pairs.get(at);if(end!==undefined&&end>at)at=end;continue;}
   if(!['+','-'].includes(sign.text)||tokens[at+1]?.text!=='(')continue;
   const returns=pairs.get(at+1);if(returns===undefined||returns===at+2)continue;
   let cursor=returns+1,selector='',name:typeof sign|undefined;
   while(cursor<tokens.length){
    const label=tokens[cursor]!;
    if(sourceIdentifier(label)){name??=label;cursor++;if(tokens[cursor]?.text!==':'){if(!selector)selector=label.text;else selector='';break;}}
    else if(tokens[cursor]?.text!==':')break;
    if(tokens[cursor]?.text!==':')break;
    name??=tokens[cursor];selector+=`${sourceIdentifier(label)?label.text:''}:`;cursor++;
    if(tokens[cursor]?.text==='('){const typeEnd=pairs.get(cursor);if(typeEnd===undefined||typeEnd===cursor+1){selector='';break;}cursor=typeEnd+1;}
    if(!sourceIdentifier(tokens[cursor])){selector='';break;}cursor++;
    if(tokens[cursor]?.text===','){
     if(tokens.slice(cursor+1,cursor+4).map(t=>t.text).join('')!=='...'){selector='';break;}cursor+=4;break;
    }
    if([';','{'].includes(tokens[cursor]?.text??''))break;
   }
   const terminal=tokens[cursor];if(!selector||!name||!terminal||![';','{'].includes(terminal.text))continue;
   const bodyEnd=terminal.text==='{'?pairs.get(cursor):cursor;if(bodyEnd===undefined||tokens[bodyEnd]!.end>owner.end)continue;
   const start=sign.start,end=tokens[bodyEnd]!.end;
   if(facts.declarations.some(f=>f.selector&&f.start===start)){at=bodyEnd;continue;}
   if(facts.declarations.length>=20_000){facts.truncated=true;return;}
   const dispatch=sign.text==='+'?'class':'instance';
   const fact:DeclarationFact={key:`objc-cpp-method:${start}:${end}:${name.start}`,parent:owner.key,name:selector,qualifiedName:`${owner.qualifiedName}::${sign.text}${selector}`,kind:'method',entityType:'method',signature:content.slice(start,terminal.start).replace(/\s+/g,' ').trim().slice(0,1200),range:source.range(start,end),start,end,nameEnd:name.end,selector,dispatch,declarationForm:terminal.text==='{'?'definition':'declaration',modifiers:[dispatch==='class'?'class-method':'instance-method','objc-cpp-method-header'],annotations:['Original Objective-C++ return/parameter type syntax is retained without type binding'],sourceConditions:[...sourceConditions(lexical,start),'Original Objective-C++ selector header profile; C++ type and method-body binding remain unverified']};
   facts.declarations.push(fact);at=bodyEnd;
  }
 }
}
