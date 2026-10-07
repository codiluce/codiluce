// `codiluce annotate`: describe the indexed code with language models.
// Always estimates the cost first (optionally measured by a pilot request per
// task); never starts when the estimate exceeds --max-cost.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { GraphStore } from '../storage/sqlite.js';
import { ProjectionService } from '../projection/service.js';
import { HistoryAccess, HistoryService } from '../history/service.js';
import { OpenAiResponses, openAiKey } from './openai.js';
import { estimate, pilot, runTasks, type Estimate } from './runner.js';
import { ANNOTATIONS_DATABASE, AnnotationStore } from './store.js';
import { loadAnnotationInput, TASK_ORDER, type TaskName } from './tasks.js';
import { STE_TARGET } from './ste.js';

const execute = promisify(execFile);
export interface AnnotateOptions {
  root: string; stateDirectory: string;
  /** Where to look for a `.env` holding OPENAI_API_KEY (the tool workspace; never the target repository). */
  keyDirectories: string[];
  tasks?: string; estimateOnly: boolean; pilot: boolean; maxCost: number; concurrency: number; force: boolean;
}
export async function annotateCommand(options: AnnotateOptions): Promise<number> {
  const tasks = (options.tasks ? options.tasks.split(',').map(item => item.trim()).filter(Boolean) : TASK_ORDER) as TaskName[];
  for (const task of tasks) if (!TASK_ORDER.includes(task)) throw new Error(`Unknown task ${task}; tasks are ${TASK_ORDER.join(', ')}`);
  if (!Number.isFinite(options.maxCost) || options.maxCost <= 0) throw new Error('--max-cost must be a positive number of US dollars');
  const store = new GraphStore(path.join(options.stateDirectory, 'codiluce.db'), true);
  const access = new HistoryAccess(options.stateDirectory);
  const annotations = new AnnotationStore(path.join(options.stateDirectory, ANNOTATIONS_DATABASE));
  try {
    const projection = new ProjectionService(store, { root: options.root, history: access.get });
    const historyService = new HistoryService({ root: options.root, stateDirectory: options.stateDirectory, store, history: access });
    const timeline = access.get() ? await historyService.timeline().catch(() => undefined) : undefined;
    const history = timeline?.available ? { entries: timeline.entries.filter(entry => entry.snapshot), message: async (sha: string) => { try { return (await execute('git', ['log', '-1', '--format=%B', sha], { cwd: options.root })).stdout; } catch { return undefined; } } } : undefined;
    if (!history && (tasks.includes('commits') || tasks.includes('chapters'))) console.error('No indexed history (run history index): commits and chapters are skipped.');
    console.error('Reading the index…');
    const input = await loadAnnotationInput(store, projection, annotations, options.root, history);
    let planned = await estimate(input, tasks, { force: options.force });
    printEstimate(planned, 'Estimate (before measuring)');
    const key = openAiKey(options.keyDirectories);
    if (options.pilot || !options.estimateOnly) {
      if (!key) { console.error('OPENAI_API_KEY is not set (environment, or a .env file in the tool workspace or the state directory).'); return 1; }
      if (planned.total > options.maxCost * 3) { console.error(`The estimate ($${planned.total.toFixed(2)}) is far above --max-cost ($${options.maxCost.toFixed(2)}): not measured, not run.`); return 3; }
      const model = new OpenAiResponses(key);
      console.error('Measuring with one request per small task (its answers are kept)…');
      const measured = await pilot(input, model, tasks, { force: options.force });
      console.error(`Pilot: $${measured.cost.toFixed(4)} (${measured.usage.input} input, ${measured.usage.output} output tokens of which ${measured.usage.reasoning} reasoning)`);
      planned = await estimate(input, tasks, { force: options.force, measured: measured.measured });
      printEstimate(planned, 'Estimate (measured)');
      if (options.estimateOnly) { console.log(JSON.stringify({ estimate: planned, pilot: { cost: measured.cost, usage: measured.usage } }, null, 2)); return 0; }
      if (planned.total > options.maxCost) { console.error(`The estimate ($${planned.total.toFixed(2)}) exceeds --max-cost ($${options.maxCost.toFixed(2)}): not run. Raise --max-cost to confirm, or choose fewer --tasks.`); console.log(JSON.stringify({ estimate: planned, run: false }, null, 2)); return 3; }
      const started = Date.now();
      const result = await runTasks(input, model, tasks, {
        budget: options.maxCost, concurrency: options.concurrency, force: options.force, estimate: planned.total,
        onEvent: event => {
          if (event.type === 'collect') console.error(`${event.task}: ${event.pending} of ${event.items} to describe`);
          else if (event.type === 'request' && (event.done === event.total || event.done % 10 === 0)) console.error(`  ${event.task} ${event.done}/${event.total} · spent $${event.spent.toFixed(3)}`);
          else if (event.type === 'error') console.error(`  ${event.task}: ${event.message}`);
          else if (event.type === 'stopped') console.error(`Stopped: ${event.reason}`);
        },
      });
      const ste = Object.entries(result.ste).map(([task, score]) => `${task} ${Math.round(score * 100)}%`).join(', ');
      console.error(`Done in ${Math.round((Date.now() - started) / 1000)} s: $${result.cost.toFixed(3)} for ${result.requests} requests (${result.failed} failed). ASD-STE100 score: ${ste || 'n/a'} (target ${STE_TARGET * 100}%).`);
      console.log(JSON.stringify({ estimate: planned.total, ...result }, null, 2));
      return result.failed ? 2 : 0;
    }
    console.log(JSON.stringify({ estimate: planned }, null, 2));
    return 0;
  } finally { annotations.close(); access.close(); store.close(); }
}
function printEstimate(estimate: Estimate, title: string): void {
  console.error(`${title}:`);
  for (const task of estimate.tasks) console.error(`  ${task.task.padEnd(9)} ${task.model.padEnd(12)} ${String(task.pending).padStart(5)}/${String(task.items).padEnd(5)} items ${String(task.requests).padStart(4)} requests ${String(task.input).padStart(9)} in ${String(task.output).padStart(8)} out  $${task.cost.toFixed(3)}${task.measured ? ' (measured)' : ''}`);
  console.error(`  total $${estimate.total.toFixed(3)}`);
}
