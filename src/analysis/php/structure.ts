import { ast, name, nodes, type Ast } from '../../analyzers/php-ast.js';
import type { DeclarationFact, PhpDeclarationSource, PhpPathExpression, PhpSyntaxFacts, StructureFacts } from '../facts.js';
import { SourceText } from '../source-map.js';

const MAX_NODES = 200_000, MAX_DEPTH = 128, MAX_SITES = 4096, MAX_HEADER = 4096;
interface Token { kind: string|null; text: string; start: number; end: number }
interface Scope { namespace: string; scope: string; owner?: DeclarationFact; type?: DeclarationFact; statement?: Ast; conditions: string[]; deferred: boolean }

/** Extract only original source declarations from the parse-only provider.
 * PHP namespace identity is independent of lexical containment: a function
 * declared inside another function still belongs to its PHP namespace. */
export function extractPhp(root: Ast, content: string): StructureFacts {
  const source = new SourceText(content);
  const php: PhpSyntaxFacts = { profile: 'php-parser-8.4-original-source', executionUnverified: true, complete: true, namespaces: [], declarations: [], imports: [], loads: [], loaderChanges: [], traits: [], bindings: [], regions: [] };
  const facts: StructureFacts = { declarations: [], issues: [], truncated: false, php };
  const issue = (code: string, reason: string, node?: Ast) => {
    php.complete = false;
    if (facts.issues.length < 100) facts.issues.push({ code, reason, ...node?.loc ? { range: source.range(node.loc.start.offset, node.loc.end.offset) } : {} });
  };
  const limit = () => { if (!facts.truncated) issue('php-structure-budget', 'Original PHP extraction exceeded its node, depth, token or source-site budget'); facts.truncated = true; };
  const site = (node: Ast) => {
    const start = node.loc?.start.offset, end = node.loc?.end.offset;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 0 || end! < start! || end! > content.length) throw Error('PHP provider returned invalid original source positions');
    return { start: start!, end: end!, range: source.range(start!, end!) };
  };
  const text = (node: Ast|undefined) => node?.loc ? content.slice(site(node).start, site(node).end) : '';
  const append = <T>(items: T[], value: T) => { if (items.length >= MAX_SITES) limit(); else items.push(value); };
  function pathExpression(node: Ast|undefined, depth = 0): PhpPathExpression {
    if (!node || depth > 32) return { kind: 'unknown', reason: 'Missing or over-budget original path expression' };
    if (['string','nowdoc'].includes(node.kind) && typeof node.value === 'string') return { kind: 'literal', value: node.value };
    if (node.kind === 'encapsed' && Array.isArray(node.value) && nodes(node.value).every(part=>part.kind==='encapsedpart'&&ast(part.expression)?.kind==='string'&&typeof ast(part.expression)?.value==='string')) return {kind:'literal',value:nodes(node.value).map(part=>String(ast(part.expression)!.value)).join('')};
    if (node.kind === 'magic' && ['__DIR__','__FILE__'].includes(String(node.value))) return { kind: node.value === '__DIR__' ? 'dir' : 'file' };
    if (node.kind === 'bin' && node.type === '.') return { kind: 'concat', left: pathExpression(ast(node.left),depth+1), right: pathExpression(ast(node.right),depth+1) };
    const callee = ast(node.what), args = nodes(node.arguments);
    if (node.kind === 'call' && callee?.kind === 'name' && ['dirname','\\dirname'].includes(String(callee.name).toLowerCase()) && args.length >= 1 && args.length <= 2) {
      const levels = args.length === 1 ? 1 : args[1]?.kind === 'number' ? Number(args[1].value) : NaN;
      if (Number.isSafeInteger(levels) && levels >= 1 && levels <= 32) return { kind: 'dirname', argument: pathExpression(args[0],depth+1), levels, name: String(callee.name) };
    }
    return { kind: 'unknown', reason: `Original ${node.kind} expression needs runtime evaluation or a separate binding profile` };
  }
  if (!Array.isArray(root.tokens) || root.tokens.length > MAX_NODES) { limit(); return facts; }
  const nativeTokens: Token[] = root.tokens.map(value => {
    if (!Array.isArray(value) || typeof value[1] !== 'string' || !Number.isSafeInteger(value[3]) || !Number.isSafeInteger(value[4]) || value[3] < 0 || value[4] < value[3] || value[4] > content.length || content.slice(value[3], value[4]) !== value[1]) throw Error('PHP provider returned invalid original tokens');
    return { kind: value[0] as string|null, text: value[1], start: value[3] as number, end: value[4] as number };
  });
  // Parser lookahead/backtracking can emit the same original token repeatedly
  // and out of order, especially for nullable and union named parameter types.
  const tokens = [...new Map(nativeTokens.map(token => [`${token.start}:${token.end}`, token])).values()].sort((a,b) => a.start-b.start || a.end-b.end);
  for (let i=1;i<tokens.length;i++) if (tokens[i]!.start<tokens[i-1]!.end) { issue('php-original-token-gap','Overlapping native token spans cannot form qualified original declaration headers'); return facts; }
  function tokenIndex(start: number): number {
    let low = 0, high = tokens.length;
    while (low < high) { const mid = (low + high) >>> 1; if (tokens[mid]!.start < start) low = mid + 1; else high = mid; }
    return low;
  }
  function originalName(node: Ast, expected: string, variable = false): Token|undefined {
    const span = site(ast(node.name) ?? node);
    for (let i = tokenIndex(span.start); i < tokens.length && tokens[i]!.start < span.end; i++) {
      const token = tokens[i]!;
      if (token.text === (variable ? `$${expected}` : expected) && token.kind !== 'T_CONSTANT_ENCAPSED_STRING') return token;
    }
    return undefined;
  }
  function header(start: number, end: number): string {
    if (end - start > MAX_HEADER) { issue('php-header-budget', 'Original PHP declaration header exceeds the bounded signature profile'); end = start + MAX_HEADER; }
    let result = '', separator = false;
    for (let i = tokenIndex(start); i < tokens.length && tokens[i]!.start < end; i++) {
      const token = tokens[i]!;
      if (['T_WHITESPACE', 'T_COMMENT', 'T_DOC_COMMENT'].includes(token.kind ?? '')) { separator = true; continue; }
      if (separator && result) result += ' ';
      result += content.slice(token.start, Math.min(token.end, end)); separator = false;
    }
    return result.trim();
  }
  function boundary(node: Ast, token: Token, kind: string): number {
    const end = site(node).end, body = ast(node.body);
    if (['function', 'method', 'constructor', 'destructor', 'closure-binding', 'arrow-binding', 'property-get', 'property-set'].includes(kind) && body?.loc) {
      let start = site(body).start;
      // Arrow bodies begin after the final original => token; default array
      // arguments may also contain => before the callable's real body.
      if (body.kind !== 'block') {
        let arrow: number|undefined;
        for (let i = tokenIndex(token.end); i < tokens.length && tokens[i]!.start < start; i++) if (tokens[i]!.kind === 'T_DOUBLE_ARROW') arrow = tokens[i]!.start;
        if (arrow !== undefined) start = arrow;
      }
      return start;
    }
    for (let i = tokenIndex(token.end); i < tokens.length && tokens[i]!.start < end; i++) {
      const t = tokens[i]!;
      if (t.kind === null && (['class', 'interface', 'trait', 'enum'].includes(kind) ? t.text === '{' : ['=', '{', ';'].includes(t.text))) return t.start;
    }
    return end;
  }
  const modifiers = (node: Ast, statement?: Ast) => {
    const owner = statement ?? node, result: string[] = [];
    for (const [key, label] of [['isStatic', 'static'], ['isFinal', 'final'], ['final', 'final'], ['isAbstract', 'abstract'], ['isReadonly', 'readonly'], ['readonly', 'readonly'], ['byref', 'by-reference']] as const) if (node[key] === true || owner[key] === true) result.push(label);
    return [...new Set(result)];
  };
  function declare(node: Ast, scope: Scope, kind: string, expected: string, variable = false, options: { promoted?: boolean; bindingOnly?: boolean; nameNode?: Ast; headerNode?: Ast } = {}): DeclarationFact|undefined {
    if (facts.declarations.length >= MAX_SITES) { limit(); return; }
    const nameToken = originalName(options.nameNode ?? node, expected, variable);
    if (!nameToken) { issue('php-declaration-name-gap', `No exact original token for ${kind} ${expected}`, node); return; }
    const providerNode = options.headerNode ?? node;
    const attributes = nodes(providerNode.attrGroups).map(attribute => ({ text: text(attribute), range: site(attribute).range }));
    const own = site(node), start = Math.min(own.start, ...nodes(node.attrGroups).map(attribute => site(attribute).start));
    const headerEnd = boundary(options.headerNode ?? node, nameToken, kind);
    const member = ['method', 'constructor', 'destructor', 'property', 'promoted-property', 'class-constant', 'enum-case'].includes(kind);
    const parent = options.promoted ? scope.type : scope.owner;
    const qualifiedName = member ? `${scope.type!.qualifiedName}::${variable ? '$' : ''}${expected}` : options.bindingOnly ? `${scope.owner?.qualifiedName ?? scope.namespace}::$${expected}` : ['property-get', 'property-set'].includes(kind) ? `${parent!.qualifiedName}::${expected}` : [scope.namespace, expected].filter(Boolean).join('\\');
    const key = `php:${start}:${own.end}:${kind}:${nameToken.start}`;
    const callable = ['function', 'method', 'constructor', 'destructor', 'property-get', 'property-set', 'closure-binding', 'arrow-binding'].includes(kind);
    const fact: DeclarationFact = { key, name: variable ? `$${expected}` : expected, qualifiedName, kind, entityType: callable ? kind === 'function' || options.bindingOnly ? 'function' : 'method' : kind === 'property' || kind === 'promoted-property' ? 'method' : 'class', signature: header(start, headerEnd), start, end: own.end, nameEnd: nameToken.end, range: source.range(start, own.end), declarationForm: callable && !ast(providerNode.body) ? 'declaration' : 'definition', ...parent ? { parent: parent.key } : {}, modifiers: modifiers(providerNode, scope.statement), ...scope.conditions.length ? { sourceConditions: [...scope.conditions] } : {} };
    const visibility = options.promoted ? ({ 1: 'public', 2: 'protected', 4: 'private' } as Record<number,string>)[Number(node.flags)] : typeof (scope.statement ?? node).visibility === 'string' ? String((scope.statement ?? node).visibility) || (member ? 'public' : undefined) : member ? 'public' : undefined;
    if (visibility) fact.visibility = visibility;
    if (attributes.length) fact.annotations = attributes.map(attribute => attribute.text);
    append(facts.declarations, fact);
    const bases: PhpDeclarationSource['bases'] = [];
    for (const [field, relation] of [['extends', 'extends'], ['implements', 'implements']] as const) for (const base of Array.isArray(node[field]) ? nodes(node[field]) : ast(node[field]) ? [ast(node[field])!] : []) bases.push({ kind: relation, text: text(base), range: site(base).range });
    const first = scope.statement ? nodes(scope.statement.properties ?? scope.statement.constants)[0] : undefined;
    const sharedName = first && name(first.name) ? originalName(first, name(first.name)!, scope.statement!.kind === 'propertystatement') : undefined;
    const declaredType = ast(providerNode.type) ?? ast(scope.statement?.type) ?? ast(first?.type);
    const visibilitySet = options.promoted ? ({ 1: 'public', 2: 'protected', 4: 'private' } as Record<number,string>)[Number(node.flagsSet)] : typeof (scope.statement ?? node).visibilitySet === 'string' ? String((scope.statement ?? node).visibilitySet) : undefined;
    const declaration: PhpDeclarationSource = { key, namespace: scope.namespace, scope: scope.scope, nameRange: source.range(nameToken.start, nameToken.end), headerRange: source.range(start, headerEnd), attributes, bases, ...declaredType ? { type: text(declaredType) } : {}, ...scope.statement ? { sharedHeader: header(site(scope.statement).start, sharedName?.start ?? site(first!).start) } : {}, ...visibilitySet ? { visibilitySet } : {}, ...options.promoted ? { promoted: true } : {}, ...options.bindingOnly ? { bindingOnly: true } : {} };
    append(php.declarations, declaration);
    return fact;
  }
  const closureBindings = new Map<Ast, DeclarationFact>();
  const namedCalls: {node:Ast;namespace:string;scope:string;conditions:string[]}[] = [];
  const stack: { node: Ast; scope: Scope; depth: number }[] = [{ node: root, scope: { namespace: '', scope: `php-file:0:${content.length}`, conditions: [], deferred: false }, depth: 0 }];
  let visited = 0;
  while (stack.length && !facts.truncated) {
    const { node, scope, depth } = stack.pop()!;
    if (++visited > MAX_NODES || depth > MAX_DEPTH) { limit(); break; }
    let next: Scope = scope;
    if(node.kind==='call'&&ast(node.what)?.kind==='name')append(namedCalls,{node,namespace:scope.namespace,scope:scope.scope,conditions:scope.conditions});
    if (node.kind === 'namespace') {
      const span = site(node), key = `php-namespace:${span.start}:${span.end}`;
      append(php.namespaces, { ...span, key, name: String(node.name ?? ''), bracketed: node.withBrackets === true });
      next = { namespace: String(node.name ?? ''), scope: key, conditions: [], deferred: false };
    } else if (['class', 'interface', 'trait', 'enum'].includes(node.kind)) {
      if (node.isAnonymous || !name(node.name)) {
        append(php.regions, { ...site(node), kind: 'anonymous-class', conditions: scope.conditions });
        issue('php-anonymous-class-gap', 'Original anonymous class region retained; members have no qualified named type owner', node);
        next = { ...scope, owner: undefined, type: undefined, statement: undefined, conditions: [...scope.conditions, 'Original anonymous-class activation is unverified'], deferred: true };
      } else {
        const declaration = declare(node, scope, node.kind, name(node.name)!);
        next = { ...scope, owner: declaration, type: declaration, statement: undefined };
      }
    } else if (node.kind === 'function' && name(node.name)) {
      const declaration = declare(node, scope, 'function', name(node.name)!);
      next = { ...scope, owner: declaration, type: undefined, statement: undefined, conditions: [...scope.conditions, 'Original function body executes only when invoked'], deferred: true };
    } else if (node.kind === 'method') {
      const methodName = name(node.name);
      const declaration = scope.type && methodName ? declare(node, scope, methodName.toLowerCase() === '__construct' ? 'constructor' : methodName.toLowerCase() === '__destruct' ? 'destructor' : 'method', methodName) : undefined;
      next = { ...scope, owner: declaration, statement: undefined, conditions: [...scope.conditions, 'Original method body executes only when invoked'], deferred: true };
    } else if (['propertystatement', 'classconstant', 'constantstatement'].includes(node.kind)) next = { ...scope, statement: node };
    else if (node.kind === 'property' && scope.type && name(node.name)) {
      const declaration = declare(node, scope, 'property', name(node.name)!, true);
      next = { ...scope, owner: declaration, statement: undefined };
    } else if (node.kind === 'constant' && name(node.name)) declare(node, scope, scope.type ? 'class-constant' : 'constant', name(node.name)!);
    else if (node.kind === 'enumcase' && scope.type && name(node.name)) declare(node, scope, 'enum-case', name(node.name)!);
    else if (node.kind === 'propertyhook' && ['property','promoted-property'].includes(scope.owner?.kind ?? '') && name(node.name)) {
      const declaration = declare(node, scope, `property-${name(node.name)}`, name(node.name)!);
      next = { ...scope, owner: declaration, conditions: [...scope.conditions, 'Original property hook execution is unverified'], deferred: true };
    } else if (node.kind === 'parameter' && name(node.name)) {
      const promoted = Number(node.flags) !== 0 && scope.owner?.kind === 'constructor' && !!scope.type;
      append(php.bindings, { ...site(node), name: name(node.name)!, kind: 'parameter', ...scope.owner ? { owner: scope.owner.key } : {}, ...promoted ? { promoted: true } : {} });
      if (promoted) { const declaration = declare(node, scope, 'promoted-property', name(node.name)!, true, { promoted: true }); next = { ...scope, owner: declaration }; }
    } else if (node.kind === 'assign' && node.operator === '=') {
      const left = ast(node.left), right = ast(node.right);
      if (left?.kind === 'variable' && typeof left.name === 'string' && right && ['closure', 'arrowfunc'].includes(right.kind)) {
        const declaration = declare(node, scope, right.kind === 'closure' ? 'closure-binding' : 'arrow-binding', left.name, true, { bindingOnly: true, nameNode: { ...left, name: left }, headerNode: right });
        if (declaration) closureBindings.set(right, declaration);
      }
    } else if (node.kind === 'closure' || node.kind === 'arrowfunc') {
      const owner = closureBindings.get(node);
      append(php.regions, { ...site(node), kind: node.kind === 'closure' ? 'closure' : 'arrow-function', conditions: scope.conditions });
      if (!owner) issue('php-unbound-callable-gap', 'Original anonymous callable region retained; no named binding or generated function is invented', node);
      for (const capture of nodes(node.uses)) if (typeof capture.name === 'string') append(php.bindings, { ...site(capture), name: capture.name, kind: 'closure-capture', ...owner ? { owner: owner.key } : {} });
      next = { ...scope, owner, type: undefined, statement: undefined, conditions: [...scope.conditions, 'Original anonymous callable executes only when invoked'], deferred: true };
    } else if (node.kind === 'usegroup' && !scope.owner && !scope.deferred) {
      for (const item of nodes(node.items)) {
        const specifier = [typeof node.name === 'string' ? node.name : '', String(item.name ?? '')].filter(Boolean).join('\\').replace(/^\\/, '');
        const kind = item.type ?? node.type ?? 'class';
        append(php.imports, { ...site(item), namespace: scope.namespace, scope: scope.scope, kind: kind === 'function' ? 'function' : kind === 'const' ? 'const' : 'class', specifier, alias: name(item.alias) ?? specifier.split('\\').at(-1)!, conditions: scope.conditions });
      }
    } else if (node.kind === 'traituse') append(php.traits, { ...site(node), ...scope.type ? { owner: scope.type.key } : {}, names: nodes(node.traits).map(text), adaptations: nodes(node.adaptations).map(adaptation => ({ kind: adaptation.kind, text: text(adaptation), range: site(adaptation).range })) });
    else if (node.kind === 'include') append(php.loads, { ...site(node), kind: `${node.require ? 'require' : 'include'}${node.once ? '_once' : ''}` as PhpSyntaxFacts['loads'][number]['kind'], expression: text(ast(node.target)), path: pathExpression(ast(node.target)), namespace: scope.namespace, scope: scope.scope, conditions: scope.conditions });
    else if (node.kind === 'call' && ast(node.what)?.kind === 'name' && ['chdir','set_include_path','restore_include_path','ini_set','ini_restore','spl_autoload_register','spl_autoload_unregister','stream_wrapper_register','stream_wrapper_unregister','stream_wrapper_restore'].includes(String(ast(node.what)!.name).split('\\').at(-1)!.toLowerCase())) append(php.loaderChanges, { ...site(node), name: String(ast(node.what)!.name), conditions: scope.conditions });
    else if (node.kind === 'inline') append(php.regions, { ...site(node), kind: 'inline-html', conditions: scope.conditions });
    else if (['if', 'while', 'do', 'for', 'foreach', 'switch', 'case', 'try', 'catch', 'finally'].includes(node.kind)) next = { ...scope, conditions: [...scope.conditions, `Declaration occurs in original ${node.kind} syntax; activation is unverified`] };
    const children: Ast[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments'].includes(key)) continue;
      if (Array.isArray(value)) children.push(...nodes(value)); else if (ast(value)) children.push(ast(value)!);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, scope: next, depth: depth + 1 });
  }
  facts.declarations.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind, 'en'));
  const mutations=new Set(['chdir','set_include_path','restore_include_path','ini_set','ini_restore','spl_autoload_register','spl_autoload_unregister','stream_wrapper_register','stream_wrapper_unregister','stream_wrapper_restore']);
  for(const call of namedCalls) {
    const callee=String(ast(call.node.what)!.name);
    const imported=php.imports.find(item=>item.scope===call.scope&&item.kind==='function'&&item.alias.toLowerCase()===callee.toLowerCase());
    if(imported&&mutations.has(imported.specifier.toLowerCase())&&!php.loaderChanges.some(change=>change.start===site(call.node).start))append(php.loaderChanges,{...site(call.node),name:imported.specifier,conditions:call.conditions});
  }
  return facts;
}
