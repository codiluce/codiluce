// The OpenAI Responses API for annotations: one request returns one JSON value
// validated by the provider against a strict JSON Schema. Usage (input,
// cached input, output and the reasoning inside it) comes back with every
// result, so runs can be priced exactly. Rate limits and server errors are
// retried with backoff; an incomplete answer (token limit) is an error.
import { existsSync } from 'node:fs';
import path from 'node:path';

export type Effort = 'low' | 'medium' | 'high';
export interface ModelUse { model: string; effort: Effort }
export interface Usage { input: number; cached: number; output: number; reasoning: number }
export interface StructuredRequest {
  use: ModelUse; instructions: string; input: string;
  schemaName: string; schema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface StructuredResult<T> { value: T; usage: Usage; model: string; ms: number }
/** What the annotation tasks need from a model provider (tests use a fake). */
export interface StructuredModel { structured<T>(request: StructuredRequest, signal?: AbortSignal): Promise<StructuredResult<T>> }
export class ModelError extends Error { constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); } }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const RETRIES = 5;

export class OpenAiResponses implements StructuredModel {
  constructor(private readonly key: string, private readonly fetcher: Fetch = (input, init) => fetch(input, init), private readonly baseUrl = 'https://api.openai.com/v1') {}
  async structured<T>(request: StructuredRequest, signal?: AbortSignal): Promise<StructuredResult<T>> {
    const body = JSON.stringify({
      model: request.use.model, reasoning: { effort: request.use.effort },
      instructions: request.instructions, input: request.input,
      text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } },
      max_output_tokens: request.maxOutputTokens, store: false,
    });
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let response: Response;
      try { response = await this.fetcher(`${this.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body, signal }); }
      catch (error) {
        if (signal?.aborted || attempt >= RETRIES) throw new ModelError(`Network error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
        await wait(backoff(attempt)); continue;
      }
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string }; status?: string; incomplete_details?: { reason?: string }; output_text?: string; output?: { content?: { type: string; text?: string; refusal?: string }[] }[]; usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } }; model?: string };
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < RETRIES) { await wait(Number(response.headers.get('retry-after')) * 1000 || backoff(attempt)); continue; }
        throw new ModelError(`${response.status}: ${payload.error?.message ?? 'request failed'}`, response.status, retryable);
      }
      const usage: Usage = { input: payload.usage?.input_tokens ?? 0, cached: payload.usage?.input_tokens_details?.cached_tokens ?? 0, output: payload.usage?.output_tokens ?? 0, reasoning: payload.usage?.output_tokens_details?.reasoning_tokens ?? 0 };
      const parts = (payload.output ?? []).flatMap(item => item.content ?? []);
      const refusal = parts.find(part => part.type === 'refusal');
      if (refusal) throw Object.assign(new ModelError(`The model declined: ${refusal.refusal ?? ''}`), { usage });
      if (payload.status && payload.status !== 'completed') throw Object.assign(new ModelError(`Incomplete answer (${payload.incomplete_details?.reason ?? payload.status})`), { usage });
      const text = payload.output_text ?? parts.find(part => part.type === 'output_text')?.text;
      if (!text) throw Object.assign(new ModelError('Empty answer'), { usage });
      let value: T;
      try { value = JSON.parse(text) as T; } catch { throw Object.assign(new ModelError('The answer is not valid JSON'), { usage }); }
      return { value, usage, model: payload.model ?? request.use.model, ms: Date.now() - started };
    }
  }
}
function backoff(attempt: number): number { return Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5); }
function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** The OpenAI key: the environment, else a `.env` file of the tool workspace or the state directory. */
export function openAiKey(directories: string[]): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const directory of directories) {
    const file = path.join(directory, '.env');
    if (!existsSync(file)) continue;
    try { process.loadEnvFile(file); } catch { continue; }
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  }
  return undefined;
}
