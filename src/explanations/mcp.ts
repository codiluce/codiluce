// `codiluce mcp`: a Model Context Protocol server over stdio, so an agent
// (Claude Code, Codex, Cursor…) can ask the index about the code and save
// what it explains for the map. JSON-RPC 2.0, one message per line; nothing
// but protocol messages goes to stdout (logs go to stderr).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { HistoryAccess, HistoryService } from '../history/service.js';
import { AnnotationAccess } from '../ai/store.js';
import { ProjectionService } from '../projection/service.js';
import { GraphStore } from '../storage/sqlite.js';
import { ActivityWriter } from './activity.js';
import { LINK_GUIDE } from './links.js';
import type { SubjectKind } from './model.js';
import { agentPrompt, MCP_PROMPTS, type PromptKind } from './prompts.js';
import { ExplanationService } from './service.js';
import { codeTools, describeTool, explanationTools, runTool, type ToolContext, type ToolSpec } from './tools.js';
import { ConversationService } from '../conversations/service.js';
import { conversationTools } from '../conversations/tools.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Where `serve` says it listens, so a saved explanation can be opened. */
export const SERVE_FILE = 'serve.json';
type Id = string | number | null;
interface Message { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> }

export const MCP_INSTRUCTIONS = [
  'Codiluce has indexed this repository into an evidenced graph: files, symbols, routes and endpoints, tables, the calls and HTTP requests between them (across frontend and backend), every flow by entry point, the blast radius of a change, and the Git history.',
  'Use these tools to understand the code before reading files one by one: start with `overview`, find things with `search`, then `entity`, `flow`, `impact`, `commit` and `source`.',
  'When the user wants to understand something, call `start_explanation` first (with their question), so the Codiluce map shows at once that an explanation is on its way, then save your explanation with `publish_explanation`: they read it in the Explanations column of the Codiluce map, where hovering a link lights that code and clicking opens it.',
  LINK_GUIDE,
].join('\n\n');

export interface McpOptions {
  root: string; stateDirectory: string; version: string;
  maxFileBytes?: number;
  input?: Readable; output?: Writable; log?: (line: string) => void;
}
/** Serve MCP on stdio until the input ends. */
export async function runMcpServer(options: McpOptions): Promise<void> {
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  const session = new McpSession(options);
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const work = session.receive(line).then(reply => { if (reply) output.write(`${JSON.stringify(reply)}\n`); }).catch(error => log(`codiluce mcp: ${error instanceof Error ? error.message : String(error)}`));
    pending.add(work); void work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
  session.close();
}

/** One client's session: the index opened on first use, its tools and prompts, and what it is doing (shown on the map). */
export class McpSession {
  private client?: { name?: string; version?: string };
  private opened?: { store: GraphStore; access: HistoryAccess; notes: AnnotationAccess; tools: ToolSpec[] };
  private journal?: { conversations: ConversationService; tools: ToolSpec[] };
  readonly activity: ActivityWriter;
  constructor(private readonly options: McpOptions) { this.activity = new ActivityWriter(options.stateDirectory); }
  close(): void { this.activity.close(); this.journal?.conversations.close(); if (this.opened) { this.opened.access.close(); this.opened.notes.close(); this.opened.store.close(); } }

  async receive(line: string): Promise<unknown> {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return error(null, -32700, 'Parse error'); }
    if (Array.isArray(message)) return error(null, -32600, 'Batches are not supported');
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') return message && 'id' in message ? error(message.id ?? null, -32600, 'Invalid request') : undefined;
    const notification = !('id' in message) || message.id === undefined;
    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      return notification ? undefined : { jsonrpc: '2.0', id: message.id, result };
    } catch (failure) {
      if (notification) return undefined;
      if (failure instanceof RpcError) return error(message.id!, failure.code, failure.message);
      return error(message.id!, -32603, failure instanceof Error ? failure.message : String(failure));
    }
  }
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const info = params.clientInfo as { name?: string; version?: string } | undefined;
        this.client = info && typeof info === 'object' ? { ...(typeof info.name === 'string' ? { name: info.name } : {}), ...(typeof info.version === 'string' ? { version: info.version } : {}) } : undefined;
        this.activity.connect(this.client?.name);
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'codiluce', title: 'Codiluce', version: this.options.version },
          instructions: MCP_INSTRUCTIONS,
        };
      }
      case 'notifications/initialized': case 'notifications/cancelled': return {};
      case 'ping': return {};
      case 'tools/list': return { tools: this.tools().map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { title: tool.title, readOnlyHint: tool.readOnly, openWorldHint: false, ...(tool.readOnly ? {} : { destructiveHint: false, idempotentHint: false }) } })) };
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!this.tools().some(tool => tool.name === name)) throw new RpcError(-32602, `Unknown tool ${name}`);
        // Recorded before the tool runs: the map shows the step while it is taken.
        if (name !== 'start_explanation') this.activity.step(describeTool(name, params.arguments));
        const { text, isError } = await runTool(this.tools(), name, params.arguments ?? {});
        return { content: [{ type: 'text', text }], isError };
      }
      case 'prompts/list': return { prompts: MCP_PROMPTS.map(prompt => ({ name: prompt.name, title: prompt.title, description: prompt.description, arguments: prompt.argument ? [{ name: prompt.argument.name, description: prompt.argument.description, required: true }] : [] })) };
      case 'prompts/get': {
        const prompt = MCP_PROMPTS.find(item => item.name === params.name);
        if (!prompt) throw new RpcError(-32602, `Unknown prompt ${String(params.name)}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const value = prompt.argument ? args[prompt.argument.name] : undefined;
        if (prompt.argument && (typeof value !== 'string' || !value.trim())) throw new RpcError(-32602, `The ${prompt.argument.name} argument is required`);
        const target = prompt.target(typeof value === 'string' ? value.trim() : undefined);
        // The user just ran the prompt (a slash command): the explanation is on its way before the agent's first tool call.
        const kind = PROMPT_SUBJECTS[target.kind];
        this.activity.begin({ title: typeof value === 'string' && value.trim() ? `${prompt.title}: ${value.trim()}` : prompt.title, ...(kind ? { subject: { kind, ...(target.ref ? { ref: target.ref } : {}) } } : {}) }, { fresh: true });
        return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: agentPrompt(target) } }] };
      }
      case 'resources/list': return { resources: [] };
      default: throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }
  private tools(): ToolSpec[] {
    if (this.opened) return this.opened.tools;
    this.journal ??= (() => {
      const conversations = new ConversationService({ root: this.options.root, stateDirectory: this.options.stateDirectory });
      return { conversations, tools: conversationTools(conversations) };
    })();
    const database = path.join(this.options.stateDirectory, 'codiluce.db');
    if (!existsSync(database)) return [notIndexed(this.options.root), ...this.journal.tools];
    const store = new GraphStore(database, true);
    const access = new HistoryAccess(this.options.stateDirectory);
    const notes = new AnnotationAccess(this.options.stateDirectory, existsSync);
    const projection = new ProjectionService(store, { stateDirectory: this.options.stateDirectory, root: this.options.root, history: access.get, annotations: notes.get });
    const history = new HistoryService({ root: this.options.root, stateDirectory: this.options.stateDirectory, store, history: access });
    const service = new ExplanationService({ stateDirectory: this.options.stateDirectory, root: this.options.root, projection, history });
    const context: ToolContext = { service, projection, history, root: this.options.root, maxFileBytes: this.options.maxFileBytes ?? 1024 * 1024, serverUrl: () => serveUrl(this.options.stateDirectory), agent: () => this.client?.name, activity: this.activity };
    this.opened = { store, access, notes, tools: [...codeTools(context), ...explanationTools(context), ...this.journal.tools] };
    return this.opened.tools;
  }
}
const PROMPT_SUBJECTS: Record<PromptKind, SubjectKind | undefined> = { overview: 'overview', flow: 'flow', commit: 'commit', pr: 'pr', entity: 'entity', impact: 'entity', coverage: 'entity', refresh: undefined };
class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
function error(id: Id, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function notIndexed(root: string): ToolSpec {
  return { name: 'overview', title: 'Repository overview', description: 'The repository has not been indexed yet.', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: async () => `Codiluce has not indexed ${root} yet. Run \`npx codiluce start\` there (or \`codiluce index\`), then reconnect.` };
}
/** The running map's address, when `serve` recorded one and its process is alive. */
export function serveUrl(stateDirectory: string): string | undefined {
  try {
    const record = JSON.parse(readFileSync(path.join(stateDirectory, SERVE_FILE), 'utf8')) as { url?: string; pid?: number };
    if (!record.url) return undefined;
    if (record.pid) { try { process.kill(record.pid, 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') return undefined; } }
    return record.url;
  } catch { return undefined; }
}
