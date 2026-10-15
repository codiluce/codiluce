/** The pinned web-tree-sitter 0.27 runtime accepts an owned wasmMemory.
 * Its default allows 2 GiB independently of V8's old-space limit. Keep the
 * original 32 MiB initial memory and impose an engine-enforced maximum.
 * This bounds this linear memory, not grammar bytes, JS facts or total RSS. */
export const NATIVE_WASM_MEMORY_LIMITS = Object.freeze({initialBytes: 32 * 1024 * 1024, maxBytes: 256 * 1024 * 1024, pageBytes: 65536});
// Invalidate facts admitted by the older auxiliary-trap fallback. Healthy
// syntax identities and semantic producers remain unchanged.
export const NATIVE_PARSER_FAILURE_POLICY = 'fatal-v1';

export function nativeWasmMemoryLimit(bytes = NATIVE_WASM_MEMORY_LIMITS.maxBytes): number {
  if (!Number.isSafeInteger(bytes) || bytes < NATIVE_WASM_MEMORY_LIMITS.initialBytes || bytes > NATIVE_WASM_MEMORY_LIMITS.maxBytes || bytes % NATIVE_WASM_MEMORY_LIMITS.pageBytes) throw Error('Native WASM memory limit must be page aligned between 32 and 256 MiB');
  return bytes;
}

export function nativeWasmWorkerLimit(args: readonly string[]): number {
  if (!args.length) return NATIVE_WASM_MEMORY_LIMITS.maxBytes;
  if (args.length !== 1 || !/^--max-wasm-bytes=\d+$/.test(args[0]!)) throw Error('Invalid owned native WASM argument');
  return nativeWasmMemoryLimit(Number(args[0]!.slice('--max-wasm-bytes='.length)));
}

export function createNativeWasmMemory(bytes = NATIVE_WASM_MEMORY_LIMITS.maxBytes) {
  const maxBytes = nativeWasmMemoryLimit(bytes), memory = new WebAssembly.Memory({initial: NATIVE_WASM_MEMORY_LIMITS.initialBytes / NATIVE_WASM_MEMORY_LIMITS.pageBytes, maximum: maxBytes / NATIVE_WASM_MEMORY_LIMITS.pageBytes});
  const grow = memory.grow.bind(memory);
  let growthFailed = false;
  // Emscripten catches grow failures and may retry a smaller over-allocation.
  // A successful retry clears the failure; a final failed growth must never
  // escape as successful partial auxiliary grammar facts.
  Object.defineProperty(memory, 'grow', {value(pages: number) {
    try {const previous = grow(pages); growthFailed = false; return previous;}
    catch (error) {growthFailed = true; throw error;}
  }});
  const assertAvailable = () => {if (growthFailed) throw Error(`Native Tree-sitter WASM memory exhausted at ${maxBytes} bytes`);};
  return {memory, maxBytes, assertAvailable};
}
