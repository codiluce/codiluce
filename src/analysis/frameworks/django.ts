import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { subset, validRange } from 'semver';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence, type SourceRange } from '../../core/graph.js';
import { fileAnalysis, type PythonArgument, type PythonExpression } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';
import { PythonSymbols, type PythonBound } from '../languages/python-symbols.js';
import { compileDjangoPath, djangoRegexRoute, type RoutingContract } from '../routes/contracts.js';

export const DJANGO_VERSION = '1.0.0';
interface Site { file: string; start: number; range: SourceRange; scope?: string }
interface Sequence { kind: 'sequence'; items: Value[]; container?: string; conditions: string[] }
interface Mapping { kind: 'mapping'; entries: Map<string, Value>; conditions: string[] }
interface Pattern { kind: 'pattern'; site: Site; rule?: string; regex: boolean; target: Value; name?: string; kwargs?: Mapping; conditions: string[] }
interface Include { kind: 'include'; site: Site; patterns: Value; namespace?: string; appName?: string; conditions: string[] }
interface Group { methods: string[] | '*'; excluded?: string[]; handler?: string; status?: number; automatic?: boolean }
interface View { kind: 'view'; groups: Group[]; classId?: string; conditions: string[] }
interface Unknown { kind: 'unknown'; reason: string }
type Value = PythonBound | Sequence | Mapping | Pattern | Include | View | Unknown | string | number | boolean | null | undefined;
interface Root { id: string; application: string; site: Site; value: Value; label: string; proof: string; profile: 'django-5.2' | 'unknown'; settings?: string; conditions: string[]; middleware: string[] }
const object = <K extends 'sequence' | 'mapping' | 'pattern' | 'include' | 'view' | 'module' | 'symbol'>(value: Value, kind: K): value is Extract<Exclude<Value, undefined>, { kind: K }> => !!value && typeof value === 'object' && value.kind === kind;
const unknown = (reason: string): Unknown => ({ kind: 'unknown', reason });
const methodNames = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const methodDecorators = new Set(['require_http_methods', 'require_GET', 'require_POST', 'require_safe']);
const transparent = new Set(['django.views.decorators.csrf.csrf_exempt', 'django.views.decorators.csrf.csrf_protect', 'django.views.decorators.csrf.ensure_csrf_cookie', 'django.views.decorators.csrf.requires_csrf_token']);

/** Static URLconf values only. No settings import, regex execution, framework
 * installation or target Python runtime is used. Unknown values stay candidates. */
export class DjangoRegistrations {
  private readonly active = new Set<string>();
  private readonly variables = new Map<string, Value>();
  private readonly profiles = new Map<string, Root['profile']>();
  private readonly roots: Root[] = [];
  private readonly visited = new Set<string>();
  private readonly middlewareEntities = new Map<string, string[]>();
  private readonly escapes = new Map<string, Site[]>();
  private readonly objectEscapes = new Set<string>();
  private readonly settingsSelectors = new Map<string, Site[]>();
  private converterOverride?: boolean;
  private steps = 0;
  constructor(private readonly context: AnalysisContext, private readonly symbols: PythonSymbols) {}
  private fact(site: Site, explanation: string): Evidence { return { ...evidence('framework', 'django', site.file, site.range.startLine, explanation), analyzerVersion: DJANGO_VERSION }; }
  private issue(site: Site, code: string, reason: string): void { this.context.graph.diagnose({ analyzer: 'django', severity: 'warning', code: `django-${code}`, file: site.file, line: site.range.startLine, entityId: this.context.files.get(site.file)?.id, reason }); }
  private site(file: string, expression?: PythonExpression): Site { return expression?.kind === 'call' ? { file, start: expression.start ?? Infinity, range: expression.range ?? { startLine: 1, endLine: 1 } } : { file, start: Infinity, range: { startLine: 1, endLine: 1 } }; }
  private argument(args: PythonArgument[], name: string, index?: number): PythonExpression | undefined { return args.find(arg => arg.name === name)?.value ?? (index === undefined ? undefined : args.filter(arg => !arg.name && !arg.spread)[index]?.value); }
  private read(args: PythonArgument[], name: string, site: Site, index?: number): Value { const value = this.argument(args, name, index); return value ? this.evaluate(value, site) : undefined; }
  private options(args: PythonArgument[], allowed: string[], maximum: number): string[] {
    const positional = args.filter(arg => !arg.name && !arg.spread), named = args.filter(arg => arg.name);
    return [...(args.some(arg => arg.spread) ? ['Expanded URL registration arguments are unresolved'] : []), ...named.filter(arg => !allowed.includes(arg.name!)).map(arg => `Unsupported URL registration keyword ${arg.name}`), ...(positional.length > maximum ? ['Too many positional URL registration arguments'] : []), ...(named.some(arg => named.filter(other => other.name === arg.name).length > 1 || (allowed.indexOf(arg.name!) >= 0 && allowed.indexOf(arg.name!) < Math.min(maximum, positional.length))) ? ['URL registration binds an argument more than once'] : [])];
  }
  private profile(file: string): Root['profile'] {
    const root = this.symbols.resolver.owner(file)?.root ?? '.', cached = this.profiles.get(root); if (cached) return cached;
    const sources = this.context.sources ?? new IndexedSources(this.context), dependencies: string[] = [];
    for (const input of this.context.files.values()) {
      if (!input.analyzable || path.posix.dirname(input.path) !== root) continue;
      try {
        if (/(?:^|\/)pyproject\.toml$/.test(input.path)) {
          const parsed = parseToml(sources.readText(input.path)) as any;
          dependencies.push(...(Array.isArray(parsed.project?.dependencies) ? parsed.project.dependencies.filter((item: unknown): item is string => typeof item === 'string') : []));
          const poetry = Object.entries(parsed.tool?.poetry?.dependencies ?? {}).find(([name]) => name.toLowerCase() === 'django')?.[1];
          if (typeof poetry === 'string') dependencies.push(`django${/^[<>=~^]/.test(poetry) ? poetry : `==${poetry}`}`);
        } else if (/(?:^|\/)requirements[\w.-]*\.txt$/.test(input.path)) dependencies.push(...sources.readText(input.path).split(/\r?\n/));
      } catch { /* A failed manifest cannot establish a version profile. */ }
    }
    const ranges = dependencies.map(item => /^\s*django(?:\[[\w, -]+\])?(?=\s|[<>=~!@;#]|$)\s*([^#]*)/i.exec(item)).filter(Boolean).map(match => /[!*@;]|~=/.test(match![1]!) ? undefined : validRange(match![1]!.trim().replace(/==/g, '').replace(/,/g, ' ')));
    const result = ranges.length && ranges.every(range => !!range && subset(range, '>=5.2.0 <5.3.0')) ? 'django-5.2' : 'unknown';
    this.profiles.set(root, result); return result;
  }
  private module(importer: string, name: string): Value {
    if ((this.context.graph.entities.get(this.context.files.get(importer)!.id)?.metadata.importGaps as { path: boolean }[] | undefined)?.some(gap => gap.path)) return unknown('Runtime import-path mutation prevents URLconf module selection');
    const result = this.symbols.resolver.resolve(importer, name);
    return result.status === 'resolved' && result.modules.length === 1 && result.modules[0]!.file ? { kind: 'module', importer, name, modules: result.modules } : unknown(`URLconf module ${name} is not one readable indexed module`);
  }
  private moduleVariable(value: Value, name = 'urlpatterns'): Value { return object(value, 'module') && value.modules.length === 1 && value.modules[0]!.file ? this.variable(value.modules[0]!.file!.path, name) : value; }
  private dotted(importer: string, name: string): PythonBound | Unknown {
    const parts = name.split('.'), attribute = parts.pop()!;
    const module = this.module(importer, parts.join('.'));
    return object(module, 'module') && module.modules[0]!.file ? this.symbols.name(module.modules[0]!.file!.path, attribute) : unknown(`Dotted callable ${name} is not indexed`);
  }
  run(): void {
    const python = [...this.context.files.values()].filter(file => file.language === 'python' && file.analyzable && file.path.endsWith('.py') && !/(?:^|\/)(?:tests?|fixtures|__fixtures__|testdata)(?:\/|$)/.test(file.path));
    if (!python.some(file => this.symbols.facts(file.path)?.python?.imports.some(item => item.specifier === 'django' || item.specifier.startsWith('django.'))) && !this.context.config.applications.some(app => app.entrypoints?.django?.length || app.frameworks.includes('django'))) return;
    for (const [file, parsed] of this.context.syntax ?? []) for (const call of parsed.facts.python?.calls ?? []) {
      if (call.scope || call.expression.kind !== 'call') continue;
      const site = { file, start: call.start, range: call.range }, callee = call.expression.callee;
      const registration = this.symbols.resolve(file, callee, undefined, call.start);
      if (registration.kind === 'external' && /^(?:django\.(?:urls(?:\.conf)?\.(?:path|re_path|include)|conf\.urls\.include|views\.decorators\.(?:http|csrf)\.\w+))$/.test(registration.name)) continue;
      const values = [...(callee.kind === 'member' && callee.name !== 'as_view' ? [this.symbols.resolve(file, callee.object, undefined, call.start)] : []), ...call.expression.args.map(arg => this.symbols.resolve(file, arg.value, undefined, call.start))];
      for (const value of values) {
        if (value.kind === 'value' && !value.assignment.scope && !(file === value.file && call.callee.startsWith(`${value.assignment.name}.`))) { const key = JSON.stringify([value.file, value.assignment.name]), sites = this.escapes.get(key) ?? []; sites.push(site); this.escapes.set(key, sites); }
        if (value.kind === 'symbol') this.objectEscapes.add(value.id);
      }
    }
    for (const app of this.context.config.applications) {
      const files = python.filter(file => file.application?.name === app.name), importer = files.find(file => this.symbols.resolver.owner(file.path)?.root === app.path) ?? files[0]; if (!importer) continue;
      if (app.entrypoints?.django?.length) for (const entry of app.entrypoints.django) {
        const [name, attribute = 'urlpatterns'] = entry.split(':'), module = this.module(importer.path, name!);
        const selectedFile = object(module, 'module') ? module.modules[0]!.file!.path : importer.path;
        let value = this.moduleVariable(module, attribute);
        if (typeof value === 'string') value = this.moduleVariable(this.module(selectedFile, value));
        const settings = attribute === 'ROOT_URLCONF' ? selectedFile : files.filter(file => this.symbols.facts(file.path)?.python?.assignments.some(item => !item.scope && item.name === 'ROOT_URLCONF' && item.value.kind === 'literal' && item.value.value === name)).map(file => file.path);
        this.addRoot(app.name, entry, selectedFile, value, [`Configured Django entrypoint ${entry}`, ...(Array.isArray(settings) && settings.length > 1 ? ['Multiple middleware/settings alternatives are unresolved'] : [])], typeof settings === 'string' ? settings : settings.length === 1 ? settings[0] : undefined, importer.path);
      }
      else {
        const selectedSettings = new Set<string>();
        for (const file of files.filter(file => /(?:^|\/)(?:manage|wsgi|asgi)\.py$/.test(file.path))) {
          const calls = this.symbols.facts(file.path)?.python?.calls ?? [];
          if (!calls.some(call => { const value = call.expression.kind === 'call' ? this.symbols.resolve(file.path, call.expression.callee, call.scope, call.start) : undefined; return value?.kind === 'external' && ['django.core.management.execute_from_command_line', 'django.core.wsgi.get_wsgi_application', 'django.core.asgi.get_asgi_application'].includes(value.name); })) continue;
          for (const call of calls) if (call.expression.kind === 'call') {
            const binding = this.symbols.resolve(file.path, call.expression.callee, call.scope, call.start);
            if (binding.kind === 'external' && binding.name === 'os.environ.setdefault' && this.read(call.expression.args, 'key', { file: file.path, start: call.start, range: call.range, scope: call.scope }, 0) === 'DJANGO_SETTINGS_MODULE') {
              const name = this.read(call.expression.args, 'default', { file: file.path, start: call.start, range: call.range, scope: call.scope }, 1), module = typeof name === 'string' ? this.module(file.path, name) : undefined;
              if (object(module, 'module')) { const filePath = module.modules[0]!.file!.path; selectedSettings.add(filePath); const sites = this.settingsSelectors.get(filePath) ?? []; sites.push({ file: file.path, start: call.start, range: call.range }); this.settingsSelectors.set(filePath, sites); }
            }
          }
        }
        const settings = files.filter(file => selectedSettings.size ? selectedSettings.has(file.path) : this.symbols.facts(file.path)?.python?.assignments.some(item => !item.scope && item.name === 'ROOT_URLCONF'));
        for (const file of settings) {
          const assignments = this.symbols.facts(file.path)!.python!.assignments.filter(item => !item.scope && item.name === 'ROOT_URLCONF');
          if (!assignments.length) {
            const selected = this.variable(file.path, 'ROOT_URLCONF'), value = typeof selected === 'string' ? this.moduleVariable(this.module(file.path, selected)) : this.moduleVariable(selected);
            this.addRoot(app.name, typeof selected === 'string' ? selected : `${file.path}:ROOT_URLCONF`, file.path, value, [`Imported ROOT_URLCONF settings profile ${file.path}`], file.path);
          }
          for (const assignment of assignments) {
            const site = { file: file.path, start: assignment.start, range: assignment.range }, selected = assignments.length === 1 ? this.variable(file.path, 'ROOT_URLCONF') : this.evaluate(assignment.value, site);
            const value = typeof selected === 'string' ? this.moduleVariable(this.module(file.path, selected)) : this.moduleVariable(selected);
            const label = typeof selected === 'string' ? selected : `${file.path}:ROOT_URLCONF`, conditions = [...assignment.conditions];
            if (assignments.length !== 1) conditions.push('ROOT_URLCONF has multiple assignments');
            this.addRoot(app.name, label, file.path, value, [`Literal ROOT_URLCONF settings profile ${file.path}`, ...conditions], file.path);
          }
        }
        if (!settings.length && (app.frameworks.includes('django') || files.some(file => this.symbols.facts(file.path)?.python?.imports.some(item => item.specifier.startsWith('django.urls'))))) this.issue(this.site(importer.path), 'url-root-missing', 'No explicit entrypoint or indexed ROOT_URLCONF settings profile selects public URL patterns');
      }
    }
    for (const root of this.roots) {
      const alternatives = this.roots.filter(item => item.application === root.application);
      if (alternatives.length > 1) root.conditions.push('Multiple settings/URLconf deployment alternatives are unresolved');
      this.walk(root, root.value, '', [], [], [], new Set(), []);
    }
  }
  private addRoot(application: string, label: string, file: string, value: Value, proof: string[], settings?: string, profileSource = file): void {
    const assignment = this.symbols.facts(file)?.python?.assignments.find(item => !item.scope && item.name === (settings ? 'ROOT_URLCONF' : 'urlpatterns'));
    const site = assignment ? { file, start: assignment.start, range: assignment.range } : this.site(file), id = this.context.graph.id('router', 'django', application, label, settings ?? '');
    if (this.roots.some(item => item.id === id)) return;
    const profile = this.profile(profileSource), conditions = proof.slice(1);
    if (profile === 'unknown') { conditions.push('Django version does not select the reviewed 5.2 routing profile'); this.issue(site, 'version-profile', conditions.at(-1)!); }
    const root: Root = { id, application, label, site, value, proof: proof[0]!, profile, settings, conditions, middleware: [] };
    if (settings) this.middleware(root, settings);
    this.roots.push(root); this.mark(file, proof[0]!);
  }
  private mark(file: string, explanation: string): void {
    if (this.visited.has(file)) return; this.visited.add(file);
    const entity = this.context.graph.entities.get(this.context.files.get(file)!.id)!, analysis = fileAnalysis(entity.metadata.analysis);
    (entity.metadata.frameworkPacks as string[] | undefined) ??= []; if (!(entity.metadata.frameworkPacks as string[]).includes('django')) (entity.metadata.frameworkPacks as string[]).push('django');
    if (analysis) analysis.features.framework = this.symbols.facts(file)?.issues.length || this.symbols.facts(file)?.truncated ? { status: 'failed', reason: 'Complete Django syntax facts are unavailable' } : { status: 'partial', reason: 'Static Django settings/URL roots, indexed URL lists, includes, namespaces, view/method binding and constrained dynamic candidates; settings and runtime dispatch are not executed' };
    (entity.metadata.djangoProfiles as string[] | undefined) ??= []; (entity.metadata.djangoProfiles as string[]).push(explanation);
  }
  private variable(file: string, name: string): Value {
    const key = JSON.stringify([file, name]); if (this.variables.has(key)) return this.variables.get(key);
    if (this.active.has(key) || this.active.size > 32 || ++this.steps > 30_000) return unknown('URLconf value recursion/step budget exceeded');
    const facts = this.symbols.facts(file), syntax = facts?.python;
    this.mark(file, `Indexed Django ${name} value`);
    if (!syntax || facts!.issues.length || facts!.truncated) return unknown('Complete URLconf syntax is unavailable');
    if (syntax.opaqueScopes.includes('') || syntax.calls.some(call => !call.scope && ['exec', 'eval', 'globals', 'locals'].includes(call.callee))) return unknown('Dynamic module namespace prevents static URLconf values');
    const assignments = syntax.assignments.filter(item => !item.scope && item.name === name).sort((a, b) => a.start - b.start);
    if (!assignments.length) { const binding = this.symbols.name(file, name); return binding.kind === 'value' ? this.variable(binding.file, binding.assignment.name) : binding; }
    this.active.add(key);
    const events = [...assignments.map(item => ({ start: item.start, kind: 'assignment' as const, item })), ...syntax.calls.filter(item => !item.scope && item.standalone && item.callee.startsWith(`${name}.`)).map(item => ({ start: item.start, kind: 'call' as const, item }))].sort((a, b) => a.start - b.start);
    let value: Value; const conditions: string[] = [];
    for (const event of events) {
      const site = { file, start: event.start, range: event.item.range };
      if (event.kind === 'assignment') {
        const current = this.evaluate(event.item.value, site);
        if (event.item.conditions.length) conditions.push('Conditional URLconf assignment');
        if (event.item.augmentation) {
          if (event.item.augmentation === '+=' && object(value, 'sequence') && object(current, 'sequence')) value.items.push(...current.items);
          else { conditions.push('Unsupported URLconf augmentation'); if (object(value, 'sequence')) value.items.push(unknown('Dynamic augmented URL patterns')); }
        } else {
          if (value !== undefined) { conditions.push('Multiple URLconf assignments'); if (object(value, 'sequence') && object(current, 'sequence')) { value.items.push(...current.items); continue; } }
          value = current;
        }
      } else if (object(value, 'sequence') && event.item.expression.kind === 'call') {
        const method = event.item.callee.slice(name.length + 1), args = event.item.expression.args;
        if (event.item.conditions.length || args.some(arg => arg.spread) || args.some(arg => arg.name) || args.length !== 1) conditions.push('Conditional, expanded or invalid URL list mutation');
        const added = this.read(args, 'object', site, 0);
        if (method === 'append') value.items.push(added);
        else if (method === 'extend' && object(added, 'sequence')) { value.items.push(...added.items); conditions.push(...added.conditions); }
        else { conditions.push(`Unsupported URL list mutation ${method}`); value.items.push(unknown('Unsupported URL list mutation may add patterns')); }
      }
    }
    const writes = syntax.writes.filter(item => !item.scope && item.name === name);
    if (writes.some(write => !assignments.some(item => item.start === write.start))) conditions.push('URLconf value is mutated through an unsupported write');
    if (object(value, 'sequence')) for (const site of this.escapes.get(key) ?? []) { conditions.push('URL list is mutated through an alias or passed to an unreviewed callable'); value.items.push(unknown('Aliased/escaped URL list may contain additional patterns')); this.issue(site, 'url-list-escape', conditions.at(-1)!); }
    if (this.symbols.moduleAttributeWritten(file, name)) { conditions.push('URLconf module attribute is assigned through an alias'); if (object(value, 'sequence')) value.items.push(unknown('Aliased module assignment may replace URL patterns')); }
    if (object(value, 'sequence')) value.conditions.push(...conditions); else if (conditions.length) value = unknown(conditions.join('; '));
    this.active.delete(key); this.variables.set(key, value); return value;
  }
  private evaluate(expression: PythonExpression, outer: Site): Value {
    if (++this.steps > 30_000) return unknown('Static URLconf exceeded 30,000 steps');
    const site = expression.kind === 'call' ? { ...outer, ...this.site(outer.file, expression) } : outer;
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'sequence') return { kind: 'sequence', items: expression.items.map(item => this.evaluate(item, site)), container: expression.container, conditions: expression.container === 'set' ? ['Unordered URL pattern set'] : [] };
    if (expression.kind === 'mapping') {
      const entries = new Map<string, Value>(), conditions: string[] = [];
      for (const item of expression.items) { const key = this.evaluate(item.key, site); if (typeof key === 'string') entries.set(key, this.evaluate(item.value, site)); else conditions.push('Dynamic URL argument name'); }
      return { kind: 'mapping', entries, conditions };
    }
    if (expression.kind === 'binary' && expression.operator === '+') {
      const left = this.evaluate(expression.left, site), right = this.evaluate(expression.right, site);
      return object(left, 'sequence') && object(right, 'sequence') ? { kind: 'sequence', items: [...left.items, ...right.items], conditions: [...left.conditions, ...right.conditions] } : typeof left === 'string' && typeof right === 'string' ? left + right : unknown('Dynamic URLconf concatenation');
    }
    if (expression.kind === 'name' || expression.kind === 'member') {
      const selected = this.symbols.resolve(site.file, expression, site.scope, site.start);
      if (selected.kind === 'value') return this.variable(selected.file, selected.assignment.name);
      if (selected.kind !== 'unresolved') return selected;
      if (expression.kind === 'name' && !site.scope && this.symbols.facts(site.file)?.python?.assignments.some(item => !item.scope && item.name === expression.name)) return this.variable(site.file, expression.name);
      if (expression.kind === 'member') { const parent = this.evaluate(expression.object, site); if (object(parent, 'module')) return this.moduleVariable(parent, expression.name); }
      return unknown(selected.reason);
    }
    if (expression.kind !== 'call') return unknown('Expression is outside the static URLconf value profile');
    const callable = this.symbols.resolve(site.file, expression.callee, site.scope, site.start);
    if (callable.kind === 'external' && ['django.urls.path', 'django.urls.conf.path', 'django.urls.re_path', 'django.urls.conf.re_path'].includes(callable.name)) {
      const rule = this.read(expression.args, 'route', site, 0), target = this.read(expression.args, 'view', site, 1), name = this.read(expression.args, 'name', site, 3), kwargs = this.read(expression.args, 'kwargs', site, 2), conditions = this.options(expression.args, ['route', 'view', 'kwargs', 'name'], 4);
      if (typeof rule !== 'string' || rule.startsWith('/')) conditions.push('Dynamic or invalid Django route');
      if (this.argument(expression.args, 'kwargs', 2) && kwargs !== null && !object(kwargs, 'mapping')) conditions.push('Dynamic view defaults');
      if (this.argument(expression.args, 'name', 3) && name !== null && typeof name !== 'string') conditions.push('Dynamic URL name');
      this.mark(site.file, 'Proven Django path/re_path registration');
      return { kind: 'pattern', site, rule: typeof rule === 'string' ? rule : undefined, regex: callable.name.endsWith('.re_path'), target, name: typeof name === 'string' ? name : undefined, kwargs: object(kwargs, 'mapping') ? kwargs : undefined, conditions: [...conditions, ...(object(kwargs, 'mapping') ? kwargs.conditions : [])] };
    }
    if (callable.kind === 'external' && ['django.urls.include', 'django.urls.conf.include', 'django.conf.urls.include'].includes(callable.name)) {
      let patterns = this.read(expression.args, 'arg', site, 0), appName: string | undefined;
      const namespace = this.read(expression.args, 'namespace', site, 1), conditions = this.options(expression.args, ['arg', 'namespace'], 2);
      if (object(patterns, 'sequence') && patterns.container === 'tuple') {
        if (patterns.items.length === 2 && typeof patterns.items[1] === 'string') { appName = patterns.items[1]; patterns = patterns.items[0]; } else conditions.push('Invalid include tuple');
      }
      if (typeof patterns === 'string') patterns = this.module(site.file, patterns);
      if (object(patterns, 'module')) { const name = this.moduleVariable(patterns, 'app_name'); if (typeof name === 'string') appName = name; patterns = this.moduleVariable(patterns); }
      if (namespace !== undefined && namespace !== null && (typeof namespace !== 'string' || !appName)) conditions.push('Dynamic namespace or missing application namespace');
      return { kind: 'include', site, patterns, namespace: typeof namespace === 'string' ? namespace : appName, appName, conditions };
    }
    if (expression.callee.kind === 'member' && expression.callee.name === 'as_view') {
      const selected = this.symbols.resolve(site.file, expression.callee.object, site.scope, site.start);
      if (selected.kind === 'symbol' && selected.declaration.kind === 'class') return this.classView(selected, expression.args, site);
    }
    return unknown('Unreviewed URL pattern/view constructor');
  }
  private functionView(value: Extract<PythonBound, { kind: 'symbol' }>): View {
    const definition = this.symbols.facts(value.file)?.python?.definitions.find(item => item.key === value.declaration.key), conditions: string[] = []; let methods: string[] | '*' = '*';
    for (const decorator of definition?.decorators ?? []) {
      const expression = decorator.kind === 'call' ? decorator.callee : decorator, bound = this.symbols.resolve(value.file, expression, value.declaration.parent, value.declaration.start);
      if (bound.kind === 'external' && bound.name.startsWith('django.views.decorators.http.') && methodDecorators.has(bound.name.split('.').at(-1)!)) {
        const kind = bound.name.split('.').at(-1)!, methodSet = kind === 'require_GET' ? ['GET'] : kind === 'require_POST' ? ['POST'] : kind === 'require_safe' ? ['GET', 'HEAD'] : decorator.kind === 'call' ? this.methods(this.read(decorator.args, 'request_method_list', { file: value.file, start: value.declaration.start, range: value.declaration.range, scope: value.declaration.parent }, 0)) : undefined;
        if (decorator.kind === 'call') { if (kind === 'require_http_methods') conditions.push(...this.options(decorator.args, ['request_method_list'], 1)); else conditions.push('HTTP view decorator is invoked outside its reviewed form'); }
        if (!methodSet) conditions.push('Dynamic HTTP method decorator'); else methods = methods === '*' ? methodSet : methods.filter(method => methodSet.includes(method));
      } else if (!(bound.kind === 'external' && transparent.has(bound.name) && decorator.kind !== 'call')) conditions.push('Custom decorator changes the registered view');
    }
    if (definition?.conditions.length || this.symbols.attributeWrites(value.id).length || this.objectEscapes.has(value.id)) conditions.push('Conditional, mutated or escaped view declaration');
    if (conditions.length) return { kind: 'view', groups: [{ methods: '*'}], conditions };
    if (definition?.decorators.length) this.context.graph.entities.get(value.id)!.metadata.pythonCallable = true;
    return { kind: 'view', groups: [...(methods === '*' || methods.length ? [{ methods, handler: value.id }] : []), ...(methods !== '*' ? [{ methods: '*' as const, excluded: methods, automatic: true, status: 405 }] : [])], conditions };
  }
  private methods(value: Value, classAttribute = false): string[] | undefined { return object(value, 'sequence') && value.items.every(item => typeof item === 'string' && (classAttribute ? /^[a-z]+$/ : /^[A-Z]+$/).test(item)) ? [...new Set((value.items as string[]).map(item => item.toUpperCase()))] : undefined; }
  private classView(selected: Extract<PythonBound, { kind: 'symbol' }>, args: PythonArgument[], site: Site): View {
    const members = new Map<string, Extract<PythonBound, { kind: 'symbol' }>>(), attributes = new Map<string, Value>(), conditions: string[] = [], seen = new Set<string>(); let current: PythonBound = selected, baseName = '';
    while (current.kind === 'symbol' && current.declaration.kind === 'class' && seen.size < 16 && !seen.has(current.id)) {
      const level = current;
      seen.add(level.id); const facts = this.symbols.facts(level.file)!, definition = facts.python!.definitions.find(item => item.key === level.declaration.key)!;
      if (definition?.decorators.length || definition?.conditions.length || this.symbols.attributeWrites(current.id).length || this.objectEscapes.has(current.id)) conditions.push('Decorated/conditional/mutated/escaped view class');
      for (const member of facts.declarations.filter(item => item.parent === level.declaration.key)) if (!members.has(member.name)) {
        const writes = facts.python!.writes.filter(item => item.scope === level.declaration.key && item.name === member.name);
        if (writes.length !== 1) conditions.push('View class member is multiply assigned');
        members.set(member.name, { kind: 'symbol', file: current.file, declaration: member, id: this.context.syntax!.get(current.file)!.declarations.get(member.key)! });
      }
      for (const assignment of facts.python!.assignments.filter(item => item.scope === level.declaration.key)) if (!attributes.has(assignment.name)) {
        if (assignment.conditions.length || assignment.augmentation || facts.python!.writes.filter(item => item.scope === level.declaration.key && item.name === assignment.name).length !== 1) conditions.push('Conditional/mutated view attribute');
        attributes.set(assignment.name, this.evaluate(assignment.value, { file: current.file, start: assignment.start, range: assignment.range, scope: current.declaration.key }));
        if (methodNames.includes(assignment.name) || ['dispatch', 'http_method_not_allowed'].includes(assignment.name)) {
          const bound = attributes.get(assignment.name);
          if (object(bound, 'symbol') && ['function', 'method'].includes(bound.declaration.kind) && !members.has(assignment.name)) members.set(assignment.name, bound);
          else conditions.push('Class HTTP/dispatch attribute is not one indexed callable');
        }
      }
      if (!definition || definition.bases.length !== 1) { conditions.push('Multiple or unproven view inheritance'); break; }
      current = this.symbols.resolve(current.file, definition.bases[0]!, current.declaration.parent, current.declaration.start);
    }
    if (current.kind === 'external') baseName = current.name;
    const base = baseName.split('.').at(-1)!, known = /^(?:django\.views(?:\.generic(?:\.(?:base|list|detail))?)?)\.(?:View|TemplateView|ListView|DetailView|RedirectView)$/.test(baseName);
    if (!known) conditions.push('Class does not reach a reviewed Django view base');
    if (['as_view', '__init__', 'setup', '__getattr__', '__getattribute__'].some(name => members.has(name) || attributes.has(name))) conditions.push('Custom view construction/setup');
    const options = this.options(args, ['http_method_names', ...attributes.keys(), ...(['TemplateView', 'ListView', 'DetailView'].includes(base) ? ['template_name', 'extra_context'] : []), ...(base === 'RedirectView' ? ['url', 'permanent', 'pattern_name', 'query_string'] : [])], 0); conditions.push(...options);
    if (args.some(arg => arg.name && [...methodNames, 'dispatch', 'setup', '__init__'].includes(arg.name))) conditions.push('as_view arguments replace protected HTTP/dispatch attributes');
    for (const arg of args.filter(arg => arg.name)) attributes.set(arg.name!, this.evaluate(arg.value, site));
    let allowed = attributes.has('http_method_names') ? this.methods(attributes.get('http_method_names'), true) : methodNames.map(name => name.toUpperCase());
    if (!allowed || allowed.some(method => !methodNames.includes(method.toLowerCase()))) conditions.push('Dynamic/nonstandard class-view HTTP method names');
    if (conditions.length) return { kind: 'view', classId: selected.id, groups: [{ methods: '*' }], conditions };
    if (members.has('dispatch')) {
      const target = this.functionView(members.get('dispatch')!); return { ...target, classId: selected.id };
    }
    if (members.has('http_method_not_allowed') && this.functionView(members.get('http_method_not_allowed')!).conditions.length) return { kind: 'view', classId: selected.id, groups: [{ methods: '*' }], conditions: ['Custom HTTP rejection wrapper is unresolved'] };
    const groups: Group[] = [], inherited = ['TemplateView', 'ListView', 'DetailView'].includes(base) ? new Map([['GET', selected.id]]) : base === 'RedirectView' ? new Map(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(method => [method, selected.id])) : new Map<string, string>();
    const syncKinds = new Set([...members].filter(([name]) => methodNames.includes(name) && name !== 'options').map(([, member]) => member.declaration.modifiers?.includes('async') ?? false));
    if ([...inherited.keys()].some(method => method !== 'OPTIONS' && !members.has(method.toLowerCase()) && !(method === 'HEAD' && members.has('get')))) syncKinds.add(false);
    if (syncKinds.size > 1) return { kind: 'view', classId: selected.id, groups: [{ methods: '*' }], conditions: ['Mixed sync/async class handlers are invalid'] };
    const handled: string[] = [];
    for (const method of allowed!) {
      const member = members.get(method.toLowerCase()) ?? (method === 'HEAD' ? members.get('get') : undefined), inheritedHandler = inherited.get(method) ?? (method === 'HEAD' ? inherited.get('GET') : undefined);
      if (member) {
        const target = this.functionView(member), group = target.groups.find(group => group.methods === '*' ? !group.excluded?.includes(method) : group.methods.includes(method));
        if (target.conditions.length) return { kind: 'view', classId: selected.id, groups: [{ methods: '*' }], conditions: target.conditions };
        if (group) { groups.push({ ...group, methods: [method], excluded: undefined }); handled.push(method); }
      } else if (inheritedHandler) { groups.push({ methods: [method], handler: inheritedHandler }); handled.push(method); }
      else if (method === 'OPTIONS') { groups.push({ methods: ['OPTIONS'], automatic: true, status: 200 }); handled.push(method); }
    }
    groups.push({ methods: '*', excluded: handled, ...(members.has('http_method_not_allowed') ? { handler: members.get('http_method_not_allowed')!.id } : { automatic: true, status: 405 }) });
    return { kind: 'view', classId: selected.id, groups, conditions };
  }
  private middleware(root: Root, file: string): void {
    const syntax = this.symbols.facts(file)?.python;
    if (!syntax?.assignments.some(item => !item.scope && item.name === 'MIDDLEWARE') && !syntax?.imports.some(item => !item.scope && item.bindings.some(binding => binding.local === 'MIDDLEWARE' || binding.imported === '*'))) return;
    const value = this.variable(file, 'MIDDLEWARE');
    if (!object(value, 'sequence') || value.conditions.length || !value.items.every(item => typeof item === 'string')) { root.conditions.push('Dynamic middleware/settings may override URLconf'); this.issue(this.site(file), 'dynamic-middleware', 'Middleware registration is not a literal indexed sequence'); return; }
    root.middleware = value.items as string[]; const targets: string[] = [];
    const standard = new Set(['django.middleware.security.SecurityMiddleware', 'django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.common.CommonMiddleware', 'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware', 'django.contrib.auth.middleware.LoginRequiredMiddleware', 'django.contrib.messages.middleware.MessageMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware', 'django.middleware.locale.LocaleMiddleware']);
    for (const name of root.middleware) {
      const selected = this.dotted(file, name); if (selected.kind !== 'symbol') { if (!standard.has(name)) { root.conditions.push('External middleware semantics are unreviewed'); this.issue(this.site(file), 'unreviewed-middleware', `Middleware ${name} is outside the indexed/standard profile`); } continue; }
      targets.push(selected.id);
      if (this.symbols.facts(selected.file)?.python?.writes.some(write => /(?:^|\.)(?:urlconf|path_info)$/.test(write.name))) { root.conditions.push('Indexed middleware can override URLconf/path_info'); this.issue(this.site(selected.file), 'middleware-urlconf-override', root.conditions.at(-1)!); }
    }
    this.middlewareEntities.set(root.id, targets);
  }
  private walk(root: Root, value: Value, prefix: string, namespaces: string[], mounts: RoutingContract['mounts'], conditions: string[], seen: Set<Value>, order: number[], defaults: string[] = [], regex = false): void {
    if (++this.steps > 30_000 || seen.size > 32 || seen.has(value)) { this.emit(root, unknown('Cyclic/deep URLconf expansion'), root.site, prefix, namespaces, mounts, [...conditions, 'Cyclic/deep URLconf expansion'], order, defaults, regex); return; }
    if (object(value, 'module')) { this.walk(root, this.moduleVariable(value), prefix, namespaces, mounts, conditions, new Set([...seen, value]), order, defaults, regex); return; }
    if (object(value, 'sequence')) {
      for (const [index, child] of value.items.entries()) this.walk(root, child, prefix, namespaces, mounts, [...conditions, ...value.conditions], new Set([...seen, value]), [...order, index], defaults, regex);
      return;
    }
    if (!object(value, 'pattern')) { this.emit(root, value, root.site, prefix, namespaces, mounts, [...conditions, 'URL pattern value is unresolved'], order, defaults, regex); return; }
    const tuple = object(value.target, 'sequence') && value.target.items.length === 3 && value.target.items.slice(1).every(item => item === null || typeof item === 'string') ? value.target : undefined;
    const include = object(value.target, 'include') ? value.target : tuple ? { kind: 'include' as const, patterns: this.moduleVariable(typeof tuple.items[0] === 'string' ? this.module(value.site.file, tuple.items[0]) : tuple.items[0]), namespace: typeof tuple.items[2] === 'string' ? tuple.items[2] : undefined, site: value.site, conditions: tuple.conditions } : undefined;
    const converted = value.regex && value.rule !== undefined ? djangoRegexRoute(value.rule, !!include) : value.rule, fullPath = prefix + (converted ?? ''), nextConditions = [...conditions, ...value.conditions, ...(converted === undefined ? ['Dynamic or unsupported regex route'] : [])], nextDefaults = [...defaults, ...value.kwargs?.entries.keys() ?? []];
    if (include) {
      const mount = { id: this.context.graph.id('mount', root.id, value.site.file, fullPath, JSON.stringify(order)), file: value.site.file, line: value.site.range.startLine, prefix: converted ?? '<unresolved>' };
      this.walk(root, include.patterns, fullPath, include.namespace ? [...namespaces, include.namespace] : namespaces, [...mounts, mount], [...nextConditions, ...include.conditions], new Set([...seen, value]), order, nextDefaults, regex || value.regex); return;
    }
    this.emit(root, value.target, value.site, fullPath, namespaces, mounts, nextConditions, order, nextDefaults, regex || value.regex, value.name, value.regex ? value.rule : undefined);
  }
  private emit(root: Root, target: Value, site: Site, path: string, namespaces: string[], mounts: RoutingContract['mounts'], conditions: string[], order: number[], defaults: string[], regex: boolean, name?: string, originalRegex?: string): void {
    const parentId = this.context.applicationIds.get(root.application); if (!parentId) return;
    const selected = object(target, 'view') ? target : object(target, 'symbol') && ['function', 'method'].includes(target.declaration.kind) ? this.functionView(target) : undefined;
    const constraints = [...root.conditions, ...conditions, ...selected?.conditions ?? []], pattern = compileDjangoPath(`/${path}`); if (regex) pattern.dialect = 'django-re-path';
    if (!selected) constraints.push('View is not one proven indexed function or Django as_view callable');
    if (!selected || selected.conditions.length) this.issue(site, 'unresolved-view', constraints.join('; '));
    if (!selected || selected.conditions.length || conditions.some(item => /URL pattern value is unresolved|unsupported regex|Dynamic or invalid Django route|Cyclic/.test(item))) { pattern.status = 'partial'; pattern.reason = 'Unresolved URLconf/registration path'; pattern.alternatives = []; const bound = path.split('<')[0]!; if (bound && !conditions.some(item => /unsupported regex|invalid Django route/.test(item))) pattern.prefix = `/${bound}`; }
    this.converterOverride ??= [...this.context.syntax?.entries() ?? []].some(([file, parsed]) => parsed.facts.python?.calls.some(call => { const binding = call.expression.kind === 'call' ? this.symbols.resolve(file, call.expression.callee, call.scope, call.start) : undefined; return binding?.kind === 'external' && ['django.urls.register_converter', 'django.urls.converters.register_converter'].includes(binding.name); }));
    if (this.converterOverride && path.includes('<')) { pattern.status = 'partial'; pattern.reason = 'Runtime converter registration may replace built-ins'; constraints.push(pattern.reason); }
    for (const group of selected?.groups ?? [{ methods: '*' as const }]) {
      const routing: RoutingContract = { version: 1, pattern, methods: group.methods, ...(group.excluded ? { excludedMethods: group.excluded } : {}), executionContext: 'server', registration: { file: site.file, line: site.range.startLine, receiver: root.id }, mounts, middleware: root.middleware, conditions: [...new Set(constraints)] };
      const method = group.methods === '*' ? '*' : group.methods[0], facts = [this.fact(root.site, `${root.proof}; selected URLconf ${root.label}`), ...(root.settings ? this.settingsSelectors.get(root.settings) ?? [] : []).map(site => this.fact(site, 'Declared DJANGO_SETTINGS_MODULE startup default; environment is not read')), this.fact(site, group.automatic ? `Framework HTTP ${group.status} response` : 'Registered Django URL pattern'), ...mounts.map(mount => this.fact({ file: mount.file, start: 0, range: { startLine: mount.line, endLine: mount.line } }, `Django include prefix ${mount.prefix}`))];
      const id = this.context.graph.id('endpoint', 'django', parentId, root.id, path, JSON.stringify(order), JSON.stringify(group.methods), JSON.stringify(group.excluded ?? []), group.handler ?? '');
      this.context.graph.contain({ id, type: 'api_endpoint', name: `${method} /${path}`, path: site.file, language: 'python', parentId, sourceRange: site.range, metadata: { framework: 'django', frameworkVersion: DJANGO_VERSION, registrationProfile: root.profile, method, routePath: `/${path}`, registration: selected ? 'registered' : 'candidate', routing, namespaces, urlName: name ? [...namespaces, name].join(':') : undefined, urlconf: root.label, urlOrder: order, defaultArgumentNames: defaults, ...(originalRegex !== undefined ? { originalRegex } : {}), ...(selected?.classId ? { viewClass: selected.classId } : {}), ...(constraints.length || pattern.status === 'partial' ? { constraintsUnresolved: true } : {}), ...(group.automatic ? { automaticResponse: true, statusCode: group.status } : {}) }, evidence: facts });
      if (group.handler) this.context.graph.relate(id, group.handler, 'handles', facts, { framework: 'django', role: group.handler === selected?.classId ? 'view_class' : 'view' });
      if (selected?.classId) this.context.graph.relate(id, selected.classId, 'references', facts, { framework: 'django', role: 'view_class' });
      for (const middleware of this.middlewareEntities.get(root.id) ?? []) this.context.graph.relate(id, middleware, 'references', facts, { framework: 'django', role: 'middleware' });
      const entity = this.context.graph.entities.get(this.context.files.get(site.file)!.id)!; (entity.metadata.registrations as unknown[] | undefined) ??= []; (entity.metadata.registrations as unknown[]).push({ version: 1, framework: 'django', root: root.id, path: `/${path}`, methods: group.methods, line: site.range.startLine, namespaces, conditions: routing.conditions });
    }
  }
}
