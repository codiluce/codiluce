// A cancellable parser process. A pathological grammar/query cannot block the
// indexer, and all WASM resources disappear when this process is terminated.
import { Parser, Language, Query } from 'web-tree-sitter';
import { grammarCatalog, queryText, verifiedGrammar } from './grammars.js';
import { extractStructure } from './extract.js';

const loaded = new Map<string, { parser: Parser; query: Query }>();
const initialized = Parser.init();
async function load(language: string): Promise<{ parser: Parser; query: Query }> {
  await initialized;
  let entry = loaded.get(language);
  if (entry) return entry;
  const spec = grammarCatalog.get(language);
  if (!spec) throw new Error(`Unknown grammar: ${language}`);
  const grammar = await Language.load(verifiedGrammar(spec));
  if (grammar.abiVersion !== spec.abi) throw new Error(`Grammar ABI mismatch: ${language}`);
  const query = new Query(grammar, queryText(language));
  const parser = new Parser(); parser.setLanguage(grammar);
  entry = { parser, query }; loaded.set(language, entry);
  return entry;
}
async function handle(job: { id: number; language: string; content: string }): Promise<void> {
  try {
    const { parser, query } = await load(job.language);
    parser.reset();
    // Go's EOF semicolon and C# EOF preprocessor directives need a terminal
    // newline in these grammars; positions still map to the original input.
    const input = ['go','csharp'].includes(job.language) && !job.content.endsWith('\n') ? `${job.content}\n` : job.content;
    const tree = parser.parse(input);
    if (!tree) throw new Error('Parser returned no tree');
    try { process.send?.({ id: job.id, facts: extractStructure(tree.rootNode, query, job.language, job.content) }); }
    finally { tree.delete(); }
  } catch (error) { process.send?.({ id: job.id, error: error instanceof Error ? error.message : String(error) }); }
}
let pending = Promise.resolve();
process.on('message', (job: { id: number; language: string; content: string }) => { pending = pending.then(() => handle(job)); });
process.once('disconnect', () => {
  for (const { parser, query } of loaded.values()) { query.delete(); parser.delete(); }
  process.exit(0);
});
