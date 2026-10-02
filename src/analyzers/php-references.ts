// Call resolution and effects for PHP methods of Laravel applications.
//
// Receivers are typed only from what the code declares: `$this`, `self`,
// `static`, `parent`, `new X`, typed parameters, typed and constructor-promoted
// properties, single-class local assignments, `app(X::class)` /
// `resolve(X::class)` and declared return types. A call becomes a `calls`
// relation when that type is an indexed class declaring (or inheriting) the
// method. Effects are matched on resolved names: facades by their imported
// class (`Illuminate\Support\Facades\DB`, or the global alias), Eloquent
// queries on classes whose `extends` chain reaches an Eloquent base,
// framework helpers (`abort`, `response`, `redirect`, `dispatch`…) and
// framework exceptions with a known HTTP status.
import type { AnalysisContext } from '../core/analyzer.js';
import { evidence, type EffectCategory, type Entity } from '../core/graph.js';
import { args, ast, classConstant, literal, name, nodes, resolve, text, walk, type Ast, type ParsedFile, type Scope } from './php-ast.js';
import type { SiteCollector } from './references.js';

export interface PhpClass { entity: Entity; fqn: string; app: string; scope: Scope; parsed: ParsedFile; node: Ast; extends?: string }
export interface PhpMethod { entity: Entity; node: Ast; owner: PhpClass }
type Type = { kind: 'class'; fqn: string } | { kind: 'query'; model: string } | { kind: 'external'; via: string } | undefined;

const ELOQUENT_BASES = new Set(['illuminate\\database\\eloquent\\model', 'illuminate\\foundation\\auth\\user', 'illuminate\\database\\eloquent\\relations\\pivot', 'illuminate\\database\\eloquent\\relations\\morphpivot', 'illuminate\\notifications\\databasenotification']);
const FORM_REQUEST = 'illuminate\\foundation\\http\\formrequest';
const FACADES: Record<string, EffectCategory> = { db: 'database', cache: 'cache', redis: 'cache', mail: 'mail', notification: 'mail', storage: 'file', file: 'file', http: 'network', queue: 'queue', bus: 'queue', event: 'event', broadcast: 'event', auth: 'auth', hash: 'auth', gate: 'auth', password: 'auth', session: 'storage', cookie: 'storage', artisan: 'process', process: 'process' };
const WRITES = new Set(['create', 'insert', 'insertgetid', 'insertorignore', 'update', 'updateorcreate', 'updateorinsert', 'firstorcreate', 'upsert', 'destroy', 'delete', 'forcedelete', 'truncate', 'forcecreate', 'increment', 'decrement', 'save', 'saveor', 'push', 'restore', 'touch', 'sync', 'attach', 'detach', 'toggle', 'statement', 'unprepared', 'put', 'forget', 'flush', 'forever', 'pull', 'add', 'set', 'del']);
const EXCEPTION_STATUS: Record<string, number> = {
  'symfony\\component\\httpkernel\\exception\\notfoundhttpexception': 404, 'illuminate\\database\\eloquent\\modelnotfoundexception': 404,
  'illuminate\\auth\\authenticationexception': 401, 'symfony\\component\\httpkernel\\exception\\unauthorizedhttpexception': 401,
  'illuminate\\auth\\access\\authorizationexception': 403, 'symfony\\component\\httpkernel\\exception\\accessdeniedhttpexception': 403,
  'illuminate\\validation\\validationexception': 422, 'symfony\\component\\httpkernel\\exception\\badrequesthttpexception': 400,
  'symfony\\component\\httpkernel\\exception\\conflicthttpexception': 409, 'symfony\\component\\httpkernel\\exception\\toomanyrequestshttpexception': 429,
  'symfony\\component\\httpkernel\\exception\\unprocessableentityhttpexception': 422,
};
const RESPONSE_HELPERS = new Set(['response', 'redirect', 'back', 'to_route', 'view', 'abort', 'abort_if', 'abort_unless']);
function short(value: string, max = 70): string { const text = value.replace(/\s+/g, ' '); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

export function resolvePhpReferences(context: AnalysisContext, classes: Map<string, PhpClass>, methods: PhpMethod[], sites: SiteCollector): void {
  const key = (app: string, fqn: string) => `${app}:${fqn.toLowerCase()}`;
  const classOf = (app: string, fqn: string | undefined) => fqn ? classes.get(key(app, fqn)) : undefined;
  const chain = (app: string, fqn: string): string[] => {
    const result: string[] = [];
    for (let current: string | undefined = fqn; current && result.length < 20 && !result.includes(current.toLowerCase()); current = classOf(app, current)?.extends) result.push(current.toLowerCase());
    return result;
  };
  const isModel = (app: string, fqn: string) => chain(app, fqn).some(item => ELOQUENT_BASES.has(item));
  /** The class inherits from code outside the index (a framework or vendor class). */
  const inheritsExternal = (app: string, fqn: string) => chain(app, fqn).some(item => !classes.has(`${app}:${item}`));
  const isFormRequest = (app: string, fqn: string) => chain(app, fqn).includes(FORM_REQUEST);
  const methodIndex = new Map<string, Entity>();
  for (const method of methods) methodIndex.set(`${key(method.owner.app, method.owner.fqn)}::${method.entity.name.toLowerCase()}`, method.entity);
  const methodNodes = new Map(methods.map(method => [method.entity.id, method]));
  const lookup = (app: string, fqn: string, method: string): Entity | undefined => {
    for (const ancestor of chain(app, fqn)) { const found = methodIndex.get(`${app}:${ancestor}::${method.toLowerCase()}`); if (found) return found; }
    return undefined;
  };
  const facadeOf = (fqn: string | undefined): string | undefined => {
    if (!fqn) return undefined;
    const lower = fqn.toLowerCase();
    const short = lower.startsWith('illuminate\\support\\facades\\') ? lower.slice('illuminate\\support\\facades\\'.length) : lower.includes('\\') ? undefined : lower;
    return short && FACADES[short] ? short : undefined;
  };

  for (const method of methods) {
    const { owner } = method;
    const { parsed, scope, app } = { parsed: owner.parsed, scope: owner.scope, app: owner.app };
    const from = method.entity;
    const lineOf = (node: Ast) => node.loc?.start.line ?? method.node.loc?.start.line ?? 1;
    const fact = (node: Ast, explanation: string) => ({ ...evidence('php', 'php-laravel', parsed.file.path, lineOf(node), explanation), endLine: node.loc?.end.line });
    const typeName = (node: unknown, where: PhpClass = owner): string | undefined => {
      const type = ast(node);
      if (!type) return undefined;
      if (type.kind === 'typereference' || type.kind === 'selfreference' || type.kind === 'staticreference') return ['self', 'static'].includes(String(type.name ?? type.raw).toLowerCase()) ? where.fqn : undefined;
      if (type.kind === 'name') { const raw = name(type)!.toLowerCase(); return raw === 'self' || raw === 'static' ? where.fqn : raw === 'parent' ? where.extends : resolve(type, where.scope); }
      return undefined;
    };
    // Declared property types of the class chain: typed properties and promoted constructor parameters.
    const propertyType = (fqn: string, property: string): string | undefined => {
      for (const ancestor of chain(app, fqn)) {
        const info = classes.get(`${app}:${ancestor}`);
        if (!info) continue;
        for (const item of nodes(info.node.body)) {
          if (item.kind === 'propertystatement') for (const declared of nodes(item.properties)) if (name(declared.name) === property) { const type = typeName(declared.type ?? item.type, info); if (type) return type; }
          if (item.kind === 'method' && name(item.name)?.toLowerCase() === '__construct') for (const parameter of args(item)) if (parameter.flags && name(parameter.name) === property) { const type = typeName(parameter.type, info); if (type) return type; }
        }
      }
      return undefined;
    };
    // Locals: typed parameters, then variables whose every assignment has one known class type.
    const locals = new Map<string, Type>();
    for (const parameter of args(method.node)) { const fqn = typeName(parameter.type); if (fqn && name(parameter.name)) locals.set(name(parameter.name)!, { kind: 'class', fqn }); }
    walk(method.node, node => {
      // Typed closure parameters and caught exceptions are declared types too.
      if ((node.kind === 'closure' || node.kind === 'arrowfunc') && node !== method.node) for (const parameter of args(node)) { const fqn = typeName(parameter.type); const variable = name(parameter.name); if (fqn && variable && !locals.has(variable)) locals.set(variable, { kind: 'class', fqn }); }
      if (node.kind === 'catch') { const variable = ast(node.variable)?.name; const types = nodes(node.what).map(item => resolve(item, scope)).filter((item): item is string => !!item); if (typeof variable === 'string' && types.length && !locals.has(variable)) locals.set(variable, types.length === 1 ? { kind: 'class', fqn: types[0]! } : { kind: 'external', via: 'caught exception' }); }
    });
    const assigned = new Map<string, Ast[]>();
    walk(method.node, node => { if (node.kind === 'assign' && ast(node.left)?.kind === 'variable' && typeof ast(node.left)!.name === 'string' && node.operator === '=') assigned.set(ast(node.left)!.name as string, [...assigned.get(ast(node.left)!.name as string) ?? [], ast(node.right)!]); });
    const typeOf = (node: Ast | undefined, depth = 0): Type => {
      if (!node || depth > 6) return undefined;
      if (node.kind === 'variable') {
        const variable = node.name as string;
        if (variable === 'this') return { kind: 'class', fqn: owner.fqn };
        if (locals.has(variable)) return locals.get(variable);
        const values = assigned.get(variable);
        if (values?.length) {
          locals.set(variable, undefined); // recursion guard
          const types = values.map(value => typeOf(value, depth + 1));
          const first = types[0];
          const same = first && types.every(type => JSON.stringify(type) === JSON.stringify(first)) ? first : undefined;
          locals.set(variable, same);
          return same;
        }
        return undefined;
      }
      if (node.kind === 'new') { const fqn = classTarget(node.what); return fqn ? { kind: 'class', fqn } : undefined; }
      if (node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup') {
        const receiver = typeOf(ast(node.what), depth + 1);
        if (receiver?.kind === 'class') { const fqn = propertyType(receiver.fqn, name(node.offset) ?? ''); return fqn ? { kind: 'class', fqn } : !classes.has(key(app, receiver.fqn)) || inheritsExternal(app, receiver.fqn) ? { kind: 'external', via: `${receiver.fqn} property` } : undefined; }
        return receiver?.kind === 'external' ? receiver : undefined;
      }
      if (node.kind === 'call') return callType(node, depth);
      return undefined;
    };
    const classTarget = (what: unknown): string | undefined => {
      const node = ast(what);
      if (!node) return undefined;
      if (node.kind === 'selfreference' || node.kind === 'staticreference') return owner.fqn;
      if (node.kind === 'parentreference') return owner.extends;
      if (node.kind === 'name') { const raw = name(node)!.toLowerCase(); return raw === 'self' || raw === 'static' ? owner.fqn : raw === 'parent' ? owner.extends : resolve(node, scope); }
      return undefined;
    };
    const returnType = (target: Entity): Type => {
      const declared = methodNodes.get(target.id);
      const fqn = declared ? typeName(declared.node.type, declared.owner) : undefined;
      return fqn ? { kind: 'class', fqn } : undefined;
    };
    const callType = (node: Ast, depth: number): Type => {
      const what = ast(node.what);
      if (!what) return undefined;
      if (what.kind === 'name') {
        const fn = name(what)!.toLowerCase();
        if ((fn === 'app' || fn === 'resolve') && args(node).length === 1) { const fqn = classConstant(args(node)[0], scope); return fqn ? { kind: 'class', fqn } : { kind: 'external', via: fn }; }
        return { kind: 'external', via: `${fn}()` };
      }
      if (what.kind === 'staticlookup') {
        const fqn = classTarget(what.what), methodName = name(what.offset) ?? '';
        if (!fqn) return undefined;
        if (facadeOf(fqn)) return { kind: 'external', via: fqn };
        const target = lookup(app, fqn, methodName);
        if (target) return returnType(target);
        if (isModel(app, fqn)) return afterQuery(methodName.toLowerCase(), { kind: 'query', model: fqn });
        return classes.has(key(app, fqn)) ? undefined : { kind: 'external', via: fqn };
      }
      if (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') {
        const receiver = typeOf(ast(what.what), depth + 1), methodName = (name(what.offset) ?? '').toLowerCase();
        if (receiver?.kind === 'class') { const target = lookup(app, receiver.fqn, methodName); return target ? returnType(target) : isModel(app, receiver.fqn) ? { kind: 'query', model: receiver.fqn } : !classes.has(key(app, receiver.fqn)) || inheritsExternal(app, receiver.fqn) ? { kind: 'external', via: receiver.fqn } : undefined; }
        if (receiver?.kind === 'query') return afterQuery(methodName, receiver);
        return receiver;
      }
      return undefined;
    };
    /** What an Eloquent builder call returns: a model instance, a result set, or still a query. */
    const afterQuery = (methodName: string, query: { kind: 'query'; model: string }): Type => ['first', 'firstorfail', 'find', 'findorfail', 'sole', 'firstornew', 'firstorcreate', 'create', 'updateorcreate', 'forcecreate', 'make'].includes(methodName) ? { kind: 'class', fqn: query.model } : ['get', 'all', 'paginate', 'pluck', 'count', 'exists', 'sum', 'value', 'max', 'min', 'avg'].includes(methodName) ? { kind: 'external', via: 'Eloquent result' } : query;
    /** Calls chained onto this one (`X::a()->b()->c()`), innermost first. */
    const chainOf = (node: Ast): { root: Ast; names: string[] } => {
      const names: string[] = [];
      let current: Ast = node;
      for (;;) {
        const what = ast(current.what);
        if (current.kind === 'call' && what && (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') && ast(what.what)?.kind === 'call') { names.unshift((name(what.offset) ?? '').toLowerCase()); current = ast(what.what)!; continue; }
        if (current.kind === 'call' && what && (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup' || what.kind === 'staticlookup')) names.unshift((name(what.offset) ?? '').toLowerCase());
        return { root: current, names };
      }
    };
    const effect = (node: Ast, category: EffectCategory, operation: string, via: string, extra: { status?: number; target?: Entity; detail?: string } = {}) => {
      sites.effect(from.id, { category, operation, detail: extra.detail ?? short(text(node, parsed)), line: lineOf(node), via, ...(extra.status !== undefined ? { status: extra.status } : {}), ...(extra.target ? { target: extra.target.id, targetName: extra.target.name } : {}) });
    };
    const statusArgument = (value: Ast | undefined, fallback: number) => value?.kind === 'number' && /^\d{3}$/.test(String(value.value)) ? Number(value.value) : fallback;
    const isChained = (node: Ast, parent: Ast | undefined) => !!parent && (parent.kind === 'propertylookup' || parent.kind === 'nullsafepropertylookup') && ast(parent.what) === node;
    const parents = new Map<Ast, Ast>();
    walk(method.node, node => { for (const value of Object.values(node)) { if (Array.isArray(value)) for (const child of nodes(value)) parents.set(child, node); else { const child = ast(value); if (child && child !== node) parents.set(child, node); } } });
    const insideClosure = (node: Ast) => { for (let current = parents.get(node); current && current !== method.node; current = parents.get(current)) if (current.kind === 'closure' || current.kind === 'arrowfunc') return true; return false; };
    const controllerMethod = owner.entity.type === 'controller' && method.node.visibility !== 'private' && method.node.visibility !== 'protected';

    // FormRequest parameters validate before the method body runs.
    for (const parameter of args(method.node)) {
      const fqn = typeName(parameter.type);
      if (fqn && isFormRequest(app, fqn)) effect(parameter, 'response', 'validation', fqn, { status: 422, detail: `${fqn.split('\\').at(-1)} validates the request before ${from.name} runs` });
    }
    walk(method.node, node => {
      const parent = parents.get(node);
      if (node.kind === 'new') {
        const fqn = classTarget(node.what);
        const target = fqn ? classOf(app, fqn) : undefined;
        if (target) { sites.add({ from: from.id, to: target.entity.id, type: 'calls', form: 'new', evidence: fact(node, `Constructs new ${fqn!.split('\\').at(-1)}(…)`) }); sites.count(from.id, 'resolved'); }
        else if (fqn) sites.count(from.id, 'external');
        if (parent?.kind === 'throw' && fqn) {
          const status = EXCEPTION_STATUS[fqn.toLowerCase()] ?? (fqn.toLowerCase() === 'symfony\\component\\httpkernel\\exception\\httpexception' ? statusArgument(args(node)[0], 500) : undefined);
          if (status) effect(parent, 'response', 'throw', fqn, { status });
        }
        return;
      }
      if (node.kind === 'return' && controllerMethod && node.expr && !insideClosure(node)) {
        const value = ast(node.expr)!;
        const root = value.kind === 'call' ? chainOf(value).root : value;
        const helper = root.kind === 'call' && ast(root.what)?.kind === 'name' ? name(ast(root.what))!.toLowerCase() : undefined;
        if (!helper || !RESPONSE_HELPERS.has(helper)) effect(node, 'response', 'return', 'controller return value', { status: 200 });
        return;
      }
      if (node.kind !== 'call') return;
      const what = ast(node.what);
      if (!what) return;
      const chained = isChained(node, parent);
      // Effects are recorded once per call chain, at its outermost call.
      if (!chained) {
        const { root, names } = chainOf(node);
        const rootWhat = ast(root.what);
        if (rootWhat?.kind === 'staticlookup') {
          const fqn = classTarget(rootWhat.what), facade = facadeOf(fqn);
          const write = names.some(item => WRITES.has(item));
          if (facade) effect(node, FACADES[facade]!, FACADES[facade] === 'database' ? (write ? 'write' : 'read') : names[0] ?? facade, fqn!);
          else if (fqn && isModel(app, fqn) && !lookup(app, fqn, names[0] ?? '')) {
            const model = classOf(app, fqn);
            effect(node, 'database', write ? 'write' : 'read', `Eloquent model ${fqn}`, model ? { target: model.entity } : {});
            if (names.some(item => item === 'findorfail' || item === 'firstorfail')) effect(node, 'response', 'not found', 'ModelNotFoundException', { status: 404, detail: `${fqn.split('\\').at(-1)}::…OrFail() → 404 when missing` });
          } else if (fqn && names[0] === 'dispatch' && classOf(app, fqn)) effect(node, 'queue', 'dispatch', fqn, { target: classOf(app, fqn)!.entity });
          else if (fqn && fqn.toLowerCase() === 'illuminate\\validation\\validationexception') effect(node, 'response', 'validation', fqn, { status: 422 });
        } else if (rootWhat?.kind === 'name') {
          const fn = name(rootWhat)!.toLowerCase(), first = args(root)[0];
          if (fn === 'abort') effect(node, 'response', 'abort', 'abort()', { status: statusArgument(first, 500) });
          else if (fn === 'abort_if' || fn === 'abort_unless') effect(node, 'response', fn, `${fn}()`, { status: statusArgument(args(root)[1], 500) });
          else if (fn === 'response') {
            const index = names.indexOf('json');
            const call = index >= 0 ? nthCall(node, names.length - index - 1) : undefined;
            const status = names.includes('nocontent') ? 204 : call ? statusArgument(args(call)[1], 200) : statusArgument(args(root)[1], 200);
            effect(node, 'response', names[0] ?? 'response', 'response()', { status });
          } else if (fn === 'redirect' || fn === 'back' || fn === 'to_route') effect(node, 'response', 'redirect', `${fn}()`, { status: 302 });
          else if (fn === 'view') effect(node, 'response', 'view', 'view()', { status: 200, ...(literal(first) ? { detail: `view('${literal(first)}')` } : {}) });
          else if (fn === 'dispatch' || fn === 'event' || fn === 'broadcast') {
            const created = ast(first)?.kind === 'new' ? classTarget(ast(first)!.what) : undefined;
            const target = created ? classOf(app, created) : undefined;
            effect(node, fn === 'dispatch' ? 'queue' : 'event', fn, `${fn}()`, target ? { target: target.entity } : {});
          } else if (fn === 'cache') effect(node, 'cache', names[0] ?? 'cache', 'cache()');
          else if (fn === 'session') effect(node, 'storage', names[0] ?? 'session', 'session()');
        } else if (rootWhat?.kind === 'propertylookup' || rootWhat?.kind === 'nullsafepropertylookup') {
          const receiver = typeOf(ast(rootWhat.what));
          if (names.at(-1) === 'validate' && receiver?.kind === 'class' && (receiver.fqn.toLowerCase() === 'illuminate\\http\\request' || isFormRequest(app, receiver.fqn))) effect(node, 'response', 'validation', receiver.fqn, { status: 422, detail: `${short(text(root, parsed), 50)} → 422 when invalid` });
          // Writes on a model instance ($user->update(…), $user->save()).
          const model = receiver?.kind === 'class' && isModel(app, receiver.fqn) ? receiver.fqn : receiver?.kind === 'query' ? receiver.model : undefined;
          if (model && !lookup(app, model, names[0] ?? '') && names.some(item => WRITES.has(item))) effect(node, 'database', 'write', `Eloquent model ${model}`, classOf(app, model) ? { target: classOf(app, model)!.entity } : {});
        }
      }
      // The call itself.
      if (what.kind === 'name') { sites.count(from.id, 'external'); return; }
      const methodName = name(what.offset);
      if (!methodName) { sites.count(from.id, 'unresolved'); return; }
      let receiverType: Type;
      if (what.kind === 'staticlookup') {
        const fqn = classTarget(what.what);
        receiverType = fqn ? (facadeOf(fqn) ? { kind: 'external', via: fqn } : classes.has(key(app, fqn)) ? { kind: 'class', fqn } : { kind: 'external', via: fqn }) : undefined;
      } else if (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') receiverType = typeOf(ast(what.what));
      else { sites.count(from.id, 'unresolved'); return; }
      const call = short(text(node, parsed).split('(')[0] ?? methodName, 60);
      if (receiverType?.kind === 'class') {
        const target = lookup(app, receiverType.fqn, methodName);
        if (target) { sites.add({ from: from.id, to: target.id, type: 'calls', form: 'call', evidence: fact(node, `Calls ${call}(…)`) }); sites.count(from.id, 'resolved'); return; }
        if (isModel(app, receiverType.fqn) || !classes.has(key(app, receiverType.fqn)) || inheritsExternal(app, receiverType.fqn)) { sites.count(from.id, 'external'); return; }
        if (what.kind === 'staticlookup' && methodName.toLowerCase() === 'dispatch') { sites.count(from.id, 'external'); return; }
        sites.count(from.id, 'unresolved', methodName); return;
      }
      if (receiverType?.kind === 'query' || receiverType?.kind === 'external') { sites.count(from.id, 'external'); return; }
      sites.count(from.id, 'unresolved', methodName);
    });
  }
  function nthCall(node: Ast, steps: number): Ast | undefined {
    let current: Ast | undefined = node;
    for (let i = 0; i < steps && current; i++) current = ast(ast(current.what)?.what);
    return current?.kind === 'call' ? current : undefined;
  }
}
