import type { Evidence } from '../core/graph.js';

/** Bounds on encoded table/reference payload, not decoded objects or RSS. */
export interface RustEvidenceLimits { maxEntries: number; maxEvidenceBytes: number; maxReferenceBytes: number; maxProofReferences: number }
export const RUST_EVIDENCE_LIMITS: Readonly<RustEvidenceLimits> = Object.freeze({ maxEntries: 65_536, maxEvidenceBytes: 8 * 1024 * 1024, maxReferenceBytes: 16 * 1024 * 1024, maxProofReferences: 65_536 });
type Limits = RustEvidenceLimits;
export interface RustEvidenceTable { version: 1; entries: Evidence[]; limits: Limits; evidenceBytes: number; referenceBytes: number; proofs: number }
type Plain = Record<string, unknown>;
const sources = new Set(['filesystem','typescript','php','syntax','framework','git','runtime','heuristic','ai']);
function plain(value: unknown): value is Plain {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function evidence(value: unknown): Evidence {
  if (!plain(value)) throw Error('Rust evidence must be a plain original fact');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw Error('Rust evidence cannot execute accessors');
    const item = descriptor.value;
    if (item !== null && item !== undefined && !['string','number','boolean'].includes(typeof item)) throw Error('Rust evidence requires primitive original fields');
  }
  if (!sources.has(String(value.source)) || typeof value.analyzer !== 'string' || !value.analyzer || typeof value.analyzerVersion !== 'string' || !value.analyzerVersion || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw Error('Invalid original Rust evidence identity');
  return value as unknown as Evidence;
}
function limits(options: Partial<Limits>): Limits {
  for (const key of Object.keys(options)) if (!Object.hasOwn(RUST_EVIDENCE_LIMITS,key)) throw Error('Unknown Rust evidence limit');
  const selected = { ...RUST_EVIDENCE_LIMITS, ...options };
  for (const key of Object.keys(selected) as (keyof Limits)[]) if (!Number.isSafeInteger(selected[key]) || selected[key] < 1 || selected[key] > RUST_EVIDENCE_LIMITS[key]) throw Error('Rust evidence limits must be positive safe integers within the public profile');
  if (selected.maxEvidenceBytes < 2) throw Error('Rust evidence table byte limit must admit the empty [] payload');
  return selected;
}

/** Intern exact public JSON facts. Ordered indices preserve every duplicate
 * occurrence and field. Admission is atomic; original mutable inputs never
 * become table entries. Lookup/key snapshots retire when the file is sealed. */
export class RustEvidenceEncoder {
  private readonly selected: Limits;
  private readonly entries: Evidence[] = [];
  private readonly lookup = new Map<string,number>();
  private cached = new WeakMap<object,{keys:string[];values:unknown[];json:string}>();
  private evidenceBytes = 2;
  private referenceBytes = 0;
  private proofs = 0;
  private sealed = false;
  constructor(options: Partial<Limits> = {}) { this.selected = limits(options); }
  reference(proof: readonly Evidence[]): number[] {
    if (this.sealed) throw Error('Rust evidence file table is sealed');
    if (!Array.isArray(proof) || proof.length > this.selected.maxProofReferences) throw Error('Rust evidence per-proof reference budget exceeded');
    const pending = new Map<string,number>(), values: string[] = [], refs: number[] = [];
    let bytes = this.evidenceBytes, referenceBytes = 2;
    for (const item of proof) {
      const fact = evidence(item), keys = Object.keys(fact), old = this.cached.get(fact);
      // Reused source facts are common, but mutation must never reuse a stale
      // JSON identity. All admitted fields are primitives, including extras.
      const same = old && keys.length === old.keys.length && keys.every((key,i) => key === old.keys[i] && Object.is((fact as unknown as Plain)[key],old.values[i]));
      const json = same ? old.json : JSON.stringify(fact);
      if (!same) this.cached.set(fact,{keys,values:keys.map(key=>(fact as unknown as Plain)[key]),json});
      let index = this.lookup.get(json) ?? pending.get(json);
      if (index === undefined) {
        index = this.entries.length + values.length;
        bytes += Buffer.byteLength(json) + (index ? 1 : 0);
        if (index >= this.selected.maxEntries || bytes > this.selected.maxEvidenceBytes) throw Error('Rust evidence table payload budget exceeded');
        pending.set(json,index);values.push(json);
      }
      referenceBytes += String(index).length + (refs.length ? 1 : 0);refs.push(index);
      if (this.referenceBytes + referenceBytes > this.selected.maxReferenceBytes) throw Error('Rust evidence reference payload budget exceeded');
    }
    if (this.referenceBytes + referenceBytes > this.selected.maxReferenceBytes) throw Error('Rust evidence reference payload budget exceeded');
    for (const [json,index] of pending) { this.lookup.set(json,index);this.entries.push(JSON.parse(json) as Evidence); }
    this.evidenceBytes = bytes;this.referenceBytes += referenceBytes;this.proofs++;return refs;
  }
  seal(): RustEvidenceTable {
    if (this.sealed) throw Error('Rust evidence file table is sealed');
    this.sealed = true;this.lookup.clear();this.cached = new WeakMap();
    return { version: 1, entries: this.entries, limits: { ...this.selected }, evidenceBytes: this.evidenceBytes, referenceBytes: this.referenceBytes, proofs: this.proofs };
  }
}

/** Read one full proof from compact metadata or an older expanded graph.
 * Failure is explicit: invalid references can never turn into empty evidence.
 * This reader is browser-safe; only the owned Node encoder measures UTF-8. */
export function rustOutcomeEvidence(metadata: Record<string,unknown>, outcome: Record<string,unknown>): Evidence[] {
  if (Object.hasOwn(outcome,'proof') && Object.hasOwn(outcome,'proofRefs')) throw Error('Conflicting Rust evidence representations');
  if (Object.hasOwn(outcome,'proof')) {
    if (!Array.isArray(outcome.proof) || outcome.proof.length > RUST_EVIDENCE_LIMITS.maxProofReferences) throw Error('Invalid legacy Rust proof');
    return outcome.proof.map(evidence);
  }
  const table = metadata.rustSymbolEvidence;
  if (!plain(table) || table.version !== 1 || !Array.isArray(table.entries)) throw Error('Original Rust evidence table is unavailable');
  if (!plain(table.limits)) throw Error('Original Rust evidence profile is unavailable');
  const selected = limits(table.limits as Partial<Limits>);
  const entries = table.entries;
  if (entries.length > selected.maxEntries || !Array.isArray(outcome.proofRefs) || outcome.proofRefs.length > selected.maxProofReferences) throw Error('Invalid Rust evidence reference budget');
  return outcome.proofRefs.map(index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) throw Error('Invalid original Rust evidence reference');
    return evidence(entries[index]);
  });
}
