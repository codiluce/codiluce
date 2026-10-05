// Models used for annotations, and their prices (US dollars per million
// tokens, OpenAI standard tier, as published in October 2026). Reasoning
// tokens are billed as output. `high`: synthesis over the whole repository
// (domains, the overview, history chapters); `low`: many small descriptions
// (files, folders, flows, commits).
import type { ModelUse, Usage } from './openai.js';

export const MODELS: Record<'high' | 'low', ModelUse> = {
  high: { model: process.env.ARCHIPELAGO_AI_HIGH_MODEL ?? 'gpt-6.1-sol', effort: 'high' },
  low: { model: process.env.ARCHIPELAGO_AI_LOW_MODEL ?? 'gpt-6-luna', effort: 'low' },
};
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6.1-sol': { input: 2.0, cached: 0.1, output: 10.0 },
  'gpt-6-sol': { input: 2.0, cached: 0.2, output: 10.0 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
};
/** Dated model IDs (`gpt-6-luna-2026-…`) are priced as their family. */
export function priceOf(model: string): { input: number; cached: number; output: number } {
  const known = PRICES[model] ?? Object.entries(PRICES).sort((a, b) => b[0].length - a[0].length).find(([name]) => model.startsWith(name))?.[1];
  if (!known) throw new Error(`No price is known for model ${model}; add it to src/ai/pricing.ts`);
  return known;
}
export function costOf(model: string, usage: Usage): number {
  const price = priceOf(model);
  return ((usage.input - usage.cached) * price.input + usage.cached * price.cached + usage.output * price.output) / 1e6;
}
export function addUsage(a: Usage, b: Usage): Usage { return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning }; }
export const NO_USAGE: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
