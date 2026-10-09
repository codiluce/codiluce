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
export interface GoSite { start: number; range: SourceRange }
export type GoExpression = GoSite & (
  | { kind: 'name'; name: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'member'; object: GoExpression; name: string }
  | { kind: 'call'; callee: GoExpression; args: GoExpression[] }
  | { kind: 'unary'; operator: string; object: GoExpression }
  | { kind: 'index'; object: GoExpression; index?: GoExpression }
  | { kind: 'composite'; type: GoExpression; items?: { key?: string; value: GoExpression }[] }
  | { kind: 'binary'; operator: string; left: GoExpression; right: GoExpression }
  | { kind: 'function'; key: string }
  | { kind: 'unknown'; text: string }
);
export interface GoScopeFact { key: string; parent?: string; owner?: string; kind: 'file' | 'function' | 'type' | 'block' | 'control' | 'case'; start: number; end: number; conditional?: string }
export interface GoParameterFact { name?: string; type: GoExpression; variadic?: boolean }
export interface GoDefinitionFact extends GoSite {
  key: string; name: string; kind: 'function' | 'method' | 'type' | 'closure'; scope: string; bodyScope?: string; typeScope?: string;
  end: number; signature: string; receiver?: GoParameterFact; parameters: GoParameterFact[]; results: GoParameterFact[];
  generic?: boolean;
  alias?: boolean; underlying?: GoExpression; interface?: boolean; fields?: { name?: string; type: GoExpression; embedded: boolean }[];
}
export interface GoBindingFact extends GoSite { name: string; scope: string; end: number; kind: 'var' | 'const' | 'short' | 'parameter' | 'type-parameter' | 'range'; type?: GoExpression; value?: GoExpression; tuple?: boolean }
export interface GoWriteFact extends GoSite { target: GoExpression; scope: string; kind: 'assignment' | 'augmentation' | 'address'; value?: GoExpression }
export interface GoReferenceFact extends GoSite { expression: GoExpression; scope: string }
export interface GoCallFact extends GoReferenceFact { expression: GoExpression & { kind: 'call' }; timing: 'immediate' | 'deferred' | 'goroutine' }
export interface GoReturnFact extends GoSite { scope: string; values: GoExpression[] }
export interface GoSemanticFacts { scopes: GoScopeFact[]; definitions: GoDefinitionFact[]; bindings: GoBindingFact[]; writes: GoWriteFact[]; references: GoReferenceFact[]; calls: GoCallFact[]; returns: GoReturnFact[]; gaps: string[] }
export interface GoSyntaxFacts { package?: { name: string; range: SourceRange; start: number }; imports: GoImportFact[]; comments: { text: string; start: number; end: number }[]; complete: boolean; semantic?: GoSemanticFacts }
export interface RubySite { start: number; end: number; range: SourceRange }
export type RubyExpression = RubySite & (
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'symbol'; name: string }
  | { kind: 'constant'; name: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'call'; receiver?: RubyExpression; method: string; args: RubyExpression[] }
  | { kind: 'array'; items: RubyExpression[] }
  | { kind: 'hash'; items: { key: RubyExpression; value: RubyExpression }[] }
  | { kind: 'unknown'; text: string }
);
export interface RubyScopeFact extends RubySite { key: string; parent?: string; owner?: string; kind: 'file' | 'class' | 'module' | 'method' | 'singleton' | 'block' | 'control'; name?: string; conditional?: string; deferred?: boolean }
export interface RubyDefinitionFact extends RubySite { key: string; name: string; kind: 'class' | 'module' | 'method' | 'singleton_method'; scope: string; bodyScope: string; superclass?: RubyExpression; receiver?: RubyExpression }
export interface RubyCallFact extends RubySite { expression: RubyExpression & { kind: 'call' }; scope: string; blockScope?: string; bare?: boolean; safeNavigation?: boolean }
export interface RubyLocalFact extends RubySite { name: string; scope: string; kind: 'parameter' | 'block_local' | 'write' }
export interface RubyAssignmentFact extends RubySite { target: RubyExpression; value: RubyExpression; scope: string; augmentation?: boolean }
export interface RubyReferenceFact extends RubySite { expression: RubyExpression & { kind: 'constant' }; scope: string }
export interface RubyGapFact extends RubySite { scope: string; kind: 'path' | 'loader' | 'constants' | 'scope'; reason: string }
export interface RubySyntaxFacts { scopes: RubyScopeFact[]; definitions: RubyDefinitionFact[]; calls: RubyCallFact[]; locals: RubyLocalFact[]; assignments: RubyAssignmentFact[]; references: RubyReferenceFact[]; gaps: RubyGapFact[]; complete: boolean }
export interface JvmImportFact { specifier: string; kind: 'single' | 'star' | 'static' | 'static-star'; alias?: string; start: number; end: number; range: SourceRange }
export interface JvmDeclarationFact { key: string; name: string; qualifiedName: string; parent?: string; importable: boolean; static: boolean; visibility: string; reason?: string }
export interface JvmSite { start: number; end: number; range: SourceRange }
export type JvmExpression = JvmSite & (
  | { kind: 'name'; name: string }
  | { kind: 'generic-type'; name: JvmExpression; arguments: JvmExpression[] }
  | { kind: 'literal'; value: string | number | boolean | null; literalType?: string }
  | { kind: 'member'; object: JvmExpression; name: string; safe?: boolean }
  | { kind: 'call'; callee: JvmExpression; args: JvmArgument[]; typeArguments?: boolean }
  | { kind: 'new'; type: JvmExpression; args: JvmArgument[]; anonymous?: boolean }
  | { kind: 'array'; items: JvmExpression[] }
  | { kind: 'binary'; operator: string; left: JvmExpression; right: JvmExpression }
  | { kind: 'unary'; operator: string; object: JvmExpression }
  | { kind: 'index'; object: JvmExpression; index?: JvmExpression }
  | { kind: 'cast'; type: JvmExpression; value: JvmExpression }
  | { kind: 'class'; type: JvmExpression }
  | { kind: 'method-reference'; object?: JvmExpression; name: string }
  | { kind: 'lambda'; key: string }
  | { kind: 'unknown'; text: string }
);
export interface JvmArgument { name?: string; value: JvmExpression; spread?: boolean }
export interface JvmAnnotationFact extends JvmSite { type: JvmExpression; args: JvmArgument[]; target?: string }
export interface JvmScopeFact extends JvmSite { key: string; parent?: string; owner?: string; kind: 'file'|'type'|'function'|'initializer'|'lambda'|'block'|'control'|'opaque'; conditional?: string; deferred?: boolean; gaps: string[] }
export interface JvmParameterFact { name?: string; type?: JvmExpression; default?: JvmExpression; variadic?: boolean; property?: boolean; annotations: JvmAnnotationFact[] }
export interface JvmDefinitionFact extends JvmSite { key: string; name: string; kind: string; scope: string; bodyScope?: string; typeScope?: string; parent?: string; parameters: JvmParameterFact[]; returnType?: JvmExpression; receiverType?: JvmExpression; bases: JvmExpression[]; typeParameters: string[]; annotations: JvmAnnotationFact[]; value?: JvmExpression; immutable?: boolean; modifiers: string[]; gaps: string[] }
export interface JvmBindingFact extends JvmSite { name: string; scope: string; declaration?: string; kind: 'parameter'|'local'|'loop'|'catch'|'pattern'; type?: JvmExpression; value?: JvmExpression; immutable: boolean }
export interface JvmWriteFact extends JvmSite { scope: string; target: JvmExpression; value?: JvmExpression; operator: string }
export interface JvmReferenceFact extends JvmSite { scope: string; expression: JvmExpression; kind: 'value'|'type'|'method-reference' }
export interface JvmCallFact extends JvmSite { scope: string; expression: JvmExpression; kind: 'call'|'new'|'super'|'this' }
export interface JvmReturnFact extends JvmSite { scope: string; value: JvmExpression }
export interface JvmSemanticFacts { scopes: JvmScopeFact[]; definitions: JvmDefinitionFact[]; bindings: JvmBindingFact[]; writes: JvmWriteFact[]; references: JvmReferenceFact[]; calls: JvmCallFact[]; returns: JvmReturnFact[]; complete: boolean; gaps: string[] }
export interface JvmSyntaxFacts { package: string; imports: JvmImportFact[]; declarations: JvmDeclarationFact[]; complete: boolean; module?: string; gaps: string[]; semantic?: JvmSemanticFacts }
export interface CsharpImportFact { specifier: string; kind: 'namespace'|'static'|'alias'; alias?: string; global: boolean; namespace: string; scopeStart: number; scopeEnd: number; start: number; end: number; range: SourceRange }
export interface CsharpDeclarationFact { key: string; name: string; qualifiedName: string; namespace: string; parent?: string; type: boolean; arity: number; partial: boolean; static: boolean; visibility: string; fileLocal: boolean; bases: string[]; flavor?: string; typeParameters?:string[]; constraints?:string[] }
export interface CsharpSite { start:number; end:number; range:SourceRange }
export type CsharpExpression = CsharpSite & (
  | {kind:'name';name:string}
  | {kind:'literal';value:string|number|boolean|null;type:string}
  | {kind:'member';object:CsharpExpression;name:string;conditional?:boolean}
  | {kind:'call';callee:CsharpExpression;args:CsharpArgument[]}
  | {kind:'new';type:string;args:CsharpArgument[];initializer?:boolean}
  | {kind:'lambda';key:string}
  | {kind:'binary';operator:string;left:CsharpExpression;right:CsharpExpression}
  | {kind:'unary';operator:string;value:CsharpExpression}
  | {kind:'cast';type:string;value:CsharpExpression}
  | {kind:'typeof';type:string}
  | {kind:'array';values:CsharpExpression[];type?:string}
  | {kind:'object';properties:{name:string;value:CsharpExpression}[]}
  | {kind:'unknown';text:string}
);
export interface CsharpArgument {name?:string;modifier?:string;value:CsharpExpression}
export interface CsharpParameter {name:string;type?:string;modifiers:string[];default?:CsharpExpression;attributes?:CsharpAttribute[]}
export interface CsharpAttribute extends CsharpSite {type:string;args:CsharpArgument[];target?:string}
export interface CsharpScope extends CsharpSite {key:string;parent?:string;owner?:string;namespace:string;kind:'file'|'namespace'|'type'|'function'|'lambda'|'block'|'control'|'initializer'|'opaque';gaps:string[];deferred?:boolean}
export interface CsharpStatement extends CsharpSite {scope:string;kind:'expression'|'variable'|'return'|'block'|'control'|'opaque';value?:CsharpExpression;bindings?:number[];body?:CsharpStatement[];branches?:CsharpStatement[][];control?:string;awaited?:boolean;text?:string}
export interface CsharpDefinitionFact extends CsharpSite {key:string;name:string;kind:string;scope:string;parent?:string;bodyScope?:string;typeScope?:string;parameters:CsharpParameter[];returnType?:string;modifiers:string[];typeParameters:string[];attributes:CsharpAttribute[];value?:CsharpExpression;gaps:string[];hasBody:boolean;statements?:CsharpStatement[]}
export interface CsharpBindingFact extends CsharpSite {name:string;scope:string;kind:'parameter'|'local'|'loop'|'catch'|'pattern';type?:string;value?:CsharpExpression;modifiers:string[]}
export interface CsharpSemanticFacts {attributes?: (CsharpAttribute&{scope:string})[];scopes:CsharpScope[];definitions:CsharpDefinitionFact[];bindings:CsharpBindingFact[];writes:(CsharpSite&{scope:string;target:CsharpExpression;operator:string;value?:CsharpExpression})[];references:(CsharpSite&{scope:string;expression:CsharpExpression;kind:'type'|'attribute'|'value'})[];calls:(CsharpSite&{scope:string;expression:CsharpExpression})[];returns:(CsharpSite&{scope:string;value:CsharpExpression})[];complete:boolean;gaps:string[]}
export interface CsharpSyntaxFacts { imports: CsharpImportFact[]; declarations: CsharpDeclarationFact[]; namespaces: {name: string; start: number; range: SourceRange}[]; complete: boolean; gaps: string[]; semantic?:CsharpSemanticFacts }
export interface RustScopeFact {key:string;parent?:string;module:string;kind:'file'|'module'|'block'|'enum';start:number;end:number;range:SourceRange;attributes:string[];gaps:string[]}
export interface RustImportFact {scope:string;specifier:string;segments:string[];absolute:boolean;alias?:string;glob:boolean;selfOnly:boolean;visibility:string;attributes:string[];kind:'use'|'extern';start:number;end:number;range:SourceRange;gaps:string[]}
export interface RustItemFact {key:string;scope:string;name:string;kind:string;namespaces:('type'|'value'|'macro')[];visibility:string;attributes:string[];memberScope?:string;body?:string;start:number;end:number;range:SourceRange;gaps:string[]}
export interface RustSyntaxFacts {scopes:RustScopeFact[];items:RustItemFact[];imports:RustImportFact[];complete:boolean;gaps:string[]}
export interface StructureFacts { declarations: DeclarationFact[]; issues: ParseIssue[]; truncated: boolean; python?: PythonSyntaxFacts; go?: GoSyntaxFacts; ruby?: RubySyntaxFacts; jvm?: JvmSyntaxFacts; csharp?: CsharpSyntaxFacts; rust?:RustSyntaxFacts }
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
