// Checking an API key before it is saved: one request that lists models
// (free) tells a working key from a mistyped one. Offline, the key is saved
// unchecked and the setup says so.
import Anthropic from '@anthropic-ai/sdk';

export type Provider = 'anthropic' | 'openai';
export type KeyCheck = { status: 'valid' } | { status: 'invalid'; message: string } | { status: 'unchecked'; message: string };
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const PROVIDERS: Record<Provider, { name: string; variable: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'; prefix: RegExp; console: string; uses: string }> = {
  anthropic: { name: 'Anthropic', variable: 'ANTHROPIC_API_KEY', prefix: /^sk-ant-/, console: 'https://console.anthropic.com/settings/keys', uses: 'asking questions in the map (Claude)' },
  openai: { name: 'OpenAI', variable: 'OPENAI_API_KEY', prefix: /^sk-/, console: 'https://platform.openai.com/api-keys', uses: 'asking questions in the map, and describing the code' },
};
/** A quick look at the key's shape, before any request. */
export function keyShape(provider: Provider, key: string): string | undefined {
  if (/\s/.test(key)) return 'A key has no spaces';
  if (key.length < 20) return 'That is too short for an API key';
  if (provider === 'openai' && PROVIDERS.anthropic.prefix.test(key)) return 'This is an Anthropic key (sk-ant-…)';
  if (!PROVIDERS[provider].prefix.test(key)) return `${PROVIDERS[provider].name} keys start with ${provider === 'anthropic' ? 'sk-ant-' : 'sk-'}`;
  return undefined;
}
export async function checkKey(provider: Provider, key: string, options: { fetcher?: Fetch; timeoutMs?: number; baseUrl?: string } = {}): Promise<KeyCheck> {
  const timeoutMs = options.timeoutMs ?? 8000;
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: timeoutMs, ...(options.baseUrl ? { baseURL: options.baseUrl } : {}), ...(options.fetcher ? { fetch: options.fetcher as typeof fetch } : {}) });
      await client.models.list({ limit: 1 });
      return { status: 'valid' };
    }
    const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    const response = await fetcher(`${options.baseUrl ?? 'https://api.openai.com/v1'}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401 || response.status === 403) return { status: 'invalid', message: 'OpenAI refused this key' };
    if (!response.ok) return { status: 'unchecked', message: `OpenAI answered ${response.status}; saved without a check` };
    return { status: 'valid' };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return { status: 'invalid', message: 'Anthropic refused this key' };
    if (error instanceof Anthropic.APIError && typeof error.status === 'number') return { status: 'unchecked', message: `Anthropic answered ${error.status}; saved without a check` };
    return { status: 'unchecked', message: 'Could not reach the provider to check it; saved without a check' };
  }
}
