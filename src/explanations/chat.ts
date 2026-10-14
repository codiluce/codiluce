// The chat in the map: a question (with the code it is about attached) is
// answered by a language model that reads the index through the same tools an
// agent gets over MCP, and the answer is saved as an explanation. Anthropic
// models go through the official SDK; OpenAI models through the Responses API,
// as `annotate` does. Each question has a spending cap; an answer whose links
// do not resolve is sent back once to be fixed.
import Anthropic from '@anthropic-ai/sdk';
import { findKey } from '../setup/settings.js';
import { openAiKey } from '../ai/openai.js';
import { costOf as openAiCost } from '../ai/pricing.js';
import { LINK_GUIDE, parseLink } from './links.js';
import { latestAnswer, type AskEvent, type ChatModelInfo, type ExplanationDetail, type SubjectKind } from './model.js';
import { chatQuestion } from './prompts.js';
import { resolveLink } from './resolve.js';
import type { ExplanationService } from './service.js';
import { runTool, type ToolSpec } from './tools.js';

interface ChatModel { id: string; label: string; provider: 'anthropic' | 'openai'; note?: string; fallback?: boolean; effort: 'low' | 'medium' | 'high' }
/** Models the chat offers, best first; the first one with a key is the default. */
export const CHAT_MODELS: ChatModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', fallback: true, effort: 'medium' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', fallback: true, effort: 'medium', note: 'faster, cheaper' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', effort: 'medium', note: 'fastest, cheapest' },
  { id: process.env.CODILUCE_AI_HIGH_MODEL ?? 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', effort: 'medium' },
  { id: process.env.CODILUCE_AI_LOW_MODEL ?? 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', effort: 'low', note: 'cheapest' },
];
/** Anthropic prices, US dollars per million tokens (cache writes at 1.25× input). */
const ANTHROPIC_PRICES: Record<string, { input: number; cacheRead: number; output: number }> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, output: 0.5 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, output: 25 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, output: 10 },
  'claude-opus-4-8': { input: 5, cacheRead: 0.5, output: 25 },
};
/** Default spending cap per question, in US dollars (CODILUCE_CHAT_MAX_COST overrides it). */
export const CHAT_MAX_COST = 0.5;
const MAX_ROUNDS = 14;
const MAX_TOKENS = 16000;

export const CHAT_INSTRUCTIONS = `You explain a software repository to an engineer, inside Codiluce: a map of their code. Your tools read Codiluce's index of this repository (an evidenced graph of files, symbols, routes and endpoints, tables, the calls and HTTP requests between them across frontend and backend, every flow by entry point, the blast radius of a change, the Git history) and its source.

How to work:
- Look before you answer. Use the tools to find and read the code you talk about; prefer what the index proves (entity, flow, relations, impact) to guesses from names, and read source for the details that matter.
- Keep it proportionate: a handful of well-chosen calls, not every file.
- Say what the index shows as fact. Say when you infer, and when the index cannot see something (unresolved calls, dynamic dispatch, configuration).

How to answer:
- Markdown. Start with a level-2 heading that names the answer in a few words, then the answer in two or three sentences, then the details in short sections or numbered steps.
- Be concrete: name the files, functions, endpoints and tables involved. Keep it as short as the question allows.
- Answer in the language the question is written in.

${LINK_GUIDE}`;

export interface AskInput {
  question: string;
  /** Continue this explanation (a follow-up). */
  explanationId?: string;
  /** Rewrite this explanation because its code changed. */
  refresh?: boolean;
  model?: string;
  /** Links the user attached (files, folders, flows, commits). */
  context?: string[];
}
export interface ChatOptions {
  service: ExplanationService;
  /** The read-only tools (the chat saves its answer itself). */
  tools: ToolSpec[];
  /** Files that may hold the keys, first match wins after the environment (src/setup/settings.ts `keyFiles`). */
  keyFiles: string[];
  maxCost?: number;
  /** Tests: providers that do not reach the network. */
  providers?: Partial<Record<'anthropic' | 'openai', ChatProvider>>;
}
/** One model conversation with tools, until it answers in text. */
export interface ChatProvider {
  run(request: ProviderRequest): Promise<ProviderResult>;
}
export interface ProviderRequest {
  model: ChatModel; instructions: string; question: string; tools: ToolSpec[];
  /** Spent so far on this question, and the cap. */
  budget: { spent: () => number; add: (cost: number) => void; max: number };
  emit: (event: AskEvent) => void; signal: AbortSignal;
  /** Called with the final text: undefined accepts it, a message asks for another try (once). */
  review: (text: string) => Promise<string | undefined>;
}
export interface ProviderResult { text: string; model: string }

export class ChatService {
  private readonly maxCost: number;
  constructor(private readonly options: ChatOptions) {
    const fromEnv = Number(process.env.CODILUCE_CHAT_MAX_COST);
    this.maxCost = options.maxCost ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : CHAT_MAX_COST);
  }
  get cap(): number { return this.maxCost; }
  /** Models with whether a key is set for them (read again on each call, so a key added to .env works without a restart). */
  models(): ChatModelInfo[] {
    const keys = { anthropic: !!this.options.providers?.anthropic || !!anthropicKey(this.options.keyFiles), openai: !!this.options.providers?.openai || !!openAiKey(this.options.keyFiles) };
    const preferred = CHAT_MODELS.find(model => keys[model.provider])?.id;
    return CHAT_MODELS.map(model => ({ id: model.id, label: model.label, provider: model.provider, available: keys[model.provider], ...(model.id === preferred ? { default: true } : {}), ...(model.note ? { note: model.note } : {}) }));
  }
  keyFiles(): string[] { return this.options.keyFiles; }

  async ask(input: AskInput, emit: (event: AskEvent) => void, signal: AbortSignal): Promise<ExplanationDetail> {
    const service = this.options.service;
    if (service.readOnly) throw new Error('Explanations are read-only on this server (serve --read-only)');
    const question = input.question.trim();
    if (!question && !input.refresh) throw new Error('Ask a question');
    if (question.length > 20_000) throw new Error('The question is too long');
    const available = this.models().filter(model => model.available);
    const chosen = CHAT_MODELS.find(model => model.id === (input.model ?? available.find(item => item.default)?.id));
    if (!chosen) throw new Error(available.length ? `Unknown model ${input.model}` : `No API key: run codiluce setup, or add ANTHROPIC_API_KEY or OPENAI_API_KEY to ${this.keyFiles()[0]}`);
    if (!available.some(model => model.id === chosen.id)) throw new Error(`No ${chosen.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is set (run codiluce setup, or add it to ${this.keyFiles()[0]})`);
    const existing = input.explanationId ? await service.detail(input.explanationId) : undefined;
    if (input.explanationId && !existing) throw new Error(`No explanation ${input.explanationId}`);
    if (input.refresh && !existing) throw new Error('Refresh needs an explanation');

    const prompt = await this.prompt(input, question, existing);
    let spent = 0;
    const budget = { spent: () => spent, add: (cost: number) => { spent += cost; }, max: this.maxCost };
    emit({ type: 'start', id: existing?.id ?? '', model: chosen.id });
    let retried = false;
    const review = async (text: string) => {
      if (retried) return undefined;
      const missing = (await service.check(text)).filter(link => link.status === 'missing');
      if (!missing.length) return undefined;
      retried = true;
      emit({ type: 'retry', reason: `${missing.length} link${missing.length === 1 ? '' : 's'} did not resolve; asking the model to fix ${missing.length === 1 ? 'it' : 'them'}` });
      return `These links in your answer do not name anything indexed:\n${missing.map(link => `- ${link.href}: ${link.reason ?? 'not found'}`).join('\n')}\nFind the right paths with the tools (search) and write the whole answer again with correct links.`;
    };
    const provider = this.options.providers?.[chosen.provider] ?? (chosen.provider === 'anthropic' ? new AnthropicChat(anthropicKey(this.options.keyFiles)!) : new OpenAiChat(openAiKey(this.options.keyFiles)!));
    const result = await provider.run({ model: chosen, instructions: CHAT_INSTRUCTIONS, question: prompt.text, tools: this.options.tools, budget, emit, signal, review });
    if (!result.text.trim()) throw new Error('The model gave no answer');
    return service.publish({
      ...(existing ? { id: existing.id } : {}), markdown: result.text,
      question: input.refresh ? existing?.turns.find(turn => turn.role === 'question')?.text : question, mode: input.refresh ? 'replace' : 'append',
      ...(existing ? {} : { subject: prompt.subject }), source: 'chat', model: result.model, cost: spent, allowUnresolved: true,
    });
  }

  /** The user message: earlier turns (follow-ups), what changed (refresh), the attached code, then the question. */
  private async prompt(input: AskInput, question: string, existing: ExplanationDetail | undefined): Promise<{ text: string; subject: { kind: SubjectKind; ref?: string } }> {
    const environment = await this.options.service.environment();
    const parts: string[] = [];
    if (existing && !input.refresh) {
      parts.push('Earlier in this conversation:', ...existing.turns.map(turn => `${turn.role === 'question' ? 'Question' : 'Your answer'}:\n${turn.text}`), '---');
    }
    if (existing && input.refresh) {
      const answer = latestAnswer(existing);
      const changed = existing.links.filter(link => link.status === 'changed').map(link => `- ${link.href} (changed)`);
      const missing = existing.links.filter(link => link.status === 'missing').map(link => `- ${link.href} (no longer exists)`);
      parts.push(`This explanation was written at commit ${existing.commit?.slice(0, 10) ?? 'unknown'}; the index is now at ${environment.context.commitSha?.slice(0, 10) ?? 'the working tree'}.`,
        existing.turns.find(turn => turn.role === 'question') ? `It answered: ${existing.turns.find(turn => turn.role === 'question')!.text}` : '',
        `The explanation:\n${answer?.text ?? ''}`, changed.length || missing.length ? `Code it links that changed since:\n${[...changed, ...missing].join('\n')}` : 'None of the code it links changed; check whether it is still right.',
        '---', question || chatQuestion({ kind: 'refresh' }));
      return { text: parts.filter(Boolean).join('\n\n'), subject: existing.subject };
    }
    const attached: string[] = [];
    let subject: { kind: SubjectKind; ref?: string } = { kind: 'question' };
    const context = [...new Set(input.context ?? [])].slice(0, 20);
    for (const href of context) {
      const parsed = parseLink(href);
      if (!parsed || parsed.kind === 'external') continue;
      const link = resolveLink(parsed, environment);
      attached.push(`- ${href}: ${link.status === 'missing' ? `not found (${link.reason ?? ''})` : `${link.type ?? link.kind} ${link.label ?? link.path ?? link.name ?? ''}`.trim()}`);
      if (context.length === 1 && link.status !== 'missing') subject = { kind: parsed.kind === 'flow' ? 'flow' : parsed.kind === 'commit' ? 'commit' : parsed.kind === 'pr' ? 'pr' : 'entity', ref: parsed.kind === 'commit' || parsed.kind === 'pr' ? parsed.target : href };
    }
    if (attached.length) parts.push(`The user attached:\n${attached.join('\n')}`);
    if (/^explain this codebase/i.test(question) && !attached.length) subject = { kind: 'overview' };
    parts.push(question);
    return { text: parts.join('\n\n'), subject };
  }
}

/** The Anthropic key: the environment, else the first key file that sets it. */
export function anthropicKey(files: string[]): string | undefined { return findKey('ANTHROPIC_API_KEY', files)?.value; }
export function anthropicCost(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const price = ANTHROPIC_PRICES[model] ?? Object.entries(ANTHROPIC_PRICES).find(([name]) => model.startsWith(name))?.[1] ?? ANTHROPIC_PRICES['claude-opus-5-5']!;
  return (usage.input_tokens * price.input + (usage.cache_read_input_tokens ?? 0) * price.cacheRead + (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25 + usage.output_tokens * price.output) / 1e6;
}
function describeTool(name: string, input: unknown): string {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const main = value.link ?? value.flow ?? value.query ?? value.commit ?? value.kind ?? '';
  return `${name}${main ? ` ${String(main)}` : ''}`;
}
/** Close to the cap or the round limit: the next request answers without tools. */
function finishing(round: number, budget: ProviderRequest['budget']): boolean { return round >= MAX_ROUNDS - 1 || budget.spent() >= budget.max * 0.75; }
const FINISH = 'Answer now with what you found; do not call more tools.';

/** Claude through the official SDK: a streamed manual tool loop, so text arrives as it is written and the cap is checked each round. */
export class AnthropicChat implements ChatProvider {
  private readonly client: Anthropic;
  constructor(apiKey: string) { this.client = new Anthropic({ apiKey, maxRetries: 3 }); }
  async run(request: ProviderRequest): Promise<ProviderResult> {
    const { model, budget, emit, signal } = request;
    const tools: Anthropic.Beta.BetaTool[] = request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: request.question }];
    let served = model.id, jsonRetries = 0;
    for (let round = 0; ; round++) {
      if (budget.spent() >= budget.max) throw new Error(`Stopped at the cap of $${budget.max.toFixed(2)} per question (CODILUCE_CHAT_MAX_COST)`);
      const last = finishing(round, budget);
      const stream = this.client.beta.messages.stream({
        model: model.id, max_tokens: MAX_TOKENS, system: request.instructions, tools, messages,
        cache_control: { type: 'ephemeral' }, output_config: { effort: model.effort },
        ...(last ? { tool_choice: { type: 'none' } } : {}),
        // Refusals are retried server-side on the model Anthropic recommends for the category (not offered for Haiku).
        ...(model.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { signal });
      let text = '';
      stream.on('text', delta => { text += delta; emit({ type: 'text', delta }); });
      let message: Anthropic.Beta.BetaMessage;
      try { message = await stream.finalMessage(); jsonRetries = 0; }
      catch (error) {
        // A tool input that is not JSON (eager input streaming): ask again, twice at most; API errors are not retried here.
        if (error instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw error;
        continue;
      }
      served = message.model ?? served;
      budget.add(anthropicCost(served, message.usage));
      if (message.stop_reason === 'refusal') throw new Error(`The model declined to answer${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ''}`);
      const uses = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (message.stop_reason === 'max_tokens' && uses.length) throw new Error('The answer was cut off at the output limit');
      messages.push({ role: 'assistant', content: message.content });
      if (!uses.length) {
        const correction = await request.review(text);
        if (!correction) return { text, model: served };
        messages.push({ role: 'user', content: correction });
        continue;
      }
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const use of uses) {
        emit({ type: 'tool', name: use.name, detail: describeTool(use.name, use.input) });
        const { text: output, isError } = await runTool(request.tools, use.name, use.input);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: output.length > 60_000 ? `${output.slice(0, 60_000)}\n… (cut at 60 000 characters)` : output, ...(isError ? { is_error: true } : {}) });
      }
      if (finishing(round + 1, budget)) results.push({ type: 'text', text: FINISH });
      messages.push({ role: 'user', content: results });
    }
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
interface ResponseItem { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string; refusal?: string }[]; [key: string]: unknown }
/** OpenAI models through the Responses API with function tools (not streamed: the answer arrives whole). */
export class OpenAiChat implements ChatProvider {
  constructor(private readonly key: string, private readonly fetcher: Fetch = (input, init) => fetch(input, init), private readonly baseUrl = 'https://api.openai.com/v1') {}
  async run(request: ProviderRequest): Promise<ProviderResult> {
    const { model, budget, emit, signal } = request;
    const tools = request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
    const input: unknown[] = [{ role: 'user', content: request.question }];
    let served = model.id;
    for (let round = 0; ; round++) {
      if (budget.spent() >= budget.max) throw new Error(`Stopped at the cap of $${budget.max.toFixed(2)} per question (CODILUCE_CHAT_MAX_COST)`);
      const last = finishing(round, budget);
      const response = await this.fetcher(`${this.baseUrl}/responses`, {
        method: 'POST', signal, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.id, reasoning: { effort: model.effort }, instructions: request.instructions, input, tools, tool_choice: last ? 'none' : 'auto', max_output_tokens: MAX_TOKENS, store: false, include: ['reasoning.encrypted_content'] }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string }; model?: string; status?: string; output?: ResponseItem[]; usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } };
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${payload.error?.message ?? 'request failed'}`);
      served = payload.model ?? served;
      const usage = { input: payload.usage?.input_tokens ?? 0, cached: payload.usage?.input_tokens_details?.cached_tokens ?? 0, output: payload.usage?.output_tokens ?? 0, reasoning: payload.usage?.output_tokens_details?.reasoning_tokens ?? 0 };
      try { budget.add(openAiCost(served, usage)); } catch { budget.add(openAiCost(model.id, usage)); }
      const output = payload.output ?? [];
      const refusal = output.flatMap(item => item.content ?? []).find(part => part.type === 'refusal');
      if (refusal) throw new Error(`The model declined to answer: ${refusal.refusal ?? ''}`);
      input.push(...output);
      const calls = output.filter(item => item.type === 'function_call');
      if (!calls.length) {
        const text = output.flatMap(item => item.type === 'message' ? item.content ?? [] : []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
        if (payload.status && payload.status !== 'completed' && !text) throw new Error(`Incomplete answer (${payload.status})`);
        const correction = await request.review(text);
        if (!correction) { emit({ type: 'text', delta: text }); return { text, model: served }; }
        input.push({ role: 'user', content: correction });
        continue;
      }
      for (const call of calls) {
        let args: unknown;
        try { args = JSON.parse(call.arguments ?? '{}'); } catch { args = undefined; }
        emit({ type: 'tool', name: call.name ?? '', detail: describeTool(call.name ?? '', args) });
        const { text, isError } = args === undefined ? { text: 'The arguments are not valid JSON', isError: true } : await runTool(request.tools, call.name ?? '', args);
        input.push({ type: 'function_call_output', call_id: call.call_id, output: isError ? `Error: ${text}` : text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (cut)` : text });
      }
      if (finishing(round + 1, budget)) input.push({ role: 'user', content: FINISH });
    }
  }
}
