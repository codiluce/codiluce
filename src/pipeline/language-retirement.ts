import type { AnalysisContext } from '../core/analyzer.js';

/** The default pipeline has finished the native-language import, symbol and
 * framework consumers before it enters embedded/TypeScript analysis. Retire
 * their context roots, leaving graph facts and the later PHP phase untouched.
 * Individual analyzers retain their services for callers that compose them. */
export function retireNativeLanguageServices(context: AnalysisContext): void {
  if (context.syntax) {
    const remaining: NonNullable<AnalysisContext['syntax']> = new Map();
    for (const [file, syntax] of context.syntax) {
      const facts = syntax.facts;
      if (facts.php || !(facts.liquid || facts.python || facts.go || facts.ruby || facts.jvm || facts.csharp || facts.rust)) remaining.set(file, syntax);
    }
    context.syntax = remaining.size ? remaining : undefined;
  }
  context.python = undefined;
  context.go = undefined;
  context.goSymbols = undefined;
  context.ruby = undefined;
  context.rubySymbols = undefined;
  context.rubyAutoload = undefined;
  context.jvm = undefined;
  context.jvmSymbols = undefined;
  context.csharp = undefined;
  context.csharpSymbols = undefined;
  context.rust = undefined;
  context.rustSymbols = undefined;
  // A subsequent consumer reads through the unchanged scan/hash boundary.
  // Keep source failures, dependency reads and directory ownership intact.
  context.sources?.clear();
}
