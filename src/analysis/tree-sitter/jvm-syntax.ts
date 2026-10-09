import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, JvmSyntaxFacts } from '../facts.js';
import type { SourceText } from '../source-map.js';
export function extractJvm(root: Node, language: string, declarations: DeclarationFact[], source: SourceText): JvmSyntaxFacts {
    const packages = root.namedChildren.filter(node => ['package_declaration', 'package_header'].includes(node.type)), name = packages[0]?.namedChildren.find(node => ['identifier', 'scoped_identifier', 'qualified_identifier'].includes(node.type));
    const path = (text: string) => text.replace(/`([^`]+)`|\s+/g, (_match, escaped: string | undefined) => escaped ?? '');
    const facts: JvmSyntaxFacts = { package: name ? path(name.text) : '', imports: [], declarations: [], complete: !root.hasError && packages.length <= 1, gaps: [] };
    for (const node of root.namedChildren) {
        if (node.type === 'module_declaration') {
            facts.module = node.childForFieldName('name')?.text;
            facts.gaps.push('JPMS requires/exports/readability need a selected module-path profile');
        }
        if (!['import_declaration', 'import'].includes(node.type) || !node.namedChildren.length)
            continue;
        const target = node.namedChildren.find(child => ['identifier', 'scoped_identifier', 'qualified_identifier'].includes(child.type));
        if (!target || node.hasError) {
            facts.complete = false;
            continue;
        }
        const star = node.children.some(child => child.type === '*' || child.type === 'asterisk'), isStatic = node.children.some(child => child.type === 'static'), alias = language === 'kotlin' && node.children.some(child => child.type === 'as') ? node.namedChildren.at(-1)?.text : undefined;
        facts.imports.push({ specifier: path(target.text), kind: isStatic ? (star ? 'static-star' : 'static') : (star ? 'star' : 'single'), ...(alias ? { alias: path(alias) } : {}), start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
    }
    if (language === 'java' && /\\u+[0-9a-fA-F]{4}/.test(root.text))
        facts.gaps.push('Java Unicode escape preprocessing requires a selected lexical profile');
    if (language === 'kotlin' && declarations.some(declaration => declaration.modifiers?.some(modifier => ['expect', 'actual'].includes(modifier))))
        facts.gaps.push('Kotlin multiplatform declarations require a selected compilation profile');
    const byKey = new Map(declarations.map(declaration => [declaration.key, declaration]));
    for (const declaration of declarations) {
        const node = root.descendantForIndex(declaration.start, declaration.end);
        let current: Node | null = node;
        let local = false, companion = false;
        while (current) {
            if (['function_body', 'block', 'lambda_literal', 'constructor_body', 'method_declaration', 'function_declaration'].includes(current.type) && current.startIndex < declaration.start)
                local = true;
            if (current.type === 'companion_object')
                companion = true;
            current = current.parent;
        }
        const enumConstant = language === 'java' && declaration.kind === 'property' && [node, node?.parent].some(item => item?.type === 'enum_constant' && item.startIndex === declaration.start && item.endIndex === declaration.end);
        const parent = declaration.parent ? byKey.get(declaration.parent) : undefined, type = ['class', 'interface', 'enum', 'record', 'annotation', 'object', 'typealias'].includes(declaration.kind), isStatic = enumConstant || !!declaration.modifiers?.includes('static') || (language === 'java' && !!parent && ['interface', 'annotation'].includes(parent.kind) && (type || declaration.kind === 'property'));
        const visibility = (enumConstant ? 'public' : undefined) ?? declaration.visibility ?? (language === 'kotlin' || language === 'java' && parent && ['interface', 'annotation'].includes(parent.kind) ? 'public' : 'package');
        const importable = !local && !companion && (type && (!parent || ['class', 'interface', 'enum', 'record', 'annotation', 'object'].includes(parent.kind)) || language === 'kotlin' && !parent || parent?.kind === 'object' || isStatic);
        const qualifiedName = path(declaration.qualifiedName);
        facts.declarations.push({ key: declaration.key, name: path(declaration.name), qualifiedName, ...(declaration.parent ? { parent: declaration.parent } : {}), importable, static: isStatic, visibility, ...(local ? { reason: 'Local declaration is outside package import scope' } : companion ? { reason: 'Companion/JVM bridge import requires a reviewed interop summary' } : {}) });
    }
    return facts;
}
