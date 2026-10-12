import path from 'node:path';
import type { Analyzer, AnalysisContext, ScannedFile } from '../core/analyzer.js';
import { ANALYZER_VERSION, declarationHashes, evidence, type Entity, type Evidence } from '../core/graph.js';
import { hasFramework, repoPath } from '../core/config.js';
import { args, ast, classConstant, inertiaPageOf, literal, name, nodes, resolve, scopedChildren, text, walk, type Ast, type ParsedFile, type Scope } from './php-ast.js';
import { resolvePhpReferences, type PhpClass, type PhpMethod } from './php-references.js';
import { declareTables } from './laravel-schema.js';
import { declareConsole, type ConsoleRegistration } from './laravel-console.js';
import { declareFortify } from './laravel-fortify.js';
import { fileKey, pathSetKey } from '../pipeline/cache.js';
import { SiteCollector } from './references.js';
import { PhpSources } from '../analysis/php/sources.js';
import {LaravelFiles,laravelClassHeader} from '../analysis/php/laravel-files.js';
import { PHP_PARSER_VERSION, PHP_SOURCE_PROFILE, PHP_SOURCE_PROVIDER_VERSION, PHP_STRUCTURE_VERSION } from '../analysis/php/version.js';

export const LARAVEL_VERSION = `${ANALYZER_VERSION}:laravel-indexed-php:2`;

interface ChainItem { name: string; args: Ast[]; ast: Ast }
interface RouteContext { prefix: string; namePrefix: string; controller?: string; middleware: string[]; constraints: boolean; facts: Evidence[]; registration: 'static' | 'convention'; api: boolean }
function fingerprint(node: Ast, parsed: ParsedFile): ReturnType<typeof declarationHashes> | Record<string, never> {
  if (!node.loc) return {};
  const nameLoc = ast(node.name)?.loc;
  return declarationHashes(text(node, parsed), nameLoc ? nameLoc.end.offset - node.loc.start.offset : 0);
}
function chain(node: Ast, scope: Scope): ChainItem[] | undefined {
  if (node.kind !== 'call') return undefined;
  const what = ast(node.what);
  if (!what) return undefined;
  if (what.kind === 'staticlookup' && resolve(what.what, scope) === 'Illuminate\\Support\\Facades\\Route') {
    const method = name(what.offset);
    return method ? [{ name: method.toLowerCase(), args: args(node), ast: node }] : undefined;
  }
  if (what.kind === 'propertylookup') {
    const receiver = ast(what.what);
    const previous = receiver ? chain(receiver, scope) : undefined;
    const method = name(what.offset);
    if (previous && method) return [...previous, { name: method.toLowerCase(), args: args(node), ast: node }];
  }
  return undefined;
}
function routePath(prefix: string, uri: string): string { return `/${[prefix, uri].map(part => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`; }
function fileLiteral(node: Ast | undefined, parsed: ParsedFile): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'string') return literal(node);
  if (node.kind === 'magic' && String(node.value).toUpperCase() === '__DIR__') return path.dirname(parsed.file.absolutePath);
  if (node.kind === 'bin' && node.type === '.') {
    const left = fileLiteral(ast(node.left), parsed), right = fileLiteral(ast(node.right), parsed);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
function configuredLaravelBuilder(node: Ast | undefined, scope: Scope): boolean {
  if (!node || node.kind !== 'call') return false;
  const what = ast(node.what);
  if (what?.kind === 'staticlookup') return resolve(what.what, scope) === 'Illuminate\\Foundation\\Application' && name(what.offset) === 'configure';
  return what?.kind === 'propertylookup' && configuredLaravelBuilder(ast(what.what), scope);
}
export const laravelAnalyzer: Analyzer = {
  name: 'php-laravel', version: LARAVEL_VERSION,
  async analyze(context): Promise<void> {
    // Route registration, call resolution and tables are application-wide facts: the PHP of every Laravel application is one cache unit.
    const files = [...context.files.values()].filter(file => file.language === 'php' && hasFramework(file.application, 'laravel'));
    if (!files.length) return;
    const sources = context.phpSources ??= new PhpSources(context);
    try {
      // Validate and qualify every input before an application cache can replay
      // its strong framework facts. A source race or bounded tree failure must
      // invalidate the old application result even when its scanned hash matches.
      const availability: { file:string; available:boolean; reason?:string }[] = [];
      for (const file of files) {
        if (!file.analyzable) { availability.push({file:file.path,available:false}); continue; }
        try {
          const source = await sources.read(file);
          context.graph.entities.get(file.id)!.metadata.phpSourceProvider = { version:PHP_SOURCE_PROVIDER_VERSION, profile:PHP_SOURCE_PROFILE, available:!!source.ast, nativeBytes:source.astBytes, ...source.astGap ? {reason:source.astGap} : {} };
          availability.push({file:file.path,available:!!source.ast,...source.ast ? {} : {reason:source.astGap}});
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          context.graph.entities.get(file.id)!.metadata.phpSourceProvider = { version:PHP_SOURCE_PROVIDER_VERSION, profile:PHP_SOURCE_PROFILE, available:false, reason };
          availability.push({file:file.path,available:false,reason});
        }
      }
      const inputs = { version:LARAVEL_VERSION, files:files.map(file=>fileKey(context,file.path)), availability, paths:pathSetKey(context), config:context.config, applications:[...context.applicationIds], parser:{name:'php-parser',version:PHP_PARSER_VERSION}, profile:PHP_SOURCE_PROFILE, provider:PHP_SOURCE_PROVIDER_VERSION, structure:PHP_STRUCTURE_VERSION };
      if (context.cache) await context.cache.unit(context, 'php-laravel', 'laravel', inputs, () => analyzeLaravel(context), {shouldStore:()=>files.every(file=>!file.analyzable||!sources.failures.has(file.path))});
      else await analyzeLaravel(context);
    } finally { sources.closeParser(); }
  },
};
async function analyzeLaravel(context: AnalysisContext): Promise<void> {
  const parsedFiles = new LaravelFiles(context);
  const classes = new Map<string, Entity>();
  const methods = new Map<string, Entity>();
  const inheritance: { from: string; target: string; facts: Evidence[]; app: string }[] = [];
  const phpClasses = new Map<string, PhpClass>();
  const phpMethods: PhpMethod[] = [];
  const { graph } = context;
  const diagnostic = (parsed: ParsedFile, node: Ast | undefined, code: string, reason: string, severity: 'warning' | 'error' = 'warning') => graph.diagnose({ analyzer: 'php-laravel', severity, code, reason, file: parsed.file.path, line: node?.loc?.start.line, entityId: parsed.file.id });
  const facts = (parsed: ParsedFile, node: Ast, explanation: string, framework = false): Evidence[] => [{ ...evidence(framework ? 'framework' : 'php', 'php-laravel', parsed.file.path, node.loc?.start.line, explanation), endLine: node.loc?.end.line }];
  for (const file of context.files.values()) {
    if (file.language !== 'php' || !file.analyzable || !hasFramework(file.application, 'laravel')) continue;
    let source;
    try {source=await context.phpSources!.read(file);}
    catch{/* The indexed provider retains the source failure reason below. */}
    if (!source?.ast) {
      graph.diagnose({ analyzer: 'php-laravel', severity: 'error', code: 'php-parse-error', file: file.path, entityId: file.id, reason: context.phpSources!.failures.get(file.path) ?? source?.astGap ?? 'Bounded indexed original PHP source is unavailable' });
      continue;
    }
    const { content, ast:root } = source;
    const parsed = { file, ast: root, content };
    parsedFiles.register(file,{mentionsFortify:/\bFortify\b/.test(content)});
    scopedChildren(root, { namespace: '', imports: new Map() }, (children, scope) => {
      for (const child of children) walk(child, node => {
        if (node.kind !== 'class' || node.isAnonymous || !name(node.name)) return;
        const fqn = [scope.namespace, name(node.name)].filter(Boolean).join('\\');
        const classId = graph.id('symbol', 'php', file.application!.name, fqn);
        if (graph.entities.has(classId)) { diagnostic(parsed, node, 'duplicate-php-class', `Duplicate class ${fqn}`, 'error'); return; }
        const controller = /(?:^|\/)app\/Http\/Controllers\//.test(file.path);
        const entity = graph.contain({ id: classId, type: controller ? 'controller' : 'class', name: name(node.name)!, path: file.path, language: 'php', parentId: file.id, sourceRange: node.loc ? { startLine: node.loc.start.line, endLine: node.loc.end.line, startColumn: node.loc.start.column + 1, endColumn: node.loc.end.column + 1 } : undefined, metadata: { qualifiedName: fqn, extends: resolve(node.extends, scope), ...fingerprint(node, parsed) }, evidence: facts(parsed, node, 'PHP class declaration') });
        classes.set(`${file.application!.name}:${fqn.toLowerCase()}`, entity);
        const base = resolve(node.extends, scope);
        const phpClass: PhpClass = { entity, fqn, app: file.application!.name, scope, file, node:laravelClassHeader(node), ...(base ? { extends: base } : {}) };
        phpClasses.set(`${file.application!.name}:${fqn.toLowerCase()}`, phpClass);
        if (base) inheritance.push({ from: entity.id, target: base, facts: facts(parsed, node, 'PHP extends declaration'), app: file.application!.name });
        const methodHeaders=nodes(phpClass.node.body).filter(item=>item.kind==='method');
        for (const [methodIndex,method] of nodes(node.body).filter(item => item.kind === 'method').entries()) {
          const methodName = name(method.name)!;
          const signature = `(${args(method).map(param => `${param.variadic ? '...' : ''}${param.nullable ? '?' : ''}${text(ast(param.type), parsed).replace(/\s+/g, '') || 'unknown'}${param.value ? '?' : ''}`).join(',')})`;
          const id = graph.id('symbol', 'php', file.application!.name, `${fqn}::${methodName}`, signature);
          if (graph.entities.has(id)) { diagnostic(parsed, method, 'duplicate-php-method', `Duplicate method ${fqn}::${methodName}`, 'error'); continue; }
          const methodEntity = graph.contain({ id, type: 'method', name: methodName, path: file.path, language: 'php', parentId: classId, sourceRange: method.loc ? { startLine: method.loc.start.line, endLine: method.loc.end.line, startColumn: method.loc.start.column + 1, endColumn: method.loc.end.column + 1 } : undefined, metrics: method.loc ? { loc: method.loc.end.line - method.loc.start.line + 1 } : undefined, metadata: { qualifiedName: `${fqn}::${methodName}`, signature, visibility: method.visibility, static: !!method.isStatic, ...fingerprint(method, parsed) }, evidence: facts(parsed, method, 'PHP method declaration') });
          methods.set(`${file.application!.name}:${fqn.toLowerCase()}::${methodName.toLowerCase()}`, methodEntity);
          phpMethods.push({ entity: methodEntity, node: methodHeaders[methodIndex]!, owner: phpClass });
        }
      });
    });
  }
  for (const base of inheritance) { const target = classes.get(`${base.app}:${base.target.toLowerCase()}`); if (target) graph.relate(base.from, target.id, 'extends', base.facts); }
  const consoleRegistrations: ConsoleRegistration[] = [];

  for (const app of context.config.applications.filter(app => hasFramework(app, 'laravel'))) {
    const appId = context.applicationIds.get(app.name);
    if (!appId) continue;
    const bootstrapPath = path.posix.join(app.path === '.' ? '' : app.path, 'bootstrap/app.php');
    const registrations: { file: string; prefix: string; api: boolean; facts: Evidence[]; registration: 'static' | 'convention' }[] = [];
    {const bootstrap = await parsedFiles.get(bootstrapPath);
    if (bootstrap) {
      let routingFound = false;
      scopedChildren(bootstrap.ast, { namespace: '', imports: new Map() }, (children, scope) => {
        for (const statement of children) {
        // Only unconditional top-level builder expressions are trusted.
        if (!['return', 'expressionstatement'].includes(statement.kind)) continue;
        walk(statement, node => {
        const what = ast(node.what);
        if (node.kind !== 'call' || what?.kind !== 'propertylookup' || name(what.offset) !== 'withRouting') return;
        if (!configuredLaravelBuilder(ast(what.what), scope)) { diagnostic(bootstrap, node, 'unverified-routing-builder', 'withRouting receiver is not a statically verified Laravel Application::configure builder'); return; }
        routingFound = true;
        const named = new Map(args(node).filter(item => item.kind === 'namedargument').map(item => [name(item.name), ast(item.value)]));
        const apiPrefix = named.has('apiPrefix') ? literal(named.get('apiPrefix')) : 'api';
        if (named.has('using')) diagnostic(bootstrap, node, 'custom-route-registration', 'withRouting(using:) replaces normal route registration; it is not statically resolved');
        if (named.has('using')) return;
        for (const routeType of ['web', 'api']) {
          const argument = named.get(routeType);
          if (!argument) continue;
          const registered = fileLiteral(argument, bootstrap);
          if (!registered || (routeType === 'api' && apiPrefix === undefined)) { diagnostic(bootstrap, node, 'dynamic-route-registration', `Cannot resolve ${routeType} route file or apiPrefix`); continue; }
          const relative = path.relative(context.root, registered).split(path.sep).join('/');
          registrations.push({ file: relative, prefix: routeType === 'api' ? apiPrefix! : '', api: routeType === 'api', facts: facts(bootstrap, node, 'Laravel withRouting registration and API prefix', true), registration: 'static' });
        }
        const commands = named.get('commands');
        if (commands) {
          const registered = fileLiteral(commands, bootstrap);
          if (registered) consoleRegistrations.push({ app: app.name, file: path.relative(context.root, registered).split(path.sep).join('/'), registration: 'static', facts: facts(bootstrap, node, 'Laravel withRouting(commands:) registers console routes', true) });
          else diagnostic(bootstrap, node, 'dynamic-route-registration', 'Cannot resolve the console route file of withRouting(commands:)');
        }
        if (named.has('then')) diagnostic(bootstrap, node, 'additional-route-registration', 'withRouting(then:) may register additional routes; not resolved');
        });
        }
      });
      if (!routingFound) diagnostic(bootstrap, undefined, 'routing-bootstrap-unresolved', 'No unconditional Laravel Application::configure()->withRouting() registration could be resolved');
    } else if (!context.files.has(bootstrapPath)) {
      for (const routeType of ['web', 'api']) {
        const relative = path.posix.join(app.path === '.' ? '' : app.path, `routes/${routeType}.php`);
        if (parsedFiles.has(relative)) registrations.push({ file: relative, prefix: routeType === 'api' ? 'api' : '', api: routeType === 'api', registration: 'convention', facts: [evidence('framework', 'php-laravel', relative, 1, 'Conventional route candidate; bootstrap registration unavailable')] });
      }
      graph.diagnose({ analyzer: 'php-laravel', severity: 'warning', code: 'route-registration-unverified', reason: `No bootstrap/app.php in ${app.name}; conventional route candidates are not eligible for exact HTTP linking` });
    }
    }
    // Laravel ≤ 10 loads routes/console.php from the console Kernel: a conventional console route file.
    const consolePath = path.posix.join(app.path === '.' ? '' : app.path, 'routes/console.php');
    if (!consoleRegistrations.some(item => item.app === app.name) && parsedFiles.has(consolePath)) consoleRegistrations.push({ app: app.name, file: consolePath, registration: 'convention', facts: [evidence('framework', 'php-laravel', consolePath, 1, 'Conventional console route file (routes/console.php)')] });
    const seen = new Set<string>();
    type RouteDiagnostic=Parameters<typeof graph.diagnose>[0];
    type RouteEvent={kind:'diagnostic';value:RouteDiagnostic}|{kind:'include';file:string;context:RouteContext}|{kind:'endpoint';value:Parameters<typeof graph.contain>[0];handler?:Entity;facts:Evidence[];duplicate:RouteDiagnostic};
    async function processFile(relative: string, routeContext: RouteContext, ancestry: Set<string>): Promise<void> {
      try { repoPath(context.root, relative); } catch { graph.diagnose({ analyzer: 'php-laravel', severity: 'warning', code: 'route-include-outside-repository', file: relative, reason: 'Route include escapes repository' }); return; }
      if (ancestry.has(relative)) { graph.diagnose({analyzer:'php-laravel',severity:'warning',code:'cyclic-route-include',reason:'Cyclic route include',file:relative,entityId:context.files.get(relative)?.id}); return; }
      const key = JSON.stringify([relative, routeContext]);
      if (seen.has(key)) return;
      seen.add(key);
      // Compile source into detached operations before following an include.
      // A deep include chain retains only metadata, never its parents' trees.
      const events=await compileFile(relative,routeContext);if(!events)return;
      const nextAncestry = new Set([...ancestry, relative]);
      for(const event of events){
        if(event.kind==='include')await processFile(event.file,event.context,nextAncestry);
        else if(event.kind==='diagnostic')graph.diagnose(event.value);
        else if(graph.entities.has(event.value.id!))graph.diagnose(event.duplicate);
        else {const endpoint=graph.contain(event.value);if(event.handler)graph.relate(endpoint.id,event.handler.id,'handles',[...event.facts,...event.handler.evidence]);}
      }
    }
    async function compileFile(relative:string,routeContext:RouteContext):Promise<RouteEvent[]|undefined>{
      const parsed=await parsedFiles.get(relative);
      if(!parsed){graph.diagnose({analyzer:'php-laravel',severity:'warning',code:'route-file-unavailable',file:relative,reason:'Registered route file is missing, ignored or unparseable'});return;}
      const events:RouteEvent[]=[];
      scopedChildren(parsed.ast,{namespace:'',imports:new Map()},(children,scope)=>processStatements(children,scope,parsed,routeContext,events));
      return events;
    }
    function processStatements(children: Ast[], scope: Scope, parsed: ParsedFile, parent: RouteContext, events:RouteEvent[]): void {
      const diagnostic=(parsed:ParsedFile,node:Ast|undefined,code:string,reason:string)=>events.push({kind:'diagnostic',value:{analyzer:'php-laravel',severity:'warning',code,reason,file:parsed.file.path,line:node?.loc?.start.line,entityId:parsed.file.id}});
      const routeText=(node:Ast|undefined,parsed:ParsedFile)=>Buffer.from(text(node,parsed),'utf16le').toString('utf16le');
      for (const statement of children) {
        const expression = statement.kind === 'expressionstatement' ? ast(statement.expression) : statement;
        if (!expression) continue;
        if (expression.kind === 'include') {
          const include = fileLiteral(ast(expression.target), parsed);
          if (!include) diagnostic(parsed, expression, 'dynamic-route-include', 'Cannot resolve route include');
          else events.push({kind:'include',file:path.relative(context.root,path.resolve(path.dirname(parsed.file.absolutePath),include)).split(path.sep).join('/'),context:{...parent,facts:[...parent.facts,...facts(parsed,expression,'Route file include',true)]}});
          continue;
        }
        const calls = chain(expression, scope);
        if (!calls) {
          let hasRoute = false;
          walk(expression, child => { if (chain(child, scope)) hasRoute = true; });
          if (hasRoute) diagnostic(parsed, expression, 'conditional-route-registration', 'Route declaration nested in unsupported conditional/function registration');
          continue;
        }
        let current: RouteContext = { ...parent, middleware: [...parent.middleware], facts: [...parent.facts, ...facts(parsed, expression, 'Laravel Route facade declaration', true)] };
        let http: ChainItem | undefined;
        let routeName: string | undefined;
        let unsupported = false;
        for (const call of calls) {
          if (call.name === 'prefix') {
            const prefix = literal(call.args[0]);
            if (prefix === undefined) { diagnostic(parsed, call.ast, 'dynamic-route-prefix', 'Route prefix is not a literal'); unsupported = true; break; }
            current.prefix = routePath(current.prefix, prefix);
          } else if (call.name === 'middleware' || call.name === 'withoutmiddleware') {
            current.middleware.push(...(call.args[0]?.kind === 'array' ? nodes(call.args[0].items).map(item => literal(item.value) ?? routeText(ast(item.value), parsed)) : [literal(call.args[0]) ?? routeText(call.args[0], parsed)]));
          } else if (call.name === 'controller') {
            current.controller = classConstant(call.args[0], scope);
            if (!current.controller) { diagnostic(parsed, call.ast, 'dynamic-route-controller', 'Cannot resolve controller group'); unsupported = true; break; }
          } else if (call.name === 'name') {
            const declaredName = literal(call.args[0]);
            if (declaredName !== undefined) { if (calls.some(item => item.name === 'group')) current.namePrefix += declaredName; else routeName = current.namePrefix + declaredName; }
          } else if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'any', 'match'].includes(call.name)) http = call;
          else if (call.name.startsWith('where')) { current.constraints = true; diagnostic(parsed, call.ast, 'route-constraints-not-evaluated', 'Route constraints are retained as unresolved; endpoint excluded from exact HTTP matching'); }
          else if (call.name === 'domain' || call.name === 'namespace' || ['resource', 'apiresource', 'resources', 'apiresources', 'redirect', 'permanentredirect', 'view', 'fallback'].includes(call.name)) { diagnostic(parsed, call.ast, 'unsupported-route-registration', `Route::${call.name} requires further deterministic extraction`); unsupported = true; break; }
          else if (call.name !== 'group') { diagnostic(parsed, call.ast, 'unsupported-route-modifier', `Unresolved Route modifier/macro ${call.name}`); unsupported = true; break; }
        }
        if (unsupported) continue;
        const group = calls.find(item => item.name === 'group');
        if (group) {
          const closure = group.args[0];
          if (closure?.kind === 'closure') processStatements(nodes(ast(closure.body)?.children), scope, parsed, current, events);
          else diagnostic(parsed, group.ast, 'unsupported-route-group', 'Only closure route groups are resolved in Phase 1');
          continue;
        }
        if (!http) continue;
        const offset = http.name === 'match' ? 1 : 0;
        const uri = literal(http.args[offset]);
        if (uri === undefined) { diagnostic(parsed, http.ast, 'dynamic-route-uri', 'Route URI is not a literal'); continue; }
        const methodsList = http.name === 'any' ? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] : http.name === 'match' ? nodes(http.args[0]?.items).map(item => literal(item.value)?.toUpperCase()) : [http.name.toUpperCase(), ...(http.name === 'get' ? ['HEAD'] : [])];
        if (!methodsList.length || methodsList.some(method => !method || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method))) { diagnostic(parsed, http.ast, 'dynamic-route-methods', 'Cannot resolve Route::match HTTP methods'); continue; }
        const action = http.args[offset + 1];
        let handlerClass: string | undefined;
        let handlerMethod: string | undefined;
        let handlerKind = 'unresolved';
        if (action?.kind === 'array') { const items = nodes(action.items); handlerClass = classConstant(items[0]?.value, scope) ?? literal(items[0]?.value)?.replace(/^\\/, ''); handlerMethod = literal(items[1]?.value); }
        else if (classConstant(action, scope)) { handlerClass = classConstant(action, scope); handlerMethod = '__invoke'; }
        else if (action?.kind === 'string') {
          const value = literal(action)!;
          if (current.controller) { handlerClass = current.controller; handlerMethod = value; }
          else if (value.includes('@')) { [handlerClass, handlerMethod] = value.replace(/^\\/, '').split('@'); }
        } else if (action?.kind === 'closure' || action?.kind === 'arrowfunc') handlerKind = 'closure';
        const inertiaPage = handlerKind === 'closure' ? inertiaPageOf(action!, scope) : undefined;
        const handler = handlerClass && handlerMethod ? methods.get(`${app.name}:${handlerClass.toLowerCase()}::${handlerMethod.toLowerCase()}`) : undefined;
        if (handler) handlerKind = 'method';
        if (handlerKind === 'unresolved') diagnostic(parsed, http.ast, 'unresolved-route-handler', `Cannot resolve route handler ${handlerClass ?? routeText(action, parsed)}${handlerMethod ? `::${handlerMethod}` : ''}`);
        for (const method of methodsList as string[]) {
          const fullPath = routePath(current.prefix, uri);
          const id = graph.id('endpoint', app.name, method, fullPath, parsed.file.path, handlerClass ?? handlerKind, handlerMethod ?? '');
          const value:Parameters<typeof graph.contain>[0] = { id, type: 'api_endpoint', name: `${method} ${fullPath}`, path: parsed.file.path, parentId: appId, sourceRange: http.ast.loc ? { startLine: http.ast.loc.start.line, endLine: http.ast.loc.end.line } : undefined, metadata: { method, routePath: fullPath, framework: 'laravel', routeFile: parsed.file.path, api: current.api, registration: current.registration, middleware: current.middleware, constraintsUnresolved: current.constraints, handlerKind, ...(routeName ? { routeName } : {}), ...(inertiaPage ? { inertiaPage } : {}), ...(handlerClass ? { controller: handlerClass, controllerMethod: handlerMethod } : {}) }, evidence: current.facts };
          events.push({kind:'endpoint',value,handler,facts:current.facts,duplicate:{analyzer:'php-laravel',severity:'warning',code:'duplicate-route-declaration',reason:`Repeated ${method} ${fullPath} registration`,file:parsed.file.path,line:http.ast.loc?.start.line,entityId:parsed.file.id}});
        }
      }
    }
    for (const registration of registrations) await processFile(registration.file, { ...registration, namePrefix: '', middleware: [], constraints: false }, new Set());
    // Packages that register routes from their own route files: Fortify's are declared from the application's configuration.
    const fortify = await declareFortify(context, app, appId, parsedFiles, methods);
    graph.diagnose({ analyzer: 'php-laravel', severity: 'info', code: 'framework-route-coverage', reason: `${app.name}: package/provider routes${fortify ? ' other than laravel/fortify\'s' : ''} and implicit framework health endpoints are outside the static route-file inventory` });
  }
  // Tables declared by migrations, and the Eloquent models that map to them.
  const tables = await declareTables(context, parsedFiles, phpClasses);
  // Artisan commands and scheduled tasks: entry points without an HTTP request.
  const commands = await declareConsole(context, phpClasses, methods, parsedFiles, consoleRegistrations);
  // Calls between methods, constructions, effects and table access, once every class, table and command is known.
  const sites = new SiteCollector();
  await resolvePhpReferences(context, phpClasses, phpMethods, sites, parsedFiles, tables, commands);
  sites.flush(graph);
}
