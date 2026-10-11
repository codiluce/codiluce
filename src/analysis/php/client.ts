import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StructureParser } from '../tree-sitter/client.js';

// Share the bounded IPC transport, not a Tree-sitter grammar or PHP runtime.
const worker = fileURLToPath(new URL(`./worker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
export class PhpParser extends StructureParser {
  constructor(timeoutMs = 10_000) { super(timeoutMs, worker); }
  parseSource(content: string) { return this.parse('php', content); }
}
