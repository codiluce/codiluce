// Generated from Codiluce’s typed source-only parser. Do not edit.
// Rebuild: npm run build:native-worker

// src/analysis/tree-sitter/worker.ts
import { Parser, Language, Query } from "web-tree-sitter";
import { serialize } from "node:v8";

// src/analysis/tree-sitter/grammars.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
var GRAMMAR_ROOT = new URL("../../../grammars/", import.meta.url);
var manifestText = "";
var manifestError;
var manifest = { format: 1, runtime: { package: "web-tree-sitter", version: "unavailable" }, grammars: [] };
try {
  manifestText = readFileSync(new URL("manifest.json", GRAMMAR_ROOT), "utf8");
  const parsed = JSON.parse(manifestText);
  if (parsed.format !== 1 || !Array.isArray(parsed.grammars) || typeof parsed.runtime?.version !== "string" || !parsed.grammars.every((grammar) => grammar && ["language", "file", "sha256", "source", "sourceRevision", "artifactPackage", "artifactVersion", "artifactPath", "license", "licenseFile"].every((key) => typeof grammar[key] === "string") && Number.isInteger(grammar.abi))) throw new Error("Unsupported grammar manifest format");
  manifest = parsed;
} catch (error) {
  manifestError = `Structural grammar catalog unavailable: ${error instanceof Error ? error.message : String(error)}`;
}
var grammarManifest = manifest;
var grammarCatalog = new Map(grammarManifest.grammars.map((grammar) => [grammar.language, grammar]));
function grammarFile(grammar) {
  return fileURLToPath(new URL(grammar.file, GRAMMAR_ROOT));
}
function queryText(language) {
  if (!grammarCatalog.has(language)) throw new Error(`Unsupported structural language: ${language}`);
  return readFileSync(new URL(`queries/${language}/declarations.scm`, GRAMMAR_ROOT), "utf8");
}
function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}
var GRAMMAR_CATALOG_VERSION = hashText(manifestText + [...grammarCatalog.keys()].sort().map((language) => {
  try {
    return queryText(language);
  } catch {
    return `${language}:query-unavailable`;
  }
}).join("\0")).slice(0, 16);
function verifiedGrammar(grammar) {
  const bytes = readFileSync(grammarFile(grammar));
  if (createHash("sha256").update(bytes).digest("hex") !== grammar.sha256) throw new Error(`Grammar checksum mismatch: ${grammar.language}`);
  return bytes;
}

// src/analysis/source-map.ts
var SourceText = class {
  constructor(text) {
    this.text = text;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      } else if (code === 10 || code === 8232 || code === 8233) this.starts.push(i + 1);
    }
  }
  text;
  starts = [0];
  position(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.text.length) throw new Error("Source offset outside text");
    let low = 0, high = this.starts.length;
    while (low + 1 < high) {
      const mid = low + high >>> 1;
      if (this.starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { line: low + 1, column: offset - this.starts[low] + 1 };
  }
  range(start, end) {
    if (end < start) throw new Error("Source range is reversed");
    const from = this.position(start), to = this.position(end);
    return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
  }
  region(start, end) {
    this.range(start, end);
    return { text: this.text.slice(start, end), start, end, range: (from, to) => {
      if (from < 0 || to < from || to > end - start) throw new Error("Region range outside source");
      return this.range(start + from, start + to);
    } };
  }
};

// src/analysis/tree-sitter/python-imports.ts
var MAX_NODES = 2e5;
var MAX_FACTS = 2e4;
var compact = (value) => value.replace(/\s+/g, " ").trim().slice(0, 500);
var dotted = (node) => node.text.replace(/\s/g, "");
function expression(node, depth = 0) {
  const unknown = { kind: "unknown", text: compact(node?.text ?? "") };
  if (!node || node.hasError || depth > 16 || node.namedChildCount > 64) return unknown;
  const next = (child3) => expression(child3, depth + 1);
  if (node.type === "identifier") return { kind: "name", name: node.text };
  if (node.type === "attribute") return { kind: "member", object: next(node.childForFieldName("object")), name: node.childForFieldName("attribute")?.text ?? "" };
  if (["true", "false", "none"].includes(node.type)) return { kind: "literal", value: node.type === "none" ? null : node.type === "true" };
  if (node.type === "integer" && /^\d+$/.test(node.text) && Number.isSafeInteger(Number(node.text))) return { kind: "literal", value: Number(node.text) };
  if (node.type === "string") {
    const match = /^([rRuU]?)("""|'''|"|')([\s\S]*)\2$/.exec(node.text);
    if (match && (!match[3].includes("\\") || match[1].toLowerCase() === "r")) return { kind: "literal", value: match[3] };
  }
  if (node.type === "parenthesized_expression") return next(node.namedChildren[0] ?? null);
  if (node.type === "type") return next(node.namedChildren[0] ?? null);
  if (["list", "tuple", "set", "type_parameter"].includes(node.type)) return { kind: "sequence", items: node.namedChildren.filter((child3) => child3.type !== "comment").map(next), ...node.type !== "type_parameter" ? { container: node.type } : {} };
  if (node.type === "dictionary" && node.namedChildren.every((child3) => child3.type === "pair" || child3.type === "comment")) return { kind: "mapping", items: node.namedChildren.filter((child3) => child3.type === "pair").map((child3) => ({ key: next(child3.childForFieldName("key")), value: next(child3.childForFieldName("value")) })) };
  if (node.type === "binary_operator") return { kind: "binary", operator: node.childForFieldName("operator")?.text ?? "", left: next(node.childForFieldName("left")), right: next(node.childForFieldName("right")) };
  if (node.type === "subscript" || node.type === "generic_type") {
    const items = node.type === "generic_type" ? node.namedChildren[1]?.namedChildren ?? [] : node.childrenForFieldName("subscript");
    return { kind: "subscript", object: next(node.childForFieldName("value") ?? node.namedChildren[0] ?? null), items: items.flatMap((item) => item.type === "tuple" ? item.namedChildren : [item]).map(next) };
  }
  if (node.type === "call") return { kind: "call", start: node.startIndex, range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }, callee: next(node.childForFieldName("function")), args: (node.childForFieldName("arguments")?.namedChildren ?? []).filter((arg) => arg.type !== "comment").map((arg) => arg.type === "keyword_argument" ? { name: arg.childForFieldName("name")?.text, value: next(arg.childForFieldName("value")) } : { value: next(arg), .../splat/.test(arg.type) ? { spread: true } : {} }) };
  return unknown;
}
function extractPythonImports(root, declarations, source) {
  const facts = { imports: [], writes: [], calls: [], assignments: [], returns: [], definitions: [], references: [], scopes: [], opaqueScopes: [], opaqueModule: false };
  const scopes = new Map(declarations.map((item) => [item.start, item]));
  const scopesByKey = new Map(declarations.map((item) => [item.key, item]));
  const lexical = new Map(declarations.map((item) => [item.key, item]));
  const comprehensions = /* @__PURE__ */ new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);
  const pending2 = [{ node: root, conditions: [], guards: [] }];
  let visited = 0, truncated = false;
  const write = (node, scope, kind) => {
    if (!node || node.hasError || facts.writes.length >= MAX_FACTS) return;
    if (node.type === "identifier") facts.writes.push({ name: node.text, start: node.startIndex, line: source.range(node.startIndex, node.endIndex).startLine, kind, ...scope ? { scope } : {} });
    else if (["pattern_list", "tuple_pattern", "list_pattern", "tuple", "list", "list_splat_pattern", "dictionary_splat_pattern"].includes(node.type)) node.namedChildren.forEach((child3) => write(child3, scope, kind));
    else if (node.type === "attribute") facts.writes.push({ name: dotted(node), start: node.startIndex, line: source.range(node.startIndex, node.endIndex).startLine, kind, ...scope ? { scope } : {} });
    else if (node.type === "subscript") write(node.childForFieldName("value"), scope, "mutation");
  };
  while (pending2.length) {
    const frame = pending2.pop(), { node } = frame;
    if (++visited > MAX_NODES || [facts.imports, facts.writes, facts.calls, facts.scopes, facts.assignments, facts.returns, facts.definitions, facts.references].some((items) => items.length >= MAX_FACTS)) {
      truncated = true;
      break;
    }
    let scope = frame.scope;
    const declaration = scopes.get(node.startIndex);
    if (declaration && (node.type === "decorated_definition" || ["function_definition", "class_definition"].includes(node.type))) {
      if (scope !== declaration.key) {
        facts.writes.push({ name: declaration.name, start: node.startIndex, line: declaration.range.startLine, kind: "declaration", ...scope ? { scope } : {} });
        scope = declaration.key;
        const definition = node.type === "decorated_definition" ? node.childForFieldName("definition") ?? node.namedChildren.at(-1) : node;
        const parameters2 = definition?.childForFieldName("parameters");
        const positionalEnd = parameters2?.namedChildren.find((child3) => child3.type === "positional_separator")?.startIndex;
        const keywordStart = parameters2?.namedChildren.find((child3) => child3.type === "keyword_separator" || child3.type === "list_splat_pattern" || child3.namedChildren.some((item) => item.type === "list_splat_pattern"))?.startIndex;
        facts.definitions.push({ key: declaration.key, conditions: frame.conditions, decorators: node.type === "decorated_definition" ? node.namedChildren.filter((child3) => child3.type === "decorator").map((child3) => expression(child3.namedChildren[0] ?? null)) : [], bases: (definition?.childForFieldName("superclasses")?.namedChildren ?? []).filter((child3) => child3.type !== "comment").map((child3) => expression(child3)), parameters: (parameters2?.namedChildren ?? []).filter((child3) => !["positional_separator", "keyword_separator", "comment"].includes(child3.type)).map((parameter) => {
          const name3 = parameter.type === "identifier" ? parameter : parameter.childForFieldName("name") ?? parameter.namedChildren.find((child3) => child3.type === "identifier" || /splat_pattern$/.test(child3.type));
          const actualName = name3 && /splat_pattern$/.test(name3.type) ? name3.namedChildren[0] : name3;
          const value = parameter.childForFieldName("value"), annotation = parameter.childForFieldName("type");
          return { name: actualName?.text ?? "", ...value ? { default: expression(value) } : {}, ...annotation ? { annotation: expression(annotation) } : {}, ...positionalEnd !== void 0 && parameter.startIndex < positionalEnd ? { kind: "positional-only" } : keywordStart !== void 0 && parameter.startIndex > keywordStart ? { kind: "keyword-only" } : {}, .../splat/.test(parameter.type) || !!name3 && /splat/.test(name3.type) ? { variadic: true } : {} };
        }) });
        for (const parameter of parameters2?.namedChildren ?? []) {
          const name3 = parameter.type === "identifier" ? parameter : parameter.childForFieldName("name") ?? parameter.namedChildren.find((child3) => child3.type === "identifier" || /splat_pattern$/.test(child3.type)) ?? null;
          write(name3, scope, "parameter");
        }
      }
    }
    if (comprehensions.has(node.type) || node.type === "lambda") {
      const key = `${node.startIndex}:${node.endIndex}:${node.type}`, kind = node.type === "lambda" ? "lambda" : "comprehension";
      const record = { key, kind, start: node.startIndex, end: node.endIndex, ...scope ? { parent: scope } : {} };
      facts.scopes.push(record);
      lexical.set(key, record);
      scope = key;
      if (kind === "lambda") for (const parameter of node.childForFieldName("parameters")?.namedChildren ?? []) write(parameter.type === "identifier" ? parameter : parameter.childForFieldName("name") ?? parameter.namedChildren.find((child3) => child3.type === "identifier" || /splat_pattern$/.test(child3.type)) ?? null, scope, "parameter");
    }
    if ((node.type === "import_statement" || node.type === "import_from_statement") && !node.hasError) {
      const from = node.type === "import_from_statement", moduleNode = node.childForFieldName("module_name");
      const names2 = node.childrenForFieldName("name");
      const binding = (item, moduleImport) => {
        const name3 = item.type === "aliased_import" ? item.childForFieldName("name") : item;
        return { imported: dotted(name3), local: item.childForFieldName("alias")?.text ?? (moduleImport ? dotted(name3).split(".")[0] : dotted(name3)) };
      };
      const common = { ...scope ? { scope } : {}, range: source.range(node.startIndex, node.endIndex), start: node.startIndex, end: node.endIndex, conditions: frame.conditions, guards: frame.guards };
      if (from && moduleNode) facts.imports.push({ ...common, kind: "from", specifier: dotted(moduleNode), bindings: node.namedChildren.some((child3) => child3.type === "wildcard_import") ? [{ imported: "*", local: "*" }] : names2.map((item) => binding(item, false)) });
      else if (!from) for (const item of names2) facts.imports.push({ ...common, kind: "import", specifier: binding(item, true).imported, bindings: [binding(item, true)], moduleBinding: item.type === "aliased_import" ? "exact" : "head" });
      continue;
    }
    if (["assignment", "augmented_assignment", "named_expression", "for_statement", "for_in_clause"].includes(node.type)) {
      let bindingScope = scope;
      if (node.type === "named_expression") while (bindingScope && lexical.get(bindingScope)?.kind === "comprehension") bindingScope = lexical.get(bindingScope)?.parent;
      write(node.childForFieldName("left") ?? node.childForFieldName("name"), bindingScope, node.type === "augmented_assignment" ? "augmentation" : "assignment");
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      if (["assignment", "augmented_assignment"].includes(node.type) && left?.type === "identifier" && right) facts.assignments.push({ name: left.text, value: expression(right), start: left.startIndex, range: source.range(node.startIndex, node.endIndex), conditions: frame.conditions, ...node.type === "augmented_assignment" ? { augmentation: node.childForFieldName("operator")?.text ?? node.children.find((child3) => !child3.isNamed && child3.text.endsWith("="))?.text ?? "<unknown>" } : {}, ...bindingScope ? { scope: bindingScope } : {} });
    }
    if (node.type === "as_pattern") {
      const alias = node.childForFieldName("alias");
      write(alias?.type === "as_pattern_target" ? alias.namedChildren[0] ?? null : alias, scope, "assignment");
    }
    if (node.type === "delete_statement") node.namedChildren.forEach((child3) => write(child3, scope, "assignment"));
    if (["global_statement", "nonlocal_statement"].includes(node.type) && !facts.opaqueScopes.includes(scope ?? "")) facts.opaqueScopes.push(scope ?? "");
    if (node.type === "return_statement") facts.returns.push({ value: expression(node.namedChildren[0] ?? null), start: node.startIndex, conditions: frame.conditions, ...scope ? { scope } : {} });
    if ((node.type === "identifier" || node.type === "attribute") && node.parent?.type !== "attribute") {
      const parent = node.parent, excluded = !parent || ["parameters", "lambda_parameters", "typed_parameter", "typed_default_parameter", "default_parameter", "global_statement", "nonlocal_statement", "keyword_argument", "as_pattern_target"].includes(parent.type) && node.id !== parent.childForFieldName("value")?.id && node.id !== parent.childForFieldName("type")?.id || ["function_definition", "class_definition"].includes(parent.type) && node.id === parent.childForFieldName("name")?.id || ["assignment", "augmented_assignment", "named_expression", "for_statement", "for_in_clause"].includes(parent.type) && node.id === parent.childForFieldName("left")?.id;
      if (!excluded && /^[\p{ID_Start}_][\p{ID_Continue}]*(?:\.[\p{ID_Start}_][\p{ID_Continue}]*)*$/u.test(dotted(node))) facts.references.push({ name: dotted(node), start: node.startIndex, range: source.range(node.startIndex, node.endIndex), ...scope ? { scope } : {} });
    }
    if (node.type === "call") {
      const callee = node.childForFieldName("function");
      if (callee && !callee.hasError) facts.calls.push({ callee: ["identifier", "attribute"].includes(callee.type) ? dotted(callee) : compact(callee.text), expression: expression(node), standalone: node.parent?.type === "expression_statement", conditions: frame.conditions, start: node.startIndex, range: source.range(node.startIndex, node.endIndex), ...scope ? { scope } : {} });
      let current = scope, deferred = false;
      while (current) {
        const declaration2 = lexical.get(current);
        if (!declaration2) break;
        if (["function", "method", "lambda"].includes(declaration2.kind)) {
          deferred = true;
          break;
        }
        current = declaration2.parent;
      }
      if (!deferred) facts.opaqueModule = true;
    }
    if (node.type === "if_statement" || node.type === "elif_clause") {
      const test = node.childForFieldName("condition"), consequence = node.childForFieldName("consequence");
      for (const child3 of [...node.namedChildren].reverse()) {
        if (child3.id === test?.id || child3.type === "comment") continue;
        const branch = child3.id === consequence?.id;
        const condition2 = `${branch ? "if" : "else"} ${compact(test?.text ?? "<unknown>")}`;
        pending2.push({ node: child3, ...scope ? { scope } : {}, conditions: [...frame.conditions, condition2], guards: [...frame.guards, { expression: compact(test?.text ?? ""), branch, ...scope ? { scope } : {} }] });
      }
      if (test) pending2.push({ node: test, ...scope ? { scope } : {}, conditions: frame.conditions, guards: frame.guards });
      continue;
    }
    const condition = ["for_statement", "while_statement", "try_statement", "except_clause", "with_statement", "match_statement", "case_clause"].includes(node.type) ? `${node.type}: ${compact(node.text.split(/\r?\n/)[0] ?? "")}` : void 0;
    for (const child3 of [...node.namedChildren].reverse()) {
      let childScope = scope;
      if (node.type === "decorated_definition" && child3.type === "decorator") childScope = frame.scope;
      if (["function_definition", "class_definition"].includes(node.type) && child3.id !== node.childForFieldName("body")?.id) childScope = scope ? scopesByKey.get(scope)?.parent : void 0;
      if (node.type === "for_in_clause" && comprehensions.has(node.parent?.type ?? "") && node.parent?.namedChildren.find((item) => item.type === "for_in_clause")?.id === node.id && child3.id === node.childForFieldName("right")?.id) childScope = scope ? lexical.get(scope)?.parent : void 0;
      if (node.type === "lambda" && child3.id === node.childForFieldName("parameters")?.id) childScope = frame.scope;
      pending2.push({ node: child3, ...childScope ? { scope: childScope } : {}, conditions: condition ? [...frame.conditions, condition] : frame.conditions, guards: frame.guards });
    }
  }
  facts.imports.sort((a, b) => a.start - b.start || a.specifier.localeCompare(b.specifier, "en"));
  facts.writes.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name, "en"));
  facts.calls.sort((a, b) => a.start - b.start || a.callee.localeCompare(b.callee, "en"));
  facts.opaqueScopes.sort();
  return { facts, truncated };
}

// src/analysis/tree-sitter/go-imports.ts
function goString(text) {
  if (text.startsWith("`") && text.endsWith("`") && !text.slice(1, -1).includes("`")) return text.slice(1, -1).replace(/\r/g, "");
  if (!text.startsWith('"') || !text.endsWith('"')) return void 0;
  const bytes = [], encoder = new TextEncoder(), simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i];
    if (char === '"' || char === "\n" || char === "\r") return void 0;
    if (char !== "\\") {
      const point = text.codePointAt(i);
      if (point >= 55296 && point <= 57343) return void 0;
      bytes.push(...encoder.encode(String.fromCodePoint(point)));
      if (point > 65535) i++;
      continue;
    }
    const escape = text[++i];
    if (!escape || i >= text.length - 1) return void 0;
    if (escape in simple) {
      bytes.push(simple[escape]);
      continue;
    }
    const size = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : /[0-7]/.test(escape) ? 3 : 0;
    if (!size) return void 0;
    const octal = /[0-7]/.test(escape), start = octal ? i : i + 1, digits = text.slice(start, start + size);
    if (start + size > text.length - 1 || digits.length !== size || !(octal ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/).test(digits)) return void 0;
    const value = parseInt(digits, octal ? 8 : 16);
    i = start + size - 1;
    if (octal || escape === "x") {
      if (value > 255) return void 0;
      bytes.push(value);
    } else {
      if (value > 1114111 || value >= 55296 && value <= 57343) return void 0;
      bytes.push(...encoder.encode(String.fromCodePoint(value)));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return void 0;
  }
}
function extractGoImports(root, source) {
  const facts = { imports: [], comments: [], complete: !root.hasError }, clauses = root.namedChildren.filter((node) => node.type === "package_clause");
  const clause = clauses.length === 1 ? clauses[0] : void 0, name3 = clause?.namedChildren.find((node) => node.type === "package_identifier");
  if (name3 && name3.text !== "_" && !clause.hasError) facts.package = { name: name3.text, range: source.range(clause.startIndex, clause.endIndex), start: clause.startIndex };
  else facts.complete = false;
  let count = 0, truncated = false;
  for (const node of root.namedChildren) {
    if (++count > 2e4) {
      truncated = true;
      break;
    }
    if (node.type === "comment") facts.comments.push({ text: node.text, start: node.startIndex, end: node.endIndex });
    if (node.type !== "import_declaration") continue;
    for (const spec of node.descendantsOfType("import_spec")) {
      if (++count > 2e4) {
        truncated = true;
        break;
      }
      const literal = spec.childForFieldName("path"), alias = spec.childForFieldName("name")?.text, specifier = literal && goString(literal.text);
      if (!specifier || /[\s\0\\]/.test(specifier) || spec.hasError) {
        facts.complete = false;
        continue;
      }
      facts.imports.push({ specifier, ...alias ? { local: alias } : {}, kind: alias === "." ? "dot" : alias === "_" ? "blank" : alias ? "named" : "default", range: source.range(spec.startIndex, spec.endIndex), start: spec.startIndex, end: spec.endIndex });
    }
  }
  if (truncated) facts.complete = false;
  return { facts, truncated };
}

// src/analysis/tree-sitter/go-syntax.ts
function extractGoSemantic(root, declarations, source) {
  const facts = { scopes: [], definitions: [], bindings: [], writes: [], references: [], calls: [], returns: [], gaps: [] };
  const byStart = new Map(declarations.map((item) => [item.start, item])), seenClosures = /* @__PURE__ */ new Set();
  let visited = 0, truncated = false;
  const site = (node) => ({ start: node.startIndex, range: source.range(node.startIndex, node.endIndex) });
  const field = (node, name3) => node.childForFieldName(name3) ?? void 0;
  const items = (node) => node?.namedChildren.filter((child3) => child3.type !== "comment") ?? [];
  const limit = () => {
    if (++visited > 2e5) truncated = true;
    return !truncated;
  };
  const unknown = (node) => ({ ...site(node), kind: "unknown", text: node.text.slice(0, 200) });
  function expression2(node, depth = 0) {
    if (!node) return { kind: "unknown", text: "", start: 0, range: source.range(0, 0) };
    if (depth > 64 || !limit()) return unknown(node);
    const recurse = (child3) => expression2(child3, depth + 1), s = site(node);
    switch (node.type) {
      case "identifier":
      case "type_identifier":
      case "package_identifier":
      case "field_identifier":
        return { ...s, kind: "name", name: node.text };
      case "interpreted_string_literal":
      case "raw_string_literal": {
        const value = goString(node.text);
        return value === void 0 ? unknown(node) : { ...s, kind: "literal", value };
      }
      case "true":
      case "false":
        return { ...s, kind: "literal", value: node.text === "true" };
      case "nil":
        return { ...s, kind: "literal", value: null };
      case "int_literal":
        return { ...s, kind: "literal", value: Number(node.text.replace(/_/g, "")) };
      case "parenthesized_expression":
      case "parenthesized_type":
      case "type_elem":
        return recurse(node.namedChildren[0]);
      case "selector_expression":
        return { ...s, kind: "member", object: recurse(field(node, "operand")), name: field(node, "field")?.text ?? "" };
      case "qualified_type":
        return { ...s, kind: "member", object: recurse(field(node, "package")), name: field(node, "name")?.text ?? "" };
      case "call_expression":
        return { ...s, kind: "call", callee: recurse(field(node, "function")), args: items(field(node, "arguments")).map(recurse) };
      // Go's grammar cannot disambiguate F[T](x) from a generic conversion.
      // The symbol binder makes that decision using the actual declaration.
      case "type_conversion_expression":
        return { ...s, kind: "call", callee: recurse(field(node, "type")), args: field(node, "operand") ? [recurse(field(node, "operand"))] : [] };
      case "pointer_type":
        return { ...s, kind: "unary", operator: "*", object: recurse(node.namedChildren[0]) };
      case "unary_expression":
        return { ...s, kind: "unary", operator: node.children.find((child3) => !child3.isNamed)?.text ?? "", object: recurse(field(node, "operand")) };
      case "index_expression":
        return { ...s, kind: "index", object: recurse(field(node, "operand")), index: recurse(field(node, "index")) };
      case "generic_type":
        return { ...s, kind: "index", object: recurse(field(node, "type")) };
      case "binary_expression":
        return { ...s, kind: "binary", operator: node.children.find((child3) => !child3.isNamed)?.text ?? "", left: recurse(field(node, "left")), right: recurse(field(node, "right")) };
      case "composite_literal":
        return { ...s, kind: "composite", type: recurse(field(node, "type")), items: items(field(node, "body")).map((item) => item.type === "keyed_element" ? { key: item.namedChildren[0]?.text, value: recurse(item.namedChildren.at(-1)?.namedChildren[0] ?? item.namedChildren.at(-1)) } : { value: recurse(item.type === "literal_element" ? item.namedChildren[0] : item) }) };
      case "func_literal":
        return { ...s, kind: "function", key: `closure:${node.startIndex}:${Math.min(node.endIndex, source.text.length)}` };
      default:
        return unknown(node);
    }
  }
  function scope(node, parent, kind, owner2, conditional = true) {
    const key = `${kind}:${node.startIndex}:${node.endIndex}${typeof conditional === "string" ? ":branch" : ""}`;
    facts.scopes.push({ key, parent, kind, owner: owner2, start: node.startIndex, end: Math.min(node.endIndex, source.text.length), ...conditional && ["control", "case"].includes(kind) ? { conditional: typeof conditional === "string" ? conditional : `${node.type} at line ${source.range(node.startIndex, node.startIndex).startLine}` } : {} });
    return key;
  }
  function parameters2(node) {
    if (!node) return [];
    if (node.type !== "parameter_list") return [{ type: expression2(node) }];
    return node.namedChildren.flatMap((parameter) => {
      const names2 = parameter.childrenForFieldName("name"), type = expression2(field(parameter, "type")), variadic = parameter.type === "variadic_parameter_declaration";
      return names2.length ? names2.map((name3) => ({ name: name3.text, type, ...variadic ? { variadic } : {} })) : [{ type, ...variadic ? { variadic } : {} }];
    });
  }
  function typeParameters(node, target) {
    for (const parameter of items(field(node, "type_parameters"))) for (const name3 of parameter.childrenForFieldName("name")) facts.bindings.push({ ...site(name3), end: name3.endIndex, scope: target, name: name3.text, kind: "type-parameter" });
  }
  function definition(node, current) {
    const declaration = byStart.get(node.startIndex), closure = node.type === "func_literal", body3 = field(node, "body");
    const key = closure ? `closure:${node.startIndex}:${Math.min(node.endIndex, source.text.length)}` : declaration?.key;
    if (!key) {
      facts.gaps.push("Declaration missing from structural facts");
      return;
    }
    if (closure) {
      if (seenClosures.has(node.id)) return;
      seenClosures.add(node.id);
    }
    const kind = closure ? "closure" : node.type === "method_declaration" ? "method" : node.type === "function_declaration" ? "function" : "type";
    const name3 = field(node, "name")?.text ?? "<closure>", params = parameters2(field(node, "parameters")), results = parameters2(field(node, "result")), receiver = parameters2(field(node, "receiver"))[0];
    const def = { ...site(node), key, name: name3, kind, scope: current, end: Math.min(node.endIndex, source.text.length), signature: declaration?.signature ?? node.text.slice(0, (body3?.startIndex ?? node.endIndex) - node.startIndex).replace(/\s+/g, " "), parameters: params, results, ...receiver ? { receiver } : {}, ...field(node, "type_parameters") ? { generic: true } : {} };
    if (kind === "type") {
      def.typeScope = scope(node, current, "type", key);
      typeParameters(node, def.typeScope);
      const type = field(node, "type");
      def.alias = node.type === "type_alias";
      def.underlying = expression2(type);
      def.interface = type?.type === "interface_type";
      if (type?.type === "struct_type") def.fields = (type.namedChildren.find((child3) => child3.type === "field_declaration_list")?.namedChildren ?? []).flatMap((item) => {
        const names2 = item.childrenForFieldName("name"), value = expression2(field(item, "type"));
        if (names2.length) return names2.map((name4) => ({ name: name4.text, type: value, embedded: false }));
        const pointer = item.children.some((child3) => child3.type === "*");
        return [{ type: pointer ? { ...site(item), kind: "unary", operator: "*", object: value } : value, embedded: true }];
      });
      facts.definitions.push(def);
      if (type) read(type, def.typeScope, true);
      return;
    }
    facts.definitions.push(def);
    for (const part of [...params, ...results, ...receiver ? [receiver] : []]) facts.references.push({ ...part.type, expression: part.type, scope: current });
    if (!body3) {
      facts.gaps.push("Bodyless function needs external implementation");
      return;
    }
    const inner = def.bodyScope = scope(body3, current, "function", key);
    typeParameters(node, inner);
    for (const part of [...params, ...results, ...receiver ? [receiver] : []]) if (part.name && part.name !== "_") facts.bindings.push({ ...site(body3), start: body3.startIndex, end: body3.startIndex, name: part.name, kind: "parameter", scope: inner, type: part.type });
    if (receiver) for (const identifier of field(node, "receiver")?.descendantsOfType("type_arguments").flatMap((item) => item.descendantsOfType("type_identifier")) ?? []) facts.bindings.push({ ...site(identifier), end: identifier.endIndex, scope: inner, name: identifier.text, kind: "type-parameter" });
    items(body3).forEach((child3) => walk(child3, inner));
  }
  function read(node, current, typeOnly = false, parentReference = false) {
    if (!limit()) return;
    if (node.type === "binary_expression" && node.children.some((child3) => ["&&", "||"].includes(child3.type))) {
      const left = field(node, "left"), right = field(node, "right");
      if (left) read(left, current, typeOnly);
      if (right) read(right, scope(right, current, "control"), typeOnly);
      return;
    }
    if (node.type === "func_literal") {
      definition(node, current);
      return;
    }
    if (["call_expression", "type_conversion_expression"].includes(node.type) && !typeOnly) {
      const value = expression2(node);
      if (value.kind === "call") facts.calls.push({ ...site(node), expression: value, scope: current, timing: node.parent?.type === "defer_statement" ? "deferred" : node.parent?.type === "go_statement" ? "goroutine" : "immediate" });
    }
    if (node.type === "unary_expression" && node.children.some((child3) => child3.type === "&")) {
      const target = field(node, "operand");
      if (target) facts.writes.push({ ...site(node), target: expression2(target), scope: current, kind: "address" });
    }
    const reference = ["identifier", "type_identifier", "selector_expression", "qualified_type"].includes(node.type);
    if (reference && !parentReference) facts.references.push({ ...site(node), scope: current, expression: expression2(node) });
    if (["interpreted_string_literal", "raw_string_literal", "comment"].includes(node.type)) return;
    if (node.type === "keyed_element") {
      if (node.namedChildren[0]?.type !== "literal_element" || node.namedChildren[0]?.namedChildren[0]?.type !== "identifier") {
        const key = node.namedChildren[0];
        if (key) read(key, current, typeOnly);
      }
      const value = node.namedChildren.at(-1);
      if (value) read(value, current, typeOnly);
      return;
    }
    if (["field_declaration", "parameter_declaration", "variadic_parameter_declaration", "type_parameter_declaration"].includes(node.type)) {
      const type = field(node, "type");
      if (type) read(type, current, true);
      return;
    }
    if (node.type === "method_elem") {
      for (const child3 of node.namedChildren) if (child3 !== field(node, "name")) read(child3, current, true);
      return;
    }
    for (const child3 of node.namedChildren) {
      if (reference && (child3 === field(node, "field") || child3 === field(node, "name"))) continue;
      read(child3, current, typeOnly, reference && child3 === (field(node, "operand") ?? field(node, "package")));
    }
  }
  function bind(node, current, kind, left, right) {
    const names2 = left?.namedChildren ?? node.childrenForFieldName("name"), values = items(right ?? field(node, "value")), type = field(node, "type");
    for (const [index, name3] of names2.entries()) {
      if (name3.type !== "identifier" || name3.text === "_") {
        if (name3.text !== "_") read(name3, current);
        continue;
      }
      facts.bindings.push({ ...site(name3), scope: current, name: name3.text, end: node.endIndex, kind, ...type ? { type: expression2(type) } : {}, ...values.length === names2.length ? { value: expression2(values[index]) } : values.length === 1 ? { value: expression2(values[0]), tuple: names2.length !== 1 } : {} });
    }
    if (type) read(type, current, true);
    for (const value of values) read(value, current);
  }
  function walk(node, current) {
    if (!limit()) return;
    switch (node.type) {
      case "package_clause":
      case "import_declaration":
      case "comment":
        return;
      case "function_declaration":
      case "method_declaration":
      case "type_spec":
      case "type_alias":
      case "func_literal":
        definition(node, current);
        return;
      case "block": {
        const inner = scope(node, current, "block");
        items(node).forEach((child3) => walk(child3, inner));
        return;
      }
      case "if_statement":
      case "for_statement":
      case "expression_switch_statement":
      case "type_switch_statement":
      case "select_statement": {
        const inner = scope(node, current, "control", void 0, !["if_statement", "expression_switch_statement", "type_switch_statement"].includes(node.type));
        if (node.type === "if_statement") {
          const consequence = field(node, "consequence"), alternative = field(node, "alternative"), reason = `if_statement at line ${source.range(node.startIndex, node.startIndex).startLine}`;
          for (const child3 of items(node)) walk(child3, child3.id === consequence?.id || child3.id === alternative?.id ? scope(child3, inner, "control", void 0, reason) : inner);
          return;
        }
        if (node.type === "type_switch_statement") {
          const value = field(node, "value");
          if (value) read(value, inner);
          for (const child3 of node.namedChildren) {
            if (["type_case", "default_case"].includes(child3.type)) {
              const branch = scope(child3, inner, "case"), names2 = items(field(node, "alias")), types4 = child3.childrenForFieldName("type");
              for (const name3 of names2) if (name3.text !== "_") facts.bindings.push({ ...site(name3), end: child3.startIndex, name: name3.text, scope: branch, kind: "parameter", ...types4.length === 1 ? { type: expression2(types4[0]) } : {} });
              for (const part of child3.namedChildren) {
                if (part.type === "statement_list") walk(part, branch);
                else read(part, branch, true);
              }
            } else if (child3 !== value && child3 !== field(node, "alias")) walk(child3, inner);
          }
        } else items(node).forEach((child3) => walk(child3, inner));
        return;
      }
      case "expression_case":
      case "communication_case":
      case "default_case":
      case "type_case": {
        const inner = scope(node, current, "case");
        items(node).forEach((child3) => walk(child3, inner));
        return;
      }
      case "var_spec":
        bind(node, current, "var");
        return;
      case "const_spec":
        bind(node, current, "const");
        return;
      case "short_var_declaration":
        bind(node, current, "short", field(node, "left"), field(node, "right"));
        return;
      case "range_clause":
      case "receive_statement": {
        const left = field(node, "left"), right = field(node, "right");
        if (node.children.some((child3) => child3.type === ":=")) bind(node, current, "range", left, void 0);
        else for (const target of items(left)) {
          facts.writes.push({ ...site(target), target: expression2(target), scope: current, kind: "assignment" });
          read(target, current);
        }
        if (right) read(right, current);
        return;
      }
      case "assignment_statement":
      case "inc_statement":
      case "dec_statement": {
        const targets = field(node, "left")?.namedChildren ?? node.namedChildren.slice(0, 1), assignment = node.type === "assignment_statement" && node.children.some((child3) => child3.type === "=");
        const values = items(field(node, "right"));
        for (const [index, target] of targets.entries()) {
          facts.writes.push({ ...site(target), target: expression2(target), scope: current, kind: assignment ? "assignment" : "augmentation", ...assignment && values.length === targets.length ? { value: expression2(values[index]) } : {} });
          read(target, current);
        }
        const right = field(node, "right");
        if (right) read(right, current);
        return;
      }
      case "return_statement": {
        const values = items(node.namedChildren[0]);
        facts.returns.push({ ...site(node), scope: current, values: values.map((value) => expression2(value)) });
        values.forEach((value) => read(value, current));
        return;
      }
      case "labeled_statement": {
        const statement = node.namedChildren.at(-1);
        if (statement) walk(statement, current);
        return;
      }
      case "break_statement":
      case "continue_statement":
      case "goto_statement":
        return;
      default:
        if (node.type.endsWith("_declaration") || ["statement_list", "for_clause", "var_spec_list", "const_spec_list"].includes(node.type)) items(node).forEach((child3) => walk(child3, current));
        else read(node, current);
    }
  }
  const file = scope(root, void 0, "file");
  root.namedChildren.forEach((node) => walk(node, file));
  facts.gaps = [...new Set(facts.gaps)];
  return { facts, truncated };
}

// src/analysis/tree-sitter/ruby-syntax.ts
function stringValue(text) {
  const quote = text[0];
  let value, close, single;
  if (quote === "'" || quote === '"') {
    if (text.at(-1) !== quote) return;
    value = text.slice(1, -1);
    close = quote;
    single = quote === "'";
  } else {
    const match = /^%(q|Q)([^\w\s])/.exec(text);
    if (!match) return;
    close = { "(": ")", "[": "]", "{": "}", "<": ">" }[match[2]] ?? match[2];
    if (text.at(-1) !== close) return;
    value = text.slice(3, -1);
    single = match[1] === "q";
  }
  const bytes = [], add = (part) => bytes.push(...Buffer.from(part, "utf8"));
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== "\\") {
      const point = value.codePointAt(i);
      add(String.fromCodePoint(point));
      if (point > 65535) i++;
      continue;
    }
    const escape = value[++i];
    if (escape === void 0) return;
    if (single) {
      add(escape === "\\" || escape === close || quote === "%" && value[i] === text[2] ? escape : "\\" + escape);
      continue;
    }
    const basic = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", v: "\v", a: "\x07", e: "\x1B", s: " ", "\n": "" };
    if (escape in basic) {
      add(basic[escape]);
      continue;
    }
    if (/[0-7]/.test(escape)) {
      const octal = /^[0-7]{1,3}/.exec(value.slice(i))[0];
      bytes.push(parseInt(octal, 8) & 255);
      i += octal.length - 1;
      continue;
    }
    if (escape === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(value.slice(i + 1));
      if (!hex) return;
      bytes.push(parseInt(hex[0], 16));
      i += hex[0].length;
      continue;
    }
    if (escape === "u") {
      const fixed = /^[0-9a-fA-F]{4}/.exec(value.slice(i + 1)), group = /^\{([0-9a-fA-F]+(?:[ \t]+[0-9a-fA-F]+)*)\}/.exec(value.slice(i + 1));
      const points = fixed ? [parseInt(fixed[0], 16)] : group ? group[1].split(/[ \t]+/).map((point) => parseInt(point, 16)) : void 0;
      if (!points || points.some((point) => point > 1114111 || point >= 55296 && point <= 57343)) return;
      for (const point of points) add(String.fromCodePoint(point));
      i += fixed ? 4 : group[0].length;
      continue;
    }
    if (["c", "C", "M"].includes(escape)) return;
    add(escape);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return;
  }
}
function extractRubySemantic(root, declarations, source) {
  const facts = { scopes: [], definitions: [], calls: [], locals: [], assignments: [], references: [], gaps: [], complete: false };
  let visits = 0, truncated = false;
  const bySite = new Map(declarations.map((item) => [`${item.start}:${item.end}`, item]));
  const site = (node) => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
  const children = (node) => node?.namedChildren.filter((child3) => child3.type !== "comment") ?? [];
  const field = (node, name3) => node.childForFieldName(name3) ?? void 0;
  const unknown = (node) => ({ ...site(node), kind: "unknown", text: node.text.slice(0, 200) });
  function expression2(node, depth2 = 0) {
    if (depth2 > 64) {
      truncated = true;
      return unknown(node);
    }
    switch (node.type) {
      case "constant":
      case "scope_resolution":
        return { ...site(node), kind: "constant", name: node.text.replace(/\s+/g, "") };
      case "identifier":
      case "self":
      case "global_variable":
        return { ...site(node), kind: "identifier", name: node.text };
      case "string": {
        if (node.descendantsOfType("interpolation").length) return unknown(node);
        const value = stringValue(node.text);
        return value === void 0 ? unknown(node) : { ...site(node), kind: "literal", value };
      }
      case "simple_symbol":
        return { ...site(node), kind: "symbol", name: node.text.slice(1) };
      case "true":
      case "false":
      case "nil":
        return { ...site(node), kind: "literal", value: node.type === "nil" ? null : node.type === "true" };
      case "integer": {
        const value = Number(node.text.replaceAll("_", ""));
        return Number.isSafeInteger(value) ? { ...site(node), kind: "literal", value } : unknown(node);
      }
      case "parenthesized_statements": {
        const values = children(node);
        return values.length === 1 ? expression2(values[0], depth2 + 1) : unknown(node);
      }
      case "array":
        return { ...site(node), kind: "array", items: children(node).map((child3) => expression2(child3, depth2 + 1)) };
      case "string_array":
        return { ...site(node), kind: "array", items: children(node).map((child3) => child3.type === "bare_string" && !child3.descendantsOfType("interpolation").length && !child3.text.includes("\\") ? { ...site(child3), kind: "literal", value: child3.text } : unknown(child3)) };
      case "symbol_array":
        return { ...site(node), kind: "array", items: children(node).map((child3) => child3.type === "bare_symbol" && !child3.descendantsOfType("interpolation").length && !child3.text.includes("\\") ? { ...site(child3), kind: "symbol", name: child3.text } : unknown(child3)) };
      case "pair": {
        const key = field(node, "key"), value = field(node, "value");
        return key && value ? { ...site(node), kind: "hash", items: [{ key: expression2(key, depth2 + 1), value: expression2(value, depth2 + 1) }] } : unknown(node);
      }
      case "hash":
        return { ...site(node), kind: "hash", items: children(node).map((child3) => {
          const key = field(child3, "key"), value = field(child3, "value");
          return key && value ? { key: expression2(key, depth2 + 1), value: expression2(value, depth2 + 1) } : { key: unknown(child3), value: unknown(child3) };
        }) };
      case "hash_key_symbol":
        return { ...site(node), kind: "symbol", name: node.text.replace(/:$/, "") };
      case "call": {
        const method = field(node, "method"), receiver = field(node, "receiver");
        return method ? { ...site(node), kind: "call", method: method.text, ...receiver ? { receiver: expression2(receiver, depth2 + 1) } : {}, args: children(field(node, "arguments")).map((child3) => expression2(child3, depth2 + 1)) } : unknown(node);
      }
      case "element_reference": {
        const object = field(node, "object");
        return object ? { ...site(node), kind: "call", receiver: expression2(object, depth2 + 1), method: "[]", args: children(node).filter((child3) => child3.id !== object.id).map((child3) => expression2(child3, depth2 + 1)) } : unknown(node);
      }
      default:
        return unknown(node);
    }
  }
  function scope(node, parent, kind, details = {}) {
    const key = `${kind}:${node.startIndex}:${node.endIndex}`;
    facts.scopes.push({ ...site(node), key, parent, kind, ...details });
    return key;
  }
  const gap = (node, current, kind, reason) => facts.gaps.push({ ...site(node), scope: current, kind, reason });
  function parameters2(node, current) {
    for (const parameter of children(node)) {
      const name3 = parameter.type === "identifier" ? parameter : field(parameter, "name");
      const names2 = parameter.type === "destructured_parameter" ? parameter.descendantsOfType("identifier") : name3?.type === "identifier" ? [name3] : [];
      for (const name4 of names2) facts.locals.push({ ...site(name4), scope: current, name: name4.text, kind: parameter.type === "identifier" && node && field(node, "locals")?.id === parameter.id ? "block_local" : "parameter" });
      const value = field(parameter, "value");
      if (value) walk(value, current);
    }
  }
  let depth = 0;
  function walk(node, current) {
    if (++depth > 512) {
      depth--;
      truncated = true;
      return;
    }
    try {
      visit(node, current);
    } finally {
      depth--;
    }
  }
  function visit(node, current) {
    if (++visits > 2e5) {
      truncated = true;
      return;
    }
    if (["class", "module", "method", "singleton_method"].includes(node.type)) {
      const name3 = field(node, "name"), body3 = field(node, "body");
      if (!name3) return;
      const declaration = bySite.get(`${node.startIndex}:${node.endIndex}`);
      const superclass = children(field(node, "superclass"))[0], receiver = field(node, "object");
      const inner = scope(node, current, node.type === "singleton_method" ? "method" : node.type, { name: name3.text.replace(/\s+/g, ""), owner: declaration?.key, ...node.type.includes("method") ? { deferred: true } : {} });
      facts.definitions.push({ ...site(node), key: declaration?.key ?? `${node.startIndex}:${node.endIndex}:${node.type}`, kind: node.type, name: name3.text.replace(/\s+/g, ""), scope: current, bodyScope: inner, ...superclass ? { superclass: expression2(superclass) } : {}, ...receiver ? { receiver: expression2(receiver) } : {} });
      if (superclass) walk(superclass, current);
      if (name3.type === "scope_resolution" && field(name3, "scope")) walk(field(name3, "scope"), current);
      parameters2(field(node, "parameters"), inner);
      if (body3) walk(body3, inner);
      return;
    }
    if (node.type === "singleton_class") {
      const inner = scope(node, current, "singleton");
      gap(node, inner, "scope", "Singleton-class lexical and loader context requires a receiver summary");
      children(node).forEach((child3) => walk(child3, inner));
      return;
    }
    if (["block", "do_block", "lambda"].includes(node.type)) {
      const inner = scope(node, current, "block", { deferred: true });
      const params = field(node, "parameters");
      parameters2(params, inner);
      children(node).filter((child3) => child3.id !== params?.id).forEach((child3) => walk(child3, inner));
      return;
    }
    if (["if", "unless", "elsif", "if_modifier", "unless_modifier", "case", "case_match", "in_clause", "match_pattern", "test_pattern", "when", "while", "until", "for", "while_modifier", "until_modifier", "rescue", "ensure", "conditional", "binary"].includes(node.type)) {
      if (node.type === "binary" && children(node).some((child3) => child3.type === "global_variable" && ["$LOAD_PATH", "$:", "$LOADED_FEATURES", '$"'].includes(child3.text))) gap(node, current, "path", "Ruby load path or loaded-feature binary operations require a state summary");
      const inner = scope(node, current, "control", node.type !== "binary" || ["and", "or", "&&", "||"].includes(field(node, "operator")?.text ?? "") ? { conditional: `${node.type} at line ${site(node).range.startLine}` } : {});
      const operator = field(node, "operator")?.text, left = field(node, "left"), right = field(node, "right");
      if (node.type === "binary" && operator && !["and", "or", "&&", "||"].includes(operator) && left && right) facts.calls.push({ ...site(node), scope: inner, expression: { ...site(node), kind: "call", receiver: expression2(left), method: operator, args: [expression2(right)] } });
      if (node.type === "binary" && field(node, "operator")?.text === "=~") for (const regex of node.namedChildren.filter((child3) => child3.type === "regex")) for (const capture of regex.text.matchAll(/\(\?<([\p{L}_][\p{L}\p{N}_]*)>/gu)) facts.locals.push({ ...site(regex), scope: inner, name: capture[1], kind: "write" });
      const pattern = field(node, "pattern") ?? field(node, "variable");
      if (pattern) for (const target of [...pattern.type === "identifier" ? [pattern] : pattern.descendantsOfType("identifier"), ...pattern.descendantsOfType("hash_key_symbol")]) facts.locals.push({ ...site(target), scope: inner, name: target.text.replace(/:$/, ""), kind: "write" });
      children(node).filter((child3) => child3.id !== pattern?.id).forEach((child3) => walk(child3, inner));
      return;
    }
    if (["assignment", "operator_assignment", "multiple_assignment"].includes(node.type)) {
      const left = field(node, "left"), right = field(node, "right");
      if (left && right) {
        const target = expression2(left);
        facts.assignments.push({ ...site(node), scope: current, target, value: expression2(right), ...node.type !== "assignment" ? { augmentation: true } : {} });
        if (target.kind === "call") facts.calls.push({ ...site(node), scope: current, expression: { ...target, ...site(node), method: target.method + "=", args: [...target.args, expression2(right)] } });
        for (const target2 of left.type === "identifier" ? [left] : left.type === "left_assignment_list" ? left.descendantsOfType("identifier") : []) facts.locals.push({ ...site(target2), scope: current, name: target2.text, kind: "write" });
        if (left.text.includes("$LOAD_PATH") || left.text.includes("$:") || left.text.includes("$LOADED_FEATURES") || left.text.includes('$"')) gap(node, current, "path", "Ruby load path or loaded-feature state is reassigned");
        walk(right, current);
      } else children(node).forEach((child3) => walk(child3, current));
      return;
    }
    if (["alias", "undef"].includes(node.type)) {
      gap(node, current, "loader", node.type === "alias" ? "Ruby method aliases can replace loader identity" : "Ruby undef can remove loader method identity");
      return;
    }
    if (node.type === "call") {
      const value = expression2(node);
      if (value.kind === "call") {
        const block = field(node, "block");
        facts.calls.push({ ...site(node), scope: current, expression: value, ...block ? { blockScope: `block:${block.startIndex}:${block.endIndex}` } : {}, ...node.children.some((child3) => child3.type === "&.") ? { safeNavigation: true } : {} });
        const receiver = field(node, "receiver");
        if (receiver?.text.includes("$LOAD_PATH") || receiver?.text.includes("$:") || receiver?.text.includes("$LOADED_FEATURES") || receiver?.text.includes('$"')) gap(node, current, "path", "Ruby load path or loaded-feature operations require a state summary");
        if (value.receiver?.kind === "constant" && ["Dir", "::Dir", "FileUtils", "::FileUtils"].includes(value.receiver.name) && ["chdir", "cd"].includes(value.method)) gap(node, current, "path", "Ruby working-directory changes require a recorded runtime state summary");
        if (["const_set", "remove_const", "private_constant", "const_missing", "class_eval", "module_eval", "instance_eval", "eval", "define_method", "define_singleton_method", "remove_method", "undef_method", "alias_method"].includes(value.method)) gap(node, current, ["const_set", "remove_const", "private_constant", "const_missing"].includes(value.method) ? "constants" : "loader", `Ruby ${value.method} requires a runtime namespace/method summary`);
      }
      children(node).filter((child3) => child3.id !== field(node, "method")?.id).forEach((child3) => walk(child3, current));
      return;
    }
    if (["super", "yield", "element_reference"].includes(node.type)) {
      const value = expression2(node);
      facts.calls.push({ ...site(node), scope: current, expression: value.kind === "call" ? value : { ...site(node), kind: "call", method: node.type, args: children(field(node, "arguments")).map((child3) => expression2(child3)) } });
      children(node).forEach((child3) => walk(child3, current));
      return;
    }
    if (["constant", "scope_resolution"].includes(node.type)) {
      const value = expression2(node);
      if (value.kind === "constant") facts.references.push({ ...site(node), expression: value, scope: current });
      return;
    }
    if (node.type === "identifier" && !["__FILE__", "__LINE__", "__ENCODING__"].includes(node.text)) {
      facts.calls.push({ ...site(node), scope: current, bare: true, expression: { ...site(node), kind: "call", method: node.text, args: [] } });
      return;
    }
    children(node).forEach((child3) => walk(child3, current));
  }
  walk(root, scope(root, void 0, "file"));
  facts.complete = !truncated && !root.hasError;
  return { facts, truncated };
}

// src/analysis/tree-sitter/jvm-semantic.ts
var MAX_NODES2 = 2e5;
var MAX_SITES = 5e4;
var callable = /* @__PURE__ */ new Set(["method", "function", "constructor"]);
var typeKinds = /* @__PURE__ */ new Set(["class", "interface", "enum", "record", "annotation", "object", "typealias"]);
var unescapeName = (text) => text.replace(/`([^`]+)`|\s+/g, (_match, escaped) => escaped ?? "");
var child = (node, ...names2) => node.namedChildren.find((item) => names2.includes(item.type));
var named = (node, field, ...types4) => node.childForFieldName(field) ?? child(node, ...types4);
var typeNodes = /* @__PURE__ */ new Set(["type_identifier", "scoped_type_identifier", "generic_type", "user_type", "nullable_type", "function_type", "array_type", "integral_type", "floating_point_type", "boolean_type", "void_type"]);
function extractJvmSemantic(root, language, declarations, source) {
  const facts = { scopes: [], definitions: [], bindings: [], writes: [], references: [], calls: [], returns: [], complete: !root.hasError, gaps: [] };
  const site = (node) => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
  const unknown = (node) => ({ ...site(node), kind: "unknown", text: node.text.slice(0, 300) });
  const bySite = new Map(declarations.map((declaration) => [`${declaration.start}:${declaration.end}`, declaration]));
  const lambdaKeys = /* @__PURE__ */ new Map();
  let expressionNodes = 0, lambdaOrdinal = 0, scopeOrdinal = 0, nodes = 0;
  const lambdaKey = (node) => {
    let key = lambdaKeys.get(node.id);
    if (!key) {
      key = `jvm-lambda:${lambdaOrdinal++}`;
      lambdaKeys.set(node.id, key);
    }
    return key;
  };
  const args = (node, depth = 0) => {
    if (!node) return [];
    if (node.namedChildren.length > 128) {
      facts.complete = false;
      facts.gaps.push("JVM argument budget exceeded");
      return [];
    }
    return node.namedChildren.filter((item) => item.type !== "comment").map((item) => {
      if (item.type === "element_value_pair") return { name: unescapeName(item.childForFieldName("key")?.text ?? ""), value: expression2(item.childForFieldName("value") ?? item, depth + 1) };
      if (item.type === "value_argument") {
        const assignment = item.children.some((part) => part.type === "="), value = item.namedChildren.at(-1) ?? item;
        return { ...assignment ? { name: unescapeName(item.namedChildren[0]?.text ?? "") } : {}, value: expression2(value, depth + 1), ...item.children.some((part) => part.type === "*") ? { spread: true } : {} };
      }
      return { value: expression2(item, depth + 1) };
    });
  };
  const expression2 = (node, depth = 0) => {
    if (++expressionNodes > MAX_NODES2 || depth > 32) {
      facts.complete = false;
      return unknown(node);
    }
    const base = site(node), parts = node.namedChildren.filter((part) => part.type !== "comment");
    if (node.type === "identifier" && ["true", "false"].includes(node.text)) return { ...base, kind: "literal", value: node.text === "true", literalType: "boolean" };
    if (node.type === "generic_type" || node.type === "user_type" && parts.some((part) => part.type === "type_arguments")) {
      const container = child(node, "type_arguments"), names2 = parts.filter((part) => part !== container), text = names2.map((part) => part.text).join(".");
      return container && names2.length ? { ...base, kind: "generic-type", name: { ...base, kind: "name", name: unescapeName(text) }, arguments: container.namedChildren.map((part) => expression2(part.type === "type_projection" && part.namedChildren.length === 1 && !/^(?:in|out)\b/.test(part.text) ? part.namedChildren[0] : part, depth + 1)) } : unknown(node);
    }
    if (["identifier", "type_identifier", "scoped_identifier", "scoped_type_identifier", "qualified_identifier", "user_type", "integral_type", "floating_point_type", "boolean_type", "void_type"].includes(node.type)) {
      if (node.type === "user_type" && parts.some((part) => part.type === "type_arguments")) return unknown(node);
      return { ...base, kind: "name", name: unescapeName(node.text) };
    }
    if (["this_expression", "super_expression"].includes(node.type) && !["this", "super"].includes(node.text)) return unknown(node);
    if (["this", "this_expression", "super", "super_expression"].includes(node.type)) return { ...base, kind: "name", name: node.type.startsWith("this") ? "this" : "super" };
    if (["parenthesized_expression", "parenthesized_type"].includes(node.type) && parts[0]) return expression2(parts[0], depth + 1);
    if (["true", "false", "boolean_literal"].includes(node.type)) return { ...base, kind: "literal", value: node.text === "true", literalType: "boolean" };
    if (["null_literal", "null"].includes(node.type)) return { ...base, kind: "literal", value: null, literalType: "null" };
    if (/^(?:decimal|hex|octal|binary)_integer_literal$|^integer_literal$/.test(node.type) || node.type === "number_literal" && !/[.eEfFuU]/.test(node.text)) {
      const text = node.text.replaceAll("_", ""), long = /[lL]$/.test(text), raw = text.replace(/[lL]$/, "");
      const value = /^0[0-7]+$/.test(raw) && language === "java" ? parseInt(raw, 8) : Number(raw);
      return Number.isSafeInteger(value) ? { ...base, kind: "literal", value, literalType: long ? "long" : "int" } : unknown(node);
    }
    if (/floating_point_literal|real_literal/.test(node.type) || node.type === "number_literal" && /^(?:\d[\d_]*\.[\d_]+|\d[\d_]*[eE][+-]?[\d_]+)(?:[fF])?$/.test(node.text)) {
      const value = Number(node.text.replaceAll("_", "").replace(/[fFdD]$/, ""));
      return Number.isFinite(value) ? { ...base, kind: "literal", value, literalType: /[fF]$/.test(node.text) ? "float" : "double" } : unknown(node);
    }
    if (node.type === "string_literal") {
      if (language === "kotlin" && parts.some((part) => /interpolation/.test(part.type))) return unknown(node);
      const text = node.text;
      if (text.startsWith('"""')) return language === "kotlin" && !text.includes("$") ? { ...base, kind: "literal", value: text.slice(3, -3), literalType: "String" } : unknown(node);
      if (language === "kotlin" && /(?<!\\)\$/.test(text)) return unknown(node);
      try {
        return { ...base, kind: "literal", value: JSON.parse(language === "kotlin" ? text.replace(/\\\$/g, "$") : text), literalType: "String" };
      } catch {
        return unknown(node);
      }
    }
    if (["element_value_array_initializer", "array_initializer", "collection_literal"].includes(node.type)) return { ...base, kind: "array", items: parts.map((part) => expression2(part, depth + 1)) };
    if (node.type === "field_access") {
      const object = node.childForFieldName("object"), name3 = node.childForFieldName("field");
      return object && name3 ? { ...base, kind: "member", object: expression2(object, depth + 1), name: unescapeName(name3.text) } : unknown(node);
    }
    if (node.type === "navigation_expression" && parts.length >= 2) {
      const object = parts[0], name3 = parts.at(-1);
      return node.children.some((part) => part.type === "::") ? { ...base, kind: "method-reference", object: expression2(object, depth + 1), name: unescapeName(name3.text) } : { ...base, kind: "member", object: expression2(object, depth + 1), name: unescapeName(name3.text), ...node.children.some((part) => part.type === "?.") ? { safe: true } : {} };
    }
    if (node.type === "method_invocation") {
      const name3 = node.childForFieldName("name"), object = node.childForFieldName("object");
      if (!name3) return unknown(node);
      const callee = object ? { ...site(name3), kind: "member", object: expression2(object, depth + 1), name: unescapeName(name3.text) } : { ...site(name3), kind: "name", name: unescapeName(name3.text) };
      return { ...base, kind: "call", callee, args: args(node.childForFieldName("arguments") ?? void 0, depth + 1), ...node.childForFieldName("type_arguments") ? { typeArguments: true } : {} };
    }
    if (node.type === "call_expression") {
      const callee = parts[0], argumentList = child(node, "value_arguments"), lambda = child(node, "annotated_lambda", "lambda_literal");
      if (!callee) return unknown(node);
      const values = args(argumentList, depth + 1);
      if (lambda) values.push({ value: expression2(lambda, depth + 1) });
      if (lambda && !argumentList && callee.type === "call_expression") {
        const target = expression2(callee, depth + 1);
        if (target.kind === "call") return { ...base, ...target, start: base.start, end: base.end, range: base.range, args: [...target.args, ...values] };
      }
      return { ...base, kind: "call", callee: expression2(callee, depth + 1), args: values, ...parts.some((part) => part.type === "type_arguments") ? { typeArguments: true } : {} };
    }
    if (node.type === "object_creation_expression" || node.type === "constructor_invocation") {
      const type = named(node, "type", "user_type"), argumentsNode = named(node, "arguments", "value_arguments");
      return type ? { ...base, kind: "new", type: expression2(type, depth + 1), args: args(argumentsNode, depth + 1), ...child(node, "class_body") ? { anonymous: true } : {} } : unknown(node);
    }
    if (node.type === "method_reference" || node.type === "callable_reference") {
      const name3 = parts.at(-1), object = parts.length > 1 ? parts[0] : void 0;
      return name3 ? { ...base, kind: "method-reference", ...object ? { object: expression2(object, depth + 1) } : {}, name: unescapeName(name3.text) } : unknown(node);
    }
    if (["lambda_expression", "lambda_literal"].includes(node.type)) return { ...base, kind: "lambda", key: lambdaKey(node) };
    if (node.type === "annotated_lambda") {
      const lambda = child(node, "lambda_literal");
      return lambda ? expression2(lambda, depth + 1) : unknown(node);
    }
    if (["binary_expression", "infix_expression", "additive_expression", "multiplicative_expression", "comparison_expression", "equality_expression", "conjunction_expression", "disjunction_expression", "elvis_expression", "range_expression"].includes(node.type) && parts.length >= 2) {
      const left = node.childForFieldName("left") ?? parts[0], right = node.childForFieldName("right") ?? parts.at(-1), operator = node.childForFieldName("operator")?.text ?? node.children.find((part) => !part.isNamed)?.text ?? (node.type === "infix_expression" ? parts.slice(1, -1).find((part) => part.type === "identifier")?.text : void 0) ?? "";
      return { ...base, kind: "binary", operator, left: expression2(left, depth + 1), right: expression2(right, depth + 1) };
    }
    if (["unary_expression", "prefix_expression", "postfix_expression"].includes(node.type) && parts[0]) return { ...base, kind: "unary", operator: node.children.find((part) => !part.isNamed)?.text ?? "", object: expression2(parts[0], depth + 1) };
    if (["array_access", "indexing_expression"].includes(node.type)) {
      const object = node.childForFieldName("array") ?? parts[0], index = node.childForFieldName("index") ?? parts[1];
      return object ? { ...base, kind: "index", object: expression2(object, depth + 1), ...index ? { index: expression2(index, depth + 1) } : {} } : unknown(node);
    }
    if (node.type === "cast_expression") {
      const type = node.childForFieldName("type"), value = node.childForFieldName("value");
      return type && value ? { ...base, kind: "cast", type: expression2(type, depth + 1), value: expression2(value, depth + 1) } : unknown(node);
    }
    if (node.type === "class_literal" && parts[0]) return { ...base, kind: "class", type: expression2(parts[0], depth + 1) };
    return unknown(node);
  };
  const annotation = (node) => {
    const invocation = child(node, "constructor_invocation"), type = node.childForFieldName("name") ?? child(node, "user_type") ?? (invocation && child(invocation, "user_type"));
    const target = child(node, "use_site_target");
    return { ...site(node), type: type ? expression2(type) : unknown(node), args: args(named(node, "arguments", "annotation_argument_list") ?? (invocation && child(invocation, "value_arguments"))), ...target ? { target: target.text } : {} };
  };
  const annotations2 = (node) => {
    const result = [];
    const scan = (part) => {
      if (["annotation", "marker_annotation"].includes(part.type)) result.push(annotation(part));
      else if (["modifiers", "parameter_modifiers", "annotated_type"].includes(part.type)) for (const nested of part.namedChildren) scan(nested);
    };
    for (const part of node.namedChildren) scan(part);
    return result;
  };
  const scope = (node, kind, parent, owner2, conditional) => {
    const value = { ...site(node), key: `jvm-scope:${scopeOrdinal++}`, kind, ...parent ? { parent: parent.key } : {}, ...owner2 ? { owner: owner2 } : {}, ...conditional ? { conditional } : {}, ...kind === "lambda" ? { deferred: true } : {}, gaps: [] };
    facts.scopes.push(value);
    return value;
  };
  const parameters2 = (node, container) => {
    if (!container) return [];
    const values = [];
    const entries = container.type === "identifier" ? [container] : container.namedChildren;
    for (let i = 0; i < entries.length; i++) {
      const parameter = entries[i];
      if (!["formal_parameter", "spread_parameter", "parameter", "class_parameter", "variable_declaration", "identifier", "receiver_parameter"].includes(parameter.type)) continue;
      const name3 = parameter.childForFieldName("name") ?? child(parameter, "identifier"), type = parameter.childForFieldName("type") ?? parameter.namedChildren.find((part) => typeNodes.has(part.type));
      const next = entries[i + 1], isDefault = next && !["parameter", "parameter_modifiers", "formal_parameter"].includes(next.type) && container.text.slice(parameter.endIndex - container.startIndex, next.startIndex - container.startIndex).includes("=");
      values.push({ name: unescapeName(name3?.text ?? (parameter.type === "identifier" ? parameter.text : "")) || void 0, ...type ? { type: expression2(type) } : {}, ...isDefault ? { default: expression2(next) } : {}, ...parameter.type === "spread_parameter" || /\bvararg\b/.test(parameter.text) ? { variadic: true } : {}, ...parameter.type === "class_parameter" && parameter.children.some((part) => ["val", "var"].includes(part.type)) ? { property: true } : {}, annotations: [...annotations2(parameter), ...language === "kotlin" && container.namedChildren[i - 1]?.type === "parameter_modifiers" ? annotations2(container.namedChildren[i - 1]) : []] });
      if (isDefault) i++;
    }
    return values;
  };
  const bind = (node, name3, where, kind, type, value, immutable = false) => {
    facts.bindings.push({ ...site(node), name: unescapeName(name3), scope: where.key, kind, ...type ? { type: expression2(type) } : {}, ...value ? { value: expression2(value) } : {}, immutable });
  };
  const definition = (node, declaration, where) => {
    const params = named(node, "parameters", "formal_parameters", "function_value_parameters") ?? child(child(node, "primary_constructor") ?? node, "class_parameters");
    const body3 = named(node, "body", "function_body", "class_body", "enum_body", "annotation_type_body", "block", "constructor_body");
    const resultType = node.childForFieldName("type") ?? (language === "kotlin" ? node.namedChildren.find((part) => typeNodes.has(part.type) && part.startIndex > declaration.nameEnd) : void 0);
    const typeParameters = child(node, "type_parameters")?.namedChildren.flatMap((part) => part.namedChildren.filter((name3) => ["type_identifier", "identifier"].includes(name3.type)).slice(0, 1).map((name3) => unescapeName(name3.text))) ?? [];
    const bases = [];
    for (const heritage of node.namedChildren.filter((part) => ["superclass", "super_interfaces", "extends_interfaces", "delegation_specifiers"].includes(part.type))) {
      const scan = (part) => {
        if (typeNodes.has(part.type)) {
          bases.push(expression2(part));
          return;
        }
        if (part.type === "constructor_invocation") {
          const type2 = child(part, "user_type");
          if (type2) bases.push(expression2(type2));
          return;
        }
        for (const item of part.namedChildren) scan(item);
      };
      scan(heritage);
    }
    const valueNode = node.type === "variable_declarator" ? node.childForFieldName("value") : node.type === "property_declaration" && node.children.some((part) => part.type === "=") ? node.namedChildren.at(-1) : void 0;
    const type = declaration.kind === "property" ? node.parent?.childForFieldName("type") ?? child(child(node, "variable_declaration") ?? node, "user_type", "nullable_type") : void 0;
    const def = { ...site(node), key: declaration.key, name: unescapeName(declaration.name), kind: declaration.kind, scope: where.key, ...declaration.parent ? { parent: declaration.parent } : {}, parameters: parameters2(node, params), ...resultType ? { returnType: expression2(resultType) } : {}, ...type ? { returnType: expression2(type) } : {}, bases, typeParameters, annotations: annotations2(node.type === "variable_declarator" ? node.parent ?? node : node), ...valueNode ? { value: expression2(valueNode) } : {}, modifiers: declaration.modifiers ?? [], gaps: [] };
    if (language === "kotlin" && callable.has(declaration.kind)) {
      const receiver = node.namedChildren.find((part) => typeNodes.has(part.type) && part.endIndex < declaration.nameEnd);
      if (receiver) {
        def.receiverType = expression2(receiver);
        def.gaps.push("Kotlin extension dispatch requires a reviewed receiver/overload profile");
      }
    }
    if (def.kind === "property") def.immutable = language === "java" ? def.modifiers.includes("final") : node.children.some((part) => part.type === "val");
    if (language === "kotlin" && node.namedChildren.some((part) => ["getter", "setter", "property_delegate"].includes(part.type))) def.gaps.push("Custom/delegated Kotlin property requires a reviewed access profile");
    if (node.type === "enum_constant") def.gaps.push("Enum construction and anonymous constant bodies require a reviewed compiler profile");
    if (body3) {
      const selected = scope(body3, typeKinds.has(def.kind) ? "type" : "function", where, def.key);
      if (typeKinds.has(def.kind)) def.typeScope = selected.key;
      else def.bodyScope = selected.key;
    }
    facts.definitions.push(def);
    return def;
  };
  const fileScope = scope(root, "file");
  const reference = (node, where, kind = "value") => facts.references.push({ ...site(node), scope: where.key, expression: expression2(node), kind });
  const visit = (node, where, suppressed = false) => {
    if (++nodes > MAX_NODES2 || facts.calls.length + facts.references.length + facts.bindings.length > MAX_SITES) {
      facts.complete = false;
      return;
    }
    if (["package_declaration", "package_header", "import", "import_declaration", "line_comment", "block_comment", "comment"].includes(node.type)) return;
    const declaration = bySite.get(`${node.startIndex}:${node.endIndex}`);
    if (declaration) {
      const def = definition(node, declaration, where), bodyKey = def.bodyScope ?? def.typeScope, bodyScope = bodyKey ? facts.scopes.find((item) => item.key === bodyKey) : void 0;
      const body3 = bodyScope ? node.namedChildren.find((part) => part.startIndex === bodyScope.start && part.endIndex === bodyScope.end) : void 0;
      if (def.kind === "property" && !["file", "type", "opaque"].includes(where.kind)) facts.bindings.push({ ...site(node), scope: where.key, declaration: def.key, kind: "local", name: def.name, ...def.returnType ? { type: def.returnType } : {}, ...def.value ? { value: def.value } : {}, immutable: node.children.some((part) => part.type === "val") });
      if (bodyScope) {
        for (const parameter of def.parameters) {
          if (parameter.name) facts.bindings.push({ ...site(node), name: parameter.name, scope: bodyScope.key, kind: "parameter", ...parameter.type ? { type: parameter.type } : {}, immutable: language === "kotlin" });
        }
        if (body3) {
          if (language === "kotlin" && body3.type === "function_body" && body3.children.some((part) => part.type === "=") && body3.namedChildren.length === 1) facts.returns.push({ ...site(body3), scope: bodyScope.key, value: expression2(body3.namedChildren[0]) });
          visitChildren(body3, bodyScope);
        }
      }
      if (def.value) {
        const valueNode = node.type === "variable_declarator" ? node.childForFieldName("value") : node.namedChildren.at(-1);
        if (valueNode) {
          const initializer = ["file", "type"].includes(where.kind) ? scope(valueNode, "initializer", where, def.key) : where;
          visit(valueNode, initializer);
        }
      }
      const header2 = node.namedChildren.filter((part) => part !== body3 && part.endIndex <= (body3?.startIndex ?? node.endIndex) && part !== node.childForFieldName("name"));
      for (const part of header2) {
        if (typeNodes.has(part.type)) reference(part, where, "type");
      }
      return;
    }
    if (["annotation", "marker_annotation"].includes(node.type)) return;
    if (["lambda_expression", "lambda_literal"].includes(node.type)) {
      const key = lambdaKey(node), own = scope(node, "lambda", where, key), params = named(node, "parameters", "formal_parameters", "lambda_parameters");
      const def = { ...site(node), key, name: "<lambda>", kind: "lambda", scope: where.key, bodyScope: own.key, parameters: parameters2(node, params), bases: [], typeParameters: [], annotations: [], modifiers: [], gaps: [] };
      facts.definitions.push(def);
      for (const parameter of def.parameters) if (parameter.name) facts.bindings.push({ ...site(node), scope: own.key, kind: "parameter", name: parameter.name, ...parameter.type ? { type: parameter.type } : {}, immutable: language === "kotlin" });
      if (!params && language === "kotlin") own.gaps.push("Implicit Kotlin lambda parameter/receiver requires a selected callable type");
      for (const part of node.namedChildren) if (part.id !== params?.id) visit(part, own);
      return;
    }
    if (["class_body", "enum_body", "annotation_type_body"].includes(node.type)) {
      const own = scope(node, "opaque", where);
      own.gaps.push("Anonymous/local JVM type body requires a reviewed owning-type profile");
      visitChildren(node, own);
      return;
    }
    if (["companion_object", "object_literal"].includes(node.type)) {
      const own = scope(node, "opaque", where);
      own.gaps.push("Companion/anonymous-object receiver and generated bridges require a reviewed JVM profile");
      visitChildren(node, own);
      return;
    }
    if (["block", "constructor_body"].includes(node.type)) {
      const own = scope(node, "block", where);
      visitChildren(node, own);
      return;
    }
    if (["if_statement", "if_expression", "switch_expression", "when_expression", "while_statement", "while_expression", "do_statement", "do_while_expression", "for_statement", "enhanced_for_statement", "try_statement", "try_expression", "catch_clause", "when_entry", "switch_block_statement_group"].includes(node.type)) {
      const own = scope(node, "control", where, void 0, `${node.type} body may execute conditionally`);
      if (node.type === "enhanced_for_statement") {
        const name3 = node.childForFieldName("name"), type = node.childForFieldName("type");
        if (name3) bind(name3, name3.text, own, "loop", type ?? void 0);
      }
      if (language === "kotlin" && node.type === "for_statement") {
        const variable = child(node, "variable_declaration"), name3 = variable && child(variable, "identifier");
        if (name3) bind(variable, name3.text, own, "loop", variable?.namedChildren.find((part) => typeNodes.has(part.type)));
      }
      if (node.type === "catch_clause") {
        const param = child(node, "catch_formal_parameter", "parameter"), name3 = param && named(param, "name", "identifier");
        if (name3) bind(param, name3.text, own, "catch", param?.childForFieldName("type") ?? void 0);
      }
      visitChildren(node, own);
      return;
    }
    if (node.type === "local_variable_declaration") {
      const type = node.childForFieldName("type");
      for (const variable of node.namedChildren.filter((part) => part.type === "variable_declarator")) {
        const name3 = variable.childForFieldName("name"), value = variable.childForFieldName("value");
        if (name3) bind(variable, name3.text, where, "local", type ?? void 0, value ?? void 0, node.namedChildren.some((part) => part.type === "modifiers" && /\bfinal\b/.test(part.text)));
        if (value) visit(value, where);
      }
      if (type) reference(type, where, "type");
      return;
    }
    if (node.type === "property_declaration") {
      const variable = child(node, "variable_declaration"), name3 = variable && child(variable, "identifier"), type = variable?.namedChildren.find((part) => typeNodes.has(part.type)), value = node.children.some((part) => part.type === "=") ? node.namedChildren.at(-1) : void 0;
      if (name3) bind(node, name3.text, where, "local", type, value, node.children.some((part) => part.type === "val"));
      if (value) visit(value, where);
      if (type) reference(type, where, "type");
      if (!name3) where.gaps.push("Destructuring/delegated Kotlin bindings need a selected type profile");
      return;
    }
    if (["assignment_expression", "assignment", "update_expression"].includes(node.type)) {
      const target = node.childForFieldName("left") ?? node.namedChildren[0], value = node.childForFieldName("right") ?? node.namedChildren[1], operator = node.childForFieldName("operator")?.text ?? node.children.find((part) => !part.isNamed)?.text ?? "=";
      if (target) facts.writes.push({ ...site(node), scope: where.key, target: expression2(target), ...value ? { value: expression2(value) } : {}, operator });
      if (value) visit(value, where);
      if (target && target.type !== "identifier") visit(target, where);
      return;
    }
    if (["instanceof_expression", "type_pattern", "record_pattern", "as_expression"].includes(node.type)) where.gaps.push("Pattern/smart-cast binding requires a reviewed control-flow type profile");
    if (["return_statement", "return_expression"].includes(node.type)) {
      const value = node.namedChildren.at(-1);
      if (value) {
        facts.returns.push({ ...site(node), scope: where.key, value: expression2(value) });
        visit(value, where);
      }
      return;
    }
    if (["method_invocation", "call_expression", "object_creation_expression", "explicit_constructor_invocation"].includes(node.type)) {
      facts.calls.push({ ...site(node), scope: where.key, expression: expression2(node), kind: node.type === "object_creation_expression" ? "new" : node.type === "explicit_constructor_invocation" ? node.children.some((part) => part.type === "super") ? "super" : "this" : "call" });
      const name3 = node.childForFieldName("name");
      for (const part of node.namedChildren) if (part.id !== name3?.id) {
        if (node.type === "call_expression" && !child(node, "value_arguments") && child(node, "annotated_lambda", "lambda_literal") && part === node.namedChildren[0] && part.type === "call_expression") visitChildren(part, where, true);
        else visit(part, where, !["argument_list", "value_arguments", "annotated_lambda", "lambda_literal"].includes(part.type));
      }
      return;
    }
    if (node.type === "method_reference" || node.type === "callable_reference" || node.type === "navigation_expression" && node.children.some((part) => part.type === "::")) {
      reference(node, where, "method-reference");
      return;
    }
    if (typeNodes.has(node.type)) {
      reference(node, where, "type");
      return;
    }
    if (node.type === "field_access" || node.type === "navigation_expression") {
      if (!suppressed) reference(node, where);
      for (const part of node.namedChildren.slice(0, -1)) visit(part, where, true);
      return;
    }
    if (node.type === "identifier" && !suppressed) {
      reference(node, where);
      return;
    }
    visitChildren(node, where, suppressed);
  };
  const visitChildren = (node, where, suppressed = false) => {
    for (const part of node.namedChildren) visit(part, where, suppressed);
  };
  visitChildren(root, fileScope);
  if (!facts.complete && !facts.gaps.length) facts.gaps.push("JVM syntax/semantic extraction is incomplete or exceeded its budget");
  return facts;
}

// src/analysis/tree-sitter/jvm-syntax.ts
function extractJvm(root, language, declarations, source) {
  const packages = root.namedChildren.filter((node) => ["package_declaration", "package_header"].includes(node.type)), name3 = packages[0]?.namedChildren.find((node) => ["identifier", "scoped_identifier", "qualified_identifier"].includes(node.type));
  const path = (text) => text.replace(/`([^`]+)`|\s+/g, (_match, escaped) => escaped ?? "");
  const facts = { package: name3 ? path(name3.text) : "", imports: [], declarations: [], complete: !root.hasError && packages.length <= 1, gaps: [] };
  for (const node of root.namedChildren) {
    if (node.type === "module_declaration") {
      facts.module = node.childForFieldName("name")?.text;
      facts.gaps.push("JPMS requires/exports/readability need a selected module-path profile");
    }
    if (!["import_declaration", "import"].includes(node.type) || !node.namedChildren.length)
      continue;
    const target = node.namedChildren.find((child3) => ["identifier", "scoped_identifier", "qualified_identifier"].includes(child3.type));
    if (!target || node.hasError) {
      facts.complete = false;
      continue;
    }
    const star = node.children.some((child3) => child3.type === "*" || child3.type === "asterisk"), isStatic = node.children.some((child3) => child3.type === "static"), alias = language === "kotlin" && node.children.some((child3) => child3.type === "as") ? node.namedChildren.at(-1)?.text : void 0;
    facts.imports.push({ specifier: path(target.text), kind: isStatic ? star ? "static-star" : "static" : star ? "star" : "single", ...alias ? { alias: path(alias) } : {}, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
  }
  if (language === "java" && /\\u+[0-9a-fA-F]{4}/.test(root.text))
    facts.gaps.push("Java Unicode escape preprocessing requires a selected lexical profile");
  if (language === "kotlin" && declarations.some((declaration) => declaration.modifiers?.some((modifier) => ["expect", "actual"].includes(modifier))))
    facts.gaps.push("Kotlin multiplatform declarations require a selected compilation profile");
  const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
  for (const declaration of declarations) {
    const node = root.descendantForIndex(declaration.start, declaration.end);
    let current = node;
    let local = false, companion = false;
    while (current) {
      if (["function_body", "block", "lambda_literal", "constructor_body", "method_declaration", "function_declaration"].includes(current.type) && current.startIndex < declaration.start)
        local = true;
      if (current.type === "companion_object")
        companion = true;
      current = current.parent;
    }
    const enumConstant = language === "java" && declaration.kind === "property" && [node, node?.parent].some((item) => item?.type === "enum_constant" && item.startIndex === declaration.start && item.endIndex === declaration.end);
    const parent = declaration.parent ? byKey.get(declaration.parent) : void 0, type = ["class", "interface", "enum", "record", "annotation", "object", "typealias"].includes(declaration.kind), isStatic = enumConstant || !!declaration.modifiers?.includes("static") || language === "java" && !!parent && ["interface", "annotation"].includes(parent.kind) && (type || declaration.kind === "property");
    const visibility = (enumConstant ? "public" : void 0) ?? declaration.visibility ?? (language === "kotlin" || language === "java" && parent && ["interface", "annotation"].includes(parent.kind) ? "public" : "package");
    const importable = !local && !companion && (type && (!parent || ["class", "interface", "enum", "record", "annotation", "object"].includes(parent.kind)) || language === "kotlin" && !parent || parent?.kind === "object" || isStatic);
    const qualifiedName = path(declaration.qualifiedName);
    facts.declarations.push({ key: declaration.key, name: path(declaration.name), qualifiedName, ...declaration.parent ? { parent: declaration.parent } : {}, importable, static: isStatic, visibility, ...local ? { reason: "Local declaration is outside package import scope" } : companion ? { reason: "Companion/JVM bridge import requires a reviewed interop summary" } : {} });
  }
  facts.semantic = extractJvmSemantic(root, language, declarations, source);
  facts.complete &&= facts.semantic.complete;
  return facts;
}

// src/analysis/tree-sitter/csharp-semantic.ts
var types = /* @__PURE__ */ new Set(["class", "interface", "struct", "enum", "record", "type"]);
var name = (value) => value.replace(/\s+/g, "").replace(/@([\p{L}_][\p{L}\p{N}_]*)/gu, "$1");
function extractCsharpSemantic(root, declarations, source) {
  const facts = { scopes: [], definitions: [], bindings: [], writes: [], references: [], calls: [], returns: [], complete: !root.hasError, gaps: [] };
  const site = (node) => ({ start: Math.min(node.startIndex, source.text.length), end: Math.min(node.endIndex, source.text.length), range: source.range(node.startIndex, node.endIndex) });
  const unknown = (node) => ({ ...site(node), kind: "unknown", text: node.text.slice(0, 300) });
  const children = (node) => node.namedChildren.filter((child3) => child3.type !== "comment");
  const bySite = new Map(declarations.map((fact) => [`${fact.start}:${fact.end}`, fact])), lambdaKeys = /* @__PURE__ */ new Map();
  const nodeScopes = /* @__PURE__ */ new Map(), definitionNodes = /* @__PURE__ */ new Map();
  let nodes = 0, expressions = 0, scopeOrdinal = 0, lambdaOrdinal = 0;
  const lambdaKey = (node) => {
    let key = lambdaKeys.get(node.id);
    if (!key) {
      key = "csharp-lambda:" + lambdaOrdinal++;
      lambdaKeys.set(node.id, key);
    }
    return key;
  };
  const args = (node, depth = 0) => {
    if (!node)
      return [];
    if (node.namedChildren.length > 128) {
      facts.complete = false;
      return [];
    }
    return children(node).map((argument) => {
      const parts = children(argument), identifier = argument.childForFieldName("name"), value = parts.at(-1) ?? argument;
      let alias = identifier?.text;
      const assigned = value.type === "assignment_expression" && value.childForFieldName("operator")?.text === "=";
      if (assigned)
        alias = value.childForFieldName("left")?.text;
      else if (argument.children.some((child3) => child3.type === ":"))
        alias = parts[0]?.text;
      const modifier = argument.children.find((child3) => ["ref", "out", "in"].includes(child3.type))?.text;
      return { ...alias ? { name: name(alias) } : {}, ...modifier ? { modifier } : {}, value: expression2(assigned ? value.childForFieldName("right") ?? value : value, depth + 1) };
    });
  };
  const expression2 = (node, depth = 0) => {
    if (++expressions > 2e5 || depth > 32) {
      facts.complete = false;
      return unknown(node);
    }
    const base = site(node), parts = children(node);
    if (["identifier", "qualified_name", "alias_qualified_name", "predefined_type"].includes(node.type))
      return { ...base, kind: "name", name: name(node.text) };
    if (["this", "base", "this_expression", "base_expression"].includes(node.type))
      return { ...base, kind: "name", name: node.text };
    if (["parenthesized_expression", "arrow_expression_clause", "await_expression"].includes(node.type) && parts[0])
      return expression2(parts[0], depth + 1);
    if (["true", "false", "boolean_literal"].includes(node.type))
      return { ...base, kind: "literal", value: node.text === "true", type: "bool" };
    if (node.type === "null_literal")
      return { ...base, kind: "literal", value: null, type: "null" };
    if (node.type === "integer_literal") {
      const text = node.text.replaceAll("_", ""), suffix = /[uUlL]+$/.exec(text)?.[0] ?? "", raw = text.slice(0, text.length - suffix.length), value = Number(raw);
      return Number.isSafeInteger(value) ? { ...base, kind: "literal", value, type: /u/i.test(suffix) ? /l/i.test(suffix) ? "ulong" : "uint" : /l/i.test(suffix) ? "long" : value <= 2147483647 ? "int" : value <= 4294967295 ? "uint" : "long" } : unknown(node);
    }
    if (node.type === "real_literal") {
      const suffix = /[fFdDmM]$/.exec(node.text)?.[0], value = Number(node.text.replaceAll("_", "").replace(/[fFdDmM]$/, ""));
      return Number.isFinite(value) ? { ...base, kind: "literal", value, type: /m/i.test(suffix ?? "") ? "decimal" : /f/i.test(suffix ?? "") ? "float" : "double" } : unknown(node);
    }
    if (node.type === "string_literal") {
      try {
        return { ...base, kind: "literal", value: JSON.parse(node.text), type: "string" };
      } catch {
        return unknown(node);
      }
    }
    if (node.type === "verbatim_string_literal")
      return { ...base, kind: "literal", value: node.text.slice(2, -1).replaceAll('""', '"'), type: "string" };
    if (node.type === "character_literal") {
      try {
        const value = JSON.parse('"' + node.text.slice(1, -1).replaceAll('"', '\\"').replaceAll("\\'", "'") + '"');
        return typeof value === "string" && value.length === 1 ? { ...base, kind: "literal", value, type: "char" } : unknown(node);
      } catch {
        return unknown(node);
      }
    }
    if (["array_creation_expression", "implicit_array_creation_expression", "collection_expression"].includes(node.type)) {
      const initializer = parts.find((child3) => child3.type === "initializer_expression") ?? (node.type === "collection_expression" ? node : void 0);
      if (!initializer || children(initializer).length > 128 || children(initializer).some((child3) => child3.type === "spread_element"))
        return unknown(node);
      return { ...base, kind: "array", values: children(initializer).map((child3) => expression2(child3.type === "collection_element" ? children(child3)[0] ?? child3 : child3, depth + 1)), ...node.childForFieldName("type") ? { type: name(node.childForFieldName("type").text) } : {} };
    }
    if (node.type === "member_access_expression") {
      const object = node.childForFieldName("expression"), member = node.childForFieldName("name");
      return object && member ? { ...base, kind: "member", object: expression2(object, depth + 1), name: name(member.text) } : unknown(node);
    }
    if (node.type === "invocation_expression") {
      const callee = node.childForFieldName("function");
      return callee ? { ...base, kind: "call", callee: expression2(callee, depth + 1), args: args(node.childForFieldName("arguments") ?? void 0, depth + 1) } : unknown(node);
    }
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type");
      return type ? { ...base, kind: "new", type: name(type.text), args: args(node.childForFieldName("arguments") ?? void 0, depth + 1), ...parts.some((child3) => child3.type === "initializer_expression") ? { initializer: true } : {} } : unknown(node);
    }
    if (node.type === "anonymous_object_creation_expression") {
      const properties = [], entries = node.children;
      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        if (!item.isNamed || item.type === "comment")
          continue;
        if (item.type !== "identifier" || entries[i + 1]?.type !== "=" || !entries[i + 2]?.isNamed || properties.length >= 128)
          return unknown(node);
        properties.push({ name: name(item.text), value: expression2(entries[i + 2], depth + 1) });
        i += 2;
      }
      return { ...base, kind: "object", properties };
    }
    if (["lambda_expression", "anonymous_method_expression"].includes(node.type))
      return { ...base, kind: "lambda", key: lambdaKey(node) };
    if (node.type === "binary_expression") {
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      return left && right ? { ...base, kind: "binary", operator: node.childForFieldName("operator")?.text ?? "", left: expression2(left, depth + 1), right: expression2(right, depth + 1) } : unknown(node);
    }
    if (["prefix_unary_expression", "postfix_unary_expression"].includes(node.type) && parts[0])
      return { ...base, kind: "unary", operator: node.children.find((child3) => !child3.isNamed)?.text ?? "", value: expression2(parts[0], depth + 1) };
    if (node.type === "cast_expression") {
      const type = node.childForFieldName("type"), value = node.childForFieldName("value");
      return type && value ? { ...base, kind: "cast", type: name(type.text), value: expression2(value, depth + 1) } : unknown(node);
    }
    if (node.type === "typeof_expression") {
      const type = node.childForFieldName("type") ?? parts[0];
      return type ? { ...base, kind: "typeof", type: name(type.text) } : unknown(node);
    }
    return unknown(node);
  };
  const attribute = (node, target) => ({ ...site(node), type: name(node.childForFieldName("name")?.text ?? ""), args: args(children(node).find((child3) => child3.type === "attribute_argument_list")), ...target ? { target } : {} });
  const attributes = (node) => children(node).filter((child3) => child3.type === "attribute_list").flatMap((list) => children(list).filter((child3) => child3.type === "attribute").map((child3) => attribute(child3, children(list).find((child4) => child4.type === "attribute_target_specifier")?.text)));
  const parameters2 = (node) => {
    if (!node)
      return [];
    if (node.type === "implicit_parameter" || node.type === "identifier")
      return [{ name: name(node.text), modifiers: [] }];
    return children(node).filter((child3) => ["parameter", "implicit_parameter", "identifier"].includes(child3.type)).map((parameter) => {
      const identifier = parameter.childForFieldName("name") ?? (parameter.type === "identifier" || parameter.type === "implicit_parameter" ? parameter : void 0), type = parameter.childForFieldName("type"), value = children(parameter).find((child3) => child3.id !== identifier?.id && child3.id !== type?.id && !["modifier", "attribute_list"].includes(child3.type));
      return { name: name(identifier?.text ?? ""), ...attributes(parameter).length ? { attributes: attributes(parameter) } : {}, ...type ? { type: name(type.text) } : {}, modifiers: parameter.children.filter((child3) => ["ref", "out", "in", "params", "this", "scoped"].includes(child3.type) || child3.type === "modifier").map((child3) => child3.text), ...parameter.children.some((child3) => child3.type === "=") && value ? { default: expression2(value) } : {} };
    });
  };
  const scope = (node, kind, parent, owner2, namespace = parent?.namespace ?? "") => {
    const value = { ...site(node), key: "csharp-scope:" + scopeOrdinal++, kind, namespace, ...parent ? { parent: parent.key } : {}, ...owner2 ? { owner: owner2 } : {}, gaps: [], ...kind === "lambda" ? { deferred: true } : {} };
    facts.scopes.push(value);
    nodeScopes.set(node.id, value);
    return value;
  };
  const fileScope = scope(root, "file"), fileNamespace = root.namedChildren.find((child3) => child3.type === "file_scoped_namespace_declaration"), namespaceScope = fileNamespace ? scope(root, "namespace", fileScope, void 0, name(fileNamespace.childForFieldName("name")?.text ?? "")) : void 0;
  if (namespaceScope)
    namespaceScope.start = fileNamespace.endIndex;
  const globals = root.namedChildren.filter((child3) => child3.type === "global_statement");
  let topScope;
  if (globals.length) {
    const start = globals[0].startIndex, end = globals.at(-1).endIndex, base = { start, end: Math.min(end, source.text.length), range: source.range(start, end) }, key = "csharp-top-level";
    topScope = scope(root, "function", fileScope, key);
    Object.assign(topScope, base);
    facts.definitions.push({ ...base, key, name: "<top-level>", kind: "top-level", scope: fileScope.key, bodyScope: topScope.key, parameters: [], modifiers: [], typeParameters: [], attributes: [], gaps: [], hasBody: true });
    if (fileNamespace || globals.some((child3) => child3.startIndex > root.namedChildren.find((child4) => child4.type.endsWith("_declaration") && child4.type !== "file_scoped_namespace_declaration")?.startIndex))
      topScope.gaps.push("Top-level statements with namespace/preceding type declarations are invalid");
  }
  const refType = (node, current, kind = "type") => {
    if (!node)
      return;
    const type = typeNameNode(node);
    facts.references.push({ ...site(node), scope: current.key, expression: { ...site(node), kind: "name", name: type }, kind });
  };
  function typeNameNode(node) {
    return name(node.text);
  }
  const definition = (node, current, fact, kind) => {
    const key = fact?.key ?? lambdaKey(node), body3 = node.childForFieldName("body"), params = parameters2(node.childForFieldName("parameters") ?? void 0), mods = fact?.modifiers ?? node.children.filter((child3) => child3.type === "modifier" || ["static", "async"].includes(child3.type)).map((child3) => child3.text), parent = fact?.parent && declarations.find((item) => item.key === fact.parent && item.kind !== "namespace")?.key;
    const value = { ...site(node), key, name: fact?.name ?? "<lambda>", kind, scope: current.key, ...parent ? { parent } : {}, parameters: params, modifiers: mods, typeParameters: children(node).find((child3) => child3.type === "type_parameter_list")?.namedChildren.map((child3) => name(child3.childForFieldName("name")?.text ?? child3.text)) ?? [], attributes: attributes(node), gaps: [], hasBody: !!body3 };
    definitionNodes.set(value, node);
    const returnNode = node.childForFieldName("returns") ?? (!types.has(kind) && kind !== "constructor" ? node.childForFieldName("type") : null);
    if (returnNode)
      value.returnType = name(returnNode.text);
    if (mods.some((modifier) => ["extern", "unsafe"].includes(modifier)))
      value.gaps.push("External/unsafe original member requires a reviewed binding profile");
    if (node.type === "property_declaration")
      value.gaps.push("Property accessor dispatch is not an ordinary direct method");
    if (types.has(kind)) {
      const bodyScope2 = body3 ? scope(body3, "type", current, key) : void 0;
      if (bodyScope2) {
        value.typeScope = bodyScope2.key;
        params.forEach((parameter) => facts.bindings.push({ ...site(node.childForFieldName("parameters") ?? node), name: parameter.name, scope: bodyScope2.key, kind: "parameter", type: parameter.type, modifiers: parameter.modifiers }));
      }
      facts.definitions.push(value);
      return { value, body: bodyScope2 };
    }
    const bodyScope = body3 ? scope(body3, kind === "lambda" ? "lambda" : "function", current, key) : void 0;
    if (bodyScope)
      value.bodyScope = bodyScope.key;
    facts.definitions.push(value);
    if (bodyScope)
      params.forEach((parameter) => facts.bindings.push({ ...site(node.childForFieldName("parameters") ?? node), name: parameter.name, scope: bodyScope.key, kind: "parameter", type: parameter.type, modifiers: parameter.modifiers }));
    refType(returnNode ?? void 0, current);
    const parameterNodes = node.childForFieldName("parameters")?.namedChildren ?? [];
    for (const parameter of parameterNodes)
      refType(parameter.childForFieldName("type") ?? void 0, bodyScope ?? current);
    for (const annotation of value.attributes)
      facts.references.push({ ...annotation, scope: current.key, expression: { ...annotation, kind: "name", name: annotation.type }, kind: "attribute" });
    return { value, body: bodyScope };
  };
  const enclosingDeclarationSpace = (current) => {
    let found = current;
    while (found.kind === "control" && found.parent)
      found = facts.scopes.find((scope2) => scope2.key === found.parent) ?? found;
    return found;
  };
  const opaqueNames = (node, current, kind) => {
    if (node.type === "identifier") {
      if (node.text !== "_")
        facts.bindings.push({ ...site(node), name: name(node.text), scope: current.key, kind, modifiers: [] });
      return;
    }
    for (const child3 of children(node))
      opaqueNames(child3, current, kind);
  };
  const walk = (node, current) => {
    if (++nodes > 2e5 || facts.calls.length + facts.references.length + facts.bindings.length > 5e4) {
      facts.complete = false;
      return;
    }
    if (node.type === "global_attribute") {
      for (const child3 of children(node).filter((child4) => child4.type === "attribute")) {
        const annotation = attribute(child3, node.children.find((child4) => child4.type === "assembly" || child4.type === "module")?.text);
        (facts.attributes ??= []).push({ ...annotation, scope: current.key });
        facts.references.push({ ...annotation, scope: current.key, expression: { ...annotation, kind: "name", name: annotation.type }, kind: "attribute" });
      }
      return;
    }
    if (["comment", "using_directive", "file_scoped_namespace_declaration", "attribute_list"].includes(node.type) || node.type.startsWith("preproc_"))
      return;
    if (node.type === "namespace_declaration") {
      const childScope = scope(node, "namespace", current, void 0, [current.namespace, name(node.childForFieldName("name")?.text ?? "")].filter(Boolean).join("."));
      for (const child3 of node.childForFieldName("body")?.namedChildren ?? [])
        walk(child3, childScope);
      return;
    }
    if (node.type === "global_statement" && topScope) {
      for (const child3 of children(node))
        walk(child3, topScope);
      return;
    }
    const fact = bySite.get(`${node.startIndex}:${Math.min(node.endIndex, source.text.length)}`);
    if (fact?.kind === "namespace")
      return;
    if (fact && types.has(fact.kind)) {
      const result = definition(node, current, fact, fact.kind);
      for (const base of children(node).find((child3) => child3.type === "base_list")?.namedChildren ?? [])
        refType(base, current);
      for (const annotation of result.value.attributes)
        facts.references.push({ ...annotation, scope: current.key, expression: { ...annotation, kind: "name", name: annotation.type }, kind: "attribute" });
      if (result.body)
        for (const child3 of node.childForFieldName("body")?.namedChildren ?? [])
          walk(child3, result.body);
      return;
    }
    if (fact && ["method", "constructor", "function", "property"].includes(fact.kind)) {
      const result = definition(node, current, fact, fact.kind);
      if (fact.kind === "property" && node.type === "variable_declarator") {
        const typeNode = node.parent?.childForFieldName("type"), value = children(node).find((child3) => child3.id !== node.childForFieldName("name")?.id);
        result.value.returnType = typeNode ? name(typeNode.text) : void 0;
        refType(typeNode ?? void 0, current);
        if (value) {
          result.value.value = expression2(value);
          const initializer2 = scope(value, "initializer", current, fact.key);
          walk(value, initializer2);
        }
        result.value.hasBody = false;
      } else if (result.body) {
        const body3 = node.childForFieldName("body");
        if (body3.type === "block")
          for (const child3 of children(body3))
            walk(child3, result.body);
        else {
          walk(body3, result.body);
          if (body3.type === "arrow_expression_clause" && children(body3)[0])
            facts.returns.push({ ...site(body3), scope: result.body.key, value: expression2(children(body3)[0]) });
        }
      }
      const initializer = node.namedChildren.find((child3) => child3.type === "constructor_initializer");
      if (initializer) {
        result.value.gaps.push("Constructor base/this initializers require a reviewed constructor chain");
        for (const child3 of initializer.namedChildren)
          walk(child3, current);
      }
      return;
    }
    if (["lambda_expression", "anonymous_method_expression"].includes(node.type)) {
      const result = definition(node, current, void 0, "lambda");
      if (result.body) {
        const body3 = node.childForFieldName("body");
        if (body3.type === "block")
          for (const child3 of children(body3))
            walk(child3, result.body);
        else {
          walk(body3, result.body);
          facts.returns.push({ ...site(body3), scope: result.body.key, value: expression2(body3) });
        }
      }
      return;
    }
    if (node.type === "block") {
      const block = scope(node, "block", current);
      for (const child3 of children(node))
        walk(child3, block);
      return;
    }
    if (["for_statement", "foreach_statement", "if_statement", "while_statement", "do_statement", "switch_statement", "switch_section", "catch_clause", "using_statement", "lock_statement", "fixed_statement"].includes(node.type)) {
      const control = scope(node, "control", current);
      if (["fixed_statement", "using_statement"].includes(node.type))
        control.gaps.push("Using/fixed lifetime or implicit disposal is outside direct call binding");
      if (node.type === "foreach_statement") {
        const identifier = node.childForFieldName("left"), type = node.childForFieldName("type");
        if (identifier?.type === "tuple_pattern")
          opaqueNames(identifier, control, "loop");
        else if (identifier)
          facts.bindings.push({ ...site(identifier), name: name(identifier.text), scope: control.key, kind: "loop", type: type ? name(type.text) : void 0, modifiers: [] });
      }
      for (const child3 of children(node))
        walk(child3, control);
      return;
    }
    if (["declaration_pattern", "recursive_pattern", "declaration_expression", "catch_declaration"].includes(node.type)) {
      const identifier = node.childForFieldName("name"), type = node.childForFieldName("type");
      refType(type ?? void 0, current);
      if (identifier) {
        const target = node.type === "catch_declaration" ? current : enclosingDeclarationSpace(current);
        opaqueNames(identifier, target, node.type === "catch_declaration" ? "catch" : "pattern");
      }
      for (const child3 of children(node))
        if (child3.id !== identifier?.id && child3.id !== type?.id)
          walk(child3, current);
      return;
    }
    if (node.type === "variable_declaration" && node.parent?.type !== "field_declaration") {
      const type = node.childForFieldName("type");
      refType(type ?? void 0, current);
      for (const variable of children(node).filter((child3) => child3.type === "variable_declarator")) {
        const identifier = variable.childForFieldName("name"), tuple = children(variable).find((child3) => child3.type === "tuple_pattern"), value = children(variable).find((child3) => child3.id !== identifier?.id && child3.id !== tuple?.id);
        if (tuple)
          opaqueNames(tuple, current, "local");
        if (identifier)
          facts.bindings.push({ ...site(variable), name: name(identifier.text), scope: current.key, kind: "local", ...type && type.type !== "implicit_type" ? { type: name(type.text) } : {}, ...value ? { value: expression2(value) } : {}, modifiers: node.parent?.children.filter((child3) => child3.type === "modifier" || child3.type === "const").map((child3) => child3.text) ?? [] });
        if (value)
          walk(value, current);
      }
      return;
    }
    if (node.type === "assignment_expression") {
      const target = node.childForFieldName("left"), value = node.childForFieldName("right");
      if (target?.type === "tuple_expression") {
        const reserveWrites = (child3) => {
          if (child3.type === "identifier")
            facts.writes.push({ ...site(child3), scope: current.key, target: expression2(child3), operator: "deconstruction write" });
          else
            for (const part of children(child3))
              reserveWrites(part);
        };
        reserveWrites(target);
      }
      if (target)
        facts.writes.push({ ...site(node), scope: current.key, target: expression2(target), operator: node.childForFieldName("operator")?.text ?? "=", ...value ? { value: expression2(value) } : {} });
    }
    if (["prefix_unary_expression", "postfix_unary_expression"].includes(node.type) && /[+][+]|--/.test(node.text) && children(node)[0])
      facts.writes.push({ ...site(node), scope: current.key, target: expression2(children(node)[0]), operator: "mutation" });
    if (node.type === "argument" && node.children.some((child3) => ["ref", "out"].includes(child3.type)) && children(node).at(-1))
      facts.writes.push({ ...site(node), scope: current.key, target: expression2(children(node).at(-1)), operator: "ref/out" });
    if (["invocation_expression", "object_creation_expression", "implicit_object_creation_expression"].includes(node.type))
      facts.calls.push({ ...site(node), scope: current.key, expression: expression2(node) });
    if (node.type === "object_creation_expression")
      refType(node.childForFieldName("type") ?? void 0, current);
    if (node.type === "return_statement" && children(node)[0])
      facts.returns.push({ ...site(node), scope: current.key, value: expression2(children(node)[0]) });
    const parent = node.parent, memberChild = parent?.type === "member_access_expression", declarationName = parent?.childForFieldName("name")?.id === node.id;
    if (node.type === "member_access_expression" && !memberChild || node.type === "identifier" && !memberChild && !declarationName && !["qualified_name", "alias_qualified_name", "generic_name", "parameter", "type_parameter", "variable_declarator", "object_creation_expression"].includes(parent?.type ?? ""))
      facts.references.push({ ...site(node), scope: current.key, expression: expression2(node), kind: "value" });
    for (const child3 of children(node))
      walk(child3, current);
  };
  for (const node of root.namedChildren)
    walk(node, namespaceScope && node.startIndex >= namespaceScope.start ? namespaceScope : fileScope);
  const statements = (node, current) => {
    const base = { ...site(node), scope: current.key };
    if (["comment", "local_function_statement", "empty_statement"].includes(node.type))
      return [];
    if (node.type === "global_statement")
      return children(node).flatMap((child3) => statements(child3, current));
    if (node.type === "block") {
      const block = nodeScopes.get(node.id) ?? current;
      return [{ ...base, scope: block.key, kind: "block", body: children(node).flatMap((child3) => statements(child3, block)) }];
    }
    if (node.type === "local_declaration_statement")
      return [{ ...base, kind: "variable", bindings: facts.bindings.filter((binding) => binding.kind === "local" && binding.scope === current.key && binding.start >= node.startIndex && binding.end <= node.endIndex).map((binding) => binding.start) }];
    if (node.type === "expression_statement" || node.type === "return_statement") {
      const value = children(node)[0];
      return [{ ...base, kind: node.type === "return_statement" ? "return" : "expression", ...value ? { value: expression2(value), awaited: value.type === "await_expression" } : {} }];
    }
    const control = nodeScopes.get(node.id);
    if (control?.kind === "control") {
      const branches = children(node).filter((child3) => child3.type === "block" || child3.type.endsWith("_statement") || child3.type === "switch_section" || child3.type === "catch_clause").map((child3) => statements(child3, control));
      const condition = node.childForFieldName("condition");
      return [{ ...base, scope: control.key, kind: "control", control: node.type, branches, ...condition ? { value: expression2(condition) } : {} }];
    }
    return [{ ...base, kind: "opaque", text: node.text.slice(0, 300) }];
  };
  for (const [definition2, node] of definitionNodes) {
    if (!definition2.bodyScope || types.has(definition2.kind))
      continue;
    const current = facts.scopes.find((scope2) => scope2.key === definition2.bodyScope), body3 = node.childForFieldName("body");
    if (body3?.type === "block")
      definition2.statements = children(body3).flatMap((child3) => statements(child3, current));
    else if (body3)
      definition2.statements = [{ ...site(body3), scope: current.key, kind: "return", value: expression2(body3), awaited: body3.type === "await_expression" }];
  }
  const top = facts.definitions.find((definition2) => definition2.kind === "top-level");
  if (top && topScope)
    top.statements = globals.flatMap((node) => statements(node, topScope));
  facts.gaps = [...new Set(facts.gaps)].sort();
  return facts;
}

// src/analysis/tree-sitter/csharp-syntax.ts
var types2 = /* @__PURE__ */ new Set(["class", "interface", "struct", "enum", "record", "type"]);
var name2 = (text) => text.replace(/\s+/g, "").replace(/@([\p{L}_][\p{L}\p{N}_]*)/gu, "$1");
function extractCsharp(root, declarations, source) {
  const facts = { imports: [], declarations: [], namespaces: [], complete: !root.hasError, gaps: [] };
  const fileNamespace = root.namedChildren.find((node) => node.type === "file_scoped_namespace_declaration");
  const namespaceAt = (node) => {
    const segments = [];
    for (let parent = node.parent; parent; parent = parent.parent)
      if (parent.type === "namespace_declaration")
        segments.unshift(name2(parent.childForFieldName("name")?.text ?? ""));
    if (fileNamespace && node.startIndex > fileNamespace.startIndex)
      segments.unshift(name2(fileNamespace.childForFieldName("name")?.text ?? ""));
    return segments.filter(Boolean).join(".");
  };
  const nodes = /* @__PURE__ */ new Map(), stack = [root];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++visited > 2e5) {
      facts.complete = false;
      facts.gaps.push("C# syntax node budget exceeded");
      break;
    }
    nodes.set(node.startIndex, node);
    if (node.type === "identifier" && /\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}/.test(node.text))
      facts.gaps.push("Escaped C# identifiers require reviewed lexical normalization");
    if (node.type.startsWith("preproc_") && !["preproc_region", "preproc_endregion", "preproc_nullable", "preproc_pragma", "preproc_arg"].includes(node.type))
      facts.gaps.push("Conditional/preprocessor source requires a selected C# lexical profile");
    if (node.type === "extern_alias_directive")
      facts.gaps.push("Extern assembly aliases require reviewed metadata references");
    if (node.type === "using_directive") {
      const alias = node.childForFieldName("name"), target = node.namedChildren.find((child3) => child3.id !== alias?.id);
      if (!target || node.hasError)
        facts.complete = false;
      else {
        const namespace = namespaceAt(node), global = node.children.some((child3) => child3.type === "global"), isStatic = node.children.some((child3) => child3.type === "static");
        let scope;
        for (let parent = node.parent; parent; parent = parent.parent)
          if (parent.type === "namespace_declaration") {
            scope = parent;
            break;
          }
        facts.imports.push({ specifier: name2(target.text), kind: alias ? "alias" : isStatic ? "static" : "namespace", ...alias ? { alias: name2(alias.text) } : {}, global, namespace, scopeStart: scope?.startIndex ?? (namespace && fileNamespace ? fileNamespace.endIndex : 0), scopeEnd: scope?.endIndex ?? source.text.length, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
        if (global && namespace)
          facts.gaps.push("Global using inside a namespace is invalid");
        const container = node.parent?.type === "declaration_list" ? node.parent : root;
        if (container.namedChildren.some((child3) => child3.startIndex < node.startIndex && (child3.type.endsWith("_declaration") && !["using_directive", "extern_alias_directive", "file_scoped_namespace_declaration"].includes(child3.type) || global && child3.type === "using_directive" && !child3.children.some((token) => token.type === "global"))))
          facts.gaps.push("Using directive appears after declarations or ordinary usings");
      }
    }
    if (["namespace_declaration", "file_scoped_namespace_declaration"].includes(node.type))
      facts.namespaces.push({ name: [namespaceAt(node), name2(node.childForFieldName("name")?.text ?? "")].filter(Boolean).join("."), start: node.startIndex, range: source.range(node.startIndex, node.endIndex) });
    for (const child3 of [...node.namedChildren].reverse())
      stack.push(child3);
  }
  if (fileNamespace && root.namedChildren.some((node) => node.startIndex < fileNamespace.startIndex && node.type.endsWith("_declaration")))
    facts.gaps.push("File-scoped namespace follows another namespace/type declaration");
  const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
  for (const declaration of declarations) {
    if (declaration.kind === "namespace")
      continue;
    let node = nodes.get(declaration.start);
    if (!node || node.endIndex !== declaration.end)
      node = root.descendantForIndex(declaration.start, declaration.end);
    while (node && node.startIndex === declaration.start && node.endIndex !== declaration.end && node.parent)
      node = node.parent;
    if (!node) {
      facts.complete = false;
      continue;
    }
    const parent = declaration.parent ? byKey.get(declaration.parent) : void 0, parentType = parent && types2.has(parent.kind), type = types2.has(declaration.kind), modifiers4 = declaration.modifiers ?? [];
    const parameters2 = node.namedChildren.find((child3) => child3.type === "type_parameter_list")?.namedChildren.filter((child3) => child3.type === "type_parameter").length ?? 0;
    const namespace = namespaceAt(node), visibility = modifiers4.includes("protected") ? modifiers4.includes("private") ? "private protected" : modifiers4.includes("internal") ? "protected internal" : "protected" : declaration.visibility ?? (parentType ? ["interface", "enum"].includes(parent.kind) ? "public" : "private" : "internal");
    facts.declarations.push({ key: declaration.key, name: name2(declaration.name), qualifiedName: name2(declaration.qualifiedName), namespace, ...parentType ? { parent: parent.key } : {}, type, arity: parameters2, partial: modifiers4.includes("partial"), static: modifiers4.includes("static") || modifiers4.includes("const"), visibility, fileLocal: modifiers4.includes("file"), flavor: declaration.kind === "record" ? node.children.some((child3) => child3.type === "struct") ? "record-struct" : "record-class" : declaration.kind, typeParameters: node.namedChildren.find((child3) => child3.type === "type_parameter_list")?.namedChildren.map((child3) => name2(child3.childForFieldName("name")?.text ?? child3.text)) ?? [], constraints: node.namedChildren.filter((child3) => child3.type === "type_parameter_constraints_clause").map((child3) => name2(child3.text)), bases: node.namedChildren.find((child3) => child3.type === "base_list")?.namedChildren.map((child3) => name2(child3.text)) ?? [] });
  }
  facts.gaps = [...new Set(facts.gaps)].sort();
  facts.semantic = extractCsharpSemantic(root, declarations, source);
  facts.complete &&= facts.semantic.complete;
  return facts;
}

// src/analysis/languages/rust-cfg.ts
var rustIdentifier = (text) => /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(text) && text !== "_";
var rustName = (text) => text.replace(/^r#/, "");
function stringEnd(text, start) {
  const raw = /^r(#{0,255})"/.exec(text.slice(start));
  if (raw) {
    const end = text.indexOf('"' + raw[1], start + raw[0].length);
    return end < 0 ? void 0 : end + 1 + raw[1].length;
  }
  if (text[start] !== '"')
    return;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\")
      i++;
    else if (text[i] === '"')
      return i + 1;
  }
}
function rustString(text) {
  if (stringEnd(text, 0) !== text.length)
    return;
  const raw = /^r(#{0,255})"([\s\S]*)"\1$/.exec(text);
  if (raw)
    return raw[2];
  if (!text.startsWith('"') || !text.endsWith('"'))
    return;
  let result = "";
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = text[++i], basic = { n: "\n", r: "\r", t: "	", "0": "\0", "\\": "\\", '"': '"', "'": "'" };
    if (next !== void 0 && next in basic) {
      result += basic[next];
      continue;
    }
    if (next === "\n" || next === "\r" && text[i + 1] === "\n") {
      while (/\s/.test(text[i + 1] ?? "") && i < text.length - 2)
        i++;
      continue;
    }
    if (next === "x") {
      const value = /^[0-9a-fA-F]{2}/.exec(text.slice(i + 1));
      if (!value || parseInt(value[0], 16) > 127)
        return;
      result += String.fromCodePoint(parseInt(value[0], 16));
      i += 2;
      continue;
    }
    if (next === "u") {
      const value = /^\{([0-9a-fA-F_]{1,12})\}/.exec(text.slice(i + 1));
      if (!value)
        return;
      const digits = value[1].replaceAll("_", ""), point = parseInt(digits, 16);
      if (!digits || digits.length > 6 || point > 1114111 || point >= 55296 && point <= 57343)
        return;
      result += String.fromCodePoint(point);
      i += value[0].length;
      continue;
    }
    return;
  }
  return result;
}

// src/analysis/tree-sitter/rust-semantic.ts
function extractRustSemantic(root, declarations, source, syntax) {
  const facts = { definitions: [], impls: [], bindings: [], references: [], calls: [], statements: [], writes: [], returns: [], complete: syntax.complete, gaps: [] };
  const byStart = new Map(declarations.map((d) => [d.start, d])), byScope = new Map(syntax.scopes.map((s) => [s.key, s]));
  let visits = 0;
  const site = (node) => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
  const attributes = (node) => {
    const result = [];
    for (let p = node.previousNamedSibling; p?.type === "attribute_item"; p = p.previousNamedSibling)
      result.unshift(p.text);
    return result;
  };
  const visibility = (node) => node.namedChildren.find((n) => n.type === "visibility_modifier")?.text.replace(/\s+/g, "") ?? "private";
  const typeParameters = (node) => node.childForFieldName("type_parameters")?.namedChildren.map((n) => n.childForFieldName("name")?.text).filter((name3) => !!name3).map(rustName) ?? [];
  const scopeAt = (node, current) => {
    const kinds = node.type === "block" ? ["block"] : ["closure_expression", "async_block"].includes(node.type) ? ["lambda"] : ["if_expression", "while_expression", "for_expression", "match_arm"].includes(node.type) ? ["control"] : node.type === "impl_item" ? ["impl"] : node.type === "trait_item" ? ["trait"] : ["declaration_list", "enum_variant_list"].includes(node.type) ? ["module", "enum"] : [];
    return syntax.scopes.find((scope) => kinds.includes(scope.kind) && scope.start === node.startIndex && scope.end === node.endIndex) ?? current;
  };
  const textPath = (node) => {
    const text = node.text.replace(/\s+/g, ""), valid = /^(?:::)?(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*(?:::(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u.test(text);
    return valid ? { segments: text.split("::").filter(Boolean).map(rustName), absolute: text.startsWith("::") } : void 0;
  };
  function type(node, depth = 0) {
    if (!node)
      return;
    if (depth > 64)
      return { ...site(node), kind: "unknown", text: node.text };
    if (node.type === "reference_type") {
      const inner = type(node.childForFieldName("type"), depth + 1);
      return { ...site(node), kind: "reference", text: node.text, inner, mutable: node.namedChildren.some((n) => n.type === "mutable_specifier") };
    }
    if (node.type === "function_type")
      return { ...site(node), kind: "function", text: node.text };
    if (node.type === "generic_type") {
      const head = node.childForFieldName("type"), path2 = head && textPath(head);
      return { ...site(node), kind: path2 ? "path" : "unknown", text: node.text, ...path2, generics: true };
    }
    const path = textPath(node);
    return { ...site(node), kind: path ? "path" : "unknown", text: node.text, ...path };
  }
  function expression2(node, depth = 0) {
    if (!node)
      return { start: 0, end: 0, range: { startLine: 1, endLine: 1 }, kind: "unknown", text: "Missing original expression" };
    const at = site(node), unknown = () => ({ ...at, kind: "unknown", text: node.text.slice(0, 1e3) });
    if (depth > 64)
      return unknown();
    const next = (n) => expression2(n, depth + 1);
    if (node.type === "macro_invocation") {
      const macro = syntax.macros?.find((macro2) => macro2.start === node.startIndex && macro2.end === node.endIndex);
      if (macro) return { ...at, kind: "macro", path: macro.path, absolute: macro.absolute, tokens: macro.tokens, operands: macro.operands };
    }
    if (["identifier", "scoped_identifier", "type_identifier", "scoped_type_identifier", "self", "crate", "super", "primitive_type"].includes(node.type)) {
      const path = textPath(node);
      return path ? { ...at, kind: "path", ...path } : { ...at, kind: "path", segments: [], absolute: false, qualified: true };
    }
    if (node.type === "generic_function") {
      const base = next(node.childForFieldName("function"));
      return base.kind === "path" ? { ...base, ...at, generics: node.childForFieldName("type_arguments")?.namedChildren.map((n) => n.text) ?? [] } : unknown();
    }
    if (node.type === "field_expression")
      return { ...at, kind: "field", value: next(node.childForFieldName("value")), name: rustName(node.childForFieldName("field")?.text ?? "") };
    if (node.type === "call_expression")
      return { ...at, kind: "call", callee: next(node.childForFieldName("function")), args: node.childForFieldName("arguments")?.namedChildren.filter((n) => !n.type.includes("comment")).map(next) ?? [] };
    if (["closure_expression", "async_block"].includes(node.type))
      return { ...at, kind: node.type === "async_block" ? "async" : "closure", key: `${node.startIndex}:${node.endIndex}:${node.type === "async_block" ? "async" : "closure"}` };
    if (node.type === "reference_expression")
      return { ...at, kind: "reference", value: next(node.childForFieldName("value")), mutable: node.namedChildren.some((n) => n.type === "mutable_specifier") };
    if (node.type === "unary_expression" && node.text.trimStart().startsWith("*"))
      return { ...at, kind: "deref", value: next(node.namedChildren.at(-1)) };
    if (["await_expression", "parenthesized_expression", "try_expression"].includes(node.type))
      return { ...at, kind: node.type === "await_expression" ? "await" : node.type === "try_expression" ? "try" : "paren", value: next(node.namedChildren[0]) };
    if (node.type === "type_cast_expression")
      return { ...at, kind: "cast", value: next(node.childForFieldName("value")), type: type(node.childForFieldName("type")) };
    if (node.type === "struct_expression")
      return { ...at, kind: "struct", type: type(node.childForFieldName("name")), fields: (node.childForFieldName("body")?.namedChildren ?? []).filter((n) => ["field_initializer", "shorthand_field_initializer"].includes(n.type)).map((n) => ({ name: rustName(n.childForFieldName("field")?.text ?? n.text), value: next(n.childForFieldName("value") ?? n.namedChildren.at(-1)) })) };
    if (["tuple_expression", "array_expression"].includes(node.type))
      return { ...at, kind: node.type === "tuple_expression" ? "tuple" : "array", values: node.namedChildren.map(next) };
    if (node.type === "block")
      return { ...at, kind: "block", scope: scopeAt(node, syntax.scopes[0]).key };
    if (["string_literal", "raw_string_literal"].includes(node.type)) {
      const value = rustString(node.text);
      return value === void 0 ? unknown() : { ...at, kind: "literal", value };
    }
    if (node.type === "boolean_literal")
      return { ...at, kind: "literal", value: node.text === "true" };
    if (["integer_literal", "float_literal"].includes(node.type)) {
      const value = Number(node.text.replaceAll("_", "").replace(/(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))$/, ""));
      return Number.isFinite(value) ? { ...at, kind: "literal", value } : unknown();
    }
    return unknown();
  }
  const chain = (scope) => {
    const result = [];
    for (let s = scope; s && result.length < 128; s = s.parent ? byScope.get(s.parent) : void 0)
      result.push(s);
    return result;
  };
  const owner2 = (scope) => chain(scope).find((s) => s.owner)?.owner;
  const conditional = (scope) => {
    for (const s of chain(scope)) {
      if (s.kind === "control")
        return true;
      if (s.owner)
        return false;
    }
    return false;
  };
  function pattern(node, scope, activation, kind, value, annotation, mutable = false, attrs = [], gaps = [], depth = 0, projection) {
    if (!node || depth > 64)
      return;
    if (["identifier", "self", "shorthand_field_identifier"].includes(node.type)) {
      facts.bindings.push({ ...site(node), name: rustName(node.text), scope: scope.key, activation, kind, ...value ? { value } : {}, ...projection ? { projection } : {}, ...annotation ? { type: annotation } : {}, mutable, attributes: attrs, gaps });
      return;
    }
    if (node.type === "mut_pattern" || node.type === "ref_pattern" || node.type === "reference_pattern") {
      const child3 = node.namedChildren.find((n) => n.type !== "mutable_specifier");
      pattern(child3, scope, activation, kind, value, annotation, mutable || node.text.startsWith("mut "), attrs, gaps, depth + 1, projection);
      return;
    }
    if (node.type === "tuple_pattern") {
      const positional = node.children.filter((child3) => (child3.isNamed || child3.type === "_") && !child3.type.includes("comment")), rest = node.children.some((child3) => child3.text === "..");
      for (const [index, n] of positional.entries()) {
        const original = !rest && (projection ?? (value && value.kind !== "tuple" ? { value, indices: [] } : void 0));
        pattern(n, scope, activation, kind, !rest && value?.kind === "tuple" ? value.values[index] : void 0, void 0, mutable, attrs, rest ? [...gaps, "Tuple-rest Rust binding requires native tuple extent proof"] : gaps, depth + 1, original ? { ...original, indices: [...original.indices, index] } : void 0);
      }
      return;
    }
    if (node.type === "field_pattern") {
      pattern(node.childForFieldName("pattern") ?? node.namedChildren.find((n) => n.type === "shorthand_field_identifier"), scope, activation, kind, void 0, void 0, mutable, attrs, [...gaps, "Destructured Rust field value/type inference is unavailable"], depth + 1);
      return;
    }
    for (const n of node.namedChildren) {
      if (n.id === node.childForFieldName("type")?.id || n.id === node.childForFieldName("condition")?.id || ["type_identifier", "scoped_identifier", "scoped_type_identifier", "field_identifier", "mutable_specifier"].includes(n.type))
        continue;
      pattern(n, scope, activation, kind, void 0, void 0, mutable, attrs, [...gaps, "Pattern-bound Rust value/type inference is unavailable"], depth + 1);
    }
  }
  const typeReferences = (node, scope, attrs) => {
    if (!node)
      return;
    let count = 0;
    const visit = (n) => {
      if (++count > 2048)
        return;
      if (["type_identifier", "scoped_type_identifier", "generic_type", "primitive_type", "scoped_identifier"].includes(n.type)) {
        const selected = n.type === "generic_type" ? n.childForFieldName("type") : n;
        const value = expression2(selected);
        facts.references.push({ ...site(selected), scope: scope.key, expression: value, kind: "type", attributes: attrs });
        if (n.type === "generic_type")
          for (const t of n.childForFieldName("type_arguments")?.namedChildren ?? [])
            visit(t);
        return;
      }
      for (const c of n.namedChildren)
        visit(c);
    };
    visit(node);
  };
  function parameters2(node, scope, attrs) {
    const result = [];
    for (const n of node?.children.filter((child3) => child3.isNamed || child3.type === "_") ?? []) {
      if (n.type.includes("comment") || n.type === "attribute_item")
        continue;
      if (n.type === "self_parameter") {
        const text = n.text.replace(/\s+/g, ""), receiver = text === "self" || text === "mutself" ? "value" : text === "&self" ? "shared" : text === "&mutself" ? "mutable" : "opaque";
        result.push({ ...site(n), name: "self", receiver, mutable: receiver === "mutable" || text === "mutself" });
        facts.bindings.push({ ...site(n), name: "self", scope: scope.key, activation: scope.start, kind: "parameter", mutable: false, attributes: attrs, gaps: [] });
        continue;
      }
      const p = n.childForFieldName("pattern") ?? n, annotation = type(n.childForFieldName("type")), name3 = ["identifier", "self"].includes(p.type) ? rustName(p.text) : void 0, mutable = n.text.trimStart().startsWith("mut ");
      result.push({ ...site(n), ...name3 ? { name: name3 } : {}, ...annotation ? { type: annotation } : {}, mutable });
      pattern(p, scope, scope.start, "parameter", void 0, annotation, mutable, attrs);
      typeReferences(n.childForFieldName("type"), scope, attrs);
    }
    return result;
  }
  function walk(node, current, inherited = []) {
    if (++visits > 2e5 || facts.references.length + facts.calls.length > 4e4) {
      facts.complete = false;
      return;
    }
    if (["attribute_item", "inner_attribute_item", "comment", "line_comment", "block_comment", "use_declaration", "extern_crate_declaration", "macro_definition", "macro_invocation"].includes(node.type))
      return;
    const scope = scopeAt(node, current), attrs = [...inherited, ...attributes(node)];
    if (node.type === "expression_statement" && node.namedChildren[0])
      facts.statements.push({ ...site(node), scope: scope.key, expression: expression2(node.namedChildren[0]), attributes: attrs });
    if (node.type === "impl_item") {
      const selected = type(node.childForFieldName("type"));
      if (selected)
        facts.impls.push({ ...site(node), key: scope.key, scope: scope.key, parent: current.key, type: selected, ...node.childForFieldName("trait") ? { trait: type(node.childForFieldName("trait")) } : {}, generics: !!node.childForFieldName("type_parameters") || node.namedChildren.some((n) => n.type === "where_clause"), typeParameters: typeParameters(node), attributes: attrs, gaps: [] });
      typeReferences(node.childForFieldName("type"), current, attrs);
      typeReferences(node.childForFieldName("trait"), current, attrs);
      for (const n of node.childForFieldName("body")?.namedChildren ?? [])
        walk(n, scope);
      return;
    }
    const declaration = byStart.get(node.startIndex), original = declaration?.end === node.endIndex ? declaration : void 0;
    if (["function_item", "function_signature_item", "closure_expression", "async_block"].includes(node.type)) {
      const isClosure = node.type === "closure_expression" || node.type === "async_block", body3 = node.childForFieldName("body") ?? node.namedChildren.find((n) => n.type === "block"), bodyScope = isClosure ? scope : body3 ? scopeAt(body3, current) : current;
      const kind = isClosure ? node.type === "async_block" ? "async" : "closure" : original?.kind ?? "function", key = isClosure ? `${node.startIndex}:${node.endIndex}:${kind}` : original?.key;
      if (!key)
        return;
      const definition = { ...site(node), key, name: isClosure ? kind === "async" ? "<async block>" : "<closure>" : rustName(original.name), kind, scope: current.key, ...body3 ? { body: bodyScope.key } : {}, parameters: parameters2(node.childForFieldName("parameters"), bodyScope, attrs), ...node.childForFieldName("return_type") ? { returnType: type(node.childForFieldName("return_type")) } : {}, visibility: visibility(node), attributes: attrs, generics: !!node.childForFieldName("type_parameters") || node.namedChildren.some((n) => n.type === "where_clause"), async: node.type === "async_block" || !!node.children.find((n) => n.type === "async") || !!node.namedChildren.find((n) => n.type === "function_modifiers" && /\basync\b/.test(n.text)), ...["impl", "trait"].includes(current.kind) ? { impl: current.key } : {}, gaps: [] };
      facts.definitions.push(definition);
      definition.typeParameters = typeParameters(node);
      typeReferences(node.childForFieldName("return_type"), bodyScope, attrs);
      if (body3) {
        walk(body3, bodyScope);
        const tail = body3.type === "block" ? body3.namedChildren.filter((child3) => !child3.type.includes("comment")).at(-1) : body3;
        if (tail && tail.type !== "return_expression" && tail.type !== "let_declaration" && tail.type !== "empty_statement" && !tail.type.endsWith("_item") && !(tail.type === "expression_statement" && tail.text.trimEnd().endsWith(";"))) {
          const n = tail.type === "expression_statement" ? tail.namedChildren[0] : tail;
          facts.returns.push({ ...site(n), scope: scopeAt(body3, bodyScope).key, owner: key, value: expression2(n), conditional: conditional(bodyScope) });
        }
      }
      return;
    }
    if (original && ["struct", "union", "enum", "trait", "type", "constant", "static", "field", "variant"].includes(original.kind)) {
      facts.definitions.push({ ...site(node), key: original.key, name: rustName(original.name), kind: original.kind, scope: current.key, parameters: [], visibility: visibility(node), attributes: attrs, generics: !!node.childForFieldName("type_parameters") || node.namedChildren.some((n) => n.type === "where_clause"), typeParameters: typeParameters(node), async: false, ...original.parent ? { parent: original.parent } : {}, ...node.childForFieldName("type") ? { returnType: type(node.childForFieldName("type")) } : {}, ...node.childForFieldName("value") ? { value: expression2(node.childForFieldName("value")) } : {}, gaps: node.type === "static_item" && node.namedChildren.some((n) => n.type === "mutable_specifier") ? ["Mutable Rust static value is unavailable"] : [] });
      typeReferences(node.childForFieldName("type"), current, attrs);
      if (["type", "constant", "static", "field"].includes(original.kind))
        return;
    }
    if (node.type === "let_declaration") {
      const value = node.childForFieldName("value"), annotation = type(node.childForFieldName("type"));
      pattern(node.childForFieldName("pattern"), scope, node.endIndex, "local", value ? expression2(value) : void 0, annotation, node.namedChildren.some((n) => n.type === "mutable_specifier"), attrs);
      typeReferences(node.childForFieldName("type"), scope, attrs);
      if (value)
        walk(value, scope, attrs);
      for (const alternative of node.namedChildren.filter((n) => n.type === "block" || n.type === "else_clause"))
        walk(alternative, scope, attrs);
      return;
    }
    if (node.type === "let_condition") {
      const value = node.childForFieldName("value");
      if (value)
        walk(value, scope, attrs);
      pattern(node.childForFieldName("pattern"), scope, node.endIndex, "pattern", void 0, void 0, false, attrs);
      return;
    }
    if (node.type === "for_expression") {
      const value = node.childForFieldName("value");
      if (value)
        walk(value, current, attrs);
      pattern(node.childForFieldName("pattern"), scope, value?.endIndex ?? node.startIndex, "pattern", void 0, void 0, false, attrs);
      const body3 = node.childForFieldName("body");
      if (body3)
        walk(body3, scope, attrs);
      return;
    }
    if (node.type === "match_arm") {
      const p = node.childForFieldName("pattern");
      pattern(p, scope, p?.startIndex ?? node.startIndex, "pattern", void 0, void 0, false, attrs);
      const guard = p?.childForFieldName("condition");
      if (guard)
        walk(guard, scope, attrs);
      const value = node.childForFieldName("value");
      if (value)
        walk(value, scope, attrs);
      return;
    }
    if (node.type === "if_expression" || node.type === "while_expression") {
      for (const n of node.namedChildren)
        walk(n, n.type === "else_clause" ? current : scope, attrs);
      return;
    }
    if (node.type === "return_expression") {
      const key = owner2(scope), value = node.namedChildren[0];
      if (key && value)
        facts.returns.push({ ...site(node), scope: scope.key, owner: key, value: expression2(value), conditional: conditional(scope) });
      if (value)
        walk(value, scope, attrs);
      return;
    }
    if (["assignment_expression", "compound_assignment_expr"].includes(node.type)) {
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      if (left)
        facts.writes.push({ ...site(node), scope: scope.key, target: expression2(left), ...right && node.type === "assignment_expression" ? { value: expression2(right) } : {}, kind: "assignment" });
      if (right)
        walk(right, scope, attrs);
      return;
    }
    if (node.type === "reference_expression" && node.namedChildren.some((n) => n.type === "mutable_specifier"))
      facts.writes.push({ ...site(node), scope: scope.key, target: expression2(node.childForFieldName("value")), kind: "mutable-borrow" });
    if (node.type === "call_expression") {
      const value = expression2(node);
      facts.calls.push({ ...site(node), scope: scope.key, expression: value, attributes: attrs, awaited: node.parent?.type === "await_expression" });
      const fn = node.childForFieldName("function");
      if (fn) {
        facts.references.push({ ...site(fn), scope: scope.key, expression: expression2(fn), kind: "value", attributes: attrs });
        if (fn.type === "field_expression") {
          const receiver = fn.childForFieldName("value");
          if (receiver)
            walk(receiver, scope, attrs);
        } else if (!["identifier", "scoped_identifier", "generic_function", "type_identifier", "scoped_type_identifier"].includes(fn.type))
          walk(fn, scope, attrs);
      }
      for (const arg of node.childForFieldName("arguments")?.namedChildren ?? [])
        walk(arg, scope, attrs);
      return;
    }
    if (["identifier", "scoped_identifier", "self", "field_expression", "generic_function"].includes(node.type)) {
      facts.references.push({ ...site(node), scope: scope.key, expression: expression2(node), kind: "value", attributes: attrs });
      if (node.type === "field_expression") {
        const receiver = node.childForFieldName("value");
        if (receiver)
          walk(receiver, scope, attrs);
      }
      return;
    }
    if (node.type === "struct_expression") {
      typeReferences(node.childForFieldName("name"), scope, attrs);
      for (const n of node.childForFieldName("body")?.namedChildren ?? []) {
        const value = n.childForFieldName("value");
        if (value)
          walk(value, scope, attrs);
      }
      return;
    }
    for (const n of node.namedChildren)
      walk(n, scope, attrs);
  }
  for (const node of root.namedChildren)
    walk(node, syntax.scopes[0]);
  if (!facts.complete)
    facts.gaps.push("Incomplete/truncated original Rust semantic syntax");
  return facts;
}

// src/analysis/tree-sitter/rust-syntax.ts
function extractRust(root, declarations, source) {
  const facts = { scopes: [], items: [], imports: [], macros: [], complete: !root.hasError, gaps: [] };
  let visits = 0;
  const byStart = new Map(declarations.map((item) => [item.start, item]));
  const site = (node) => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
  const attributes = (node) => {
    const values = [];
    for (let s = node.previousNamedSibling; s?.type === "attribute_item"; s = s.previousNamedSibling)
      values.unshift(s.text);
    return values;
  };
  const visibility = (node) => node.namedChildren.find((n) => n.type === "visibility_modifier")?.text.replace(/\s+/g, "") ?? "private";
  function scope(node, kind, parent, module) {
    const key = kind === "file" ? "root" : `${node.startIndex}:${node.endIndex}:${kind}`;
    const value = { key, kind, ...site(node), ...parent ? { parent: parent.key } : {}, module: module ?? parent?.module ?? key, attributes: node.namedChildren.filter((n) => n.type === "inner_attribute_item").map((n) => n.text), gaps: [] };
    facts.scopes.push(value);
    return value;
  }
  function useTree(node, prefix2, base, absolute = false, depth = 0) {
    if (depth > 64 || facts.imports.length > 2e4) {
      facts.complete = false;
      return;
    }
    const emit = (segments, alias, glob = false, selfOnly2 = false) => facts.imports.push({ ...base, segments, specifier: (absolute ? "::" : "") + segments.join("::") + (glob ? "::*" : ""), absolute, ...alias ? { alias } : {}, glob, selfOnly: selfOnly2 });
    if (node.type === "use_as_clause") {
      const children = node.namedChildren;
      const target = children[0], alias = children.at(-1)?.text;
      if (!target || !alias)
        return;
      const before = facts.imports.length;
      useTree(target, prefix2, base, absolute, depth + 1);
      for (const item of facts.imports.slice(before))
        item.alias = rustName(alias);
      return;
    }
    if (node.type === "use_list") {
      for (const child3 of node.namedChildren)
        if (!["comment", "line_comment", "block_comment"].includes(child3.type))
          useTree(child3, prefix2, base, absolute, depth + 1);
      return;
    }
    if (node.type === "scoped_use_list") {
      const list = node.namedChildren.find((n) => n.type === "use_list"), path = node.namedChildren.find((n) => n.type !== "use_list");
      const parts2 = path?.text.replace(/\s+/g, "").split("::").filter(Boolean) ?? [];
      if (list)
        useTree(list, [...prefix2, ...parts2.map(rustName)], base, absolute || node.text.trimStart().startsWith("::"), depth + 1);
      return;
    }
    if (node.type === "use_wildcard") {
      const text2 = node.text.replace(/\s+/g, "").replace(/(?:::)?\*$/, "");
      absolute = absolute || text2.startsWith("::");
      emit([...prefix2, ...text2.split("::").filter(Boolean).map(rustName)], void 0, true);
      return;
    }
    const text = node.text.replace(/\s+/g, ""), parts = text.split("::").filter(Boolean).map(rustName);
    if (parts.some((part) => !rustIdentifier(part) && !["self", "super", "crate"].includes(part))) {
      emit([...prefix2, ...parts]);
      facts.imports.at(-1).gaps.push("Unreviewed Rust use tree");
      return;
    }
    const selfOnly = parts.at(-1) === "self" && (prefix2.length > 0 || parts.length > 1);
    if (selfOnly)
      parts.pop();
    emit([...prefix2, ...parts], void 0, false, selfOnly);
    facts.imports.at(-1).absolute = absolute || text.startsWith("::");
    facts.imports.at(-1).specifier = (facts.imports.at(-1).absolute ? "::" : "") + facts.imports.at(-1).segments.join("::");
  }
  const top = scope(root, "file");
  function visit(node, current, enumVisibility) {
    if (++visits > 2e5) {
      facts.complete = false;
      return;
    }
    if (["attribute_item", "inner_attribute_item", "comment", "line_comment", "block_comment"].includes(node.type))
      return;
    if (node.type === "macro_invocation") {
      const head = node.text.slice(0, node.text.indexOf("!")).replace(/\s+/g, ""), tree = node.namedChildren.find((child3) => child3.type === "token_tree");
      let operands;
      if (tree && tree.text.length <= 8192) {
        let body3 = tree.text.slice(1, -1);
        for (const comment of tree.namedChildren.filter((child3) => child3.type.includes("comment")).sort((a, b) => b.startIndex - a.startIndex)) {
          const start = comment.startIndex - tree.startIndex - 1, end = comment.endIndex - tree.startIndex - 1;
          body3 = body3.slice(0, start) + body3.slice(start, end).replace(/[^\r\n]/g, " ") + body3.slice(end);
        }
        const fields = body3.split(",");
        operands = [];
        let offset = tree.startIndex + 1;
        for (const [index, field] of fields.entries()) {
          const text = field.trim(), compact11 = text.replace(/\s+/g, "");
          if (!text && index === fields.length - 1) break;
          if (index >= 512 || !/^(?:::\s*)?(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*(?:\s*::\s*(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u.test(text)) {
            operands = void 0;
            break;
          }
          const start = offset + field.indexOf(text), end = start + text.length;
          operands.push({ start, end, range: source.range(start, end), kind: "path", segments: compact11.split("::").filter(Boolean).map(rustName), absolute: compact11.startsWith("::") });
          offset += field.length + 1;
        }
      }
      facts.macros.push({ ...site(node), scope: current.key, path: head.split("::").filter(Boolean).map(rustName), absolute: head.startsWith("::"), tokens: tree?.text.slice(0, 8193) ?? "", operands, attributes: attributes(node) });
      current.gaps.push("Rust macro invocation can supply generated/scoped items; expansion is unavailable");
      return;
    }
    if (node.type === "use_declaration") {
      const tree = node.childForFieldName("argument") ?? node.namedChildren.find((n) => n.type !== "visibility_modifier");
      if (tree)
        useTree(tree, [], { ...site(node), scope: current.key, absolute: false, visibility: visibility(node), attributes: attributes(node), kind: "use", gaps: [] });
      return;
    }
    if (node.type === "extern_crate_declaration") {
      const names2 = node.namedChildren.filter((n) => ["identifier", "self"].includes(n.type));
      const name3 = names2[0]?.text, alias = names2[1]?.text;
      if (name3)
        facts.imports.push({ ...site(node), scope: current.key, specifier: rustName(name3), segments: [rustName(name3)], absolute: false, ...alias ? { alias: rustName(alias) } : {}, glob: false, selfOnly: false, visibility: visibility(node), attributes: attributes(node), kind: "extern", gaps: [] });
      return;
    }
    const declaration = byStart.get(node.startIndex);
    let item;
    if (declaration?.end === node.endIndex && !["impl", "trait"].includes(current.kind) && ["module", "struct", "union", "enum", "trait", "type", "function", "constant", "static", "macro", "variant"].includes(declaration.kind)) {
      const namespaces = declaration.kind === "macro" ? ["macro"] : ["function", "constant", "static"].includes(declaration.kind) ? ["value"] : declaration.kind === "variant" ? ["type", "value"] : declaration.kind === "struct" && !node.namedChildren.some((n) => n.type === "field_declaration_list") ? ["type", "value"] : ["type"];
      item = { ...site(node), key: declaration.key, scope: current.key, name: rustName(declaration.name), kind: declaration.kind, namespaces, visibility: enumVisibility ?? visibility(node), attributes: attributes(node), gaps: [] };
      facts.items.push(item);
    }
    if (node.type === "mod_item") {
      if (!item)
        return;
      const body3 = node.childForFieldName("body") ?? node.namedChildren.find((n) => n.type === "declaration_list");
      if (body3) {
        const child3 = scope(body3, "module", current);
        child3.module = child3.key;
        item.memberScope = child3.key;
        for (const n of body3.namedChildren)
          visit(n, child3);
      }
      return;
    }
    if (node.type === "enum_item") {
      const body3 = node.childForFieldName("body") ?? node.namedChildren.find((n) => n.type === "enum_variant_list");
      if (body3 && item) {
        const child3 = scope(body3, "enum", current);
        item.memberScope = child3.key;
        for (const n of body3.namedChildren)
          visit(n, child3, item.visibility);
      }
      return;
    }
    if (node.type === "block") {
      const child3 = scope(node, "block", current, current.module);
      for (const n of node.namedChildren)
        visit(n, child3);
      return;
    }
    if (["impl_item", "trait_item"].includes(node.type)) {
      const child3 = scope(node, node.type === "impl_item" ? "impl" : "trait", current);
      child3.attributes.push(...attributes(node));
      const body3 = node.childForFieldName("body");
      if (body3)
        for (const n of body3.namedChildren)
          visit(n, child3);
      return;
    }
    if (["closure_expression", "async_block"].includes(node.type)) {
      const child3 = scope(node, "lambda", current);
      child3.owner = `${node.startIndex}:${node.endIndex}:${node.type === "async_block" ? "async" : "closure"}`;
      const body3 = node.childForFieldName("body") ?? node.namedChildren.find((n) => n.type === "block");
      if (body3)
        visit(body3, child3);
      return;
    }
    if (["if_expression", "while_expression", "for_expression", "match_arm"].includes(node.type)) {
      const child3 = scope(node, "control", current);
      child3.attributes.push(...attributes(node));
      for (const n of node.namedChildren)
        visit(n, n.type === "else_clause" ? current : child3);
      return;
    }
    if (node.type === "function_item") {
      const body3 = node.childForFieldName("body");
      if (body3) {
        const child3 = scope(body3, "block", current, current.module);
        child3.owner = declaration?.key;
        child3.attributes.push(...attributes(node));
        if (item)
          item.body = child3.key;
        for (const n of body3.namedChildren)
          visit(n, child3);
      }
      return;
    }
    for (const n of node.namedChildren)
      visit(n, current, enumVisibility);
  }
  for (const node of root.namedChildren)
    visit(node, top);
  if (!facts.complete)
    facts.gaps.push("Incomplete/truncated original Rust syntax");
  facts.semantic = extractRustSemantic(root, declarations, source, facts);
  return facts;
}

// src/analysis/tree-sitter/cfamily-structure.ts
var MAX_NODES3 = 2e5;
var MAX_DECLARATIONS = 2e4;
var MAX_ISSUES = 100;
var MAX_DIRECTIVES = 4096;
var compact2 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
var typeKinds2 = /* @__PURE__ */ new Map([["class_specifier", "class"], ["struct_specifier", "struct"], ["union_specifier", "union"], ["enum_specifier", "enum"], ["namespace_definition", "namespace"]]);
var callableKinds = /* @__PURE__ */ new Set(["function", "qualified-function", "method", "constructor", "destructor"]);
var scopeKinds = /* @__PURE__ */ new Set([...typeKinds2.values(), ...callableKinds]);
var directiveKinds = /* @__PURE__ */ new Set(["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_elifdef", "preproc_else", "preproc_include", "preproc_def", "preproc_function_def", "preproc_call", "preproc_undef", "preproc_linemarker"]);
var conditionKinds = /* @__PURE__ */ new Set(["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_elifdef", "preproc_else"]);
function declarator(node, depth = 0) {
  if (!node || depth > 64 || node.hasError || node.isMissing) return;
  if (node.type === "qualified_identifier") {
    const scope = node.childForFieldName("scope"), selected2 = declarator(node.childForFieldName("name") ?? void 0, depth + 1);
    if (!selected2) return;
    return { ...selected2, text: `${scope ? `${scope.text}::` : node.text.startsWith("::") ? "::" : ""}${selected2.text}` };
  }
  if (["identifier", "field_identifier", "type_identifier", "namespace_identifier", "destructor_name", "operator_name", "template_function"].includes(node.type)) return { name: node, text: node.text, display: node.text, operators: [] };
  if (node.type === "operator_cast") {
    const type = node.childForFieldName("type"), fn = node.childForFieldName("declarator");
    if (type && fn?.type === "abstract_function_declarator") return { name: type, text: `operator ${type.text}`, display: `operator ${type.text}`, operators: [fn] };
    return;
  }
  const inner = node.childForFieldName("declarator") ?? (["parenthesized_declarator", "attributed_declarator", "reference_declarator"].includes(node.type) ? node.namedChildren.find((child3) => !/attribute/.test(child3.type)) : void 0);
  const selected = declarator(inner, depth + 1);
  if (!selected) return;
  return { ...selected, operators: [...selected.operators, ...["function_declarator", "pointer_declarator", "reference_declarator", "array_declarator", "block_pointer_declarator"].includes(node.type) ? [node] : []] };
}
function owner(node) {
  return node.parent?.type === "template_declaration" ? node.parent : node;
}
function body(node) {
  return node.childForFieldName("body") ?? void 0;
}
function header(node) {
  const nested = node.type === "template_declaration" ? node.namedChildren.find((child3) => typeKinds2.has(child3.type) || child3.type === "function_definition") : void 0;
  return compact2(node.text.slice(0, (body(node)?.startIndex ?? (nested ? body(nested)?.startIndex : void 0) ?? node.endIndex) - node.startIndex));
}
function context(node) {
  const values = [];
  let depth = 0;
  for (let parent = node.parent; parent && ++depth <= 128; parent = parent.parent) if (conditionKinds.has(parent.type)) values.unshift(parent.text.split("\n")[0].trim().slice(0, 8192));
  return values;
}
function modifiers(node) {
  const values = node.namedChildren.filter((child3) => /^(?:storage_class_specifier|type_qualifier|function_specifier|explicit_function_specifier|ms_call_modifier)$/.test(child3.type)).map((child3) => child3.text);
  for (const child3 of node.children) if (["virtual", "explicit", "constexpr", "consteval", "inline", "friend", "thread_local"].includes(child3.type)) values.push(child3.text);
  if (node.parent?.type === "friend_declaration") values.push("friend");
  for (let parent = node.parent, depth = 0; parent && ++depth <= 64; parent = parent.parent) {
    if (parent.type === "linkage_specification") {
      const value = parent.childForFieldName("value");
      if (value) values.push(`extern ${value.text}`);
    }
    if (["function_definition", "class_specifier", "struct_specifier", "namespace_definition"].includes(parent.type)) break;
  }
  return [...new Set(values)];
}
function access(node, parent) {
  if (!parent || !["class", "struct", "union"].includes(parent.kind)) return;
  let member = node;
  for (let depth = 0; member.parent?.type !== "field_declaration_list" && member.parent && ++depth <= 64; ) member = member.parent;
  for (let previous = member.previousNamedSibling, count = 0; previous && ++count <= 4096; previous = previous.previousNamedSibling) if (previous.type === "access_specifier") return previous.text;
  return parent.kind === "class" ? "private" : "public";
}
function extractCfamilyStructure(root, query, language, content, seeds = []) {
  const source = new SourceText(content), issues = [], preprocessor = [], damaged = [];
  let truncated = false, visited = 0;
  const range = (node) => source.range(Math.min(node.startIndex, content.length), Math.min(node.endIndex, content.length));
  const issue = (code, reason, node) => {
    if (issues.length < MAX_ISSUES) issues.push({ code, reason, ...node ? { range: range(node) } : {} });
    else truncated = true;
  };
  const pending2 = [root];
  while (pending2.length) {
    const node = pending2.pop();
    if (++visited > MAX_NODES3) {
      truncated = true;
      break;
    }
    if (node.isError || node.isMissing) {
      damaged.push({ start: node.startIndex, end: node.endIndex });
      issue("syntax-parse-error", node.isMissing ? `Missing ${node.type}` : "Parser recovered from invalid syntax", node);
    }
    if (directiveKinds.has(node.type)) {
      if (preprocessor.length >= MAX_DIRECTIVES) truncated = true;
      else {
        const text = (conditionKinds.has(node.type) ? node.text.split("\n")[0] : content.slice(node.startIndex, node.endIndex)).trim();
        preprocessor.push({ kind: node.type, text: text.slice(0, 8192), range: range(node) });
        if (text.length > 8192) issue("syntax-extraction-gap", "Original preprocessor text exceeds the retained syntax limit", node);
      }
    }
    for (let index = node.namedChildCount - 1; index >= 0; index--) {
      const child3 = node.namedChild(index);
      if (child3) pending2.push(child3);
    }
  }
  const nodes = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") nodes.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const candidates = [...nodes.values()].sort((a, b) => owner(a).startIndex - owner(b).startIndex || b.endIndex - a.endIndex);
  const declarations = seeds.map((seed) => seed.declaration), byNode = new Map(seeds.filter((seed) => seed.scope).map((seed) => [seed.node.id, seed.declaration])), originalNodes = new Map(seeds.map((seed) => [seed.declaration.key, seed.node]));
  const parentFor = (node, friend = false) => {
    let depth = 0;
    for (let current = node.parent; current && ++depth <= 128; current = current.parent) {
      const selected = byNode.get(current.id);
      if (selected && (!friend || !["class", "struct", "union"].includes(selected.kind))) return selected;
    }
    return;
  };
  const add = (node, name3, text, kind, signature2, form, friend = false, display) => {
    if (declarations.length >= MAX_DECLARATIONS) {
      truncated = true;
      return;
    }
    const original = owner(node), headerEnd = body(node)?.startIndex ?? node.endIndex;
    if (name3?.hasError || name3?.isMissing || damaged.some((item) => item.start < headerEnd && item.end >= original.startIndex)) return;
    const parent = parentFor(node, friend), mods = modifiers(node), annotations2 = node.namedChildren.filter((child3) => /attribute/.test(child3.type)).map((child3) => child3.text), conditions = context(node);
    if (!name3) {
      mods.push("anonymous");
      annotations2.push("Anonymous original syntax scope; no identifier is synthesized");
    }
    let qualifiedName = text.startsWith("::") ? text.slice(2) : [parent?.qualifiedName, text].filter(Boolean).join("::");
    const callable2 = callableKinds.has(kind), method = kind === "function" && language === "cpp" && parent && ["class", "struct", "union"].includes(parent.kind);
    if (method) kind = text === parent.name ? "constructor" : text === `~${parent.name}` ? "destructor" : "method";
    const fact = { key: `${node.startIndex}:${node.endIndex}:${kind}:${name3?.startIndex ?? node.startIndex}`, name: display ?? (name3?.type === "qualified_identifier" ? name3.childForFieldName("name")?.text ?? text : text), qualifiedName, kind, entityType: callable2 ? kind === "function" ? "function" : "method" : kind === "property" ? "method" : "class", signature: compact2(signature2), range: range(original), start: original.startIndex, end: Math.min(original.endIndex, content.length), nameEnd: name3?.endIndex ?? Math.min(node.startIndex + node.type.split("_")[0].length, content.length), declarationForm: form, ...parent ? { parent: parent.key } : {}, ...mods.length ? { modifiers: mods } : {}, ...annotations2.length ? { annotations: annotations2 } : {}, ...conditions.length ? { sourceConditions: conditions } : {}, ...!friend && access(node, parent) ? { visibility: access(node, parent) } : {} };
    declarations.push(fact);
    originalNodes.set(fact.key, node);
    if (scopeKinds.has(kind) && body(node)) {
      byNode.set(node.id, fact);
      if (original !== node) byNode.set(original.id, fact);
    }
    return fact;
  };
  for (const node of candidates) {
    const kind = typeKinds2.get(node.type);
    if (kind) {
      const name3 = node.childForFieldName("name"), hasBody = !!body(node), standalone = node.parent?.type === "translation_unit" || ["declaration_list", "field_declaration_list", "template_declaration", "preproc_if", "preproc_else", "preproc_ifdef", "preproc_elif"].includes(node.parent?.type ?? "") || ["declaration", "field_declaration"].includes(node.parent?.type ?? "") && node.parent.childrenForFieldName("declarator").length === 0;
      if (!hasBody && !standalone) continue;
      if (!name3 && !hasBody) continue;
      add(node, name3 ?? void 0, name3?.text ?? `<anonymous ${kind}>`, kind, header(owner(node)), hasBody ? "definition" : "declaration");
      continue;
    }
    if (["alias_declaration", "namespace_alias_definition", "concept_definition", "enumerator", "preproc_def", "preproc_function_def"].includes(node.type)) {
      const name3 = node.childForFieldName("name");
      if (!name3) {
        issue("syntax-extraction-gap", "Original named declaration has no reviewed name field", node);
        continue;
      }
      const type = node.type === "alias_declaration" ? "type" : node.type === "namespace_alias_definition" ? "namespace-alias" : node.type === "concept_definition" ? "concept" : node.type === "enumerator" ? "enum-member" : "macro";
      add(node, name3, name3.text, type, header(owner(node)), type === "type" || type === "namespace-alias" ? "declaration" : "definition");
      continue;
    }
    for (const selected of node.childrenForFieldName("declarator")) {
      const selectedName = declarator(selected);
      if (!selectedName) {
        issue("syntax-extraction-gap", "Original declarator requires an additional structural profile; no name is guessed", selected);
        continue;
      }
      const name3 = selectedName.name, friend = node.parent?.type === "friend_declaration", parent = parentFor(node, friend), functionLike = selectedName.operators[0]?.type === "function_declarator" || selectedName.operators[0]?.type === "abstract_function_declarator";
      const alias = node.type === "type_definition", field = parent && ["class", "struct", "union"].includes(parent.kind), local = parent && callableKinds.has(parent.kind);
      if (local && !functionLike && !alias) continue;
      const definition = node.type === "function_definition";
      let kind2 = alias ? "type" : functionLike ? "function" : field ? "property" : "variable";
      if (language === "c" && field && functionLike) {
        kind2 = "property";
        issue("syntax-extraction-gap", "C field function syntax does not certify a callable or compiler validity", node);
      }
      const original = owner(node), prefix2 = original !== node ? original.text.slice(0, node.startIndex - original.startIndex) : "", typeNode = node.childForFieldName("type"), type = typeNode ? typeKinds2.has(typeNode.type) ? header(typeNode) : typeNode.text : "";
      add(node, name3, selectedName.text, kind2, `${prefix2}${modifiers(node).join(" ")} ${type} ${selected.text}`, definition ? "definition" : functionLike || alias || selected.type !== "init_declarator" ? "declaration" : "definition", friend, selectedName.display);
    }
  }
  const types4 = /* @__PURE__ */ new Map();
  for (const declaration of declarations) if (["class", "struct", "union"].includes(declaration.kind)) {
    const values = types4.get(declaration.qualifiedName) ?? [];
    values.push(declaration);
    types4.set(declaration.qualifiedName, values);
  }
  for (const declaration of declarations) {
    const node = originalNodes.get(declaration.key);
    if (declaration.kind !== "function" || !node.childrenForFieldName("declarator").some((item) => declarator(item)?.text.includes("::"))) continue;
    const prefix2 = declaration.qualifiedName.slice(0, declaration.qualifiedName.lastIndexOf("::")), owners2 = types4.get(prefix2) ?? [];
    if (owners2.length === 1 && JSON.stringify(owners2[0].sourceConditions ?? []) === JSON.stringify(declaration.sourceConditions ?? [])) {
      declaration.parent = owners2[0].key;
      declaration.kind = declaration.name === owners2[0].name ? "constructor" : declaration.name === `~${owners2[0].name}` ? "destructor" : "method";
      declaration.entityType = "method";
    } else {
      declaration.kind = "qualified-function";
      declaration.sourceConditions = [...declaration.sourceConditions ?? [], "Qualified C++ callable scope owner requires translation-unit/type binding"];
    }
  }
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || (a.range?.startColumn ?? 0) - (b.range?.startColumn ?? 0) || a.reason.localeCompare(b.reason));
  if (truncated) {
    if (issues.length === MAX_ISSUES) issues.pop();
    issues.push({ code: "syntax-budget-exceeded", reason: "Structural extraction reached its node, declaration, directive, diagnostic or query limit" });
  }
  return { declarations, issues, truncated, cfamily: { preprocessor, complete: !truncated && !issues.length } };
}

// src/analysis/tree-sitter/objc-structure.ts
var MAX_DECLARATIONS2 = 2e4;
var MAX_NODES4 = 2e5;
var MAX_METADATA = 4096;
var MAX_ISSUES2 = 100;
var compact3 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
var containers = /* @__PURE__ */ new Set(["class_interface", "class_implementation", "protocol_declaration"]);
var members = /* @__PURE__ */ new Set(["instance_variables", "method_declaration", "implementation_definition", "property_declaration", "declaration", "type_definition", "function_definition", "qualified_protocol_interface_declaration", "preproc_if", "preproc_ifdef", "preproc_def", "preproc_call", "preproc_undef"]);
var identifiers = /* @__PURE__ */ new Set(["identifier", "keyword_identifier"]);
function extractObjcStructure(root, query, content) {
  const source = new SourceText(content), seeds = [], byNode = /* @__PURE__ */ new Map(), issues = [], damage = [];
  const syntax = { propertyImplementations: [], moduleImports: [], complete: true };
  let truncated = false, visited = 0;
  const range = (node) => source.range(Math.min(node.startIndex, content.length), Math.min(node.endIndex, content.length));
  const issue = (reason, node) => {
    if (issues.length < MAX_ISSUES2) issues.push({ code: "syntax-extraction-gap", reason, ...node ? { range: range(node) } : {} });
    else truncated = true;
  };
  const pending2 = [root];
  while (pending2.length) {
    const node = pending2.pop();
    if (++visited > MAX_NODES4) {
      truncated = true;
      break;
    }
    if (node.isError || node.isMissing) damage.push(node);
    for (let index = node.namedChildCount - 1; index >= 0; index--) {
      const child3 = node.namedChild(index);
      if (child3) pending2.push(child3);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "objc_declaration") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const candidates = [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const parentFor = (node) => {
    let depth = 0;
    for (let current = node.parent; current && ++depth <= 128; current = current.parent) {
      const parent = byNode.get(current.id);
      if (parent) return parent;
    }
    return;
  };
  const headerEnd = (node) => {
    if (!containers.has(node.type)) return node.namedChildren.find((child3) => child3.type === "compound_statement")?.startIndex ?? node.endIndex;
    const boundary = node.children.find((child3) => members.has(child3.type) || child3.type === "@end")?.startIndex ?? node.endIndex;
    return node.children.filter((child3) => child3.startIndex < boundary && child3.type !== "comment").at(-1)?.endIndex ?? boundary;
  };
  const valid = (node, end = headerEnd(node)) => !damage.some((error) => error.startIndex < end && error.endIndex >= node.startIndex);
  const attributes = (node) => node.namedChildren.filter((child3) => /attribute/.test(child3.type)).map((child3) => child3.text);
  const add = (node, nameNode, text, kind, form, signature2, options = {}) => {
    if (seeds.length >= MAX_DECLARATIONS2) {
      truncated = true;
      return;
    }
    if (nameNode.hasError || nameNode.isMissing || !valid(node)) return;
    const parent = parentFor(node), conditions = context(node), annotations2 = [...attributes(node), ...options.annotations ?? []];
    const fact = { key: `objc:${node.startIndex}:${node.endIndex}:${kind}:${nameNode.startIndex}`, name: text, qualifiedName: [parent?.qualifiedName, `${options.dispatch ? options.dispatch === "class" ? "+" : "-" : ""}${text}`].filter(Boolean).join("::"), kind, entityType: kind === "method" || kind === "property" ? "method" : "class", signature: compact3(signature2), range: range(node), start: node.startIndex, end: Math.min(node.endIndex, content.length), nameEnd: nameNode.endIndex, declarationForm: form, ...parent ? { parent: parent.key } : {}, ...conditions.length ? { sourceConditions: conditions } : {}, ...annotations2.length ? { annotations: annotations2 } : {}, ...options.modifiers?.length ? { modifiers: options.modifiers } : {}, ...options.visibility ? { visibility: options.visibility } : {}, ...options.selector ? { selector: options.selector, dispatch: options.dispatch } : {} };
    seeds.push({ node, declaration: fact, scope: options.scope });
    if (options.scope) byNode.set(node.id, fact);
    return fact;
  };
  const originalHeader = (node) => content.slice(node.startIndex, Math.min(headerEnd(node), content.length));
  for (const node of candidates) {
    if (containers.has(node.type)) {
      const name3 = node.namedChildren.find((child3) => child3.type === "identifier");
      if (!name3) {
        issue("Original Objective-C container has no reviewed identifier; no owner is guessed", node);
        continue;
      }
      const category = node.childForFieldName("category"), extension = node.children.some((child3) => child3.type === "(") && !category;
      const text = category ? `${name3.text}(${category.text})` : extension ? `${name3.text}()` : name3.text;
      const kind = node.type === "protocol_declaration" ? "protocol" : node.type === "class_interface" ? "class-interface" : "class-implementation";
      const annotations2 = node.namedChildren.filter((child3) => ["protocol_reference_list", "parameterized_arguments"].includes(child3.type)).map((child3) => child3.text), superclass = node.childForFieldName("superclass");
      if (superclass) annotations2.push(`Original superclass syntax: ${superclass.text}`);
      add(node, name3, text, kind, node.type === "class_implementation" ? "definition" : "declaration", originalHeader(node), { scope: true, annotations: annotations2, modifiers: category ? ["category"] : extension ? ["class-extension"] : [] });
      continue;
    }
    if (node.type === "class_declaration" || node.type === "protocol_forward_declaration") {
      for (const name3 of node.namedChildren.filter((child3) => child3.type === "identifier")) add(node, name3, name3.text, node.type === "class_declaration" ? "class-forward" : "protocol-forward", "declaration", node.text);
      continue;
    }
    if (node.type === "compatibility_alias_declaration") {
      const names2 = node.namedChildren.filter((child3) => child3.type === "identifier");
      if (names2.length !== 2) {
        issue("Original compatibility alias requires two reviewed source identifiers", node);
        continue;
      }
      add(node, names2[0], names2[0].text, "class-alias", "declaration", node.text, { annotations: [`Original alias target syntax: ${names2[1].text}`] });
      continue;
    }
    if (node.type === "method_declaration" || node.type === "method_definition") {
      const dispatch = node.children.find((child3) => child3.type === "+" || child3.type === "-")?.type;
      let selector = "", part, name3;
      for (const child3 of node.namedChildren) {
        if (child3.type === "compound_statement") break;
        if (identifiers.has(child3.type)) {
          part = child3;
          name3 ??= child3;
        } else if (child3.type === "method_parameter" && child3.children.some((token) => token.type === ":")) {
          selector += `${part?.text ?? ""}:`;
          name3 ??= child3.children.find((token) => token.type === ":");
          part = void 0;
        }
      }
      if (!selector && part) selector = part.text;
      if (!name3 || !selector || !dispatch) {
        issue("Original Objective-C method has no complete reviewed selector; no name is guessed", node);
        continue;
      }
      if (!parentFor(node)) {
        issue("Original Objective-C method has no retained source container; no owner is guessed", node);
        continue;
      }
      const qualification = node.parent?.type === "qualified_protocol_interface_declaration" ? node.parent.children.find((child3) => child3.type === "@optional" || child3.type === "@required")?.text.slice(1) : void 0;
      add(node, name3, selector, "method", node.type === "method_definition" ? "definition" : "declaration", originalHeader(node), { scope: true, selector, dispatch: dispatch === "+" ? "class" : "instance", modifiers: [dispatch === "+" ? "class-method" : "instance-method", ...qualification ? [qualification] : []] });
      continue;
    }
    if (node.type === "property_declaration" || node.type === "instance_variables") {
      const declarations = [];
      const members2 = [node];
      let examined = 0;
      while (members2.length) {
        const child3 = members2.pop();
        if (++examined > MAX_NODES4) {
          truncated = true;
          break;
        }
        if (child3.type === "struct_declaration" || child3.type === "atomic_declaration") declarations.push(child3);
        else for (const nested of child3.namedChildren) members2.push(nested);
      }
      for (const declaration of declarations.sort((a, b) => a.startIndex - b.startIndex)) {
        if (!valid(declaration, declaration.endIndex)) continue;
        const conditional = context(declaration).length > 0, visibility = node.type === "instance_variables" && !conditional ? ivarVisibility(declaration, node) : void 0;
        const propertyAttributes = node.namedChildren.find((child3) => child3.type === "property_attributes_declaration")?.namedChildren.map((child3) => child3.text) ?? [];
        if (conditional && node.type === "instance_variables") propertyAttributes.push("Conditional ivar access syntax remains unevaluated");
        if (declaration.type === "atomic_declaration") {
          const name3 = declaration.namedChildren.find((child3) => ["identifier", "field_identifier"].includes(child3.type));
          if (name3) add(node.type === "property_declaration" ? node : declaration, name3, name3.text, "property", "declaration", node.type === "property_declaration" ? node.text : declaration.text, { modifiers: [node.type === "property_declaration" ? "objc-property" : "ivar"], annotations: propertyAttributes, visibility });
          else issue("Original atomic property/ivar has no reviewed name", declaration);
          continue;
        }
        const firstDeclarator = declaration.namedChildren.find((child3) => child3.type === "struct_declarator");
        for (const item of declaration.namedChildren.filter((child3) => child3.type === "struct_declarator")) {
          if (item.children[0]?.type === ":") continue;
          const original = item.namedChildren.find((child3) => !child3.type.includes("attribute") && child3.type !== "bitfield_clause"), name3 = declarator(original);
          if (!name3) {
            issue("Original Objective-C property/ivar requires an additional declarator profile; no name is guessed", item);
            continue;
          }
          const enclosing = node.type === "property_declaration" ? node : declaration, prefix2 = content.slice(enclosing.startIndex, firstDeclarator.startIndex), parent = parentFor(node);
          if (!parent) {
            issue("Original Objective-C property/ivar has no retained source container", enclosing);
            continue;
          }
          add(enclosing, name3.name, name3.display, "property", "declaration", `${prefix2}${item.text}`, { modifiers: [node.type === "property_declaration" ? "objc-property" : "ivar"], annotations: propertyAttributes, visibility });
        }
      }
      continue;
    }
    if (node.type === "property_implementation") {
      if (syntax.propertyImplementations.length >= MAX_METADATA) {
        truncated = true;
        continue;
      }
      syntax.propertyImplementations.push({ kind: node.children.some((child3) => child3.type === "@dynamic") ? "dynamic" : "synthesize", text: content.slice(node.startIndex, Math.min(node.endIndex, content.length)), names: node.namedChildren.filter((child3) => child3.type === "identifier").map((child3) => child3.text), range: range(node) });
      continue;
    }
    if (node.type === "module_import") {
      if (syntax.moduleImports.length >= MAX_METADATA) {
        truncated = true;
        continue;
      }
      syntax.moduleImports.push({ text: content.slice(node.startIndex, Math.min(node.endIndex, content.length)), path: node.childrenForFieldName("path").filter((child3) => child3.type === "identifier").map((child3) => child3.text), range: range(node) });
    }
  }
  const facts = extractCfamilyStructure(root, query, "c", content, seeds);
  facts.declarations.sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
  facts.issues.push(...issues);
  if (facts.issues.length > MAX_ISSUES2) {
    facts.issues.length = MAX_ISSUES2;
    truncated = true;
  }
  if (truncated && !facts.issues.some((issue2) => issue2.code === "syntax-budget-exceeded")) {
    if (facts.issues.length === MAX_ISSUES2) facts.issues.pop();
    facts.issues.push({ code: "syntax-budget-exceeded", reason: "Objective-C structure reached its node, declaration, syntax-metadata, diagnostic or query limit" });
  }
  facts.truncated ||= truncated;
  syntax.complete = !facts.truncated && !facts.issues.length;
  if (facts.cfamily) facts.cfamily.complete = syntax.complete;
  facts.issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.reason.localeCompare(b.reason));
  return { ...facts, objc: syntax };
}
function ivarVisibility(member, container) {
  let visibility = "protected";
  for (const node of container.namedChildren) {
    if (node.startIndex > member.startIndex) break;
    const token = node.namedChildren.find((child3) => child3.type === "visibility_specification");
    if (token) visibility = token.text.slice(1);
  }
  return visibility;
}

// src/analysis/tree-sitter/swift-structure.ts
var MAX_NODES5 = 2e5;
var MAX_DECLARATIONS3 = 2e4;
var MAX_METADATA2 = 4096;
var MAX_ISSUES3 = 100;
var compact4 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
var callableKinds2 = /* @__PURE__ */ new Set(["function", "method", "constructor", "destructor", "subscript"]);
var typeKinds3 = /* @__PURE__ */ new Set(["class", "struct", "enum", "actor", "protocol", "extension"]);
var names = /* @__PURE__ */ new Set(["simple_identifier", "type_identifier", "custom_operator"]);
var knownAttributes = /* @__PURE__ */ new Set(["attached", "freestanding", "available", "objc", "objcMembers", "MainActor", "Sendable", "preconcurrency", "inlinable", "usableFromInline", "discardableResult", "propertyWrapper", "resultBuilder", "unchecked", "escaping", "autoclosure", "convention", "noescape", "nonobjc", "frozen", "unknown", "_spi", "_alwaysEmitIntoClient", "_disfavoredOverload", "_transparent", "_specialize", "_cdecl"]);
function extractSwiftStructure(root, query, content) {
  const source = new SourceText(content), declarations = [], issues = [], syntax = { imports: [], directives: [], macroInvocations: [], complete: true };
  const damage = [], comments = [], all = [], pending2 = [root];
  let truncated = false, visited = 0;
  const range = (start, end) => source.range(Math.min(start, content.length), Math.min(end, content.length));
  const issue = (code, reason, node) => {
    if (issues.length < MAX_ISSUES3) issues.push({ code, reason, ...node ? { range: range(node.startIndex, node.endIndex) } : {} });
    else truncated = true;
  };
  while (pending2.length) {
    const node = pending2.pop();
    if (++visited > MAX_NODES5) {
      truncated = true;
      break;
    }
    all.push(node);
    if (node.isError || node.isMissing) {
      damage.push(node);
      issue("syntax-parse-error", node.isMissing ? `Missing ${node.type}` : "Swift parser recovered from invalid syntax", node);
    }
    if (/comment/.test(node.type)) comments.push(node);
    for (let n = node.childCount - 1; n >= 0; n--) {
      const child3 = node.child(n);
      if (child3) pending2.push(child3);
    }
  }
  const directives = all.filter((n) => n.type === "directive").sort((a, b) => a.startIndex - b.startIndex), contexts = [], conditions = [];
  let depth = 0;
  for (const node of directives) {
    const text = content.slice(node.startIndex, Math.min(node.endIndex, content.length));
    if (syntax.directives.length >= MAX_METADATA2) {
      truncated = true;
      break;
    }
    syntax.directives.push({ text: text.slice(0, 8192), range: range(node.startIndex, node.endIndex) });
    if (text.length > 8192) truncated = true;
    if (/^#if\b/.test(text)) {
      depth++;
      if (depth <= 128) conditions.push(text.slice(0, 8192));
      else truncated = true;
    } else if (/^#(?:elseif|else)\b/.test(text) && depth <= 128 && conditions.length) conditions[conditions.length - 1] = `${conditions.at(-1)} | ${text}`.slice(0, 8192);
    else if (/^#endif\b/.test(text)) {
      if (depth <= 128) conditions.pop();
      depth = Math.max(0, depth - 1);
    }
    contexts.push({ end: node.endIndex, values: [...conditions] });
  }
  const context2 = (start) => {
    let low = 0, high = contexts.length;
    while (low < high) {
      const middle = low + high >>> 1;
      if (contexts[middle].end <= start) low = middle + 1;
      else high = middle;
    }
    return [...contexts[low - 1]?.values ?? []];
  };
  for (const node of all) {
    if (node.type === "import_declaration") {
      if (syntax.imports.length >= MAX_METADATA2) {
        truncated = true;
        continue;
      }
      const path = node.namedChildren.find((n) => n.type === "identifier");
      if (!path || node.hasError) continue;
      const kind = node.children.find((n) => ["class", "struct", "enum", "protocol", "func", "var", "let", "typealias"].includes(n.type))?.text;
      syntax.imports.push({ text: content.slice(node.startIndex, Math.min(node.endIndex, content.length)), path: path.text, ...kind ? { kind } : {}, range: range(node.startIndex, node.endIndex) });
    } else if (node.type === "macro_invocation") {
      if (syntax.macroInvocations.length >= MAX_METADATA2) {
        truncated = true;
        continue;
      }
      const name3 = node.namedChildren.find((n) => n.type === "simple_identifier");
      if (!name3) continue;
      syntax.macroInvocations.push({ text: content.slice(node.startIndex, Math.min(node.endIndex, content.length)).slice(0, 8192), name: name3.text, range: range(node.startIndex, node.endIndex) });
      issue("swift-macro-expansion-gap", "Original Swift macro invocation retained; generated declarations and compiler-plugin expansion remain unverified", node);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const byNode = /* @__PURE__ */ new Map();
  const parentFor = (node) => {
    for (let current = node.parent, depth2 = 0; current && ++depth2 <= 128; current = current.parent) {
      const parent = byNode.get(current.id);
      if (parent) return parent;
    }
    return void 0;
  };
  const body3 = (node) => node.childForFieldName("body") ?? node.childForFieldName("computed_value") ?? node.namedChildren.find((n) => ["computed_property", "willset_didset_block"].includes(n.type));
  const header2 = (start, end) => {
    let text = "", at = start;
    for (const comment of comments.filter((c) => c.startIndex >= start && c.endIndex <= end).sort((a, b) => a.startIndex - b.startIndex)) {
      text += content.slice(at, comment.startIndex) + " ";
      at = comment.endIndex;
    }
    return compact4(text + content.slice(at, end));
  };
  const add = (node, nameNode, name3, kind, start = node.startIndex, end = node.endIndex, signatureEnd = body3(node)?.startIndex ?? end, scope = false, swiftName) => {
    if (declarations.length >= MAX_DECLARATIONS3) {
      truncated = true;
      return;
    }
    if (nameNode.isMissing || nameNode.hasError || damage.some((error) => error.startIndex < signatureEnd && error.endIndex > start)) return;
    const parent = parentFor(node), mods = node.namedChildren.filter((n) => /modifier/.test(n.type)).flatMap((n) => n.type === "modifiers" ? n.namedChildren.filter((c) => c.type !== "attribute") : [n]).map((n) => n.text);
    const attributes = node.namedChildren.flatMap((n) => n.type === "modifiers" ? n.namedChildren.filter((c) => c.type === "attribute") : n.type === "attribute" ? [n] : []), annotations2 = attributes.map((n) => n.text), sourceConditions2 = context2(start);
    for (const attr of attributes) {
      const attributeName = /^@([\w.]+)/.exec(attr.text)?.[1];
      if (attributeName && !knownAttributes.has(attributeName)) {
        sourceConditions2.push("Original Swift attribute syntax retained; attached macro/property-wrapper expansion remains unverified");
        issue("swift-attribute-expansion-gap", "Original Swift attribute may generate members; expansion and synthesized declarations remain unverified", attr);
      }
    }
    if (kind === "function" && parent && typeKinds3.has(parent.kind)) kind = "method";
    for (let current = node.parent, depth2 = 0; current && ++depth2 <= 128; current = current.parent) if (current.type === "lambda_literal") {
      sourceConditions2.push("Original named declaration inside an anonymous Swift closure; closure/type binding remains unverified");
      break;
    }
    const fact = { key: `swift:${start}:${end}:${kind}:${nameNode.startIndex}`, name: name3, qualifiedName: [parent?.qualifiedName, name3].filter(Boolean).join("."), kind, entityType: callableKinds2.has(kind) ? kind === "function" ? "function" : "method" : kind === "property" ? "method" : "class", signature: header2(start, signatureEnd), range: range(start, end), start, end: Math.min(end, content.length), nameEnd: nameNode.endIndex, declarationForm: body3(node) ? "definition" : "declaration", ...parent ? { parent: parent.key } : {}, ...mods.length ? { modifiers: mods } : {}, ...annotations2.length ? { annotations: annotations2 } : {}, ...sourceConditions2.length ? { sourceConditions: sourceConditions2 } : {}, ...swiftName ? { swiftName } : {} };
    const visibility = mods.find((m) => /^(?:open|public|package|internal|fileprivate|private)$/.test(m));
    if (visibility) fact.visibility = visibility;
    declarations.push(fact);
    if (scope) byNode.set(node.id, fact);
    return fact;
  };
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    const fields = node.childrenForFieldName("name");
    if (["class_declaration", "protocol_declaration"].includes(node.type)) {
      const token = node.children.find((n) => ["class", "struct", "enum", "actor", "extension", "protocol"].includes(n.type)), name4 = fields[0];
      if (!token || !name4) {
        issue("syntax-extraction-gap", "Swift type/extension has no reviewed original name", node);
        continue;
      }
      add(node, name4, name4.text, token.text, node.startIndex, node.endIndex, body3(node)?.startIndex ?? node.endIndex, true);
      continue;
    }
    if (["function_declaration", "protocol_function_declaration", "init_declaration", "deinit_declaration", "subscript_declaration"].includes(node.type)) {
      const keyword = node.type === "init_declaration" ? "init" : node.type === "deinit_declaration" ? "deinit" : node.type === "subscript_declaration" ? "subscript" : void 0;
      const name4 = keyword ? node.children.find((n) => n.type === keyword) : fields.find((n) => names.has(n.type) || !n.isNamed && /^[^\p{ID_Continue}\s()[\]{}:;,]+$/u.test(n.text) && n.text !== "->");
      if (!name4) {
        issue("syntax-extraction-gap", "Swift callable has no reviewed original name", node);
        continue;
      }
      const kind2 = keyword === "init" ? "constructor" : keyword === "deinit" ? "destructor" : keyword === "subscript" ? "subscript" : "function", parameters2 = node.namedChildren.filter((n) => n.type === "parameter"), labels = [];
      for (const parameter of parameters2) {
        const explicit = parameter.childForFieldName("external_name"), local = parameter.childrenForFieldName("name").find((n) => n.type === "simple_identifier");
        if (!explicit && !local) {
          issue("syntax-extraction-gap", "Swift parameter label has no reviewed original identifier", parameter);
          break;
        }
        labels.push(explicit?.text ?? (keyword === "subscript" || name4.type === "custom_operator" || !name4.isNamed ? "_" : local.text));
      }
      const nativeName = kind2 === "destructor" ? "deinit" : labels.length === parameters2.length ? `${name4.text}(${labels.map((label) => label + ":").join("")})` : void 0;
      add(node, name4, name4.text, kind2, node.startIndex, node.endIndex, body3(node)?.startIndex ?? node.endIndex, true, nativeName);
      continue;
    }
    if (["property_declaration", "protocol_property_declaration"].includes(node.type)) {
      let local = false;
      for (let current = node.parent, depth2 = 0; current && ++depth2 <= 128; current = current.parent) {
        if (["class_body", "enum_class_body", "protocol_body"].includes(current.type)) break;
        if (["statements", "lambda_literal", "function_body"].includes(current.type)) {
          local = true;
          break;
        }
      }
      if (local) continue;
      for (const pattern of fields.filter((n) => n.type === "pattern")) {
        const identifiers2 = [], pending3 = [pattern];
        while (pending3.length) {
          const part = pending3.pop();
          if (part.type === "simple_identifier") identifiers2.push(part);
          else if (part.type === "pattern") for (const nested of part.namedChildren) pending3.push(nested);
        }
        for (const name4 of identifiers2.sort((a, b) => a.startIndex - b.startIndex)) {
          const parent = parentFor(node), type = node.namedChildren.find((n) => n.type === "type_annotation" && n.startIndex >= pattern.endIndex && n.startIndex < (fields.find((p) => p.startIndex > pattern.startIndex)?.startIndex ?? node.endIndex));
          const fact2 = add(node, name4, name4.text, parent && typeKinds3.has(parent.kind) ? "property" : "variable", node.startIndex, node.endIndex, body3(node)?.startIndex ?? Math.min(node.childForFieldName("value")?.startIndex ?? node.endIndex, type?.endIndex ?? pattern.endIndex));
          if (fact2) {
            fact2.signature = compact4(`${node.namedChildren.find((n) => n.type === "value_binding_pattern")?.text ?? pattern.namedChildren.find((n) => n.type === "value_binding_pattern")?.text ?? ""} ${name4.text}${type ? type.text : ""}`);
            if (node.childForFieldName("value")) fact2.declarationForm = "definition";
          }
        }
      }
      continue;
    }
    if (node.type === "enum_entry") {
      const entries = fields.filter((n) => n.type === "simple_identifier");
      for (let at = 0; at < entries.length; at++) {
        const name4 = entries[at], next = entries[at + 1], last = node.children.filter((n) => n.startIndex >= name4.startIndex && (!next || n.endIndex <= next.startIndex) && n.type !== ",").at(-1);
        const fact2 = add(node, name4, name4.text, "enum-member", at === 0 ? node.startIndex : name4.startIndex, last?.endIndex ?? name4.endIndex, last?.endIndex ?? name4.endIndex);
        if (fact2) fact2.declarationForm = "definition";
      }
      continue;
    }
    const name3 = node.type === "macro_declaration" || node.type === "precedence_group_declaration" ? node.namedChildren.find((n) => n.type === "simple_identifier") : node.type === "operator_declaration" ? node.namedChildren.find((n) => n.type === "custom_operator" || n.type === "bang") : fields.find((n) => names.has(n.type));
    if (!name3) {
      issue("syntax-extraction-gap", "Swift named declaration requires an additional structural profile; no name is guessed", node);
      continue;
    }
    const kind = node.type === "typealias_declaration" ? "type" : node.type === "associatedtype_declaration" ? "associatedtype" : node.type === "macro_declaration" ? "macro" : node.type === "operator_declaration" ? "operator" : "precedencegroup";
    const definition = node.childForFieldName("definition");
    const fact = add(node, name3, name3.text, kind, node.startIndex, node.endIndex, definition ? node.children.find((n) => n.type === "=")?.startIndex ?? definition.startIndex : node.endIndex);
    if (fact && kind === "macro") fact.sourceConditions = [...fact.sourceConditions ?? [], "Original Swift macro declaration only; compiler-plugin expansion and generated declarations remain unverified"];
  }
  if (truncated) {
    if (issues.length >= MAX_ISSUES3) issues.pop();
    issues.push({ code: "syntax-budget-exceeded", reason: "Swift extraction reached its node, declaration, directive/context, metadata, diagnostic or query limit" });
  }
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.reason.localeCompare(b.reason));
  syntax.complete = !truncated && !issues.length;
  return { declarations, issues, truncated, swift: syntax };
}

// src/analysis/tree-sitter/scala-structure.ts
var MAX_NODES6 = 2e5;
var MAX_DECLARATIONS4 = 2e4;
var MAX_METADATA3 = 4096;
var MAX_ISSUES4 = 100;
var compact5 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
var typeKinds4 = /* @__PURE__ */ new Set(["class", "trait", "object", "package-object", "enum", "enum-member", "given"]);
var callKinds = /* @__PURE__ */ new Set(["function", "method", "constructor", "extension-method"]);
var stagedKinds = /* @__PURE__ */ new Set(["macro_body", "quote_expression", "splice_expression"]);
var modifierTokens = /* @__PURE__ */ new Set(["case", "implicit", "final", "sealed", "abstract", "override", "lazy"]);
function extractScalaStructure(root, query, content) {
  const source = new SourceText(content), declarations = [], issues = [], syntax = { packages: [], imports: [], exports: [], extensions: [], givens: [], staged: [], directives: [], complete: true };
  const all = [], damage = [], comments = [], pending2 = [root];
  let visited = 0, truncated = false;
  const range = (start, end) => source.range(Math.min(start, content.length), Math.min(end, content.length));
  const issue = (code, reason, node) => {
    if (issues.length < MAX_ISSUES4) issues.push({ code, reason, ...node ? { range: range(node.startIndex, node.endIndex) } : {} });
    else truncated = true;
  };
  while (pending2.length) {
    const node = pending2.pop();
    if (++visited > MAX_NODES6) {
      truncated = true;
      break;
    }
    all.push(node);
    if (node.isError || node.isMissing) {
      damage.push(node);
      issue("syntax-parse-error", node.isMissing ? `Missing ${node.type}` : "Scala parser recovered from invalid syntax", node);
    }
    if (/comment/.test(node.type)) comments.push(node);
    for (let at = node.childCount - 1; at >= 0; at--) {
      const child3 = node.child(at);
      if (child3) pending2.push(child3);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const byNode = /* @__PURE__ */ new Map(), packages = /* @__PURE__ */ new Map(), anonymousOwners = /* @__PURE__ */ new Set();
  for (const node of all) if (node.type === "package_clause" && !node.childForFieldName("body") && node.parent) {
    const clauses = packages.get(node.parent.id) ?? [];
    clauses.push(node);
    packages.set(node.parent.id, clauses);
  }
  for (const clauses of packages.values()) clauses.sort((a, b) => a.startIndex - b.startIndex);
  const header2 = (start, end) => {
    let text = "", at = start;
    for (const comment of comments.filter((c) => c.startIndex >= start && c.endIndex <= end).sort((a, b) => a.startIndex - b.startIndex)) {
      text += content.slice(at, comment.startIndex) + " ";
      at = comment.endIndex;
    }
    return compact5(text + content.slice(at, end));
  };
  const parentFor = (node) => {
    for (let current = node, depth = 0; current?.parent && ++depth <= 128; current = current.parent) {
      const parent = current.parent, owner2 = byNode.get(parent.id);
      if (owner2) return owner2;
      const clauses = packages.get(parent.id);
      if (clauses) {
        let low = 0, high = clauses.length;
        while (low < high) {
          const middle = low + high >>> 1;
          if (clauses[middle].startIndex < current.startIndex) low = middle + 1;
          else high = middle;
        }
        const preceding = clauses[low - 1], fact = preceding && byNode.get(preceding.id);
        if (fact) return fact;
      }
    }
    return void 0;
  };
  const ancestors = (node) => {
    const parents = [];
    for (let current = node.parent; current; current = current.parent) {
      if (parents.length === 128) {
        truncated = true;
        break;
      }
      parents.push(current);
    }
    return parents;
  };
  const boundText = (node) => {
    if (node.endIndex - node.startIndex > 8192) truncated = true;
    return content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 8192, content.length));
  };
  const append = (target, value) => {
    if (target.length >= MAX_METADATA3) truncated = true;
    else target.push(value);
  };
  const extensionHeader = (node) => {
    const end = node.children.find((n) => n.type === "{")?.startIndex ?? node.childrenForFieldName("body")[0]?.startIndex ?? node.endIndex;
    return { signature: header2(node.startIndex, end), range: range(node.startIndex, end) };
  };
  for (const node of all) {
    if (!["package_clause", "import_declaration", "export_declaration", "extension_definition", "given_definition", "using_directive", ...stagedKinds].includes(node.type)) continue;
    if (node.type === "package_clause") {
      const end = node.childForFieldName("body")?.startIndex ?? node.endIndex;
      append(syntax.packages, { text: content.slice(node.startIndex, Math.min(end, node.startIndex + 8192)), range: range(node.startIndex, end), name: node.childForFieldName("name")?.text ?? "", explicitBody: !!node.childForFieldName("body") });
      if (end - node.startIndex > 8192) truncated = true;
      continue;
    }
    const site = { text: boundText(node), range: range(node.startIndex, node.endIndex) };
    if (node.type === "import_declaration" || node.type === "export_declaration") {
      const path = node.childrenForFieldName("path").filter((n) => n.isNamed);
      append(node.type === "import_declaration" ? syntax.imports : syntax.exports, { ...site, path: path.length ? content.slice(path[0].startIndex, path.at(-1).endIndex) : "" });
    } else if (node.type === "extension_definition") {
      const h = extensionHeader(node);
      append(syntax.extensions, { ...site, signature: h.signature, headerRange: h.range });
    } else if (node.type === "given_definition") append(syntax.givens, { ...site, ...node.childForFieldName("name") ? { name: node.childForFieldName("name").text } : {}, signature: header2(node.startIndex, node.childForFieldName("body")?.startIndex ?? node.endIndex) });
    else if (stagedKinds.has(node.type)) {
      append(syntax.staged, { ...site, kind: node.type });
      issue("scala-staged-code-gap", "Original Scala macro/quote/splice syntax retained; expansion, execution and generated declarations remain unverified", node);
    } else if (node.type === "using_directive") append(syntax.directives, site);
  }
  const add = (node, nameNode, name3, kind, signatureEnd = node.childForFieldName("body")?.startIndex ?? node.childForFieldName("value")?.startIndex ?? node.endIndex, scope = false) => {
    if (declarations.length >= MAX_DECLARATIONS4) {
      truncated = true;
      return;
    }
    const parents = ancestors(node);
    if (parents.some((n) => stagedKinds.has(n.type))) return;
    if (nameNode.hasError || nameNode.isMissing || damage.some((n) => n.startIndex >= node.startIndex && n.startIndex < signatureEnd && n.endIndex >= node.startIndex)) return;
    const parent = parentFor(node), mods = node.namedChildren.filter((n) => n.type === "modifiers" || n.type === "opaque_modifier" || n.type === "access_modifier" && n.startIndex < nameNode.startIndex).flatMap((n) => n.type === "modifiers" ? n.children.filter((c) => c.isNamed || modifierTokens.has(c.type)) : [n]).map((n) => n.text), annotations2 = node.namedChildren.filter((n) => n.type === "annotation").map((n) => n.text), conditions = [];
    for (const keyword of ["case", "implicit", "final", "sealed", "abstract", "override", "lazy"]) if (node.children.some((n) => n.type === keyword) && !mods.includes(keyword)) mods.push(keyword);
    if (kind === "function" && parent && typeKinds4.has(parent.kind)) kind = "method";
    const extension = parents.find((n) => n.type === "extension_definition");
    if (extension && callKinds.has(kind)) {
      kind = "extension-method";
      conditions.push("Original Scala extension receiver/context syntax; type binding and extension dispatch remain unverified");
    }
    const anonymous = parents.find((n) => n.type === "given_definition" && !n.childForFieldName("name"));
    if (anonymous) {
      conditions.push("Original member of an anonymous Scala given; no generated owner name or implicit binding is inferred");
      if (!anonymousOwners.has(anonymous.id)) {
        anonymousOwners.add(anonymous.id);
        issue("scala-anonymous-owner-gap", "Original anonymous given members retained; lexical source has no named owner", anonymous);
      }
    }
    const instance = parents.find((n) => n.type === "instance_expression" && n.namedChildren.some((c) => ["template_body", "with_template_body"].includes(c.type)));
    if (instance) {
      conditions.push("Original member of an anonymous Scala instance; no generated class name or type binding is inferred");
      if (!anonymousOwners.has(instance.id)) {
        anonymousOwners.add(instance.id);
        issue("scala-anonymous-owner-gap", "Original anonymous instance members retained; lexical source has no named owner", instance);
      }
    }
    if (kind === "function" && (anonymous || instance)) {
      const originalOwner = parents.findIndex((n) => byNode.has(n.id)), anonymousOwner = parents.findIndex((n) => n.id === anonymous?.id || n.id === instance?.id);
      if (originalOwner < 0 || anonymousOwner < originalOwner) kind = "method";
    }
    if (parents.some((n) => n.type === "lambda_expression")) conditions.push("Original named declaration inside a Scala lambda; closure/runtime binding remains unverified");
    if (node.childForFieldName("derive")) {
      conditions.push("Original Scala derives clause retained; generated instances remain unverified");
      issue("scala-derivation-gap", "Original derives syntax does not establish generated instances", node.childForFieldName("derive"));
    }
    const originalHeader = header2(node.startIndex, signatureEnd), extensionContext = extension && callKinds.has(kind) ? extensionHeader(extension) : void 0;
    const fact = { key: `scala:${node.startIndex}:${node.endIndex}:${kind}:${nameNode.startIndex}`, name: name3, qualifiedName: [parent?.qualifiedName, name3].filter(Boolean).join("."), kind, entityType: callKinds.has(kind) ? kind === "function" ? "function" : "method" : kind === "property" ? "method" : "class", signature: extensionContext ? compact5(`${extensionContext.signature} ${originalHeader}`) : originalHeader, range: range(node.startIndex, node.endIndex), start: node.startIndex, end: Math.min(node.endIndex, content.length), nameEnd: nameNode.endIndex, declarationForm: node.childForFieldName("body") || node.childForFieldName("value") || ["class", "trait", "object", "package-object", "enum", "enum-member", "namespace"].includes(kind) || node.children.some((n) => n.type === "=") ? "definition" : "declaration", ...parent ? { parent: parent.key } : {}, ...mods.length ? { modifiers: mods } : {}, ...annotations2.length ? { annotations: annotations2 } : {}, ...conditions.length ? { sourceConditions: conditions } : {}, ...extensionContext ? { scalaExtension: extensionContext } : {} };
    const visibility = mods.find((m) => /^(?:private|protected)\b/.test(m));
    if (visibility) fact.visibility = visibility;
    declarations.push(fact);
    if (scope) byNode.set(node.id, fact);
    return fact;
  };
  const localValue = (node) => {
    for (const parent of ancestors(node)) {
      if (["template_body", "enum_body", "with_template_body", "class_definition", "trait_definition", "object_definition", "package_object"].includes(parent.type)) return false;
      if (["function_definition", "lambda_expression", "block", "indented_block", "case_clause", "enumerator"].includes(parent.type)) return true;
    }
    return false;
  };
  const bindings = (pattern) => {
    const names2 = [], queue = [pattern];
    while (queue.length) {
      const part = queue.pop();
      if (["identifier", "operator_identifier"].includes(part.type)) names2.push(part);
      else if (["tuple_pattern", "identifiers", "named_tuple_pattern"].includes(part.type)) queue.push(...part.namedChildren);
      else if (part.type === "named_pattern") {
        const value = part.namedChildren.at(-1);
        if (value) queue.push(value);
      } else if (["capture_pattern", "typed_pattern", "repeat_pattern"].includes(part.type)) {
        const name3 = part.childForFieldName("name"), nested = part.childForFieldName("pattern");
        if (name3 && name3.type !== "wildcard") names2.push(name3);
        if (nested) queue.push(nested);
      } else if (part.type === "case_class_pattern") queue.push(...part.childrenForFieldName("pattern").filter((n) => n.isNamed));
      else if (part.type === "infix_pattern") queue.push(...part.childrenForFieldName("left"), ...part.childrenForFieldName("right"));
      else if (!["wildcard", "stable_identifier", "boolean_literal", "null_literal", "integer_literal", "floating_point_literal", "character_literal", "string", "unit"].includes(part.type)) issue("scala-pattern-gap", "Scala source binding pattern requires additional qualification; no names are guessed", part);
    }
    return names2.sort((a, b) => a.startIndex - b.startIndex);
  };
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    const name3 = node.childForFieldName("name");
    if (["package_clause", "class_definition", "trait_definition", "object_definition", "package_object", "enum_definition", "simple_enum_case", "full_enum_case"].includes(node.type)) {
      if (!name3) {
        issue("syntax-extraction-gap", "Scala type/package/case lacks a reviewed original name", node);
        continue;
      }
      const kind = node.type === "package_clause" ? "namespace" : node.type === "package_object" ? "package-object" : node.type.endsWith("enum_case") ? "enum-member" : node.type.replace("_definition", "");
      add(node, name3, name3.text, kind, void 0, true);
      continue;
    }
    if (["function_definition", "function_declaration", "given_definition", "type_definition"].includes(node.type)) {
      if (!name3) {
        if (node.type !== "given_definition") issue("syntax-extraction-gap", "Scala named declaration lacks a reviewed original name", node);
        continue;
      }
      const kind = node.type === "given_definition" ? "given" : node.type === "type_definition" ? node.namedChildren.some((n) => n.type === "opaque_modifier") ? "opaque-type" : "type" : name3.text === "this" ? "constructor" : "function";
      add(node, name3, name3.text, kind, void 0, true);
      continue;
    }
    if (node.type === "class_parameter") {
      if (!name3 || !node.children.some((n) => ["val", "var"].includes(n.type))) continue;
      const owner2 = parentFor(node);
      if (!owner2 || !typeKinds4.has(owner2.kind)) continue;
      add(node, name3, name3.text, "property", node.childForFieldName("default_value")?.startIndex ?? node.endIndex);
      continue;
    }
    if (["val_definition", "var_definition", "val_declaration", "var_declaration"].includes(node.type)) {
      if (localValue(node)) continue;
      const pattern = node.childForFieldName("pattern"), names2 = pattern ? bindings(pattern) : node.childrenForFieldName("name").filter((n) => n.isNamed), type = node.childForFieldName("type"), keyword = node.type.startsWith("val") ? "val" : "var";
      for (const name4 of names2) {
        const owner2 = parentFor(node), fact = add(node, name4, name4.text, owner2 && typeKinds4.has(owner2.kind) ? "property" : "variable", type?.endIndex ?? pattern?.endIndex ?? name4.endIndex, names2.length === 1);
        if (fact) fact.signature = compact5(`${fact.modifiers?.join(" ") ?? ""} ${keyword} ${name4.text}${type ? `: ${type.text}` : ""}`);
      }
      continue;
    }
  }
  if (truncated) {
    if (issues.length >= MAX_ISSUES4) issues.pop();
    issues.push({ code: "syntax-budget-exceeded", reason: "Scala extraction reached its node, declaration, metadata, diagnostic, context or query limit" });
  }
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.reason.localeCompare(b.reason));
  syntax.complete = !truncated && !issues.length;
  return { declarations, issues, truncated, scala: syntax };
}

// src/analysis/tree-sitter/groovy-structure.ts
var MAX_NODES7 = 2e5;
var MAX_DECLARATIONS5 = 2e4;
var MAX_METADATA4 = 4096;
var MAX_ISSUES5 = 100;
var compact6 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
var modifiers2 = /* @__PURE__ */ new Set(["public", "private", "protected", "static", "final", "abstract", "synchronized", "native", "transient", "volatile", "strictfp", "sealed", "non-sealed"]);
var types3 = /* @__PURE__ */ new Set(["class", "trait", "interface", "annotation", "enum", "record"]);
var reservedNames = /* @__PURE__ */ new Set(["boolean", "byte", "char", "double", "float", "int", "long", "short", "void", "class", "interface", "trait", "enum", "def", "package", "import", "return", "throw", "throws", "new", "this", "super", "true", "false", "null", ...modifiers2]);
var transforms = /* @__PURE__ */ new Set(["Grab", "Grapes", "GrabConfig", "GrabResolver", "ASTTest", "ASTTransformation", "ASTTransformationClass", "Field", "Immutable", "ImmutableBase", "ImmutableOptions", "Canonical", "TupleConstructor", "MapConstructor", "NamedVariant", "InheritConstructors", "AutoClone", "AutoExternalize", "EqualsAndHashCode", "ToString", "Delegate", "Builder", "Lazy", "Singleton", "Memoized", "RecordType", "Sortable", "Category", "Mixin", "Newify", "BaseScript", "PackageScope", "PropertyOptions"]);
function extractGroovyStructure(root, query, content) {
  const source = new SourceText(content), declarations = [], issues = [], syntax = { packages: [], imports: [], annotations: [], dsl: [], complete: true };
  const all = [], damage = [], comments = [], pending2 = [root];
  let visited = 0, truncated = false;
  const range = (start, end) => source.range(Math.min(start, content.length), Math.min(end, content.length));
  const issue = (code, reason, node) => {
    if (issues.length < MAX_ISSUES5) issues.push({ code, reason, ...node ? { range: range(node.startIndex, node.endIndex) } : {} });
    else truncated = true;
  };
  while (pending2.length) {
    const node = pending2.pop();
    if (++visited > MAX_NODES7) {
      truncated = true;
      break;
    }
    all.push(node);
    if (node.isError || node.isMissing) {
      damage.push(node);
      issue("syntax-parse-error", node.isMissing ? `Missing ${node.type}` : "Groovy parser recovered from invalid or unqualified syntax", node);
    }
    if (/comment/.test(node.type)) comments.push(node);
    for (let at = node.childCount - 1; at >= 0; at--) {
      const child3 = node.child(at);
      if (child3) pending2.push(child3);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const byNode = /* @__PURE__ */ new Map(), unsafeBodies = new Set(all.filter((n) => ["class_body", "enum_body"].includes(n.type) && n.children.some((c) => c.isError || c.isMissing)).map((n) => n.id)), invalidHeaders = /* @__PURE__ */ new Set();
  for (const parameter of all.filter((n) => n.type === "formal_parameter" && reservedNames.has(n.childForFieldName("name")?.text ?? ""))) {
    const owner2 = parameter.parent?.parent;
    if (owner2) invalidHeaders.add(owner2.id);
    issue("groovy-header-gap", "A reserved Groovy keyword cannot establish an original parameter name; callable header omitted", parameter);
  }
  for (const body3 of all.filter((n) => unsafeBodies.has(n.id))) issue("groovy-owner-recovery-gap", "Recovered Groovy member ownership is ambiguous; retain the original type header and omit uncertain members", body3);
  const ancestors = (node) => {
    const parents = [];
    for (let current = node.parent; current; current = current.parent) {
      if (parents.length === 128) {
        truncated = true;
        break;
      }
      parents.push(current);
    }
    return parents;
  };
  const packages = all.filter((n) => n.type === "package_declaration" && n.parent?.id === root.id).sort((a, b) => a.startIndex - b.startIndex);
  if (packages.length > 1) issue("groovy-package-gap", "Multiple original package clauses require language validation; no compiler executes", packages[1]);
  const parentFor = (node) => {
    const parents = ancestors(node);
    for (const parent of parents) {
      const fact = byNode.get(parent.id);
      if (fact) return fact;
    }
    const preceding = packages.filter((p) => p.startIndex < node.startIndex).at(-1);
    return preceding ? byNode.get(preceding.id) : void 0;
  };
  const header2 = (start, end) => {
    let text = "", at = start;
    for (const comment of comments.filter((c) => c.startIndex >= start && c.endIndex <= end).sort((a, b) => a.startIndex - b.startIndex)) {
      text += content.slice(at, comment.startIndex) + " ";
      at = comment.endIndex;
    }
    return compact6(text + content.slice(at, end));
  };
  const append = (target, value) => {
    if (target.length >= MAX_METADATA4) truncated = true;
    else target.push(value);
  };
  const site = (node, end = node.endIndex) => {
    if (end - node.startIndex > 8192) truncated = true;
    return { text: content.slice(node.startIndex, Math.min(end, node.startIndex + 8192, content.length)), range: range(node.startIndex, end) };
  };
  for (const node of all) {
    if (node.type === "package_declaration") append(syntax.packages, { ...site(node), name: node.childForFieldName("name")?.text ?? "" });
    else if (node.type === "import_declaration") {
      const stat = node.children.some((c) => c.type === "static"), star = node.children.some((c) => c.type === ".*"), alias = node.childForFieldName("alias");
      append(syntax.imports, { ...site(node), path: node.childForFieldName("name")?.text ?? "", kind: stat ? star ? "static-star" : "static" : star ? "star" : "single", ...alias ? { alias: alias.text } : {} });
    } else if (node.type === "annotation") {
      const name3 = node.childForFieldName("name")?.text ?? "", generationUnverified = transforms.has(name3.split(".").at(-1));
      append(syntax.annotations, { ...site(node), name: name3, generationUnverified });
      if (generationUnverified) issue("groovy-generation-gap", "Original annotation retained; AST transformation, generated declarations and dependency loading remain unverified", node);
    } else if (["pipeline_statement", "command_chain"].includes(node.type)) {
      const end = node.childForFieldName("body")?.startIndex ?? node.namedChildren.find((c) => c.type === "closure")?.startIndex ?? node.endIndex;
      append(syntax.dsl, { ...site(node, end), kind: node.type });
    }
  }
  const add = (node, nameNode, kind, end = node.childForFieldName("body")?.startIndex ?? node.endIndex, scope = false, signature2) => {
    if (declarations.length >= MAX_DECLARATIONS5) {
      truncated = true;
      return;
    }
    const parents = ancestors(node);
    if (nameNode.hasError || nameNode.isMissing || invalidHeaders.has(node.id) || parents.some((p) => p.isError || unsafeBodies.has(p.id) || invalidHeaders.has(p.id)) || damage.some((n) => n.startIndex >= node.startIndex && n.startIndex < end && n.endIndex >= node.startIndex)) return;
    if (unsafeBodies.size && !types3.has(kind) && kind !== "namespace") return;
    const parent = parentFor(node), mods = node.children.filter((n) => modifiers2.has(n.type)).map((n) => n.text), annotations2 = node.namedChildren.filter((n) => n.type === "annotation").map((n) => n.text), conditions = [];
    if (parents.some((n) => n.type === "closure")) conditions.push("Original named declaration inside a Groovy closure; receiver/delegate and runtime binding remain unverified");
    if (annotations2.length) conditions.push("Original annotation spelling only; annotation resolution and AST transformation remain unverified");
    const uncertainBody = !!node.childForFieldName("body") && unsafeBodies.has(node.childForFieldName("body").id), sourceEnd = uncertainBody ? end : node.endIndex;
    if (uncertainBody) conditions.push("Original Groovy type header only; recovered body extent and member ownership remain unverified");
    const name3 = nameNode.text, fact = { key: `groovy:${node.startIndex}:${node.endIndex}:${kind}:${nameNode.startIndex}`, name: name3, qualifiedName: [parent?.qualifiedName, name3].filter(Boolean).join("."), kind, entityType: kind === "function" ? "function" : ["method", "constructor", "property", "field", "variable", "record-component"].includes(kind) ? "method" : "class", signature: signature2 ?? header2(node.startIndex, end), range: range(node.startIndex, sourceEnd), start: node.startIndex, end: Math.min(sourceEnd, content.length), nameEnd: nameNode.endIndex, declarationForm: uncertainBody ? "declaration" : kind === "method" || kind === "function" ? node.childForFieldName("body") ? "definition" : "declaration" : "definition", ...parent ? { parent: parent.key } : {}, ...mods.length ? { modifiers: mods } : {}, ...annotations2.length ? { annotations: annotations2 } : {}, ...conditions.length ? { sourceConditions: conditions } : {} };
    const visibility = mods.find((m) => ["public", "private", "protected"].includes(m));
    if (visibility) fact.visibility = visibility;
    declarations.push(fact);
    if (scope) byNode.set(node.id, fact);
    return fact;
  };
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    const name3 = node.childForFieldName("name");
    if (["package_declaration", "class_declaration", "trait_declaration", "interface_declaration", "annotation_type_declaration", "enum_declaration", "enum_constant", "record_declaration", "record_component"].includes(node.type)) {
      if (!name3) {
        issue("syntax-extraction-gap", "Groovy declaration lacks a reviewed original name", node);
        continue;
      }
      const kind = node.type === "package_declaration" ? "namespace" : node.type === "annotation_type_declaration" ? "annotation" : node.type === "enum_constant" ? "enum-member" : node.type === "record_component" ? "record-component" : node.type.replace("_declaration", "");
      add(node, name3, kind, void 0, node.type !== "record_component");
      continue;
    }
    if (["constructor_declaration", "method_declaration"].includes(node.type)) {
      if (!name3) {
        issue("syntax-extraction-gap", "Groovy callable lacks a reviewed original name", node);
        continue;
      }
      if (name3.type === "quoted_identifier" && name3.namedChildren.some((n) => n.type.startsWith("gstring_"))) {
        issue("groovy-dynamic-name-gap", "Interpolated Groovy callable name has no verified fixed source binding; no named declaration is guessed", name3);
        continue;
      }
      const parent = parentFor(node);
      let kind = parent && types3.has(parent.kind) ? "method" : "function";
      if (node.type === "constructor_declaration" && parent && types3.has(parent.kind) && parent.name === name3.text) kind = "constructor";
      add(node, name3, kind, void 0, true);
      continue;
    }
    if (node.type === "field_declaration" || ["local_variable_declaration", "multi_assignment_declaration"].includes(node.type)) {
      if (node.type !== "field_declaration" && node.parent?.id !== root.id) continue;
      const names2 = [...node.namedChildren.filter((n) => n.type === "variable_declarator").flatMap((n) => n.childrenForFieldName("name").filter((c) => c.isNamed)), ...node.childrenForFieldName("name").filter((n) => n.isNamed)].sort((a, b) => a.startIndex - b.startIndex);
      const type = node.childForFieldName("type");
      if (type && ["class", "trait", "interface", "enum", "record", "def", "package", "import"].includes(type.text)) continue;
      const explicitAccess = node.children.some((n) => ["public", "private", "protected"].includes(n.type));
      for (const name4 of names2) {
        const end = type?.endIndex ?? names2[0].startIndex, signature2 = compact6(`${header2(node.startIndex, end)} ${name4.text}`);
        add(node, name4, node.type === "field_declaration" ? explicitAccess ? "field" : "property" : "variable", name4.endIndex, names2.length === 1, signature2);
      }
    }
  }
  if (truncated) {
    if (issues.length >= MAX_ISSUES5) issues.pop();
    issues.push({ code: "syntax-budget-exceeded", reason: "Groovy extraction reached its node, declaration, metadata, diagnostic, context or query limit" });
  }
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.reason.localeCompare(b.reason));
  syntax.complete = !truncated && !issues.length;
  return { declarations, issues, truncated, groovy: syntax };
}

// src/analysis/tree-sitter/fsharp-structure.ts
var MAX_NODES8 = 2e5;
var MAX_DECLARATIONS6 = 2e4;
var MAX_METADATA5 = 4096;
var MAX_ISSUES6 = 100;
var compact7 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
var typeKinds5 = /* @__PURE__ */ new Set(["type", "class", "struct", "record", "union", "enum", "interface", "delegate", "type-alias", "type-extension", "exception"]);
var bodies = /* @__PURE__ */ new Set(["anon_type_defn", "record_type_defn", "union_type_defn", "enum_type_defn", "interface_type_defn", "delegate_type_defn", "type_abbrev_defn", "type_declaration", "type_extension"]);
var direct = (node, ...types4) => node.namedChildren.find((child3) => types4.includes(child3.type));
var nameOf = (node) => {
  if (!node) return;
  if (["identifier", "op_identifier", "active_pattern"].includes(node.type)) return node;
  if (node.type === "long_identifier" || node.type === "long_identifier_or_op") return node.namedChildren.length === 1 ? nameOf(node.namedChildren[0]) : void 0;
};
function extractFsharpStructure(root, query, content, signatureFile = false) {
  const source = new SourceText(content), declarations = [], issues = [], syntax = { sourceKind: signatureFile ? "signature" : "implementation", attributes: [], imports: [], directives: [], conditions: [], quotations: [], complete: true };
  const all = [], damage = [], comments = [], pending2 = [root];
  let truncated = false;
  const range = (start, end) => source.range(Math.min(start, content.length), Math.min(end, content.length));
  const issue = (code, reason, node) => {
    if (issues.length < MAX_ISSUES6) issues.push({ code, reason, ...node ? { range: range(node.startIndex, node.endIndex) } : {} });
    else truncated = true;
  };
  while (pending2.length) {
    const node = pending2.pop();
    if (all.length === MAX_NODES8) {
      truncated = true;
      break;
    }
    all.push(node);
    if (node.isError || node.isMissing) {
      damage.push(node);
      issue("syntax-parse-error", node.isMissing ? `Missing ${node.type}` : "F# parser recovered from unsupported or invalid syntax", node);
    }
    if (/comment/.test(node.type)) comments.push(node);
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) pending2.push(child3);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const byNode = /* @__PURE__ */ new Map(), unsafeOwners = /* @__PURE__ */ new Set(), ambiguousUnions = /* @__PURE__ */ new Set();
  const ancestors = (node) => {
    const parents = [];
    for (let p = node.parent; p; p = p.parent) {
      if (parents.length === 128) {
        truncated = true;
        break;
      }
      parents.push(p);
    }
    return parents;
  };
  const parentFor = (node) => {
    for (const parent of ancestors(node)) {
      const fact = byNode.get(parent.id);
      if (fact) return fact;
    }
    return void 0;
  };
  const text = (node) => {
    if (node.endIndex - node.startIndex > 8192) truncated = true;
    return content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 8192, content.length));
  };
  const append = (target, value) => {
    if (target.length === MAX_METADATA5) truncated = true;
    else target.push(value);
  };
  const header2 = (start, end) => {
    let value = "", at = start;
    for (const comment of comments.filter((n) => n.startIndex >= start && n.endIndex <= end).sort((a, b) => a.startIndex - b.startIndex)) {
      value += content.slice(at, comment.startIndex) + " ";
      at = comment.endIndex;
    }
    return compact7(value + content.slice(at, end));
  };
  const conditions = (node) => ancestors(node).reverse().filter((p) => ["preproc_if", "preproc_else", "interface_implementation", "type_extension"].includes(p.type)).map((p) => {
    if (p.type === "preproc_if") return `Original #if ${compact7(p.childForFieldName("condition")?.text ?? "")}; branch selection is unverified`;
    if (p.type === "preproc_else") return "Original #else branch; branch selection is unverified";
    return `Original ${p.type === "type_extension" ? "type extension" : "explicit interface implementation"} context; type/member binding is unverified`;
  });
  const blocked = (node) => ancestors(node).some((p) => p.isError || p.isMissing || p.type === "literal_expression" || unsafeOwners.has(p.id));
  const add = (node, nameNode, kind, start = node.startIndex, end = node.endIndex, headerEnd = end, scope = false, explicitSignature) => {
    if (declarations.length === MAX_DECLARATIONS6) {
      truncated = true;
      return;
    }
    if (blocked(node) || nameNode.hasError || nameNode.isMissing || damage.some((n) => n.startIndex < headerEnd && n.endIndex >= start)) return;
    const parent = parentFor(node), mods = node.children.filter((n) => ["access_modifier", "mutable", "inline", "rec", "static", "abstract", "override", "default"].includes(n.type)).map((n) => n.text), attributeOwner = bodies.has(node.type) && node.parent?.type === "type_definition" ? node.parent : ["function_declaration_left", "value_declaration_left"].includes(node.type) && node.parent?.type === "function_or_value_defn" ? node.parent : node, attrs = attributeOwner.namedChildren.filter((n) => n.type === "attributes").map((n) => text(n));
    const fact = { key: `fsharp:${start}:${end}:${kind}:${nameNode.startIndex}`, name: nameNode.text, qualifiedName: [parent?.qualifiedName, nameNode.text].filter(Boolean).join("."), kind, entityType: ["function", "method", "constructor", "property"].includes(kind) ? kind === "function" ? "function" : "method" : "class", signature: explicitSignature ?? header2(start, headerEnd), start, end: Math.min(end, content.length), nameEnd: nameNode.endIndex, range: range(start, end), declarationForm: signatureFile || kind === "abstract-method" || kind === "abstract-property" ? "declaration" : "definition", ...parent ? { parent: parent.key } : {}, ...mods.length ? { modifiers: mods } : {}, ...attrs.length ? { annotations: attrs } : {}, sourceConditions: [...conditions(node), ...signatureFile ? ["Original F# signature declaration; agreement with implementation/project compile order is unverified"] : []] };
    const visibility = mods.find((m) => ["private", "internal", "public"].includes(m));
    if (visibility) fact.visibility = visibility;
    declarations.push(fact);
    if (scope) byNode.set(node.id, fact);
    return fact;
  };
  const bindingName = (name3, node, explicit = false) => {
    if (!name3) {
      issue("fsharp-pattern-gap", "F# binding pattern has no independently qualified original name; no names are guessed", node);
      return;
    }
    const spelling = name3.text.replace(/^``|``$/g, "");
    if (!explicit && name3.type === "identifier" && !/^[\p{Ll}_]/u.test(spelling)) {
      issue("fsharp-pattern-gap", "Capitalized F# binding head may be a constructor/constant pattern; binding requires compiler context and is omitted", node);
      return;
    }
    return name3;
  };
  const patternNames = (pattern) => {
    if (pattern.type === "identifier_pattern") {
      const head = direct(pattern, "long_identifier_or_op");
      if (pattern.namedChildren.length !== 1) {
        issue("fsharp-pattern-gap", "Applied F# value pattern is ambiguous with a constructor pattern; names are omitted", pattern);
        return [];
      }
      const name3 = bindingName(nameOf(head), pattern);
      return name3 ? [name3] : [];
    }
    if (["paren_pattern", "repeat_pattern", "typed_pattern"].includes(pattern.type)) return pattern.namedChildren.filter((n) => n.type.endsWith("_pattern")).flatMap(patternNames);
    if (pattern.type !== "wildcard_pattern") issue("fsharp-pattern-gap", "This F# destructuring pattern requires additional qualification; no names are guessed", pattern);
    return [];
  };
  for (const node of all) {
    if (blocked(node)) continue;
    if (node.type === "attributes") {
      append(syntax.attributes, { text: text(node), range: range(node.startIndex, node.endIndex) });
    } else if (node.type === "extern_binding") {
      issue("fsharp-extern-gap", "Original external F# declaration is outside the qualified profile; native library and callable binding remain unverified", node);
    } else if (node.type === "import_decl") {
      append(syntax.imports, { text: text(node), path: direct(node, "long_identifier")?.text ?? "", range: range(node.startIndex, node.endIndex) });
    } else if (["fsi_directive_decl", "compiler_directive_decl"].includes(node.type)) {
      append(syntax.directives, { text: text(node), range: range(node.startIndex, node.endIndex) });
      if (node.children.some((n) => ["#load", "#r", "#I"].includes(n.type))) issue("fsharp-loading-gap", "Original F# load/reference/search-path directive is source only; no file, package or assembly is loaded", node);
    } else if (["preproc_if", "preproc_else"].includes(node.type)) {
      append(syntax.conditions, { text: content.slice(node.startIndex, Math.min(node.endIndex, content.indexOf("\n", node.startIndex) < 0 ? content.length : content.indexOf("\n", node.startIndex))), range: range(node.startIndex, node.endIndex) });
    } else if (node.type === "literal_expression") {
      append(syntax.quotations, { text: text(node), range: range(node.startIndex, node.endIndex) });
      issue("fsharp-quotation-gap", "Original F# quotation retained; quoted declarations, evaluation and generated code are excluded", node);
    }
  }
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    if (blocked(node)) continue;
    if (["namespace", "named_module", "module_defn", "module_abbrev"].includes(node.type)) {
      const name3 = node.childrenForFieldName("name").find((n) => n.isNamed) ?? direct(node, "identifier"), first = node.childrenForFieldName("block")[0] ?? node.namedChildren.find((n) => n.startIndex > (name3?.endIndex ?? node.endIndex) && n.type !== "attributes");
      if (name3) add(node, name3, node.type === "namespace" ? "namespace" : node.type === "module_abbrev" ? "module-alias" : "module", node.startIndex, node.endIndex, first?.startIndex ?? name3.endIndex, true);
      continue;
    }
    if (node.type === "type_definition") {
      for (const body3 of node.namedChildren.filter((n) => bodies.has(n.type))) {
        const typeName = direct(body3, "type_name"), name3 = typeName?.childForFieldName("type_name");
        if (!name3 || !typeName) continue;
        const first = body3.childrenForFieldName("block")[0] ?? direct(body3, "union_type_cases", "enum_type_cases", "type_extension_elements"), explicitType = body3.children.find((n) => ["class", "struct"].includes(n.type)), headerEnd = explicitType?.endIndex ?? first?.startIndex ?? typeName.endIndex;
        let kind = body3.type === "anon_type_defn" ? explicitType?.type ?? (direct(body3, "primary_constr_args") ? "class" : "type") : { "record_type_defn": "record", "union_type_defn": "union", "enum_type_defn": "enum", "interface_type_defn": "interface", "delegate_type_defn": "delegate", "type_abbrev_defn": "type-alias", "type_extension": "type-extension" }[body3.type] ?? "type";
        if (kind === "union") {
          const cases = direct(body3, "union_type_cases")?.namedChildren.filter((n) => n.type === "union_type_case") ?? [];
          if (cases.length === 1 && !body3.children.some((n) => n.type === "|") && !direct(body3, "union_type_cases")?.children.some((n) => n.type === "|") && !direct(cases[0], "union_type_fields") && !cases[0].children.some((n) => ["of", ":"].includes(n.type))) {
            kind = "type";
            ambiguousUnions.add(body3.id);
            issue("fsharp-type-shape-gap", "Native single bare F# union case is ambiguous with a type alias; the original type is retained and no case is invented", body3);
          }
        }
        if (body3.hasError) {
          unsafeOwners.add(body3.id);
          issue("fsharp-owner-recovery-gap", "F# type body recovery makes member ownership uncertain; only an intact original type header is retained", body3);
        }
        const fact = add(body3, name3, kind, body3.startIndex, body3.hasError ? headerEnd : body3.endIndex, ["type-alias", "delegate"].includes(kind) ? body3.endIndex : headerEnd, true);
        if (fact && body3.hasError) {
          fact.declarationForm = "declaration";
          fact.sourceConditions.push("Original type header only; body/member ownership is unverified");
        }
        if (fact) {
          const access2 = direct(typeName, "access_modifier");
          if (access2) fact.visibility = access2.text;
        }
        if (fact && kind === "type-extension") fact.sourceConditions.push("Original type extension region; no new type or logical type merging is inferred");
      }
      continue;
    }
    if (node.type === "exception_definition") {
      const name3 = node.childForFieldName("exception_name");
      if (name3) add(node, name3, "exception", node.startIndex, node.endIndex, direct(node, "type_extension_elements")?.startIndex ?? node.endIndex, true);
      continue;
    }
    if (["record_field", "union_type_case", "union_type_field", "enum_type_case"].includes(node.type)) {
      if (ancestors(node).some((n) => ambiguousUnions.has(n.id))) continue;
      const name3 = direct(node, "identifier");
      if (!name3) continue;
      if (node.type === "union_type_field" && !node.children.some((n) => n.type === ":")) continue;
      const kind = node.type === "record_field" ? "field" : node.type === "union_type_field" ? "union-field" : node.type === "union_type_case" ? "union-case" : "enum-member";
      add(node, name3, kind, node.startIndex, node.endIndex, node.children.find((n) => n.type === "=")?.startIndex ?? node.endIndex, node.type === "union_type_case");
      continue;
    }
    if (node.type === "function_or_value_defn") {
      if (signatureFile) {
        issue("fsharp-signature-shape-gap", "Implementation binding in a signature file is outside the qualified signature profile and is omitted", node);
        continue;
      }
      const lefts = node.namedChildren.filter((n) => ["function_declaration_left", "value_declaration_left"].includes(n.type)), right = node.childrenForFieldName("body");
      for (let i = 0; i < lefts.length; i++) {
        const left = lefts[i], body3 = right[i];
        if (!body3) {
          issue("fsharp-binding-gap", "F# binding has no reviewed native body; declaration omitted", left);
          continue;
        }
        const pattern = direct(left, "identifier_pattern"), applied = pattern && pattern.namedChildren.length > 1;
        if (left.type === "function_declaration_left" || applied) {
          if (ancestors(node).some((n) => ["fun_expression", "function_expression", "brace_expression", "ce_expression"].includes(n.type))) {
            issue("fsharp-closure-owner-gap", "Named F# binding inside an anonymous lambda/computation has unqualified ownership and is omitted", left);
            continue;
          }
          const name3 = bindingName(left.type === "function_declaration_left" ? direct(left, "identifier", "op_identifier", "active_pattern") : nameOf(direct(pattern, "long_identifier_or_op")), left);
          if (!name3) continue;
          const prefix2 = node.children.filter((n) => ["let", "let!", "rec", "inline", "mutable"].includes(n.type)).map((n) => n.text), fact = add(left, name3, "function", left.startIndex, body3.endIndex, body3.startIndex, true, compact7(`${prefix2.join(" ")} ${header2(left.startIndex, body3.startIndex)}`));
          if (fact) {
            byNode.set(body3.id, fact);
            fact.modifiers = [...prefix2.filter((m) => m !== "let" && m !== "let!"), ...left.children.filter((n) => ["inline", "mutable"].includes(n.type)).map((n) => n.text)];
            const access2 = direct(left, "access_modifier");
            if (access2) fact.visibility = access2.text;
          }
        } else {
          if (ancestors(node).some((n) => ["function_or_value_defn", "method_or_prop_defn", "fun_expression", "member_defn", "anon_type_defn", "brace_expression"].includes(n.type))) continue;
          const valuePattern = left.namedChildren.find((n) => n.type.endsWith("_pattern"));
          if (!valuePattern) continue;
          for (const name3 of patternNames(valuePattern)) {
            const prefix2 = node.children.filter((n) => ["let", "let!", "rec", "inline", "mutable"].includes(n.type)).map((n) => n.text), fact = add(left, name3, "variable", left.startIndex, body3.endIndex, body3.startIndex, false, compact7(`${prefix2.join(" ")} ${header2(left.startIndex, body3.startIndex)}`));
            if (fact) {
              fact.modifiers = [...prefix2.filter((m) => m !== "let" && m !== "let!"), ...left.children.filter((n) => ["inline", "mutable"].includes(n.type)).map((n) => n.text)];
              const access2 = direct(left, "access_modifier");
              if (access2) fact.visibility = access2.text;
            }
          }
        }
      }
      continue;
    }
    if (node.type === "value_definition") {
      const left = direct(node, "value_declaration_left"), pattern = left && direct(left, "identifier_pattern"), name3 = bindingName(nameOf(pattern && direct(pattern, "long_identifier_or_op")), node, true), spec = direct(node, "curried_spec");
      if (name3 && spec) add(node, name3, spec.namedChildren.some((n) => n.type === "arguments_spec") ? "function" : "variable", node.startIndex, node.endIndex, node.childForFieldName("body")?.startIndex ?? node.endIndex);
      continue;
    }
    if (node.type === "member_defn") {
      const parent = parentFor(node);
      if (!parent || !typeKinds5.has(parent.kind) || ancestors(node).some((n) => n.type === "brace_expression")) {
        issue("fsharp-anonymous-member-gap", "Original F# member has no qualified named type owner; member omitted", node);
        continue;
      }
      const method = direct(node, "method_or_prop_defn"), prop = method?.childForFieldName("name") ?? direct(node, "property_or_ident"), spec = direct(node, "member_signature"), ctor = direct(node, "additional_constr_defn");
      const name3 = prop?.childForFieldName("method") ?? (prop && direct(prop, "identifier", "op_identifier", "active_pattern")) ?? (spec && direct(spec, "identifier")) ?? ctor?.children.find((n) => n.type === "new");
      if (!name3) {
        issue("fsharp-member-gap", "F# native member name requires additional qualification; member omitted", node);
        continue;
      }
      const property = prop && !method?.childForFieldName("args"), kind = ctor ? "constructor" : spec ? direct(spec, "curried_spec")?.namedChildren.some((n) => n.type === "arguments_spec") ? "method" : "property" : property ? "property" : "method";
      const equal = (ctor ?? method ?? node).children.find((n) => n.type === "="), headerEnd = equal?.startIndex ?? method?.childrenForFieldName("block")[0]?.startIndex ?? node.endIndex;
      const accessors = method?.childrenForFieldName("block").filter((n) => n.type === "property_accessor") ?? [], accessorHeaders = accessors.map((n) => header2(n.startIndex, n.children.find((c) => c.type === "=")?.startIndex ?? n.endIndex)).join(" and ");
      const accessorTokens = node.children.filter((n) => ["with", "get", "set", ","].includes(n.type)).map((n) => n.text).join(" ");
      const fact = add(node, name3, kind, node.startIndex, node.endIndex, headerEnd, true, property ? compact7(`${header2(node.startIndex, headerEnd)} ${accessorHeaders || accessorTokens}`) : void 0);
      if (fact && spec) fact.declarationForm = "declaration";
      continue;
    }
  }
  if (truncated) {
    if (issues.length === MAX_ISSUES6) issues.pop();
    issues.push({ code: "syntax-budget-exceeded", reason: "F# extraction reached its node, declaration, metadata, diagnostic, context or query limit" });
  }
  syntax.complete = !truncated && !issues.length;
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.reason.localeCompare(b.reason));
  return { declarations, issues, truncated, fsharp: syntax };
}

// src/analysis/tree-sitter/vbnet-source.ts
var vbFold = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
var vbName = (text) => vbFold(text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text);
function vbHeader(content, start, end) {
  const tokens = [], limit = Math.min(end, content.length, start + 8192);
  let at = start, depth = 0;
  while (at < limit) {
    const begin = at, c = content[at];
    if (c === "\r" || c === "\n") {
      const continuation = tokens.at(-1)?.text === "_";
      if (continuation) tokens.pop();
      if (!depth && !continuation) return { end: begin, tokens, complete: true };
      at += c === "\r" && content[at + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (/[ \t\f\u00a0]/.test(c)) {
      at++;
      continue;
    }
    if (c === "'" || vbFold(content.slice(at, at + 3)) === "rem" && (at === start || /\s/.test(content[at - 1])) && /\s/.test(content[at + 3] ?? "")) {
      while (at < limit && !/[\r\n]/.test(content[at])) at++;
      if (!depth) return { end: begin, tokens, complete: true };
      continue;
    }
    if (c === ":" && !depth) return { end: begin, tokens, complete: true };
    let kind = "punctuation";
    if (c === '"') {
      kind = "literal";
      at++;
      let closed = false;
      while (at < limit) {
        if (content[at] === '"') {
          if (content[at + 1] === '"') {
            at += 2;
            continue;
          }
          at++;
          closed = true;
          break;
        }
        at++;
      }
      if (!closed) return { end: at, tokens, complete: false };
      if (/[cC]/.test(content[at] ?? "")) at++;
    } else if (c === "[") {
      kind = "identifier";
      at++;
      while (at < limit && content[at] !== "]" && !/[\r\n]/.test(content[at])) at++;
      if (content[at] !== "]") return { end: at, tokens, complete: false };
      at++;
    } else if (c === "#" && content.indexOf("#", at + 1) > at) {
      const close = content.indexOf("#", at + 1);
      if (close >= limit || /[\r\n]/.test(content.slice(at, close))) return { end: at, tokens, complete: false };
      kind = "literal";
      at = close + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      kind = "word";
      at++;
      while (at < limit && /[A-Za-z_0-9]/.test(content[at])) at++;
      if (/[$%&@#!]/.test(content[at] ?? "")) at++;
    } else {
      if (c === "(") depth++;
      if (c === ")") depth--;
      at++;
    }
    tokens.push({ text: content.slice(begin, at), start: begin, end: at, kind });
  }
  return { end: at, tokens, complete: at === Math.min(end, content.length) && depth === 0 && tokens.at(-1)?.text !== "_" };
}
function vbHeaderIdentity(tokens) {
  return tokens.map((t) => t.kind === "literal" ? t.text : t.kind === "identifier" ? vbName(t.text) : vbFold(t.text)).join(" ");
}

// src/analysis/tree-sitter/vbnet-structure.ts
var MAX_NODES9 = 2e5;
var MAX_DECLARATIONS7 = 2e4;
var MAX_METADATA6 = 4096;
var MAX_ISSUES7 = 100;
var owners = /* @__PURE__ */ new Map([["namespace_block", "namespace"], ["module_block", "module"], ["class_block", "class"], ["structure_block", "struct"], ["interface_block", "interface"], ["enum_block", "enum"]]);
var procedures = /* @__PURE__ */ new Set(["method_declaration", "constructor_declaration", "get_accessor", "set_accessor", "lambda_expression"]);
var reserved = new Set("AddHandler AddressOf Alias And AndAlso As Boolean ByRef Byte ByVal Call Case Catch CBool CByte CChar CDate CDbl CDec Char CInt Class CLng CObj Const Continue CSByte CShort CSng CStr CType CUInt CULng CUShort Date Decimal Declare Default Delegate Dim DirectCast Do Double Each Else ElseIf End EndIf Enum Erase Error Event Exit False Finally For Friend Function Get GetType GetXmlNamespace Global GoSub GoTo Handles If Implements Imports In Inherits Integer Interface Is IsNot Let Lib Like Long Loop Me Mod Module MustInherit MustOverride MyBase MyClass Namespace Narrowing New Next Not Nothing NotInheritable NotOverridable Object Of On Operator Option Optional Or OrElse Overloads Overridable Overrides ParamArray Partial Private Property Protected Public RaiseEvent ReadOnly ReDim REM RemoveHandler Resume Return SByte Select Set Shadows Shared Short Single Static Step Stop String Structure Sub SyncLock Then Throw To True Try TryCast TypeOf UInteger ULong UShort Using Variant Wend When While Widening With WithEvents WriteOnly Xor".split(" ").map(vbFold));
var validName = (name3) => {
  const escaped = name3.startsWith("[") && name3.endsWith("]"), suffix = !escaped && /[$%&@#!]$/.test(name3), inner = escaped ? name3.slice(1, -1) : suffix ? name3.slice(0, -1) : name3;
  return /^[\p{L}\p{Nl}][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*$/u.test(inner) || /^[\p{Pc}][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]+$/u.test(inner) ? escaped || suffix || !reserved.has(vbFold(inner)) : false;
};
var compact8 = (text) => text.replace(/\s+/g, " ").trim();
function extractVbnetStructure(root, query, content) {
  const source = new SourceText(content), declarations = [], issues = [], syntax = { options: [], imports: [], attributes: [], directives: [], projectContextUnverified: true, complete: true };
  const all = [], damage = [], pending2 = [root], byNode = /* @__PURE__ */ new Map(), unsafe = /* @__PURE__ */ new Set();
  let truncated = false;
  const range = (start, end) => source.range(Math.min(start, content.length), Math.min(end, content.length));
  const issue = (code, reason, node) => {
    if (issues.length < MAX_ISSUES7) issues.push({ code, reason, ...node ? { range: range(node.startIndex, node.endIndex) } : {} });
    else truncated = true;
  };
  const ancestors = (node) => {
    const result = [];
    for (let p = node.parent; p; p = p.parent) {
      if (result.length === 128) {
        truncated = true;
        break;
      }
      result.push(p);
    }
    return result;
  };
  while (pending2.length) {
    const node = pending2.pop();
    if (all.length === MAX_NODES9) {
      truncated = true;
      break;
    }
    all.push(node);
    if (node.isError || node.isMissing) {
      damage.push(node);
      issue("syntax-parse-error", node.isMissing ? `Missing ${node.type}` : "VB.NET parser recovered from unsupported or invalid syntax", node);
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) pending2.push(child3);
    }
  }
  const fileRecovery = damage.some((n) => !ancestors(n).some((p) => owners.has(p.type)));
  if (fileRecovery) issue("vbnet-owner-recovery-gap", "Recovery outside a qualified VB scope makes ownership uncertain; only intact outer scope headers are retained", root);
  const text = (node) => {
    if (node.endIndex - node.startIndex > 8192) truncated = true;
    return content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 8192, content.length));
  };
  const append = (target, value) => {
    if (target.length === MAX_METADATA6) truncated = true;
    else target.push(value);
  };
  for (const node of all) {
    if (node.type === "option_statements") append(syntax.options, { text: text(node), range: range(node.startIndex, node.endIndex) });
    else if (node.type === "imports_statement") append(syntax.imports, { text: text(node), paths: node.childrenForFieldName("namespace").filter((n) => !n.hasError).map((n) => n.text), range: range(node.startIndex, node.endIndex) });
    else if (node.type === "attribute_block") append(syntax.attributes, { text: text(node), range: range(node.startIndex, node.endIndex) });
    else if (node.type === "preprocessor_directive") {
      append(syntax.directives, { text: text(node), range: range(node.startIndex, node.endIndex) });
      issue("vbnet-preprocessor-gap", "Original VB conditional directive retained; no branch or project DefineConstants value is evaluated", node);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) truncated = true;
  const parentFor = (node) => ancestors(node).map((p) => byNode.get(p.id)).find(Boolean);
  const blocked = (node) => ancestors(node).some((p) => p.isError || p.isMissing || unsafe.has(p.id));
  const originalHeader = (node, end = node.endIndex) => vbHeader(content, node.startIndex, end);
  const add = (node, name3, kind, header2, scope = false, start = node.startIndex, end = node.endIndex, signature2, identityTokens = header2.tokens) => {
    if (declarations.length === MAX_DECLARATIONS7) {
      truncated = true;
      return;
    }
    if (blocked(node) || name3.hasError || name3.isMissing || !header2.complete || header2.tokens.length === 0 || header2.end - start > 1200 || vbHeaderIdentity(identityTokens).length > 1200) {
      if (!header2.complete || header2.end - start > 1200 || vbHeaderIdentity(identityTokens).length > 1200) {
        truncated = true;
        issue("vbnet-header-budget-gap", "Original VB declaration header exceeds the qualified lexical/signature budget or has an unfinished literal/continuation", node);
      }
      return;
    }
    if (damage.some((n) => n.startIndex < header2.end && n.endIndex >= start)) return;
    if (kind !== "constructor" && (kind === "namespace" ? !name3.text.split(".").every((part, i) => i === 0 && vbFold(part) === "global" || validName(part)) : !validName(name3.text))) {
      issue("vbnet-identifier-gap", "Native VB name violates the qualified original identifier profile; no declaration is guessed", node);
      return;
    }
    const parent = parentFor(node), qualifiedName = [parent?.qualifiedName, name3.text].filter(Boolean).join(".");
    if (!owners.has(node.type) && kind !== "delegate" && !parent) {
      issue("vbnet-owner-gap", "Original VB member has no qualified named type/module owner and is omitted", node);
      return;
    }
    const modifierNode = (node.type === "variable_declarator" ? node.parent : node)?.childForFieldName("modifiers"), mods = modifierNode?.namedChildren.map((n) => n.text) ?? [], conditions = ["Original VB source only; project root namespace, references and compiler binding are unverified"];
    if (mods.some((m) => vbFold(m) === "partial")) conditions.push("Original partial source fragment; no logical type/member merging is inferred");
    if (header2.tokens.some((t) => ["handles", "implements"].includes(vbFold(t.text)))) conditions.push("Original Handles/Implements clause; event/interface binding is unverified");
    if (/[^\x00-\x7f]/.test(name3.text)) conditions.push("Non-ASCII source name retained; Unicode compiler case equivalence is unverified");
    if (/[$%&@#!]$/.test(name3.text)) conditions.push("Original identifier type character retained; declared type agreement and compiler identity are unverified");
    const attributeOwner = node.parent?.type === "type_declaration" ? node.parent : node, attrs = [];
    for (let previous = attributeOwner.previousNamedSibling; previous?.type === "attribute_block"; previous = previous.previousNamedSibling) if (!previous.hasError) attrs.unshift(text(previous));
    if (attrs.length) conditions.push("Original attributes retained; compiler/generated behavior is unverified");
    const fact = { key: `vbnet:${start}:${end}:${kind}:${name3.startIndex}`, name: name3.text, qualifiedName, kind, entityType: kind === "function" ? "function" : ["method", "constructor", "property", "event"].includes(kind) ? "method" : "class", signature: signature2 ?? compact8(content.slice(node.startIndex, header2.end)), start, end: Math.min(end, content.length), nameEnd: name3.endIndex, range: range(start, end), declarationForm: "definition", sourceConditions: conditions, vbnetIdentity: { qualifiedName: [parent?.vbnetIdentity?.qualifiedName, kind === "namespace" ? name3.text.split(".").map(vbName).join(".") : vbName(name3.text)].filter(Boolean).join("."), signature: vbHeaderIdentity(identityTokens) }, ...parent ? { parent: parent.key } : {}, ...mods.length ? { modifiers: mods } : {}, ...attrs.length ? { annotations: attrs } : {} };
    const visibility = mods.filter((m) => ["public", "private", "protected", "friend"].includes(vbFold(m)));
    if (visibility.length) fact.visibility = visibility.map(vbFold).join(" ");
    declarations.push(fact);
    if (scope) byNode.set(node.id, fact);
    return fact;
  };
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    if (blocked(node)) continue;
    if (owners.has(node.type)) {
      const name4 = node.childForFieldName("name");
      if (!name4) continue;
      const header3 = originalHeader(node), recovered = node.hasError || fileRecovery;
      const fact2 = add(node, name4, owners.get(node.type), header3, true, node.startIndex, recovered ? header3.end : node.endIndex);
      if (recovered) {
        unsafe.add(node.id);
        issue("vbnet-owner-recovery-gap", "VB scope body recovery makes original member ownership uncertain; only an intact source header is retained", node);
        if (fact2) {
          fact2.declarationForm = "declaration";
          fact2.sourceConditions.push("Original scope header only; body/member ownership is unverified");
        }
      }
      continue;
    }
    if (fileRecovery || ancestors(node).some((p) => procedures.has(p.type) || p.type === "statement")) continue;
    if (node.hasError) {
      issue("vbnet-declaration-recovery-gap", "Damaged original VB declaration is omitted", node);
      continue;
    }
    if (node.type === "variable_declarator") {
      if (node.parent?.type !== "field_declaration") continue;
      const name4 = node.childForFieldName("name");
      if (!name4) continue;
      const end = node.children.find((n) => n.type === "=")?.startIndex ?? node.endIndex, header3 = vbHeader(content, node.startIndex, end), mod = node.parent.childForFieldName("modifiers"), prefix2 = mod ? originalHeader(mod).tokens : [], tokens2 = [...prefix2, ...header3.tokens];
      add(node, name4, "field", header3, false, node.startIndex, node.endIndex, compact8(`${mod?.text ?? ""} ${content.slice(node.startIndex, header3.end)}`), tokens2);
      continue;
    }
    if (node.type === "const_declaration") {
      const names2 = node.childrenForFieldName("name");
      for (let i = 0; i < names2.length; i++) {
        const name4 = names2[i], next = names2[i + 1], tail = node.namedChildren.filter((n) => n.startIndex >= name4.endIndex && n.endIndex <= (next?.startIndex ?? node.endIndex)), asClause = tail.find((n) => n.type === "as_clause"), header3 = vbHeader(content, name4.startIndex, asClause?.endIndex ?? name4.endIndex), prefix2 = originalHeader(node, name4.startIndex).tokens;
        add(node, name4, "constant", header3, false, name4.startIndex, next?.startIndex ?? node.endIndex, compact8(`${content.slice(node.startIndex, names2[0].startIndex)} ${content.slice(name4.startIndex, header3.end)}`), [...prefix2.filter((t) => t.end <= (names2[0]?.startIndex ?? 0)), ...header3.tokens]);
      }
      continue;
    }
    const header2 = originalHeader(node);
    let name3 = node.childForFieldName("name") ?? void 0, kind, scope = false;
    if (node.type === "constructor_declaration") {
      const sub = header2.tokens.findIndex((t) => vbFold(t.text) === "sub"), newToken = header2.tokens[sub + 1];
      if (sub >= 0 && newToken && vbFold(newToken.text) === "new") name3 = { text: newToken.text, startIndex: newToken.start, endIndex: newToken.end };
      kind = "constructor";
      scope = true;
    } else if (node.type === "method_declaration") {
      kind = parentFor(node)?.kind === "module" ? "function" : "method";
      scope = true;
    } else if (node.type === "delegate_declaration") kind = "delegate";
    else if (node.type === "event_declaration") kind = "event";
    else if (node.type === "property_declaration") kind = "property";
    else if (node.type === "enum_member") kind = "enum-member";
    if (!kind || !name3) continue;
    const initializer = node.children.find((n) => n.type === "="), main = initializer ? vbHeader(content, node.startIndex, initializer.startIndex) : header2;
    const accessors = kind === "property" ? node.namedChildren.filter((n) => ["get_accessor", "set_accessor"].includes(n.type)).map((n) => originalHeader(n)) : [], tokens = [...main.tokens, ...accessors.flatMap((a) => a.tokens)], signature2 = accessors.length ? [compact8(content.slice(node.startIndex, main.end)), ...accessors.map((a) => a.tokens.map((t) => t.text).join(" "))].join(" ") : void 0;
    const fact = add(node, name3, kind, { ...main, complete: main.complete && accessors.every((a) => a.complete) }, scope, node.startIndex, node.endIndex, signature2, tokens);
    if (fact && (["delegate", "event", "enum-member"].includes(kind) || parentFor(node)?.kind === "interface" || fact.modifiers?.some((m) => vbFold(m) === "mustoverride"))) fact.declarationForm = "declaration";
  }
  if (truncated) {
    if (issues.length === MAX_ISSUES7) issues.pop();
    issues.push({ code: "syntax-budget-exceeded", reason: "VB extraction reached its node, declaration, metadata, diagnostic, context, header or query limit" });
  }
  syntax.complete = !truncated && !issues.length;
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.reason.localeCompare(b.reason));
  return { declarations, issues, truncated, vbnet: syntax };
}

// src/analysis/tree-sitter/extract.ts
var MAX_DECLARATIONS8 = 2e4;
var MAX_ISSUES8 = 100;
var MAX_NODES10 = 2e5;
var compact9 = (text) => text.replace(/\s+/g, " ").trim();
var FIELD_BODIES = /* @__PURE__ */ new Set(["block", "body_statement", "class_body", "declaration_list", "field_declaration_list", "enum_body", "function_body", "arrow_expression_clause", "constructor_body", "accessor_list"]);
var CALLABLES = /* @__PURE__ */ new Set(["function", "method", "constructor"]);
var ParserOriginalSource = class extends SourceText {
  range(start, end) {
    if (start > this.text.length + 1 || end > this.text.length + 1) return super.range(start, end);
    return super.range(Math.min(start, this.text.length), Math.min(end, this.text.length));
  }
};
var METHOD_OWNERS = /* @__PURE__ */ new Set(["class", "struct", "interface", "trait", "record", "object", "enum"]);
function child2(node, ...types4) {
  return node.namedChildren.find((item) => types4.includes(item.type));
}
function body2(node) {
  return node.childForFieldName("body") ?? node.namedChildren.find((item) => FIELD_BODIES.has(item.type));
}
function prefix(root, language) {
  const node = root.namedChildren.find((item) => ["package_declaration", "package_header", "package_clause", "file_scoped_namespace_declaration"].includes(item.type));
  if (!node) return "";
  const name3 = node.childForFieldName("name") ?? node.namedChildren.find((item) => !["annotation", "modifiers"].includes(item.type));
  return name3?.text ?? "";
}
function declarationKind(language, node, kind) {
  if (language === "go" && kind === "type") {
    const type = node.childForFieldName("type");
    return type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type";
  }
  if (language === "kotlin" && kind === "class") {
    const header2 = node.text.slice(0, (body2(node)?.startIndex ?? node.endIndex) - node.startIndex);
    if (/\binterface\b/.test(header2)) return "interface";
    if (/\benum\s+class\b/.test(header2)) return "enum";
  }
  return kind;
}
function parameters(node) {
  return node.childForFieldName("parameters") ?? child2(node, "function_value_parameters", "formal_parameters", "parameter_list", "method_parameters");
}
function signature(node, name3, kind) {
  if (node.type === "type_spec" && ["struct", "interface"].includes(kind)) return kind;
  if (kind === "property") return compact9(node.childForFieldName("type")?.text ?? (node.type === "variable_declarator" ? node.parent?.childForFieldName("type")?.text : void 0) ?? "");
  if (CALLABLES.has(kind)) {
    const params = parameters(node)?.text ?? "()";
    const parameterNode = parameters(node);
    const result = node.childForFieldName("return_type") ?? node.childForFieldName("result") ?? node.childForFieldName("returns") ?? node.childForFieldName("type") ?? (node.type === "function_declaration" && parameterNode ? node.namedChildren.find((item) => item.startIndex > parameterNode.endIndex && ["user_type", "nullable_type", "function_type"].includes(item.type)) : void 0);
    return compact9(params + (result ? ` \u2192 ${result.text}` : "")).slice(0, 1200);
  }
  const end = body2(node)?.startIndex ?? node.endIndex;
  return compact9(node.text.slice(name3.endIndex - node.startIndex, end - node.startIndex)).slice(0, 1200);
}
function modifiers3(node) {
  if (node.type === "variable_declarator" && node.parent?.type === "variable_declaration" && node.parent.parent?.type === "field_declaration") return modifiers3(node.parent.parent);
  if (node.type === "variable_declarator" && ["field_declaration", "constant_declaration"].includes(node.parent?.type ?? "")) return modifiers3(node.parent);
  const values = node.namedChildren.filter((item) => ["modifiers", "modifier", "visibility_modifier"].includes(item.type));
  return [
    ...values.flatMap((item) => item.type === "modifiers" ? item.children : [item]).filter((item) => !/annotation|attribute/.test(item.type)).map((item) => compact9(item.text)),
    ...node.type === "singleton_method" ? ["static"] : [],
    ...node.children.some((item) => item.type === "async") ? ["async"] : []
  ];
}
function annotations(node) {
  const result = [];
  const owner2 = node.parent?.type === "decorated_definition" ? node.parent : node;
  const inspect = (item) => {
    if (/^(decorator|annotation|marker_annotation|attribute_list)$/.test(item.type)) result.push(item.text.trim());
    else if (["modifiers", "modifier"].includes(item.type)) item.namedChildren.forEach(inspect);
  };
  owner2.namedChildren.forEach(inspect);
  for (let sibling = node.previousNamedSibling; sibling?.type === "attribute_item"; sibling = sibling.previousNamedSibling) result.unshift(sibling.text.trim());
  return result;
}
function extractStructure(root, query, language, content) {
  if (language === "c" || language === "cpp") return extractCfamilyStructure(root, query, language, content);
  if (language === "objective-c") return extractObjcStructure(root, query, content);
  if (language === "swift") return extractSwiftStructure(root, query, content);
  if (language === "scala") return extractScalaStructure(root, query, content);
  if (language === "groovy") return extractGroovyStructure(root, query, content);
  if (language === "vbnet") return extractVbnetStructure(root, query, content);
  if (language === "fsharp" || language === "fsharp-signature") return extractFsharpStructure(root, query, content, language === "fsharp-signature");
  const source = ["go", "csharp"].includes(language) ? new ParserOriginalSource(content) : new SourceText(content), issues = [];
  const damaged = [];
  let truncated = false, visited = 0;
  const queue = [root];
  while (queue.length) {
    const node = queue.pop();
    if (++visited > MAX_NODES10) {
      truncated = true;
      break;
    }
    if (node.isError || node.isMissing) {
      damaged.push({ start: node.startIndex, end: node.endIndex });
      if (issues.length < MAX_ISSUES8) issues.push({ code: "syntax-parse-error", reason: node.isMissing ? `Missing ${node.type}` : "Parser recovered from invalid syntax", range: source.range(node.startIndex, node.endIndex) });
      else truncated = true;
    }
    if (node.hasError) {
      for (const item of node.children) if (item.hasError || item.isError || item.isMissing) queue.push(item);
    }
  }
  const captured = [];
  for (const match of query.matches(root, { matchLimit: 4096 })) {
    const definition = match.captures.find((item) => item.name.startsWith("declaration."));
    const name3 = match.captures.find((item) => item.name === "name")?.node;
    if (!definition || !name3 || name3.isMissing || name3.hasError) continue;
    const node = definition.node;
    const headerEnd = body2(node)?.startIndex ?? node.endIndex;
    if (damaged.some((item) => item.start < headerEnd && item.end >= node.startIndex)) continue;
    captured.push({ node, name: name3, kind: declarationKind(language, node, definition.name.slice("declaration.".length)) });
    if (captured.length >= MAX_DECLARATIONS8) {
      truncated = true;
      break;
    }
  }
  if (query.didExceedMatchLimit()) truncated = true;
  captured.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex || a.kind.localeCompare(b.kind));
  const declarations = [], byNode = /* @__PURE__ */ new Map();
  const separator = language === "rust" || language === "ruby" ? "::" : ".";
  const top = prefix(root, language);
  const owners2 = /* @__PURE__ */ new Map();
  const receiverMethods = [];
  for (const { node, name: name3, kind: rawKind } of captured) {
    let parent, impl;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === "impl_item") impl = ancestor;
      parent = byNode.get(ancestor.id);
      if (parent) break;
    }
    const receiver = node.childForFieldName("receiver");
    const target = (impl?.childForFieldName("type")?.text ?? receiver?.descendantsOfType("type_identifier")[0]?.text)?.replace(/<.*>$/, "");
    const kind = rawKind === "function" && (impl || parent && METHOD_OWNERS.has(parent.kind)) ? "method" : rawKind;
    const owner2 = node.parent?.type === "decorated_definition" ? node.parent : node;
    const qualifiedName = [parent?.qualifiedName ?? top, name3.text].filter(Boolean).join(separator);
    const mods = modifiers3(node), notes = annotations(node);
    const visibility = mods.find((item) => /^(public|private|protected|internal|pub(?:\(.+\))?)$/.test(item));
    const fact = {
      key: String(node.id),
      ...parent ? { parent: parent.key } : {},
      name: name3.text,
      qualifiedName,
      kind,
      entityType: CALLABLES.has(kind) ? kind === "function" ? "function" : "method" : kind === "property" ? "method" : "class",
      signature: `${mods.includes("static") && CALLABLES.has(kind) ? "static " : ""}${signature(node, name3, kind)}`,
      range: source.range(owner2.startIndex, owner2.endIndex),
      start: owner2.startIndex,
      end: Math.min(owner2.endIndex, content.length),
      nameEnd: name3.endIndex,
      ...visibility ? { visibility } : {},
      ...mods.length ? { modifiers: mods } : {},
      ...notes.length ? { annotations: notes } : {},
      ...language === "go" ? { exported: new RegExp("^\\p{Lu}", "u").test(name3.text) } : language === "rust" ? { exported: !!visibility?.startsWith("pub") } : {}
    };
    declarations.push(fact);
    byNode.set(node.id, fact);
    if (target) receiverMethods.push({ fact, target, scope: parent?.qualifiedName ?? top });
    if (!CALLABLES.has(kind)) {
      const list = owners2.get(qualifiedName) ?? [];
      list.push(fact);
      owners2.set(qualifiedName, list);
    }
  }
  const previousNames = new Map(declarations.map((fact) => [fact.key, fact.qualifiedName]));
  for (const { fact, target, scope } of receiverMethods) {
    const qualifiedTarget = [scope, target].filter(Boolean).join(separator);
    const candidates = owners2.get(qualifiedTarget) ?? [];
    if (candidates.length === 1) fact.parent = candidates[0].key;
    fact.qualifiedName = `${qualifiedTarget}${separator}${fact.name}`;
  }
  const byKey = new Map(declarations.map((fact) => [fact.key, fact]));
  const updated = new Set(receiverMethods.map((item) => item.fact.key));
  const qualify = (fact) => {
    if (updated.has(fact.key)) return;
    updated.add(fact.key);
    const parent = fact.parent ? byKey.get(fact.parent) : void 0;
    if (!parent) return;
    qualify(parent);
    if (parent.qualifiedName !== previousNames.get(parent.key)) fact.qualifiedName = `${parent.qualifiedName}${separator}${fact.name}`;
  };
  declarations.forEach(qualify);
  const keys = new Map(declarations.map((item) => [item.key, `${item.start}:${item.end}:${item.kind}`]));
  for (const declaration of declarations) {
    const key = keys.get(declaration.key);
    if (declaration.parent) declaration.parent = keys.get(declaration.parent);
    declaration.key = key;
  }
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || (a.range?.startColumn ?? 0) - (b.range?.startColumn ?? 0) || a.reason.localeCompare(b.reason));
  const python = language === "python" ? extractPythonImports(root, declarations, source) : void 0;
  const go = language === "go" ? extractGoImports(root, source) : void 0;
  const goSemantic = language === "go" ? extractGoSemantic(root, declarations, source) : void 0;
  const ruby = language === "ruby" ? extractRubySemantic(root, declarations, source) : void 0;
  const jvm = ["java", "kotlin"].includes(language) ? extractJvm(root, language, declarations, source) : void 0;
  const csharp = language === "csharp" ? extractCsharp(root, declarations, source) : void 0;
  const rust = language === "rust" ? extractRust(root, declarations, source) : void 0;
  if (go && goSemantic) go.facts.semantic = goSemantic.facts;
  truncated ||= (python?.truncated ?? false) || (go?.truncated ?? false) || (goSemantic?.truncated ?? false) || (ruby?.truncated ?? false);
  if (jvm && truncated) jvm.complete = false;
  if (csharp && truncated) csharp.complete = false;
  if (rust && truncated) rust.complete = false;
  if (rust?.semantic && truncated) rust.semantic.complete = false;
  if (truncated) issues.push({ code: "syntax-budget-exceeded", reason: "Structural extraction reached its node, declaration, diagnostic or query limit" });
  return { declarations, issues, truncated, ...python ? { python: python.facts } : {}, ...go ? { go: go.facts } : {}, ...ruby ? { ruby: ruby.facts } : {}, ...jvm ? { jvm } : {}, ...csharp ? { csharp } : {}, ...rust ? { rust } : {} };
}

// src/analysis/tree-sitter/cfamily-source.ts
function cfamilySource(content) {
  const tokens = [], directives = [], conditions = [];
  const identifier = /[\p{ID_Start}_$][\p{ID_Continue}$]*/uy, raw = /(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/y;
  let index = 0, lineHasCode = false, truncated = false, conditionalDepth = 0;
  while (index < content.length) {
    if (tokens.length >= 2e5 || directives.length >= 4096) {
      truncated = true;
      break;
    }
    const start = index, char = content[index];
    if (/\s/.test(char)) {
      if (char === "\n") lineHasCode = false;
      index++;
      continue;
    }
    if (content.startsWith("//", index)) {
      const end = content.indexOf("\n", index + 2);
      index = end < 0 ? content.length : end;
      continue;
    }
    if (content.startsWith("/*", index)) {
      const end = content.indexOf("*/", index + 2);
      index = end < 0 ? content.length : end + 2;
      if (content.slice(start, index).includes("\n")) lineHasCode = false;
      continue;
    }
    if (char === "#" && !lineHasCode) {
      let end = index;
      do {
        const next = content.indexOf("\n", end);
        if (next < 0) {
          end = content.length;
          break;
        }
        end = next + 1;
      } while (/\\\r?\n$/.test(content.slice(index, end)));
      const original = content.slice(index, end).trim(), text = original.slice(0, 8192), kind = /^#\s*(\w+)/.exec(text)?.[1];
      if (original.length > 8192) truncated = true;
      if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
        conditionalDepth++;
        if (conditionalDepth <= 128) conditions.push(text.split("\n")[0]);
        else truncated = true;
      } else if (["elif", "elifdef", "elifndef", "else"].includes(kind ?? "") && conditions.length && conditionalDepth <= 128) conditions[conditions.length - 1] = `${conditions.at(-1)} | ${text.split("\n")[0]}`.slice(0, 8192);
      else if (kind === "endif") {
        if (conditionalDepth <= 128) conditions.pop();
        conditionalDepth = Math.max(0, conditionalDepth - 1);
      }
      directives.push({ start, end, text, conditions: [...conditions] });
      index = end;
      lineHasCode = false;
      continue;
    }
    lineHasCode = true;
    raw.lastIndex = index;
    const rawMatch = raw.exec(content);
    if (rawMatch) {
      const end = content.indexOf(`)${rawMatch[1]}"`, index + rawMatch[0].length);
      index = end < 0 ? content.length : end + rawMatch[1].length + 2;
      tokens.push({ text: "literal", start, end: index, opaque: true });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index++;
      while (index < content.length) {
        if (content[index] === "\\") index += 2;
        else if (content[index++] === quote) break;
      }
      index = Math.min(index, content.length);
      tokens.push({ text: "literal", start, end: index, opaque: true });
      continue;
    }
    identifier.lastIndex = index;
    const match = identifier.exec(content);
    if (match) {
      index = identifier.lastIndex;
      tokens.push({ text: match[0], start, end: index });
    } else {
      index++;
      tokens.push({ text: char, start, end: index });
    }
  }
  const pairs = /* @__PURE__ */ new Map(), stack = [];
  for (let at = 0; at < tokens.length; at++) {
    const text = tokens[at].text;
    if (["(", "{", "["].includes(text)) stack.push(at);
    else if ([")", "}", "]"].includes(text)) {
      const open = stack.pop();
      if (open !== void 0 && { "(": ")", "{": "}", "[": "]" }[tokens[open].text] === text) {
        pairs.set(open, at);
        pairs.set(at, open);
      } else stack.length = 0;
    }
  }
  return { tokens, pairs, directives, truncated };
}
function sourceConditions(source, start) {
  let low = 0, high = source.directives.length;
  while (low < high) {
    const middle = low + high >>> 1;
    if (source.directives[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  return [...source.directives[low - 1]?.conditions ?? []];
}
var sourceIdentifier = (token) => !!token && !token.opaque && /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(token.text);

// src/analysis/tree-sitter/objc-regions.ts
var MAX_REGIONS = 4096;
function objcRegions(content) {
  const source = cfamilySource(content), tokens = source.tokens;
  let truncated = source.truncated;
  const regions = [], stack = [];
  for (let item = 0; item < tokens.length - 1; item++) {
    if (tokens[item].text !== "@" || tokens[item].end !== tokens[item + 1].start) continue;
    const kind = tokens[item + 1].text;
    if (["interface", "implementation", "protocol"].includes(kind) && tokens[item + 2] && /^[\p{ID_Start}_$]/u.test(tokens[item + 2].text)) {
      if (kind === "protocol" && [",", ";"].includes(tokens[item + 3]?.text ?? "")) continue;
      stack.push(tokens[item].start);
    } else if (kind === "end" && stack.length) {
      const start = stack.pop();
      if (!stack.length) {
        if (regions.length >= MAX_REGIONS) {
          truncated = true;
          break;
        }
        regions.push({ start, end: tokens[item + 1].end });
      }
    }
  }
  return { regions, truncated };
}
function recoverObjcRegions(facts, content, parser, query) {
  if (!facts.issues.length && !facts.truncated) return facts;
  const discovered = objcRegions(content), source = new SourceText(content);
  let result = facts;
  for (const region of discovered.regions) {
    if (result.declarations.some((fact) => ["class-interface", "class-implementation", "protocol"].includes(fact.kind) && fact.start <= region.start && fact.end >= region.end)) continue;
    parser.reset();
    const tree = parser.parse(content.slice(region.start, region.end));
    if (!tree) continue;
    try {
      const recovered = extractObjcStructure(tree.rootNode, query, content.slice(region.start, region.end));
      if (!recovered.declarations.some((fact) => ["class-interface", "class-implementation", "protocol"].includes(fact.kind))) {
        result.declarations = result.declarations.filter((fact) => fact.end <= region.start || fact.start >= region.end);
        continue;
      }
      const prefix2 = `objc-region:${region.start}:`, keys = new Map(recovered.declarations.map((fact) => [fact.key, prefix2 + fact.key]));
      const reason = "Original self-contained Objective-C region recovered; surrounding annotation/macro syntax remains unexpanded and requires source-context qualification";
      const context2 = facts.cfamily?.preprocessor.filter((item) => ["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_elifdef", "preproc_else"].includes(item.kind) && item.range.startLine <= source.range(region.start, region.start).startLine && item.range.endLine >= source.range(region.end, region.end).endLine).map((item) => item.text) ?? [];
      const declarations = recovered.declarations.map((fact) => ({ ...fact, key: keys.get(fact.key), ...fact.parent ? { parent: keys.get(fact.parent) } : {}, start: fact.start + region.start, end: fact.end + region.start, nameEnd: fact.nameEnd + region.start, range: source.range(fact.start + region.start, fact.end + region.start), sourceConditions: [...context2, ...fact.sourceConditions ?? [], reason] }));
      const starts = [0];
      const text = content.slice(region.start, region.end);
      for (let at = 0; at < text.length; at++) if (text[at] === "\n") starts.push(at + 1);
      const offsetRange = (range) => {
        if (range.startColumn === void 0 || range.endColumn === void 0) throw new Error("Original Objective-C region range is missing its parser columns");
        return source.range(region.start + starts[range.startLine - 1] + range.startColumn - 1, region.start + starts[range.endLine - 1] + range.endColumn - 1);
      };
      const existing = result.declarations.filter((fact) => fact.end <= region.start || fact.start >= region.end);
      const combined = [...existing, ...declarations].sort((a, b) => a.start - b.start || b.end - a.end);
      const issues = [...result.issues, ...recovered.issues.map((issue) => ({ ...issue, ...issue.range ? { range: offsetRange(issue.range) } : {} })), { code: "syntax-source-context-gap", reason, range: source.range(region.start, region.end) }];
      const propertyImplementations = [...result.objc?.propertyImplementations ?? [], ...recovered.objc.propertyImplementations.map((item) => ({ ...item, range: offsetRange(item.range) }))], moduleImports = [...result.objc?.moduleImports ?? [], ...recovered.objc.moduleImports.map((item) => ({ ...item, range: offsetRange(item.range) }))];
      result = { ...result, declarations: combined.slice(0, 2e4), truncated: result.truncated || recovered.truncated || combined.length > 2e4 || issues.length > 100 || propertyImplementations.length > 4096 || moduleImports.length > 4096, issues: issues.slice(0, 100), cfamily: result.cfamily ? { ...result.cfamily, complete: false } : void 0, objc: { propertyImplementations: propertyImplementations.slice(0, 4096), moduleImports: moduleImports.slice(0, 4096), isolatedRegions: [...result.objc?.isolatedRegions ?? [], { range: source.range(region.start, region.end), reason }], complete: false } };
    } finally {
      tree.delete();
    }
  }
  if (discovered.truncated || result.truncated) {
    result.truncated = true;
    if (!result.issues.some((issue) => issue.code === "syntax-budget-exceeded")) {
      if (result.issues.length === 100) result.issues.pop();
      result.issues.push({ code: "syntax-budget-exceeded", reason: "Objective-C source recovery reached its token, region, declaration, metadata or diagnostic limit" });
    }
    if (result.objc) result.objc.complete = false;
    if (result.cfamily) result.cfamily.complete = false;
  }
  return result;
}

// src/analysis/tree-sitter/objc-macros.ts
var profiles = /* @__PURE__ */ new Set(["NS_ENUM", "NS_CLOSED_ENUM", "NS_OPTIONS", "CF_ENUM", "CF_CLOSED_ENUM", "CF_OPTIONS"]);
var compact10 = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1200);
function extractObjcMacroProfiles(facts, content, lexical = cfamilySource(content)) {
  const { tokens, pairs, directives } = lexical, source = new SourceText(content);
  const overridden = new Set(directives.map((d) => /^#\s*(?:define|undef)\s+([\w$]+)/.exec(d.text.replace(/\\\r?\n/g, " ").replace(/\/\*[\s\S]*?\*\//g, " "))?.[1]).filter((name3) => !!name3));
  const metadata = [];
  const issue = (reason, start, end) => {
    if (facts.issues.length < 100) facts.issues.push({ code: "objc-macro-profile-gap", reason, range: source.range(start, end) });
    else facts.truncated = true;
  };
  if (lexical.truncated) {
    facts.truncated = true;
    if (facts.objc) facts.objc.complete = false;
    if (facts.cfamily) facts.cfamily.complete = false;
    if (!facts.issues.some((i) => i.code === "syntax-budget-exceeded")) {
      if (facts.issues.length >= 100) facts.issues.pop();
      facts.issues.push({ code: "syntax-budget-exceeded", reason: "Original source exceeds token/directive/context bounds; standard macro profiles cannot be certified" });
    }
    return facts;
  }
  for (let at = 0; at < tokens.length - 4; at++) {
    if (tokens[at].text !== "typedef" || !profiles.has(tokens[at + 1].text) || tokens[at + 2].text !== "(") continue;
    const begin = tokens[at], macro = tokens[at + 1].text, close = pairs.get(at + 2);
    if (close === void 0) continue;
    const open = close + 1, end = pairs.get(open);
    if (tokens[open]?.text !== "{" || end === void 0 || tokens[end + 1]?.text !== ";") {
      issue(`Original ${macro} requires a complete literal enum body and semicolon`, begin.start, tokens[close].end);
      continue;
    }
    const finish = tokens[end + 1].end;
    facts.declarations = facts.declarations.filter((f) => f.end <= begin.start || f.start >= finish || f.start < begin.start && f.end > finish);
    if (overridden.has(macro)) {
      issue(`Original ${macro} is defined/undefined in this source; the standard SDK profile cannot certify its declarations`, begin.start, finish);
      at = end + 1;
      continue;
    }
    const commas = [];
    for (let n = at + 3; n < close; n++) {
      const pair = pairs.get(n);
      if (pair !== void 0 && pair > n) {
        n = pair;
        continue;
      }
      if (tokens[n].text === ",") commas.push(n);
    }
    const separator = commas[0], name3 = separator === void 0 ? void 0 : tokens[separator + 1];
    if (commas.length !== 1 || separator === void 0 || !sourceIdentifier(name3) || separator + 2 !== close || separator === at + 3) {
      issue(`Original ${macro} requires two literal arguments with one explicit type name`, begin.start, finish);
      at = end + 1;
      continue;
    }
    const underlying = content.slice(tokens[at + 3].start, tokens[separator - 1].end);
    const reason = `Original ${macro} enum/options source profile; macro expansion, SDK type/ABI and numeric values remain unverified`;
    const conditions = [...sourceConditions(lexical, begin.start), reason];
    const owner2 = facts.declarations.filter((f) => f.start < begin.start && f.end >= finish).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const key = `objc-enum:${begin.start}:${finish}:${name3.start}`;
    const type = { key, name: name3.text, qualifiedName: [owner2?.qualifiedName, name3.text].filter(Boolean).join("::"), kind: "type", entityType: "class", signature: compact10(content.slice(begin.start, tokens[open].start)), range: source.range(begin.start, finish), start: begin.start, end: finish, nameEnd: name3.end, declarationForm: "declaration", annotations: [`Original macro: ${macro}`, `Original underlying type syntax: ${underlying}`], sourceConditions: conditions, ...owner2 ? { parent: owner2.key } : {} };
    if (facts.declarations.length >= 2e4 || metadata.length >= 4096) {
      facts.truncated = true;
      break;
    }
    facts.declarations.push(type);
    metadata.push({ macro, name: name3.text, underlyingType: underlying, range: type.range });
    let memberStart = open + 1;
    const addMember = (last) => {
      if (last <= memberStart) return;
      const first = tokens[memberStart];
      if (!sourceIdentifier(first) || last > memberStart + 1 && tokens[memberStart + 1].text !== "=" || tokens[memberStart + 1]?.text === "=" && last === memberStart + 2) {
        issue(`Original ${macro} member requires an explicit identifier and optional original initializer; no declaration is guessed`, first.start, tokens[last - 1].end);
        return;
      }
      if (facts.declarations.length >= 2e4) {
        facts.truncated = true;
        return;
      }
      const memberEnd = tokens[last - 1].end;
      facts.declarations.push({ key: `${key}:member:${first.start}`, parent: key, name: first.text, qualifiedName: `${type.qualifiedName}::${first.text}`, kind: "enum-member", entityType: "class", signature: compact10(content.slice(first.start, memberEnd)), range: source.range(first.start, memberEnd), start: first.start, end: memberEnd, nameEnd: first.end, declarationForm: "definition", sourceConditions: [...sourceConditions(lexical, first.start), reason] });
    };
    for (let n = open + 1; n < end; n++) {
      const pair = pairs.get(n);
      if (pair !== void 0 && pair > n) {
        n = pair;
        continue;
      }
      if (tokens[n].text === ",") {
        addMember(n);
        memberStart = n + 1;
      }
    }
    addMember(end);
    issue(reason, begin.start, finish);
    at = end + 1;
  }
  if (metadata.length && facts.objc) facts.objc.enumProfiles = metadata;
  if (lexical.truncated) facts.truncated = true;
  if (facts.truncated && !facts.issues.some((i) => i.code === "syntax-budget-exceeded")) {
    if (facts.issues.length >= 100) facts.issues.pop();
    facts.issues.push({ code: "syntax-budget-exceeded", reason: "Original Objective-C macro profiles reached the source-token, directive, declaration, metadata or diagnostic limit" });
  }
  facts.declarations.sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
  if (facts.objc) facts.objc.complete = !facts.truncated && !facts.issues.length;
  if (facts.cfamily) facts.cfamily.complete = !facts.truncated && !facts.issues.length;
  return facts;
}

// src/analysis/tree-sitter/objc-cpp.ts
var objcKinds = /* @__PURE__ */ new Set(["class-interface", "class-implementation", "class-forward", "class-alias", "protocol", "protocol-forward"]);
var originalObjcDeclarations = (declarations) => declarations.filter((f) => objcKinds.has(f.kind) || !!f.selector || f.modifiers?.some((m) => ["objc-property", "ivar"].includes(m)));
function composeObjcCpp(facts, root, query, content, lexical = cfamilySource(content)) {
  const source = new SourceText(content), regions = objcRegions(content), cpp = extractCfamilyStructure(root, query, "cpp", content);
  const original = originalObjcDeclarations(facts.declarations);
  const intervals = [...regions.regions, ...original.filter((f) => ["class-forward", "class-alias", "protocol-forward"].includes(f.kind)).map((f) => ({ start: f.start, end: f.end }))];
  const { tokens } = lexical;
  for (let at = 0; at < tokens.length - 1; at++) if (tokens[at].text === "@" && tokens[at + 1].text === "import") {
    const end = tokens.findIndex((t, n) => n > at && t.text === ";");
    if (end >= 0) intervals.push({ start: tokens[at].start, end: tokens[end].end });
  }
  const recoveredRegions = [];
  const captured = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "declaration") captured.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) cpp.truncated = true;
  const known = new Set(cpp.declarations.map((f) => f.key)), recovered = [];
  for (const node of [...captured.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    if (recovered.some((r) => r.start <= node.startIndex && r.end >= node.endIndex) || intervals.some((r) => node.startIndex < r.end && node.endIndex > r.start && !(node.type === "namespace_definition" && node.startIndex < r.start && node.endIndex >= r.end))) continue;
    let damaged = false;
    for (let parent = node.parent, depth = 0; parent && ++depth <= 128; parent = parent.parent) if (parent.isError) {
      damaged = true;
      break;
    }
    if (!damaged) continue;
    if (recovered.length >= 4096) {
      cpp.truncated = true;
      break;
    }
    const isolated = extractCfamilyStructure(node, query, "cpp", content), reason2 = "Original self-contained C++ AST subtree retained; surrounding parser/macro context remains unverified";
    const owner2 = cpp.declarations.filter((f) => ["namespace", "class", "struct", "union", "function", "method"].includes(f.kind) && f.start < node.startIndex && f.end >= node.endIndex).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const additions = isolated.declarations.filter((f) => !known.has(f.key) && !(f.kind === "variable" && owner2 && ["function", "method"].includes(owner2.kind)));
    if (!additions.length) continue;
    if (owner2) {
      const rootFact = additions.find((f) => !f.parent);
      if (rootFact) {
        const old = rootFact.qualifiedName;
        rootFact.parent = owner2.key;
        for (const f of additions) if (f.qualifiedName === old || f.qualifiedName.startsWith(`${old}::`)) f.qualifiedName = `${owner2.qualifiedName}::${f.qualifiedName}`;
      }
    }
    for (const f of additions) {
      f.sourceConditions = [...f.sourceConditions ?? [], reason2];
      cpp.declarations.push(f);
      known.add(f.key);
    }
    recovered.push({ start: node.startIndex, end: node.endIndex });
    recoveredRegions.push({ range: source.range(Math.min(node.startIndex, content.length), Math.min(node.endIndex, content.length)), reason: reason2 });
    cpp.truncated ||= isolated.truncated || cpp.declarations.length > 2e4;
    if (cpp.declarations.length > 2e4) {
      cpp.declarations.length = 2e4;
      break;
    }
  }
  const native = cpp.declarations.filter((f) => !intervals.some((region) => f.start < region.end && f.end > region.start && !(f.kind === "namespace" && f.start < region.start && f.end >= region.end)));
  const keys = new Map(native.map((f) => [f.key, `objc-cpp:${f.key}`]));
  const cppDeclarations = native.map((f) => ({ ...f, key: keys.get(f.key), ...f.parent ? { parent: keys.get(f.parent) } : {}, sourceConditions: [...f.sourceConditions ?? [], "Original separate C++ grammar profile; Objective-C/C++ type and translation-unit binding remain unverified"] }));
  for (const container of original.filter((f) => objcKinds.has(f.kind) && !f.parent)) {
    const namespace = cppDeclarations.filter((f) => f.kind === "namespace" && f.start < container.start && f.end > container.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!namespace) continue;
    const oldName = container.qualifiedName;
    container.parent = namespace.key;
    container.qualifiedName = `${namespace.qualifiedName}::${oldName}`;
    for (const child3 of original) if (child3 !== container && child3.qualifiedName.startsWith(`${oldName}::`) && child3.start >= container.start && child3.end <= container.end) child3.qualifiedName = `${namespace.qualifiedName}::${child3.qualifiedName}`;
  }
  facts.declarations = [...original, ...cppDeclarations];
  recoverOriginalCppMethods(facts, content, lexical);
  const preprocessor = [...facts.cfamily?.preprocessor ?? [], ...cpp.cfamily?.preprocessor ?? []];
  const unique = new Map(preprocessor.map((d) => [`${d.kind}:${d.range.startLine}:${d.range.startColumn}:${d.text}`, d]));
  const reason = "Original Objective-C and C++ grammar profiles retain separate source declarations; shared types, macros and cross-language binding remain unverified";
  const issues = [...facts.issues, ...cpp.issues, { code: "objc-cpp-structure-gap", reason }];
  facts.truncated ||= cpp.truncated || regions.truncated || lexical.truncated || facts.declarations.length > 2e4 || issues.length > 100 || unique.size > 4096;
  facts.declarations = facts.declarations.sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key)).slice(0, 2e4);
  facts.issues = issues.slice(0, 100);
  facts.cfamily = { preprocessor: [...unique.values()].slice(0, 4096), complete: false };
  if (facts.objc) {
    facts.objc.cppProfile = { grammar: "cpp", declarations: cppDeclarations.length, methodHeaders: facts.declarations.filter((f) => f.modifiers?.includes("objc-cpp-method-header")).length, ...recoveredRegions.length ? { recoveredRegions } : {} };
    facts.objc.complete = false;
  }
  if (!facts.issues.some((i) => i.code === "objc-cpp-structure-gap")) facts.issues[facts.issues.length - 1] = { code: "objc-cpp-structure-gap", reason };
  if (facts.truncated && !facts.issues.some((i) => i.code === "syntax-budget-exceeded")) {
    if (facts.issues.length >= 100) facts.issues.pop();
    facts.issues.push({ code: "syntax-budget-exceeded", reason: "Mixed Objective-C++ source extraction reached its declaration, syntax, region or diagnostic limit" });
  }
  return facts;
}
function recoverOriginalCppMethods(facts, content, lexical = cfamilySource(content)) {
  const source = new SourceText(content), { tokens, pairs } = lexical;
  for (const owner2 of facts.declarations.filter((f) => ["class-interface", "class-implementation", "protocol"].includes(f.kind))) {
    let low = 0, high = tokens.length;
    while (low < high) {
      const middle = low + high >>> 1;
      if (tokens[middle].start < owner2.start) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < tokens.length && tokens[at].start < owner2.end; at++) {
      const sign = tokens[at];
      if (["{", "(", "["].includes(sign.text)) {
        const end2 = pairs.get(at);
        if (end2 !== void 0 && end2 > at) at = end2;
        continue;
      }
      if (!["+", "-"].includes(sign.text) || tokens[at + 1]?.text !== "(") continue;
      const returns = pairs.get(at + 1);
      if (returns === void 0 || returns === at + 2) continue;
      let cursor = returns + 1, selector = "", name3;
      while (cursor < tokens.length) {
        const label = tokens[cursor];
        if (sourceIdentifier(label)) {
          name3 ??= label;
          cursor++;
          if (tokens[cursor]?.text !== ":") {
            if (!selector) selector = label.text;
            else selector = "";
            break;
          }
        } else if (tokens[cursor]?.text !== ":") break;
        if (tokens[cursor]?.text !== ":") break;
        name3 ??= tokens[cursor];
        selector += `${sourceIdentifier(label) ? label.text : ""}:`;
        cursor++;
        if (tokens[cursor]?.text === "(") {
          const typeEnd = pairs.get(cursor);
          if (typeEnd === void 0 || typeEnd === cursor + 1) {
            selector = "";
            break;
          }
          cursor = typeEnd + 1;
        }
        if (!sourceIdentifier(tokens[cursor])) {
          selector = "";
          break;
        }
        cursor++;
        if (tokens[cursor]?.text === ",") {
          if (tokens.slice(cursor + 1, cursor + 4).map((t) => t.text).join("") !== "...") {
            selector = "";
            break;
          }
          cursor += 4;
          break;
        }
        if ([";", "{"].includes(tokens[cursor]?.text ?? "")) break;
      }
      const terminal = tokens[cursor];
      if (!selector || !name3 || !terminal || ![";", "{"].includes(terminal.text)) continue;
      const bodyEnd = terminal.text === "{" ? pairs.get(cursor) : cursor;
      if (bodyEnd === void 0 || tokens[bodyEnd].end > owner2.end) continue;
      const start = sign.start, end = tokens[bodyEnd].end;
      if (facts.declarations.some((f) => f.selector && f.start === start)) {
        at = bodyEnd;
        continue;
      }
      if (facts.declarations.length >= 2e4) {
        facts.truncated = true;
        return;
      }
      const dispatch = sign.text === "+" ? "class" : "instance";
      const fact = { key: `objc-cpp-method:${start}:${end}:${name3.start}`, parent: owner2.key, name: selector, qualifiedName: `${owner2.qualifiedName}::${sign.text}${selector}`, kind: "method", entityType: "method", signature: content.slice(start, terminal.start).replace(/\s+/g, " ").trim().slice(0, 1200), range: source.range(start, end), start, end, nameEnd: name3.end, selector, dispatch, declarationForm: terminal.text === "{" ? "definition" : "declaration", modifiers: [dispatch === "class" ? "class-method" : "instance-method", "objc-cpp-method-header"], annotations: ["Original Objective-C++ return/parameter type syntax is retained without type binding"], sourceConditions: [...sourceConditions(lexical, start), "Original Objective-C++ selector header profile; C++ type and method-body binding remain unverified"] };
      facts.declarations.push(fact);
      at = bodyEnd;
    }
  }
}

// src/analysis/tree-sitter/template-facts.ts
var MAX_ISSUES9 = 100;
function erbIssue(facts, code, reason, range) {
  if (facts.issues.length < MAX_ISSUES9) facts.issues.push({ code, reason, ...range ? { range } : {} });
  else facts.truncated = true;
}
function finishErb(facts) {
  if (facts.truncated && !facts.issues.some((i) => i.code === "erb-budget-exceeded")) {
    if (facts.issues.length === MAX_ISSUES9) facts.issues.pop();
    facts.issues.push({ code: "erb-budget-exceeded", reason: "Original ERB extraction reached its node, region, declaration, header, context, diagnostic or query budget" });
  }
  facts.erb.complete = !facts.issues.length && !facts.truncated && facts.erb.rubyComplete && facts.erb.host.complete;
  return facts;
}
function razorIssue(facts, code, reason, range) {
  if (facts.issues.length < 100) facts.issues.push({ code, reason, ...range ? { range } : {} });
  else facts.truncated = true;
}
function finishRazor(facts) {
  if (facts.truncated) {
    facts.razor.csharpComplete = false;
    if (facts.issues.length === 100) facts.issues.pop();
    razorIssue(facts, "razor-budget-exceeded", "Original Razor extraction reached its node, region, declaration, header, context, diagnostic or query budget");
  }
  facts.razor.complete = !facts.truncated && !facts.issues.length && facts.razor.csharpComplete && facts.razor.host.complete;
  return facts;
}
function liquidIssue(facts, code, reason, start, end, content) {
  if (facts.issues.length < 100) facts.issues.push({ code, reason, ...start !== void 0 && content !== void 0 ? { range: new SourceText(content).range(start, end ?? start) } : {} });
  else facts.truncated = true;
}
function finishLiquid(facts) {
  const syntax = facts.liquid;
  if (facts.truncated) {
    syntax.host.complete = false;
    syntax.nativeComplete = false;
    if (!facts.issues.some((i) => i.code === "liquid-budget-exceeded")) {
      if (facts.issues.length === 100) facts.issues.pop();
      facts.issues.push({ code: "liquid-budget-exceeded", reason: "Original Liquid extraction reached its node, depth, region, binding, import, diagnostic or query budget" });
    }
  }
  syntax.complete = !facts.truncated && !facts.issues.length && syntax.nativeComplete && syntax.host.complete;
  return facts;
}

// src/analysis/tree-sitter/embedded-host.ts
var MAX_REGIONS2 = 4096;
function withinBudget(root) {
  const pending2 = [root];
  let count = 0;
  while (pending2.length) {
    const node = pending2.pop();
    if (++count > 2e5) return false;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) pending2.push(child3);
    }
  }
  return true;
}
function extractTemplateHost(root, query, content, facts, template) {
  const issue = (code, reason, range) => {
    if (facts.issues.length < 100) facts.issues.push({ code, reason, ...range ? { range } : {} });
    else facts.truncated = true;
  };
  const source = new SourceText(content), syntax = facts[template];
  if (!withinBudget(root)) {
    facts.truncated = true;
    syntax.host.complete = false;
    return;
  }
  if (root.hasError) {
    syntax.host.complete = false;
    issue(`${template}-html-gap`, "Literal HTML projection recovered; script/style ownership is unqualified and regions are omitted");
    return;
  }
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "region") {
    if (syntax.host.regions.length === MAX_REGIONS2) {
      facts.truncated = true;
      break;
    }
    const node = capture.node, start = node.namedChildren.find((n) => n.type === "start_tag"), end = node.namedChildren.find((n) => n.type === "end_tag");
    if (!start || !end) continue;
    const raw = node.namedChildren.find((n) => n.type === "raw_text"), bodyStart = raw?.startIndex ?? start.endIndex, bodyEnd = raw?.endIndex ?? end.startIndex, attributes = start.namedChildren.filter((n) => n.type === "attribute").map((n) => ({ name: n.namedChildren.find((c) => c.type === "attribute_name")?.text ?? "", text: content.slice(n.startIndex, n.endIndex), ...n.descendantsOfType("attribute_value")[0] ? { value: content.slice(n.descendantsOfType("attribute_value")[0].startIndex, n.descendantsOfType("attribute_value")[0].endIndex) } : {}, range: source.range(n.startIndex, n.endIndex) })), dynamic = template === "razor" && content.slice(node.startIndex, node.endIndex).includes("@") || syntax.regions.some((r) => r.kind !== "literal" && !(template === "liquid" && r.kind === "raw" && r.bodyStart <= node.startIndex && r.bodyEnd >= node.endIndex) && !(template === "razor" && r.kind === "recovery" && r.start >= node.startIndex && r.end <= node.endIndex && !content.slice(node.startIndex, node.endIndex).includes("@")) && r.start < node.endIndex && r.end > node.startIndex), external = attributes.some((a) => a.name.toLowerCase() === "src"), conditions = ["Original literal HTML source region; rendering/runtime execution is unverified"];
    const attribute = (name3) => attributes.find((a) => a.name.toLowerCase() === name3)?.value?.trim().toLowerCase() ?? "", scriptType = attribute("type"), processor = attribute("lang"), legacy = attribute("language"), script = node.type === "script_element", javascript = (!scriptType || ["module", "text/javascript", "application/javascript"].includes(scriptType)) && (!processor || ["js", "javascript"].includes(processor)) && (!legacy || legacy === "javascript"), css = (!scriptType || scriptType === "text/css") && (!processor || processor === "css");
    if (script && !javascript) conditions.push("Script MIME/processor type is outside the qualified literal JavaScript profile");
    if (!script && !css) conditions.push("Style MIME/processor type is outside the literal CSS region profile");
    if (dynamic) conditions.push(`${template.toUpperCase()} processing intersects this HTML region; original client/style declarations cannot be inferred from rendered source`);
    if (external) conditions.push("External script URL retained as source syntax only");
    const supported = !dynamic && !external && (script ? javascript : css);
    if (!supported) {
      syntax.host.complete = false;
      issue(`${template}-host-source-gap`, conditions.slice(1).join("; "), source.range(node.startIndex, node.endIndex));
    }
    syntax.host.regions.push({ kind: node.type === "script_element" ? "script" : "style", start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex), bodyStart, bodyEnd, bodyRange: source.range(bodyStart, bodyEnd), attributes, executionContext: script && javascript ? "browser" : "none", language: script ? javascript ? "javascript" : "unknown" : css ? "css" : "unknown", supported, conditions });
  }
  if (query.didExceedMatchLimit()) facts.truncated = true;
}

// src/analysis/tree-sitter/erb-structure.ts
var MAX_NODES11 = 2e5;
var MAX_REGIONS3 = 4096;
var MAX_DECLARATIONS9 = 2e4;
function withinBudget2(root) {
  const pending2 = [root];
  let count = 0;
  while (pending2.length) {
    const node = pending2.pop();
    if (++count > MAX_NODES11) return false;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) pending2.push(child3);
    }
  }
  return true;
}
function extractErbRegions(root, query, content, host = "unknown") {
  const source = new SourceText(content), facts = { declarations: [], issues: [], truncated: false, erb: { regions: [], host: { language: host, regions: [], complete: true }, rubyComplete: true, complete: true, executionUnverified: true } }, syntax = facts.erb, stack = [root];
  let nodes = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++nodes > MAX_NODES11) {
      facts.truncated = true;
      break;
    }
    if (node.isError || node.isMissing) {
      syntax.rubyComplete = false;
      erbIssue(facts, "erb-parse-error", node.isMissing ? `Missing template ${node.type}` : "Native ERB delimiter recovery prevents a qualified Ruby projection", source.range(node.startIndex, node.endIndex));
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) stack.push(child3);
    }
  }
  const selected = /* @__PURE__ */ new Map();
  for (const capture of query.captures(root, { matchLimit: 4096 })) if (capture.name === "region") selected.set(capture.node.id, capture.node);
  if (query.didExceedMatchLimit()) facts.truncated = true;
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex)) {
    if (syntax.regions.length === MAX_REGIONS3) {
      facts.truncated = true;
      break;
    }
    const literal = node.type === "content", nativeOpen = node.children.find((n) => !n.isNamed)?.text ?? "", nativeClose = node.children.filter((n) => !n.isNamed).at(-1)?.text ?? "";
    let kind = literal ? "literal" : node.type === "comment_directive" ? "comment" : content.startsWith("<%=", node.startIndex) ? "output" : "code", opening = literal ? void 0 : kind === "comment" ? "<%#" : kind === "output" ? "<%=" : nativeOpen === "<%-" ? "<%-" : "<%", closing = literal ? void 0 : nativeClose;
    const conditions = [], supported = literal || !node.hasError && ["<%", "<%=", "<%#", "<%-", "<%graphql"].includes(nativeOpen) && ["%>", "-%>"].includes(nativeClose) && nativeOpen !== "<%==";
    if (!supported) {
      syntax.rubyComplete = false;
      conditions.push("Nonstandard/invalid template delimiter or engine extension is unqualified");
      erbIssue(facts, "erb-engine-syntax-gap", conditions[0], source.range(node.startIndex, node.endIndex));
    }
    if (opening === "<%-" || closing === "-%>") {
      conditions.push("Explicit trim tag retained as original Ruby code; ERB trim mode or Erubi/Rails engine agreement is unverified");
      erbIssue(facts, "erb-trim-mode-gap", conditions.at(-1), source.range(node.startIndex, node.endIndex));
    }
    const bodyStart = literal ? node.startIndex : Math.min(node.endIndex, node.startIndex + opening.length), bodyEnd = literal ? node.endIndex : Math.max(bodyStart, node.endIndex - (closing?.length ?? 0));
    if (!literal && content.slice(bodyStart, bodyEnd).includes("%%>")) {
      conditions.push("Escaped ERB closing delimiter retained in original spelling; compiled literal agreement is unverified");
      erbIssue(facts, "erb-escape-gap", conditions.at(-1), source.range(bodyStart, bodyEnd));
    }
    if (literal) {
      const original = content.slice(node.startIndex, node.endIndex);
      for (const match of original.matchAll(/^%[^%\r\n]/gm)) {
        if (match.index === 0 && node.startIndex && !/[\r\n]/.test(content[node.startIndex - 1])) continue;
        syntax.rubyComplete = false;
        erbIssue(facts, "erb-percent-mode-gap", "Literal line could be Ruby under percent-line trim mode; unknown compiler options quarantine Ruby declarations", source.range(node.startIndex + match.index, node.startIndex + match.index + 1));
      }
    }
    syntax.regions.push({ key: `${kind}:${syntax.regions.length}`, kind, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex), bodyStart, bodyEnd, bodyRange: source.range(bodyStart, bodyEnd), ...opening ? { opening, closing } : {}, executionContext: kind === "code" || kind === "output" ? "server" : "none", supported, conditions });
  }
  return facts;
}
function erbRubyProjection(content, facts) {
  if (!facts.erb.rubyComplete || facts.truncated) return;
  const chars = content.split("").map((c) => /[\r\n]/.test(c) ? c : " ");
  for (const region of facts.erb.regions) if (region.kind === "code" || region.kind === "output") {
    for (let at = region.bodyStart; at < region.bodyEnd; at++) chars[at] = content[at];
    if (region.closing && region.bodyEnd < chars.length) chars[region.bodyEnd] = ";";
  }
  return chars.join("");
}
function erbHostProjection(content, facts) {
  const chars = content.split("");
  for (const region of facts.erb.regions) if (region.kind !== "literal") {
    for (let at = region.start; at < region.end; at++) if (!/[\r\n]/.test(chars[at])) chars[at] = " ";
  }
  return chars.join("");
}
function extractErbRuby(root, query, content, facts) {
  const source = new SourceText(content), regions = facts.erb.regions.filter((r) => r.kind === "code" || r.kind === "output");
  if (!withinBudget2(root)) {
    facts.truncated = true;
    facts.erb.rubyComplete = false;
    return;
  }
  if (root.hasError) {
    facts.erb.rubyComplete = false;
    erbIssue(facts, "erb-ruby-projection-gap", "Original Ruby regions have invalid/unsupported syntax or require engine-generated context; declarations are quarantined rather than assigned uncertain owners");
    return;
  }
  const selected = [];
  for (const match of query.matches(root, { matchLimit: 4096 })) {
    const definition = match.captures.find((c) => c.name.startsWith("declaration.")), name3 = match.captures.find((c) => c.name === "name")?.node;
    if (definition && name3) {
      if (selected.length === MAX_DECLARATIONS9) {
        facts.truncated = true;
        break;
      }
      selected.push({ node: definition.node, name: name3, kind: definition.name.slice("declaration.".length) });
    }
  }
  if (query.didExceedMatchLimit()) facts.truncated = true;
  const byNode = /* @__PURE__ */ new Map(), unsafe = /* @__PURE__ */ new Set();
  for (const { node, name: name3, kind } of selected.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex)) {
    let parent, depth = 0, blocked = false;
    for (let p = node.parent; p; p = p.parent) {
      if (unsafe.has(p.id)) {
        blocked = true;
        break;
      }
      if (++depth > 128) {
        facts.truncated = true;
        blocked = true;
        break;
      }
      parent = byNode.get(p.id);
      if (parent) break;
    }
    if (blocked) {
      unsafe.add(node.id);
      continue;
    }
    const params = node.childForFieldName("parameters"), superclass = node.childForFieldName("superclass"), headerEnd = params?.endIndex ?? superclass?.endIndex ?? name3.endIndex, headerRegion = regions.find((r) => r.bodyStart <= node.startIndex && r.bodyEnd >= headerEnd);
    if (!headerRegion || name3.hasError || name3.isMissing || content.slice(name3.startIndex, name3.endIndex) !== name3.text || headerEnd - node.startIndex > 1200) {
      unsafe.add(node.id);
      facts.erb.rubyComplete = false;
      erbIssue(facts, "erb-original-header-gap", "Native Ruby declaration header/name is not wholly inside one bounded original ERB code region", source.range(node.startIndex, Math.min(headerEnd, content.length)));
      continue;
    }
    const parts = regions.filter((r) => r.bodyStart < node.endIndex && r.bodyEnd > node.startIndex), conditions = ["Original ERB source declaration; Ruby engine/runtime owner, view binding and output compilation are unverified", ...parts.flatMap((r) => r.conditions)];
    if (parts.length > 1) conditions.push("Original declaration spans template regions; literal markup and generated output calls are excluded from the Ruby projection");
    const fact = { key: `erb-ruby:${node.startIndex}:${node.endIndex}:${kind}`, name: name3.text, qualifiedName: [parent?.qualifiedName, name3.text].filter(Boolean).join("::"), kind, entityType: kind === "method" ? "method" : "class", signature: content.slice(node.startIndex, headerEnd).trim(), start: node.startIndex, end: node.endIndex, nameEnd: name3.endIndex, range: source.range(node.startIndex, node.endIndex), declarationForm: "definition", sourceConditions: [...new Set(conditions)], embeddedSource: { language: "ruby", executionContext: "server", headerRange: source.range(node.startIndex, headerEnd), regions: parts.map((r) => source.range(Math.max(node.startIndex, r.bodyStart), Math.min(node.endIndex, r.bodyEnd))) }, ...parent ? { parent: parent.key } : {} };
    if (node.type === "singleton_method") fact.sourceConditions.push("Original singleton receiver header retained; receiver/dispatch binding is unverified");
    facts.declarations.push(fact);
    byNode.set(node.id, fact);
  }
}
function extractErbHost(root, query, content, facts) {
  extractTemplateHost(root, query, content, facts, "erb");
}

// src/analysis/tree-sitter/erb-script.ts
function extractErbScripts(compiler, content, facts) {
  extractLiteralScripts(compiler, content, facts, "erb");
}
function extractLiteralScripts(compiler, content, facts, template) {
  const syntax = facts[template];
  const issue = (code, reason, range) => erbIssue(facts, code.replace(/^erb-/, template + "-"), reason, range);
  const original = new SourceText(content);
  let ordinal = 0;
  for (const region of syntax.host.regions.filter((r) => r.kind === "script")) {
    const key = `script:${ordinal++}`;
    if (!region.supported || region.language !== "javascript") continue;
    const text = content.slice(region.bodyStart, region.bodyEnd), source = compiler.createSourceFile("original-inline-script.js", text, compiler.ScriptTarget.Latest, true, compiler.ScriptKind.JS), offset = region.bodyStart;
    if (source.parseDiagnostics.length) {
      region.supported = false;
      syntax.host.complete = false;
      issue("erb-script-parse-gap", "Literal original JavaScript failed parsing; this script is quarantined without affecting other source regions", region.bodyRange);
      continue;
    }
    const program = compiler.createProgram([source.fileName], { allowJs: true, noResolve: true, noLib: true, noEmit: true }, { getSourceFile: (name3) => name3 === source.fileName ? source : void 0, getDefaultLibFileName: () => "", writeFile: () => {
    }, getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (name3) => name3 === source.fileName, readFile: (name3) => name3 === source.fileName ? text : void 0, getCanonicalFileName: (name3) => name3, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n" });
    if (program.getSyntacticDiagnostics(source).length) {
      region.supported = false;
      syntax.host.complete = false;
      issue("erb-script-processor-gap", "Literal script contains syntax outside JavaScript; a qualified source processor is required and this script is quarantined", region.bodyRange);
      continue;
    }
    if (compiler.isExternalModule(source) && region.attributes.find((a) => a.name.toLowerCase() === "type")?.value?.trim().toLowerCase() !== "module") {
      region.supported = false;
      syntax.host.complete = false;
      issue("erb-script-module-gap", "Literal import/export syntax requires an explicit module script type; client declarations are quarantined", region.bodyRange);
      continue;
    }
    let count = 0;
    const claimedInitializers = /* @__PURE__ */ new Set(), pending2 = [{ node: source, blocked: false, depth: 0 }];
    while (pending2.length) {
      const item = pending2.pop(), node = item.node;
      let parent = item.parent, blocked = item.blocked;
      if (++count > 2e5 || item.depth > 128 || facts.declarations.length >= 2e4) {
        facts.truncated = true;
        region.supported = false;
        break;
      }
      const classNode = compiler.isClassDeclaration(node) || compiler.isClassExpression(node), functionNode = compiler.isFunctionDeclaration(node) || compiler.isFunctionExpression(node), method = compiler.isMethodDeclaration(node) || compiler.isGetAccessorDeclaration(node) || compiler.isSetAccessorDeclaration(node), constructor = compiler.isConstructorDeclaration(node), name3 = classNode || functionNode || method ? node.name : void 0;
      let initializer = compiler.isVariableDeclaration(node) ? node.initializer : void 0;
      while (initializer && compiler.isParenthesizedExpression(initializer)) initializer = initializer.expression;
      if (compiler.isVariableDeclaration(node) && initializer && (compiler.isFunctionExpression(initializer) || compiler.isArrowFunction(initializer))) {
        const start = node.getStart(source), headerEnd = initializer.body.getStart(source);
        if (blocked || !compiler.isIdentifier(node.name)) {
          blocked = true;
          issue("erb-script-owner-gap", "Callable source binding requires an original identifier and qualified lexical owner; descendants are quarantined", original.range(offset + start, offset + node.end));
        } else if (headerEnd - start > 1200) {
          blocked = true;
          region.supported = false;
          issue("erb-script-header-gap", "Original callable binding header exceeds the bounded signature profile; descendants are quarantined", original.range(offset + start, offset + headerEnd));
        } else {
          const nameText = node.name.getText(source), kind = compiler.isArrowFunction(initializer) ? "arrow-binding" : "function-binding", fact = { key: `${template}-${key}:${offset + start}:${offset + node.end}:${kind}`, name: nameText, qualifiedName: [parent?.qualifiedName ?? key, nameText].join("::"), kind, entityType: "function", signature: text.slice(start, headerEnd).trim(), start: offset + start, end: offset + node.end, nameEnd: offset + node.name.end, range: original.range(offset + start, offset + node.end), declarationForm: "definition", sourceConditions: [...template === "liquid" ? region.conditions : [], "Original JavaScript variable initializer binding; assignment, aliases, mutation, rendered/browser execution and call binding remain unverified"], embeddedSource: { language: "javascript", executionContext: "browser", headerRange: original.range(offset + start, offset + headerEnd), regions: [original.range(offset + start, offset + node.end)] }, ...parent ? { parent: parent.key } : {} };
          facts.declarations.push(fact);
          parent = fact;
          claimedInitializers.add(initializer);
        }
      }
      if (!claimedInitializers.has(node) && (classNode || functionNode || method || constructor)) {
        if (blocked || !name3 && !constructor || (method || constructor) && (!parent || parent.kind !== "class")) {
          issue("erb-script-owner-gap", "Unnamed JavaScript type/callback or object member has no qualified original source owner; nested declarations are quarantined", original.range(offset + node.getStart(source), offset + node.end));
          blocked = true;
        } else {
          const body3 = classNode ? node.getChildren(source).find((n) => n.kind === compiler.SyntaxKind.OpenBraceToken) : node.body, start = node.getStart(source), headerEnd = body3?.getStart(source) ?? node.end, nameStart = name3?.getStart(source) ?? start, nameEnd = name3?.end ?? start + "constructor".length, nameText = name3?.getText(source) ?? "constructor", kind = classNode ? "class" : functionNode ? "function" : constructor ? "constructor" : compiler.isGetAccessorDeclaration(node) ? "get-accessor" : compiler.isSetAccessorDeclaration(node) ? "set-accessor" : "method";
          if (headerEnd - start > 1200) {
            blocked = true;
            region.supported = false;
            issue("erb-script-header-gap", "Original JavaScript header exceeds the bounded signature profile; descendants are quarantined", original.range(offset + start, offset + headerEnd));
          } else {
            const fact = { key: `${template}-${key}:${offset + start}:${offset + node.end}:${kind}`, name: nameText, qualifiedName: [parent?.qualifiedName ?? key, nameText].join("::"), kind, entityType: classNode ? "class" : functionNode ? "function" : "method", signature: text.slice(start, headerEnd).trim(), start: offset + start, end: offset + node.end, nameEnd: offset + nameEnd, range: original.range(offset + start, offset + node.end), declarationForm: "definition", sourceConditions: [...template === "liquid" ? region.conditions : [], "Original literal JavaScript declaration; rendered/browser execution, imports and call binding remain unverified"], embeddedSource: { language: "javascript", executionContext: "browser", headerRange: original.range(offset + start, offset + headerEnd), regions: [original.range(offset + start, offset + node.end)] }, ...parent ? { parent: parent.key } : {} };
            if (content.slice(offset + nameStart, offset + nameEnd) !== nameText) {
              blocked = true;
              region.supported = false;
              issue("erb-script-name-gap", "JavaScript name has no exact original source spelling", fact.range);
            } else {
              facts.declarations.push(fact);
              parent = fact;
            }
          }
        }
      } else if (compiler.isArrowFunction(node) && !claimedInitializers.has(node)) {
        blocked = true;
      }
      const children = [];
      compiler.forEachChild(node, (n) => {
        children.push(n);
      });
      for (let i = children.length - 1; i >= 0; i--) pending2.push({ node: children[i], parent, blocked, depth: item.depth + 1 });
    }
  }
}

// src/analysis/tree-sitter/razor-structure.ts
var MAX_NODES12 = 2e5;
var MAX_REGIONS4 = 4096;
var MAX_DECLARATIONS10 = 2e4;
function blockKind(node) {
  const brace = node.children.find((n) => n.type === "{");
  const open = node.text.slice(0, (brace?.startIndex ?? node.startIndex) - node.startIndex);
  return open.includes("functions") ? "functions" : open.includes("code") ? "code" : "render";
}
function missingDelimiter(node) {
  return node.children.some((n) => n.isMissing || n.isError);
}
function intersects(a, b, c, d) {
  return c === d ? c >= a && c <= b : a < d && b > c;
}
function extractRazor(root, query, content, sourceKind = "component") {
  const source = new SourceText(content), executionContext = sourceKind === "view" ? "server" : "unknown", facts = { declarations: [], issues: [], truncated: false, razor: { sourceKind, regions: [], directives: [], host: { language: "html", regions: [], complete: true }, csharpComplete: true, complete: true, executionUnverified: true, projectContextUnverified: true } }, syntax = facts.razor, pending2 = [{ node: root, depth: 0 }], damage = [];
  let count = 0;
  while (pending2.length) {
    const { node, depth } = pending2.pop();
    if (++count > MAX_NODES12 || depth > 128) {
      facts.truncated = true;
      break;
    }
    if (node.isError || node.isMissing) {
      damage.push(node);
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-parse-error", node.isMissing ? `Missing native Razor ${node.type}` : "Native Razor recovery leaves this original source context unqualified", source.range(node.startIndex, node.endIndex));
      if (syntax.regions.length < MAX_REGIONS4) syntax.regions.push({ key: `recovery:${node.type}:${node.startIndex}:${node.endIndex}`, kind: "recovery", nativeKind: node.type, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex), bodyStart: node.startIndex, bodyEnd: node.endIndex, bodyRange: source.range(node.startIndex, node.endIndex), supported: false, executionContext, conditions: ["Native recovery prevents qualified source ownership"] });
      else facts.truncated = true;
    }
    if (["conversion_operator_declaration", "namespace_declaration", "file_scoped_namespace_declaration"].includes(node.type)) {
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-csharp-profile-gap", "Original namespace/conversion syntax is outside the qualified Razor member profile; compiler/project agreement remains unverified", source.range(node.startIndex, node.endIndex));
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) pending2.push({ node: child3, depth: depth + 1 });
    }
  }
  if (facts.truncated) return facts;
  const captures = query.captures(root, { matchLimit: 4096 }), selected = /* @__PURE__ */ new Map();
  for (const c of captures) if (c.name === "region") selected.set(c.node.id, c.node);
  if (query.didExceedMatchLimit()) facts.truncated = true;
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    if (syntax.regions.length === MAX_REGIONS4) {
      facts.truncated = true;
      break;
    }
    const directive = node.type.endsWith("_directive"), block = node.type === "razor_block", mode = block ? blockKind(node) : void 0, kind = directive ? "directive" : block ? mode === "render" ? "render-block" : "member-block" : node.type === "razor_comment" ? "comment" : node.type === "razor_escape" ? "escape" : node.type === "explicit_line_transition" ? "line-markup" : node.type === "razor_html_attribute" ? "attribute" : node.type.includes("expression") ? "expression" : "control";
    const braces = block ? node.children.filter((n) => n.type === "{" || n.type === "}") : [], bodyStart = block ? braces[0]?.endIndex ?? node.startIndex : node.type === "razor_comment" ? node.startIndex + 2 : node.startIndex, bodyEnd = block ? braces.at(-1)?.startIndex ?? node.endIndex : node.type === "razor_comment" ? Math.max(bodyStart, node.endIndex - 2) : node.endIndex, supported = !node.hasError && !(mode === "code" && sourceKind === "view"), conditions = ["Original Razor syntax; compilation, rendering, project imports and runtime binding are unverified"];
    if (mode === "code" && sourceKind === "view") {
      syntax.csharpComplete = false;
      conditions.push("@code members require a .razor component; .cshtml ownership is unqualified");
      razorIssue(facts, "razor-source-kind-gap", conditions.at(-1), source.range(node.startIndex, node.endIndex));
    }
    const region = { key: `${kind}:${syntax.regions.length}`, kind, nativeKind: node.type, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex), bodyStart, bodyEnd, bodyRange: source.range(bodyStart, bodyEnd), supported, executionContext: ["comment", "escape", "line-markup"].includes(kind) ? "none" : executionContext, conditions };
    syntax.regions.push(region);
    if (directive) {
      syntax.directives.push({ kind: node.type.slice(6, -10), text: content.slice(node.startIndex, node.endIndex), range: region.range, supported });
    }
  }
  for (const c of captures) if (c.name === "preprocessor") {
    if (syntax.directives.length === MAX_REGIONS4) {
      facts.truncated = true;
      break;
    }
    syntax.directives.push({ kind: "csharp-" + c.node.type, text: content.slice(c.node.startIndex, Math.min(c.node.endIndex, c.node.startIndex + 1200)), range: source.range(c.node.startIndex, c.node.endIndex), supported: false });
    syntax.csharpComplete = false;
    razorIssue(facts, "razor-preprocessor-gap", "Original conditional/preprocessor syntax is retained; compiler symbols and branch activation are unverified", source.range(c.node.startIndex, c.node.endIndex));
  }
  for (const capture of captures) if (capture.name === "opaque" || capture.name === "region" && capture.node.type === "explicit_line_transition") {
    const node = capture.node, text = content.slice(node.startIndex, node.endIndex), body3 = capture.name === "opaque" ? text.slice(4, -3) : text.slice(2);
    if (body3.includes("@")) {
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-opaque-transition-gap", "Native opaque HTML comment/line-markup contains @; nested Razor processing is unqualified", source.range(node.startIndex, node.endIndex));
      if (syntax.regions.length < MAX_REGIONS4) syntax.regions.push({ key: `opaque:${node.type}:${node.startIndex}:${node.endIndex}`, kind: "recovery", nativeKind: node.type, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex), bodyStart: node.startIndex, bodyEnd: node.endIndex, bodyRange: source.range(node.startIndex, node.endIndex), supported: false, executionContext, conditions: ["Opaque nested transition is outside the qualified native profile"] });
      else facts.truncated = true;
    }
  }
  const rows = [];
  for (const match of query.matches(root, { matchLimit: 4096 })) {
    const declaration = match.captures.find((c) => c.name.startsWith("declaration.")), name3 = match.captures.find((c) => c.name === "name")?.node;
    if (declaration && name3) {
      if (rows.length === MAX_DECLARATIONS10) {
        facts.truncated = true;
        break;
      }
      rows.push({ node: declaration.node, name: name3, kind: declaration.name.slice(12) });
    }
  }
  if (query.didExceedMatchLimit()) facts.truncated = true;
  const owners2 = /* @__PURE__ */ new Map(), unsafe = /* @__PURE__ */ new Set(), types4 = /* @__PURE__ */ new Set(["class", "interface", "struct", "record", "enum", "type"]);
  for (const { node, name: name3, kind: capturedKind } of rows.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex || a.name.startIndex - b.name.startIndex)) {
    let block, parent, blocked = false, insideFunction = false, directive = false, conditional = false, depth = 0;
    for (let p = node.parent; p; p = p.parent) {
      if (++depth > 128) {
        facts.truncated = true;
        blocked = true;
        break;
      }
      if (p.type.endsWith("_directive")) {
        directive = true;
        break;
      }
      if (p.type.startsWith("preproc_")) conditional = true;
      if (p.isError || unsafe.has(p.id) || ["lambda_expression", "anonymous_method_expression", "namespace_declaration", "file_scoped_namespace_declaration", "conversion_operator_declaration"].includes(p.type)) {
        blocked = true;
        break;
      }
      if (["method_declaration", "local_function_statement", "constructor_declaration", "destructor_declaration", "operator_declaration"].includes(p.type)) insideFunction = true;
      parent ??= owners2.get(p.id);
      if (p.type === "razor_block") {
        block = p;
        break;
      }
    }
    if (directive) continue;
    if (blocked) {
      unsafe.add(node.id);
      continue;
    }
    if (!block || missingDelimiter(block) || blockKind(block) === "code" && sourceKind === "view") {
      unsafe.add(node.id);
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-owner-gap", "C# declaration has no qualified original member/render block; descendants are quarantined", source.range(node.startIndex, node.endIndex));
      continue;
    }
    const member = blockKind(block) !== "render", top = node.parent?.id === block.id, field = capturedKind === "field", statement = field ? node.parent : node;
    if (field) {
      if (insideFunction || !member && !(parent && types4.has(parent.kind))) continue;
      if (!statement || !["field_declaration", "local_declaration_statement", "event_field_declaration"].includes(statement.type)) continue;
      if (!top && statement.parent?.id !== block.id && statement.parent?.type !== "declaration_list" && !statement.parent?.type.startsWith("preproc_")) continue;
    }
    const kind = field ? statement.type === "event_field_declaration" ? "event" : "field" : capturedKind === "method" && (!member || insideFunction) ? "function" : capturedKind;
    if (types4.has(kind) && (!member || insideFunction) || ["property", "event", "indexer", "operator", "constructor", "destructor", "enum-case"].includes(kind) && (!member || insideFunction) || ["constructor", "destructor"].includes(kind) && (!parent || !types4.has(parent.kind))) {
      unsafe.add(node.id);
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-owner-gap", "Type/member declaration requires an original source type/member context; no generated template class is inferred", source.range(node.startIndex, node.endIndex));
      continue;
    }
    if (!field && !top && !parent && kind !== "function" && !conditional) {
      unsafe.add(node.id);
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-owner-gap", "Nested declaration has an unqualified original lexical owner; descendants are quarantined", source.range(node.startIndex, node.endIndex));
      continue;
    }
    const start = field ? statement.startIndex : node.startIndex, type = field ? node.childForFieldName("type") : void 0, body3 = node.childForFieldName("body") ?? node.childForFieldName("accessors") ?? node.childForFieldName("value"), headerEnd = field ? name3.endIndex : body3?.startIndex ?? node.endIndex, rangeEnd = field ? name3.parent?.endIndex ?? name3.endIndex : node.endIndex;
    if (headerEnd - start > 1200 || name3.hasError || name3.isMissing || content.slice(name3.startIndex, name3.endIndex) !== name3.text || damage.some((d) => intersects(start, headerEnd, d.startIndex, d.endIndex)) || (missingDelimiter(node) || !!body3 && body3.children.some((c) => c.isMissing)) && !field) {
      unsafe.add(node.id);
      syntax.csharpComplete = false;
      razorIssue(facts, "razor-original-header-gap", "Original C# header/name/delimiters exceed the bounded native profile or intersect recovery; descendants are quarantined", source.range(start, Math.min(headerEnd, content.length)));
      continue;
    }
    const signature2 = field && type ? content.slice(start, type.endIndex) + " " + name3.text : content.slice(start, headerEnd).trim(), regions = field && type ? [source.range(start, type.endIndex), source.range(name3.startIndex, rangeEnd)] : [source.range(start, rangeEnd)], form = node.childForFieldName("body") || node.childForFieldName("accessors") || node.childForFieldName("value") || field || types4.has(kind) || kind === "enum-case" ? "definition" : "declaration";
    const fact = { key: `razor-csharp:${node.startIndex}:${node.endIndex}:${name3.startIndex}:${kind}`, name: name3.text, qualifiedName: [parent?.qualifiedName, ...kind === "function" && !parent ? [`render:${syntax.regions.filter((r) => r.kind === "render-block" && r.start < block.startIndex).length}`] : [], name3.text].filter(Boolean).join("::"), kind, entityType: types4.has(kind) ? "class" : kind === "function" ? "function" : "method", signature: signature2, start, end: rangeEnd, nameEnd: name3.endIndex, range: source.range(start, rangeEnd), declarationForm: form, sourceConditions: ["Original C# source declaration; generated class/render methods, namespaces/partial component binding, imports, routes and runtime execution remain unverified", ...conditional ? ["Original preprocessor branch; compiler symbols and activation are unverified"] : [], ...field ? ["Field signature consists only of original shared type/modifier bytes and the original declarator name; initializer execution remains unverified"] : [], ...syntax.regions.filter((r) => r.start <= start && r.end >= rangeEnd && r.kind === "control").map(() => "Original conditional/control source context; activation is unverified")], embeddedSource: { language: "csharp", executionContext, headerRange: source.range(start, headerEnd), regions }, ...parent ? { parent: parent.key } : {} };
    facts.declarations.push(fact);
    if (!field) owners2.set(node.id, fact);
  }
  syntax.regions.sort((a, b) => a.start - b.start || b.end - a.end);
  return facts;
}
function razorHostProjection(root, query, content, facts) {
  if (facts.truncated) {
    facts.razor.host.complete = false;
    return content.replace(/[^\r\n]/g, " ");
  }
  const protectedHost = [];
  const chars = content.split(""), mask = (start, end) => {
    for (let i = start; i < end; i++) if (!/[\r\n]/.test(chars[i])) chars[i] = " ";
  };
  for (const r of facts.razor.regions) mask(r.start, r.end);
  const captures = query.captures(root, { matchLimit: 4096 });
  if (query.didExceedMatchLimit()) facts.truncated = true;
  for (const c of captures) if (c.name === "markup" && content[c.node.startIndex] === "<") {
    if (/^<(script|style)(?:[\s>])/i.test(c.node.text) && !c.node.text.includes("@")) protectedHost.push({ start: c.node.startIndex, end: c.node.endIndex });
    for (let i = c.node.startIndex; i < c.node.endIndex; i++) chars[i] = content[i];
  }
  for (const r of facts.razor.regions) if (!["member-block", "render-block", "control", "line-markup"].includes(r.kind) && !(r.kind === "recovery" && protectedHost.some((h) => h.start <= r.start && h.end >= r.end))) mask(r.start, r.end);
  return chars.join("");
}

// src/analysis/tree-sitter/liquid-structure.ts
var CONTROLS = /* @__PURE__ */ new Set(["if_statement", "unless_statement", "case_statement", "for_loop_statement", "capture_statement", "tablerow_statement", "form_statement", "paginate_statement"]);
var OPAQUE = /* @__PURE__ */ new Set(["comment", "doc", "raw_statement", "javascript_statement", "stylesheet_statement", "schema_statement"]);
function extractLiquid(root, query, content, host = "unknown", engine = "unknown") {
  const source = new SourceText(content), facts = { declarations: [], issues: [], truncated: false, liquid: { regions: [], imports: [], bindings: [], host: { language: host, regions: [], complete: true }, engine, nativeComplete: true, complete: true, executionUnverified: true } }, syntax = facts.liquid;
  const selected = /* @__PURE__ */ new Map(), imports = [], bindings = [];
  const recoveries = [];
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  if (host === "javascript" || host === "css") {
    syntax.host.complete = false;
    liquidIssue(facts, "liquid-host-language-gap", "Original non-HTML asset template regions are retained; whole JS/CSS asset processors and rendered equivalence remain unqualified");
  }
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > 2e5 || depth > 128) {
      facts.truncated = true;
      return finishLiquid(facts);
    }
    if (node.isError || node.isMissing) {
      recoveries.push(node);
      syntax.nativeComplete = false;
      liquidIssue(facts, "liquid-parse-gap", "Native Liquid recovery/missing syntax leaves engine/body ownership unqualified", node.startIndex, Math.min(node.endIndex, content.length), content);
    }
    const previous = node.previousSibling, recoveredRenderOperand = previous?.isError && previous.text.trim() === "render" && /^[ \t]*$/.test(content.slice(previous.endIndex, node.startIndex));
    if (node.type === "custom_unpaired_statement" && !recoveredRenderOperand) {
      syntax.nativeComplete = false;
      liquidIssue(facts, "liquid-custom-tag-gap", "Custom engine tags have unqualified block/output semantics; host declarations and template lookup are quarantined", node.startIndex, node.endIndex, content);
    }
    if (node.type === "doc" && engine !== "shopify") {
      syntax.nativeComplete = false;
      liquidIssue(facts, "liquid-doc-engine-gap", "Non-rendered doc bodies require a qualified Shopify engine profile", node.startIndex, node.endIndex, content);
    }
    if (node.type === "raw_statement" && node.namedChildren.some((n) => n.type === "raw_statement")) {
      syntax.nativeComplete = false;
      liquidIssue(facts, "liquid-raw-nesting-gap", "Native nested raw blocks do not establish agreement with engine endraw semantics", node.startIndex, node.endIndex, content);
    }
    if (OPAQUE.has(node.type)) {
      if (node.hasError) {
        const completeDoc = node.type === "doc" && node.children.filter((c) => !c.isNamed && c.text.includes("{%")).length === 2 && node.children.some((c) => !c.isNamed && c.text.trim() === "enddoc");
        if (!completeDoc) {
          syntax.nativeComplete = false;
          recoveries.push(node);
        }
        liquidIssue(facts, completeDoc ? "liquid-doc-body-gap" : "liquid-opaque-recovery-gap", "Original opaque block delimiters are incomplete or recovered", node.startIndex, node.endIndex, content);
      }
      continue;
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child3 = node.child(i);
      if (child3) stack.push({ node: child3, depth: depth + 1 });
    }
  }
  for (const capture of query.captures(root, { matchLimit: 4096 })) {
    if (capture.name === "region") selected.set(capture.node.id, capture.node);
    else if (capture.name === "import") imports.push(capture.node);
    else if (capture.name === "binding") bindings.push(capture.node);
    if (selected.size + imports.length + bindings.length > 2e4) {
      facts.truncated = true;
      return finishLiquid(facts);
    }
  }
  if (query.didExceedMatchLimit()) {
    facts.truncated = true;
    return finishLiquid(facts);
  }
  const add = (kind, node, start = node.startIndex, end = node.endIndex, bodyStart = start, bodyEnd = end, supported = !node.hasError, conditions = []) => {
    if (syntax.regions.length >= 4096) {
      facts.truncated = true;
      return;
    }
    syntax.regions.push({ key: `${kind}:${start}:${end}`, kind, nativeKind: node.type, start, end, range: source.range(start, end), bodyStart, bodyEnd, bodyRange: source.range(bodyStart, bodyEnd), supported, conditions });
  };
  for (const node of recoveries) add("recovery", node);
  const opaque = [...selected.values()].filter((n) => OPAQUE.has(n.type));
  const excluded = (node) => opaque.some((p) => p.id !== node.id && p.startIndex <= node.startIndex && p.endIndex >= node.endIndex);
  for (const node of [...selected.values()].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)) {
    if (excluded(node)) continue;
    if (node.type === "template_content") {
      const ambiguous = /\{[{%]/.test(node.text);
      add("literal", node, node.startIndex, node.endIndex, node.startIndex, node.endIndex, !ambiguous);
      if (ambiguous) {
        syntax.nativeComplete = false;
        liquidIssue(facts, "liquid-literal-delimiter-gap", "Native literal text contains a Liquid opening marker; escaped/triple delimiters require an engine-qualified raw context and host declarations are quarantined", node.startIndex, node.endIndex, content);
      }
      continue;
    }
    if (node.type === "front_matter") {
      add("front-matter", node);
      liquidIssue(facts, "liquid-front-matter-gap", "Original front matter is retained; Jekyll/data-engine evaluation and template lookup are unqualified", node.startIndex, node.endIndex, content);
      continue;
    }
    const opens = node.children.filter((n) => !n.isNamed && n.text.includes("{%")), closes = node.children.filter((n) => !n.isNamed && n.text.includes("%}"));
    const firstOpen = opens[0], lastOpen = opens.at(-1), start = firstOpen ? firstOpen.startIndex + firstOpen.text.indexOf("{%") : node.startIndex;
    const bodyStart = closes[0]?.endIndex ?? node.startIndex, bodyEnd = lastOpen ? lastOpen.startIndex + lastOpen.text.indexOf("{%") : node.endIndex;
    let kind = CONTROLS.has(node.type) ? "control" : node.type === "comment" ? "comment" : node.type === "doc" ? "doc" : node.type === "raw_statement" ? "raw" : node.type.replace(/_statement$/, "");
    const conditions = ["Original Liquid source; engine/render/runtime execution is unverified"];
    if (kind === "raw") conditions.push("Raw content remains original literal bytes; native raw_content coordinates are not used");
    if (["javascript", "stylesheet", "schema", "style"].includes(kind)) conditions.push("Shopify-specific body semantics require an indexed/configured Shopify application");
    const paired = opens.length >= 2 && closes.length >= 2;
    add(kind, node, start, node.endIndex, paired ? bodyStart : node.startIndex, paired ? Math.max(bodyStart, bodyEnd) : node.endIndex, !node.hasError, conditions);
  }
  const pending2 = [root];
  while (pending2.length && !facts.truncated) {
    const node = pending2.pop();
    if (OPAQUE.has(node.type)) continue;
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const open = children[i], match = /(\{%|\{\{)/.exec(open.text);
      if (open.isNamed || !match) continue;
      const delimiter = match[1], closeSpelling = delimiter === "{%" ? "%}" : "}}";
      let j = i + 1;
      while (j < children.length && !(!children[j].isNamed && children[j].text.includes(closeSpelling))) j++;
      if (j === children.length) continue;
      const close = children[j], start = open.startIndex + match.index, end = close.endIndex, bodyStart = open.endIndex, bodyEnd = close.startIndex;
      add(delimiter === "{%" ? "tag" : "output", node, start, end, bodyStart, bodyEnd, !children.slice(i, j + 1).some((n) => n.hasError));
      i = j;
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child3 = node.namedChild(i);
      if (child3) pending2.push(child3);
    }
  }
  for (const node of imports.sort((a, b) => a.startIndex - b.startIndex)) {
    if (excluded(node) || OPAQUE.has(node.type)) continue;
    if (syntax.imports.length >= 4096) {
      facts.truncated = true;
      break;
    }
    const kind = node.children.find((n) => !n.isNamed)?.text.trim(), literal = node.childForFieldName("file") ?? node.namedChildren.find((n) => n.type === "string"), raw = literal?.text, quoted = raw && /^(['"])[^\r\n]*\1$/.test(raw), specifier = quoted ? raw.slice(1, -1) : void 0;
    const conditions = ["Source template dependency only; rendering, parameter binding and runtime activation are unverified"];
    for (let parent = node.parent; parent; parent = parent.parent) if (CONTROLS.has(parent.type)) conditions.push(`Original ${parent.type} at line ${source.range(parent.startIndex, parent.endIndex).startLine}; conditional rendering and variable scopes are unverified`);
    const supported = syntax.nativeComplete && !node.hasError && !!specifier;
    if (!supported) conditions.push("A complete native source context and original quoted literal filename are required");
    syntax.imports.push({ kind, text: content.slice(node.startIndex, node.endIndex), ...specifier !== void 0 ? { specifier } : {}, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex), supported, conditions });
  }
  for (const region of syntax.regions.filter((r) => r.kind === "tag")) {
    const text = content.slice(region.bodyStart, region.bodyEnd).trim(), kind = /^(render|include_relative|include|section|sections|layout)\b/.exec(text)?.[1];
    if (!kind || syntax.imports.some((i) => i.start >= region.bodyStart && i.end <= region.bodyEnd)) continue;
    if (syntax.imports.length >= 4096) {
      facts.truncated = true;
      break;
    }
    syntax.imports.push({ kind, text, start: region.bodyStart, end: region.bodyEnd, range: source.range(region.bodyStart, region.bodyEnd), supported: false, conditions: ["Native tag retained, but original dependency statement was recovered or outside the qualified literal syntax profile"] });
  }
  syntax.imports.sort((a, b) => a.start - b.start);
  for (const node of bindings.sort((a, b) => a.startIndex - b.startIndex)) {
    if (excluded(node) || node.hasError) continue;
    if (syntax.bindings.length >= 4096) {
      facts.truncated = true;
      break;
    }
    const name3 = node.childForFieldName("variable_name") ?? node.childForFieldName("item") ?? node.namedChildren.find((n) => n.type === "identifier");
    if (!name3) continue;
    syntax.bindings.push({ name: name3.text, kind: node.type, range: source.range(node.startIndex, node.endIndex), nameRange: source.range(name3.startIndex, name3.endIndex) });
  }
  syntax.regions.sort((a, b) => a.start - b.start || b.end - a.end || a.kind.localeCompare(b.kind, "en"));
  if (!syntax.nativeComplete) syntax.host.complete = false;
  return finishLiquid(facts);
}
function liquidHostProjection(content, facts) {
  const syntax = facts.liquid, chars = content.split("").map((c) => /[\r\n]/.test(c) ? c : " ");
  if (facts.truncated || !syntax.nativeComplete) return chars.join("");
  for (const r of syntax.regions) if (r.kind === "literal" || r.kind === "raw") for (let i = r.kind === "raw" ? r.bodyStart : r.start; i < (r.kind === "raw" ? r.bodyEnd : r.end); i++) chars[i] = content[i];
  for (const r of syntax.regions) if (["comment", "doc", "schema", "javascript", "stylesheet", "style", "front-matter", "tag", "output"].includes(r.kind)) {
    for (let i = r.start; i < r.end; i++) if (!/[\r\n]/.test(chars[i])) chars[i] = " ";
  }
  return chars.join("");
}
function extractLiquidBodyHosts(content, facts, bodyTags = true) {
  const syntax = facts.liquid;
  if (facts.truncated) return;
  const javascriptBlocks = syntax.regions.filter((r) => r.kind === "javascript"), stylesheetBlocks = syntax.regions.filter((r) => r.kind === "stylesheet");
  if (syntax.engine === "shopify" && (javascriptBlocks.length > 1 || stylesheetBlocks.length > 1)) liquidIssue(facts, "liquid-body-count-gap", "Multiple original JavaScript/stylesheet blocks exceed the Shopify one-block-per-kind/source contract; only independent original source syntax is retained");
  for (const r of syntax.regions.filter((r2) => ["javascript", "stylesheet", "style"].includes(r2.kind))) {
    const dynamicStyle = r.kind === "style" && (/\{[{%]/.test(content.slice(r.bodyStart, r.bodyEnd)) || syntax.regions.some((c) => c !== r && c.kind !== "literal" && c.start >= r.bodyStart && c.end <= r.bodyEnd));
    const recovered = syntax.regions.some((c) => c.kind === "recovery" && c.start < r.end && c.end > r.start) || facts.issues.some((i) => ["liquid-custom-tag-gap", "liquid-raw-nesting-gap"].includes(i.code));
    const supported = (r.kind === "style" ? syntax.host.language === "html" : bodyTags) && !recovered && !dynamicStyle && syntax.engine === "shopify" && r.supported && r.bodyStart > r.start && r.bodyEnd < r.end && !syntax.regions.some((c) => c.kind === "control" && c.start <= r.start && c.end >= r.end);
    if (!supported) {
      syntax.host.complete = false;
      liquidIssue(facts, "liquid-body-engine-gap", "Source body requires a complete original Shopify block and unambiguous application/control context; interpolated style output is unqualified", r.start, r.end, content);
    }
    const javascript = r.kind === "javascript";
    syntax.host.regions.push({ kind: javascript ? "script" : "style", start: r.start, end: r.end, range: r.range, bodyStart: r.bodyStart, bodyEnd: r.bodyEnd, bodyRange: r.bodyRange, attributes: [], executionContext: javascript ? "browser" : "none", language: javascript ? "javascript" : "css", supported, conditions: [...r.conditions, ...(javascript ? javascriptBlocks.length > 1 : r.kind === "stylesheet" && stylesheetBlocks.length > 1) ? ["Multiple body blocks; engine bundle/runtime placement is unqualified"] : [], "Original Shopify body syntax only; bundle placement and runtime execution remain unverified"] });
  }
  syntax.host.regions.sort((a, b) => a.start - b.start);
}

// src/analysis/tree-sitter/worker.ts
var loaded = /* @__PURE__ */ new Map();
function reply(id, response) {
  const payload = serialize(response);
  process.send?.({ id, type: "completed", completedAtNs: process.hrtime.bigint().toString(), bytes: payload.byteLength });
  process.send?.({ id, type: "result", payload });
}
var initialized = Parser.init();
async function load(language) {
  await initialized;
  let entry = loaded.get(language);
  if (entry) return entry;
  const spec = grammarCatalog.get(language);
  if (!spec) throw new Error(`Unknown grammar: ${language}`);
  const grammar = await Language.load(verifiedGrammar(spec));
  if (grammar.abiVersion !== spec.abi) throw new Error(`Grammar ABI mismatch: ${language}`);
  const query = new Query(grammar, queryText(language));
  const parser = new Parser();
  parser.setLanguage(grammar);
  entry = { parser, query };
  loaded.set(language, entry);
  return entry;
}
async function handle(job) {
  try {
    const { parser, query } = await load(job.language);
    parser.reset();
    const input = ["go", "csharp", "c", "cpp", "objective-c", "vbnet"].includes(job.language) && !job.content.endsWith("\n") ? `${job.content}
` : job.content;
    const tree = parser.parse(input);
    if (!tree) throw new Error("Parser returned no tree");
    try {
      let facts = job.language === "erb" ? extractErbRegions(tree.rootNode, query, job.content, job.erbHost) : job.language === "razor" ? extractRazor(tree.rootNode, query, job.content, job.razorKind) : job.language === "liquid" ? extractLiquid(tree.rootNode, query, job.content, job.liquidHost, job.liquidEngine) : extractStructure(tree.rootNode, query, job.language, job.content);
      if (job.language === "erb") {
        const projection = erbRubyProjection(job.content, facts);
        if (projection?.trim()) try {
          const ruby = await load("ruby");
          ruby.parser.reset();
          const rubyTree = ruby.parser.parse(projection);
          if (!rubyTree) throw Error("Ruby projection returned no tree");
          try {
            extractErbRuby(rubyTree.rootNode, ruby.query, job.content, facts);
          } finally {
            rubyTree.delete();
          }
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
          facts.erb.rubyComplete = false;
          erbIssue(facts, "erb-ruby-unavailable", `Original ERB regions retained; Ruby grammar/query unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (job.erbHost === "html") try {
          const html = await load("html");
          html.parser.reset();
          const htmlTree = html.parser.parse(erbHostProjection(job.content, facts));
          if (!htmlTree) throw Error("HTML projection returned no tree");
          try {
            extractErbHost(htmlTree.rootNode, html.query, job.content, facts);
          } finally {
            htmlTree.delete();
          }
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
          facts.erb.host.complete = false;
          erbIssue(facts, "erb-html-unavailable", `Original ERB/Ruby regions retained; HTML grammar/query unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!job.nativeOnly && facts.erb.host.regions.some((r) => r.kind === "script" && r.supported && r.language === "javascript")) {
          const compiler = (await import("typescript")).default;
          extractErbScripts(compiler, job.content, facts);
        }
        if (!job.nativeOnly) facts = finishErb(facts);
      }
      if (job.language === "razor") {
        if (facts.truncated) facts.razor.host.complete = false;
        else try {
          const html = await load("html");
          html.parser.reset();
          const host = html.parser.parse(razorHostProjection(tree.rootNode, query, job.content, facts));
          if (!host) throw Error("HTML projection returned no tree");
          try {
            extractTemplateHost(host.rootNode, html.query, job.content, facts, "razor");
          } finally {
            host.delete();
          }
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
          facts.razor.host.complete = false;
          razorIssue(facts, "razor-html-unavailable", `Original Razor/C# source retained; HTML grammar/query unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!job.nativeOnly && !facts.truncated && facts.razor.host.regions.some((r) => r.kind === "script" && r.supported && r.language === "javascript")) {
          const compiler = (await import("typescript")).default;
          extractLiteralScripts(compiler, job.content, facts, "razor");
        }
        if (!job.nativeOnly) facts = finishRazor(facts);
      }
      if (job.language === "liquid") {
        if (!facts.truncated && facts.liquid.nativeComplete && job.liquidHost === "html") try {
          const html = await load("html");
          html.parser.reset();
          const host = html.parser.parse(liquidHostProjection(job.content, facts));
          if (!host) throw Error("HTML projection returned no tree");
          try {
            extractTemplateHost(host.rootNode, html.query, job.content, facts, "liquid");
          } finally {
            host.delete();
          }
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
          facts.liquid.host.complete = false;
          liquidIssue(facts, "liquid-html-unavailable", `Original Liquid regions retained; HTML grammar/query unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        extractLiquidBodyHosts(job.content, facts, job.liquidBodyTags);
        if (!job.nativeOnly && !facts.truncated && facts.liquid.host.regions.some((r) => r.kind === "script" && r.supported && r.language === "javascript")) {
          const compiler = (await import("typescript")).default;
          extractLiteralScripts(compiler, job.content, facts, "liquid");
        }
        if (!job.nativeOnly) facts = finishLiquid(facts);
      }
      if (job.language === "objective-c") {
        facts = recoverObjcRegions(facts, job.content, parser, query);
        if (job.objectiveCpp) {
          recoverOriginalCppMethods(facts, job.content);
          try {
            const cpp = await load("cpp");
            cpp.parser.reset();
            const cppTree = cpp.parser.parse(input);
            if (!cppTree) throw new Error("C++ parser returned no tree");
            try {
              facts = composeObjcCpp(facts, cppTree.rootNode, cpp.query, job.content);
            } finally {
              cppTree.delete();
            }
          } catch (error) {
            facts.declarations = [...originalObjcDeclarations(facts.declarations), ...facts.declarations.filter((f) => f.kind === "macro")];
            if (facts.issues.length >= 100) {
              facts.issues.pop();
              facts.truncated = true;
            }
            facts.issues.push({ code: "objc-cpp-grammar-unavailable", reason: `Original Objective-C declarations retained; auxiliary C++ grammar unavailable: ${error instanceof Error ? error.message : String(error)}` });
            if (facts.objc) facts.objc.complete = false;
          }
        }
        facts = extractObjcMacroProfiles(facts, job.content);
      }
      reply(job.id, { facts });
    } finally {
      tree.delete();
    }
  } catch (error) {
    reply(job.id, { error: error instanceof Error ? error.message : String(error) });
  }
}
var pending = Promise.resolve();
process.on("message", (job) => {
  pending = pending.then(() => handle(job));
});
process.once("disconnect", () => {
  for (const { parser, query } of loaded.values()) {
    query.delete();
    parser.delete();
  }
  process.exit(0);
});
