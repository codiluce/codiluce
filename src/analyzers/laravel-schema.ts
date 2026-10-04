// Database tables of a Laravel application, from its migrations, and the
// Eloquent models that map to them.
//
// Migrations in `database/migrations/*.php` are replayed in filename order
// (the order Laravel runs them), reading only `up()`: `Schema::create`,
// `Schema::table`, `Schema::rename`, `Schema::drop`/`dropIfExists`, optionally
// through `Schema::connection('…')`, with the Blueprint closure's columns,
// column changes, renames, drops and foreign keys. The result is the schema
// the migrations *declare*; it is never presented as the live database.
// Non-literal table names, raw SQL and unknown Blueprint calls are reported,
// not guessed.
//
// Models map to tables by an explicit `protected $table = '…'` (declared on
// the model or inherited from an indexed parent) or, failing that, by the
// framework convention (snake_case, plural of the last word), which the
// evidence says. A mapping is linked only to a table the migrations declare.
import path from 'node:path';
import type { AnalysisContext } from '../core/analyzer.js';
import type { Entity, Evidence } from '../core/graph.js';
import { evidence } from '../core/graph.js';
import { args, ast, classConstant, literal, name, nodes, resolve, scopedChildren, text, type Ast, type ParsedFile, type Scope } from './php-ast.js';
import { classChain, isEloquentModel, type PhpClass, type TableLookup } from './php-references.js';
import { MAX_SITE_EVIDENCE } from './references.js';

export interface TableColumn { name: string; type: string; nullable?: boolean; unique?: boolean; primary?: boolean; default?: string }
export interface ForeignKey { column: string; table: string; references: string; onDelete?: string }
export interface TableOperation { file: string; operation: 'create' | 'alter' | 'rename'; line: number; endLine?: number }
export interface TableDefinition {
  name: string; connection?: string;
  columns: TableColumn[]; foreignKeys: (ForeignKey & { evidence: Evidence })[];
  /** Where the table was created; absent when migrations only alter a table created elsewhere. */
  created?: { file: string; line: number; endLine: number };
  operations: TableOperation[]; previousNames: string[];
  /** A column or foreign key was declared inside a condition (e.g. `if (!Schema::hasColumn(…))`). */
  conditional: boolean;
  evidence: Evidence[];
}
export interface SchemaDiagnostic { file: string; line?: number; code: string; reason: string; severity: 'info' | 'warning' }

const SCHEMA_FACADE = 'illuminate\\support\\facades\\schema';
const NO_NAME_COLUMNS: Record<string, { name: string; type: string; nullable?: boolean }[]> = {
  timestamps: [{ name: 'created_at', type: 'timestamp', nullable: true }, { name: 'updated_at', type: 'timestamp', nullable: true }],
  timestampstz: [{ name: 'created_at', type: 'timestampTz', nullable: true }, { name: 'updated_at', type: 'timestampTz', nullable: true }],
  nullabletimestamps: [{ name: 'created_at', type: 'timestamp', nullable: true }, { name: 'updated_at', type: 'timestamp', nullable: true }],
  remembertoken: [{ name: 'remember_token', type: 'string', nullable: true }],
};
/** Column methods whose name argument is optional, with Laravel's default. */
const DEFAULT_NAMES: Record<string, string> = { id: 'id', softdeletes: 'deleted_at', softdeletestz: 'deleted_at' };
const COLUMN_TYPES = new Set([
  'id', 'increments', 'tinyincrements', 'smallincrements', 'mediumincrements', 'bigincrements', 'integerincrements',
  'char', 'string', 'tinytext', 'text', 'mediumtext', 'longtext', 'integer', 'tinyinteger', 'smallinteger', 'mediuminteger', 'biginteger',
  'unsignedinteger', 'unsignedtinyinteger', 'unsignedsmallinteger', 'unsignedmediuminteger', 'unsignedbiginteger', 'float', 'double', 'decimal',
  'unsigneddecimal', 'boolean', 'enum', 'set', 'json', 'jsonb', 'date', 'datetime', 'datetimetz', 'time', 'timetz', 'timestamp', 'timestamptz',
  'year', 'binary', 'uuid', 'ulid', 'ipaddress', 'macaddress', 'geometry', 'geography', 'point', 'linestring', 'polygon', 'multipoint',
  'foreignid', 'foreignuuid', 'foreignulid', 'softdeletes', 'softdeletestz', 'vector', 'computed',
]);
const MORPHS = new Set(['morphs', 'nullablemorphs', 'uuidmorphs', 'nullableuuidmorphs', 'ulidmorphs', 'nullableulidmorphs']);
/** Blueprint calls that change nothing this extraction records. */
const IGNORED = new Set(['index', 'unique', 'primary', 'fulltext', 'spatialindex', 'rawindex', 'dropindex', 'dropunique', 'dropprimary', 'dropfulltext', 'dropspatialindex', 'renameindex', 'engine', 'charset', 'collation', 'comment', 'temporary']);

/** Laravel's `Str::plural` for the common English cases (Doctrine inflector rules, abridged). */
const UNCOUNTABLE = new Set(['audio', 'compensation', 'data', 'deer', 'education', 'emoji', 'equipment', 'evidence', 'feedback', 'firmware', 'fish', 'furniture', 'gold', 'hardware', 'information', 'kin', 'knowledge', 'love', 'metadata', 'money', 'moose', 'news', 'nutrition', 'offspring', 'plankton', 'police', 'rain', 'recommended', 'related', 'rice', 'series', 'sheep', 'software', 'species', 'swine', 'traffic', 'wheat', 'cattle']);
const IRREGULAR: Record<string, string> = { person: 'people', man: 'men', woman: 'women', child: 'children', tooth: 'teeth', foot: 'feet', mouse: 'mice', goose: 'geese', ox: 'oxen', criterion: 'criteria', leaf: 'leaves', life: 'lives', medium: 'media', index: 'indices', matrix: 'matrices', vertex: 'vertices', status: 'statuses', alias: 'aliases', quiz: 'quizzes', bus: 'buses', hero: 'heroes', potato: 'potatoes', tomato: 'tomatoes', echo: 'echoes' };
export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (IRREGULAR[lower]) return IRREGULAR[lower]!;
  if (/(?:[^aeiouy]|qu)y$/.test(lower)) return `${word.slice(0, -1)}ies`;
  if (/(?:x|ch|ss|sh|zz)$/.test(lower)) return `${word}es`;
  if (/sis$/.test(lower)) return `${word.slice(0, -2)}es`;
  if (/(?:[^f])fe$/.test(lower)) return `${word.slice(0, -2)}ves`;
  if (/(?:[lr])f$/.test(lower)) return `${word.slice(0, -1)}ves`;
  if (/(?:us)$/.test(lower)) return `${word}es`;
  return `${word}s`;
}
/** `UserCard` → `user_cards`: what `Model::getTable()` returns without an explicit `$table`. */
export function conventionTable(className: string): string {
  const words = className.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().split('_').filter(Boolean);
  if (!words.length) return className.toLowerCase();
  words[words.length - 1] = pluralize(words.at(-1)!);
  return words.join('_');
}
/** `user_id` → `users`: the table `foreignId('user_id')->constrained()` references. */
function constrainedTable(column: string, referenced = 'id'): string {
  const suffix = `_${referenced}`;
  const base = column.endsWith(suffix) ? column.slice(0, -suffix.length) : column;
  const words = base.split('_');
  words[words.length - 1] = pluralize(words.at(-1)!);
  return words.join('_');
}

interface Call { name: string; args: Ast[]; node: Ast }
/** `$table->string('x')->nullable()->unique()` → root call and the modifiers chained on it. */
function blueprintChain(node: Ast, variable: string): { root: Call; modifiers: Call[] } | undefined {
  const calls: Call[] = [];
  let current: Ast | undefined = node;
  while (current?.kind === 'call') {
    const what = ast(current.what);
    if (what?.kind !== 'propertylookup' && what?.kind !== 'nullsafepropertylookup') return undefined;
    const method = name(what.offset);
    if (!method) return undefined;
    calls.unshift({ name: method.toLowerCase(), args: args(current), node: current });
    const receiver = ast(what.what);
    if (receiver?.kind === 'variable') return receiver.name === variable ? { root: calls[0]!, modifiers: calls.slice(1) } : undefined;
    current = receiver;
  }
  return undefined;
}
function scalar(value: Ast | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'string') return String(value.value);
  if (value.kind === 'number') return String(value.value);
  if (value.kind === 'boolean') return value.value ? 'true' : 'false';
  if (value.kind === 'nullkeyword') return 'null';
  return undefined;
}
function stringList(value: Ast | undefined): string[] | undefined {
  if (!value) return undefined;
  if (value.kind === 'string') return [String(value.value)];
  if (value.kind === 'array') { const items = nodes(value.items).map(item => literal(item.value)); return items.every((item): item is string => item !== undefined) ? items : undefined; }
  return undefined;
}

/** Replay the migrations of one application. Files must belong to it; order is by file name. */
export function extractSchema(files: ParsedFile[], analyzer: string): { tables: Map<string, TableDefinition>; diagnostics: SchemaDiagnostic[] } {
  const tables = new Map<string, TableDefinition>();
  const diagnostics: SchemaDiagnostic[] = [];
  const ordered = [...files].sort((a, b) => path.posix.basename(a.file.path) < path.posix.basename(b.file.path) ? -1 : path.posix.basename(a.file.path) > path.posix.basename(b.file.path) ? 1 : 0);
  for (const parsed of ordered) {
    const file = parsed.file.path;
    const diagnose = (node: Ast | undefined, code: string, reason: string, severity: 'info' | 'warning' = 'warning') => diagnostics.push({ file, ...(node?.loc ? { line: node.loc.start.line } : {}), code, reason, severity });
    const fact = (node: Ast, explanation: string): Evidence => ({ ...evidence('framework', analyzer, file, node.loc?.start.line, explanation), ...(node.loc ? { endLine: node.loc.end.line } : {}) });
    const ups: { method: Ast; scope: Scope }[] = [];
    scopedChildren(parsed.ast, { namespace: '', imports: new Map() }, (children, scope) => {
      const visit = (node: Ast): void => {
        if (node.kind === 'method' && name(node.name)?.toLowerCase() === 'up') { ups.push({ method: node, scope }); return; }
        for (const [key, value] of Object.entries(node)) {
          if (key === 'loc' || key.endsWith('Comments') || key === 'comments') continue;
          if (Array.isArray(value)) for (const child of nodes(value)) visit(child); else { const child = ast(value); if (child) visit(child); }
        }
      };
      for (const child of children) visit(child);
    });
    if (!ups.length) { diagnose(undefined, 'migration-without-up', 'No up() method: this migration declares no schema change that can be read', 'info'); continue; }
    for (const { method, scope } of ups) {
      const isSchema = (what: unknown) => { const resolved = resolve(what, scope)?.toLowerCase(); return resolved === SCHEMA_FACADE || (resolved === 'schema' && !scope.namespace); };
      /** `Schema::x(…)` or `Schema::connection('c')->x(…)`: operation, arguments and connection. */
      const schemaCall = (node: Ast): { operation: string; args: Ast[]; connection?: string } | undefined => {
        if (node.kind !== 'call') return undefined;
        const what = ast(node.what);
        if (what?.kind === 'staticlookup' && isSchema(what.what)) { const operation = name(what.offset)?.toLowerCase(); return operation ? { operation, args: args(node) } : undefined; }
        if (what?.kind === 'propertylookup') {
          const receiver = ast(what.what), operation = name(what.offset)?.toLowerCase();
          const inner = receiver ? schemaCall(receiver) : undefined;
          if (inner?.operation === 'connection' && operation) return { operation, args: args(node), ...(literal(inner.args[0]) ? { connection: literal(inner.args[0]) } : {}) };
        }
        return undefined;
      };
      const visit = (node: Ast, conditional: boolean): void => {
        const call = schemaCall(node);
        if (call && !['connection', 'hascolumn', 'hascolumns', 'hastable', 'hasindex', 'getcolumnlisting', 'disableforeignkeyconstraints', 'enableforeignkeyconstraints', 'withoutforeignkeyconstraints', 'defaultstringlength'].includes(call.operation)) { operation(node, call, conditional); return; }
        const nested = conditional || node.kind === 'if' || node.kind === 'switch' || node.kind === 'retif' || node.kind === 'for' || node.kind === 'foreach' || node.kind === 'while' || node.kind === 'try';
        for (const [key, value] of Object.entries(node)) {
          if (key === 'loc' || key.endsWith('Comments') || key === 'comments') continue;
          if (Array.isArray(value)) for (const child of nodes(value)) visit(child, nested); else { const child = ast(value); if (child) visit(child, nested); }
        }
      };
      const operation = (node: Ast, call: { operation: string; args: Ast[]; connection?: string }, conditional: boolean): void => {
        const tableName = literal(call.args[0]);
        const line = node.loc?.start.line ?? method.loc?.start.line ?? 1, endLine = node.loc?.end.line;
        if (call.operation === 'rename') {
          const to = literal(call.args[1]);
          if (tableName === undefined || to === undefined) { diagnose(node, 'dynamic-migration-table', 'Schema::rename with a table name that is not a literal'); return; }
          const table = tables.get(tableName);
          if (!table) { diagnose(node, 'migration-unknown-table', `Schema::rename('${tableName}', '${to}'): no earlier migration declares ${tableName}`, 'info'); return; }
          tables.delete(tableName);
          table.previousNames.push(tableName); table.name = to;
          table.operations.push({ file, operation: 'rename', line, ...(endLine ? { endLine } : {}) });
          table.evidence.push(fact(node, `Schema::rename('${tableName}', '${to}') in ${path.posix.basename(file)}`));
          tables.set(to, table);
          return;
        }
        if (call.operation === 'drop' || call.operation === 'dropifexists') {
          if (tableName === undefined) { diagnose(node, 'dynamic-migration-table', `Schema::${call.operation} with a table name that is not a literal`); return; }
          tables.delete(tableName);
          return;
        }
        if (call.operation === 'dropcolumns' || call.operation === 'dropcolumn') {
          const table = tableName !== undefined ? tables.get(tableName) : undefined;
          const columns = stringList(call.args[1]);
          if (table && columns) table.columns = table.columns.filter(column => !columns.includes(column.name));
          return;
        }
        if (call.operation === 'dropalltables') { tables.clear(); return; }
        if (call.operation !== 'create' && call.operation !== 'table' && call.operation !== 'createifnotexists') { diagnose(node, 'unsupported-schema-operation', `Schema::${name(ast(ast(node.what)?.offset)) ?? call.operation} is not read by the migration extraction`, 'info'); return; }
        if (tableName === undefined) { diagnose(node, 'dynamic-migration-table', `Schema::${call.operation} with a table name that is not a literal (${text(call.args[0], parsed).slice(0, 60)})`); return; }
        let table = tables.get(tableName);
        const creates = call.operation !== 'table';
        if (creates && table && call.operation === 'create') diagnose(node, 'duplicate-table-create', `Schema::create('${tableName}') runs again without an earlier drop; the declarations are merged`, 'info');
        if (!table) {
          table = { name: tableName, columns: [], foreignKeys: [], operations: [], previousNames: [], conditional: false, evidence: [], ...(call.connection ? { connection: call.connection } : {}) };
          tables.set(tableName, table);
        }
        if (creates && !table.created) table.created = { file, line, endLine: endLine ?? line };
        table.operations.push({ file, operation: creates ? 'create' : 'alter', line, ...(endLine ? { endLine } : {}) });
        table.evidence.push(fact(node, `Schema::${creates ? 'create' : 'table'}('${tableName}') in ${path.posix.basename(file)}${creates ? '' : ' alters the table'}; migrations declare the intended schema, not the live database`));
        if (conditional) table.conditional = true;
        const closure = call.args[1];
        if (!closure || (closure.kind !== 'closure' && closure.kind !== 'arrowfunc')) { if (closure) diagnose(node, 'dynamic-blueprint', `The Blueprint of ${tableName} is not a closure`, 'info'); return; }
        const variable = ast(args(closure)[0]?.name)?.name ?? name(args(closure)[0]?.name);
        if (typeof variable !== 'string') return;
        const body = closure.kind === 'arrowfunc' ? [ast(closure.body)!].filter(Boolean) : nodes(ast(closure.body)?.children);
        blueprint(table, body, variable, conditional);
      };
      const blueprint = (table: TableDefinition, statements: Ast[], variable: string, conditional: boolean): void => {
        const each = (node: Ast, nested: boolean): void => {
          const expression = node.kind === 'expressionstatement' ? ast(node.expression) : node;
          const chain = expression ? blueprintChain(expression, variable) : undefined;
          if (chain) { column(table, chain, nested); return; }
          const branch = nested || node.kind === 'if' || node.kind === 'foreach' || node.kind === 'for' || node.kind === 'switch' || node.kind === 'retif';
          for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key.endsWith('Comments') || key === 'comments') continue;
            if (Array.isArray(value)) for (const child of nodes(value)) each(child, branch); else { const child = ast(value); if (child && child.kind !== 'closure' && child.kind !== 'arrowfunc') each(child, branch); }
          }
        };
        for (const statement of statements) each(statement, conditional);
      };
      const column = (table: TableDefinition, chain: { root: Call; modifiers: Call[] }, conditional: boolean): void => {
        const { root, modifiers } = chain;
        const has = (modifier: string) => modifiers.find(item => item.name === modifier);
        if (conditional) table.conditional = true;
        const upsert = (definition: TableColumn) => {
          const index = table.columns.findIndex(item => item.name === definition.name);
          if (index >= 0) table.columns[index] = { ...(has('change') ? {} : table.columns[index]), ...definition };
          else table.columns.push(definition);
        };
        if (root.name === 'dropcolumn' || root.name === 'dropcolumns') { const names = root.args.flatMap(arg => stringList(arg) ?? []); table.columns = table.columns.filter(item => !names.includes(item.name)); table.foreignKeys = table.foreignKeys.filter(item => !names.includes(item.column)); return; }
        if (root.name === 'renamecolumn') {
          const from = literal(root.args[0]), to = literal(root.args[1]);
          if (from !== undefined && to !== undefined) { for (const item of table.columns) if (item.name === from) item.name = to; for (const key of table.foreignKeys) if (key.column === from) key.column = to; }
          return;
        }
        if (root.name === 'droptimestamps' || root.name === 'droptimestampstz') { table.columns = table.columns.filter(item => item.name !== 'created_at' && item.name !== 'updated_at'); return; }
        if (root.name === 'dropsoftdeletes' || root.name === 'dropsoftdeletestz') { const target = literal(root.args[0]) ?? 'deleted_at'; table.columns = table.columns.filter(item => item.name !== target); return; }
        if (root.name === 'dropremembertoken') { table.columns = table.columns.filter(item => item.name !== 'remember_token'); return; }
        if (root.name === 'dropmorphs') { const base = literal(root.args[0]); if (base) table.columns = table.columns.filter(item => item.name !== `${base}_type` && item.name !== `${base}_id`); return; }
        if (root.name === 'dropforeign' || root.name === 'dropconstrainedforeignid') {
          const names = stringList(root.args[0]);
          if (names && root.args[0]?.kind === 'array') table.foreignKeys = table.foreignKeys.filter(item => !names.includes(item.column));
          else if (names) table.foreignKeys = table.foreignKeys.filter(item => !names.some(value => value === item.column || value === `${table.name}_${item.column}_foreign`));
          if (root.name === 'dropconstrainedforeignid' && names) table.columns = table.columns.filter(item => !names.includes(item.name));
          return;
        }
        if (root.name === 'foreign') {
          const columns = stringList(root.args[0]);
          const on = literal(has('on')?.args[0]), references = stringList(has('references')?.args[0])?.[0] ?? 'id';
          if (!columns?.length || on === undefined) { diagnose(root.node, 'unresolved-foreign-key', `Foreign key on ${table.name} without a literal column and ->on('table')`, 'info'); return; }
          table.foreignKeys.push({ column: columns[0]!, table: on, references, ...(onDelete(modifiers) ? { onDelete: onDelete(modifiers) } : {}), evidence: fact(root.node, `Foreign key ${table.name}.${columns[0]} → ${on}.${references}`) });
          return;
        }
        if (IGNORED.has(root.name)) return;
        if (NO_NAME_COLUMNS[root.name]) { for (const definition of NO_NAME_COLUMNS[root.name]!) upsert({ ...definition }); return; }
        if (MORPHS.has(root.name)) {
          const base = literal(root.args[0]);
          if (!base) return;
          const nullable = root.name.startsWith('nullable');
          upsert({ name: `${base}_type`, type: 'string', ...(nullable ? { nullable } : {}) });
          upsert({ name: `${base}_id`, type: root.name.includes('uuid') ? 'uuid' : root.name.includes('ulid') ? 'ulid' : 'unsignedBigInteger', ...(nullable ? { nullable } : {}) });
          return;
        }
        if (root.name === 'foreignidfor') {
          const model = classConstant(root.args[0], scope);
          const columnName = literal(root.args[1]) ?? (model ? `${model.split('\\').at(-1)!.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()}_id` : undefined);
          if (!columnName) { diagnose(root.node, 'unresolved-foreign-key', `foreignIdFor on ${table.name} without a resolvable model`, 'info'); return; }
          upsert({ name: columnName, type: 'foreignId', ...(has('nullable') ? { nullable: true } : {}) });
          const constrained = has('constrained');
          if (constrained && model) table.foreignKeys.push({ column: columnName, table: literal(constrained.args[0]) ?? conventionTable(model.split('\\').at(-1)!), references: literal(constrained.args[1]) ?? 'id', ...(onDelete(modifiers) ? { onDelete: onDelete(modifiers) } : {}), evidence: fact(root.node, `Foreign key ${table.name}.${columnName} → ${model.split('\\').at(-1)} (foreignIdFor)`) });
          return;
        }
        if (!COLUMN_TYPES.has(root.name)) { diagnose(root.node, 'unsupported-blueprint-call', `$${variableName(root)}->${root.name}() on ${table.name} is not read by the migration extraction`, 'info'); return; }
        const columnName = literal(root.args[0]) ?? DEFAULT_NAMES[root.name];
        if (columnName === undefined) { diagnose(root.node, 'dynamic-migration-column', `A ${root.name} column of ${table.name} has no literal name`, 'info'); return; }
        const defaultValue = has('default') ? scalar(has('default')!.args[0]) ?? text(has('default')!.args[0], parsed).slice(0, 40) : undefined;
        upsert({
          name: columnName, type: TYPE_NAMES[root.name] ?? root.name,
          ...(has('nullable') && literal(has('nullable')!.args[0]) !== 'false' && scalar(has('nullable')!.args[0]) !== 'false' ? { nullable: true } : root.name === 'softdeletes' || root.name === 'softdeletestz' ? { nullable: true } : {}),
          ...(has('unique') ? { unique: true } : {}),
          ...(has('primary') || ['id', 'increments', 'bigincrements', 'tinyincrements', 'smallincrements', 'mediumincrements', 'integerincrements'].includes(root.name) ? { primary: true } : {}),
          ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        });
        const constrained = has('constrained');
        if (constrained && (root.name === 'foreignid' || root.name === 'foreignuuid' || root.name === 'foreignulid' || root.name === 'unsignedbiginteger')) {
          const referenced = literal(constrained.args[1]) ?? 'id';
          const target = literal(constrained.args[0]) ?? constrainedTable(columnName, referenced);
          table.foreignKeys.push({ column: columnName, table: target, references: referenced, ...(onDelete(modifiers) ? { onDelete: onDelete(modifiers) } : {}), evidence: fact(root.node, `Foreign key ${table.name}.${columnName} → ${target}.${referenced}${literal(constrained.args[0]) ? '' : ' (table guessed by the constrained() convention)'}`) });
        } else if (has('references') && has('on')) {
          const on = literal(has('on')!.args[0]), references = literal(has('references')!.args[0]) ?? 'id';
          if (on) table.foreignKeys.push({ column: columnName, table: on, references, ...(onDelete(modifiers) ? { onDelete: onDelete(modifiers) } : {}), evidence: fact(root.node, `Foreign key ${table.name}.${columnName} → ${on}.${references}`) });
        }
      };
      const variableName = (call: Call) => { let current: Ast | undefined = call.node; while (current?.kind === 'call') current = ast(ast(current.what)?.what); return current?.kind === 'variable' ? String(current.name) : 'table'; };
      for (const statement of nodes(ast(method.body)?.children)) visit(statement, false);
    }
  }
  for (const table of tables.values()) if (!table.created) diagnostics.push({ file: table.operations[0]!.file, line: table.operations[0]!.line, code: 'table-created-elsewhere', severity: 'info', reason: `Migrations alter ${table.name} but none creates it (an older schema dump, a package or another application may)` });
  return { tables, diagnostics };
}
const TYPE_NAMES: Record<string, string> = {
  id: 'bigIncrements', increments: 'increments', bigincrements: 'bigIncrements', tinyincrements: 'tinyIncrements', smallincrements: 'smallIncrements', mediumincrements: 'mediumIncrements', integerincrements: 'increments',
  tinytext: 'tinyText', mediumtext: 'mediumText', longtext: 'longText', tinyinteger: 'tinyInteger', smallinteger: 'smallInteger', mediuminteger: 'mediumInteger', biginteger: 'bigInteger',
  unsignedinteger: 'unsignedInteger', unsignedtinyinteger: 'unsignedTinyInteger', unsignedsmallinteger: 'unsignedSmallInteger', unsignedmediuminteger: 'unsignedMediumInteger', unsignedbiginteger: 'unsignedBigInteger',
  unsigneddecimal: 'unsignedDecimal', datetime: 'dateTime', datetimetz: 'dateTimeTz', timetz: 'timeTz', timestamptz: 'timestampTz', ipaddress: 'ipAddress', macaddress: 'macAddress', linestring: 'lineString',
  multipoint: 'multiPoint', foreignid: 'foreignId', foreignuuid: 'foreignUuid', foreignulid: 'foreignUlid', softdeletes: 'timestamp', softdeletestz: 'timestampTz',
};
function onDelete(modifiers: Call[]): string | undefined {
  for (const modifier of modifiers) {
    if (modifier.name === 'ondelete') return literal(modifier.args[0]);
    if (modifier.name === 'cascadeondelete') return 'cascade';
    if (modifier.name === 'nullondelete') return 'set null';
    if (modifier.name === 'restrictondelete') return 'restrict';
    if (modifier.name === 'noactionondelete') return 'no action';
  }
  return undefined;
}

/**
 * Declare the tables of every Laravel application (`database_table` entities,
 * children of the application), their foreign keys, and the models that map to
 * them. Eloquent models (an `extends` chain reaching an Eloquent base) become
 * `model` entities. Returns the lookup call resolution uses for table reads and writes.
 */
export function declareTables(context: AnalysisContext, parsedFiles: Map<string, ParsedFile>, classes: Map<string, PhpClass>): TableLookup {
  const { graph } = context;
  const analyzer = 'php-laravel';
  const byApp = new Map<string, Map<string, Entity>>();
  const models = new Map<string, Entity>();
  for (const app of context.config.applications.filter(item => item.type === 'laravel')) {
    const appId = context.applicationIds.get(app.name);
    if (!appId) continue;
    const prefix = app.path === '.' ? '' : `${app.path}/`;
    const migrations = [...parsedFiles.values()].filter(parsed => parsed.file.application?.name === app.name && /^database\/migrations\/[^/]+\.php$/.test(parsed.file.path.slice(prefix.length)));
    const { tables, diagnostics } = extractSchema(migrations, analyzer);
    for (const item of diagnostics) graph.diagnose({ analyzer, severity: item.severity, code: item.code, reason: item.reason, file: item.file, ...(item.line ? { line: item.line } : {}), ...(context.files.get(item.file) ? { entityId: context.files.get(item.file)!.id } : {}) });
    const entities = new Map<string, Entity>();
    byApp.set(app.name, entities);
    for (const table of [...tables.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const anchor = table.created ?? table.operations[0]!;
      entities.set(table.name, graph.contain({
        id: graph.id('table', app.name, table.name), type: 'database_table', name: table.name, path: anchor.file, parentId: appId,
        sourceRange: { startLine: anchor.line, endLine: anchor.endLine ?? anchor.line },
        metadata: {
          declaredBy: 'migrations', origin: table.created ? 'created' : 'altered',
          columns: table.columns, foreignKeys: table.foreignKeys.map(({ evidence: _evidence, ...key }) => key),
          migrations: [...new Set(table.operations.map(operation => operation.file))],
          ...(table.connection ? { connection: table.connection } : {}), ...(table.previousNames.length ? { previousNames: table.previousNames } : {}), ...(table.conditional ? { conditional: true } : {}),
        },
        evidence: table.evidence.slice(0, MAX_SITE_EVIDENCE),
      }));
    }
    // Foreign keys: one relation per pair of tables, every key column as evidence.
    for (const table of tables.values()) {
      const from = entities.get(table.name)!;
      const grouped = new Map<string, { target: Entity; keys: TableDefinition['foreignKeys'] }>();
      for (const key of table.foreignKeys) {
        const target = entities.get(key.table);
        if (!target) { graph.diagnose({ analyzer, severity: 'info', code: 'foreign-key-target-not-indexed', reason: `${table.name}.${key.column} references ${key.table}, which no indexed migration declares`, ...(key.evidence.file ? { file: key.evidence.file } : {}), ...(key.evidence.line ? { line: key.evidence.line } : {}), entityId: from.id }); continue; }
        const group = grouped.get(target.id) ?? { target, keys: [] };
        group.keys.push(key); grouped.set(target.id, group);
      }
      for (const { target, keys } of grouped.values()) graph.relate(from.id, target.id, 'foreign_key', keys.map(key => key.evidence), { columns: keys.map(key => ({ column: key.column, references: key.references, ...(key.onDelete ? { onDelete: key.onDelete } : {}) })) });
    }
    // Models and the tables they map to.
    for (const phpClass of classes.values()) {
      if (phpClass.app !== app.name || phpClass.node.isAbstract || !isEloquentModel(classes, app.name, phpClass.fqn)) continue;
      if (phpClass.entity.type === 'class') phpClass.entity.type = 'model';
      const declared = declaredTable(classes, app.name, phpClass);
      const file = phpClass.parsed.file;
      if (declared === 'custom') { graph.diagnose({ analyzer, severity: 'info', code: 'custom-model-table', reason: `${phpClass.fqn} overrides getTable() or sets $table dynamically; its table is not inferred`, file: file.path, entityId: phpClass.entity.id, ...(phpClass.node.loc ? { line: phpClass.node.loc.start.line } : {}) }); continue; }
      const tableName = declared?.value ?? conventionTable(phpClass.entity.name);
      const target = entities.get(tableName);
      if (!target) { graph.diagnose({ analyzer, severity: 'info', code: 'model-table-not-indexed', reason: `${phpClass.fqn} maps to table ${tableName} (${declared ? 'its $table property' : 'Laravel naming convention'}), which no indexed migration declares`, file: file.path, entityId: phpClass.entity.id, ...(phpClass.node.loc ? { line: phpClass.node.loc.start.line } : {}) }); continue; }
      models.set(`${app.name}:${phpClass.fqn.toLowerCase()}`, target);
      const facts: Evidence[] = declared
        ? [{ ...evidence('php', analyzer, declared.file, declared.line, `protected $table = '${tableName}'${declared.inherited ? ` (inherited from ${declared.inherited})` : ''}`), ...(declared.endLine ? { endLine: declared.endLine } : {}) }]
        : [evidence('framework', analyzer, file.path, phpClass.node.loc?.start.line, `Laravel naming convention: ${phpClass.entity.name} → ${tableName} (snake_case, plural); the model declares no $table`)];
      graph.relate(phpClass.entity.id, target.id, 'maps_to', facts, { table: tableName, mapping: declared ? 'property' : 'convention' });
    }
  }
  return { model: (app, fqn) => models.get(`${app}:${fqn.toLowerCase()}`), named: (app, table) => byApp.get(app)?.get(table) };
}
/** The `$table` a model declares or inherits from an indexed parent; `custom` when `getTable()` is overridden or `$table` is not a literal. */
function declaredTable(classes: Map<string, PhpClass>, app: string, model: PhpClass): { value: string; file: string; line?: number; endLine?: number; inherited?: string } | 'custom' | undefined {
  for (const ancestor of classChain(classes, app, model.fqn)) {
    const info = classes.get(`${app}:${ancestor}`);
    if (!info) return undefined;
    for (const item of nodes(info.node.body)) {
      if (item.kind === 'method' && name(item.name)?.toLowerCase() === 'gettable') return 'custom';
      if (item.kind !== 'propertystatement' || item.isStatic) continue;
      for (const property of nodes(item.properties)) {
        if (name(property.name) !== 'table') continue;
        const value = literal(property.value);
        if (value === undefined) return 'custom';
        return { value, file: info.parsed.file.path, ...(item.loc ? { line: item.loc.start.line, endLine: item.loc.end.line } : {}), ...(info !== model ? { inherited: info.fqn } : {}) };
      }
    }
  }
  return undefined;
}
