import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type Entity, type SourceRange } from '../../core/graph.js';
import type { TypeScriptServices, TypeScriptProject } from '../languages/typescript-services.js';
import type { TsApplicationState } from '../../analyzers/ts-references.js';

export interface TypeScriptPackFile {
  runtime: TypeScriptProject; file: ScannedFile; source: ts.SourceFile;
  state: TsApplicationState; owners: Map<ts.Node, Entity>;
}
export interface TypeScriptPackScope {
  context: AnalysisContext; services: TypeScriptServices; files: TypeScriptPackFile[];
}
/** These hooks run inside the language cache unit, after ordinary declarations
 * and before behavior/reference extraction. Pack versions are cache inputs. */
export interface TypeScriptFrameworkPack {
  id: string; version: string;
  applies(scope: TypeScriptPackScope): boolean;
  declare(scope: TypeScriptPackScope): void;
}
export function sourceRange(node: ts.Node): SourceRange {
  const source = node.getSourceFile(), start = source.getLineAndCharacterOfPosition(node.getStart(source)), end = source.getLineAndCharacterOfPosition(node.end);
  return { startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
}
export function nodeSite(node: ts.Node): string { return JSON.stringify([node.getSourceFile().fileName, node.kind, node.getStart(), node.end]); }
/** Register a framework callback on every owning compiler AST. Multiple
 * callbacks on one source line retain distinct ranges and ownership. */
export function declareInlineHandler(scope: TypeScriptPackScope, node: ts.ArrowFunction | ts.FunctionExpression, pack: string, identity: string, name: string): Entity | undefined {
  const relative = path.relative(scope.context.root, node.getSourceFile().fileName).split(path.sep).join('/');
  const frame = scope.files.find(frame => frame.file.path === relative);
  if (!frame) return undefined;
  const existing = scope.services.declarations.get(node);
  if (existing) return existing;
  let parent: Entity | undefined;
  for (let current = node.parent; current && !parent; current = current.parent) parent = scope.services.declarations.get(current);
  const range = sourceRange(node), graph = scope.context.graph;
  const entity = graph.contain({ id: graph.id('handler', pack, frame.runtime.project.id, relative, identity), type: 'function', name, path: relative, language: frame.file.language, parentId: parent?.id ?? frame.file.id, sourceRange: range, metadata: { role: 'handler', framework: pack, executionContext: 'server', qualifiedName: `${parent?.metadata.qualifiedName ?? ''}${parent ? '.' : ''}${name}`, ...declarationHashes(node.getText(), 0) }, evidence: [evidence('framework', pack, relative, range.startLine, 'Inline callback registered through a proven framework API')] });
  // A dependency source in a consumer program is a different AST. Register
  // the exact site on the producer's owners map used by reference extraction.
  const site = nodeSite(node);
  const visit = (candidate: ts.Node): void => {
    if (nodeSite(candidate) === site) { frame.owners.set(candidate, entity); scope.services.declarations.set(candidate, entity); return; }
    ts.forEachChild(candidate, visit);
  };
  visit(frame.source);
  scope.services.declarations.set(node, entity);
  return entity;
}
