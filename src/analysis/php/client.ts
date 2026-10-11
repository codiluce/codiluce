import { fileURLToPath } from 'node:url';
import { StructureParser } from '../tree-sitter/client.js';
import type { StructureFacts } from '../facts.js';
import type { Ast } from '../../analyzers/php-ast.js';
import { extractPhp } from './structure.js';

export interface PhpSourceUnit extends StructureFacts { phpAst?: Ast; phpAstBytes?: number; phpAstGap?: string }

// Share the bounded IPC transport, not a Tree-sitter grammar or PHP runtime.
const worker = fileURLToPath(new URL('./native-worker.mjs', import.meta.url));
export class PhpParser extends StructureParser {
  // Native PHP jobs create a fresh Engine each time. A reported source error
  // cannot poison neighboring queued jobs; exits/deadlines still reset IPC.
  constructor(timeoutMs = 10_000) { super(timeoutMs, worker, ['--max-old-space-size=256'], false); }
  async parseSource(content: string):Promise<StructureFacts> { const {phpAst,phpAstBytes,phpAstGap,...facts}=await this.parseUnit(content);return facts; }
  async parseUnit(content: string): Promise<PhpSourceUnit> {
    const native=await this.parse('php-native-unit',content) as PhpSourceUnit;
    if(!native.phpAst||native.phpAst.kind!=='program')throw Error(native.phpAstGap??'PHP native parser returned no original program');
    const facts=extractPhp(native.phpAst,content);
    delete native.phpAst.tokens;
    if(facts.truncated||facts.issues.some(issue=>issue.code==='php-original-token-gap'))return {...facts,phpAstGap:'Original native tree is unavailable after bounded source extraction failure'};
    return {...facts,phpAst:native.phpAst,phpAstBytes:native.phpAstBytes};
  }
}
