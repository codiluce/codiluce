import {types} from 'node:util';

// Private, versioned graph transport. String/object references preserve aliases;
// no metadata, proof, undefined value or original UTF-16 code unit is omitted.
const MAGIC = Buffer.from([0x43, 0x44, 0x54, 1]);
export const TYPESCRIPT_CODEC_BLOCK_BYTES = 64 * 1024;
const STRING_UNITS = 4096;
enum Tag { End, Undefined, Null, False, True, Uint, NegativeInt, Double, String8, String16, StringRef, Ref, Object, Array, Index, Map, Set, BigInt, Date, RegExp, ArrayBuffer, View, BoxedNumber, BoxedString, BoxedBoolean, BoxedBigInt, Error }
const views = [Buffer, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView] as const;
export interface TypeScriptCodecStats { allocatedBlockBytes: number; concatenatedBytes: number; peakBlockBytes: number; peakStringTemporaryBytes: number; encodedBytes: number; objects: number; strings: number }
export class TypeScriptCodecLimitError extends RangeError {}
function limit(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw Error('TypeScript codec limit requires a positive safe integer'); }
class Writer {
  readonly blocks: Buffer[] = [];
  bytes = 0;
  private block?: Buffer;
  private used = 0;
  constructor(readonly max: number, readonly stats?: TypeScriptCodecStats) {}
  reserve(size: number): void { if (!Number.isSafeInteger(size) || size < 0 || size > this.max - this.bytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${this.max} bytes`); }
  private room(): Buffer {
    if (!this.block || this.used === this.block.length) {
      if (this.block) this.blocks.push(this.block);
      this.block = Buffer.allocUnsafe(Math.min(TYPESCRIPT_CODEC_BLOCK_BYTES, this.max - this.bytes)); this.used = 0;
      if (this.stats) { this.stats.allocatedBlockBytes += this.block.length; this.stats.peakBlockBytes = Math.max(this.stats.peakBlockBytes, this.block.length); }
    }
    return this.block;
  }
  byte(value: number): void { this.reserve(1); this.room()[this.used++] = value; this.bytes++; }
  uint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid compiler transport integer');
    do { const digit = value % 128; value = Math.floor(value / 128); this.byte(digit + (value ? 128 : 0)); } while (value);
  }
  raw(value: Uint8Array): void {
    this.reserve(value.byteLength);
    for (let offset = 0; offset < value.byteLength;) {
      const block = this.room(), size = Math.min(block.length - this.used, value.byteLength - offset);
      block.set(value.subarray(offset, offset + size), this.used); this.used += size; this.bytes += size; offset += size;
    }
  }
  double(value: number): void { const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleLE(value); this.raw(bytes); }
  finish(): Buffer {
    if (this.block) this.blocks.push(this.block.subarray(0, this.used));
    if (this.stats) { this.stats.encodedBytes = this.bytes; this.stats.concatenatedBytes = this.bytes; }
    return Buffer.concat(this.blocks, this.bytes);
  }
}
type Task = {kind: 'value'; value: unknown} | {kind: 'properties'; value: object; keys: string[]; index: number; array: boolean} | {kind: 'map'; iterator: MapIterator<[unknown, unknown]>} | {kind: 'set'; iterator: SetIterator<unknown>} ;

/** String/binary payload bytes are admitted before chunk allocation or writes.
 * Blocks total at most maxBytes; final concatenation adds at most maxBytes.
 * This bounds encoding buffers, not the caller's graph, traversal key arrays,
 * reference tables, decoded graph allocations, native memory or total RSS. */
export function encodeTypeScriptPayload(value: unknown, maxBytes: number, stats?: TypeScriptCodecStats): Buffer {
  limit(maxBytes);
  if (stats) Object.assign(stats, {allocatedBlockBytes: 0, concatenatedBytes: 0, peakBlockBytes: 0, peakStringTemporaryBytes: 0, encodedBytes: 0, objects: 0, strings: 0});
  const writer = new Writer(maxBytes, stats), objects = new Map<object, number>(), strings = new Map<string, number>();
  const string = (text: string): void => {
    if (text.length > maxBytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
    const known = strings.get(text);
    if (known !== undefined) { writer.byte(Tag.StringRef); writer.uint(known); return; }
    let latin = true;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) { latin = false; break; }
    writer.byte(latin ? Tag.String8 : Tag.String16); writer.uint(text.length);
    writer.reserve(text.length * (latin ? 1 : 2));
    strings.set(text, strings.size);
    for (let offset = 0; offset < text.length; offset += STRING_UNITS) {
      const bytes = Buffer.from(text.slice(offset, offset + STRING_UNITS), latin ? 'latin1' : 'utf16le');
      if (stats) stats.peakStringTemporaryBytes = Math.max(stats.peakStringTemporaryBytes, bytes.length);
      writer.raw(bytes);
    }
  };
  writer.raw(MAGIC);
  const stack: Task[] = [{kind: 'value', value}];
  while (stack.length) {
    const task = stack.pop()!;
    if (task.kind === 'properties') {
      if (task.index === task.keys.length) { writer.byte(Tag.End); continue; }
      const key = task.keys[task.index++]!;
      if (task.array && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff) { writer.byte(Tag.Index); writer.uint(Number(key)); }
      else string(key);
      // Snapshot enumerable own keys, then read each value once, as cloning does.
      stack.push(task, {kind: 'value', value: (task.value as Record<string, unknown>)[key]}); continue;
    }
    if (task.kind === 'map') {
      const entry = task.iterator.next();
      if (entry.done) { writer.byte(Tag.End); continue; }
      stack.push(task, {kind: 'value', value: entry.value[1]}, {kind: 'value', value: entry.value[0]}); continue;
    }
    if (task.kind === 'set') {
      const entry = task.iterator.next();
      if (entry.done) { writer.byte(Tag.End); continue; }
      stack.push(task, {kind: 'value', value: entry.value}); continue;
    }
    const item = task.value;
    if (item === undefined) { writer.byte(Tag.Undefined); continue; }
    if (item === null) { writer.byte(Tag.Null); continue; }
    if (typeof item === 'boolean') { writer.byte(item ? Tag.True : Tag.False); continue; }
    if (typeof item === 'string') { string(item); continue; }
    if (typeof item === 'number') {
      if (Number.isInteger(item) && !Object.is(item, -0) && item >= 0 && item <= 0xffffffff) { writer.byte(Tag.Uint); writer.uint(item); }
      else if (Number.isInteger(item) && item < 0 && item >= -0x80000000) { writer.byte(Tag.NegativeInt); writer.uint(-item); }
      else { writer.byte(Tag.Double); writer.double(item); }
      continue;
    }
    if (typeof item === 'bigint') {
      writer.byte(Tag.BigInt); writer.byte(item < 0n ? 1 : 0);
      // Reject a large integer before constructing its bounded hexadecimal text.
      const bits = (writer.max - writer.bytes) * 8;
      if ((item < 0n ? BigInt.asIntN(bits + 1, item) : BigInt.asUintN(bits, item)) !== item) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
      let hex = (item < 0n ? -item : item).toString(16); if (hex.length % 2) hex = '0' + hex;
      writer.uint(hex.length / 2); writer.reserve(hex.length / 2);
      for (let i = 0; i < hex.length; i += STRING_UNITS) writer.raw(Buffer.from(hex.slice(i, i + STRING_UNITS), 'hex'));
      continue;
    }
    if (typeof item !== 'object' || types.isProxy(item) || types.isWeakMap(item) || types.isWeakSet(item) || types.isPromise(item) || types.isSharedArrayBuffer(item) || types.isModuleNamespaceObject(item) || item instanceof WeakRef || item instanceof FinalizationRegistry) throw Error('Unsupported compiler transport value');
    const known = objects.get(item);
    if (known !== undefined) { writer.byte(Tag.Ref); writer.uint(known); continue; }
    objects.set(item, objects.size);
    if (Array.isArray(item)) { writer.byte(Tag.Array); writer.uint(item.length); stack.push({kind: 'properties', value: item, keys: Object.keys(item), index: 0, array: true}); }
    else if (types.isMap(item)) { writer.byte(Tag.Map); stack.push({kind: 'map', iterator: Map.prototype.entries.call(item)}); }
    else if (types.isSet(item)) { writer.byte(Tag.Set); stack.push({kind: 'set', iterator: Set.prototype.values.call(item)}); }
    else if (types.isDate(item)) { writer.byte(Tag.Date); writer.double(Date.prototype.getTime.call(item)); }
    else if (types.isRegExp(item)) {
      writer.byte(Tag.RegExp); string(Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!.call(item));
      let flags = ''; for (const [name, flag] of [['hasIndices','d'],['global','g'],['ignoreCase','i'],['multiline','m'],['dotAll','s'],['unicode','u'],['unicodeSets','v'],['sticky','y']]) if (Object.getOwnPropertyDescriptor(RegExp.prototype, name!)?.get?.call(item)) flags += flag;
      string(flags);
    }
    else if (types.isArrayBuffer(item)) { writer.byte(Tag.ArrayBuffer); writer.uint(item.byteLength); writer.raw(new Uint8Array(item)); }
    else if (ArrayBuffer.isView(item)) {
      const index = Buffer.isBuffer(item) ? 0 : types.isInt8Array(item) ? 1 : types.isUint8Array(item) ? 2 : types.isUint8ClampedArray(item) ? 3 : types.isInt16Array(item) ? 4 : types.isUint16Array(item) ? 5 : types.isInt32Array(item) ? 6 : types.isUint32Array(item) ? 7 : types.isFloat32Array(item) ? 8 : types.isFloat64Array(item) ? 9 : types.isBigInt64Array(item) ? 10 : types.isBigUint64Array(item) ? 11 : 12;
      writer.byte(Tag.View); writer.byte(index); writer.uint(item.byteLength); writer.raw(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
    }
    else if (types.isNumberObject(item)) { writer.byte(Tag.BoxedNumber); writer.double(Number.prototype.valueOf.call(item)); }
    else if (types.isStringObject(item)) { writer.byte(Tag.BoxedString); string(String.prototype.valueOf.call(item)); }
    else if (types.isBooleanObject(item)) { writer.byte(Tag.BoxedBoolean); writer.byte(Boolean.prototype.valueOf.call(item) ? 1 : 0); }
    else if (types.isBigIntObject(item)) { writer.byte(Tag.BoxedBigInt); stack.push({kind: 'value', value: BigInt.prototype.valueOf.call(item)}); }
    else if (types.isNativeError(item)) {
      writer.byte(Tag.Error); const error = item as Error & {cause?: unknown};
      string(['EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError'].includes(error.name) ? error.name : 'Error');
      for (const field of [error.message, error.stack]) { writer.byte(typeof field === 'string' ? 1 : 0); if (typeof field === 'string') string(field); }
      const cause = Object.hasOwn(error, 'cause'); writer.byte(cause ? 1 : 0); if (cause) stack.push({kind: 'value', value: error.cause});
    }
    else {
      if (types.isBoxedPrimitive(item) || types.isExternal(item)) throw Error('Unsupported compiler transport object');
      writer.byte(Tag.Object); stack.push({kind: 'properties', value: item, keys: Object.keys(item), index: 0, array: false});
    }
  }
  if (stats) { stats.objects = objects.size; stats.strings = strings.size; }
  return writer.finish();
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  raw(size: number): Buffer { if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) throw Error('Truncated compiler transport'); const start = this.offset; this.offset += size; return this.bytes.subarray(start, this.offset); }
  byte(): number { return this.raw(1)[0]!; }
  uint(): number {
    let result = 0, scale = 1;
    for (let i = 0; i < 8; i++) { const byte = this.byte(); result += (byte & 127) * scale; if (!Number.isSafeInteger(result)) break; if (byte < 128) { if (i && !byte) break; return result; } scale *= 128; }
    throw Error('Invalid compiler transport integer');
  }
  double(): number { return this.raw(8).readDoubleLE(); }
}
type Frame = {kind: 'object' | 'array'; value: Record<string, unknown>; length?: number; keys: Set<string>} | {kind: 'map'; value: Map<unknown, unknown>} | {kind: 'set'; value: Set<unknown>};

/** Decode only a complete bounded frame; the caller publishes nothing until
 * its existing protocol, graph and actual worker-exit checks also succeed. */
export function decodeTypeScriptPayload(bytes: Buffer, maxBytes: number): unknown {
  limit(maxBytes); if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
  const reader = new Reader(bytes); if (!reader.raw(MAGIC.length).equals(MAGIC)) throw Error('Invalid compiler transport header');
  const objects: object[] = [], strings: string[] = [], tasks: Array<() => void> = [];
  let root: unknown;
  const string = (tag = reader.byte()): string => {
    if (tag === Tag.StringRef) { const known = strings[reader.uint()]; if (known === undefined) throw Error('Invalid compiler string reference'); return known; }
    if (tag !== Tag.String8 && tag !== Tag.String16) throw Error('Invalid compiler property or string');
    const size = reader.uint(), text = reader.raw(size * (tag === Tag.String8 ? 1 : 2)).toString(tag === Tag.String8 ? 'latin1' : 'utf16le'); strings.push(text); return text;
  };
  const frame = (current: Frame): void => {
    const tag = reader.byte(); if (tag === Tag.End) return;
    tasks.push(() => frame(current));
    if (current.kind === 'object' || current.kind === 'array') {
      const key = tag === Tag.Index && current.kind === 'array' ? String(reader.uint()) : string(tag);
      if (current.keys.has(key) || current.kind === 'array' && (key === 'length' || /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff && Number(key) >= current.length!)) throw Error('Invalid or duplicate compiler property');
      current.keys.add(key); tasks.push(() => value(item => {Object.defineProperty(current.value, key, {value: item, writable: true, enumerable: true, configurable: true});}));
    } else if (current.kind === 'set') { reader.offset--; tasks.push(() => value(item => {current.value.add(item);})); }
    else if (current.kind === 'map') {
      const map = current.value;
      reader.offset--; tasks.push(() => value(key => {tasks.push(() => value(item => {if (map.has(key)) throw Error('Duplicate compiler map key'); map.set(key, item);}));}));
    }
  };
  const value = (accept: (item: unknown) => void): void => {
    const tag = reader.byte(); let item: unknown, container: Frame | undefined;
    if (tag === Tag.Undefined) item = undefined;
    else if (tag === Tag.Null) item = null;
    else if (tag === Tag.False || tag === Tag.True) item = tag === Tag.True;
    else if (tag === Tag.Uint || tag === Tag.NegativeInt) { const n = reader.uint(); if (n > (tag === Tag.Uint ? 0xffffffff : 0x80000000) || tag === Tag.NegativeInt && !n) throw Error('Invalid compiler number'); item = tag === Tag.Uint ? n : -n; }
    else if (tag === Tag.Double) item = reader.double();
    else if (tag === Tag.String8 || tag === Tag.String16 || tag === Tag.StringRef) item = string(tag);
    else if (tag === Tag.Ref) { item = objects[reader.uint()]; if (item === undefined) throw Error('Invalid compiler object reference'); }
    else if (tag === Tag.BigInt) { const sign = reader.byte(); if (sign > 1) throw Error('Invalid compiler integer sign'); const hex = reader.raw(reader.uint()).toString('hex'); item = (sign ? -1n : 1n) * BigInt('0x' + (hex || '00')); }
    else {
      if (tag === Tag.Object) { item = {}; container = {kind: 'object', value: item as Record<string, unknown>, keys: new Set()}; }
      else if (tag === Tag.Array) { const length = reader.uint(); if (length > 0xffffffff) throw Error('Invalid compiler array length'); item = new Array(length); container = {kind: 'array', value: item as unknown as Record<string, unknown>, length, keys: new Set()}; }
      else if (tag === Tag.Map) { item = new Map(); container = {kind: 'map', value: item as Map<unknown, unknown>}; }
      else if (tag === Tag.Set) { item = new Set(); container = {kind: 'set', value: item as Set<unknown>}; }
      else if (tag === Tag.Date) item = new Date(reader.double());
      else if (tag === Tag.RegExp) item = new RegExp(string(), string());
      else if (tag === Tag.ArrayBuffer) { const data = reader.raw(reader.uint()); item = Uint8Array.from(data).buffer; }
      else if (tag === Tag.View) {
        const index = reader.byte(), constructor = views[index]; if (!constructor) throw Error('Invalid compiler view');
        const data = reader.raw(reader.uint());
        if (index === 0) item = Buffer.from(data);
        else { const copied = Uint8Array.from(data).buffer; item = index === 12 ? new DataView(copied) : new (constructor as Uint8ArrayConstructor)(copied); }
      }
      else if (tag === Tag.BoxedNumber) item = new Number(reader.double());
      else if (tag === Tag.BoxedString) item = new String(string());
      else if (tag === Tag.BoxedBoolean) { const flag = reader.byte(); if (flag > 1) throw Error('Invalid compiler boolean'); item = new Boolean(flag); }
      else if (tag === Tag.BoxedBigInt) {
        // No object can intervene in a boxed primitive's scalar body.
        const id = objects.length; item = {}; tasks.push(() => value(primitive => {if (typeof primitive !== 'bigint') throw Error('Invalid boxed compiler integer'); const boxed = Object(primitive); objects[id] = boxed; accept(boxed);}));
      }
      else if (tag === Tag.Error) {
        const name = string(), constructors: Record<string, ErrorConstructor> = {Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError};
        if (!Object.hasOwn(constructors, name)) throw Error('Invalid compiler error kind');
        const flags: number[] = [], fields: Array<string | undefined> = [];
        for (let i = 0; i < 2; i++) { const flag = reader.byte(); if (flag > 1) throw Error('Invalid compiler error field'); flags.push(flag); fields.push(flag ? string() : undefined); }
        const error = new constructors[name]!(fields[0]);
        if (!flags[0]) Reflect.deleteProperty(error, 'message');
        if (flags[1]) Object.defineProperty(error, 'stack', {value: fields[1], writable: true, configurable: true}); else delete error.stack;
        const cause = reader.byte(); if (cause > 1) throw Error('Invalid compiler error cause');
        item = error; if (cause) tasks.push(() => value(cause => {Object.defineProperty(error, 'cause', {value: cause, writable: true, configurable: true});}));
      }
      else throw Error('Invalid compiler transport tag');
      objects.push(item as object);
    }
    if (tag !== Tag.BoxedBigInt) accept(item); if (container) tasks.push(() => frame(container!));
  };
  tasks.push(() => value(item => {root = item;})); while (tasks.length) tasks.pop()!();
  if (reader.offset !== bytes.length) throw Error('Trailing compiler transport bytes');
  return root;
}
