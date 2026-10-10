import type {Evidence} from '../../core/graph.js';
import type {WarpCorsPolicy} from '../routes/warp-patterns.js';
import type {RustWebProfile} from './rust-profile.js';

export interface WarpCors {
    kind:'warp-cors';
    profile:RustWebProfile;
    policy:WarpCorsPolicy;
    built:boolean;
    consumed?:boolean;
    conditions:string[];
    proof:Evidence[];
}
const unique=<T>(values:T[])=>[...new Set(values)];
const token=/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export function warpCors(profile:RustWebProfile,fact:Evidence):WarpCors {
    return {kind:'warp-cors',profile,policy:{origins:'any',methods:[],allowedHeaders:[],exposedHeaders:[],credentials:false},built:false,conditions:[...profile.conditions],proof:[...profile.proof,fact]};
}
/** Read original builder settings only. Conversion, header construction and
 * request validation never execute; unknown settings keep the native wrapper. */
export function warpCorsMethod(value:WarpCors,name:string,args:unknown[],fact:Evidence,standardClone:boolean):WarpCors|undefined {
    const clone=name==='clone'&&!args.length;
    if(value.built&&!clone)return;
    const result:WarpCors={...value,consumed:false,policy:structuredClone(value.policy),conditions:[...value.conditions],proof:[...value.proof,fact]};
    if(value.consumed)result.conditions.push('Original Warp CORS builder/wrapper is reused after move');
    if(clone){if(!standardClone)result.conditions.push('Warp CORS clone method has no reviewed standard trait context or has a source trait competitor');return result;}
    const list=(multiple:boolean,read:(input:unknown)=>string|undefined)=>{
        const values=multiple&&Array.isArray(args[0])?args[0]:!multiple?args:undefined;
        if(!values||values.length>256)return;
        const selected=values.map(read);return selected.every(value=>value!==undefined)?selected as string[]:undefined;
    };
    const append=(key:'methods'|'allowedHeaders'|'exposedHeaders',selected:string[]|undefined)=>{
        result.policy[key]=selected&&Array.isArray(result.policy[key])?unique([...result.policy[key],...selected]):'unknown';
        if(!selected)result.conditions.push(`Original Warp CORS ${name} conversion/iterator input is unreviewed`);
    };
    if(name==='build'&&!args.length)result.built=true;
    else if(name==='allow_any_origin'&&!args.length)result.policy.origins='any';
    else if(['allow_origin','allow_origins'].includes(name)&&args.length===1){
        const selected=list(name==='allow_origins',input=>typeof input==='string'&&input.length<=8192&&!/[\r\n\0]/.test(input)?input:undefined);
        result.policy.origins=selected&&result.policy.origins!=='unknown'?unique([...(Array.isArray(result.policy.origins)?result.policy.origins:[]),...selected]):'unknown';
        result.conditions.push('Warp CORS original origin conversion/HeaderValue validity remains unreviewed');
    }
    else if(['allow_method','allow_methods'].includes(name)&&args.length===1)append('methods',list(name==='allow_methods',input=>{
        if(typeof input==='string'&&token.test(input))return input;
        if(input&&typeof input==='object'&&'kind'in input&&input.kind==='guard'&&'httpMethod'in input&&input.httpMethod===true&&'methods'in input&&Array.isArray(input.methods)&&input.methods.length===1&&typeof input.methods[0]==='string'){
            if('conditions'in input&&Array.isArray(input.conditions))result.conditions.push(...input.conditions.filter((value):value is string=>typeof value==='string'));
            if('proof'in input&&Array.isArray(input.proof))result.proof.push(...input.proof as Evidence[]);
            return input.methods[0];
        }
    }));
    else if(['allow_header','allow_headers','expose_header','expose_headers'].includes(name)&&args.length===1)append(name.startsWith('allow')?'allowedHeaders':'exposedHeaders',list(name.endsWith('headers'),input=>typeof input==='string'&&token.test(input)?input.toLowerCase():undefined));
    else if(name==='allow_credentials'&&args.length===1){result.policy.credentials=typeof args[0]==='boolean'?args[0]:'unknown';if(result.policy.credentials==='unknown')result.conditions.push('Original Warp CORS credentials operand is unreviewed');}
    else if(name==='max_age'&&args.length===1){result.policy.maxAge=typeof args[0]==='number'&&Number.isSafeInteger(args[0])&&args[0]>=0?args[0]:'unknown';result.conditions.push('Warp CORS original Seconds conversion/type bounds remain unreviewed');}
    else return;
    value.consumed=true;
    result.conditions=unique(result.conditions);
    return result;
}
