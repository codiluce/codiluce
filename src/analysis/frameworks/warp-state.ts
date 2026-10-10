import {evidence,type Evidence} from '../../core/graph.js';
import type {RustDefinition,RustSymbols,RustValue} from '../languages/rust-symbols.js';
import type {RustResolver,RustScope} from '../resolution/rust.js';
import {RustDeriveNamespaces} from '../resolution/rust-derive-namespace.js';
import type {WarpSourceState} from '../routes/warp-patterns.js';
import {RUST_ROUTER_VERSION} from './rust-profile.js';

export interface WarpStateOutput { state:WarpSourceState; extraction:string; proof:Evidence[]; conditions:string[] }
export const warpStateIdentity=(state:WarpSourceState)=>`source:${state.compilation}:${state.id}`;
/** Original state identity is distinct from Clone/Send/Sync validity. No state
 * constructor, field expression, clone implementation or callback executes. */
export function warpStateOutput(symbols:RustSymbols,base:RustResolver,definition:RustDefinition,scope:RustScope,standardClone:(scope:RustScope)=>boolean):WarpStateOutput|undefined {
    const fact=definition.fact;
    if(fact.async||fact.generics||!fact.body||fact.gaps.length||!definition.unit.facts.complete)return;
    const local=(key:string)=>symbols.resolver.scopes.find(candidate=>candidate.compilation.id===scope.compilation.id&&candidate.file.path===scope.file.path&&candidate.fact.key===key);
    const body=local(fact.body);if(!body||body.active!==true||body.gaps.length)return;
    const project=(value:RustValue,proof:Evidence[]=[]):WarpStateOutput|undefined=>{
        if(!['type','instance'].includes(value.kind)||!('symbol'in value)||value.conditions.length||value.references.length||value.symbol.active!==true||value.symbol.gaps.length||!value.symbol.fact||!['struct','enum'].includes(value.symbol.fact.kind))return;
        const symbol=value.symbol,state={id:symbol.id,compilation:symbol.scope.compilation.id,name:symbol.name,file:symbol.scope.file.path,line:symbol.fact!.range.startLine};
        return {state,extraction:warpStateIdentity(state),proof:[...value.proof,...proof,{...evidence('framework','rust-routers',state.file,state.line,`Original Warp custom state ${state.name}: source type identity only; construction, field values and Clone/Send/Sync bounds remain unreviewed`),analyzerVersion:RUST_ROUTER_VERSION}],conditions:['Warp custom state construction/field values and Clone/Send/Sync implementation bounds remain unreviewed']};
    };
    if(fact.returnType)return project(symbols.typeValue(body,fact.returnType));
    if(fact.kind!=='closure')return;
    const returns=definition.unit.facts.returns.filter(item=>item.owner===fact.key);
    if(returns.length!==1||returns[0]!.conditional)return;
    const returned=returns[0]!,at=local(returned.scope);if(!at)return;
    const ordinary=project(symbols.value(at,returned.value));if(ordinary)return ordinary;
    const expression=returned.value;
    if(expression.kind!=='call'||expression.args.length||expression.callee.kind!=='field'||expression.callee.name!=='clone'||!standardClone(at))return;
    const receiver=symbols.value(at,expression.callee.value),output=project(receiver);if(!output)return;
    const symbol='symbol'in receiver?receiver.symbol:undefined,item=symbol?.fact;
    const original=symbol&&base.scopes.find(candidate=>candidate.compilation.id===symbol.scope.compilation.id&&candidate.file.path===symbol.scope.file.path&&candidate.fact.key===symbol.scope.fact.key);
    if(!symbol||!item||!original)return;
    // An inherent clone can shadow Clone::clone. Source trait competitors are
    // rejected by standardClone; explicit/blanket competing impls remain opaque.
    for(const candidate of symbols.resolver.scopes.filter(candidate=>candidate.compilation.id===scope.compilation.id||candidate.compilation.id===symbol.scope.compilation.id)){
        const facts=symbols.facts(candidate.file.path);
        for(const impl of facts?.impls.filter(impl=>impl.parent===candidate.fact.key)??[]){
            if(!facts!.definitions.some(member=>member.impl===impl.key&&member.name==='clone'))continue;
            const target=symbols.typeValue(candidate,impl.type);
            if(target.kind==='type'&&target.symbol.id===symbol.id||target.kind==='unknown')return;
        }
    }
    const reviewed=new RustDeriveNamespaces(base).read(item,original),native=reviewed?.proof.filter(fact=>fact.explanation?.includes(`builtin::Clone derive on ${item.name}:`));
    if(!native?.length)return;
    output.proof.push(...native,{...evidence('framework','rust-routers',at.file.path,expression.range.startLine,'Original native Clone::clone return Self shape for captured source state; generated clone implementation and field bounds remain unreviewed'),analyzerVersion:RUST_ROUTER_VERSION,endLine:expression.range.endLine});
    return output;
}
