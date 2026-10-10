import { evidence, type Evidence } from '../../core/graph.js';
import type { RustItemFact } from '../facts.js';
import { rustAttributes, rustCfg, rustSplit, rustString, type RustAttributes } from '../languages/rust-cfg.js';
import { RustLockfiles } from './rust-lock.js';
import { RUST_RESOLVER_VERSION, type RustResolver, type RustScope, type RustNamespaceAttributes, type RustResolution } from './rust.js';

const builtins = new Map(Object.entries({Clone:'clone',Copy:'marker',Debug:'fmt',Default:'default',Eq:'cmp',Hash:'hash',Ord:'cmp',PartialEq:'cmp',PartialOrd:'cmp'}));
const generation = (gap: string) => gap.startsWith('Unreviewed Rust attribute');
const allowed = (result: RustResolution) => result.status === 'external' && result.conditions.every(generation);
const macroPath = (name: string) => /^(?:::)?[_\p{ID_Start}][_\p{ID_Continue}]*(?:::[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u.test(name);
interface NativeDerive { identity: string; proof: Evidence[]; originalGaps?: string[] }
const modernSerde = new Set(['1.0.169','1.0.203','1.0.219','1.0.228']);

/** Derive namespace projection, independently of generated traits/conversions.
 * Serde's anonymous wrapper requires a recorded modern provider selection and
 * canonical delegated serde identity. No registry, compiler or macros run. */
export class RustDeriveNamespaces {
    private readonly locks: RustLockfiles;
    constructor(private readonly base: RustResolver) { this.locks = new RustLockfiles(base); }
    private effective(attribute: string, scope: RustScope, depth = 0): string[] {
        if (depth > 32) return [attribute];
        const text = attribute.replace(/^#!?\[/,'').replace(/\]$/,'').trim(), conditional = /^cfg_attr\s*\(([\s\S]*)\)$/.exec(text), args = conditional && rustSplit(conditional[1]!);
        return args && args.length >= 2 && rustCfg(args[0]!,scope.compilation.environment) === true ? args.slice(1).flatMap(value=>this.effective(value,scope,depth+1)) : [attribute];
    }
    macro(name: string, item: RustItemFact, scope: RustScope): NativeDerive | undefined {
        if (!macroPath(name)) return;
        const segments=name.split('::').filter(Boolean), result=this.base.path(scope,segments,name.startsWith('::'),new Set(),'macro');
        let proof: Evidence[] | undefined, identity: string | undefined;
        if (allowed(result) && result.status==='external' && result.dependency==='rust-standard-library' && ['std','core'].includes(result.crate)) {
            const selected=result.path.at(-1)!, location=builtins.get(selected);
            if (location && (result.path.join('::')===location+'::'+selected || /^prelude::(?:v1|rust_2015|rust_2018|rust_2021|rust_2024)::/.test(result.path.join('::')) && result.path.length===3)) { proof=result.proof;identity='builtin::'+selected; }
        } else if (result.status==='unresolved' && segments.length===1 && builtins.has(name) && !name.startsWith('::')) {
            for(let current:RustScope|undefined=scope;current;current=current.parent){
                if(current.attributes.noCore || current.attributes.noPrelude || current.imports.some(site=>site.active!==false&&site.fact.attributes.some(value=>/^#!?\[\s*macro_use\b/.test(value))))return;
                if(current.items.some(value=>value.active!==false&&value.namespaces.includes('macro')&&value.name===name)||current.imports.some(site=>site.active!==false&&!site.fact.glob&&(site.fact.alias??site.fact.segments.at(-1))===name))return;
                for(const site of current.imports.filter(site=>site.active!==false&&site.fact.glob)){const imported=this.base.resolve(site);if(imported.status!=='resolved'||imported.conditions.some(gap=>!generation(gap)))return;}
            }
            const root=this.base.roots.get(scope.compilation.id), standard=this.base.path(scope,[root?.attributes.noStd?'core':'std'],false,new Set(),'type');
            if(allowed(standard)&&standard.status==='external'&&standard.dependency==='rust-standard-library'){proof=standard.proof;identity='builtin::'+name;}
        }
        if(proof&&identity)return {identity,proof};
        if(item.kind==='union'||!allowed(result)||result.status!=='external'||!['serde','serde_derive'].includes(result.dependency)||result.path.length!==1||!['Serialize','Deserialize'].includes(result.path[0]!))return;
        const entry=scope.compilation.dependencies.get(result.crate), dep=entry?.dependency;
        if(!entry||!dep||entry.active!==true||entry.compilation||entry.gaps.length||dep.scope==='build'||dep.package!==result.dependency)return;
        if(dep.package==='serde'&&![...dep.features,...scope.compilation.dependencyFeatures.get(dep.name)??[]].some(value=>['derive','serde_derive'].includes(value)))return;
        const selected=this.locks.select(scope.compilation.target.package,dep,dep.package==='serde'?'serde_derive':undefined);
        if(!selected||!modernSerde.has(selected.package.version))return;
        let delegate='::serde', customCrate=false;
        for(const attribute of item.attributes.flatMap(value=>this.effective(value,scope))){
            const helper=/^serde\s*\(([\s\S]*)\)$/.exec(attribute.replace(/^#!?\[/,'').replace(/\]$/,'').trim());
            if(!helper)continue;const args=rustSplit(helper[1]!);if(!args)return;
            for(const argument of args){const custom=/^crate\s*=\s*([\s\S]*)$/.exec(argument);if(custom){if(customCrate)return;customCrate=true;const path=rustString(custom[1]!);if(!path||!macroPath(path))return;delegate=path;}}
        }
        const delegated=this.base.path(scope,delegate.split('::').filter(Boolean),delegate.startsWith('::'),new Set(),'type');
        if(!allowed(delegated)||delegated.status!=='external'||delegated.dependency!=='serde'||delegated.path.length)return;
        const delegatedEntry=scope.compilation.dependencies.get(delegated.crate);
        if(!delegatedEntry||delegatedEntry.active!==true||delegatedEntry.compilation||delegatedEntry.gaps.length||delegatedEntry.dependency.scope==='build')return;
        const runtime=this.locks.select(scope.compilation.target.package,delegatedEntry.dependency);
        if(!runtime||runtime.package.version!==selected.package.version)return;
        return {identity:'serde::'+result.path[0],proof:[...result.proof,...dep.proof,...selected.proof,...delegated.proof,...runtime.proof],originalGaps:['Original Serde derived item traits/conversions remain unreviewed']};
    }
    attributes(retained: string[], scope: RustScope, unqualifiedBuiltin: boolean): RustAttributes {
        const result=rustAttributes(retained,scope.compilation.environment);
        if(unqualifiedBuiltin)result.namespaceGaps.push('Unreviewed Rust attribute derive builtin spelling lacks a canonical macro identity');
        return result;
    }
    builtinSpelling(name: string) { return builtins.has(name); }
    /** Preserve a gap even when the legacy syntactic reader treats a builtin
     * spelling as neutral. Unreviewed input cannot bypass identity checks. */
    opaqueBuiltins(item: RustItemFact, scope: RustScope): RustNamespaceAttributes | undefined {
        const attrs=item.attributes.flatMap(value=>this.effective(value,scope));
        if(!attrs.some(value=>{const derive=/^derive\s*\(([\s\S]*)\)$/.exec(value.replace(/^#!?\[/,'').replace(/\]$/,'').trim());return derive&&rustSplit(derive[1]!)?.some(name=>this.builtinSpelling(name));}))return;
        return {attributes:this.attributes(item.attributes,scope,true),proof:[]};
    }
    read(item: RustItemFact, scope: RustScope): RustNamespaceAttributes | undefined {
        if(!item.attributes.length)return;
        const syntax=this.base.syntax(scope.file.path),source=this.base.projects.sources.readFile(scope.file.path);
        if(!['struct','enum','union'].includes(item.kind)||!syntax?.complete||!syntax.semantic?.complete||source===undefined||item.gaps.length||source.slice(item.start,item.end).length>8192||source.slice(item.start,item.end).includes('!')||item.attributes.some(value=>value.includes('!')))return this.opaqueBuiltins(item,scope);
        const proof:Evidence[]=[], originalGaps:string[]=[], known=new Set<string>();let unqualifiedBuiltin=false,found=false,serde=false;
        const filter=(attribute:string,original:string,depth=0):string[]=>{
            if(depth>32)return [attribute];
            const text=attribute.replace(/^#!?\[/,'').replace(/\]$/,'').trim(),conditional=/^cfg_attr\s*\(([\s\S]*)\)$/.exec(text),args=conditional&&rustSplit(conditional[1]!);
            if(args&&args.length>=2&&rustCfg(args[0]!,scope.compilation.environment)===true)return args.slice(1).flatMap(value=>filter(value,original,depth+1));
            const derive=/^derive\s*\(([\s\S]*)\)$/.exec(text),names=derive&&rustSplit(derive[1]!);
            if(!names?.length||names.length>32){if(names?.some(name=>this.builtinSpelling(name))){unqualifiedBuiltin=true;found=true;}return [attribute];}const retained:string[]=[];
            for(const name of names){
                const native=this.macro(name,item,scope),start=source.lastIndexOf(original,item.start);
                if(!native||known.has(native.identity)||start<scope.fact.start){retained.push(name);unqualifiedBuiltin ||= this.builtinSpelling(name);found ||= this.builtinSpelling(name);continue;}
                known.add(native.identity);found=true;serde ||= native.identity.startsWith('serde::');originalGaps.push(...native.originalGaps??[]);
                const line=source.slice(0,start).split('\n').length;
                proof.push(...native.proof,{...evidence('syntax','rust-imports',scope.file.path,line,`Original ${native.identity} derive on ${item.name}: reviewed containing namespace only; generated implementations/traits/conversions remain unreviewed`),endLine:line+original.split('\n').length-1,analyzerVersion:RUST_RESOLVER_VERSION});
            }
            return retained.length?[`#[derive(${retained.join(',')})]`]:[];
        };
        let retained=item.attributes.flatMap(value=>filter(value,value));
        if(serde)retained=retained.filter(value=>!/^serde\s*\(/.test(value.replace(/^#!?\[/,'').replace(/\]$/,'').trim()));
        return found?{attributes:this.attributes(retained,scope,unqualifiedBuiltin),proof,originalGaps:[...new Set(originalGaps)]}:undefined;
    }
}
