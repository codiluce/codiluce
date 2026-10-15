// Browser client for explanations: reading them, the explanations that link an
// entity, what connected agents are doing, and asking the chat (its answer streams in, one JSON event a line).
import type { AgentActivityList, AskEvent, ExplanationDetail, ExplanationList, ExplanationsSetup } from '@engine/explanations/model';
import type { EntityExplanations } from '@engine/explanations/service';
import { ApiError } from './api';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface AskRequest { question: string; explanationId?: string; refresh?: boolean; model?: string; context?: string[] }
export interface ExplanationsApi {
  list(signal?: AbortSignal): Promise<ExplanationList>;
  setup(signal?: AbortSignal): Promise<ExplanationsSetup>;
  detail(id: string, signal?: AbortSignal): Promise<ExplanationDetail>;
  forEntity(id: string, signal?: AbortSignal): Promise<EntityExplanations>;
  /** Agents connected over MCP, and what they are explaining right now. */
  activity(signal?: AbortSignal): Promise<AgentActivityList>;
  ask(request: AskRequest, onEvent: (event: AskEvent) => void, signal?: AbortSignal): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
}
const HEADERS = { 'X-Codiluce-Request': 'explain' };

export class HttpExplanationsApi implements ExplanationsApi {
  constructor(private readonly base = '', private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}
  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.base}${path}`, { signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new ApiError(response.status, body.error ?? `Request failed (${response.status})`);
    return body;
  }
  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.base}${path}`, { method, headers: { ...HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new ApiError(response.status, result.error ?? `Request failed (${response.status})`);
    return result;
  }
  list(signal?: AbortSignal) { return this.get<ExplanationList>('/api/explanations', signal); }
  setup(signal?: AbortSignal) { return this.get<ExplanationsSetup>('/api/explanations/setup', signal); }
  detail(id: string, signal?: AbortSignal) { return this.get<ExplanationDetail>(`/api/explanations/${encodeURIComponent(id)}`, signal); }
  forEntity(id: string, signal?: AbortSignal) { return this.get<EntityExplanations>(`/api/explanations/entity/${encodeURIComponent(id)}`, signal); }
  activity(signal?: AbortSignal) { return this.get<AgentActivityList>('/api/explanations/activity', signal); }
  async remove(id: string) { await this.send('DELETE', `/api/explanations/${encodeURIComponent(id)}`); }
  async rename(id: string, title: string) { await this.send('PATCH', `/api/explanations/${encodeURIComponent(id)}`, { title }); }
  async ask(request: AskRequest, onEvent: (event: AskEvent) => void, signal?: AbortSignal): Promise<void> {
    const response = await this.fetcher(`${this.base}/api/explanations/ask`, { method: 'POST', signal, headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(response.status, body.error ?? `Request failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) { try { onEvent(JSON.parse(line) as AskEvent); } catch { /* a partial line */ } }
      }
      if (done) break;
    }
    if (buffer.trim()) { try { onEvent(JSON.parse(buffer) as AskEvent); } catch { /* ignore */ } }
  }
}
