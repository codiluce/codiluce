import assert from 'node:assert/strict';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childExecArgv, indexHistory, HISTORY_DATABASE } from '../src/history/indexer.js';
import { HistoryStore } from '../src/history/store.js';
import { canonicalJson } from '../src/history/fingerprint.js';

function probeWorker() {
  const child = fork(fileURLToPath(new URL('./fixtures/history-worker-channel.ts', import.meta.url)), [], { execArgv: childExecArgv(), serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: any[] = []; child.on('message', message => messages.push(message));
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.resume();
  return { child, messages, output: () => output };
}
async function message(child: ChildProcess, predicate: (message: any) => boolean): Promise<any> {
  for (;;) { const [value] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) }); if (predicate(value)) return value; }
}

test('history IPC flush and mismatched acknowledgments cannot advance the worker', async () => {
  const { child, messages } = probeWorker();
  try {
    const first = message(child, value => value.type === 'error'); child.send({ type: 'start' }); assert.equal((await first).sha, 'commit-0');
    for (let id = 0; id < 4; id++) {
      child.send({ type: 'stored', sha: 'unrelated' }); const reply = message(child, value => value.type === 'probe' && value.id === id); child.send({ type: 'probe', id });
      assert.equal((await reply).completed, 0); assert.equal(messages.filter(value => value.type === 'error').length, 1);
    }
    for (let i = 0; i < 3; i++) {
      const next = message(child, value => i === 2 ? value.type === 'complete' : value.type === 'error' && value.sha === `commit-${i + 1}`);
      child.send({ type: 'stored', sha: `commit-${i}` }); await next;
    }
    const [code] = await once(child, 'close'); assert.equal(code, 0);
    assert.equal(messages.filter(value => value.type === 'error').length, 3);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('a disconnected history parent releases an unacknowledged worker', async () => {
  const { child, output } = probeWorker();
  try {
    const first = message(child, value => value.type === 'error'); child.send({ type: 'start' }); await first;
    const closed = once(child, 'exit'); child.disconnect(); const [code] = await closed; assert.equal(code, 0);
    const result = JSON.parse(output()); assert.equal(result.completed, 0); assert.match(result.error, /disconnected before acknowledging/);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('history save failure acknowledges only that commit, resumes and matches serial snapshots', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codiluce-history-backpressure-')), root = path.join(temporary, 'repository');
  await mkdir(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  const config = { repository: { name: 'backpressure' }, applications: [{ name: 'app', path: '.', ecosystems: ['python'] }] };
  const state = path.join(temporary, 'parallel'), serial = path.join(temporary, 'serial');
  for (const directory of [state, serial]) { await mkdir(directory); await writeFile(path.join(directory, 'config.yml'), JSON.stringify(config)); }
  const original = HistoryStore.prototype.saveSnapshot;
  try {
    git('init', '-q', '-b', 'main');
    for (let i = 0; i < 6; i++) { await writeFile(path.join(root, 'main.py'), `def run():\n    return ${i}\n`); git('add', '-A'); git('commit', '-q', '-m', `Commit ${i}`); }
    let rejectFirst = true;
    HistoryStore.prototype.saveSnapshot = function (...args) { if (rejectFirst) { rejectFirst = false; throw Error('injected save failure'); } return original.apply(this, args); };
    const first = await indexHistory({ root, stateDirectory: state, ref: 'main', jobs: 2 });
    assert.deepEqual([first.indexed, first.failed, first.snapshots], [5, 1, 5]);
    HistoryStore.prototype.saveSnapshot = original;
    const resume = await indexHistory({ root, stateDirectory: state, ref: 'main', jobs: 2 }); assert.deepEqual([resume.indexed, resume.failed, resume.skipped], [1, 0, 5]);
    const reference = await indexHistory({ root, stateDirectory: serial, ref: 'main', jobs: 1 }); assert.equal(reference.indexed, 6);
    const shape = (directory: string) => {
      const store = new HistoryStore(path.join(directory, HISTORY_DATABASE), true);
      try { return store.snapshots().map(snapshot => ({ sha: snapshot.commitSha, entities: store.entities(snapshot.seq), relations: store.relations(snapshot.seq), diagnostics: store.diagnostics(snapshot.seq) })).sort((a, b) => a.sha.localeCompare(b.sha)); }
      finally { store.close(); }
    };
    assert.equal(canonicalJson(shape(state)), canonicalJson(shape(serial)));
  } finally { HistoryStore.prototype.saveSnapshot = original; await rm(temporary, { recursive: true, force: true }); }
});
