import {evidence,type Evidence} from '../../core/graph.js';
import type {RustDefinition,RustSymbols,RustValue} from '../languages/rust-symbols.js';
import type {RustScope} from '../resolution/rust.js';
import {RUST_ROUTER_VERSION} from './rust-profile.js';

const generation=(gap:string)=>/^Unreviewed Rust attribute [\w:]+ may generate\/change items$/.test(gap);
/** Possible original functions under unrelated type attributes. This does not
 * resolve generated exports, general Rust names or a function's own attributes.
 * Only Axum consumers may request this conditional source projection. */
export class RustSourceProjections {
    private readonly namespaces=new Map<RustScope,boolean>();
    constructor(private readonly symbols:RustSymbols){}
    namespace(scope:RustScope):boolean {
        const cached=this.namespaces.get(scope);if(cached!==undefined)return cached;
        let depth=0,count=0;const covered=new Set<string>();
        for(let current:RustScope|undefined=scope;current;current=current.parent){
            if(++depth>64||current.active!==true||current.compilation.gaps.length||current.gaps.some(gap=>!generation(gap))){this.namespaces.set(scope,false);return false;}
            const syntax=this.symbols.resolver.syntax(current.file.path),owner=syntax?.items.find(item=>item.key===current!.fact.owner);
            if(!syntax?.complete||!syntax.semantic?.complete||this.symbols.resolver.attributes(current.fact.attributes,current.compilation,current.file.path,owner?current.fact.parent??current.fact.key:current.fact.key,owner?.start).namespaceGaps.length){this.namespaces.set(scope,false);return false;}
            for(const item of syntax.items.filter(item=>item.scope===current!.fact.key)){
                if(++count>2048){this.namespaces.set(scope,false);return false;}
                const attrs=this.symbols.resolver.attributes(item.attributes,current.compilation,current.file.path,current.fact.key,item.start);
                if(attrs.active===false)continue;
                if(attrs.namespaceGaps.length){
                    if(attrs.active!==true||!['struct','enum','union'].includes(item.kind)||item.gaps.length||attrs.namespaceGaps.some(gap=>!generation(gap))){this.namespaces.set(scope,false);return false;}
                    for(const gap of attrs.namespaceGaps)covered.add(gap);
                }
            }
        }
        const result=scope.gaps.every(gap=>covered.has(gap));this.namespaces.set(scope,result);return result;
    }
    callable(value:RustValue):{definition:RustDefinition;scope:RustScope;proof:Evidence[];conditions:string[]}|undefined {
        if(value.kind!=='callable'||value.definitions.length!==1||!value.conditions.length||value.conditions.some(gap=>!generation(gap)))return;
        const selected=value.definitions[0]!,{definition,scope}=selected,fact=definition.fact;
        if(fact.kind!=='function'||fact.generics||fact.gaps.length||!fact.body||!definition.unit.facts.complete||!this.namespace(scope))return;
        const attrs=this.symbols.resolver.attributes(fact.attributes,scope.compilation,scope.file.path,fact.scope,fact.start);
        if(attrs.active!==true||attrs.gaps.length)return;
        const syntax=this.symbols.resolver.syntax(scope.file.path),body=syntax?.scopes.find(candidate=>candidate.key===fact.body),source=this.symbols.resolver.projects.sources.readFile(scope.file.path);
        if(!body||source===undefined||/\b(?:const|unsafe|extern)\b/.test(source.slice(fact.start,body.start)))return;
        return {...selected,conditions:[...value.conditions,'Axum original source function is projected conditionally; generated type-attribute exports and compiler validity remain unreviewed'],proof:[...value.proof,{...evidence('framework','rust-routers',scope.file.path,fact.range.startLine,`Original ${fact.name} source function has no unreviewed function attribute; unrelated type-attribute namespaces remain conditional, with no general Rust binding claim`),endLine:fact.range.endLine,analyzerVersion:RUST_ROUTER_VERSION}]};
    }
}
