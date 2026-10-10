import type {Parser,Query} from 'web-tree-sitter';
import type {StructureFacts} from '../facts.js';
import type {SourceRange} from '../../core/graph.js';
import {SourceText} from '../source-map.js';
import {extractObjcStructure} from './objc-structure.js';

interface Token {text:string;start:number;end:number}
const MAX_TOKENS=200_000,MAX_REGIONS=4096;
/** Discover original @interface/@implementation/@protocol regions. Comments,
 * literals, raw C++ strings and physical preprocessor lines cannot introduce
 * a declaration. No source is rewritten, prefixed or expanded. */
export function objcRegions(content:string):{regions:{start:number;end:number}[];truncated:boolean} {
 const tokens:Token[]=[],identifier=/[\p{ID_Start}_$][\p{ID_Continue}$]*/uy;
 let index=0,truncated=false;
 while(index<content.length){
  if(tokens.length>=MAX_TOKENS){truncated=true;break;}
  const char=content[index]!;
  if(/\s/.test(char)){index++;continue;}
  if(content.startsWith('//',index)){const end=content.indexOf('\n',index+2);index=end<0?content.length:end+1;continue;}
  if(content.startsWith('/*',index)){const end=content.indexOf('*/',index+2);index=end<0?content.length:end+2;continue;}
  if(char==='#'&&(!tokens.length||tokens.at(-1)!.end<=content.lastIndexOf('\n',index-1)+1)){
   let end=index;do{const next=content.indexOf('\n',end);if(next<0){end=content.length;break;}end=next+1;}while(/\\\r?\n$/.test(content.slice(index,end)));index=end;continue;
  }
  const raw=/^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(content.slice(index));
  if(raw){const end=content.indexOf(`)${raw[1]}"`,index+raw[0].length);index=end<0?content.length:end+raw[1]!.length+2;continue;}
  if(char==='"'||char==="'"){const quote=char;index++;while(index<content.length){if(content[index]==='\\')index+=2;else if(content[index++]===quote)break;}continue;}
  identifier.lastIndex=index;const match=identifier.exec(content);
  if(match){tokens.push({text:match[0],start:index,end:identifier.lastIndex});index=identifier.lastIndex;}
  else {tokens.push({text:char,start:index,end:index+1});index++;}
 }
 const regions:{start:number;end:number}[]=[],stack:number[]=[];
 for(let item=0;item<tokens.length-1;item++){
  if(tokens[item]!.text!=='@'||tokens[item]!.end!==tokens[item+1]!.start)continue;
  const kind=tokens[item+1]!.text;
  if(['interface','implementation','protocol'].includes(kind)&&tokens[item+2]&&/^[\p{ID_Start}_$]/u.test(tokens[item+2]!.text)){
   if(kind==='protocol'&&[',',';'].includes(tokens[item+3]?.text??''))continue;
   stack.push(tokens[item]!.start);
  }else if(kind==='end'&&stack.length){const start=stack.pop()!;if(!stack.length){if(regions.length>=MAX_REGIONS){truncated=true;break;}regions.push({start,end:tokens[item+1]!.end});}}
 }
 return {regions,truncated};
}

/** Recover only containers missing from the full-file parse, by parsing exact
 * self-contained original slices. Surrounding macro/context uncertainty remains
 * partial and visible; no generated declarations or compiler binding is claimed. */
export function recoverObjcRegions(facts:StructureFacts,content:string,parser:Parser,query:Query):StructureFacts {
 if(!facts.issues.length&&!facts.truncated)return facts;
 const discovered=objcRegions(content),source=new SourceText(content);
 let result=facts;
 for(const region of discovered.regions){
  if(result.declarations.some(fact=>['class-interface','class-implementation','protocol'].includes(fact.kind)&&fact.start<=region.start&&fact.end>=region.end))continue;
  parser.reset();const tree=parser.parse(content.slice(region.start,region.end));if(!tree)continue;
  try {
   const recovered=extractObjcStructure(tree.rootNode,query,content.slice(region.start,region.end));
   if(!recovered.declarations.some(fact=>['class-interface','class-implementation','protocol'].includes(fact.kind))){result.declarations=result.declarations.filter(fact=>fact.end<=region.start||fact.start>=region.end);continue;}
   const prefix=`objc-region:${region.start}:`,keys=new Map(recovered.declarations.map(fact=>[fact.key,prefix+fact.key]));
   const reason='Original self-contained Objective-C region recovered; surrounding annotation/macro syntax remains unexpanded and requires source-context qualification';
   const context=facts.cfamily?.preprocessor.filter(item=>['preproc_if','preproc_ifdef','preproc_elif','preproc_elifdef','preproc_else'].includes(item.kind)&&item.range.startLine<=source.range(region.start,region.start).startLine&&item.range.endLine>=source.range(region.end,region.end).endLine).map(item=>item.text)??[];
   const declarations=recovered.declarations.map(fact=>({...fact,key:keys.get(fact.key)!,...fact.parent?{parent:keys.get(fact.parent)!}:{},start:fact.start+region.start,end:fact.end+region.start,nameEnd:fact.nameEnd+region.start,range:source.range(fact.start+region.start,fact.end+region.start),sourceConditions:[...context,...fact.sourceConditions??[],reason]}));
   const starts=[0];const text=content.slice(region.start,region.end);for(let at=0;at<text.length;at++)if(text[at]==='\n')starts.push(at+1);
   const offsetRange=(range:SourceRange)=>{
    if(range.startColumn===undefined||range.endColumn===undefined)throw new Error('Original Objective-C region range is missing its parser columns');
    return source.range(region.start+starts[range.startLine-1]!+range.startColumn-1,region.start+starts[range.endLine-1]!+range.endColumn-1);
   };
   const existing=result.declarations.filter(fact=>fact.end<=region.start||fact.start>=region.end);
   const combined=[...existing,...declarations].sort((a,b)=>a.start-b.start||b.end-a.end);
   const issues=[...result.issues,...recovered.issues.map(issue=>({...issue,...issue.range?{range:offsetRange(issue.range)}:{}})),{code:'syntax-source-context-gap',reason,range:source.range(region.start,region.end)}];
   const propertyImplementations=[...result.objc?.propertyImplementations??[],...recovered.objc!.propertyImplementations.map(item=>({...item,range:offsetRange(item.range)}))],moduleImports=[...result.objc?.moduleImports??[],...recovered.objc!.moduleImports.map(item=>({...item,range:offsetRange(item.range)}))];
   result={...result,declarations:combined.slice(0,20_000),truncated:result.truncated||recovered.truncated||combined.length>20_000||issues.length>100||propertyImplementations.length>4096||moduleImports.length>4096,issues:issues.slice(0,100),cfamily:result.cfamily?{...result.cfamily,complete:false}:undefined,objc:{propertyImplementations:propertyImplementations.slice(0,4096),moduleImports:moduleImports.slice(0,4096),isolatedRegions:[...result.objc?.isolatedRegions??[],{range:source.range(region.start,region.end),reason}],complete:false}};
  }finally{tree.delete();}
 }
 if(discovered.truncated||result.truncated){result.truncated=true;if(!result.issues.some(issue=>issue.code==='syntax-budget-exceeded')){if(result.issues.length===100)result.issues.pop();result.issues.push({code:'syntax-budget-exceeded',reason:'Objective-C source recovery reached its token, region, declaration, metadata or diagnostic limit'});}if(result.objc)result.objc.complete=false;if(result.cfamily)result.cfamily.complete=false;}
 return result;
}
