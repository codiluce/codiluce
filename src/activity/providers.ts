import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { AgentConnection, AgentProvider, AgentSession } from './model.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const titleText = (value: unknown): string | undefined => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256) || undefined : undefined;

/** Recognize this repository's observer, not another repository or an unrelated Codiluce command. */
export function activityCommand(command: unknown, provider: AgentProvider, root: string, stateDirectory: string): boolean {
  if (typeof command !== 'string' || !/(?:activity[\\/]hook-cli\.(?:ts|js)|\bactivity\s+hook\b)/.test(command)) return false;
  const tokens = command.match(/'(?:[^']|'\\'')*'|"[^"\n]*"|[^\s'"]+/g)?.map(token => token.replace(/^(['"])(.*)\1$/, '$2').replace(/'\\''/g, "'")) ?? [];
  const arg = (name: string) => tokens[tokens.indexOf(name) + 1];
  return tokens.includes('--repo') && tokens.includes('--state-dir') && arg('--agent') === provider && arg('--repo') === root && arg('--state-dir') === stateDirectory;
}
interface CodexHook { command?: string; sourcePath?: string; enabled?: boolean; trustStatus?: string }
interface CodexResult { hooks?: CodexHook[]; name?: string; hooksDisabled?: boolean }

/** Metadata only: never starts/resumes a thread, runs a turn, or changes hook trust. */
export async function inspectCodex(root: string, threadId?: string): Promise<CodexResult | undefined> {
  return new Promise(resolve => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '', bytes = 0, finished = false;
    const result: CodexResult = {};
    const waiting = new Set([2, 3, ...(threadId ? [4] : [])]);
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timeout);
      child.stdin.destroy(); child.stdout.destroy(); child.kill();
      resolve(result.hooks || result.name ? result : undefined);
    };
    const timeout = setTimeout(finish, 4000);
    const send = (message: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.on('error', finish); child.on('exit', finish); child.stdin.on('error', finish);
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) return finish();
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try { message = object(JSON.parse(line)); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish();
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'hooks/list', params: { cwds: [root] } });
          send({ id: 3, method: 'config/read', params: { includeLayers: false } });
          if (threadId) send({ id: 4, method: 'thread/read', params: { threadId, includeTurns: false } });
        } else if (waiting.delete(Number(message.id))) {
          const response = object(message.result);
          if (message.id === 2 && Array.isArray(response.data)) result.hooks = response.data.flatMap(entry => {
            const item = object(entry); return item.cwd === root && Array.isArray(item.hooks) ? item.hooks as CodexHook[] : [];
          });
          if (message.id === 3) result.hooksDisabled = object(object(response.config).features).hooks === false;
          if (message.id === 4) { const thread = object(response.thread); if (thread.cwd === root) result.name = titleText(thread.name); }
          if (!waiting.size) return finish();
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codiluce-activity', version: '0.2.0' }, capabilities: { experimentalApi: true } } });
  });
}

async function configFile(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await stat(file)).size > 1024 * 1024) return undefined;
    const text = await readFile(file, 'utf8');
    return object(file.endsWith('.toml') ? parse(text) : JSON.parse(text));
  } catch { return undefined; }
}
export async function connectionConfiguration(root: string, stateDirectory: string, provider: AgentProvider): Promise<AgentConnection> {
  const home = provider === 'codex' ? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex') : process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const files = provider === 'codex'
    ? [path.join(home, 'hooks.json'), path.join(home, 'config.toml'), path.join(root, '.codex/hooks.json'), path.join(root, '.codex/config.toml')]
    : [path.join(home, 'settings.json'), path.join(root, '.claude/settings.json'), path.join(root, '.claude/settings.local.json')];
  const sources: string[] = [];
  let disabled: boolean | undefined;
  for (const file of files) {
    const config = await configFile(file); if (!config) continue;
    if (provider === 'claude-code' && typeof config.disableAllHooks === 'boolean') disabled = config.disableAllHooks;
    if (provider === 'codex' && typeof object(config.features).hooks === 'boolean') disabled = object(config.features).hooks === false;
    const matches = Object.values(object(config.hooks)).some(groups => Array.isArray(groups) && groups.some(group => {
      const handlers = object(group).hooks;
      return Array.isArray(handlers) && handlers.some(handler => activityCommand(object(handler).command, provider, root, stateDirectory));
    }));
    if (matches) sources.push(file);
  }
  return { provider, configured: sources.length > 0, sources, trust: 'unknown', ...(disabled !== undefined ? { disabled } : {}) };
}

export class AgentMetadata {
  private closed = false;
  private reads = new Map<string, { at: number; value: Promise<CodexResult | undefined> }>();
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly root: string, private readonly stateDirectory: string, private readonly inspect = inspectCodex) {}
  private schedule(threadId?: string): Promise<CodexResult | undefined> {
    return new Promise(resolve => {
      const run = () => {
        if (this.closed) { resolve(undefined); return; }
        this.active++;
        void this.inspect(this.root, threadId).then(result => resolve(result && { ...result, hooks: result.hooks?.filter(hook => activityCommand(hook.command, 'codex', this.root, this.stateDirectory)) }), () => resolve(undefined)).finally(() => { this.active--; this.queue.shift()?.(); });
      };
      if (this.active < 2) run(); else this.queue.push(run);
    });
  }
  private codex(threadId?: string): Promise<CodexResult | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const key = threadId ?? 'configuration', cached = this.reads.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = this.schedule(threadId);
    this.reads.set(key, { at: Date.now(), value });
    while (this.reads.size > 100) this.reads.delete(this.reads.keys().next().value!);
    return value;
  }
  async title(session: AgentSession): Promise<string | undefined> {
    if (session.provider !== 'codex' || !/^(?:[a-f0-9-]{36}|thr_[\w-]+)$/.test(session.sessionId)) return undefined;
    return (await this.codex(session.sessionId))?.name;
  }
  async connections(): Promise<AgentConnection[]> {
    this.reads.delete('configuration');
    const [codex, claude, runtime] = await Promise.all([
      connectionConfiguration(this.root, this.stateDirectory, 'codex'),
      connectionConfiguration(this.root, this.stateDirectory, 'claude-code'), this.codex(),
    ]);
    if (runtime?.hooks) {
      const hooks = runtime.hooks.filter(hook => activityCommand(hook.command, 'codex', this.root, this.stateDirectory));
      if (hooks.length) {
        codex.configured = true;
        codex.sources = [...new Set([...codex.sources, ...hooks.flatMap(hook => hook.sourcePath ? [hook.sourcePath] : [])])];
        codex.disabled = runtime.hooksDisabled || hooks.every(hook => hook.enabled === false);
        codex.trust = hooks.some(hook => hook.trustStatus === 'modified') ? 'modified'
          : hooks.some(hook => hook.trustStatus === 'untrusted') ? 'needs-review'
          : hooks.every(hook => ['trusted', 'managed'].includes(hook.trustStatus ?? '')) ? 'trusted' : 'unknown';
      }
    }
    return [codex, claude];
  }
  close(): void { this.closed = true; this.reads.clear(); for (const run of this.queue.splice(0)) run(); }
}
