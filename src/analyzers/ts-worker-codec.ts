import {types} from 'node:util';

// Private, versioned graph transport. String/object references preserve aliases;
// no metadata, proof, undefined value or original UTF-16 code unit is omitted.
const MAGIC = Buffer.from([0x43, 0x44, 0x54, 1]);
export const TYPESCRIPT_CODEC_BLOCK_BYTES = 64 * 1024;
const STRING_UNITS = 4096;
enum Tag { End, Undefined, Null, False, True, Uint, NegativeInt, Double, String8, String16, StringRef, Ref, Object, Array, Index, Map, Set, BigInt, Date, RegExp, ArrayBuffer, View, BoxedNumber, BoxedString, BoxedBoolean, BoxedBigInt, Error }
const views = [Buffer, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView] as const;
export interface TypeScriptCodecLimits { objects: number; strings: number; properties: number; arraySlots: number; stringUnits: number; binaryBytes: number; depth: number; tasks: number; keysPerObject: number }
export const TYPESCRIPT_CODEC_STRUCTURE_LIMITS: Readonly<TypeScriptCodecLimits> = Object.freeze({objects: 4_194_304, strings: 1_048_576, properties: 16_777_216, arraySlots: 16_777_216, stringUnits: 64 * 1024 * 1024, binaryBytes: 64 * 1024 * 1024, depth: 4096, tasks: 16_384, keysPerObject: 1_048_576});
export interface TypeScriptCodecStats { allocatedBlockBytes: number; concatenatedBytes: number; peakBlockBytes: number; peakStringTemporaryBytes: number; encodedBytes: number; objects: number; strings: number; properties: number; arraySlots: number; stringUnits: number; binaryBytes: number; peakDepth: number; peakTasks: number; peakKeys: number }
export class TypeScriptCodecLimitError extends RangeError {}
export class TypeScriptCodecStructureLimitError extends TypeScriptCodecLimitError {
  constructor(readonly resource: keyof TypeScriptCodecLimits, readonly selectedLimit: number) { super(`TypeScript compiler ${resource} exceeds ${selectedLimit} limit`); }
}
type Pool = 'objects' | 'strings' | 'properties' | 'arraySlots' | 'stringUnits' | 'binaryBytes';
class Budget {
  readonly limits: TypeScriptCodecLimits;
  private readonly used = {objects: 0, strings: 0, properties: 0, arraySlots: 0, stringUnits: 0, binaryBytes: 0};
  constructor(policy?: Partial<TypeScriptCodecLimits>, readonly stats?: TypeScriptCodecStats) {
    const selected = {...TYPESCRIPT_CODEC_STRUCTURE_LIMITS, ...policy};
    for (const key of Object.keys(selected) as Array<keyof TypeScriptCodecLimits>) {
      if (!Object.hasOwn(TYPESCRIPT_CODEC_STRUCTURE_LIMITS, key) || !Number.isSafeInteger(selected[key]) || selected[key] < 1 || selected[key] > TYPESCRIPT_CODEC_STRUCTURE_LIMITS[key]) throw Error('Compiler structural limits must be positive safe integers at or below their fixed defaults');
    }
    this.limits = selected;
    if (stats) Object.assign(stats, {allocatedBlockBytes: 0, concatenatedBytes: 0, peakBlockBytes: 0, peakStringTemporaryBytes: 0, encodedBytes: 0, ...this.used, peakDepth: 0, peakTasks: 0, peakKeys: 0});
  }
  add(pool: Pool, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits[pool] - this.used[pool]) throw new TypeScriptCodecStructureLimitError(pool, this.limits[pool]);
    this.used[pool] += count; if (this.stats) this.stats[pool] = this.used[pool];
  }
  peak(resource: 'depth' | 'tasks' | 'keysPerObject', count: number): void {
    if (count > this.limits[resource]) throw new TypeScriptCodecStructureLimitError(resource, this.limits[resource]);
    const field = resource === 'depth' ? 'peakDepth' : resource === 'tasks' ? 'peakTasks' : 'peakKeys';
    if (this.stats) this.stats[field] = Math.max(this.stats[field], count);
  }
}
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
  text(value: string, latin: boolean): void {
    const width = latin ? 1 : 2;
    this.reserve(value.length * width);
    for (let offset = 0; offset < value.length;) {
      const block = this.room(), units = Math.min(STRING_UNITS, value.length - offset, Math.floor((block.length - this.used) / width));
      if (!units) {
        // A UTF-16 code unit may straddle an odd block boundary. Fill that
        // byte and the next admitted block without padding or a temporary.
        const unit = value.charCodeAt(offset++); this.byte(unit & 255); this.byte(unit >>> 8); continue;
      }
      // Keep the native string slice bounded while writing straight into the
      // admitted output block. No per-string Buffer is allocated or copied.
      const bytes = block.write(value.slice(offset, offset + units), this.used, units * width, latin ? 'latin1' : 'utf16le');
      if (bytes !== units * width) throw Error('Incomplete compiler transport string');
      this.used += bytes; this.bytes += bytes; offset += units;
    }
  }
  double(value: number): void { const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleLE(value); this.raw(bytes); }
  finish(): Buffer {
    if (this.block) this.blocks.push(this.block.subarray(0, this.used));
    if (this.stats) { this.stats.encodedBytes = this.bytes; this.stats.concatenatedBytes = this.bytes; }
    return Buffer.concat(this.blocks, this.bytes);
  }
}
type Task = ({kind: 'value'; value: unknown} | {kind: 'properties'; value: object; keys: string[]; index: number; array: boolean} | {kind: 'map'; iterator: MapIterator<[unknown, unknown]>} | {kind: 'set'; iterator: SetIterator<unknown>}) & {depth: number};

/** String/binary payload bytes are admitted before chunk allocation or writes.
 * Blocks total at most maxBytes; final concatenation adds at most maxBytes.
 * Structure pools and traversal depth/tasks also have fixed logical budgets.
 * Object.keys takes its original own-key snapshot before key admission; that
 * builtin allocation, the caller's graph, native memory and RSS remain separate. */
export function encodeTypeScriptPayload(value: unknown, maxBytes: number, stats?: TypeScriptCodecStats, policy?: Partial<TypeScriptCodecLimits>): Buffer {
  limit(maxBytes);
  const budget = new Budget(policy, stats);
  const writer = new Writer(maxBytes, stats), objects = new Map<object, number>(), strings = new Map<string, number>();
  const string = (text: string): void => {
    if (text.length > maxBytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
    const known = strings.get(text);
    if (known !== undefined) { writer.byte(Tag.StringRef); writer.uint(known); return; }
    let latin = true;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) { latin = false; break; }
    writer.byte(latin ? Tag.String8 : Tag.String16); writer.uint(text.length);
    writer.reserve(text.length * (latin ? 1 : 2));
    budget.add('strings'); budget.add('stringUnits', text.length); strings.set(text, strings.size);
    writer.text(text, latin);
  };
  writer.raw(MAGIC);
  const stack: Task[] = [];
  // Admit the whole ordered batch before scheduling it, without a rest array.
  const push = (task: Task): void => { budget.peak('tasks', stack.length + 1); stack.push(task); };
  const pushPair = (first: Task, second: Task): void => { budget.peak('tasks', stack.length + 2); stack.push(first, second); };
  const pushTriple = (first: Task, second: Task, third: Task): void => { budget.peak('tasks', stack.length + 3); stack.push(first, second, third); };
  const properties = (value: object, array: boolean, depth: number): Task => {
    const keys = Object.keys(value); budget.peak('keysPerObject', keys.length); budget.add('properties', keys.length);
    return {kind: 'properties', value, keys, index: 0, array, depth};
  };
  push({kind: 'value', value, depth: 0});
  while (stack.length) {
    const task = stack.pop()!;
    if (task.kind === 'properties') {
      if (task.index === task.keys.length) { writer.byte(Tag.End); continue; }
      const key = task.keys[task.index++]!;
      if (task.array && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff) { writer.byte(Tag.Index); writer.uint(Number(key)); }
      else string(key);
      // Snapshot enumerable own keys, then read each value once, as cloning does.
      pushPair(task, {kind: 'value', value: (task.value as Record<string, unknown>)[key], depth: task.depth + 1}); continue;
    }
    if (task.kind === 'map') {
      const entry = task.iterator.next();
      if (entry.done) { writer.byte(Tag.End); continue; }
      budget.add('properties', 2); pushTriple(task, {kind: 'value', value: entry.value[1], depth: task.depth + 1}, {kind: 'value', value: entry.value[0], depth: task.depth + 1}); continue;
    }
    if (task.kind === 'set') {
      const entry = task.iterator.next();
      if (entry.done) { writer.byte(Tag.End); continue; }
      budget.add('properties'); pushPair(task, {kind: 'value', value: entry.value, depth: task.depth + 1}); continue;
    }
    budget.peak('depth', task.depth); const item = task.value;
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
      budget.add('binaryBytes', hex.length / 2); writer.uint(hex.length / 2); writer.reserve(hex.length / 2);
      for (let i = 0; i < hex.length; i += STRING_UNITS) writer.raw(Buffer.from(hex.slice(i, i + STRING_UNITS), 'hex'));
      continue;
    }
    if (typeof item !== 'object' || types.isProxy(item) || types.isWeakMap(item) || types.isWeakSet(item) || types.isPromise(item) || types.isSharedArrayBuffer(item) || types.isModuleNamespaceObject(item) || item instanceof WeakRef || item instanceof FinalizationRegistry) throw Error('Unsupported compiler transport value');
    const known = objects.get(item);
    if (known !== undefined) { writer.byte(Tag.Ref); writer.uint(known); continue; }
    budget.add('objects'); objects.set(item, objects.size);
    if (Array.isArray(item)) { budget.add('arraySlots', item.length); writer.byte(Tag.Array); writer.uint(item.length); push(properties(item, true, task.depth)); }
    else if (types.isMap(item)) { writer.byte(Tag.Map); push({kind: 'map', iterator: Map.prototype.entries.call(item), depth: task.depth}); }
    else if (types.isSet(item)) { writer.byte(Tag.Set); push({kind: 'set', iterator: Set.prototype.values.call(item), depth: task.depth}); }
    else if (types.isDate(item)) { writer.byte(Tag.Date); writer.double(Date.prototype.getTime.call(item)); }
    else if (types.isRegExp(item)) {
      writer.byte(Tag.RegExp); string(Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!.call(item));
      let flags = ''; for (const [name, flag] of [['hasIndices','d'],['global','g'],['ignoreCase','i'],['multiline','m'],['dotAll','s'],['unicode','u'],['unicodeSets','v'],['sticky','y']]) if (Object.getOwnPropertyDescriptor(RegExp.prototype, name!)?.get?.call(item)) flags += flag;
      string(flags);
    }
    else if (types.isArrayBuffer(item)) { budget.add('binaryBytes', item.byteLength); writer.byte(Tag.ArrayBuffer); writer.uint(item.byteLength); writer.raw(new Uint8Array(item)); }
    else if (ArrayBuffer.isView(item)) {
      const index = Buffer.isBuffer(item) ? 0 : types.isInt8Array(item) ? 1 : types.isUint8Array(item) ? 2 : types.isUint8ClampedArray(item) ? 3 : types.isInt16Array(item) ? 4 : types.isUint16Array(item) ? 5 : types.isInt32Array(item) ? 6 : types.isUint32Array(item) ? 7 : types.isFloat32Array(item) ? 8 : types.isFloat64Array(item) ? 9 : types.isBigInt64Array(item) ? 10 : types.isBigUint64Array(item) ? 11 : 12;
      budget.add('binaryBytes', item.byteLength); writer.byte(Tag.View); writer.byte(index); writer.uint(item.byteLength); writer.raw(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
    }
    else if (types.isBoxedPrimitive(item)) {
      if (types.isNumberObject(item)) { writer.byte(Tag.BoxedNumber); writer.double(Number.prototype.valueOf.call(item)); }
      else if (types.isStringObject(item)) { writer.byte(Tag.BoxedString); string(String.prototype.valueOf.call(item)); }
      else if (types.isBooleanObject(item)) { writer.byte(Tag.BoxedBoolean); writer.byte(Boolean.prototype.valueOf.call(item) ? 1 : 0); }
      else if (types.isBigIntObject(item)) { writer.byte(Tag.BoxedBigInt); push({kind: 'value', value: BigInt.prototype.valueOf.call(item), depth: task.depth + 1}); }
      else throw Error('Unsupported compiler transport object');
    }
    else if (types.isNativeError(item)) {
      writer.byte(Tag.Error); const error = item as Error & {cause?: unknown};
      string(['EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError'].includes(error.name) ? error.name : 'Error');
      for (const field of [error.message, error.stack]) { writer.byte(typeof field === 'string' ? 1 : 0); if (typeof field === 'string') string(field); }
      const cause = Object.hasOwn(error, 'cause'); writer.byte(cause ? 1 : 0); if (cause) push({kind: 'value', value: error.cause, depth: task.depth + 1});
    }
    else {
      if (types.isExternal(item)) throw Error('Unsupported compiler transport object');
      writer.byte(Tag.Object); push(properties(item, false, task.depth));
    }
  }
  if (stats) { stats.objects = objects.size; stats.strings = strings.size; }
  return writer.finish();
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  raw(size: number): Buffer { if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) throw Error('Truncated compiler transport'); const start = this.offset; this.offset += size; return this.bytes.subarray(start, this.offset); }
  byte(): number { if (this.offset >= this.bytes.length) throw Error('Truncated compiler transport'); return this.bytes[this.offset++]!; }
  uint(): number {
    let result = 0, scale = 1;
    for (let i = 0; i < 8; i++) { const byte = this.byte(); result += (byte & 127) * scale; if (!Number.isSafeInteger(result)) break; if (byte < 128) { if (i && !byte) break; return result; } scale *= 128; }
    throw Error('Invalid compiler transport integer');
  }
  double(): number { if (8 > this.bytes.length - this.offset) throw Error('Truncated compiler transport'); const value = this.bytes.readDoubleLE(this.offset); this.offset += 8; return value; }
  text(size: number, encoding: 'latin1' | 'utf16le'): string { if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) throw Error('Truncated compiler transport'); const start = this.offset; this.offset += size; return this.bytes.toString(encoding, start, this.offset); }
}
type Frame = ({kind: 'object' | 'array'; value: Record<string, unknown>; length?: number; keys: Set<string>} | {kind: 'map'; value: Map<unknown, unknown>} | {kind: 'set'; value: Set<unknown>}) & {depth: number};

/** Decode only a complete bounded frame; the caller publishes nothing until
 * its existing protocol, graph and actual worker-exit checks also succeed. */
export function decodeTypeScriptPayload(bytes: Buffer, maxBytes: number, stats?: TypeScriptCodecStats, policy?: Partial<TypeScriptCodecLimits>): unknown {
  limit(maxBytes); if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
  const budget = new Budget(policy, stats);
  const reader = new Reader(bytes); if (!reader.raw(MAGIC.length).equals(MAGIC)) throw Error('Invalid compiler transport header');
  const objects: object[] = [], strings: string[] = [], tasks: Array<() => void> = [];
  const push = (...pending: Array<() => void>): void => { budget.peak('tasks', tasks.length + pending.length); tasks.push(...pending); };
  let root: unknown;
  const string = (tag = reader.byte()): string => {
    if (tag === Tag.StringRef) { const known = strings[reader.uint()]; if (known === undefined) throw Error('Invalid compiler string reference'); return known; }
    if (tag !== Tag.String8 && tag !== Tag.String16) throw Error('Invalid compiler property or string');
    const size = reader.uint(); budget.add('strings'); budget.add('stringUnits', size);
    const text = reader.text(size * (tag === Tag.String8 ? 1 : 2), tag === Tag.String8 ? 'latin1' : 'utf16le'); strings.push(text); return text;
  };
  const frame = (current: Frame): void => {
    // Restore inheritance only after every original own field is complete.
    const tag = reader.byte(); if (tag === Tag.End) {if (current.kind === 'object') Object.setPrototypeOf(current.value, Object.prototype); return;}
    push(() => frame(current));
    if (current.kind === 'object' || current.kind === 'array') {
      const key = tag === Tag.Index && current.kind === 'array' ? String(reader.uint()) : string(tag);
      if (current.keys.has(key) || current.kind === 'array' && (key === 'length' || /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff && Number(key) >= current.length!)) throw Error('Invalid or duplicate compiler property');
      budget.peak('keysPerObject', current.keys.size + 1); budget.add('properties');
      current.keys.add(key); push(() => value(item => {if (current.kind === 'object') current.value[key] = item; else Object.defineProperty(current.value, key, {value: item, writable: true, enumerable: true, configurable: true});}, current.depth + 1));
    } else if (current.kind === 'set') { budget.add('properties'); reader.offset--; push(() => value(item => {current.value.add(item);}, current.depth + 1)); }
    else if (current.kind === 'map') {
      const map = current.value;
      budget.add('properties', 2); reader.offset--; push(() => value(key => {push(() => value(item => {if (map.has(key)) throw Error('Duplicate compiler map key'); map.set(key, item);}, current.depth + 1));}, current.depth + 1));
    }
  };
  const value = (accept: (item: unknown) => void, depth: number): void => {
    budget.peak('depth', depth); const tag = reader.byte(); let item: unknown, container: Frame | undefined;
    if (tag === Tag.Undefined) item = undefined;
    else if (tag === Tag.Null) item = null;
    else if (tag === Tag.False || tag === Tag.True) item = tag === Tag.True;
    else if (tag === Tag.Uint || tag === Tag.NegativeInt) { const n = reader.uint(); if (n > (tag === Tag.Uint ? 0xffffffff : 0x80000000) || tag === Tag.NegativeInt && !n) throw Error('Invalid compiler number'); item = tag === Tag.Uint ? n : -n; }
    else if (tag === Tag.Double) item = reader.double();
    else if (tag === Tag.String8 || tag === Tag.String16 || tag === Tag.StringRef) item = string(tag);
    else if (tag === Tag.Ref) { item = objects[reader.uint()]; if (item === undefined) throw Error('Invalid compiler object reference'); }
    else if (tag === Tag.BigInt) { const sign = reader.byte(); if (sign > 1) throw Error('Invalid compiler integer sign'); const size = reader.uint(); budget.add('binaryBytes', size); const hex = reader.raw(size).toString('hex'); item = (sign ? -1n : 1n) * BigInt('0x' + (hex || '00')); }
    else {
      budget.add('objects');
      // Keep ordinary-object writes inert to inherited setters/read-only fields.
      if (tag === Tag.Object) { item = Object.setPrototypeOf({}, null); container = {kind: 'object', value: item as Record<string, unknown>, keys: new Set(), depth}; }
      else if (tag === Tag.Array) { const length = reader.uint(); if (length > 0xffffffff) throw Error('Invalid compiler array length'); budget.add('arraySlots', length); item = new Array(length); container = {kind: 'array', value: item as unknown as Record<string, unknown>, length, keys: new Set(), depth}; }
      else if (tag === Tag.Map) { item = new Map(); container = {kind: 'map', value: item as Map<unknown, unknown>, depth}; }
      else if (tag === Tag.Set) { item = new Set(); container = {kind: 'set', value: item as Set<unknown>, depth}; }
      else if (tag === Tag.Date) item = new Date(reader.double());
      else if (tag === Tag.RegExp) item = new RegExp(string(), string());
      else if (tag === Tag.ArrayBuffer) { const size = reader.uint(); budget.add('binaryBytes', size); const data = reader.raw(size); item = Uint8Array.from(data).buffer; }
      else if (tag === Tag.View) {
        const index = reader.byte(), constructor = views[index]; if (!constructor) throw Error('Invalid compiler view');
        const size = reader.uint(); budget.add('binaryBytes', size); const data = reader.raw(size);
        if (index === 0) item = Buffer.from(data);
        else { const copied = Uint8Array.from(data).buffer; item = index === 12 ? new DataView(copied) : new (constructor as Uint8ArrayConstructor)(copied); }
      }
      else if (tag === Tag.BoxedNumber) item = new Number(reader.double());
      else if (tag === Tag.BoxedString) item = new String(string());
      else if (tag === Tag.BoxedBoolean) { const flag = reader.byte(); if (flag > 1) throw Error('Invalid compiler boolean'); item = new Boolean(flag); }
      else if (tag === Tag.BoxedBigInt) {
        // No object can intervene in a boxed primitive's scalar body.
        const id = objects.length; item = {}; push(() => value(primitive => {if (typeof primitive !== 'bigint') throw Error('Invalid boxed compiler integer'); const boxed = Object(primitive); objects[id] = boxed; accept(boxed);}, depth + 1));
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
        item = error; if (cause) push(() => value(cause => {Object.defineProperty(error, 'cause', {value: cause, writable: true, configurable: true});}, depth + 1));
      }
      else throw Error('Invalid compiler transport tag');
      objects.push(item as object);
    }
    if (tag !== Tag.BoxedBigInt) accept(item); if (container) push(() => frame(container!));
  };
  push(() => value(item => {root = item;}, 0)); while (tasks.length) tasks.pop()!();
  if (reader.offset !== bytes.length) throw Error('Trailing compiler transport bytes');
  return root;
}
