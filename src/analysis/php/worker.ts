import { Engine } from 'php-parser';
import { extractPhp } from './structure.js';
import type { Ast } from '../../analyzers/php-ast.js';

// The existing JS parser reads original PHP source. No PHP executable,
// autoloader, dependencies, user code or Composer hook is invoked.
process.on('message', (job: { id: number; content: string }) => {
  try {
    const engine = new Engine({ parser: { version: '8.4', suppressErrors: false, extractTokens: true }, ast: { withPositions: true } });
    const root = engine.parseCode(job.content, 'original.php') as unknown as Ast;
    process.send?.({ id: job.id, facts: extractPhp(root, job.content) });
  } catch (error) {
    process.send?.({ id: job.id, error: error instanceof Error ? error.message : String(error) });
  }
});
