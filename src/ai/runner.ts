// Running annotation tasks: estimate first, then describe what is new.
//
// The estimate builds every request a run would send (items already described
// with the same input and prompt are skipped) and prices it: input tokens from
// the request text, output tokens from what each task returns per item plus
// the model's reasoning. A pilot (one real request of each small task) can
// replace the guesses by measured tokens per item; its answers are kept.
// A run never starts when the estimate exceeds the budget, and stops sending
// requests once its spend reaches the budget.
import { randomUUID } from 'node:crypto';
import type { StructuredModel, Usage } from './openai.js';
import { addUsage, costOf, MODELS, NO_USAGE } from './pricing.js';
import { steScore } from './ste.js';
import type { AnnotationStore } from './store.js';
import { TASKS, TASK_ORDER, type AnnotationInput, type TaskItem, type TaskName, type TaskRequest } from './tasks.js';

/** Characters per input token for these requests (English prose, paths and code), measured on gpt-6 tokenizers. */
const CHARS_PER_TOKEN = 3.4;
/** Reasoning tokens per request, before a pilot measures them. */
const REASONING_GUESS: Record<'low' | 'high', number> = { low: 150, high: 12_000 };
export interface TaskEstimate { task: TaskName; model: string; items: number; pending: number; requests: number; input: number; output: number; cost: number; measured: boolean }
export interface Estimate { tasks: TaskEstimate[]; total: number }
export interface Measured { outputPerItem: number; reasoningPerRequest: number; inputPerChar: number }
export type RunEvent =
  | { type: 'collect'; task: TaskName; items: number; pending: number }
  | { type: 'request'; task: TaskName; done: number; total: number; usage: Usage; cost: number; spent: number }
  | { type: 'error'; task: TaskName; message: string }
  | { type: 'stopped'; reason: string };
export interface RunResult { id: string; usage: Usage; cost: number; requests: number; stored: Record<string, number>; ste: Record<string, number>; failed: number; stopped?: string }

function batches(items: TaskItem[], size: number): TaskItem[][] {
  if (!size) return items.length ? [items] : [];
  const result: TaskItem[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
function requestChars(request: TaskRequest): number { return request.instructions.length + request.input.length + JSON.stringify(request.schema).length; }

/** Items of a task that still need describing (all of them with `force`). */
const collected = new WeakMap<AnnotationInput['entities'], Map<TaskName, TaskItem[]>>();
/** Tasks whose requests do not read other answers: collected once per loaded index. */
const INDEPENDENT = new Set<TaskName>(['files', 'flows', 'commits']);
export async function pendingItems(task: TaskName, input: AnnotationInput, annotations: AnnotationStore, force: boolean): Promise<{ items: TaskItem[]; pending: TaskItem[] }> {
  const spec = TASKS[task];
  let cache = collected.get(input.entities);
  if (!cache) { cache = new Map(); collected.set(input.entities, cache); }
  const reusable = INDEPENDENT.has(task) && !input.placeholder;
  const items = reusable && cache.has(task) ? cache.get(task)! : await spec.collect(input);
  if (reusable) cache.set(task, items);
  return { items, pending: force ? items : items.filter(item => !annotations.fresh(spec.kind, item.target, item.contentKey, spec.promptVersion)) };
}

export async function estimate(input: AnnotationInput, tasks: TaskName[], options: { force?: boolean; measured?: Partial<Record<TaskName, Measured>> } = {}): Promise<Estimate> {
  const result: TaskEstimate[] = [];
  for (const task of TASK_ORDER.filter(name => tasks.includes(name))) {
    const spec = TASKS[task];
    // Tasks that read earlier answers are estimated with stand-ins of typical length.
    const placeholder = ['folders', 'domains', 'overview', 'chapters'].includes(task);
    const { items, pending } = await pendingItems(task, { ...input, placeholder }, input.annotations, !!options.force || placeholder);
    const requests = batches(pending, spec.batch).map(group => spec.request(group, input));
    const measured = options.measured?.[task];
    const use = MODELS[spec.tier];
    const inputTokens = Math.round(requests.reduce((sum, request) => sum + requestChars(request) * (measured?.inputPerChar ?? 1 / CHARS_PER_TOKEN), 0));
    const outputTokens = Math.round(pending.length * (measured?.outputPerItem ?? spec.outputPerItem) + requests.length * (measured?.reasoningPerRequest ?? REASONING_GUESS[spec.tier]));
    const cost = costOf(use.model, { input: inputTokens, cached: 0, output: outputTokens, reasoning: 0 });
    result.push({ task, model: use.model, items: items.length, pending: placeholder && !options.force ? items.length : pending.length, requests: requests.length, input: inputTokens, output: outputTokens, cost, measured: !!measured });
  }
  return { tasks: result, total: result.reduce((sum, item) => sum + item.cost, 0) };
}

/** Send one request of each small task and measure tokens per item; the answers are stored like any other. */
export async function pilot(input: AnnotationInput, model: StructuredModel, tasks: TaskName[], options: { force?: boolean } = {}): Promise<{ measured: Partial<Record<TaskName, Measured>>; usage: Usage; cost: number }> {
  const measured: Partial<Record<TaskName, Measured>> = {};
  let usage = NO_USAGE, cost = 0;
  for (const task of tasks.filter(name => TASKS[name].tier === 'low' && !['folders'].includes(name))) {
    const spec = TASKS[task];
    const { pending } = await pendingItems(task, input, input.annotations, !!options.force);
    const group = batches(pending, spec.batch)[0];
    if (!group) continue;
    const request = spec.request(group, input);
    const answer = await model.structured(requestFor(spec.tier, request));
    usage = addUsage(usage, answer.usage);
    cost += costOf(answer.model, answer.usage);
    store(input.annotations, task, group, spec.parse(answer.value, group), answer.model);
    measured[task] = { outputPerItem: (answer.usage.output - answer.usage.reasoning) / group.length, reasoningPerRequest: answer.usage.reasoning, inputPerChar: answer.usage.input / requestChars(request) };
  }
  return { measured, usage, cost };
}
function requestFor(tier: 'low' | 'high', request: TaskRequest) {
  return { use: MODELS[tier], instructions: request.instructions, input: request.input, schemaName: request.schemaName, schema: request.schema, maxOutputTokens: request.maxOutputTokens };
}
function store(annotations: AnnotationStore, task: TaskName, items: TaskItem[], parsed: ReturnType<(typeof TASKS)[TaskName]['parse']>, model: string): { stored: number; ste: number[] } {
  const spec = TASKS[task];
  const byTarget = new Map(items.map(item => [item.target, item]));
  const scores: number[] = [];
  const rows = parsed.filter(entry => byTarget.has(entry.target)).map(entry => {
    const texts = entry.prose.filter(text => text.trim());
    const ste = texts.length ? texts.reduce((sum, text) => sum + steScore(text).score, 0) / texts.length : undefined;
    if (ste !== undefined) scores.push(ste);
    return { kind: spec.kind, target: entry.target, contentKey: byTarget.get(entry.target)!.contentKey, promptVersion: spec.promptVersion, model, value: entry.value, ...(ste !== undefined ? { ste } : {}) };
  });
  annotations.put(rows);
  return { stored: rows.length, ste: scores };
}

/** Describe every pending item of the tasks, in order, within the budget. */
export async function runTasks(input: AnnotationInput, model: StructuredModel, tasks: TaskName[], options: { budget: number; concurrency?: number; force?: boolean; estimate?: number; onEvent?: (event: RunEvent) => void }): Promise<RunResult> {
  const id = randomUUID(), startedAt = new Date().toISOString();
  let usage = NO_USAGE, cost = 0, requests = 0, failed = 0, stopped: string | undefined;
  const stored: Record<string, number> = {}, scores: Record<string, number[]> = {};
  const save = (status: string) => input.annotations.saveRun({ id, startedAt, ...(status !== 'running' ? { finishedAt: new Date().toISOString() } : {}), tasks, requests, usage, cost, ...(options.estimate !== undefined ? { estimate: options.estimate } : {}), status });
  save('running');
  for (const task of TASK_ORDER.filter(name => tasks.includes(name))) {
    if (stopped) break;
    const spec = TASKS[task];
    const { items, pending } = await pendingItems(task, input, input.annotations, !!options.force);
    options.onEvent?.({ type: 'collect', task, items: items.length, pending: pending.length });
    const groups = batches(pending, spec.batch);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < groups.length && !stopped) {
        const group = groups[next++]!;
        if (cost >= options.budget) { stopped = `the spend reached the budget of $${options.budget.toFixed(2)}`; options.onEvent?.({ type: 'stopped', reason: stopped }); return; }
        try {
          const answer = await model.structured(requestFor(spec.tier, spec.request(group, input)));
          usage = addUsage(usage, answer.usage); const spent = costOf(answer.model, answer.usage); cost += spent; requests++;
          const result = store(input.annotations, task, group, spec.parse(answer.value, group), answer.model);
          stored[task] = (stored[task] ?? 0) + result.stored; (scores[task] ??= []).push(...result.ste);
          options.onEvent?.({ type: 'request', task, done: ++done, total: groups.length, usage: answer.usage, cost: spent, spent: cost });
        } catch (error) {
          failed++; requests++;
          const partial = (error as { usage?: Usage }).usage;
          if (partial) { usage = addUsage(usage, partial); cost += costOf(MODELS[spec.tier].model, partial); }
          options.onEvent?.({ type: 'error', task, message: error instanceof Error ? error.message : String(error) });
        }
        save('running');
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 6, groups.length)) }, worker));
  }
  save(stopped ? 'stopped' : failed ? 'finished with errors' : 'finished');
  const ste = Object.fromEntries(Object.entries(scores).map(([task, list]) => [task, list.length ? list.reduce((sum, score) => sum + score, 0) / list.length : 1]));
  return { id, usage, cost, requests, stored, ste, failed, ...(stopped ? { stopped } : {}) };
}
