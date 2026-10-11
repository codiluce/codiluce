// Pure finalization and bounded findings, shared by native and compiler phases.
import type {StructureFacts} from '../facts.js';
import {SourceText} from '../source-map.js';

const MAX_ISSUES=100;
export function erbIssue(facts:StructureFacts,code:string,reason:string,range?:ReturnType<SourceText['range']>):void {
 if(facts.issues.length<MAX_ISSUES)facts.issues.push({code,reason,...range?{range}:{}});else facts.truncated=true;
}
export function finishErb(facts:StructureFacts):StructureFacts {
 if(facts.truncated&&!facts.issues.some(i=>i.code==='erb-budget-exceeded')){if(facts.issues.length===MAX_ISSUES)facts.issues.pop();facts.issues.push({code:'erb-budget-exceeded',reason:'Original ERB extraction reached its node, region, declaration, header, context, diagnostic or query budget'});}
 facts.erb!.complete=!facts.issues.length&&!facts.truncated&&facts.erb!.rubyComplete&&facts.erb!.host.complete;return facts;
}

export function razorIssue(facts:StructureFacts,code:string,reason:string,range?:ReturnType<SourceText['range']>):void {if(facts.issues.length<100)facts.issues.push({code,reason,...range?{range}:{}});else facts.truncated=true;}
export function finishRazor(facts:StructureFacts):StructureFacts {
 if(facts.truncated){facts.razor!.csharpComplete=false;if(facts.issues.length===100)facts.issues.pop();razorIssue(facts,'razor-budget-exceeded','Original Razor extraction reached its node, region, declaration, header, context, diagnostic or query budget');}
 facts.razor!.complete=!facts.truncated&&!facts.issues.length&&facts.razor!.csharpComplete&&facts.razor!.host.complete;return facts;
}

export function liquidIssue(facts:StructureFacts,code:string,reason:string,start?:number,end?:number,content?:string):void {
 if(facts.issues.length<100)facts.issues.push({code,reason,...start!==undefined&&content!==undefined?{range:new SourceText(content).range(start,end??start)}:{}});else facts.truncated=true;
}
export function finishLiquid(facts:StructureFacts):StructureFacts {
 const syntax=facts.liquid!;
 if(facts.truncated){syntax.host.complete=false;syntax.nativeComplete=false;if(!facts.issues.some(i=>i.code==='liquid-budget-exceeded')){if(facts.issues.length===100)facts.issues.pop();facts.issues.push({code:'liquid-budget-exceeded',reason:'Original Liquid extraction reached its node, depth, region, binding, import, diagnostic or query budget'});}}
 syntax.complete=!facts.truncated&&!facts.issues.length&&syntax.nativeComplete&&syntax.host.complete;return facts;
}
