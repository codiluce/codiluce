import type { EntityType, Evidence, SourceRange } from '../core/graph.js';

export const ANALYSIS_FEATURES = ['structure', 'imports', 'references', 'framework', 'effects', 'guards'] as const;
export type AnalysisFeature = typeof ANALYSIS_FEATURES[number];
export type SupportStatus = 'supported' | 'partial' | 'unsupported' | 'disabled' | 'failed';
export interface FeatureOutcome { status: SupportStatus; reason?: string }
/** Serializable per-file outcomes, persisted with the graph rather than inferred from its language. */
export interface FileAnalysis {
  version: 1;
  adapter: string;
  adapterVersion: string;
  parser?: { name: string; version: string; grammar?: string; grammarHash?: string; queryHash?: string; abi?: number };
  features: Record<AnalysisFeature, FeatureOutcome>;
}
/** A syntax-derived declaration. Offsets are UTF-16 indices into the original source. */
export interface DeclarationFact {
  key: string; parent?: string;
  name: string; qualifiedName: string; kind: string; entityType: EntityType;
  signature: string; range: SourceRange; start: number; end: number; nameEnd: number;
  visibility?: string; exported?: boolean; modifiers?: string[]; annotations?: string[];
}
export interface ParseIssue { code: string; reason: string; range?: SourceRange }
export interface PythonGuardFact { expression: string; branch: boolean; scope?: string }
/** Scoped syntax only. The resolver determines whether a guard/import names a
 * real external package; spelling alone is never framework/type-only proof. */
export interface PythonImportFact {
  kind: 'import' | 'from'; specifier: string; bindings: ImportBinding[];
  moduleBinding?: 'head' | 'exact';
  scope?: string; range: SourceRange; start: number; end: number;
  conditions: string[]; guards: PythonGuardFact[];
}
export interface PythonBindingWrite { name: string; scope?: string; start: number; line: number; kind: 'assignment' | 'augmentation' | 'mutation' | 'parameter' | 'declaration' }
export type PythonExpression =
  | { kind: 'name'; name: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'sequence'; items: PythonExpression[]; container?: 'list' | 'tuple' | 'set' }
  | { kind: 'mapping'; items: { key: PythonExpression; value: PythonExpression }[] }
  | { kind: 'binary'; operator: string; left: PythonExpression; right: PythonExpression }
  | { kind: 'subscript'; object: PythonExpression; items: PythonExpression[] }
  | { kind: 'member'; object: PythonExpression; name: string }
  | { kind: 'call'; callee: PythonExpression; args: PythonArgument[]; start?: number; range?: SourceRange }
  | { kind: 'unknown'; text: string };
export interface PythonArgument { name?: string; value: PythonExpression; spread?: boolean }
export interface PythonCallFact { callee: string; expression: PythonExpression; standalone: boolean; conditions: string[]; scope?: string; start: number; range: SourceRange }
export interface PythonAssignmentFact { name: string; value: PythonExpression; scope?: string; start: number; range: SourceRange; conditions: string[]; augmentation?: string }
export interface PythonReturnFact { value: PythonExpression; scope?: string; start: number; conditions: string[] }
export interface PythonDefinitionFact { key: string; conditions: string[]; decorators: PythonExpression[]; bases: PythonExpression[]; parameters: { name: string; default?: PythonExpression; annotation?: PythonExpression; variadic?: boolean; kind?: 'positional-only' | 'keyword-only' }[] }
export interface PythonReferenceFact { name: string; scope?: string; start: number; range: SourceRange }
export interface PythonScopeFact { key: string; parent?: string; kind: 'comprehension' | 'lambda'; start: number; end: number }
export interface PythonSyntaxFacts { imports: PythonImportFact[]; writes: PythonBindingWrite[]; calls: PythonCallFact[]; assignments: PythonAssignmentFact[]; returns: PythonReturnFact[]; definitions: PythonDefinitionFact[]; references: PythonReferenceFact[]; scopes: PythonScopeFact[]; opaqueScopes: string[]; opaqueModule: boolean }
export interface GoImportFact { specifier: string; local?: string; kind: 'named' | 'default' | 'dot' | 'blank'; range: SourceRange; start: number; end: number }
export interface GoSyntaxFacts { package?: { name: string; range: SourceRange; start: number }; imports: GoImportFact[]; comments: { text: string; start: number; end: number }[]; complete: boolean }
export interface StructureFacts { declarations: DeclarationFact[]; issues: ParseIssue[]; truncated: boolean; python?: PythonSyntaxFacts; go?: GoSyntaxFacts }
export interface ImportBinding { imported: string; local: string; typeOnly?: boolean }
export type ImportOutcome =
  | { status: 'resolved'; targets: string[]; proof: Evidence[] }
  | { status: 'external'; dependency: string; proof: Evidence[] }
  | { status: 'ambiguous'; candidates: string[]; reason: string }
  | { status: 'unresolved' | 'unsupported' | 'excluded'; reason: string };

export function featureOutcomes(status: SupportStatus, reason?: string): FileAnalysis['features'] {
  return Object.fromEntries(ANALYSIS_FEATURES.map(feature => [feature, { status, ...(reason ? { reason } : {}) }])) as FileAnalysis['features'];
}
export function fileAnalysis(value: unknown): FileAnalysis | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<FileAnalysis>;
  if (item.version !== 1 || typeof item.adapter !== 'string' || typeof item.adapterVersion !== 'string' || !item.features || typeof item.features !== 'object') return undefined;
  const statuses: readonly string[] = ['supported', 'partial', 'unsupported', 'disabled', 'failed'];
  return ANALYSIS_FEATURES.every(feature => {
    const outcome = item.features![feature];
    return outcome && statuses.includes(outcome.status) && (outcome.reason === undefined || typeof outcome.reason === 'string');
  }) ? item as FileAnalysis : undefined;
}
