import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileHistory } from '../src/history/file-history.js';
import { listCommits } from '../src/history/git.js';
import { HistoryAccess, HistoryService } from '../src/history/service.js';
import { GraphStore } from '../src/storage/sqlite.js';
import type { EvolutionResponse } from '../src/projection/dto.js';

function frameNodes(data: Extract<EvolutionResponse, { status: 'ready' }>, frame: number, ghosts = true) {
  const placed = new Set<number>();
  for (const current of data.frames.slice(0, frame + 1)) { for (const index of current.drop) placed.delete(index); for (const [index] of current.set) placed.add(index!); }
  const statuses = new Map(data.frames[frame]!.changes.map(([index, status]) => [index!, status!]));
  return { nodes: new Map([...placed].filter(index => ghosts || statuses.get(index) !== 4).map(index => [data.nodes[index]!.id, { ...data.nodes[index]!, change: { status: statuses.get(index) === 3 ? 'moved' : undefined } }])) };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-file-history-'));
  const state = await mkdtemp(path.join(tmpdir(), 'codiluce-file-state-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@test.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@test.invalid' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-qb', 'main');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'stable.txt'), 'unchanged\n');
  const A = commit('Initial');
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 2;\nexport const b = 3;\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'tab\tnewline\n.txt'), 'odd path\n');
  const B = commit('Edit and add');
  git('mv', 'src/a.ts', 'src/renamed.ts');
  await rm(path.join(root, 'binary.bin'));
  const C = commit('Rename and remove');
  return { root, state, git, commit, A, B, C, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); } };
}

test('Git evolution works without snapshots, tracks exact paths and persists only file deltas', async () => {
  const f = await fixture(); const store = new GraphStore(':memory:'); const accessHistory = new HistoryAccess(f.state);
  try {
    const service = new HistoryService({ root: f.root, stateDirectory: f.state, store, history: accessHistory });
    const timeline = await service.timeline();
    assert.equal(timeline.available, true);
    assert.equal(timeline.entries.length, 3);
    assert.ok(timeline.entries.every(entry => !entry.snapshot));
    assert.deepEqual(timeline.entries[1]!.files, { files: 3, added: 2, modified: 1, moved: 0, removed: 0, insertions: 3, deletions: 1, binary: 1 });
    const renamed = await service.commitFiles(f.C);
    assert.equal(renamed.summary.moved, 1); assert.equal(renamed.summary.removed, 1);
    assert.equal(renamed.files.find(file => file.status === 'moved')!.from, 'src/a.ts');
    assert.ok((await service.commitFiles(f.B)).files.some(file => file.path === 'tab\tnewline\n.txt'));
    assert.match((await service.commitDiff(f.B, 'src/a.ts')).patch, /\+export const b = 3/);
    assert.match((await service.commitDiff(f.C, 'src/renamed.ts')).patch, /rename from src\/a.ts/);
    assert.match((await service.commitDiff(f.B, 'binary.bin')).unavailable!, /Binary/);
    await assert.rejects(service.commitDiff(f.B, '../outside'), /not changed/);
    const result = await service.gitEvolution();
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
    assert.equal(result.frames.length, 3);
    const initial = frameNodes(result, 0), last = frameNodes(result, 2);
    assert.ok([...initial.nodes.values()].some(node => node.path === 'stable.txt'));
    assert.ok([...last.nodes.values()].some(node => node.path === 'src/renamed.ts' && node.change?.status === 'moved'), 'rename is shown at the new path');
    assert.ok([...last.nodes.values()].every(node => !node.path || node.path !== 'src/a.ts'), 'the old path is absent');
    assert.ok([...last.nodes.values()].every(node => ['repository', 'directory', 'file'].includes(node.type)));
    await assert.rejects(access(path.join(f.state, 'history.db')));
    assert.ok((await readFile(path.join(f.state, 'git-file-history.json'), 'utf8')).includes(f.C));
  } finally { accessHistory.close(); store.close(); await f.cleanup(); }
});

test('file history appends new commits, survives cache reload/rewrites, and seeds a bounded window', async () => {
  const f = await fixture();
  try {
    const history = new FileHistory(f.root, f.state);
    const commits = await listCommits(f.root, { ref: 'main' });
    await history.load(commits);
    await writeFile(path.join(f.root, 'new.txt'), 'new\n');
    const D = f.commit('Append');
    const updated = await listCommits(f.root, { ref: 'main' });
    const loaded = await history.load(updated);
    assert.equal(loaded.size, 4); assert.equal(loaded.get(D)!.summary.added, 1);
    const reloaded = new FileHistory(f.root, f.state);
    assert.deepEqual([...await reloaded.load(updated)], [...loaded]);
    const bounded = updated.slice(-2);
    const data = await history.evolution(bounded, loaded, 'fixture', []);
    assert.equal(data.status, 'ready'); if (data.status !== 'ready') return;
    const scene = frameNodes(data, 0, false);
    assert.ok([...scene.nodes.values()].some(node => node.path === 'stable.txt'), 'unchanged files before the window are retained');
    assert.ok(![...scene.nodes.values()].some(node => node.path === 'binary.bin'), 'deletions in the first bounded commit are applied');
    f.git('reset', '--hard', f.A);
    await writeFile(path.join(f.root, 'replacement.txt'), 'replacement\n');
    const rewritten = f.commit('Rewritten');
    const changed = await listCommits(f.root, { ref: 'main' });
    assert.deepEqual([...await history.load(changed)].map(([sha]) => sha), [f.A, rewritten]);
    await writeFile(path.join(f.state, 'git-file-history.json'), '{broken');
    assert.equal((await new FileHistory(f.root, f.state).load(changed)).size, 2);
    const invalid = JSON.parse(await readFile(path.join(f.state, 'git-file-history.json'), 'utf8'));
    invalid.entries[0].files[0].path = '/';
    await writeFile(path.join(f.state, 'git-file-history.json'), JSON.stringify(invalid));
    const repaired = await new FileHistory(f.root, f.state).load(changed);
    assert.ok(repaired.get(f.A)!.files.every(file => file.path !== '/'), 'invalid cached paths are recomputed');
  } finally { await f.cleanup(); }
});

test('first-parent merge changes include side-branch files and read-only history creates no cache', async () => {
  const f = await fixture();
  try {
    f.git('checkout', '-qb', 'side');
    await writeFile(path.join(f.root, 'side.txt'), 'side\n'); f.commit('Side');
    f.git('checkout', 'main'); f.git('merge', '--no-ff', 'side', '-m', 'Merge');
    const commits = await listCommits(f.root, { ref: 'main' });
    const history = new FileHistory(f.root, f.state, true);
    const changes = await history.load(commits);
    assert.ok(changes.get(commits.at(-1)!.sha)!.files.some(file => file.path === 'side.txt' && file.status === 'added'));
    await assert.rejects(access(path.join(f.state, 'git-file-history.json')));
    const data = await history.evolution(commits, changes, 'fixture', ['src/**']);
    assert.equal(data.status, 'ready');
    if (data.status === 'ready') assert.ok(data.nodes.every(node => !node.path?.startsWith('src/')));
  } finally { await f.cleanup(); }
});

test('renamed files and new files reusing their old paths have distinct identities', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'src/a.ts'), 'export const replacement = true;\n');
    f.commit('Reuse the old path');
    const commits = await listCommits(f.root, { ref: 'main' });
    const history = new FileHistory(f.root, f.state);
    const data = await history.evolution(commits, await history.load(commits), 'fixture', []);
    assert.equal(data.status, 'ready'); if (data.status !== 'ready') return;
    const scene = frameNodes(data, 3, false);
    const old = [...scene.nodes.values()].find(node => node.path === 'src/renamed.ts')!;
    const replacement = [...scene.nodes.values()].find(node => node.path === 'src/a.ts')!;
    assert.ok(old && replacement); assert.notEqual(old.id, replacement.id);
    const frame = data.frames[3]!;
    const positions = new Map<number, number[]>();
    for (const current of data.frames.slice(0, 4)) { for (const index of current.drop) positions.delete(index); for (const [index, ...position] of current.set) positions.set(index!, position); }
    const before = positions.get(data.nodes.findIndex(node => node.id === old.id))!;
    const after = positions.get(data.nodes.findIndex(node => node.id === replacement.id))!;
    assert.notDeepEqual(before.slice(1, 3), after.slice(1, 3), 'files occupy separate rectangles');
    assert.ok(frame.changes.some(([index, status]) => data.nodes[index!]!.id === replacement.id && status === 1));
  } finally { await f.cleanup(); }
});

test('the complete Git timeline, commit details and playback include commits beyond 5,000', async () => {
  const f = await fixture(); const store = new GraphStore(':memory:'); const accessHistory = new HistoryAccess(f.state);
  try {
    const count = 5001;
    const commits: string[] = [];
    for (let i = 1; i <= count; i++) {
      const subject = `Commit ${i}`;
      commits.push(`commit refs/heads/complete\nmark :${i}\ncommitter Fixture <fixture@test.invalid> ${1700000000 + i} +0000\ndata ${subject.length}\n${subject}\n${i === 1 ? 'M 100644 inline stable.txt\ndata 7\nstable\n\n' : '\n'}`);
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: f.root, input: commits.join('') });
    const service = new HistoryService({ root: f.root, stateDirectory: f.state, store, history: accessHistory });
    const timeline = await service.timeline('complete');
    assert.equal(timeline.entries.length, count);
    assert.equal(timeline.entries[0]!.subject, 'Commit 1');
    assert.equal(timeline.fileHistory?.truncated, false);
    assert.equal((await service.commitFiles(timeline.entries[0]!.sha, 'complete')).files[0]!.path, 'stable.txt');
    const evolution = await service.gitEvolution('complete');
    assert.equal(evolution.status, 'ready');
    if (evolution.status === 'ready') assert.equal(evolution.frames.length, count);
    await assert.rejects(access(path.join(f.state, 'history.db')));
  } finally { accessHistory.close(); store.close(); await f.cleanup(); }
});
