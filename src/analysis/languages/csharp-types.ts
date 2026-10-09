import type { AnalysisContext } from '../../core/analyzer.js';
import type { Evidence } from '../../core/graph.js';
import type { CsharpSymbol } from '../resolution/csharp.js';
export const CSHARP_TYPE_VERSION = '1';
export interface CsharpType {
    id: string;
    name: string;
    project: string;
    arity: number;
    kind: string;
    parts: CsharpSymbol[];
    parent?: string;
    visibility: string;
    modifiers: string[];
    gaps: string[];
    proof: Evidence[];
}
/** Logical type metadata links every original fragment; no generated
 * declaration or arbitrary representative becomes a graph entity. */
export class CsharpTypes {
    readonly types = new Map<string, CsharpType>();
    private readonly bySymbol = new Map<string, CsharpType>();
    private readonly declarations = new Map<string, CsharpSymbol>();
    constructor(readonly context: AnalysisContext, readonly symbols: CsharpSymbol[]) {
        for (const symbol of symbols)
            this.declarations.set(this.siteKey(symbol), symbol);
        const identities = new Map<CsharpSymbol, string>();
        const identity = (symbol: CsharpSymbol, seen = new Set<string>()): string => {
            const cached = identities.get(symbol);
            if (cached)
                return cached;
            const key = this.siteKey(symbol);
            if (seen.has(key))
                return context.graph.id('csharp-type', 'cycle', key);
            seen.add(key);
            const parent = this.parentSymbol(symbol), parentId = parent ? identity(parent, seen) : '';
            const result = context.graph.id('csharp-type', symbol.project.id, parentId, symbol.syntax.qualifiedName, String(symbol.syntax.arity), symbol.syntax.fileLocal ? symbol.file.path : '');
            identities.set(symbol, result);
            return result;
        };
        for (const symbol of symbols.filter(symbol => symbol.syntax.type)) {
            const id = identity(symbol), parent = this.parentSymbol(symbol), type = this.types.get(id) ?? { id, name: symbol.syntax.qualifiedName, project: symbol.project.id, arity: symbol.syntax.arity, kind: symbol.syntax.flavor ?? symbol.declaration.kind, parts: [], ...(parent ? { parent: identity(parent) } : {}), visibility: symbol.syntax.visibility, modifiers: [], gaps: [], proof: [] };
            type.parts.push(symbol);
            type.proof.push(...symbol.proof);
            this.types.set(id, type);
            this.bySymbol.set(this.siteKey(symbol), type);
        }
        for (const type of this.types.values()) {
            const access = new Set(type.parts.filter(part => part.declaration.modifiers?.some(modifier => ['public', 'private', 'protected', 'internal'].includes(modifier))).map(part => part.syntax.visibility));
            if (access.size > 1)
                type.gaps.push('Partial type fragments declare conflicting accessibility');
            else if (access.size === 1)
                type.visibility = [...access][0]!;
            type.modifiers = [...new Set(type.parts.flatMap(part => part.declaration.modifiers ?? []))].sort();
            if (type.parts.length > 1) {
                if (!type.parts.every(part => part.syntax.partial) || !['class', 'struct', 'interface', 'record-class', 'record-struct'].includes(type.kind))
                    type.gaps.push('Competing declarations are not compatible partial types');
                if (type.parts.some(part => (part.syntax.flavor ?? part.declaration.kind) !== type.kind))
                    type.gaps.push('Partial fragments declare different type kinds');
                const parameters = type.parts.map(part => JSON.stringify(part.syntax.typeParameters ?? []));
                if (new Set(parameters).size > 1)
                    type.gaps.push('Partial type parameter names/order differ');
                const constraints = type.parts.map(part => part.syntax.constraints ?? []).filter(items => items.length).map(items => JSON.stringify(items));
                if (new Set(constraints).size > 1)
                    type.gaps.push('Partial generic constraints differ');
            }
            if (type.modifiers.includes('abstract') && type.modifiers.includes('sealed') || type.modifiers.includes('static') && type.modifiers.some(modifier => ['abstract', 'sealed'].includes(modifier)))
                type.gaps.push('Combined type modifiers conflict');
            const bases = type.parts.filter(part => part.syntax.bases.length).map(part => JSON.stringify(part.syntax.bases));
            if (new Set(bases).size > 1)
                type.gaps.push('Several partial base lists require reviewed inheritance merging');
            if (type.parts.length > 128)
                type.gaps.push('Partial type fragment budget exceeded');
        }
    }
    private siteKey(symbol: CsharpSymbol): string { return JSON.stringify([symbol.project.id, symbol.file.path, symbol.syntax.key]); }
    parentSymbol(symbol: CsharpSymbol): CsharpSymbol | undefined { return symbol.syntax.parent ? this.declarations.get(JSON.stringify([symbol.project.id, symbol.file.path, symbol.syntax.parent])) : undefined; }
    type(symbol: CsharpSymbol): CsharpType | undefined { return symbol.syntax.type ? this.bySymbol.get(this.siteKey(symbol)) : this.parentSymbol(symbol) ? this.bySymbol.get(this.siteKey(this.parentSymbol(symbol)!)) : undefined; }
    members(type: CsharpType, name?: string): CsharpSymbol[] { const parents = new Set(type.parts.map(part => this.siteKey(part))); return this.symbols.filter(symbol => symbol.syntax.parent && parents.has(JSON.stringify([symbol.project.id, symbol.file.path, symbol.syntax.parent])) && (name === undefined || symbol.syntax.name === name)); }
    annotate(): void {
        const originals = new Map<string, {
            part: CsharpSymbol;
            types: CsharpType[];
        }>();
        for (const type of this.types.values())
            for (const part of type.parts) {
                const record = originals.get(part.id) ?? { part, types: [] };
                record.types.push(type);
                originals.set(part.id, record);
            }
        const describe = (type: CsharpType) => ({ id: type.id, project: type.project, name: type.name, arity: type.arity, kind: type.kind, parts: [...new Set(type.parts.map(part => part.id))].sort(), visibility: type.visibility, modifiers: type.modifiers, gaps: type.gaps });
        for (const [id, record] of originals) {
            const entity = this.context.graph.entities.get(id);
            if (!entity)
                continue;
            const candidates = [...new Map(record.types.map(type => [type.id, type])).values()].sort((a, b) => a.project.localeCompare(b.project, 'en'));
            entity.metadata.csharpTypes = candidates.map(describe);
            const project = this.context.csharp?.projects.selection(record.part.file.path).project?.id;
            const selected = project ? candidates.find(type => type.project === project) : candidates.length === 1 ? candidates[0] : undefined;
            if (selected)
                entity.metadata.csharpType = describe(selected);
        }
        this.context.graph.entities.get(this.context.repositoryId)!.metadata.csharpTypes = [...this.types.values()].map(type => ({ id: type.id, name: type.name, project: type.project, parts: [...new Set(type.parts.map(part => part.id))].sort(), gaps: type.gaps }));
    }
}
