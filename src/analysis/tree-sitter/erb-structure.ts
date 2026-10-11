import {erbIssue,finishErb} from './template-facts.js';
export {erbIssue,finishErb} from './template-facts.js';
import {extractTemplateHost} from './embedded-host.js';
import type {Node,Query} from 'web-tree-sitter';
import type {DeclarationFact,ErbSyntaxFacts,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_NODES=200_000,MAX_REGIONS=4096,MAX_DECLARATIONS=20_000;
export function selectErbHost(file:string,content:string):{language:ErbSyntaxFacts['host']['language'];reason:'file-extension'|'original-doctype'|'unknown';range?:ReturnType<SourceText['range']>} {
 const lower=file.toLowerCase();
 if(lower.endsWith('.html.erb')||lower.endsWith('.rhtml'))return {language:'html',reason:'file-extension'};
 if(lower.endsWith('.js.erb'))return {language:'javascript',reason:'file-extension'};
 if(lower.endsWith('.css.erb'))return {language:'css',reason:'file-extension'};
 const doctype=/^\s*<!doctype\s+html\s*>/i.exec(content);
 if(doctype)return {language:'html',reason:'original-doctype',range:new SourceText(content).range(doctype[0].indexOf('<'),doctype[0].length)};
 return {language:'unknown',reason:'unknown'};
}
function withinBudget(root:Node):boolean {const pending=[root];let count=0;while(pending.length){const node=pending.pop()!;if(++count>MAX_NODES)return false;for(let i=node.childCount-1;i>=0;i--){const child=node.child(i);if(child)pending.push(child);}}return true;}
/** Native template delimiters first: ERB executes even inside HTML comments,
 * script strings and style text. No ERB compiler, Ruby or target code runs. */
export function extractErbRegions(root:Node,query:Query,content:string,host:ErbSyntaxFacts['host']['language']='unknown'):StructureFacts {
 const source=new SourceText(content),facts:StructureFacts={declarations:[],issues:[],truncated:false,erb:{regions:[],host:{language:host,regions:[],complete:true},rubyComplete:true,complete:true,executionUnverified:true}},syntax=facts.erb!,stack=[root];let nodes=0;
 while(stack.length){const node=stack.pop()!;if(++nodes>MAX_NODES){facts.truncated=true;break;}if(node.isError||node.isMissing){syntax.rubyComplete=false;erbIssue(facts,'erb-parse-error',node.isMissing?`Missing template ${node.type}`:'Native ERB delimiter recovery prevents a qualified Ruby projection',source.range(node.startIndex,node.endIndex));}for(let i=node.childCount-1;i>=0;i--){const child=node.child(i);if(child)stack.push(child);}}
 const selected=new Map<number,Node>();for(const capture of query.captures(root,{matchLimit:4096}))if(capture.name==='region')selected.set(capture.node.id,capture.node);if(query.didExceedMatchLimit())facts.truncated=true;
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex)){
  if(syntax.regions.length===MAX_REGIONS){facts.truncated=true;break;}
  const literal=node.type==='content',nativeOpen=node.children.find(n=>!n.isNamed)?.text??'',nativeClose=node.children.filter(n=>!n.isNamed).at(-1)?.text??'';
  let kind:'literal'|'comment'|'code'|'output'=literal?'literal':node.type==='comment_directive'?'comment':content.startsWith('<%=',node.startIndex)?'output':'code',opening=literal?undefined:kind==='comment'?'<%#':kind==='output'?'<%=':nativeOpen==='<%-'?'<%-':'<%',closing=literal?undefined:nativeClose;
  const conditions:string[]=[],supported=literal||!node.hasError&&['<%','<%=','<%#','<%-','<%graphql'].includes(nativeOpen)&&['%>','-%>'].includes(nativeClose)&&nativeOpen!=='<%==';
  if(!supported){syntax.rubyComplete=false;conditions.push('Nonstandard/invalid template delimiter or engine extension is unqualified');erbIssue(facts,'erb-engine-syntax-gap',conditions[0]!,source.range(node.startIndex,node.endIndex));}
  if(opening==='<%-'||closing==='-%>'){conditions.push('Explicit trim tag retained as original Ruby code; ERB trim mode or Erubi/Rails engine agreement is unverified');erbIssue(facts,'erb-trim-mode-gap',conditions.at(-1)!,source.range(node.startIndex,node.endIndex));}
  const bodyStart=literal?node.startIndex:Math.min(node.endIndex,node.startIndex+opening!.length),bodyEnd=literal?node.endIndex:Math.max(bodyStart,node.endIndex-(closing?.length??0));
  if(!literal&&content.slice(bodyStart,bodyEnd).includes('%%>')){conditions.push('Escaped ERB closing delimiter retained in original spelling; compiled literal agreement is unverified');erbIssue(facts,'erb-escape-gap',conditions.at(-1)!,source.range(bodyStart,bodyEnd));}
  if(literal){const original=content.slice(node.startIndex,node.endIndex);for(const match of original.matchAll(/^%[^%\r\n]/gm)){if(match.index===0&&node.startIndex&& !/[\r\n]/.test(content[node.startIndex-1]!))continue;syntax.rubyComplete=false;erbIssue(facts,'erb-percent-mode-gap','Literal line could be Ruby under percent-line trim mode; unknown compiler options quarantine Ruby declarations',source.range(node.startIndex+match.index,node.startIndex+match.index+1));}}
  syntax.regions.push({key:`${kind}:${syntax.regions.length}`,kind,start:node.startIndex,end:node.endIndex,range:source.range(node.startIndex,node.endIndex),bodyStart,bodyEnd,bodyRange:source.range(bodyStart,bodyEnd),...opening?{opening,closing}:{},executionContext:kind==='code'||kind==='output'?'server':'none',supported,conditions});
 }
 return facts;
}
/** Only original Ruby bytes enter the projection. Whitespace preserves UTF-16
 * offsets and original newlines. Delimiter semicolons separate source statements,
 * matching ERB's command joining without generating output calls or declarations.
 * This projection is syntax input, never an ERB compilation or execution proof. */
export function erbRubyProjection(content:string,facts:StructureFacts):string|undefined {
 if(!facts.erb!.rubyComplete||facts.truncated)return;
 const chars=content.split('').map(c=>/[\r\n]/.test(c)?c:' ');
 for(const region of facts.erb!.regions)if(region.kind==='code'||region.kind==='output'){
  for(let at=region.bodyStart;at<region.bodyEnd;at++)chars[at]=content[at]!;
  if(region.closing&&region.bodyEnd<chars.length)chars[region.bodyEnd]=';';
 }
 return chars.join('');
}
export function erbHostProjection(content:string,facts:StructureFacts):string {
 const chars=content.split('');for(const region of facts.erb!.regions)if(region.kind!=='literal')for(let at=region.start;at<region.end;at++)if(!/[\r\n]/.test(chars[at]!))chars[at]=' ';return chars.join('');
}
export function extractErbRuby(root:Node,query:Query,content:string,facts:StructureFacts):void {
 const source=new SourceText(content),regions=facts.erb!.regions.filter(r=>r.kind==='code'||r.kind==='output');
 if(!withinBudget(root)){facts.truncated=true;facts.erb!.rubyComplete=false;return;}
 if(root.hasError){facts.erb!.rubyComplete=false;erbIssue(facts,'erb-ruby-projection-gap','Original Ruby regions have invalid/unsupported syntax or require engine-generated context; declarations are quarantined rather than assigned uncertain owners');return;}
 const selected:{node:Node;name:Node;kind:string}[]=[];for(const match of query.matches(root,{matchLimit:4096})){const definition=match.captures.find(c=>c.name.startsWith('declaration.')),name=match.captures.find(c=>c.name==='name')?.node;if(definition&&name){if(selected.length===MAX_DECLARATIONS){facts.truncated=true;break;}selected.push({node:definition.node,name,kind:definition.name.slice('declaration.'.length)});}}if(query.didExceedMatchLimit())facts.truncated=true;
 const byNode=new Map<number,DeclarationFact>(),unsafe=new Set<number>();
 for(const {node,name,kind} of selected.sort((a,b)=>a.node.startIndex-b.node.startIndex||b.node.endIndex-a.node.endIndex)){
  let parent:DeclarationFact|undefined,depth=0,blocked=false;for(let p=node.parent;p;p=p.parent){if(unsafe.has(p.id)){blocked=true;break;}if(++depth>128){facts.truncated=true;blocked=true;break;}parent=byNode.get(p.id);if(parent)break;}if(blocked){unsafe.add(node.id);continue;}
  const params=node.childForFieldName('parameters'),superclass=node.childForFieldName('superclass'),headerEnd=params?.endIndex??superclass?.endIndex??name.endIndex,headerRegion=regions.find(r=>r.bodyStart<=node.startIndex&&r.bodyEnd>=headerEnd);
  if(!headerRegion||name.hasError||name.isMissing||content.slice(name.startIndex,name.endIndex)!==name.text||headerEnd-node.startIndex>1200){unsafe.add(node.id);facts.erb!.rubyComplete=false;erbIssue(facts,'erb-original-header-gap','Native Ruby declaration header/name is not wholly inside one bounded original ERB code region',source.range(node.startIndex,Math.min(headerEnd,content.length)));continue;}
  const parts=regions.filter(r=>r.bodyStart<node.endIndex&&r.bodyEnd>node.startIndex),conditions=['Original ERB source declaration; Ruby engine/runtime owner, view binding and output compilation are unverified',...parts.flatMap(r=>r.conditions)];if(parts.length>1)conditions.push('Original declaration spans template regions; literal markup and generated output calls are excluded from the Ruby projection');
  const fact:DeclarationFact={key:`erb-ruby:${node.startIndex}:${node.endIndex}:${kind}`,name:name.text,qualifiedName:[parent?.qualifiedName,name.text].filter(Boolean).join('::'),kind,entityType:kind==='method'?'method':'class',signature:content.slice(node.startIndex,headerEnd).trim(),start:node.startIndex,end:node.endIndex,nameEnd:name.endIndex,range:source.range(node.startIndex,node.endIndex),declarationForm:'definition',sourceConditions:[...new Set(conditions)],embeddedSource:{language:'ruby',executionContext:'server',headerRange:source.range(node.startIndex,headerEnd),regions:parts.map(r=>source.range(Math.max(node.startIndex,r.bodyStart),Math.min(node.endIndex,r.bodyEnd)))},...parent?{parent:parent.key}:{}};
  if(node.type==='singleton_method')fact.sourceConditions!.push('Original singleton receiver header retained; receiver/dispatch binding is unverified');facts.declarations.push(fact);byNode.set(node.id,fact);
 }
}
export function extractErbHost(root:Node,query:Query,content:string,facts:StructureFacts):void {extractTemplateHost(root,query,content,facts,'erb');}
