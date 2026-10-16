// Generated from Codiluce’s typed source-only parser. Do not edit.
// Rebuild: npm run build:script-worker

// src/analyzers/ts-worker-codec.ts
import { types } from "node:util";
var MAGIC = Buffer.from([67, 68, 84, 1]);
var TYPESCRIPT_CODEC_BLOCK_BYTES = 64 * 1024;
var STRING_UNITS = 4096;
var views = [Buffer, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView];
var TYPESCRIPT_CODEC_STRUCTURE_LIMITS = Object.freeze({ objects: 4194304, strings: 1048576, properties: 16777216, arraySlots: 16777216, stringUnits: 64 * 1024 * 1024, binaryBytes: 64 * 1024 * 1024, depth: 4096, tasks: 16384, keysPerObject: 1048576 });
var TypeScriptCodecLimitError = class extends RangeError {
};
var TypeScriptCodecStructureLimitError = class extends TypeScriptCodecLimitError {
  constructor(resource, selectedLimit) {
    super(`TypeScript compiler ${resource} exceeds ${selectedLimit} limit`);
    this.resource = resource;
    this.selectedLimit = selectedLimit;
  }
  resource;
  selectedLimit;
};
var Budget = class {
  constructor(policy, stats) {
    this.stats = stats;
    const selected = { ...TYPESCRIPT_CODEC_STRUCTURE_LIMITS, ...policy };
    for (const key of Object.keys(selected)) {
      if (!Object.hasOwn(TYPESCRIPT_CODEC_STRUCTURE_LIMITS, key) || !Number.isSafeInteger(selected[key]) || selected[key] < 1 || selected[key] > TYPESCRIPT_CODEC_STRUCTURE_LIMITS[key]) throw Error("Compiler structural limits must be positive safe integers at or below their fixed defaults");
    }
    this.limits = selected;
    if (stats) Object.assign(stats, { allocatedBlockBytes: 0, concatenatedBytes: 0, peakBlockBytes: 0, peakStringTemporaryBytes: 0, encodedBytes: 0, ...this.used, peakDepth: 0, peakTasks: 0, peakKeys: 0 });
  }
  stats;
  limits;
  used = { objects: 0, strings: 0, properties: 0, arraySlots: 0, stringUnits: 0, binaryBytes: 0 };
  add(pool, count = 1) {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits[pool] - this.used[pool]) throw new TypeScriptCodecStructureLimitError(pool, this.limits[pool]);
    this.used[pool] += count;
    if (this.stats) this.stats[pool] = this.used[pool];
  }
  peak(resource, count) {
    if (count > this.limits[resource]) throw new TypeScriptCodecStructureLimitError(resource, this.limits[resource]);
    const field = resource === "depth" ? "peakDepth" : resource === "tasks" ? "peakTasks" : "peakKeys";
    if (this.stats) this.stats[field] = Math.max(this.stats[field], count);
  }
};
function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw Error("TypeScript codec limit requires a positive safe integer");
}
var Writer = class {
  constructor(max, stats) {
    this.max = max;
    this.stats = stats;
  }
  max;
  stats;
  blocks = [];
  bytes = 0;
  block;
  used = 0;
  reserve(size2) {
    if (!Number.isSafeInteger(size2) || size2 < 0 || size2 > this.max - this.bytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${this.max} bytes`);
  }
  room() {
    if (!this.block || this.used === this.block.length) {
      if (this.block) this.blocks.push(this.block);
      this.block = Buffer.allocUnsafe(Math.min(TYPESCRIPT_CODEC_BLOCK_BYTES, this.max - this.bytes));
      this.used = 0;
      if (this.stats) {
        this.stats.allocatedBlockBytes += this.block.length;
        this.stats.peakBlockBytes = Math.max(this.stats.peakBlockBytes, this.block.length);
      }
    }
    return this.block;
  }
  byte(value) {
    this.reserve(1);
    this.room()[this.used++] = value;
    this.bytes++;
  }
  uint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid compiler transport integer");
    do {
      const digit = value % 128;
      value = Math.floor(value / 128);
      this.byte(digit + (value ? 128 : 0));
    } while (value);
  }
  raw(value) {
    this.reserve(value.byteLength);
    for (let offset = 0; offset < value.byteLength; ) {
      const block = this.room(), size2 = Math.min(block.length - this.used, value.byteLength - offset);
      block.set(value.subarray(offset, offset + size2), this.used);
      this.used += size2;
      this.bytes += size2;
      offset += size2;
    }
  }
  text(value, latin) {
    const width = latin ? 1 : 2;
    this.reserve(value.length * width);
    for (let offset = 0; offset < value.length; ) {
      const block = this.room(), units = Math.min(STRING_UNITS, value.length - offset, Math.floor((block.length - this.used) / width));
      if (!units) {
        const unit = value.charCodeAt(offset++);
        this.byte(unit & 255);
        this.byte(unit >>> 8);
        continue;
      }
      const bytes = block.write(value.slice(offset, offset + units), this.used, units * width, latin ? "latin1" : "utf16le");
      if (bytes !== units * width) throw Error("Incomplete compiler transport string");
      this.used += bytes;
      this.bytes += bytes;
      offset += units;
    }
  }
  double(value) {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleLE(value);
    this.raw(bytes);
  }
  finish() {
    if (this.block) this.blocks.push(this.block.subarray(0, this.used));
    if (this.stats) {
      this.stats.encodedBytes = this.bytes;
      this.stats.concatenatedBytes = this.bytes;
    }
    return Buffer.concat(this.blocks, this.bytes);
  }
};
function encodeTypeScriptPayload(value, maxBytes, stats, policy) {
  limit(maxBytes);
  const budget = new Budget(policy, stats);
  const writer = new Writer(maxBytes, stats), objects = /* @__PURE__ */ new Map(), strings = /* @__PURE__ */ new Map();
  const string = (text) => {
    if (text.length > maxBytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
    const known = strings.get(text);
    if (known !== void 0) {
      writer.byte(10 /* StringRef */);
      writer.uint(known);
      return;
    }
    let latin = true;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) {
      latin = false;
      break;
    }
    writer.byte(latin ? 8 /* String8 */ : 9 /* String16 */);
    writer.uint(text.length);
    writer.reserve(text.length * (latin ? 1 : 2));
    budget.add("strings");
    budget.add("stringUnits", text.length);
    strings.set(text, strings.size);
    writer.text(text, latin);
  };
  writer.raw(MAGIC);
  const stack = [];
  const push = (task) => {
    budget.peak("tasks", stack.length + 1);
    stack.push(task);
  };
  const pushPair = (first, second) => {
    budget.peak("tasks", stack.length + 2);
    stack.push(first, second);
  };
  const pushTriple = (first, second, third) => {
    budget.peak("tasks", stack.length + 3);
    stack.push(first, second, third);
  };
  const properties = (value2, array, depth) => {
    const keys = Object.keys(value2);
    budget.peak("keysPerObject", keys.length);
    budget.add("properties", keys.length);
    return { kind: "properties", value: value2, keys, index: 0, array, depth };
  };
  push({ kind: "value", value, depth: 0 });
  while (stack.length) {
    const task = stack.pop();
    if (task.kind === "properties") {
      if (task.index === task.keys.length) {
        writer.byte(0 /* End */);
        continue;
      }
      const key = task.keys[task.index++];
      if (task.array && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295) {
        writer.byte(14 /* Index */);
        writer.uint(Number(key));
      } else string(key);
      pushPair(task, { kind: "value", value: task.value[key], depth: task.depth + 1 });
      continue;
    }
    if (task.kind === "map") {
      const entry = task.iterator.next();
      if (entry.done) {
        writer.byte(0 /* End */);
        continue;
      }
      budget.add("properties", 2);
      pushTriple(task, { kind: "value", value: entry.value[1], depth: task.depth + 1 }, { kind: "value", value: entry.value[0], depth: task.depth + 1 });
      continue;
    }
    if (task.kind === "set") {
      const entry = task.iterator.next();
      if (entry.done) {
        writer.byte(0 /* End */);
        continue;
      }
      budget.add("properties");
      pushPair(task, { kind: "value", value: entry.value, depth: task.depth + 1 });
      continue;
    }
    budget.peak("depth", task.depth);
    const item = task.value;
    if (item === void 0) {
      writer.byte(1 /* Undefined */);
      continue;
    }
    if (item === null) {
      writer.byte(2 /* Null */);
      continue;
    }
    if (typeof item === "boolean") {
      writer.byte(item ? 4 /* True */ : 3 /* False */);
      continue;
    }
    if (typeof item === "string") {
      string(item);
      continue;
    }
    if (typeof item === "number") {
      if (Number.isInteger(item) && !Object.is(item, -0) && item >= 0 && item <= 4294967295) {
        writer.byte(5 /* Uint */);
        writer.uint(item);
      } else if (Number.isInteger(item) && item < 0 && item >= -2147483648) {
        writer.byte(6 /* NegativeInt */);
        writer.uint(-item);
      } else {
        writer.byte(7 /* Double */);
        writer.double(item);
      }
      continue;
    }
    if (typeof item === "bigint") {
      writer.byte(17 /* BigInt */);
      writer.byte(item < 0n ? 1 : 0);
      const bits = (writer.max - writer.bytes) * 8;
      if ((item < 0n ? BigInt.asIntN(bits + 1, item) : BigInt.asUintN(bits, item)) !== item) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
      let hex = (item < 0n ? -item : item).toString(16);
      if (hex.length % 2) hex = "0" + hex;
      budget.add("binaryBytes", hex.length / 2);
      writer.uint(hex.length / 2);
      writer.reserve(hex.length / 2);
      for (let i = 0; i < hex.length; i += STRING_UNITS) writer.raw(Buffer.from(hex.slice(i, i + STRING_UNITS), "hex"));
      continue;
    }
    if (typeof item !== "object" || types.isProxy(item) || types.isWeakMap(item) || types.isWeakSet(item) || types.isPromise(item) || types.isSharedArrayBuffer(item) || types.isModuleNamespaceObject(item) || item instanceof WeakRef || item instanceof FinalizationRegistry) throw Error("Unsupported compiler transport value");
    const known = objects.get(item);
    if (known !== void 0) {
      writer.byte(11 /* Ref */);
      writer.uint(known);
      continue;
    }
    budget.add("objects");
    objects.set(item, objects.size);
    if (Array.isArray(item)) {
      budget.add("arraySlots", item.length);
      writer.byte(13 /* Array */);
      writer.uint(item.length);
      push(properties(item, true, task.depth));
    } else if (types.isMap(item)) {
      writer.byte(15 /* Map */);
      push({ kind: "map", iterator: Map.prototype.entries.call(item), depth: task.depth });
    } else if (types.isSet(item)) {
      writer.byte(16 /* Set */);
      push({ kind: "set", iterator: Set.prototype.values.call(item), depth: task.depth });
    } else if (types.isDate(item)) {
      writer.byte(18 /* Date */);
      writer.double(Date.prototype.getTime.call(item));
    } else if (types.isRegExp(item)) {
      writer.byte(19 /* RegExp */);
      string(Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get.call(item));
      let flags = "";
      for (const [name, flag] of [["hasIndices", "d"], ["global", "g"], ["ignoreCase", "i"], ["multiline", "m"], ["dotAll", "s"], ["unicode", "u"], ["unicodeSets", "v"], ["sticky", "y"]]) if (Object.getOwnPropertyDescriptor(RegExp.prototype, name)?.get?.call(item)) flags += flag;
      string(flags);
    } else if (types.isArrayBuffer(item)) {
      budget.add("binaryBytes", item.byteLength);
      writer.byte(20 /* ArrayBuffer */);
      writer.uint(item.byteLength);
      writer.raw(new Uint8Array(item));
    } else if (ArrayBuffer.isView(item)) {
      const index = Buffer.isBuffer(item) ? 0 : types.isInt8Array(item) ? 1 : types.isUint8Array(item) ? 2 : types.isUint8ClampedArray(item) ? 3 : types.isInt16Array(item) ? 4 : types.isUint16Array(item) ? 5 : types.isInt32Array(item) ? 6 : types.isUint32Array(item) ? 7 : types.isFloat32Array(item) ? 8 : types.isFloat64Array(item) ? 9 : types.isBigInt64Array(item) ? 10 : types.isBigUint64Array(item) ? 11 : 12;
      budget.add("binaryBytes", item.byteLength);
      writer.byte(21 /* View */);
      writer.byte(index);
      writer.uint(item.byteLength);
      writer.raw(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
    } else if (types.isNumberObject(item)) {
      writer.byte(22 /* BoxedNumber */);
      writer.double(Number.prototype.valueOf.call(item));
    } else if (types.isStringObject(item)) {
      writer.byte(23 /* BoxedString */);
      string(String.prototype.valueOf.call(item));
    } else if (types.isBooleanObject(item)) {
      writer.byte(24 /* BoxedBoolean */);
      writer.byte(Boolean.prototype.valueOf.call(item) ? 1 : 0);
    } else if (types.isBigIntObject(item)) {
      writer.byte(25 /* BoxedBigInt */);
      push({ kind: "value", value: BigInt.prototype.valueOf.call(item), depth: task.depth + 1 });
    } else if (types.isNativeError(item)) {
      writer.byte(26 /* Error */);
      const error = item;
      string(["EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"].includes(error.name) ? error.name : "Error");
      for (const field of [error.message, error.stack]) {
        writer.byte(typeof field === "string" ? 1 : 0);
        if (typeof field === "string") string(field);
      }
      const cause = Object.hasOwn(error, "cause");
      writer.byte(cause ? 1 : 0);
      if (cause) push({ kind: "value", value: error.cause, depth: task.depth + 1 });
    } else {
      if (types.isBoxedPrimitive(item) || types.isExternal(item)) throw Error("Unsupported compiler transport object");
      writer.byte(12 /* Object */);
      push(properties(item, false, task.depth));
    }
  }
  if (stats) {
    stats.objects = objects.size;
    stats.strings = strings.size;
  }
  return writer.finish();
}
var Reader = class {
  constructor(bytes) {
    this.bytes = bytes;
  }
  bytes;
  offset = 0;
  raw(size2) {
    if (!Number.isSafeInteger(size2) || size2 < 0 || size2 > this.bytes.length - this.offset) throw Error("Truncated compiler transport");
    const start = this.offset;
    this.offset += size2;
    return this.bytes.subarray(start, this.offset);
  }
  byte() {
    if (this.offset >= this.bytes.length) throw Error("Truncated compiler transport");
    return this.bytes[this.offset++];
  }
  uint() {
    let result = 0, scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.byte();
      result += (byte & 127) * scale;
      if (!Number.isSafeInteger(result)) break;
      if (byte < 128) {
        if (i && !byte) break;
        return result;
      }
      scale *= 128;
    }
    throw Error("Invalid compiler transport integer");
  }
  double() {
    if (8 > this.bytes.length - this.offset) throw Error("Truncated compiler transport");
    const value = this.bytes.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }
  text(size2, encoding) {
    if (!Number.isSafeInteger(size2) || size2 < 0 || size2 > this.bytes.length - this.offset) throw Error("Truncated compiler transport");
    const start = this.offset;
    this.offset += size2;
    return this.bytes.toString(encoding, start, this.offset);
  }
};
function decodeTypeScriptPayload(bytes, maxBytes, stats, policy) {
  limit(maxBytes);
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw new TypeScriptCodecLimitError(`TypeScript compiler payload exceeds ${maxBytes} bytes`);
  const budget = new Budget(policy, stats);
  const reader = new Reader(bytes);
  if (!reader.raw(MAGIC.length).equals(MAGIC)) throw Error("Invalid compiler transport header");
  const objects = [], strings = [], tasks = [];
  const push = (...pending2) => {
    budget.peak("tasks", tasks.length + pending2.length);
    tasks.push(...pending2);
  };
  let root;
  const string = (tag = reader.byte()) => {
    if (tag === 10 /* StringRef */) {
      const known = strings[reader.uint()];
      if (known === void 0) throw Error("Invalid compiler string reference");
      return known;
    }
    if (tag !== 8 /* String8 */ && tag !== 9 /* String16 */) throw Error("Invalid compiler property or string");
    const size2 = reader.uint();
    budget.add("strings");
    budget.add("stringUnits", size2);
    const text = reader.text(size2 * (tag === 8 /* String8 */ ? 1 : 2), tag === 8 /* String8 */ ? "latin1" : "utf16le");
    strings.push(text);
    return text;
  };
  const frame = (current) => {
    const tag = reader.byte();
    if (tag === 0 /* End */) return;
    push(() => frame(current));
    if (current.kind === "object" || current.kind === "array") {
      const key = tag === 14 /* Index */ && current.kind === "array" ? String(reader.uint()) : string(tag);
      if (current.keys.has(key) || current.kind === "array" && (key === "length" || /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295 && Number(key) >= current.length)) throw Error("Invalid or duplicate compiler property");
      budget.peak("keysPerObject", current.keys.size + 1);
      budget.add("properties");
      current.keys.add(key);
      push(() => value((item) => {
        Object.defineProperty(current.value, key, { value: item, writable: true, enumerable: true, configurable: true });
      }, current.depth + 1));
    } else if (current.kind === "set") {
      budget.add("properties");
      reader.offset--;
      push(() => value((item) => {
        current.value.add(item);
      }, current.depth + 1));
    } else if (current.kind === "map") {
      const map = current.value;
      budget.add("properties", 2);
      reader.offset--;
      push(() => value((key) => {
        push(() => value((item) => {
          if (map.has(key)) throw Error("Duplicate compiler map key");
          map.set(key, item);
        }, current.depth + 1));
      }, current.depth + 1));
    }
  };
  const value = (accept, depth) => {
    budget.peak("depth", depth);
    const tag = reader.byte();
    let item, container;
    if (tag === 1 /* Undefined */) item = void 0;
    else if (tag === 2 /* Null */) item = null;
    else if (tag === 3 /* False */ || tag === 4 /* True */) item = tag === 4 /* True */;
    else if (tag === 5 /* Uint */ || tag === 6 /* NegativeInt */) {
      const n = reader.uint();
      if (n > (tag === 5 /* Uint */ ? 4294967295 : 2147483648) || tag === 6 /* NegativeInt */ && !n) throw Error("Invalid compiler number");
      item = tag === 5 /* Uint */ ? n : -n;
    } else if (tag === 7 /* Double */) item = reader.double();
    else if (tag === 8 /* String8 */ || tag === 9 /* String16 */ || tag === 10 /* StringRef */) item = string(tag);
    else if (tag === 11 /* Ref */) {
      item = objects[reader.uint()];
      if (item === void 0) throw Error("Invalid compiler object reference");
    } else if (tag === 17 /* BigInt */) {
      const sign = reader.byte();
      if (sign > 1) throw Error("Invalid compiler integer sign");
      const size2 = reader.uint();
      budget.add("binaryBytes", size2);
      const hex = reader.raw(size2).toString("hex");
      item = (sign ? -1n : 1n) * BigInt("0x" + (hex || "00"));
    } else {
      budget.add("objects");
      if (tag === 12 /* Object */) {
        item = {};
        container = { kind: "object", value: item, keys: /* @__PURE__ */ new Set(), depth };
      } else if (tag === 13 /* Array */) {
        const length = reader.uint();
        if (length > 4294967295) throw Error("Invalid compiler array length");
        budget.add("arraySlots", length);
        item = new Array(length);
        container = { kind: "array", value: item, length, keys: /* @__PURE__ */ new Set(), depth };
      } else if (tag === 15 /* Map */) {
        item = /* @__PURE__ */ new Map();
        container = { kind: "map", value: item, depth };
      } else if (tag === 16 /* Set */) {
        item = /* @__PURE__ */ new Set();
        container = { kind: "set", value: item, depth };
      } else if (tag === 18 /* Date */) item = new Date(reader.double());
      else if (tag === 19 /* RegExp */) item = new RegExp(string(), string());
      else if (tag === 20 /* ArrayBuffer */) {
        const size2 = reader.uint();
        budget.add("binaryBytes", size2);
        const data = reader.raw(size2);
        item = Uint8Array.from(data).buffer;
      } else if (tag === 21 /* View */) {
        const index = reader.byte(), constructor = views[index];
        if (!constructor) throw Error("Invalid compiler view");
        const size2 = reader.uint();
        budget.add("binaryBytes", size2);
        const data = reader.raw(size2);
        if (index === 0) item = Buffer.from(data);
        else {
          const copied = Uint8Array.from(data).buffer;
          item = index === 12 ? new DataView(copied) : new constructor(copied);
        }
      } else if (tag === 22 /* BoxedNumber */) item = new Number(reader.double());
      else if (tag === 23 /* BoxedString */) item = new String(string());
      else if (tag === 24 /* BoxedBoolean */) {
        const flag = reader.byte();
        if (flag > 1) throw Error("Invalid compiler boolean");
        item = new Boolean(flag);
      } else if (tag === 25 /* BoxedBigInt */) {
        const id = objects.length;
        item = {};
        push(() => value((primitive) => {
          if (typeof primitive !== "bigint") throw Error("Invalid boxed compiler integer");
          const boxed = Object(primitive);
          objects[id] = boxed;
          accept(boxed);
        }, depth + 1));
      } else if (tag === 26 /* Error */) {
        const name = string(), constructors = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
        if (!Object.hasOwn(constructors, name)) throw Error("Invalid compiler error kind");
        const flags = [], fields = [];
        for (let i = 0; i < 2; i++) {
          const flag = reader.byte();
          if (flag > 1) throw Error("Invalid compiler error field");
          flags.push(flag);
          fields.push(flag ? string() : void 0);
        }
        const error = new constructors[name](fields[0]);
        if (!flags[0]) Reflect.deleteProperty(error, "message");
        if (flags[1]) Object.defineProperty(error, "stack", { value: fields[1], writable: true, configurable: true });
        else delete error.stack;
        const cause = reader.byte();
        if (cause > 1) throw Error("Invalid compiler error cause");
        item = error;
        if (cause) push(() => value((cause2) => {
          Object.defineProperty(error, "cause", { value: cause2, writable: true, configurable: true });
        }, depth + 1));
      } else throw Error("Invalid compiler transport tag");
      objects.push(item);
    }
    if (tag !== 25 /* BoxedBigInt */) accept(item);
    if (container) push(() => frame(container));
  };
  push(() => value((item) => {
    root = item;
  }, 0));
  while (tasks.length) tasks.pop()();
  if (reader.offset !== bytes.length) throw Error("Trailing compiler transport bytes");
  return root;
}

// src/analysis/tree-sitter/frames.ts
var PARSER_FRAME_BYTES = 64 * 1024 * 1024;
var PARSER_FRAME_ENCODING = "bounded-v1";
var ParserFrameLimitError = class extends RangeError {
};
function size(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > PARSER_FRAME_BYTES) throw Error("Parser frame limit must be a positive safe integer at or below 67108864 bytes");
}
function bounded(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TypeScriptCodecLimitError) throw new ParserFrameLimitError(error.message.replace(/^TypeScript compiler/, "Parser facts"));
    throw error;
  }
}
function encodeParserFrame(value, maxBytes = PARSER_FRAME_BYTES, stats, limits) {
  size(maxBytes);
  return bounded(() => encodeTypeScriptPayload(value, maxBytes, stats, limits));
}
function decodeParserFrame(bytes, maxBytes = PARSER_FRAME_BYTES, stats, limits) {
  size(maxBytes);
  return bounded(() => decodeTypeScriptPayload(bytes, maxBytes, stats, limits));
}
function parserJob(message) {
  if (message.encoding === void 0) return message;
  if (message.encoding !== PARSER_FRAME_ENCODING || !Buffer.isBuffer(message.payload)) throw Error("Invalid parser request encoding");
  const value = decodeParserFrame(message.payload);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid parser request");
  return { ...value, id: message.id };
}
function replyParserFrame(id, response) {
  let payload;
  try {
    payload = encodeParserFrame(response);
  } catch (error) {
    payload = encodeParserFrame({ error: error instanceof Error ? error.message : String(error), fatal: true });
  }
  process.send?.({ id, type: "completed", completedAtNs: process.hrtime.bigint().toString(), bytes: payload.byteLength, encoding: PARSER_FRAME_ENCODING });
  process.send?.({ id, type: "result", payload, encoding: PARSER_FRAME_ENCODING });
}

// src/analysis/source-map.ts
var SourceText = class {
  constructor(text) {
    this.text = text;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      } else if (code === 10 || code === 8232 || code === 8233) this.starts.push(i + 1);
    }
  }
  text;
  starts = [0];
  position(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.text.length) throw new Error("Source offset outside text");
    let low = 0, high = this.starts.length;
    while (low + 1 < high) {
      const mid = low + high >>> 1;
      if (this.starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { line: low + 1, column: offset - this.starts[low] + 1 };
  }
  range(start, end) {
    if (end < start) throw new Error("Source range is reversed");
    const from = this.position(start), to = this.position(end);
    return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
  }
  region(start, end) {
    this.range(start, end);
    return { text: this.text.slice(start, end), start, end, range: (from, to) => {
      if (from < 0 || to < from || to > end - start) throw new Error("Region range outside source");
      return this.range(start + from, start + to);
    } };
  }
};

// src/analysis/tree-sitter/template-facts.ts
var MAX_ISSUES = 100;
function erbIssue(facts, code, reason, range) {
  if (facts.issues.length < MAX_ISSUES) facts.issues.push({ code, reason, ...range ? { range } : {} });
  else facts.truncated = true;
}
function finishErb(facts) {
  if (facts.truncated && !facts.issues.some((i) => i.code === "erb-budget-exceeded")) {
    if (facts.issues.length === MAX_ISSUES) facts.issues.pop();
    facts.issues.push({ code: "erb-budget-exceeded", reason: "Original ERB extraction reached its node, region, declaration, header, context, diagnostic or query budget" });
  }
  facts.erb.complete = !facts.issues.length && !facts.truncated && facts.erb.rubyComplete && facts.erb.host.complete;
  return facts;
}
function razorIssue(facts, code, reason, range) {
  if (facts.issues.length < 100) facts.issues.push({ code, reason, ...range ? { range } : {} });
  else facts.truncated = true;
}
function finishRazor(facts) {
  if (facts.truncated) {
    facts.razor.csharpComplete = false;
    if (facts.issues.length === 100) facts.issues.pop();
    razorIssue(facts, "razor-budget-exceeded", "Original Razor extraction reached its node, region, declaration, header, context, diagnostic or query budget");
  }
  facts.razor.complete = !facts.truncated && !facts.issues.length && facts.razor.csharpComplete && facts.razor.host.complete;
  return facts;
}
function finishLiquid(facts) {
  const syntax = facts.liquid;
  if (facts.truncated) {
    syntax.host.complete = false;
    syntax.nativeComplete = false;
    if (!facts.issues.some((i) => i.code === "liquid-budget-exceeded")) {
      if (facts.issues.length === 100) facts.issues.pop();
      facts.issues.push({ code: "liquid-budget-exceeded", reason: "Original Liquid extraction reached its node, depth, region, binding, import, diagnostic or query budget" });
    }
  }
  syntax.complete = !facts.truncated && !facts.issues.length && syntax.nativeComplete && syntax.host.complete;
  return facts;
}

// src/analysis/tree-sitter/erb-script.ts
function extractLiteralScripts(compiler, content, facts, template) {
  const syntax = facts[template];
  const issue = (code, reason, range) => erbIssue(facts, code.replace(/^erb-/, template + "-"), reason, range);
  const original = new SourceText(content);
  let ordinal = 0;
  for (const region of syntax.host.regions.filter((r) => r.kind === "script")) {
    const key = `script:${ordinal++}`;
    if (!region.supported || region.language !== "javascript") continue;
    const text = content.slice(region.bodyStart, region.bodyEnd), source = compiler.createSourceFile("original-inline-script.js", text, compiler.ScriptTarget.Latest, true, compiler.ScriptKind.JS), offset = region.bodyStart;
    if (source.parseDiagnostics.length) {
      region.supported = false;
      syntax.host.complete = false;
      issue("erb-script-parse-gap", "Literal original JavaScript failed parsing; this script is quarantined without affecting other source regions", region.bodyRange);
      continue;
    }
    const program = compiler.createProgram([source.fileName], { allowJs: true, noResolve: true, noLib: true, noEmit: true }, { getSourceFile: (name) => name === source.fileName ? source : void 0, getDefaultLibFileName: () => "", writeFile: () => {
    }, getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (name) => name === source.fileName, readFile: (name) => name === source.fileName ? text : void 0, getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n" });
    if (program.getSyntacticDiagnostics(source).length) {
      region.supported = false;
      syntax.host.complete = false;
      issue("erb-script-processor-gap", "Literal script contains syntax outside JavaScript; a qualified source processor is required and this script is quarantined", region.bodyRange);
      continue;
    }
    if (compiler.isExternalModule(source) && region.attributes.find((a) => a.name.toLowerCase() === "type")?.value?.trim().toLowerCase() !== "module") {
      region.supported = false;
      syntax.host.complete = false;
      issue("erb-script-module-gap", "Literal import/export syntax requires an explicit module script type; client declarations are quarantined", region.bodyRange);
      continue;
    }
    let count = 0;
    const claimedInitializers = /* @__PURE__ */ new Set(), pending2 = [{ node: source, blocked: false, depth: 0 }];
    while (pending2.length) {
      const item = pending2.pop(), node = item.node;
      let parent = item.parent, blocked = item.blocked;
      if (++count > 2e5 || item.depth > 128 || facts.declarations.length >= 2e4) {
        facts.truncated = true;
        region.supported = false;
        break;
      }
      const classNode = compiler.isClassDeclaration(node) || compiler.isClassExpression(node), functionNode = compiler.isFunctionDeclaration(node) || compiler.isFunctionExpression(node), method = compiler.isMethodDeclaration(node) || compiler.isGetAccessorDeclaration(node) || compiler.isSetAccessorDeclaration(node), constructor = compiler.isConstructorDeclaration(node), name = classNode || functionNode || method ? node.name : void 0;
      let initializer = compiler.isVariableDeclaration(node) ? node.initializer : void 0;
      while (initializer && compiler.isParenthesizedExpression(initializer)) initializer = initializer.expression;
      if (compiler.isVariableDeclaration(node) && initializer && (compiler.isFunctionExpression(initializer) || compiler.isArrowFunction(initializer))) {
        const start = node.getStart(source), headerEnd = initializer.body.getStart(source);
        if (blocked || !compiler.isIdentifier(node.name)) {
          blocked = true;
          issue("erb-script-owner-gap", "Callable source binding requires an original identifier and qualified lexical owner; descendants are quarantined", original.range(offset + start, offset + node.end));
        } else if (headerEnd - start > 1200) {
          blocked = true;
          region.supported = false;
          issue("erb-script-header-gap", "Original callable binding header exceeds the bounded signature profile; descendants are quarantined", original.range(offset + start, offset + headerEnd));
        } else {
          const nameText = node.name.getText(source), kind = compiler.isArrowFunction(initializer) ? "arrow-binding" : "function-binding", fact = { key: `${template}-${key}:${offset + start}:${offset + node.end}:${kind}`, name: nameText, qualifiedName: [parent?.qualifiedName ?? key, nameText].join("::"), kind, entityType: "function", signature: text.slice(start, headerEnd).trim(), start: offset + start, end: offset + node.end, nameEnd: offset + node.name.end, range: original.range(offset + start, offset + node.end), declarationForm: "definition", sourceConditions: [...template === "liquid" ? region.conditions : [], "Original JavaScript variable initializer binding; assignment, aliases, mutation, rendered/browser execution and call binding remain unverified"], embeddedSource: { language: "javascript", executionContext: "browser", headerRange: original.range(offset + start, offset + headerEnd), regions: [original.range(offset + start, offset + node.end)] }, ...parent ? { parent: parent.key } : {} };
          facts.declarations.push(fact);
          parent = fact;
          claimedInitializers.add(initializer);
        }
      }
      if (!claimedInitializers.has(node) && (classNode || functionNode || method || constructor)) {
        if (blocked || !name && !constructor || (method || constructor) && (!parent || parent.kind !== "class")) {
          issue("erb-script-owner-gap", "Unnamed JavaScript type/callback or object member has no qualified original source owner; nested declarations are quarantined", original.range(offset + node.getStart(source), offset + node.end));
          blocked = true;
        } else {
          const body = classNode ? node.getChildren(source).find((n) => n.kind === compiler.SyntaxKind.OpenBraceToken) : node.body, start = node.getStart(source), headerEnd = body?.getStart(source) ?? node.end, nameStart = name?.getStart(source) ?? start, nameEnd = name?.end ?? start + "constructor".length, nameText = name?.getText(source) ?? "constructor", kind = classNode ? "class" : functionNode ? "function" : constructor ? "constructor" : compiler.isGetAccessorDeclaration(node) ? "get-accessor" : compiler.isSetAccessorDeclaration(node) ? "set-accessor" : "method";
          if (headerEnd - start > 1200) {
            blocked = true;
            region.supported = false;
            issue("erb-script-header-gap", "Original JavaScript header exceeds the bounded signature profile; descendants are quarantined", original.range(offset + start, offset + headerEnd));
          } else {
            const fact = { key: `${template}-${key}:${offset + start}:${offset + node.end}:${kind}`, name: nameText, qualifiedName: [parent?.qualifiedName ?? key, nameText].join("::"), kind, entityType: classNode ? "class" : functionNode ? "function" : "method", signature: text.slice(start, headerEnd).trim(), start: offset + start, end: offset + node.end, nameEnd: offset + nameEnd, range: original.range(offset + start, offset + node.end), declarationForm: "definition", sourceConditions: [...template === "liquid" ? region.conditions : [], "Original literal JavaScript declaration; rendered/browser execution, imports and call binding remain unverified"], embeddedSource: { language: "javascript", executionContext: "browser", headerRange: original.range(offset + start, offset + headerEnd), regions: [original.range(offset + start, offset + node.end)] }, ...parent ? { parent: parent.key } : {} };
            if (content.slice(offset + nameStart, offset + nameEnd) !== nameText) {
              blocked = true;
              region.supported = false;
              issue("erb-script-name-gap", "JavaScript name has no exact original source spelling", fact.range);
            } else {
              facts.declarations.push(fact);
              parent = fact;
            }
          }
        }
      } else if (compiler.isArrowFunction(node) && !claimedInitializers.has(node)) {
        blocked = true;
      }
      const children = [];
      compiler.forEachChild(node, (n) => {
        children.push(n);
      });
      for (let i = children.length - 1; i >= 0; i--) pending2.push({ node: children[i], parent, blocked, depth: item.depth + 1 });
    }
  }
}

// src/analysis/tree-sitter/script-worker.ts
async function handle(job) {
  try {
    const compiler = (await import("typescript")).default;
    extractLiteralScripts(compiler, job.content, job.facts, job.template);
    const facts = job.template === "erb" ? finishErb(job.facts) : job.template === "razor" ? finishRazor(job.facts) : finishLiquid(job.facts);
    replyParserFrame(job.id, { facts });
  } catch (error) {
    replyParserFrame(job.id, { error: error instanceof Error ? error.message : String(error) });
  }
}
var pending = Promise.resolve();
process.on("message", (message) => {
  pending = pending.then(async () => {
    try {
      await handle(parserJob(message));
    } catch (error) {
      replyParserFrame(message.id, { error: error instanceof Error ? error.message : String(error), fatal: true });
    }
  });
});
process.once("disconnect", () => process.exit(0));
