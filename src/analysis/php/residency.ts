import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deserialize, serialize} from 'node:v8';

interface Resident<T> {value:T;cost:number}
interface Snapshot {file:string;bytes:number;digest:string;cost:number;invalid?:boolean}
export interface ResidencyLimits {maxResidentBytes:number;maxResidentUnits:number;maxSpoolBytes:number;maxSpoolUnits:number}
export const PHP_RESIDENCY_LIMITS:Readonly<ResidencyLimits>=Object.freeze({maxResidentBytes:32*1024*1024,maxResidentUnits:4096,maxSpoolBytes:256*1024*1024,maxSpoolUnits:4096});

/** Bounded provider ownership, not a decoded-object/RSS cap. Consumers can
 * retain returned units independently. Evicted units use private ephemeral
 * snapshots; unavailable snapshots are misses, never permission to drop facts. */
export class PhpResidency<T> {
  private readonly resident=new Map<string,Resident<T>>();
  private readonly snapshots=new Map<string,Snapshot>();
  private bytes=0;private spoolBytes=0;private root?:string;private closed=false;
  private evictions=0;private spills=0;private reloads=0;private misses=0;private failures=0;private bypasses=0;
  private peakBytes=0;private peakUnits=0;private peakSpoolBytes=0;
  readonly limits:Readonly<ResidencyLimits>;
  constructor(limits:ResidencyLimits=PHP_RESIDENCY_LIMITS){
    for(const name of ['maxResidentBytes','maxResidentUnits','maxSpoolBytes','maxSpoolUnits'] as const)if(!Number.isSafeInteger(limits[name])||limits[name]<0)throw Error('PHP residency limits require nonnegative safe integers');
    this.limits=Object.freeze({...limits});
  }
  stats(){return {limits:this.limits,bytes:this.bytes,units:this.resident.size,spoolBytes:this.spoolBytes,spoolUnits:this.snapshots.size,peakBytes:this.peakBytes,peakUnits:this.peakUnits,peakSpoolBytes:this.peakSpoolBytes,evictions:this.evictions,spills:this.spills,reloads:this.reloads,misses:this.misses,failures:this.failures,bypasses:this.bypasses};}
  /** Internal inspection for conformance; never emitted into graph metadata. */
  directory():string|undefined{return this.root;}
  get(key:string):T|undefined{
    if(this.closed)return undefined;
    const resident=this.resident.get(key);
    if(resident){this.resident.delete(key);this.resident.set(key,resident);return resident.value;}
    const snapshot=this.snapshots.get(key);if(!snapshot){this.misses++;return undefined;}
    if(snapshot.invalid){this.misses++;return undefined;}
    let descriptor:number|undefined;
    try{
      descriptor=openSync(snapshot.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      const info=fstatSync(descriptor);
      if(!info.isFile()||info.size!==snapshot.bytes)throw Error('Changed PHP snapshot size');
      const buffer=Buffer.allocUnsafe(snapshot.bytes);let offset=0;
      while(offset<buffer.length){const count=readSync(descriptor,buffer,offset,buffer.length-offset,null);if(!count)throw Error('Truncated PHP snapshot');offset+=count;}
      if(readSync(descriptor,Buffer.allocUnsafe(1),0,1,null)||createHash('sha256').update(buffer).digest('hex')!==snapshot.digest)throw Error('Changed PHP snapshot payload');
      closeSync(descriptor);descriptor=undefined;
      const value=deserialize(buffer) as T;
      this.snapshots.delete(key);this.snapshots.set(key,snapshot);this.reloads++;
      this.remember(key,value,snapshot.cost);return value;
    }catch{if(descriptor!==undefined){closeSync(descriptor);descriptor=undefined;}this.failures++;snapshot.invalid=true;this.forgetSnapshot(key);this.misses++;return undefined;}
    finally{if(descriptor!==undefined)closeSync(descriptor);}
  }
  put(key:string,value:T,cost:number):void{
    if(this.closed)throw Error('PHP residency store has been released');
    if(!Number.isSafeInteger(cost)||cost<0)throw Error('Invalid PHP residency cost');
    this.forget(key);
    if(cost>this.limits.maxResidentBytes||!this.limits.maxResidentUnits){this.bypasses++;this.spill(key,{value,cost});return;}
    this.remember(key,value,cost);
  }
  private remember(key:string,value:T,cost:number):void{
    if(cost>this.limits.maxResidentBytes||!this.limits.maxResidentUnits)return;
    while(this.resident.size>=this.limits.maxResidentUnits||this.bytes+cost>this.limits.maxResidentBytes){
      const oldest=this.resident.keys().next().value!;const unit=this.resident.get(oldest)!;
      this.resident.delete(oldest);this.bytes-=unit.cost;this.evictions++;
      if(!this.snapshots.has(oldest))this.spill(oldest,unit);
    }
    this.resident.set(key,{value,cost});this.bytes+=cost;
    this.peakBytes=Math.max(this.peakBytes,this.bytes);this.peakUnits=Math.max(this.peakUnits,this.resident.size);
  }
  private spill(key:string,unit:Resident<T>):void{
    if(!this.limits.maxSpoolBytes||!this.limits.maxSpoolUnits)return;
    // An undeletable snapshot remains charged, even when it is corrupt. Never
    // overwrite it or grow the quota by pretending a failed removal succeeded.
    if(this.snapshots.has(key))return;
    let reservation:Snapshot|undefined;
    try{
      const buffer=serialize(unit.value);if(buffer.length>this.limits.maxSpoolBytes){this.bypasses++;return;}
      while(this.snapshots.size>=this.limits.maxSpoolUnits||this.spoolBytes+buffer.length>this.limits.maxSpoolBytes)if(!this.forgetSnapshot(this.snapshots.keys().next().value!)){this.failures++;return;}
      this.root??=mkdtempSync(path.join(tmpdir(),'codiluce-php-residency-'));
      const file=path.join(this.root,createHash('sha256').update(key).digest('hex')+'.bin');
      // Reserve the complete possible payload before writing. A partial write
      // whose cleanup fails must remain charged and must never be replayable.
      reservation={file,bytes:buffer.length,digest:createHash('sha256').update(buffer).digest('hex'),cost:unit.cost,invalid:true};
      this.snapshots.set(key,reservation);this.spoolBytes+=buffer.length;this.peakSpoolBytes=Math.max(this.peakSpoolBytes,this.spoolBytes);
      writeFileSync(file,buffer,{mode:0o600,flag:'wx'});
      reservation.invalid=false;this.spills++;
    }catch{this.failures++;if(reservation)this.forgetSnapshot(key);}
  }
  forget(key:string):void{
    const unit=this.resident.get(key);if(unit){this.bytes-=unit.cost;this.resident.delete(key);}
    const snapshot=this.snapshots.get(key);if(snapshot)snapshot.invalid=true;
    this.forgetSnapshot(key);
  }
  private forgetSnapshot(key:string):boolean{
    const snapshot=this.snapshots.get(key);if(!snapshot)return true;
    try{unlinkSync(snapshot.file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
    this.snapshots.delete(key);this.spoolBytes-=snapshot.bytes;return true;
  }
  clear():void{
    this.closed=true;this.resident.clear();this.snapshots.clear();this.bytes=0;this.spoolBytes=0;
    if(this.root){rmSync(this.root,{recursive:true,force:true});this.root=undefined;}
  }
}

export interface PhpInputLimits {maxJobs:number;maxSourceBytes:number}
export const PHP_INPUT_LIMITS:Readonly<PhpInputLimits>=Object.freeze({maxJobs:6,maxSourceBytes:16*1024*1024});
interface Waiter {bytes:number;resolve:(release:()=>void)=>void;reject:(error:Error)=>void}
/** Waiters hold file identities, not decoded original text. A single allowed
 * larger source runs alone. Release cancels every job not yet admitted. */
export class PhpInputAdmission {
  private jobs=0;private bytes=0;private readonly waiting:Waiter[]=[];private closed=false;
  private peakJobs=0;private peakBytes=0;private oversized=0;
  readonly limits:Readonly<PhpInputLimits>;
  constructor(limits:PhpInputLimits=PHP_INPUT_LIMITS){
    if(!Number.isSafeInteger(limits.maxJobs)||limits.maxJobs<1||!Number.isSafeInteger(limits.maxSourceBytes)||limits.maxSourceBytes<1)throw Error('PHP input limits require positive safe integers');
    this.limits=Object.freeze({...limits});
  }
  stats(){return {limits:this.limits,jobs:this.jobs,bytes:this.bytes,waiting:this.waiting.length,peakJobs:this.peakJobs,peakBytes:this.peakBytes,oversized:this.oversized};}
  acquire(bytes:number):Promise<()=>void>{
    if(!Number.isSafeInteger(bytes)||bytes<0)return Promise.reject(Error('Invalid indexed PHP source size'));
    if(this.closed)return Promise.reject(Error('PHP source service has been released'));
    return new Promise((resolve,reject)=>{this.waiting.push({bytes,resolve,reject});this.dispatch();});
  }
  private dispatch():void{
    while(!this.closed&&this.waiting.length&&this.jobs<this.limits.maxJobs){
      const next=this.waiting[0]!;
      if(this.jobs&&this.bytes+next.bytes>this.limits.maxSourceBytes)return;
      this.waiting.shift();this.jobs++;this.bytes+=next.bytes;
      this.peakJobs=Math.max(this.peakJobs,this.jobs);this.peakBytes=Math.max(this.peakBytes,this.bytes);if(next.bytes>this.limits.maxSourceBytes)this.oversized++;
      let released=false;next.resolve(()=>{if(released)return;released=true;this.jobs--;this.bytes-=next.bytes;this.dispatch();});
    }
  }
  close():void{this.closed=true;for(const waiter of this.waiting.splice(0))waiter.reject(Error('PHP source service has been released'));}
}
