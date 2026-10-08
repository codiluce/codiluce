import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface GrammarSpec {
  language: string; file: string; sha256: string; abi: number;
  source: string; sourceRevision: string; license: string; licenseFile: string;
  artifactPackage: string; artifactVersion: string; artifactPath: string;
}
interface GrammarManifest { format: number; runtime: { package: string; version: string }; grammars: GrammarSpec[] }
export const STRUCTURAL_LANGUAGES = ['python', 'go', 'ruby', 'rust', 'java', 'csharp', 'kotlin'] as const;
// In a source checkout: grammars/. In a compiled package: dist/grammars/.
export const GRAMMAR_ROOT = new URL('../../../grammars/', import.meta.url);
let manifestText = '', manifestError: string | undefined;
let manifest: GrammarManifest = { format: 1, runtime: { package: 'web-tree-sitter', version: 'unavailable' }, grammars: [] };
try {
  manifestText = readFileSync(new URL('manifest.json', GRAMMAR_ROOT), 'utf8');
  const parsed = JSON.parse(manifestText) as GrammarManifest;
  if (parsed.format !== 1 || !Array.isArray(parsed.grammars) || typeof parsed.runtime?.version !== 'string'
    || !parsed.grammars.every(grammar => grammar && ['language', 'file', 'sha256', 'source', 'sourceRevision', 'artifactPackage', 'artifactVersion', 'artifactPath', 'license', 'licenseFile'].every(key => typeof (grammar as unknown as Record<string, unknown>)[key] === 'string') && Number.isInteger(grammar.abi))) throw new Error('Unsupported grammar manifest format');
  manifest = parsed;
} catch (error) { manifestError = `Structural grammar catalog unavailable: ${error instanceof Error ? error.message : String(error)}`; }
export const grammarManifestError = manifestError;
export const grammarManifest = manifest;
export const grammarCatalog = new Map(grammarManifest.grammars.map(grammar => [grammar.language, grammar]));
export function grammarFile(grammar: GrammarSpec): string { return fileURLToPath(new URL(grammar.file, GRAMMAR_ROOT)); }
export function queryText(language: string): string {
  if (!grammarCatalog.has(language)) throw new Error(`Unsupported structural language: ${language}`);
  return readFileSync(new URL(`queries/${language}/declarations.scm`, GRAMMAR_ROOT), 'utf8');
}
export function hashText(text: string): string { return createHash('sha256').update(text).digest('hex'); }
/** Include all query and artifact changes in history identities and fact caches. */
export const GRAMMAR_CATALOG_VERSION = hashText(manifestText + [...grammarCatalog.keys()].sort().map(language => {
  try { return queryText(language); } catch { return `${language}:query-unavailable`; }
}).join('\0')).slice(0, 16);
export function verifiedGrammar(grammar: GrammarSpec): Uint8Array {
  const bytes = readFileSync(grammarFile(grammar));
  if (createHash('sha256').update(bytes).digest('hex') !== grammar.sha256) throw new Error(`Grammar checksum mismatch: ${grammar.language}`);
  return bytes;
}
