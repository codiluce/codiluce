// Artisan commands and the scheduler: entry points that run without an HTTP
// request.
//
// A *command* is a class whose `extends` chain reaches Laravel's console
// `Command`, named by its literal `$signature` (the first word), `$name`, or
// `#[AsCommand(name: …)]`; its `handle` (or `__invoke`) method handles it. A
// closure command is `Artisan::command('name', fn)` in a console route file.
// Commands are children of their application, like endpoints, and point to
// their handler with `handles`.
//
// A *scheduled task* is `Schedule::command(…)`, `job(…)`, `call(…)` or
// `exec(…)` in a console route file (Laravel 11+: `withRouting(commands:)`),
// a `withSchedule(fn (Schedule $s) => …)` closure of bootstrap/app.php, or the
// `schedule()` method of the console Kernel (Laravel ≤ 10). Its cadence is read
// from the chained frequency methods. A task `invokes` the command (or the
// job's handler) it runs. Anything not literal stays a finding.
import path from 'node:path';
import type { AnalysisContext } from '../core/analyzer.js';
import { evidence, type Entity, type Evidence } from '../core/graph.js';
import { args, ast, classConstant, literal, name, nodes, resolve, scopedChildren, text, walk, type Ast, type ParsedFile, type Scope } from './php-ast.js';
import { classChain, type PhpClass } from './php-references.js';

const CONSOLE_COMMAND = 'illuminate\\console\\command';
const CONSOLE_KERNEL = 'illuminate\\foundation\\console\\kernel';
const SCHEDULE_CLASS = 'illuminate\\console\\scheduling\\schedule';
/** Frequency methods of a scheduled event (`->dailyAt('02:00')`); the rest are modifiers. */
const CADENCE = /^(every|hourly|daily|twice|weekly|monthly|quarterly|yearly|cron|weekdays|weekends|sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|days|at$|between|unlessbetween|lastdayofmonth|timezone)/i;

export interface ConsoleRegistration { app: string; file: string; facts: Evidence[]; registration: 'static' | 'convention' }
export interface CommandLookup {
  /** The command entity for a command line (`parse-words:news --limit=5` → `parse-words:news`). */
  byName(app: string, commandLine: string): Entity | undefined;
  byClass(app: string, fqn: string): Entity | undefined;
}
/** The command name of a command line or signature: its first word. */
export function commandName(line: string): string { return line.trim().split(/[\s{]/)[0] ?? ''; }
function stringValue(node: Ast | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'string' || node.kind === 'nowdoc') return typeof node.value === 'string' ? node.value : undefined;
  return undefined;
}
function words(method: string): string { return method.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); }
/** `everyThreeHours` → "every three hours"; `dailyAt('02:00')` → "daily at 02:00"; `cron('0 * * * *')` → "cron 0 * * * *". */
export function cadenceText(calls: { name: string; args: string[] }[]): string {
  return calls.map(call => [words(call.name), ...call.args].join(' ')).join(', ');
}

interface ChainItem { name: string; args: Ast[]; node: Ast }
/** `root(...)->a(...)->b(...)`: the root call, then each chained call, innermost first. */
function callChain(node: Ast): { root: Ast; chain: ChainItem[] } | undefined {
  const chain: ChainItem[] = [];
  let current: Ast | undefined = node;
  while (current?.kind === 'call') {
    const what = ast(current.what);
    if ((what?.kind === 'propertylookup' || what?.kind === 'nullsafepropertylookup') && ast(what.what)?.kind === 'call') {
      chain.unshift({ name: name(what.offset) ?? '', args: args(current), node: current });
      current = ast(what.what);
      continue;
    }
    return { root: current, chain };
  }
  return undefined;
}

export function declareConsole(context: AnalysisContext, classes: Map<string, PhpClass>, methods: Map<string, Entity>, parsedFiles: Map<string, ParsedFile>, registrations: ConsoleRegistration[]): CommandLookup {
  const { graph } = context;
  const byName = new Map<string, Entity>(), byClass = new Map<string, Entity>();
  const key = (app: string, value: string) => `${app}:${value.toLowerCase()}`;
  const fact = (parsed: ParsedFile, node: Ast, explanation: string, framework = true): Evidence => ({ ...evidence(framework ? 'framework' : 'php', 'php-laravel', parsed.file.path, node.loc?.start.line, explanation), endLine: node.loc?.end.line });
  const diagnose = (parsed: ParsedFile, node: Ast | undefined, code: string, reason: string, entityId?: string, severity: 'info' | 'warning' = 'warning') => graph.diagnose({ analyzer: 'php-laravel', severity, code, reason, file: parsed.file.path, line: node?.loc?.start.line, entityId: entityId ?? parsed.file.id });
  const handlerOf = (app: string, fqn: string): Entity | undefined => {
    for (const ancestor of classChain(classes, app, fqn)) for (const method of ['handle', '__invoke']) { const found = methods.get(`${app}:${ancestor}::${method}`); if (found) return found; }
    return undefined;
  };
  const declare = (app: string, commandLine: string, parsed: ParsedFile, node: Ast, metadata: Record<string, unknown>, facts: Evidence[]): Entity | undefined => {
    const appId = context.applicationIds.get(app);
    const command = commandName(commandLine);
    if (!appId || !command) return undefined;
    if (byName.has(key(app, command))) { diagnose(parsed, node, 'duplicate-command', `Artisan command ${command} is declared more than once`); return undefined; }
    const entity = graph.contain({ id: graph.id('command', app, command), type: 'command', name: command, path: parsed.file.path, parentId: appId, ...(node.loc ? { sourceRange: { startLine: node.loc.start.line, endLine: node.loc.end.line } } : {}), metadata: { framework: 'laravel', command, signature: commandLine.replace(/\s+/g, ' ').trim(), ...metadata }, evidence: facts });
    byName.set(key(app, command), entity);
    return entity;
  };

  // Command classes, in a stable order.
  for (const phpClass of [...classes.values()].sort((a, b) => a.entity.id < b.entity.id ? -1 : 1)) {
    const chain = classChain(classes, phpClass.app, phpClass.fqn);
    if (!chain.includes(CONSOLE_COMMAND) || chain[0] === CONSOLE_COMMAND) continue;
    const { parsed, node, scope } = phpClass;
    let signature: string | undefined, signatureNode: Ast | undefined, description: string | undefined, dynamic = false;
    for (const group of nodes(node.attrGroups)) for (const attribute of nodes(group.attrs)) {
      if (!/(^|\\)AsCommand$/.test(resolve(attribute.name, scope) ?? String(attribute.name))) continue;
      const named = args(attribute).find(item => item.kind === 'namedargument' && name(item.name) === 'name');
      const value = stringValue(ast(named?.value) ?? args(attribute)[0]);
      if (value) { signature = value; signatureNode = attribute; } else dynamic = true;
    }
    for (const item of nodes(node.body)) {
      if (item.kind !== 'propertystatement') continue;
      for (const property of nodes(item.properties)) {
        const propertyName = name(property.name);
        if (propertyName === 'signature' || (propertyName === 'name' && !signature)) {
          const value = stringValue(ast(property.value));
          if (value) { signature = value; signatureNode = property; dynamic = false; } else if (property.value) dynamic = true;
        }
        if (propertyName === 'description') description = stringValue(ast(property.value));
      }
    }
    if (!signature) {
      // Abstract bases and commands named at runtime are not entry points the index can name.
      if (dynamic) diagnose(parsed, node, 'dynamic-command-signature', `${phpClass.fqn} is a console command whose name is not a literal; it is not indexed as a command`, phpClass.entity.id, 'info');
      continue;
    }
    const handler = handlerOf(phpClass.app, phpClass.fqn);
    const entity = declare(phpClass.app, signature, parsed, signatureNode ?? node, { class: phpClass.fqn, handlerKind: handler ? 'method' : 'unresolved', registration: 'class', ...(description ? { description } : {}) }, [fact(parsed, signatureNode ?? node, `Artisan command ${commandName(signature)}: ${phpClass.fqn.split('\\').at(-1)} extends Laravel's console Command`)]);
    if (!entity) continue;
    byClass.set(key(phpClass.app, phpClass.fqn), entity);
    if (handler) graph.relate(entity.id, handler.id, 'handles', [...entity.evidence, ...handler.evidence]);
    else diagnose(parsed, node, 'unresolved-command-handler', `Command ${entity.name} has no handle() or __invoke() method in indexed code`, entity.id);
  }

  const lookup: CommandLookup = {
    byName: (app, line) => byName.get(key(app, commandName(line))),
    byClass: (app, fqn) => byClass.get(key(app, fqn)),
  };

  // Scheduled tasks and closure commands.
  const occurrences = new Map<string, number>();
  const schedule = (app: string, parsed: ParsedFile, statement: Ast, scope: Scope, isSchedule: (root: Ast) => string | undefined, origin: Evidence[]) => {
    // The walk is pre-order: the outermost call of a chain comes first and reads all of it.
    const handled = new Set<Ast>();
    walk(statement, node => {
      if (node.kind !== 'call') return;
      const found = callChain(node);
      if (!found || handled.has(found.root)) return;
      const verb = isSchedule(found.root);
      if (!verb) return;
      handled.add(found.root);
      const rootArgs = args(found.root);
      const cadenceCalls: { name: string; args: string[] }[] = [], modifiers: string[] = [];
      let dynamicCadence = false;
      for (const call of found.chain) {
        if (CADENCE.test(call.name)) {
          const values = call.args.map(item => literal(item) ?? (item.kind === 'number' ? String(item.value) : undefined));
          if (values.some(value => value === undefined)) dynamicCadence = true;
          cadenceCalls.push({ name: call.name, args: values.filter((value): value is string => value !== undefined) });
        } else modifiers.push(call.name);
      }
      const cadence = cadenceCalls.length ? cadenceText(cadenceCalls) : 'every minute';
      let target: string | undefined, invoked: Entity | undefined, targetText = '';
      if (verb === 'command') {
        const line = literal(rootArgs[0]), fqn = classConstant(rootArgs[0], scope);
        invoked = line ? lookup.byName(app, line) : fqn ? lookup.byClass(app, fqn) : undefined;
        target = line ?? (fqn ? invoked?.name ?? fqn.split('\\').at(-1) : undefined);
        targetText = line ?? fqn ?? text(rootArgs[0], parsed);
      } else if (verb === 'job') {
        const created = ast(rootArgs[0]);
        const fqn = created?.kind === 'new' ? resolve(created.what, scope) : classConstant(rootArgs[0], scope);
        invoked = fqn ? handlerOf(app, fqn) : undefined;
        target = fqn?.split('\\').at(-1);
        targetText = fqn ?? text(rootArgs[0], parsed);
      } else if (verb === 'exec') { target = literal(rootArgs[0]); targetText = target ?? text(rootArgs[0], parsed); }
      else { target = 'closure'; targetText = 'closure'; }
      const label = target ?? targetText.slice(0, 60);
      const identity = `${verb}|${targetText}|${cadence}`;
      const occurrence = (occurrences.get(`${app}|${identity}`) ?? 0) + 1;
      occurrences.set(`${app}|${identity}`, occurrence);
      const appId = context.applicationIds.get(app);
      if (!appId) return;
      const facts = [...origin, fact(parsed, node, `Laravel scheduler: ${verb}(${targetText.slice(0, 80)}), ${cadence}`)];
      const entity = graph.contain({
        id: graph.id('schedule', app, identity, String(occurrence)), type: 'scheduled_task', name: label, path: parsed.file.path, parentId: appId,
        ...(node.loc ? { sourceRange: { startLine: node.loc.start.line, endLine: node.loc.end.line } } : {}),
        metadata: { framework: 'laravel', schedule: verb, target: targetText, cadence, ...(modifiers.length ? { modifiers } : {}), ...(dynamicCadence ? { cadenceDynamic: true } : {}), handlerKind: verb === 'call' ? 'closure' : verb === 'exec' ? 'external' : invoked ? 'command' : 'unresolved' },
        evidence: facts,
      });
      if (invoked) graph.relate(entity.id, invoked.id, 'invokes', [...facts, ...invoked.evidence], { schedule: verb, cadence });
      else if (verb === 'command' || verb === 'job') diagnose(parsed, node, 'unresolved-scheduled-task', `The scheduler runs ${targetText.slice(0, 80)}, which is not an indexed ${verb === 'command' ? 'command' : 'job with a handle() method'}`, entity.id);
    });
  };
  const facadeVerb = (scope: Scope) => (root: Ast): string | undefined => {
    const what = ast(root.what);
    if (what?.kind !== 'staticlookup') return undefined;
    const fqn = resolve(what.what, scope)?.toLowerCase();
    const verb = name(what.offset)?.toLowerCase();
    return (fqn === 'illuminate\\support\\facades\\schedule' || fqn === 'schedule') && verb && ['command', 'job', 'call', 'exec'].includes(verb) ? verb : undefined;
  };
  /** `$schedule->command(…)` where `$schedule` is a parameter typed with the scheduler. */
  const variableVerb = (variables: Set<string>) => (root: Ast): string | undefined => {
    const what = ast(root.what);
    if (what?.kind !== 'propertylookup') return undefined;
    const receiver = ast(what.what), verb = name(what.offset)?.toLowerCase();
    return receiver?.kind === 'variable' && variables.has(String(receiver.name)) && verb && ['command', 'job', 'call', 'exec'].includes(verb) ? verb : undefined;
  };
  const scheduleParameters = (fn: Ast, scope: Scope) => new Set(args(fn).filter(param => resolve(param.type, scope)?.toLowerCase() === SCHEDULE_CLASS).map(param => name(param.name)).filter((item): item is string => !!item));

  // Console route files: closure commands and the Schedule facade.
  for (const registration of registrations) {
    const parsed = parsedFiles.get(registration.file);
    if (!parsed) { graph.diagnose({ analyzer: 'php-laravel', severity: 'warning', code: 'console-routes-unavailable', file: registration.file, reason: 'Registered console route file is missing, ignored or unparseable' }); continue; }
    const visit = (children: Ast[], scope: Scope) => {
      for (const statement of children) {
        const expression = statement.kind === 'expressionstatement' ? ast(statement.expression) : undefined;
        if (!expression) continue;
        const found = expression.kind === 'call' ? callChain(expression) : undefined;
        const what = found ? ast(found.root.what) : undefined;
        const facade = what?.kind === 'staticlookup' ? resolve(what.what, scope)?.toLowerCase() : undefined;
        if (found && (facade === 'illuminate\\support\\facades\\artisan' || facade === 'artisan') && name(what!.offset)?.toLowerCase() === 'command') {
          const line = literal(args(found.root)[0]);
          if (!line) { diagnose(parsed, expression, 'dynamic-command-signature', 'Artisan::command() with a name that is not a literal'); continue; }
          const purpose = found.chain.find(call => ['purpose', 'describe'].includes(call.name.toLowerCase()));
          const description = purpose ? literal(purpose.args[0]) : undefined;
          declare(registration.app, line, parsed, expression, { handlerKind: 'closure', registration: 'console-route', ...(description ? { description } : {}) }, [...registration.facts, fact(parsed, expression, `Artisan::command('${commandName(line)}') registers a closure command`)]);
          continue;
        }
        schedule(registration.app, parsed, statement, scope, facadeVerb(scope), registration.facts);
      }
    };
    scopedChildren(parsed.ast, { namespace: '', imports: new Map() }, visit);
  }
  // bootstrap/app.php withSchedule(fn (Schedule $schedule) => …) and the console Kernel's schedule().
  for (const app of context.config.applications.filter(item => item.type === 'laravel')) {
    const bootstrap = parsedFiles.get(path.posix.join(app.path === '.' ? '' : app.path, 'bootstrap/app.php'));
    if (bootstrap) scopedChildren(bootstrap.ast, { namespace: '', imports: new Map() }, (children, scope) => {
      for (const statement of children) walk(statement, node => {
        const what = ast(node.what);
        if (node.kind !== 'call' || what?.kind !== 'propertylookup' || name(what.offset) !== 'withSchedule') return;
        const closure = args(node)[0];
        if (!closure || (closure.kind !== 'closure' && closure.kind !== 'arrowfunc')) return;
        const variables = scheduleParameters(closure, scope);
        if (variables.size) schedule(app.name, bootstrap, closure, scope, variableVerb(variables), [fact(bootstrap, node, 'withSchedule() defines scheduled tasks')]);
      });
    });
  }
  for (const phpClass of classes.values()) {
    if (!classChain(classes, phpClass.app, phpClass.fqn).includes(CONSOLE_KERNEL)) continue;
    for (const method of nodes(phpClass.node.body)) {
      if (method.kind !== 'method' || name(method.name) !== 'schedule') continue;
      const variables = scheduleParameters(method, phpClass.scope);
      if (variables.size) schedule(phpClass.app, phpClass.parsed, method, phpClass.scope, variableVerb(variables), [fact(phpClass.parsed, method, 'The console Kernel schedule() method defines scheduled tasks')]);
    }
  }
  return lookup;
}
