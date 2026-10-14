// A small terminal UI for the first-run setup: styled text, a spinner and the
// prompts the setup asks (one choice, several choices, yes or no, text and a
// hidden key). Each prompt redraws in place while it is answered, then leaves
// one line with the answer. No dependency: ANSI escapes and Node's keypress
// events. Prompts need a TTY; callers check `interactive` first.
import { emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

export interface Terminal {
  input: NodeJS.ReadableStream & Partial<Pick<ReadStream, 'isTTY' | 'setRawMode'>>;
  output: NodeJS.WritableStream & Partial<Pick<WriteStream, 'isTTY' | 'columns'>>;
  /** Questions can be asked (input and output are terminals, not CI, not --yes). */
  interactive: boolean;
  color: boolean;
  unicode: boolean;
}
export class CancelledError extends Error { constructor() { super('Setup cancelled'); this.name = 'CancelledError'; } }

export function createTerminal(options: { yes?: boolean; input?: Terminal['input']; output?: Terminal['output']; env?: NodeJS.ProcessEnv } = {}): Terminal {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const tty = !!input.isTTY && !!output.isTTY;
  const color = env.NO_COLOR ? false : env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : !!output.isTTY && env.TERM !== 'dumb';
  const unicode = process.platform !== 'win32' || !!env.WT_SESSION || !!env.TERM_PROGRAM || env.TERM === 'xterm-256color';
  return { input, output, interactive: tty && !options.yes && !env.CI, color, unicode };
}

// Style ------------------------------------------------------------------------------
/** Codiluce amber (the accent of the map and the site), and the quieter tones around it. */
export function palette(terminal: Pick<Terminal, 'color'>) {
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
  const wrap = (open: string, close = '\x1b[39m') => (text: string) => terminal.color ? `${open}${text}${close}` : text;
  return {
    accent: wrap(truecolor ? '\x1b[38;2;255;191;71m' : '\x1b[38;5;214m'),
    bold: wrap('\x1b[1m', '\x1b[22m'),
    dim: wrap('\x1b[2m', '\x1b[22m'),
    muted: wrap(truecolor ? '\x1b[38;2;147;163;200m' : '\x1b[38;5;103m'),
    green: wrap(truecolor ? '\x1b[38;2;74;222;128m' : '\x1b[32m'),
    red: wrap(truecolor ? '\x1b[38;2;248;113;113m' : '\x1b[31m'),
    link: wrap(truecolor ? '\x1b[38;2;147;197;253m' : '\x1b[36m'),
    inverse: wrap('\x1b[7m', '\x1b[27m'),
  };
}
export type Palette = ReturnType<typeof palette>;
export function symbols(terminal: Pick<Terminal, 'unicode'>) {
  return terminal.unicode
    ? { mark: '◐', active: '◆', done: '◇', error: '▲', rail: '│', start: '┌', end: '└', radioOn: '●', radioOff: '○', checkOn: '◼', checkOff: '◻', ok: '✓', no: '✗', bullet: '•', arrow: '›', spinner: ['◐', '◓', '◑', '◒'], box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } }
    : { mark: 'o', active: '*', done: 'o', error: '!', rail: '|', start: '+', end: '+', radioOn: '(*)', radioOff: '( )', checkOn: '[x]', checkOff: '[ ]', ok: '+', no: 'x', bullet: '-', arrow: '>', spinner: ['|', '/', '-', '\\'], box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' } };
}
/** Visible length (ANSI escapes do not count). */
export function visible(text: string): number { return [...text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length; }
/** Words wrapped to a width; existing line breaks are kept. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) { if (line) line += ' '; continue; }
      if (line && visible(line) + visible(word) > width) { lines.push(line.trimEnd()); line = ''; }
      line += word;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
export function width(terminal: Terminal): number { return Math.max(40, Math.min(100, (terminal.output.columns ?? 80) - 2)); }

/** Lines printed under the setup's rail. */
export class Writer {
  readonly c: Palette; readonly s: ReturnType<typeof symbols>;
  constructor(readonly terminal: Terminal) { this.c = palette(terminal); this.s = symbols(terminal); }
  write(text = ''): void { this.terminal.output.write(`${text}\n`); }
  /** A paragraph beside the rail, wrapped. */
  note(text: string, tone: (text: string) => string = this.c.muted): void {
    for (const line of wrapText(text, width(this.terminal) - 4)) this.write(`${this.c.dim(this.s.rail)}  ${tone(line)}`);
  }
  rail(): void { this.write(this.c.dim(this.s.rail)); }
  /** A titled box of labeled rows (the summary at the end); long values wrap under themselves. */
  box(title: string, rows: ([string, string] | string)[]): void {
    const { c, s } = this;
    const label = Math.max(0, ...rows.map(row => typeof row === 'string' ? 0 : visible(row[0])));
    const lines: string[] = [];
    const inner = Math.min(width(this.terminal) - 2, Math.max(visible(title) + 6, ...rows.map(row => (typeof row === 'string' ? visible(row) : label + 3 + visible(row[1])) + 2)));
    for (const row of rows) {
      if (typeof row === 'string') { lines.push(...wrapText(row, inner - 2)); continue; }
      wrapText(row[1], inner - 2 - label - 3).forEach((part, index) => lines.push(`${index ? ' '.repeat(label) : c.muted(row[0].padEnd(label))}   ${part}`));
    }
    this.write(`${c.dim(`${s.box.tl}${s.box.h} `)}${c.bold(title)} ${c.dim(`${s.box.h.repeat(Math.max(0, inner - visible(title) - 3))}${s.box.tr}`)}`);
    for (const line of lines) this.write(`${c.dim(s.box.v)} ${line}${' '.repeat(Math.max(0, inner - 1 - visible(line)))}${c.dim(s.box.v)}`);
    this.write(c.dim(`${s.box.bl}${s.box.h.repeat(inner)}${s.box.br}`));
  }
}

// Redrawing in place ---------------------------------------------------------------------
class Frame {
  private rows = 0;
  constructor(private readonly terminal: Terminal) {}
  draw(lines: string[]): void {
    const out = this.terminal.output;
    if (this.rows) out.write(`\x1b[${this.rows}F\x1b[J`); else out.write('\r\x1b[J');
    const columns = Math.max(20, this.terminal.output.columns ?? 80);
    out.write(`${lines.join('\n')}\n`);
    this.rows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(visible(line) / columns)), 0);
  }
}
type Key = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string };
/** Read keys until `handle` returns a value (or throws), restoring the terminal after. */
async function keys<T>(terminal: Terminal, handle: (text: string | undefined, key: Key) => T | undefined, render: () => void): Promise<T> {
  const input = terminal.input;
  emitKeypressEvents(input as NodeJS.ReadableStream);
  const raw = typeof input.setRawMode === 'function';
  if (raw) input.setRawMode!(true);
  terminal.output.write('\x1b[?25l');
  render();
  try {
    return await new Promise<T>((resolve, reject) => {
      const onKey = (text: string | undefined, key: Key = {}) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) { cleanup(); reject(new CancelledError()); return; }
        let result: T | undefined;
        try { result = handle(text, key); } catch (error) { cleanup(); reject(error); return; }
        if (result !== undefined) { cleanup(); resolve(result); } else render();
      };
      const cleanup = () => { input.off('keypress', onKey); };
      input.on('keypress', onKey);
      (input as NodeJS.ReadableStream).resume();
    });
  } finally {
    if (raw) input.setRawMode!(false);
    (input as NodeJS.ReadableStream).pause();
    terminal.output.write('\x1b[?25h');
  }
}

// Prompts ------------------------------------------------------------------------------------
export interface Choice<T> { value: T; label: string; hint?: string; disabled?: string }
/** Where hints start: two spaces after the longest label, so they read as a column. */
function labelColumn(choices: Choice<unknown>[]): number { return Math.max(...choices.map(choice => visible(choice.label))) + 3; }
/** The prompt's header: the active diamond, the question, and its explanation beside the rail. */
function header(w: Writer, message: string, detail: string | undefined, state: 'active' | 'done' | 'error'): string[] {
  const { c, s } = w;
  const symbol = state === 'done' ? c.green(s.done) : state === 'error' ? c.red(s.error) : c.accent(s.active);
  const lines = [`${symbol}  ${state === 'done' ? message : c.bold(message)}`];
  if (detail && state !== 'done') for (const line of wrapText(detail, width(w.terminal) - 4)) lines.push(`${c.accent(s.rail)}  ${c.muted(line)}`);
  return lines;
}
function answered(w: Writer, message: string, answer: string): string[] {
  return [`${w.c.green(w.s.done)}  ${message} ${w.c.dim(w.s.arrow)} ${w.c.accent(answer)}`, w.c.dim(w.s.rail)];
}

export async function select<T>(w: Writer, options: { message: string; detail?: string; choices: Choice<T>[]; initial?: T }): Promise<T> {
  const frame = new Frame(w.terminal);
  const { c, s } = w;
  const enabled = options.choices.map((choice, index) => choice.disabled ? -1 : index).filter(index => index >= 0);
  let cursor = Math.max(0, options.choices.findIndex(choice => choice.value === options.initial && !choice.disabled));
  if (options.choices[cursor]?.disabled) cursor = enabled[0] ?? 0;
  const move = (delta: number) => { const at = enabled.indexOf(cursor); cursor = enabled[(at + delta + enabled.length) % enabled.length] ?? cursor; };
  const column = labelColumn(options.choices);
  const render = () => frame.draw([
    ...header(w, options.message, options.detail, 'active'),
    ...options.choices.map((choice, index) => {
      const on = index === cursor;
      if (choice.disabled) return `${c.accent(s.rail)}  ${c.dim(`${s.radioOff} ${choice.label}`)} ${c.dim(`(${choice.disabled})`)}`;
      return `${c.accent(s.rail)}  ${on ? c.accent(s.radioOn) : c.dim(s.radioOff)} ${on ? c.bold(choice.label) : choice.label}${choice.hint ? `${' '.repeat(column - visible(choice.label))}${c.muted(choice.hint)}` : ''}`;
    }),
    `${c.accent(s.end)}  ${c.dim('↑↓ to choose · Enter to confirm')}`,
  ]);
  const value = await keys<T>(w.terminal, (_text, key) => {
    if (key.name === 'up' || key.name === 'k') move(-1);
    else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') move(1);
    else if (key.name === 'return' || key.name === 'enter') return options.choices[cursor]!.value;
    else if (/^[1-9]$/.test(key.sequence ?? '')) { const index = Number(key.sequence) - 1; if (enabled.includes(index)) cursor = index; }
    return undefined;
  }, render);
  frame.draw(answered(w, options.message, options.choices.find(choice => choice.value === value)!.label));
  return value;
}

export async function multiselect<T>(w: Writer, options: { message: string; detail?: string; choices: Choice<T>[]; initial?: T[]; none?: string }): Promise<T[]> {
  const frame = new Frame(w.terminal);
  const { c, s } = w;
  const chosen = new Set(options.initial ?? []);
  let cursor = Math.max(0, options.choices.findIndex(choice => !choice.disabled));
  const column = labelColumn(options.choices);
  const render = () => frame.draw([
    ...header(w, options.message, options.detail, 'active'),
    ...options.choices.map((choice, index) => {
      const on = index === cursor;
      if (choice.disabled) return `${c.accent(s.rail)}   ${c.dim(`${s.checkOff} ${choice.label}`)}${' '.repeat(column - visible(choice.label))}${c.dim(choice.disabled)}`;
      const box = chosen.has(choice.value) ? c.accent(s.checkOn) : c.dim(s.checkOff);
      return `${c.accent(s.rail)}  ${on ? c.accent(s.arrow) : ' '}${box} ${on ? c.bold(choice.label) : choice.label}${choice.hint ? `${' '.repeat(column - visible(choice.label))}${c.muted(choice.hint)}` : ''}`;
    }),
    `${c.accent(s.end)}  ${c.dim('↑↓ to move · Space to select · Enter to confirm')}`,
  ]);
  const value = await keys<T[]>(w.terminal, (_text, key) => {
    const step = (delta: number) => { for (let i = 1; i <= options.choices.length; i++) { const next = (cursor + delta * i + options.choices.length * i) % options.choices.length; if (!options.choices[next]!.disabled) { cursor = next; return; } } };
    if (key.name === 'up' || key.name === 'k') step(-1);
    else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') step(1);
    else if (key.name === 'space') { const item = options.choices[cursor]!.value; if (chosen.has(item)) chosen.delete(item); else chosen.add(item); }
    else if (key.name === 'a') { const all = options.choices.filter(choice => !choice.disabled).map(choice => choice.value); if (all.every(item => chosen.has(item))) chosen.clear(); else for (const item of all) chosen.add(item); }
    else if (key.name === 'return' || key.name === 'enter') return options.choices.filter(choice => chosen.has(choice.value)).map(choice => choice.value);
    return undefined;
  }, render);
  const labels = options.choices.filter(choice => value.includes(choice.value)).map(choice => choice.label);
  frame.draw(answered(w, options.message, labels.length ? labels.join(', ') : options.none ?? 'none'));
  return value;
}

export async function confirm(w: Writer, options: { message: string; detail?: string; initial?: boolean; yes?: string; no?: string }): Promise<boolean> {
  return select<boolean>(w, { message: options.message, detail: options.detail, initial: options.initial ?? true, choices: [{ value: true, label: options.yes ?? 'Yes' }, { value: false, label: options.no ?? 'No' }] });
}

/** A line of text; `secret` hides it as it is typed (API keys). Validation runs on Enter; its message stays until the text changes. */
export async function text(w: Writer, options: { message: string; detail?: string; placeholder?: string; secret?: boolean; initial?: string; validate?: (value: string) => string | undefined; allowEmpty?: boolean }): Promise<string> {
  const frame = new Frame(w.terminal);
  const { c, s } = w;
  let value = options.initial ?? '';
  let error: string | undefined;
  const shown = () => options.secret ? (w.terminal.unicode ? '•' : '*').repeat(Math.min(value.length, 48)) + (value.length > 48 ? c.dim(` (${value.length})`) : '') : value;
  const render = () => frame.draw([
    ...header(w, options.message, options.detail, error ? 'error' : 'active'),
    `${error ? c.red(s.rail) : c.accent(s.rail)}  ${value ? shown() : c.dim(options.placeholder ?? '')}${c.inverse(' ')}`,
    error ? `${c.red(s.end)}  ${c.red(error)}` : `${c.accent(s.end)}  ${c.dim(options.allowEmpty ? 'Enter to confirm · leave empty to skip' : 'Enter to confirm')}`,
  ]);
  const result = await keys<string>(w.terminal, (input, key) => {
    if (key.name === 'return' || key.name === 'enter') {
      const trimmed = value.trim();
      if (!trimmed && !options.allowEmpty) { error = 'A value is required'; return undefined; }
      const problem = trimmed ? options.validate?.(trimmed) : undefined;
      if (problem) { error = problem; return undefined; }
      return trimmed;
    }
    if (key.name === 'backspace') value = value.slice(0, -1);
    else if (key.ctrl && key.name === 'u') value = '';
    else if (key.name === 'escape' && options.allowEmpty) return '';
    else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) value += input;
    else if (input && input.length > 1 && !key.name) value += input.replace(/[\x00-\x1f\x7f]/g, '');
    error = undefined;
    return undefined;
  }, render);
  frame.draw(answered(w, options.message, result ? (options.secret ? `${result.slice(0, 7)}${'•'.repeat(6)}` : result) : 'skipped'));
  return result;
}

/** A spinner on one line (the eclipse turning), finished with a mark and a message. Without a TTY it prints the start and end lines. */
export function spinner(w: Writer) {
  const { c, s } = w;
  let timer: ReturnType<typeof setInterval> | undefined, frame = 0, message = '', started = 0;
  const tty = !!w.terminal.output.isTTY;
  const draw = () => w.terminal.output.write(`\r\x1b[K${c.accent(s.spinner[frame++ % s.spinner.length]!)}  ${message}${c.dim(` ${elapsed(Date.now() - started)}`)}`);
  return {
    start(text: string) { message = text; started = Date.now(); if (tty) { w.terminal.output.write('\x1b[?25l'); draw(); timer = setInterval(draw, 120); } else w.write(`${s.bullet} ${text}`); },
    update(text: string) { message = text; if (!tty) return; draw(); },
    stop(text: string, status: 'ok' | 'error' | 'skip' = 'ok') {
      if (timer) clearInterval(timer);
      timer = undefined;
      const mark = status === 'ok' ? c.green(s.ok) : status === 'error' ? c.red(s.no) : c.dim(s.done);
      if (tty) w.terminal.output.write(`\r\x1b[K\x1b[?25h${mark}  ${text}\n`); else w.write(`${mark} ${text}`);
    },
  };
}
export function elapsed(ms: number): string {
  if (ms < 1000) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
/** A duration as people say it: "about 2 min", "about 50 min", "about 3 h". */
export function about(ms: number): string {
  if (ms < 60_000) return `about ${Math.max(5, Math.round(ms / 5000) * 5)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `about ${minutes} min`;
  return `about ${Math.round(minutes / 6) / 10} h`;
}
