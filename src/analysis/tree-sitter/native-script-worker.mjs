// Generated from Codiluce’s typed source-only parser. Do not edit.
// Rebuild: npm run build:script-worker

// src/analysis/tree-sitter/script-worker.ts
import { serialize } from "node:v8";

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

// src/analysis/tree-sitter/template-facts.ts
var MAX_ISSUES = 100;
function erbIssue(facts, code, reason, range) {
  if (facts.issues.length < MAX_ISSUES) facts.issues.push({ code, reason, ...range ? { range } : {} });
  else facts.truncated = true;
}
function finishErb(facts) {
  if (facts.truncated && !facts.issues.some((i) => i.code === "erb-budget-exceeded")) {
    if (facts.issues.length === MAX_ISSUES) facts.issues.pop();
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

// src/analysis/tree-sitter/erb-script.ts
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
    const program = compiler.createProgram([source.fileName], { allowJs: true, noResolve: true, noLib: true, noEmit: true }, { getSourceFile: (name) => name === source.fileName ? source : void 0, getDefaultLibFileName: () => "", writeFile: () => {
    }, getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (name) => name === source.fileName, readFile: (name) => name === source.fileName ? text : void 0, getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n" });
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
      const classNode = compiler.isClassDeclaration(node) || compiler.isClassExpression(node), functionNode = compiler.isFunctionDeclaration(node) || compiler.isFunctionExpression(node), method = compiler.isMethodDeclaration(node) || compiler.isGetAccessorDeclaration(node) || compiler.isSetAccessorDeclaration(node), constructor = compiler.isConstructorDeclaration(node), name = classNode || functionNode || method ? node.name : void 0;
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
        if (blocked || !name && !constructor || (method || constructor) && (!parent || parent.kind !== "class")) {
          issue("erb-script-owner-gap", "Unnamed JavaScript type/callback or object member has no qualified original source owner; nested declarations are quarantined", original.range(offset + node.getStart(source), offset + node.end));
          blocked = true;
        } else {
          const body = classNode ? node.getChildren(source).find((n) => n.kind === compiler.SyntaxKind.OpenBraceToken) : node.body, start = node.getStart(source), headerEnd = body?.getStart(source) ?? node.end, nameStart = name?.getStart(source) ?? start, nameEnd = name?.end ?? start + "constructor".length, nameText = name?.getText(source) ?? "constructor", kind = classNode ? "class" : functionNode ? "function" : constructor ? "constructor" : compiler.isGetAccessorDeclaration(node) ? "get-accessor" : compiler.isSetAccessorDeclaration(node) ? "set-accessor" : "method";
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

// src/analysis/tree-sitter/script-worker.ts
function reply(id, response) {
  const payload = serialize(response);
  process.send?.({ id, type: "completed", completedAtNs: process.hrtime.bigint().toString(), bytes: payload.byteLength });
  process.send?.({ id, type: "result", payload });
}
async function handle(job) {
  try {
    const compiler = (await import("typescript")).default;
    extractLiteralScripts(compiler, job.content, job.facts, job.template);
    const facts = job.template === "erb" ? finishErb(job.facts) : job.template === "razor" ? finishRazor(job.facts) : finishLiquid(job.facts);
    reply(job.id, { facts });
  } catch (error) {
    reply(job.id, { error: error instanceof Error ? error.message : String(error) });
  }
}
var pending = Promise.resolve();
process.on("message", (job) => {
  pending = pending.then(() => handle(job));
});
process.once("disconnect", () => process.exit(0));
