import { StructureParser } from './client.js';
import type { StructureFacts } from '../facts.js';

export const NATIVE_GENERATION_LIMITS = Object.freeze({ maxGrammars: 6, maxSourceBytes: 16 * 1024 * 1024 });
export interface NativeGenerationLimits { maxGrammars: number; maxSourceBytes: number }
type Options = Parameters<StructureParser['parse']>[2];

/** Reserve auxiliary grammars conservatively: even a literal/failed host may
 * not actually load all of these. A generation never exceeds this reservation. */
export function reservedGrammars(language: string, options: Options = {}): string[] {
  const reserved = [language];
  if (language === 'erb') { reserved.push('ruby'); if (options.erbHost === 'html') reserved.push('html'); }
  if (language === 'razor' || language === 'liquid' && options.liquidHost === 'html') reserved.push('html');
  if (language === 'objective-c' && options.objectiveCpp) reserved.push('cpp');
  return [...new Set(reserved)];
}

/** Sequential indexed native jobs reuse a bounded grammar generation. Retire
 * its entire WASM address space before crossing either reservation limit.
 * This bounds lifetimes, not RSS: one allowed source can exceed the byte
 * threshold, and grammar sizes/tree allocation vary. An exhausted/oversized
 * generation exits before its complete facts are returned. No input is discarded. */
export class IndexedStructureParser extends StructureParser {
  private readonly grammars = new Set<string>();
  private bytes = 0;
  private busy = false;
  private retirementPending = false;
  private rotations = 0;
  private peakGrammars = 0;
  private peakBytes = 0;
  private oversizedJobs = 0;
  private readonly limits: Readonly<NativeGenerationLimits>;
  constructor(timeoutMs = 10_000, limits: NativeGenerationLimits = NATIVE_GENERATION_LIMITS) {
    super(timeoutMs);
    if (!Number.isSafeInteger(limits.maxGrammars) || limits.maxGrammars < 3 || !Number.isSafeInteger(limits.maxSourceBytes) || limits.maxSourceBytes < 1) throw Error('Native generation limits require at least three grammars and positive safe source bytes');
    this.limits = Object.freeze({ ...limits });
  }
  generationStats() { return { limits: this.limits, grammars: this.grammars.size, sourceBytes: this.bytes, peakGrammars: this.peakGrammars, peakSourceBytes: this.peakBytes, rotations: this.rotations, oversizedJobs: this.oversizedJobs, retirementPending: this.retirementPending }; }
  override async parse(language: string, content: string, options: Options = {}): Promise<StructureFacts> {
    if (this.busy) throw Error('Indexed native grammar jobs require sequential dispatch');
    this.busy = true;
    try {
      // A failed retirement is not permission to overlap the old address
      // space. Re-prove its exit before any subsequent native dispatch.
      if (this.retirementPending) await this.closeAndWait();
      const reserved = reservedGrammars(language, options), bytes = Buffer.byteLength(content);
      const count = new Set([...this.grammars, ...reserved]).size;
      if (this.grammars.size && (count > this.limits.maxGrammars || this.bytes + bytes > this.limits.maxSourceBytes)) {
        await this.closeAndWait(); this.rotations++;
      }
      for (const grammar of reserved) this.grammars.add(grammar);
      this.bytes += bytes;
      this.peakGrammars = Math.max(this.peakGrammars, this.grammars.size); this.peakBytes = Math.max(this.peakBytes, this.bytes);
      if (bytes > this.limits.maxSourceBytes) this.oversizedJobs++;
      const facts=await super.parse(language, content, options);
      if(this.bytes>=this.limits.maxSourceBytes){await this.closeAndWait();this.rotations++;}
      return facts;
    } catch (error) { await this.closeAndWait(); throw error; }
    finally { this.busy = false; }
  }
  override close(): void { this.retirementPending = true; this.grammars.clear(); this.bytes = 0; super.close(); }
  override async closeAndWait(): Promise<void> {
    this.retirementPending = true;
    await super.closeAndWait();
    this.retirementPending = false;
  }
}
