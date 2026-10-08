import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { ANALYZER_VERSION, evidence, type Evidence } from '../../core/graph.js';
import { fileKey } from '../../pipeline/cache.js';
import { fileAnalysis, type ImportOutcome, type PythonImportFact } from '../facts.js';
import { PythonResolver, type PythonModule, type PythonModuleOutcome } from '../resolution/python.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { PythonImportBindings } from './python-bindings.js';
import { PythonSymbols } from './python-symbols.js';
import { FASTAPI_VERSION, FastAPIRegistrations } from '../frameworks/fastapi.js';
import { FLASK_VERSION, FlaskRegistrations } from '../frameworks/flask.js';
import { DJANGO_VERSION, DjangoRegistrations } from '../frameworks/django.js';

export const PYTHON_IMPORT_VERSION = `${ANALYZER_VERSION}:python-imports:8`;
export const pythonAnalyzer: Analyzer = {
  name: 'python-imports', version: PYTHON_IMPORT_VERSION,
  async analyze(context): Promise<void> {
    const files = [...context.files.values()].filter(file => file.language === 'python' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (!files.length) return;
    const resolver = new PythonResolver(context);
    context.python = resolver;
    const repository = context.graph.entities.get(context.repositoryId)!;
    repository.metadata.projects = [...Array.isArray(repository.metadata.projects) ? repository.metadata.projects : [], ...resolver.describe()];
    const directories = new Map([...context.graph.entities.values()].filter(entity => entity.path && ['directory', 'application'].includes(entity.type)).map(entity => [entity.path!, entity.id]));
    const work = async (): Promise<void> => {
      for (const file of files) analyzeFile(context, resolver, file, directories);
      const symbols = new PythonSymbols(context, resolver);
      new FastAPIRegistrations(context, symbols).run();
      new FlaskRegistrations(context, symbols).run();
      new DjangoRegistrations(context, symbols).run();
      symbols.analyze();
    };
    if (context.cache) await context.cache.unit(context, this.name, 'repository', {
      version: PYTHON_IMPORT_VERSION, syntax: STRUCTURE_VERSION, packs: { fastapi: FASTAPI_VERSION, flask: FLASK_VERSION, django: DJANGO_VERSION }, config: context.config, projects: resolver.describe(),
      inputs: [...context.files.values()].filter(file => file.language === 'python' || /(?:^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|requirements[\w.-]*\.txt)$/.test(file.path)).sort((a, b) => a.path.localeCompare(b.path, 'en')).map(file => fileKey(context, file.path)),
      availability: files.map(file => [file.path, fileAnalysis(context.graph.entities.get(file.id)!.metadata.analysis)?.features.structure]),
    }, work);
    else await work();
  },
};

function analyzeFile(context: AnalysisContext, resolver: PythonResolver, file: ScannedFile, directories: Map<string, string>): void {
  const entity = context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis);
  if (!analysis) return;
  const parsed = context.syntax?.get(file.path);
  if (!parsed?.facts.python) { analysis.features.imports = { status: 'failed', reason: 'Python syntax facts are unavailable' }; return; }
  if (!file.path.endsWith('.py')) {
    analysis.features.imports = { status: 'disabled', reason: file.path.endsWith('.pyi') ? 'Stub is type input; runtime module imports are not extracted' : 'Python launch-file semantics require an explicit profile' }; return;
  }
  entity.metadata.importResolver = { adapter: 'python', version: PYTHON_IMPORT_VERSION, project: resolver.owner(file.path)?.id };
  const entries: unknown[] = [], external: string[] = [];
  const lexical = new PythonImportBindings(parsed.facts);
  const gaps = runtimeImportGaps(resolver, file.path, lexical);
  entity.metadata.importGaps = gaps;
  for (const gap of gaps) context.graph.diagnose({ analyzer: 'python-imports', severity: 'warning', code: gap.path ? 'python-runtime-import-path' : 'python-dynamic-import', file: file.path, entityId: file.id, line: gap.line, reason: gap.reason });
  const targetId = (module: PythonModule): string | undefined => module.file?.id ?? directories.get(module.directory);
  const serialize = (value: PythonModuleOutcome): ImportOutcome => {
    if (value.status === 'resolved') return { status: 'resolved', targets: value.modules.map(targetId).filter((id): id is string => !!id), proof: value.proof };
    if (value.status === 'external') return { status: 'external', dependency: '', proof: [] };
    if (value.status === 'ambiguous') return { status: 'ambiguous', candidates: value.candidates.map(targetId).filter((id): id is string => !!id), reason: value.reason };
    return { status: value.status, reason: value.reason };
  };
  const diagnose = (fact: PythonImportFact, code: string, reason: string): void => context.graph.diagnose({ analyzer: 'python-imports', severity: 'warning', code, file: file.path, entityId: file.id, line: fact.range.startLine, reason });
  for (const fact of parsed.facts.python.imports) {
    const pathGap = gaps.find(gap => gap.path);
    const module: PythonModuleOutcome = pathGap && !['sys', 'builtins'].includes(fact.specifier) ? { status: 'unsupported', reason: 'Proven runtime import-path or package-path mutation makes static module selection unavailable in this file' } : resolver.resolve(file.path, fact.specifier);
    const scopeId = fact.scope ? parsed.declarations.get(fact.scope) : undefined;
    const typeProof = pathGap ? [] : typeOnlyGuard(resolver, file.path, lexical, fact);
    const typeOnly = typeProof.length > 0;
    const proof: Evidence[] = [{ ...evidence('syntax', 'python-imports', file.path, fact.range.startLine, `Python ${fact.kind} import ${fact.specifier}`), analyzerVersion: PYTHON_IMPORT_VERSION, endLine: fact.range.endLine }, ...typeProof];
    const outcome = serialize(module);
    if (outcome.status === 'external') { outcome.dependency = fact.specifier; outcome.proof = proof; external.push(fact.specifier); }
    else if (outcome.status === 'resolved') outcome.proof = [...proof, ...outcome.proof];
    const bindings = fact.bindings.map(binding => ({ ...binding, ...(typeOnly ? { typeOnly: true } : {}) }));
    const metadata = { adapter: 'python', version: 1, specifier: fact.specifier, kind: fact.kind, bindings, range: fact.range, ...(fact.moduleBinding ? { moduleBinding: fact.moduleBinding } : {}), ...(scopeId ? { scopeId, deferred: context.graph.entities.get(scopeId)?.type !== 'class' } : {}), ...(typeOnly ? { typeOnly } : {}), ...(fact.conditions.length ? { conditions: fact.conditions } : {}) };
    const discriminator = (implicit: boolean, specifier = fact.specifier) => JSON.stringify([specifier, scopeId ?? '', bindings, fact.moduleBinding ?? '', fact.conditions, implicit]);
    const link = (value: PythonModuleOutcome, specifier = fact.specifier): void => {
      if (value.status !== 'resolved') return;
      for (const [implicitParent, modules] of [[true, value.parents], [false, value.modules]] as const) for (const module of modules) {
        const target = targetId(module);
        if (target) context.graph.relate(file.id, target, 'imports', [...proof, ...value.proof], { ...metadata, specifier, ...(implicitParent ? { implicitParent: true } : {}), ...(module.namespace ? { namespace: true } : {}) }, discriminator(implicitParent, specifier));
      }
    };
    link(module);
    const members: unknown[] = [];
    if (fact.kind === 'from' && module.status === 'resolved') for (const binding of bindings) {
      if (binding.imported === '*') continue;
      if (module.modules.every(item => item.package)) {
        const packageName = module.modules[0]!.name;
        // A from-import first looks up a package attribute. A declared/imported
        // attribute or a dynamic initializer prevents guessing a submodule.
        const attribute = module.modules.some(item => item.file && packageHasAttributeOrGap(context, item.file.path, binding.imported));
        if (attribute) { members.push({ imported: binding.imported, status: 'symbol', reason: 'Package attribute/re-export is selected by the Python symbol binder' }); continue; }
        const memberSpecifier = `${packageName}.${binding.imported}`, member = resolver.resolve(file.path, memberSpecifier);
        members.push({ imported: binding.imported, outcome: serialize(member) }); link(member, memberSpecifier);
      }
    }
    entries.push({ ...metadata, outcome, ...(module.status === 'resolved' ? { parentTargets: module.parents.map(targetId).filter(Boolean) } : {}), ...(members.length ? { members } : {}) });
    if (!['resolved', 'external'].includes(module.status)) diagnose(fact, `python-import-${module.status}`, module.status === 'ambiguous' ? module.reason : (module as { reason: string }).reason);
  }
  entity.metadata.importOutcomes = entries;
  entity.metadata.externalImports = [...new Set(external)].sort();
  analysis.features.imports = { status: 'partial', reason: 'Static indexed module paths, aliases, package parents, namespaces and proven TYPE_CHECKING guards; bounded member/re-export/literal __all__ binding; dynamic exports, runtime hooks and sys.path mutations remain unsupported' };
}

function packageHasAttributeOrGap(context: AnalysisContext, file: string, name: string): boolean {
  const facts = context.syntax?.get(file)?.facts;
  if (!facts?.python || facts.issues.length || facts.truncated) return true;
  return facts.python.opaqueModule || facts.python.opaqueScopes.includes('') || facts.python.writes.some(write => !write.scope && [name, '__getattr__', '__path__'].includes(write.name))
    || facts.python.imports.some(fact => !fact.scope && fact.bindings.some(binding => binding.local === name || binding.imported === '*'));
}

function typeOnlyGuard(resolver: PythonResolver, file: string, lexical: PythonImportBindings, imported: PythonImportFact): Evidence[] {
  for (const guard of imported.guards) {
    let expression = guard.expression.trim(), negated = false;
    while (expression.startsWith('(') && expression.endsWith(')')) expression = expression.slice(1, -1).trim();
    if (expression.startsWith('not ')) { negated = true; expression = expression.slice(4).trim(); while (expression.startsWith('(') && expression.endsWith(')')) expression = expression.slice(1, -1).trim(); }
    if (guard.branch === negated || !/^[\p{ID_Start}_][\p{ID_Continue}]*(?:\.TYPE_CHECKING)?$/u.test(expression)) continue;
    const name = expression.split('.')[0]!;
    const binding = lexical.imported(guard.scope, name, imported.start);
    if (!binding || lexical.visible(guard.scope).some(scope => lexical.written(scope, expression))) continue;
    const { fact } = binding, typing = ['typing', 'typing_extensions'].includes(fact.specifier);
    const check = fact.kind === 'from' ? binding.imported === 'TYPE_CHECKING' && expression === name : expression === `${name}.TYPE_CHECKING`;
    if (typing && check && resolver.resolve(file, fact.specifier).status === 'external') return [{ ...evidence('syntax', 'python-imports', file, fact.range.startLine, `External ${fact.specifier} TYPE_CHECKING binding ${name}; import lies in the type-checking branch`), analyzerVersion: PYTHON_IMPORT_VERSION }];
  }
  return [];
}

function runtimeImportGaps(resolver: PythonResolver, file: string, lexical: PythonImportBindings): { line: number; path: boolean; reason: string }[] {
  const result: { line: number; path: boolean; reason: string }[] = [], syntax = lexical.facts.python!;
  const external = (scope: string | undefined, callee: string, before: number, ignoreWriteStart?: number) => {
    const [name, ...members] = callee.split('.'), binding = lexical.imported(scope, name!, before, ignoreWriteStart);
    if (!binding || resolver.resolve(file, binding.fact.specifier).status !== 'external') return '';
    const module = binding.fact.moduleBinding === 'head' ? binding.fact.specifier.split('.')[0]! : binding.fact.specifier;
    return [module, ...(binding.fact.kind === 'from' ? [binding.imported] : []), ...members].join('.');
  };
  for (const call of syntax.calls) {
    const resolved = external(call.scope, call.callee, call.start);
    const builtinImport = call.callee === '__import__' && !lexical.shadowed(call.scope, '__import__');
    if (builtinImport || resolved === 'importlib.import_module') result.push({ line: call.range.startLine, path: false, reason: `Dynamic import call ${call.callee}; runtime module names are not evaluated` });
    if (/^sys\.(?:path|meta_path|path_hooks|modules)\.(?:append|insert|extend|clear|pop|remove|sort|reverse|update|setdefault|popitem|__setitem__|__delitem__)$/.test(resolved) || /^__path__\.(?:append|insert|extend|clear|pop|remove|sort|reverse)$/.test(call.callee) && !call.scope) result.push({ line: call.range.startLine, path: true, reason: `Runtime import search state is mutated through ${call.callee}; path/hook operations are not executed` });
  }
  for (const write of syntax.writes) {
    const resolved = external(write.scope, write.name, write.start, write.kind === 'augmentation' ? write.start : undefined);
    if (/^sys\.(?:path|meta_path|path_hooks|modules)(?:\.|$)/.test(resolved) || !write.scope && ['__path__', '__package__'].includes(write.name)) result.push({ line: write.line, path: true, reason: `Runtime import search state is assigned through ${write.name}` });
  }
  return result;
}
