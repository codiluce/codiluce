import {encodeTypeScriptPayload,decodeTypeScriptPayload,TypeScriptCodecLimitError,type TypeScriptCodecStats,type TypeScriptCodecLimits} from '../../analyzers/ts-worker-codec.js';

// Private native/template parser framing. The existing reference-preserving
// codec checks bytes before block copies and structure before decoded objects.
// These are allocation/ownership bounds, not a total RSS guarantee.
export const PARSER_FRAME_BYTES=64*1024*1024;
export const PARSER_FRAME_ENCODING='bounded-v1';
export const PARSER_FRAME_POLICY='bounded-facts-v1';
export class ParserFrameLimitError extends RangeError {}
function size(value:number):void {if(!Number.isSafeInteger(value)||value<1||value>PARSER_FRAME_BYTES)throw Error('Parser frame limit must be a positive safe integer at or below 67108864 bytes');}
function bounded<T>(operation:()=>T):T {
 try{return operation();}catch(error){if(error instanceof TypeScriptCodecLimitError)throw new ParserFrameLimitError(error.message.replace(/^TypeScript compiler/,'Parser facts'));throw error;}
}
/** Lower limits and stats are owned conformance seams, never target settings. */
export function encodeParserFrame(value:unknown,maxBytes=PARSER_FRAME_BYTES,stats?:TypeScriptCodecStats,limits?:Partial<TypeScriptCodecLimits>):Buffer {
 size(maxBytes);return bounded(()=>encodeTypeScriptPayload(value,maxBytes,stats,limits));
}
export function decodeParserFrame(bytes:Buffer,maxBytes=PARSER_FRAME_BYTES,stats?:TypeScriptCodecStats,limits?:Partial<TypeScriptCodecLimits>):unknown {
 size(maxBytes);return bounded(()=>decodeTypeScriptPayload(bytes,maxBytes,stats,limits));
}
export function parserJob(message:{id:number;encoding?:unknown;payload?:unknown;[key:string]:unknown}):Record<string,unknown> {
 if(message.encoding===undefined)return message; // Owned alternate-worker fault probes retain legacy input.
 if(message.encoding!==PARSER_FRAME_ENCODING||!Buffer.isBuffer(message.payload))throw Error('Invalid parser request encoding');
 const value=decodeParserFrame(message.payload);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid parser request');
 return {...value,id:message.id};
}
export function replyParserFrame(id:number,response:unknown):void {
 let payload:Buffer;
 try{payload=encodeParserFrame(response);}catch(error){payload=encodeParserFrame({error:error instanceof Error?error.message:String(error),fatal:true});}
 process.send?.({id,type:'completed',completedAtNs:process.hrtime.bigint().toString(),bytes:payload.byteLength,encoding:PARSER_FRAME_ENCODING});
 process.send?.({id,type:'result',payload,encoding:PARSER_FRAME_ENCODING});
}
