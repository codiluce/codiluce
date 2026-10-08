import type { SourceRange } from '../core/graph.js';

/**
 * Canonical source positions use one-based lines/UTF-16 columns and an exclusive
 * end column, matching the TypeScript analyzer. Never derive them from a
 * grammar's byte columns. Regions retain their original-file offsets.
 */
export class SourceText {
  private readonly starts = [0];
  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 13) { if (text.charCodeAt(i + 1) === 10) i++; this.starts.push(i + 1); }
      else if (code === 10 || code === 0x2028 || code === 0x2029) this.starts.push(i + 1);
    }
  }
  position(offset: number): { line: number; column: number } {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.text.length) throw new Error('Source offset outside text');
    let low = 0, high = this.starts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (this.starts[mid]! <= offset) low = mid; else high = mid; }
    return { line: low + 1, column: offset - this.starts[low]! + 1 };
  }
  range(start: number, end: number): SourceRange {
    if (end < start) throw new Error('Source range is reversed');
    const from = this.position(start), to = this.position(end);
    return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
  }
  region(start: number, end: number): SourceRegion {
    this.range(start, end);
    return { text: this.text.slice(start, end), start, end, range: (from, to) => {
      if (from < 0 || to < from || to > end - start) throw new Error('Region range outside source');
      return this.range(start + from, start + to);
    } };
  }
}
export interface SourceRegion { text: string; start: number; end: number; range(start: number, end: number): SourceRange }
