// Work `start` runs after the map is open: indexing history to the chosen
// depth, then describing the code when the user agreed. Each runs as a child
// process of the same CLI (so the server stays responsive and Ctrl+C stops
// it), reporting progress on one terminal line.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { childExecArgv } from '../history/indexer.js';
import type { HistoryDepth } from './settings.js';
import { elapsed, type Writer } from './terminal.js';

export interface HistoryEvent { type: string; done?: number; total?: number; pending?: number; targets?: number; jobs?: number; error?: string; message?: string; indexed?: number; failed?: number; skipped?: number }
/** How to run this CLI again: Node, its flags (the TypeScript loader in a checkout) and the entry script. */
export function cliEntry(): string[] { return [...childExecArgv(), process.argv[1]!]; }
export function historyArgs(depth: HistoryDepth): string[] {
  if (depth === 'all') return [];
  if (typeof depth === 'number') return ['--limit', String(depth)];
  return ['--since', depth];
}

export class BackgroundWork {
  private children = new Set<ChildProcess>();
  private stopped = false;
  constructor(private readonly options: { root: string; stateDirectory: string; entry?: string[]; line: StatusLine }) {}

  /** Index history to a depth; resolves with what was indexed. */
  history(depth: HistoryDepth): Promise<{ indexed: number; failed: number; skipped: number } | undefined> {
    const { line } = this.options;
    return new Promise(resolve => {
      const started = Date.now();
      let total = 0, done = 0, failed = 0, targets = 0;
      let outcome: { indexed: number; failed: number; skipped: number } | undefined;
      const child = this.spawn(['history', 'index', '--repo', this.options.root, '--state-dir', this.options.stateDirectory, ...historyArgs(depth), '--json-progress'], 'history.log');
      if (!child) { resolve(undefined); return; }
      line.set('History', 'planning…');
      createInterface({ input: child.stdout! }).on('line', text => {
        let event: HistoryEvent;
        try { event = JSON.parse(text) as HistoryEvent; } catch { return; }
        if (event.type === 'plan') { total = event.pending ?? 0; targets = event.targets ?? 0; line.set('History', total ? `0/${total} commits` : 'up to date'); }
        else if (event.type === 'indexed' || event.type === 'failed') {
          done = event.done ?? done + 1; if (event.type === 'failed') failed++;
          const left = done ? ((Date.now() - started) / done) * (total - done) : 0;
          line.set('History', `${done}/${total} commits${failed ? `, ${failed} failed` : ''}${total > done && done >= 2 ? ` · ${elapsed(left) || 'a few seconds'} left` : ''}`);
        } else if (event.type === 'result') outcome = { indexed: event.indexed ?? done - failed, failed: event.failed ?? failed, skipped: event.skipped ?? 0 };
      });
      child.once('close', code => {
        if (this.stopped) { resolve(undefined); return; }
        if (code === 0) line.finish('History', total ? `${total - failed} commit${total - failed === 1 ? '' : 's'} indexed in ${elapsed(Date.now() - started) || 'a moment'}${failed ? ` (${failed} failed; see .codiluce/history.log)` : ''}` : `up to date · ${targets} commit${targets === 1 ? '' : 's'} indexed`, 'ok');
        else line.finish('History', `indexing stopped (exit ${code}); see ${path.join(this.options.stateDirectory, 'history.log')}`, 'error');
        resolve(outcome ?? { indexed: total - failed, failed, skipped: 0 });
      });
    });
  }
  /** Describe the code (`annotate`) within a cost cap. */
  describe(maxCost: number, tasks: string[]): Promise<boolean> {
    const { line } = this.options;
    return new Promise(resolve => {
      const started = Date.now();
      const child = this.spawn(['annotate', '--repo', this.options.root, '--state-dir', this.options.stateDirectory, '--tasks', tasks.join(','), '--max-cost', maxCost.toFixed(2)], 'annotate.log');
      if (!child) { resolve(false); return; }
      line.set('Descriptions', 'measuring the cost…');
      let spent = '';
      createInterface({ input: child.stderr! }).on('line', text => {
        const progress = /^\s+(\w+) (\d+)\/(\d+) · spent \$([\d.]+)/.exec(text);
        if (progress) { spent = progress[4]!; line.set('Descriptions', `${progress[1]} ${progress[2]}/${progress[3]} · $${progress[4]} spent`); }
        else if (/^Describing|^Measuring/.test(text)) line.set('Descriptions', text.replace(/…$/, '…'));
      });
      child.once('close', code => {
        if (this.stopped) { resolve(false); return; }
        if (code === 0) line.finish('Descriptions', `written in ${elapsed(Date.now() - started) || 'a moment'}${spent ? ` for $${spent}` : ''}; reload the map to see them`, 'ok');
        else if (code === 3) line.finish('Descriptions', `not run: the measured cost is above $${maxCost.toFixed(2)}; run codiluce annotate to decide`, 'error');
        else line.finish('Descriptions', `stopped (exit ${code}); see ${path.join(this.options.stateDirectory, 'annotate.log')}`, 'error');
        resolve(code === 0);
      });
    });
  }
  stop(): void {
    this.stopped = true;
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGTERM');
    this.options.line.clear();
  }
  private spawn(args: string[], log: string): ChildProcess | undefined {
    if (this.stopped) return undefined;
    const [node, ...entry] = [process.execPath, ...(this.options.entry ?? cliEntry())];
    const file = createWriteStream(path.join(this.options.stateDirectory, log), { flags: 'w' });
    // The working directory of this process: a checkout's TypeScript loader resolves from there (the repository is passed by --repo).
    const child = spawn(node!, [...entry, ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    child.stderr!.pipe(file, { end: false });
    child.stdout!.on('data', () => undefined);
    child.once('close', () => { this.children.delete(child); file.end(); });
    this.children.add(child);
    return child;
  }
}

/**
 * The one line of background progress under the "map ready" box: redrawn in
 * place on a TTY ("◐ History 12/50 commits · 1m left"), printed as plain lines
 * otherwise (only when something finishes, to keep logs short).
 */
export class StatusLine {
  private current = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private shown = false;
  constructor(private readonly w: Writer) {}
  set(label: string, text: string): void {
    this.current.set(label, text);
    if (!this.w.terminal.output.isTTY) return;
    this.timer ??= setInterval(() => this.draw(), 150);
    this.draw();
  }
  finish(label: string, text: string, status: 'ok' | 'error'): void {
    this.current.delete(label);
    this.erase();
    const { c, s } = this.w;
    this.w.write(`${status === 'ok' ? c.green(s.ok) : c.red(s.no)}  ${c.bold(label)}  ${text}`);
    if (!this.current.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    else this.draw();
  }
  clear(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.erase(); this.current.clear(); }
  private erase(): void { if (this.shown && this.w.terminal.output.isTTY) this.w.terminal.output.write('\r\x1b[K'); this.shown = false; }
  private draw(): void {
    if (!this.current.size || !this.w.terminal.output.isTTY) return;
    const { c, s } = this.w;
    const parts = [...this.current].map(([label, text]) => `${c.bold(label)} ${c.muted(text)}`).join(c.dim('  ·  '));
    this.w.terminal.output.write(`\r\x1b[K${c.accent(s.spinner[this.frame++ % s.spinner.length]!)}  ${parts}`);
    this.shown = true;
  }
}
