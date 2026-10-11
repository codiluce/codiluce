import type {Node,Query} from 'web-tree-sitter';
import type {AnalysisContext,ScannedFile} from '../../core/analyzer.js';
import type {LiquidRegion,LiquidSyntaxFacts,StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';
import path from 'node:path';

const CONTROLS=new Set(['if_statement','unless_statement','case_statement','for_loop_statement','capture_statement','tablerow_statement','form_statement','paginate_statement']);
const OPAQUE=new Set(['comment','doc','raw_statement','javascript_statement','stylesheet_statement','schema_statement']);
/** Engine evidence comes from the indexed application, never from a matching
 * tag spelling alone. A configured Shopify assumption is recorded explicitly. */
export function selectLiquidProfile(context:AnalysisContext,file:ScannedFile,content:string):{host:LiquidSyntaxFacts['host']['language'];engine:LiquidSyntaxFacts['engine'];root?:string;reason:string;bodyTags:boolean;lookup:boolean} {
 const lower=file.path.toLowerCase(),app=file.application,engine=app?.frameworks.includes('shopify-theme')?'shopify':'unknown';
 const relative=app?path.posix.relative(app.path,file.path):file.path;
 const reason=engine==='shopify'?'Indexed/configured Shopify application boundary; engine version and rendered execution remain unverified':'No qualified Liquid engine/application boundary';
 let host:LiquidSyntaxFacts['host']['language']='unknown';
 if(lower.endsWith('.js.liquid'))host='javascript';
 else if(lower.endsWith('.css.liquid'))host='css';
 else if(lower.endsWith('.html.liquid')||/^\s*<!doctype\s+html\s*>/i.test(content))host='html';
 else if(engine==='shopify'&&/^(?:layout|templates|sections|snippets|blocks)\//.test(relative)&&!/[.](?:json|xml|md|scss|sass)[.]liquid$/i.test(relative))host='html';
 const lookup=/^(?:layout|templates|sections|snippets|blocks)\/.+[.]liquid$/.test(relative)&&!/[.](?:js|css|json|xml|md|scss|sass)[.]liquid$/i.test(relative),bodyTags=/^(?:sections|snippets|blocks)\/[^/]+[.]liquid$/.test(relative)&&lookup;
 return {host,engine,bodyTags,lookup,...app&&engine==='shopify'?{root:app.path}:{},reason};
}
export function liquidIssue(facts:StructureFacts,code:string,reason:string,start?:number,end?:number,content?:string):void {
 if(facts.issues.length<100)facts.issues.push({code,reason,...start!==undefined&&content!==undefined?{range:new SourceText(content).range(start,end??start)}:{}});else facts.truncated=true;
}
export function finishLiquid(facts:StructureFacts):StructureFacts {
 const syntax=facts.liquid!;
 if(facts.truncated){syntax.host.complete=false;syntax.nativeComplete=false;if(!facts.issues.some(i=>i.code==='liquid-budget-exceeded')){if(facts.issues.length===100)facts.issues.pop();facts.issues.push({code:'liquid-budget-exceeded',reason:'Original Liquid extraction reached its node, depth, region, binding, import, diagnostic or query budget'});}}
 syntax.complete=!facts.truncated&&!facts.issues.length&&syntax.nativeComplete&&syntax.host.complete;return facts;
}
/** Tag delimiters are native children. Derive body bounds from those original
 * children rather than the scanner's occasionally empty raw_content node. */
export function extractLiquid(root:Node,query:Query,content:string,host:LiquidSyntaxFacts['host']['language']='unknown',engine:LiquidSyntaxFacts['engine']='unknown'):StructureFacts {
 const source=new SourceText(content),facts:StructureFacts={declarations:[],issues:[],truncated:false,liquid:{regions:[],imports:[],bindings:[],host:{language:host,regions:[],complete:true},engine,nativeComplete:true,complete:true,executionUnverified:true}},syntax=facts.liquid!;
 const selected=new Map<number,Node>(),imports:Node[]=[],bindings:Node[]=[];
 const recoveries:Node[]=[];const stack=[{node:root,depth:0}];let count=0;
 if(host==='javascript'||host==='css'){syntax.host.complete=false;liquidIssue(facts,'liquid-host-language-gap','Original non-HTML asset template regions are retained; whole JS/CSS asset processors and rendered equivalence remain unqualified');}
 // Check bounds before query traversal, which cannot yield back to JavaScript.
 while(stack.length){const {node,depth}=stack.pop()!;if(++count>200_000||depth>128){facts.truncated=true;return finishLiquid(facts);}if(node.isError||node.isMissing){recoveries.push(node);syntax.nativeComplete=false;liquidIssue(facts,'liquid-parse-gap','Native Liquid recovery/missing syntax leaves engine/body ownership unqualified',node.startIndex,Math.min(node.endIndex,content.length),content);}const previous=node.previousSibling,recoveredRenderOperand=previous?.isError&&previous.text.trim()==='render'&&/^[ \t]*$/.test(content.slice(previous.endIndex,node.startIndex));if(node.type==='custom_unpaired_statement'&&!recoveredRenderOperand){syntax.nativeComplete=false;liquidIssue(facts,'liquid-custom-tag-gap','Custom engine tags have unqualified block/output semantics; host declarations and template lookup are quarantined',node.startIndex,node.endIndex,content);}if(node.type==='doc'&&engine!=='shopify'){syntax.nativeComplete=false;liquidIssue(facts,'liquid-doc-engine-gap','Non-rendered doc bodies require a qualified Shopify engine profile',node.startIndex,node.endIndex,content);}if(node.type==='raw_statement'&&node.namedChildren.some(n=>n.type==='raw_statement')){syntax.nativeComplete=false;liquidIssue(facts,'liquid-raw-nesting-gap','Native nested raw blocks do not establish agreement with engine endraw semantics',node.startIndex,node.endIndex,content);}if(OPAQUE.has(node.type)){if(node.hasError){const completeDoc=node.type==='doc'&&node.children.filter(c=>!c.isNamed&&c.text.includes('{%')).length===2&&node.children.some(c=>!c.isNamed&&c.text.trim()==='enddoc');if(!completeDoc){syntax.nativeComplete=false;recoveries.push(node);}liquidIssue(facts,completeDoc?'liquid-doc-body-gap':'liquid-opaque-recovery-gap','Original opaque block delimiters are incomplete or recovered',node.startIndex,node.endIndex,content);}continue;}for(let i=node.childCount-1;i>=0;i--){const child=node.child(i);if(child)stack.push({node:child,depth:depth+1});}}
 for(const capture of query.captures(root,{matchLimit:4096})){if(capture.name==='region')selected.set(capture.node.id,capture.node);else if(capture.name==='import')imports.push(capture.node);else if(capture.name==='binding')bindings.push(capture.node);if(selected.size+imports.length+bindings.length>20_000){facts.truncated=true;return finishLiquid(facts);}}
 if(query.didExceedMatchLimit()){facts.truncated=true;return finishLiquid(facts);}
 const add=(kind:LiquidRegion['kind'],node:Node,start=node.startIndex,end=node.endIndex,bodyStart=start,bodyEnd=end,supported=!node.hasError,conditions:string[]=[])=>{
  if(syntax.regions.length>=4096){facts.truncated=true;return;}
  syntax.regions.push({key:`${kind}:${start}:${end}`,kind,nativeKind:node.type,start,end,range:source.range(start,end),bodyStart,bodyEnd,bodyRange:source.range(bodyStart,bodyEnd),supported,conditions});
 };
 for(const node of recoveries)add('recovery',node);
 const opaque=[...selected.values()].filter(n=>OPAQUE.has(n.type));
 const excluded=(node:Node)=>opaque.some(p=>p.id!==node.id&&p.startIndex<=node.startIndex&&p.endIndex>=node.endIndex);
 for(const node of [...selected.values()].sort((a,b)=>a.startIndex-b.startIndex||b.endIndex-a.endIndex)){
  if(excluded(node))continue;
  if(node.type==='template_content'){const ambiguous=/\{[{%]/.test(node.text);add('literal',node,node.startIndex,node.endIndex,node.startIndex,node.endIndex,!ambiguous);if(ambiguous){syntax.nativeComplete=false;liquidIssue(facts,'liquid-literal-delimiter-gap','Native literal text contains a Liquid opening marker; escaped/triple delimiters require an engine-qualified raw context and host declarations are quarantined',node.startIndex,node.endIndex,content);}continue;}
  if(node.type==='front_matter'){add('front-matter',node);liquidIssue(facts,'liquid-front-matter-gap','Original front matter is retained; Jekyll/data-engine evaluation and template lookup are unqualified',node.startIndex,node.endIndex,content);continue;}
  const opens=node.children.filter(n=>!n.isNamed&&n.text.includes('{%')),closes=node.children.filter(n=>!n.isNamed&&n.text.includes('%}'));
  const firstOpen=opens[0],lastOpen=opens.at(-1),start=firstOpen?firstOpen.startIndex+firstOpen.text.indexOf('{%'):node.startIndex;
  const bodyStart=closes[0]?.endIndex??node.startIndex,bodyEnd=lastOpen?lastOpen.startIndex+lastOpen.text.indexOf('{%'):node.endIndex;
  let kind:LiquidRegion['kind']=CONTROLS.has(node.type)?'control':node.type==='comment'?'comment':node.type==='doc'?'doc':node.type==='raw_statement'?'raw':node.type.replace(/_statement$/,'') as LiquidRegion['kind'];
  const conditions=['Original Liquid source; engine/render/runtime execution is unverified'];
  if(kind==='raw')conditions.push('Raw content remains original literal bytes; native raw_content coordinates are not used');
  if(['javascript','stylesheet','schema','style'].includes(kind))conditions.push('Shopify-specific body semantics require an indexed/configured Shopify application');
  // Inline comments and untagged multiline controls have no block body.
  const paired=opens.length>=2&&closes.length>=2;
  add(kind,node,start,node.endIndex,paired?bodyStart:node.startIndex,paired?Math.max(bodyStart,bodyEnd):node.endIndex,!node.hasError,conditions);
 }
 // Capture native tagged/output sibling pairs at every nonopaque level. This
 // also retains opening/closing control tags and the enclosing {% liquid %}.
 const pending=[root];
 while(pending.length&&!facts.truncated){const node=pending.pop()!;if(OPAQUE.has(node.type))continue;
  const children=node.children;
  for(let i=0;i<children.length;i++){const open=children[i]!,match=/(\{%|\{\{)/.exec(open.text);if(open.isNamed||!match)continue;const delimiter=match[1]!,closeSpelling=delimiter==='{%'?'%}':'}}';let j=i+1;while(j<children.length&&!(!children[j]!.isNamed&&children[j]!.text.includes(closeSpelling)))j++;if(j===children.length)continue;
   const close=children[j]!,start=open.startIndex+match.index,end=close.endIndex,bodyStart=open.endIndex,bodyEnd=close.startIndex;
   add(delimiter==='{%'?'tag':'output',node,start,end,bodyStart,bodyEnd,!children.slice(i,j+1).some(n=>n.hasError));i=j;
  }
  for(let i=node.namedChildCount-1;i>=0;i--){const child=node.namedChild(i);if(child)pending.push(child);}
 }
 for(const node of imports.sort((a,b)=>a.startIndex-b.startIndex)){
  if(excluded(node)||OPAQUE.has(node.type))continue;if(syntax.imports.length>=4096){facts.truncated=true;break;}
  const kind=node.children.find(n=>!n.isNamed)?.text.trim() as LiquidSyntaxFacts['imports'][number]['kind'],literal=node.childForFieldName('file')??node.namedChildren.find(n=>n.type==='string'),raw=literal?.text,quoted=raw&&/^(['"])[^\r\n]*\1$/.test(raw),specifier=quoted?raw.slice(1,-1):undefined;
  const conditions=['Source template dependency only; rendering, parameter binding and runtime activation are unverified'];
  for(let parent=node.parent;parent;parent=parent.parent)if(CONTROLS.has(parent.type))conditions.push(`Original ${parent.type} at line ${source.range(parent.startIndex,parent.endIndex).startLine}; conditional rendering and variable scopes are unverified`);
  const supported=syntax.nativeComplete&&!node.hasError&&!!specifier;
  if(!supported)conditions.push('A complete native source context and original quoted literal filename are required');
  syntax.imports.push({kind,text:content.slice(node.startIndex,node.endIndex),...specifier!==undefined?{specifier}:{},start:node.startIndex,end:node.endIndex,range:source.range(node.startIndex,node.endIndex),supported,conditions});
 }
 // Missing/dynamic tag shapes retain an explicit unsupported dependency site.
 for(const region of syntax.regions.filter(r=>r.kind==='tag')){
  const text=content.slice(region.bodyStart,region.bodyEnd).trim(),kind=/^(render|include_relative|include|section|sections|layout)\b/.exec(text)?.[1] as LiquidSyntaxFacts['imports'][number]['kind']|undefined;
  if(!kind||syntax.imports.some(i=>i.start>=region.bodyStart&&i.end<=region.bodyEnd))continue;
  if(syntax.imports.length>=4096){facts.truncated=true;break;}
  syntax.imports.push({kind,text,start:region.bodyStart,end:region.bodyEnd,range:source.range(region.bodyStart,region.bodyEnd),supported:false,conditions:['Native tag retained, but original dependency statement was recovered or outside the qualified literal syntax profile']});
 }
 syntax.imports.sort((a,b)=>a.start-b.start);
 for(const node of bindings.sort((a,b)=>a.startIndex-b.startIndex)){
  if(excluded(node)||node.hasError)continue;if(syntax.bindings.length>=4096){facts.truncated=true;break;}
  const name=node.childForFieldName('variable_name')??node.childForFieldName('item')??node.namedChildren.find(n=>n.type==='identifier');if(!name)continue;
  syntax.bindings.push({name:name.text,kind:node.type,range:source.range(node.startIndex,node.endIndex),nameRange:source.range(name.startIndex,name.endIndex)});
 }
 syntax.regions.sort((a,b)=>a.start-b.start||b.end-a.end||a.kind.localeCompare(b.kind,'en'));
 if(!syntax.nativeComplete)syntax.host.complete=false;
 return finishLiquid(facts);
}
export function liquidHostProjection(content:string,facts:StructureFacts):string {
 const syntax=facts.liquid!,chars=content.split('').map(c=>/[\r\n]/.test(c)?c:' ');
 if(facts.truncated||!syntax.nativeComplete)return chars.join('');
 // Native literal regions and native raw-body hulls are the only HTML bytes.
 for(const r of syntax.regions)if(r.kind==='literal'||r.kind==='raw')for(let i=r.kind==='raw'?r.bodyStart:r.start;i<(r.kind==='raw'?r.bodyEnd:r.end);i++)chars[i]=content[i]!;
 // Exclude opaque/non-rendered bodies and all dynamic delimiters.
 for(const r of syntax.regions)if(['comment','doc','schema','javascript','stylesheet','style','front-matter','tag','output'].includes(r.kind))for(let i=r.start;i<r.end;i++)if(!/[\r\n]/.test(chars[i]!))chars[i]=' ';
 return chars.join('');
}
/** Shopify JavaScript/styles remain original source bodies, with no generated
 * bundle or render helper. Unknown engines retain these regions as gaps. */
export function extractLiquidBodyHosts(content:string,facts:StructureFacts,bodyTags=true):void {
 const syntax=facts.liquid!;if(facts.truncated)return;
 const javascriptBlocks=syntax.regions.filter(r=>r.kind==='javascript'),stylesheetBlocks=syntax.regions.filter(r=>r.kind==='stylesheet');if(syntax.engine==='shopify'&&(javascriptBlocks.length>1||stylesheetBlocks.length>1))liquidIssue(facts,'liquid-body-count-gap','Multiple original JavaScript/stylesheet blocks exceed the Shopify one-block-per-kind/source contract; only independent original source syntax is retained');
 for(const r of syntax.regions.filter(r=>['javascript','stylesheet','style'].includes(r.kind))){
  const dynamicStyle=r.kind==='style'&&(/\{[{%]/.test(content.slice(r.bodyStart,r.bodyEnd))||syntax.regions.some(c=>c!==r&&c.kind!=='literal'&&c.start>=r.bodyStart&&c.end<=r.bodyEnd));
  const recovered=syntax.regions.some(c=>c.kind==='recovery'&&c.start<r.end&&c.end>r.start)||facts.issues.some(i=>['liquid-custom-tag-gap','liquid-raw-nesting-gap'].includes(i.code));
  const supported=(r.kind==='style'?syntax.host.language==='html':bodyTags)&&!recovered&&!dynamicStyle&&syntax.engine==='shopify'&&r.supported&&r.bodyStart>r.start&&r.bodyEnd<r.end&&!syntax.regions.some(c=>c.kind==='control'&&c.start<=r.start&&c.end>=r.end);
  if(!supported){syntax.host.complete=false;liquidIssue(facts,'liquid-body-engine-gap','Source body requires a complete original Shopify block and unambiguous application/control context; interpolated style output is unqualified',r.start,r.end,content);}
  const javascript=r.kind==='javascript';syntax.host.regions.push({kind:javascript?'script':'style',start:r.start,end:r.end,range:r.range,bodyStart:r.bodyStart,bodyEnd:r.bodyEnd,bodyRange:r.bodyRange,attributes:[],executionContext:javascript?'browser':'none',language:javascript?'javascript':'css',supported,conditions:[...r.conditions,...(javascript?javascriptBlocks.length>1:r.kind==='stylesheet'&&stylesheetBlocks.length>1)?['Multiple body blocks; engine bundle/runtime placement is unqualified']:[],'Original Shopify body syntax only; bundle placement and runtime execution remain unverified']});
 }
 syntax.host.regions.sort((a,b)=>a.start-b.start);
}
