import ts from 'typescript';
import path from 'node:path';
import { declarationHashes, evidence, type Entity } from '../../core/graph.js';
import { frameworkBinding, unwrap, valueDeclaration } from './typescript-binding.js';
import { declareInlineHandler, sourceRange, type TypeScriptFrameworkPack, type TypeScriptPackFile, type TypeScriptPackScope } from './typescript-pack.js';

type Kind = 'cli' | 'mcp' | 'worker' | 'function';
type Callable = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
const callable = (node: ts.Node): node is Callable => ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
const verbs = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
/** Test and fixture files (as the project model scopes them, plus `*.test.*` and e2e). */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures|__fixtures__|testdata)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** A function the server's request reaches, with the declarations holding the request, its URL object or its path, and where it was handed over. */
interface Router { frame: TypeScriptPackFile; fn: Callable; requests: Set<ts.Declaration>; urls: Set<ts.Declaration>; paths: Set<ts.Declaration>; via?: { router: Router; call: ts.CallExpression } }
const disjuncts = (expression: ts.Expression): ts.Expression[] => { const value = unwrap(expression); return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken ? [...disjuncts(value.left),...disjuncts(value.right)] : [value]; };
const returns = (node: ts.Node): boolean => {
  if (callable(node)) return false;
  if (ts.isReturnStatement(node)||ts.isThrowStatement(node)) return true;
  return ts.forEachChild(node,child=>returns(child)||undefined) ?? false;
};
/** The one expression a function returns (an arrow's body, or a lone return statement). */
const returned = (fn: Callable): ts.Expression | undefined => !fn.body ? undefined : !ts.isBlock(fn.body) ? fn.body : fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0]!) ? fn.body.statements[0]!.expression : undefined;

/** Original Node registrations only: no target execution, package loading or
 * name-only callback matching. Dispatch branches own their exact source spans,
 * so one CLI command cannot walk the bodies of all the other commands. */
export const nodeRuntimePack: TypeScriptFrameworkPack = {
  id: 'node-runtime', version: '1.1.0',
  applies: scope => scope.files.some(frame => frame.file.application?.ecosystems.includes('node')),
  declare(scope) { new NodeEntries(scope).run(); },
  finish(scope) { new NodeEntries(scope).effects(); },
};

class NodeEntries {
  private readonly occurrences = new Map<string,number>();
  private readonly registrations = new Map<string,number>();
  private readonly writes = new Set<ts.Declaration>();
  private readonly assignments = new Map<ts.Declaration, ts.Expression[]>();
  private readonly frames: Map<ts.SourceFile, TypeScriptPackFile>;
  constructor(private readonly scope: TypeScriptPackScope) {
    this.frames = new Map(scope.files.map(frame => [frame.source, frame]));
    for (const frame of scope.files) {
      const visit = (node: ts.Node): void => {
        const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
        if (target) {
          const declaration = valueDeclaration(target, frame.state.checker);
          if (declaration) { this.writes.add(declaration); if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) this.assignments.set(declaration,[...this.assignments.get(declaration) ?? [],node.right]); }
          if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) { const receiver = valueDeclaration(target.expression,frame.state.checker); if (receiver) this.writes.add(receiver); }
        }
        ts.forEachChild(node, visit);
      };
      visit(frame.source);
    }
  }
  private binding(frame: TypeScriptPackFile, expression: ts.Expression) { return frameworkBinding(expression, frame.state.checker, this.scope.services); }
  private importedCallee(frame:TypeScriptPackFile,expression:ts.Expression):boolean {
    expression=unwrap(expression);
    if (!ts.isIdentifier(expression)) return false;
    const declaration=frame.state.checker.getSymbolAtLocation(expression)?.declarations?.[0];
    if (!declaration) return false;
    if (this.writes.has(declaration)) return false;
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isImportEqualsDeclaration(declaration)) return true;
    return ts.isVariableDeclaration(declaration) && !!declaration.initializer && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer) || ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText() === 'require');
  }
  private global(frame: TypeScriptPackFile, expression: ts.Expression, name: string): boolean {
    const declarations = frame.state.checker.getSymbolAtLocation(expression)?.declarations ?? [];
    return ts.isIdentifier(expression) && expression.text === name && declarations.every(declaration => declaration.getSourceFile().isDeclarationFile && /\/typescript\/lib\//.test(declaration.getSourceFile().fileName));
  }
  private owner(frame: TypeScriptPackFile, node: ts.Node): Entity {
    for (let at: ts.Node | undefined = node; at; at = at.parent) { const owner = frame.owners.get(at); if (owner) return owner; }
    return this.scope.context.graph.entities.get(frame.file.id)!;
  }
  private literal(frame: TypeScriptPackFile, value: ts.Expression, depth = 0): string | undefined {
    value = unwrap(value);
    if (depth > 8) return undefined;
    if (ts.isStringLiteralLike(value)) return value.text;
    const declaration = valueDeclaration(value, frame.state.checker);
    return declaration && !this.writes.has(declaration) && ts.isVariableDeclaration(declaration) && declaration.initializer ? this.literal(frame, declaration.initializer, depth + 1) : undefined;
  }
  private functionOf(frame: TypeScriptPackFile, expression: ts.Expression, depth = 0): Callable | undefined {
    expression = unwrap(expression);
    if (depth > 8) return undefined;
    if (callable(expression)) return expression;
    const declaration = valueDeclaration(expression, frame.state.checker);
    if (declaration && this.writes.has(declaration)) return undefined;
    if (declaration && callable(declaration)) return declaration;
    return declaration && !this.writes.has(declaration) && ts.isVariableDeclaration(declaration) && declaration.initializer ? this.functionOf(frame, declaration.initializer, depth + 1) : undefined;
  }
  private handler(frame: TypeScriptPackFile, expression: ts.Expression, identity: string): Entity | undefined {
    const fn = this.functionOf(frame, expression);
    if (!fn) return undefined;
    return this.scope.services.declarations.get(fn) ?? (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? declareInlineHandler(this.scope, fn, 'node-runtime', identity, identity) : undefined);
  }
  private registrationName(frame:TypeScriptPackFile,node:ts.Node,label:string):string {
    const owner=this.owner(frame,node),key=`${frame.file.path}:${owner.id}:${label}`,ordinal=(this.registrations.get(key) ?? 0)+1;
    this.registrations.set(key,ordinal);
    return `${label} · ${frame.file.path} · ${owner.metadata.qualifiedName ?? owner.name} #${ordinal}`;
  }
  private issue(frame: TypeScriptPackFile, node: ts.Node, text: string): void {
    const owner = this.owner(frame, node), line = sourceRange(node).startLine;
    const gaps = (owner.metadata.flowGaps ??= []) as { line: number; text: string }[];
    if (!gaps.some(gap => gap.line === line && gap.text === text)) gaps.push({ line, text });
    this.scope.context.graph.diagnose({ analyzer: 'node-runtime', severity: 'warning', code: 'unresolved-flow-dispatch', entityId: owner.id, file: frame.file.path, line, reason: text });
  }
  private branch(frame: TypeScriptPackFile, node: ts.Node, name: string): Entity {
    const graph = this.scope.context.graph, parent = this.owner(frame, node.parent), range = sourceRange(node);
    const key = `${frame.file.path}:${parent.id}:${name}`, ordinal = this.occurrences.get(key) ?? 0; this.occurrences.set(key,ordinal+1);
    const id = graph.id('dispatch-branch', frame.file.path, String(parent.metadata.qualifiedName ?? parent.name), name, String(ordinal));
    const entity = graph.contain({ id, type: 'function', name, path: frame.file.path, language: frame.file.language, parentId: parent.id, sourceRange: range, metadata: { role: 'dispatch-branch', framework: 'node-runtime', qualifiedName: `${parent.metadata.qualifiedName ?? parent.name}.${name}`, executionContext: 'server', ...declarationHashes(node.getText(), 0) }, evidence: [evidence('framework','node-runtime',frame.file.path,range.startLine,'Original guarded dispatch branch; not a synthesized runtime function')] });
    graph.relate(parent.id,entity.id,'invokes',entity.evidence,{forms:['dispatch'],lines:[range.startLine]});
    frame.owners.set(node, entity); this.scope.services.declarations.set(node, entity);
    return entity;
  }
  private entry(frame: TypeScriptPackFile, node: ts.Node, name: string, kind: Kind, handler?: Entity, configured = false): Entity {
    const graph = this.scope.context.graph, range = sourceRange(node), app = frame.file.application!;
    const id = graph.id('flow-entry', app.name, frame.file.path, kind, name);
    const existing = graph.entities.get(id);
    if (existing) {
      if (handler) graph.relate(existing.id,handler.id,'handles',[evidence('framework','node-runtime',frame.file.path,range.startLine,'Repeated original registration of this entry')],{lines:[range.startLine],forms:['handler']});
      (existing.metadata.flowGaps ??= [] as unknown[]);
      (existing.metadata.flowGaps as unknown[]).push({line:range.startLine,text:'Repeated entry registration has unresolved dispatch precedence'});
      return existing;
    }
    const fact = evidence('framework','node-runtime',frame.file.path,range.startLine, configured ? 'Explicit configured source entry; the trigger is a recorded assumption' : 'Original Node or MCP callback/dispatch registration');
    const entity = graph.contain({ id, type: 'user_flow', name, path: frame.file.path, parentId: this.scope.context.applicationIds.get(app.name)!, sourceRange: range, metadata: { flowKind: kind, registration: configured ? 'configured' : 'explicit', framework: 'node-runtime' }, evidence: [fact] });
    if (handler) graph.relate(entity.id, handler.id, 'handles', [fact], { lines: [range.startLine], forms: ['handler'] });
    else this.issue(frame, node, `${name}: callback or dispatch target could not be resolved`);
    return entity;
  }
  /** Node argv/parseArgs provenance follows declarations, never the spelling of
   * a variable named command, args, request or pathname. */
  private cliSelector(frame: TypeScriptPackFile, expression: ts.Expression, depth = 0): boolean {
    expression = unwrap(expression); if (depth > 12) return false;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isNumericLiteral(expression.argumentExpression)) {
      const base = unwrap(expression.expression), n = Number(expression.argumentExpression.text);
      if (n === 2 && ts.isPropertyAccessExpression(base) && base.name.text === 'argv' && this.global(frame,base.expression,'process')) return true;
      const declaration = valueDeclaration(base,frame.state.checker);
      if (declaration && this.writes.has(declaration)) return false;
      if (n === 0 && declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent)) {
        const call = declaration.parent.parent.initializer;
        return (declaration.propertyName ?? declaration.name).getText() === 'positionals' && !!call && ts.isCallExpression(call) && ['node:util','util'].includes(this.binding(frame,call.expression)?.module ?? '') && this.binding(frame,call.expression)?.member === 'parseArgs';
      }
      if (n === 0 && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
        const call = declaration.initializer, access = call.expression;
        return ts.isPropertyAccessExpression(access) && access.name.text === 'slice' && call.arguments.length === 1 && call.arguments[0]?.getText() === '2' && ts.isPropertyAccessExpression(access.expression) && access.expression.name.text === 'argv' && this.global(frame,access.expression.expression,'process');
      }
    }
    const declaration = valueDeclaration(expression,frame.state.checker);
    return !!declaration && !this.writes.has(declaration) && ts.isVariableDeclaration(declaration) && !!declaration.initializer && this.cliSelector(frame,declaration.initializer,depth+1);
  }
  private equality(frame: TypeScriptPackFile, expression: ts.Expression, selector: (value: ts.Expression) => boolean): string | undefined {
    expression = unwrap(expression);
    if (!ts.isBinaryExpression(expression)) return undefined;
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return this.equality(frame,expression.left,selector) ?? this.equality(frame,expression.right,selector);
    if (![ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken].includes(expression.operatorToken.kind)) return undefined;
    return selector(expression.left) ? this.literal(frame,expression.right) : selector(expression.right) ? this.literal(frame,expression.left) : undefined;
  }
  private dispatch(frame: TypeScriptPackFile, root: ts.Node, selector: (value: ts.Expression) => boolean, emit: (node: ts.Node, name: string, condition: ts.Node) => void): number {
    let count = 0;
    const visit = (node: ts.Node): void => {
      if (node !== root && callable(node)) return;
      if (ts.isIfStatement(node)) {
        const name = this.equality(frame,node.expression,selector);
        if (name !== undefined) { emit(node.thenStatement,name,node.expression); count++; }
      } else if (ts.isSwitchStatement(node) && selector(node.expression)) {
        for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) {
          const name = this.literal(frame,clause.expression);
          if (name !== undefined) {
            emit(clause,name,clause.expression); count++;
            const last = clause.statements.at(-1);
            if (!last || ![ts.SyntaxKind.ReturnStatement,ts.SyntaxKind.ThrowStatement,ts.SyntaxKind.BreakStatement].includes(last.kind)) this.issue(frame,clause,'Switch fallthrough beyond this source clause is not modeled');
          }
          else this.issue(frame,clause,'Dynamic dispatch case: no literal entry name can be proved');
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(root); return count;
  }
  run(): void {
    for (const frame of this.scope.files) {
      if (!frame.file.application) continue;
      const app = frame.file.application;
      for (const configured of app.flowEntries ?? []) {
        if (path.posix.join(app.path === '.' ? '' : app.path,configured.path) !== frame.file.path) continue;
        const candidates = [...frame.owners.entries()].filter(([node,entity]) => callable(node) && (entity.metadata.qualifiedName === configured.symbol || entity.name === configured.symbol));
        if (candidates.length !== 1) { this.issue(frame,frame.source,`Configured flow ${configured.name}: source symbol ${configured.symbol} is missing or ambiguous`); continue; }
        const [fn,handler] = candidates[0]!, kind = configured.kind ?? 'function';
        if (configured.selector && callable(fn)) {
          const parameter = fn.parameters.find(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === configured.selector);
          if (!parameter || !fn.body) { this.issue(frame,fn,`Configured selector ${configured.selector} is not a source parameter`); continue; }
          const count = this.dispatch(frame,fn.body,value => valueDeclaration(unwrap(value),frame.state.checker) === parameter,(node,name) => this.entry(frame,node,`${configured.name} ${name}`,kind,this.branch(frame,node,`${kind}:${name}`),true));
          if (!count) this.entry(frame,fn,configured.name,kind,handler,true);
        } else this.entry(frame,fn,configured.name,kind,handler,true);
      }
      const visit = (node: ts.Node): void => {
        if (callable(node) && node.body) this.dispatch(frame,node.body,value => this.cliSelector(frame,value),(branch,name) => this.entry(frame,branch,`${app.name} ${name}`,'cli',this.branch(frame,branch,`cli:${name}`)));
        if (ts.isCallExpression(node)) this.registration(frame,node);
        ts.forEachChild(node,visit);
      };
      this.dispatch(frame,frame.source,value => this.cliSelector(frame,value),(branch,name) => this.entry(frame,branch,`${app.name} ${name}`,'cli',this.branch(frame,branch,`cli:${name}`)));
      visit(frame.source);
    }
  }
  private registration(frame: TypeScriptPackFile, call: ts.CallExpression): void {
    const callee=unwrap(call.expression);
    if (ts.isPropertyAccessExpression(callee) && !['createServer','on','once','addListener','tool','registerTool','setRequestHandler'].includes(callee.name.text)) return;
    if (!ts.isPropertyAccessExpression(callee) && !this.importedCallee(frame,callee)) return;
    const binding = ts.isPropertyAccessExpression(callee) && callee.name.text !== 'createServer' ? undefined : this.binding(frame,call.expression);
    if (binding && ['node:http','http','node:https','https'].includes(binding.module) && binding.member === 'createServer') {
      const argument = call.arguments.at(-1), fn = argument && this.functionOf(frame,argument);
      const identity=this.registrationName(frame,call,'HTTP request');
      const handler = argument && this.handler(frame,argument,identity);
      if (!fn?.body || !handler) { this.issue(frame,call,'Node HTTP request callback could not be resolved'); return; }
      this.http(frame,call,fn,handler); return;
    }
    const access = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(access)) return;
    const receiver = unwrap(access.expression);
    if (['on','once','addListener'].includes(access.name.text) && call.arguments[0] && this.literal(frame,call.arguments[0]) === 'message') {
      const imported = this.binding(frame,receiver), declaration = valueDeclaration(receiver,frame.state.checker);
      const initial = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      const factory = initial && ts.isCallExpression(initial) ? this.binding(frame,initial.expression) : undefined;
      const ctor=initial && ts.isNewExpression(initial) ? this.binding(frame,initial.expression) : undefined;
      if (declaration && this.writes.has(declaration)) return;
      const worker = this.global(frame,receiver,'process') || imported?.module === 'node:worker_threads' && imported.member === 'parentPort' || imported?.module === 'worker_threads' && imported.member === 'parentPort' || factory && ['node:child_process','child_process'].includes(factory.module) && factory.member === 'fork' || ctor && ['node:worker_threads','worker_threads'].includes(ctor.module) && ctor.member === 'Worker';
      if (!worker) return;
      const argument = call.arguments[1];
      const identity=this.registrationName(frame,call,'Worker message');
      const handler = argument && this.handler(frame,argument,identity);
      const entry = this.entry(frame,call,identity,'worker',handler);
      if (!handler) entry.metadata.flowGaps = [{ line: sourceRange(call).startLine, text: 'Message callback is unresolved' }];
      const fn=argument && this.functionOf(frame,argument),parameter=fn?.parameters[0];
      if (fn?.body && parameter) this.dispatch(frame,fn.body,value=>{
        value=unwrap(value);
        return ts.isPropertyAccessExpression(value) && value.name.text === 'type' && valueDeclaration(unwrap(value.expression),frame.state.checker) === parameter && !this.writes.has(parameter);
      },(node,name)=>this.entry(frame,node,`${identity.replace('Worker message',`Worker ${name}`)}`,'worker',this.branch(frame,node,`message:${name}`)));
    }
    if (['tool','registerTool','setRequestHandler'].includes(access.name.text)) {
      const declaration = valueDeclaration(receiver,frame.state.checker);
      if (declaration && this.writes.has(declaration)) return;
      const init = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      const ctor = init && ts.isNewExpression(init) ? this.binding(frame,init.expression) : undefined;
      if (!ctor?.module.startsWith('@modelcontextprotocol/sdk/') || !['Server','McpServer'].includes(ctor.member)) return;
      const first = call.arguments[0], name = first && this.literal(frame,first);
      const schema = first && this.binding(frame,first);
      const label = name ?? (schema?.module.startsWith('@modelcontextprotocol/sdk/') ? schema.member : undefined);
      const argument = call.arguments.at(-1);
      const identity=this.registrationName(frame,call,`MCP ${label ?? 'dynamic'}`);
      const handler = argument && this.handler(frame,argument,identity);
      const entry = this.entry(frame,call,`MCP ${label ?? `dynamic registration · ${frame.file.path}:${sourceRange(call).startLine}`}`,'mcp',handler);
      if (!label || !handler) entry.metadata.flowGaps = [{ line: sourceRange(call).startLine, text: !label ? 'MCP registration name is dynamic' : 'MCP callback is unresolved' }];
    }
  }
  private http(frame: TypeScriptPackFile, registration: ts.CallExpression, fn: Callable, callback: Entity): void {
    const request = fn.parameters[0]; if (!request || !fn.body) return;
    const count = this.routes({ frame, fn, requests: new Set([request]), urls: new Set(), paths: new Set() }, frame, callback, new Set());
    if (!count) {
      const entry=this.entry(frame,registration,callback.name,'function',callback);
      entry.metadata.flowChannel='http';
      entry.metadata.flowGaps=[{line:sourceRange(registration).startLine,text:'Node request callback detected; no literal route inventory was extracted. Dynamic or delegated routing remains outside this adapter.'}];
    }
    this.issue(frame,registration,'HTTP dispatch coverage is limited to literal path branches (in the callback and the functions it hands its request to); dynamic routes require their own registration proof');
  }
  /**
   * Literal path branches of a function the server's request reaches: the
   * callback, then each function it hands the request, its URL or its path to
   * (`handleProjectionRoute(context, new URL(request.url), response)`),
   * followed by declaration, never by name.
   */
  private routes(router: Router, server: TypeScriptPackFile, callback: Entity, seen: Set<Callable>): number {
    const { frame, fn } = router;
    if (!fn.body || seen.has(fn)) return 0;
    seen.add(fn);
    let count = this.dispatch(frame,fn.body,value => this.selector(router,value,'pathname') || this.selector(router,value,'url'),(node,url,condition) => {
      if (!/^\/[\w/.-]*$/.test(url)) { this.issue(frame,condition,'Node HTTP path is outside the literal path contract'); return; }
      const method = this.methodAt(router,node), graph = this.scope.context.graph, range = sourceRange(condition), app = server.file.application!;
      const handler = this.branch(frame,node,`http:${method}:${url}`), fact = evidence('framework','node-runtime',frame.file.path,range.startLine,router.via ? 'Literal request path dispatch in a function the Node HTTP server callback hands its request to' : 'Literal request path dispatch inside an imported Node HTTP server callback');
      const gates=this.gates(router,node,url,method);
      if(gates.length) handler.metadata.flowGaps ??= [];
      for(const gate of gates)(handler.metadata.flowGaps as unknown[]).push(gate);
      const id = graph.id('node-endpoint',app.name,frame.file.path,callback.id,method,url);
      const existing = graph.entities.get(id);
      if (existing) { existing.metadata.constraintsUnresolved = true; this.issue(frame,node,'Repeated path dispatch has unresolved branch precedence'); return; }
      const rawUrl = ts.isExpression(condition) && this.equality(frame,condition,value => this.selector(router,value,'url')) === url;
      const endpoint = graph.contain({ id, type: 'api_endpoint', name: `${method} ${url}`, path: frame.file.path, sourceRange: sourceRange(node), parentId: this.scope.context.applicationIds.get(app.name)!, metadata: { framework: 'node-http', registration: 'explicit', method, routePath: url, rawUrl, callback: callback.id,...(gates.length ? {constraintsUnresolved:true}:{}) }, evidence: [fact] });
      graph.relate(endpoint.id,handler.id,'handles',[fact],{ lines: [range.startLine], forms: ['handler'] });
    });
    let depth = 0; for (let at = router.via; at; at = at.router.via) depth++;
    // A server a test starts stands in for the real one: following it into the application's routers would give each route a twin.
    if (depth >= 3 || TEST_FILE.test(server.file.path)) return count;
    const visit = (node: ts.Node): void => {
      if (node !== fn.body && callable(node)) return;
      if (ts.isCallExpression(node)) {
        const target = this.functionOf(frame,node.expression), inner = target && this.frames.get(target.getSourceFile());
        if (target?.body && inner && !seen.has(target)) {
          const next: Router = { frame: inner, fn: target, requests: new Set(), urls: new Set(), paths: new Set(), via: { router, call: node } };
          node.arguments.forEach((argument,index) => {
            const parameter = target.parameters[index];
            if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || this.writes.has(parameter)) return;
            const declaration = valueDeclaration(unwrap(argument),frame.state.checker);
            if (declaration && router.requests.has(declaration) && !this.writes.has(declaration)) next.requests.add(parameter);
            else if (this.urlObject(router,argument)) next.urls.add(parameter);
            else if (this.selector(router,argument,'pathname')) next.paths.add(parameter);
          });
          if (next.requests.size || next.urls.size || next.paths.size) count += this.routes(next,server,callback,seen);
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(fn.body);
    return count;
  }
  /** Whether a value is the request's URL, pathname or method, through declarations from the request or a router's parameters. */
  private selector(router: Router, value: ts.Expression, field: 'url'|'method'|'pathname', depth = 0): boolean {
    const { frame } = router;
    value = unwrap(value); if (depth > 12) return false;
    if (field === 'url' && ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isStringLiteralLike(value.right)) return this.selector(router,value.left,field,depth+1);
    if (ts.isPropertyAccessExpression(value)) {
      const receiver = valueDeclaration(value.expression,frame.state.checker);
      if (value.name.text === field && receiver && router.requests.has(receiver) && !this.writes.has(receiver)) return field !== 'pathname';
      if (field === 'pathname' && value.name.text === 'pathname') return this.urlObject(router,value.expression,depth+1);
    }
    const declaration = valueDeclaration(value,frame.state.checker);
    if (field === 'pathname' && declaration && router.paths.has(declaration) && !this.writes.has(declaration)) return true;
    // `const { pathname } = url`
    if (field === 'pathname' && declaration && ts.isBindingElement(declaration) && !declaration.dotDotDotToken && !this.writes.has(declaration) && (declaration.propertyName ?? declaration.name).getText() === 'pathname' && ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) return this.urlObject(router,declaration.parent.parent.initializer,depth+1);
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const assignments = this.assignments.get(declaration) ?? [];
      const initial = !this.writes.has(declaration) ? declaration.initializer : !declaration.initializer && assignments.length === 1 ? assignments[0] : undefined;
      return !!initial && this.selector(router,initial,field,depth+1);
    }
    return false;
  }
  /** A URL object of the request: `new URL(request.url, base)`, a variable holding one, or a router parameter given one. */
  private urlObject(router: Router, value: ts.Expression, depth = 0): boolean {
    value = unwrap(value); if (depth > 12) return false;
    if (ts.isNewExpression(value)) return this.global(router.frame,value.expression,'URL') && !!value.arguments?.[0] && this.selector(router,value.arguments[0],'url',depth+1);
    const declaration = valueDeclaration(value,router.frame.state.checker);
    if (!declaration || this.writes.has(declaration)) return false;
    if (router.urls.has(declaration)) return true;
    return ts.isVariableDeclaration(declaration) && !!declaration.initializer && this.urlObject(router,declaration.initializer,depth+1);
  }
  /** The HTTP method a branch is limited to by the guards around and before it, here or where the request was handed over. */
  private methodAt(router: Router, node: ts.Node): string {
    const { frame, fn } = router, method = (value: ts.Expression) => this.selector(router,value,'method');
    for (let at: ts.Node | undefined = node; at && at !== fn; at = at.parent) {
      if (ts.isIfStatement(at) && at.thenStatement.pos <= node.pos && at.thenStatement.end >= node.end) {
        const verb = this.equality(frame,at.expression,method);
        if (verb && verbs.includes(verb)) return verb;
      }
      if (ts.isCaseClause(at) && ts.isSwitchStatement(at.parent.parent) && method(at.parent.parent.expression)) {
        const verb=this.literal(frame,at.expression);if(verb&&verbs.includes(verb))return verb;
      }
    }
    if (fn.body && ts.isBlock(fn.body)) for (const statement of fn.body.statements) {
      if (statement.end > node.pos) break;
      if (!ts.isIfStatement(statement)) continue;
      // `if (request.method !== 'POST' || …) return …`: past it, the method is POST.
      const verb = disjuncts(statement.expression).map(term => ts.isBinaryExpression(term) && [ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(term.operatorToken.kind) ? method(term.left) ? this.literal(frame,term.right) : method(term.right) ? this.literal(frame,term.left) : undefined : undefined).find(Boolean);
      const terminal = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements.at(-1) : statement.thenStatement;
      if (verb && verbs.includes(verb) && terminal && (ts.isReturnStatement(terminal) || ts.isThrowStatement(terminal))) return verb;
    }
    return router.via ? this.methodAt(router.via.router,router.via.call) : 'ANY';
  }
  private knownGuard(router: Router, expression: ts.Expression): boolean {
    expression=unwrap(expression);
    if (!ts.isBinaryExpression(expression)) return false;
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return this.knownGuard(router,expression.left)&&this.knownGuard(router,expression.right);
    if (![ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(expression.operatorToken.kind)) return false;
    const field=(value:ts.Expression)=>this.selector(router,value,'url')||this.selector(router,value,'pathname')||this.selector(router,value,'method');
    return field(expression.left)&&this.literal(router.frame,expression.right)!==undefined || field(expression.right)&&this.literal(router.frame,expression.left)!==undefined;
  }
  /**
   * Guards around or before a branch, outside the literal contract, that the
   * source does not prove let this path through (here, or where the request
   * was handed over): the endpoint stays a candidate, never an exact match.
   */
  private gates(router: Router, node: ts.Node, url: string, method: string, line?: number): { line: number; text: string }[] {
    const { fn } = router, found = new Set<ts.IfStatement>();
    for (let at: ts.Node | undefined = node.parent; at && at !== fn; at = at.parent) if (ts.isIfStatement(at) && !this.knownGuard(router,at.expression)) {
      const taken = at.thenStatement.pos <= node.pos && at.thenStatement.end >= node.end;
      if (this.holds(router,at.expression,url,method) !== taken) found.add(at);
    }
    if (fn.body && ts.isBlock(fn.body)) for (const statement of fn.body.statements) if (statement.end <= node.pos && ts.isIfStatement(statement) && !this.knownGuard(router,statement.expression) && returns(statement.thenStatement) && this.holds(router,statement.expression,url,method) !== false) found.add(statement);
    // A guard where the request was handed over is reported at the start of the function that received it.
    const own = [...found].map(gate => ({ line: line ?? sourceRange(gate.expression).startLine, text: `An earlier or enclosing routing guard is outside the literal Node dispatch contract: ${gate.expression.getText().slice(0,160)}${line === undefined ? '' : ` (${router.frame.file.path}:${sourceRange(gate.expression).startLine})`}` }));
    return router.via ? [...own, ...this.gates(router.via.router,router.via.call,url,method,line ?? sourceRange(fn).startLine)] : own;
  }
  /**
   * Whether a guard is truthy for a request to this literal path and method,
   * when the source alone decides it: path and method comparisons,
   * startsWith/endsWith/includes, literal lists, regular expressions, `!`,
   * `&&`, `||`, and predicates of the path that return one such expression
   * (`isProjectionPath(pathname)`). Anything else is unknown.
   */
  private holds(router: Router, expression: ts.Expression, url: string, method: string, depth = 0): boolean | undefined {
    const value = unwrap(expression), { frame } = router;
    if (depth > 6) return undefined;
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) { const inner = this.holds(router,value.operand,url,method,depth); return inner === undefined ? undefined : !inner; }
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const left = this.holds(router,value.left,url,method,depth), right = this.holds(router,value.right,url,method,depth);
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return left === false || right === false ? false : left && right ? true : undefined;
        return left === true || right === true ? true : left === false && right === false ? false : undefined;
      }
      // `(match = pattern.exec(pathname))`
      if (operator === ts.SyntaxKind.EqualsToken) return this.holds(router,value.right,url,method,depth);
      const equal = [ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken].includes(operator);
      if (!equal && ![ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken].includes(operator)) return undefined;
      const same = (side: ts.Expression, other: ts.Expression): boolean | undefined => {
        const text = this.literal(frame,other);
        if (text === undefined) return undefined;
        if (this.selector(router,side,'pathname')) return text === url;
        if (this.selector(router,side,'method')) return method === 'ANY' ? undefined : text === method;
        return undefined;
      };
      const result = same(value.left,value.right) ?? same(value.right,value.left);
      return result === undefined ? undefined : equal ? result : !result;
    }
    if (!ts.isCallExpression(value)) return undefined;
    const callee = unwrap(value.expression), [first] = value.arguments;
    if (ts.isPropertyAccessExpression(callee) && first && value.arguments.length === 1) {
      const name = callee.name.text, receiver = unwrap(callee.expression);
      if (['startsWith','endsWith','includes'].includes(name) && this.selector(router,receiver,'pathname')) {
        const text = this.literal(frame,first);
        return text === undefined ? undefined : name === 'startsWith' ? url.startsWith(text) : name === 'endsWith' ? url.endsWith(text) : url.includes(text);
      }
      if (name === 'includes' && ts.isArrayLiteralExpression(receiver) && this.selector(router,first,'pathname')) {
        const items = receiver.elements.map(element => ts.isSpreadElement(element) ? undefined : this.literal(frame,element));
        return items.some(item => item === undefined) ? undefined : items.includes(url);
      }
      if (['test','exec'].includes(name) && this.selector(router,first,'pathname')) return this.pattern(frame,receiver)?.test(url);
    }
    const target = this.functionOf(frame,callee), body = target && returned(target);
    const at = value.arguments.findIndex(argument => this.selector(router,argument,'pathname')), parameter = target?.parameters[at];
    const inner = target && this.frames.get(target.getSourceFile());
    if (!body || !parameter || !inner || !ts.isIdentifier(parameter.name) || this.writes.has(parameter)) return undefined;
    return this.holds({ frame: inner, fn: target, requests: new Set(), urls: new Set(), paths: new Set([parameter]) },body,url,method,depth+1);
  }
  /** A regular expression the source spells out: a literal, or `new RegExp` of literal text. */
  private pattern(frame: TypeScriptPackFile, expression: ts.Expression, depth = 0): RegExp | undefined {
    const value = unwrap(expression);
    if (depth > 8) return undefined;
    try {
      if (ts.isRegularExpressionLiteral(value)) { const end = value.text.lastIndexOf('/'); return new RegExp(value.text.slice(1,end),value.text.slice(end+1)); }
      if (ts.isNewExpression(value) && this.global(frame,value.expression,'RegExp') && value.arguments?.length && value.arguments.length <= 2) {
        const source = this.text(frame,value.arguments[0]!), flags = value.arguments[1] ? this.literal(frame,value.arguments[1]) : '';
        return source === undefined || flags === undefined ? undefined : new RegExp(source,flags);
      }
    } catch { return undefined; }
    const declaration = valueDeclaration(value,frame.state.checker);
    return declaration && !this.writes.has(declaration) && ts.isVariableDeclaration(declaration) && declaration.initializer ? this.pattern(frame,declaration.initializer,depth+1) : undefined;
  }
  /** A string the source spells out: a literal, or a template whose parts are literals. */
  private text(frame: TypeScriptPackFile, expression: ts.Expression): string | undefined {
    const value = unwrap(expression);
    if (!ts.isTemplateExpression(value)) return this.literal(frame,value);
    let text = value.head.text;
    for (const span of value.templateSpans) { const part = this.literal(frame,span.expression); if (part === undefined) return undefined; text += part + span.literal.text; }
    return text;
  }
  effects(): void {
    const entryHandlers = new Set([...this.scope.context.graph.relations.values()].filter(relation => relation.type === 'handles' && this.scope.context.graph.entities.get(relation.from)?.type === 'user_flow').map(relation => relation.to));
    for (const frame of this.scope.files) {
      const responseParameters = new Set<ts.Declaration>();
      const callbacks = (node:ts.Node):void => {
        if (ts.isCallExpression(node)) {
          const expression=unwrap(node.expression);
          const candidate=ts.isPropertyAccessExpression(expression) ? expression.name.text === 'createServer' : this.importedCallee(frame,expression);
          const binding = candidate ? this.binding(frame,node.expression) : undefined, argument = node.arguments.at(-1), fn = binding && argument && this.functionOf(frame,argument);
          if (binding && ['node:http','http','node:https','https'].includes(binding.module) && binding.member === 'createServer' && fn?.parameters[1]) responseParameters.add(fn.parameters[1]);
        }
        ts.forEachChild(node,callbacks);
      }; callbacks(frame.source);
      const add = (node: ts.Node, category: 'file'|'process'|'response', operation: string, detail: string, via: string) => {
        const owner = this.owner(frame,node), list = (owner.metadata.effects ??= []) as Record<string,unknown>[];
        const line = sourceRange(node).startLine;
        if (!list.some(effect => effect.line === line && effect.operation === operation)) list.push({ category,operation,detail,line,via });
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee=unwrap(node.expression);
          const candidate=ts.isPropertyAccessExpression(callee) ? /^(writeFile|writeFileSync|appendFile|mkdir|rename|rm|unlink)$/.test(callee.name.text) : this.importedCallee(frame,callee);
          const binding = candidate ? this.binding(frame,node.expression) : undefined;
          if (binding && /^(?:node:)?fs(?:\/promises)?$/.test(binding.module) && /^(writeFile|writeFileSync|appendFile|mkdir|rename|rm|unlink)$/.test(binding.member)) add(node,'file',binding.member,node.arguments[0]?.getText().slice(0,160) ?? 'file',`${binding.module}.${binding.member}`);
          const access = node.expression;
          if (ts.isPropertyAccessExpression(access) && access.name.text === 'end') {
            let receiver = access.expression;
            while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) receiver = receiver.expression.expression;
            const declaration = valueDeclaration(receiver,frame.state.checker);
            if (declaration && responseParameters.has(declaration)) add(node,'response','end',node.arguments[0]?.getText().slice(0,160) ?? 'HTTP response','node:http.ServerResponse.end');
          }
          if (ts.isPropertyAccessExpression(access) && access.name.text === 'postMessage') {
            const imported = this.binding(frame,access.expression);
            if (imported && ['node:worker_threads','worker_threads'].includes(imported.module) && imported.member === 'parentPort') {
              add(node,'process','send',node.arguments[0]?.getText().slice(0,160) ?? '',`${imported.module}.parentPort.postMessage`);
              this.issue(frame,node,'Worker message leaves this thread; its receiving callback is not proved by the payload alone');
            }
          }
          if (ts.isPropertyAccessExpression(access) && this.global(frame,access.expression,'process') && ['send','exit'].includes(access.name.text)) {
            add(node,'process',access.name.text,node.arguments[0]?.getText().slice(0,160) ?? '',`process.${access.name.text}`);
            if (access.name.text === 'send') this.issue(frame,node,'IPC message leaves this process; no receiver binding is proved by its payload alone');
          }
          if (ts.isPropertyAccessExpression(access) && this.global(frame,access.expression,'console') && ['log','error'].includes(access.name.text)) add(node,'process','output',node.arguments[0]?.getText().slice(0,160) ?? '',`console.${access.name.text}`);
        }
        if (ts.isReturnStatement(node) && node.expression) {
          const owner = this.owner(frame,node);
          if (entryHandlers.has(owner.id) && !owner.name.startsWith('http:')) add(node,'process','return',node.expression.getText().slice(0,160),'original return statement');
        }
        ts.forEachChild(node,visit);
      };
      visit(frame.source);
    }
  }
}
