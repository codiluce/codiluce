import type {DeclarationFact,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';
import {cfamilySource,sourceConditions,sourceIdentifier,type CfamilySource} from './cfamily-source.js';

const profiles=new Set(['NS_ENUM','NS_CLOSED_ENUM','NS_OPTIONS','CF_ENUM','CF_CLOSED_ENUM','CF_OPTIONS']);
const compact=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,1200);
/** Interpret only reviewed original enum/options declaration spelling. This is
 * not macro expansion: values, SDK types, overrides and ABI remain unknown. */
export function extractObjcMacroProfiles(facts:StructureFacts,content:string,lexical:CfamilySource=cfamilySource(content)):StructureFacts {
 const {tokens,pairs,directives}=lexical,source=new SourceText(content);
 const overridden=new Set(directives.map(d=>/^#\s*(?:define|undef)\s+([\w$]+)/.exec(d.text.replace(/\\\r?\n/g,' ').replace(/\/\*[\s\S]*?\*\//g,' '))?.[1]).filter((name):name is string=>!!name));
 const metadata:NonNullable<NonNullable<StructureFacts['objc']>['enumProfiles']>=[];
 const issue=(reason:string,start:number,end:number)=>{if(facts.issues.length<100)facts.issues.push({code:'objc-macro-profile-gap',reason,range:source.range(start,end)});else facts.truncated=true;};
 if(lexical.truncated){
  facts.truncated=true;if(facts.objc)facts.objc.complete=false;if(facts.cfamily)facts.cfamily.complete=false;
  if(!facts.issues.some(i=>i.code==='syntax-budget-exceeded')){if(facts.issues.length>=100)facts.issues.pop();facts.issues.push({code:'syntax-budget-exceeded',reason:'Original source exceeds token/directive/context bounds; standard macro profiles cannot be certified'});}
  return facts;
 }
 for(let at=0;at<tokens.length-4;at++){
  if(tokens[at]!.text!=='typedef'||!profiles.has(tokens[at+1]!.text)||tokens[at+2]!.text!=='(')continue;
  const begin=tokens[at]!,macro=tokens[at+1]!.text,close=pairs.get(at+2);if(close===undefined)continue;
  const open=close+1,end=pairs.get(open);if(tokens[open]?.text!=='{'||end===undefined||tokens[end+1]?.text!==';'){issue(`Original ${macro} requires a complete literal enum body and semicolon`,begin.start,tokens[close]!.end);continue;}
  const finish=tokens[end+1]!.end;
  // Discard fallback C declarations inside this unsupported macro spelling.
  facts.declarations=facts.declarations.filter(f=>f.end<=begin.start||f.start>=finish||f.start<begin.start&&f.end>finish);
  if(overridden.has(macro)){issue(`Original ${macro} is defined/undefined in this source; the standard SDK profile cannot certify its declarations`,begin.start,finish);at=end+1;continue;}
  const commas:number[]=[];for(let n=at+3;n<close;n++){const pair=pairs.get(n);if(pair!==undefined&&pair>n){n=pair;continue;}if(tokens[n]!.text===',')commas.push(n);}
  const separator=commas[0],name=separator===undefined?undefined:tokens[separator+1];
  if(commas.length!==1||separator===undefined||!sourceIdentifier(name)||separator+2!==close||separator===at+3){issue(`Original ${macro} requires two literal arguments with one explicit type name`,begin.start,finish);at=end+1;continue;}
  const underlying=content.slice(tokens[at+3]!.start,tokens[separator-1]!.end);
  const reason=`Original ${macro} enum/options source profile; macro expansion, SDK type/ABI and numeric values remain unverified`;
  const conditions=[...sourceConditions(lexical,begin.start),reason];
  const owner=facts.declarations.filter(f=>f.start<begin.start&&f.end>=finish).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  const key=`objc-enum:${begin.start}:${finish}:${name.start}`;
  const type:DeclarationFact={key,name:name.text,qualifiedName:[owner?.qualifiedName,name.text].filter(Boolean).join('::'),kind:'type',entityType:'class',signature:compact(content.slice(begin.start,tokens[open]!.start)),range:source.range(begin.start,finish),start:begin.start,end:finish,nameEnd:name.end,declarationForm:'declaration',annotations:[`Original macro: ${macro}`,`Original underlying type syntax: ${underlying}`],sourceConditions:conditions,...owner?{parent:owner.key}:{}};
  if(facts.declarations.length>=20_000||metadata.length>=4096){facts.truncated=true;break;}
  facts.declarations.push(type);metadata.push({macro,name:name.text,underlyingType:underlying,range:type.range});
  let memberStart=open+1;
  const addMember=(last:number)=>{
   if(last<=memberStart)return;
   const first=tokens[memberStart]!;
   if(!sourceIdentifier(first)||(last>memberStart+1&&tokens[memberStart+1]!.text!=='=')||(tokens[memberStart+1]?.text==='='&&last===memberStart+2)){issue(`Original ${macro} member requires an explicit identifier and optional original initializer; no declaration is guessed`,first.start,tokens[last-1]!.end);return;}
   if(facts.declarations.length>=20_000){facts.truncated=true;return;}
   const memberEnd=tokens[last-1]!.end;
   facts.declarations.push({key:`${key}:member:${first.start}`,parent:key,name:first.text,qualifiedName:`${type.qualifiedName}::${first.text}`,kind:'enum-member',entityType:'class',signature:compact(content.slice(first.start,memberEnd)),range:source.range(first.start,memberEnd),start:first.start,end:memberEnd,nameEnd:first.end,declarationForm:'definition',sourceConditions:[...sourceConditions(lexical,first.start),reason]});
  };
  for(let n=open+1;n<end;n++){const pair=pairs.get(n);if(pair!==undefined&&pair>n){n=pair;continue;}if(tokens[n]!.text===','){addMember(n);memberStart=n+1;}}
  addMember(end);issue(reason,begin.start,finish);at=end+1;
 }
 if(metadata.length&&facts.objc)facts.objc.enumProfiles=metadata;
 if(lexical.truncated)facts.truncated=true;
 if(facts.truncated&&!facts.issues.some(i=>i.code==='syntax-budget-exceeded')){if(facts.issues.length>=100)facts.issues.pop();facts.issues.push({code:'syntax-budget-exceeded',reason:'Original Objective-C macro profiles reached the source-token, directive, declaration, metadata or diagnostic limit'});}
 facts.declarations.sort((a,b)=>a.start-b.start||b.end-a.end||a.key.localeCompare(b.key));
 if(facts.objc)facts.objc.complete=!facts.truncated&&!facts.issues.length;
 if(facts.cfamily)facts.cfamily.complete=!facts.truncated&&!facts.issues.length;
 return facts;
}
