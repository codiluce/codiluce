// PROTOTYPE (throwaway): snapshots real data from running Codiluce servers into
// web/public/prototype/visual-directions/*.json, so the prototype page runs with
// no server. Read-only GET requests only.
//
//   node web/app/prototype/visual-directions/capture.mjs [mapApi] [historyApi]
//
// mapApi (default http://127.0.0.1:4300): a live map of this repository (map, tour, PR, agents).
// historyApi (default http://127.0.0.1:4301): a server with this repository's history indexed (commits).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAP = process.argv[2] ?? 'http://127.0.0.1:4300';
const HISTORY = process.argv[3] ?? 'http://127.0.0.1:4301';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const OUT = path.join(ROOT, 'web/public/prototype/visual-directions');
mkdirSync(OUT, { recursive: true });

const get = async url => { const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.json(); };
const slim = node => {
  const { analysis, archetypeCounts, sourceRange, canonicalParentId, ...rest } = node;
  return { ...rest, ...(archetypeCounts ? { archetypeCounts: archetypeCounts.slice(0, 6) } : {}) };
};
async function children(api, id, view = '') {
  const items = [];
  for (let offset = 0; ; offset += 500) {
    const page = await get(`${api}/api/projection/children/${encodeURIComponent(id)}?limit=500&offset=${offset}${view}`);
    items.push(...page.items);
    if (!page.hasMore) return items;
  }
}
/** Every node down to files (and the symbols of `withSymbols` files). */
async function hierarchy(api, view = '', withSymbols = new Set()) {
  const meta = await get(`${api}/api/projection${view ? `?${view.slice(1)}` : ''}`);
  const nodes = [slim(meta.root)];
  const queue = [meta.root];
  while (queue.length) {
    const batch = queue.splice(0, 16);
    const results = await Promise.all(batch.map(node => children(api, node.id, view)));
    for (const items of results) for (const item of items) {
      if (item.hidden) continue;
      const isSymbol = item.type !== 'file' && item.type !== 'directory' && item.type !== 'group' && item.type !== 'application' && item.type !== 'repository';
      if (isSymbol) continue;
      nodes.push(slim(item));
      if (item.type === 'file' ? withSymbols.has(item.path) && item.childCount > 0 : item.childCount > 0) {
        if (item.type === 'file') {
          const symbols = await children(api, item.id, view);
          nodes.push(...symbols.filter(symbol => !symbol.hidden).map(slim));
        } else queue.push(item);
      }
    }
  }
  return { meta: { snapshot: meta.snapshot, layout: meta.layout, comparison: meta.comparison }, nodes };
}

// 1. The map, with the symbols the tour names.
const TOUR_FILES = ['src/analysis/tree-sitter/native-budget.ts', 'src/analysis/tree-sitter/client.ts', 'src/analysis/tree-sitter/grammars.ts', 'src/analysis/tree-sitter/extract.ts'];
console.log('map…');
const map = await hierarchy(MAP, '', new Set(TOUR_FILES));
writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(map));
console.log(`map: ${map.nodes.length} nodes`);
const byPath = new Map(map.nodes.filter(node => node.type === 'file').map(node => [node.path, node]));

// 2. A real pull request (a merge on main): its files and the relationships between them.
async function pull(sha, title) {
  const lines = execFileSync('git', ['-C', ROOT, 'diff', '--name-status', '-M', `${sha}^1`, sha], { encoding: 'utf8' }).trim().split('\n');
  const files = lines.map(line => { const [status, a, b] = line.split('\t'); return { status: status[0], path: b ?? a, from: b ? a : undefined }; });
  const present = files.filter(file => byPath.has(file.path));
  const ids = new Set(present.map(file => byPath.get(file.path).id));
  const arrows = new Map();
  for (const file of present) {
    const node = byPath.get(file.path);
    for (let offset = 0; offset < 2000; offset += 500) {
      const page = await get(`${MAP}/api/projection/relations/${encodeURIComponent(node.id)}?scope=contained&direction=outgoing&limit=500&offset=${offset}`);
      for (const item of page.items) {
        const target = [item.other.id, ...(item.otherAncestors ?? [])].find(id => ids.has(id));
        if (!target || target === node.id) continue;
        const key = `${node.id}>${target}`;
        const arrow = arrows.get(key) ?? { from: node.id, to: target, types: {} };
        arrow.types[item.type] = (arrow.types[item.type] ?? 0) + 1;
        arrows.set(key, arrow);
      }
      if (!page.hasMore) break;
    }
  }
  const subject = execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%s%x1f%an%x1f%aI', sha], { encoding: 'utf8' }).trim().split('\x1f');
  return { sha, title, subject: subject[0], author: subject[1], date: subject[2], files, missing: files.filter(file => !byPath.has(file.path)).map(file => file.path), arrows: [...arrows.values()] };
}
console.log('pull…');
writeFileSync(path.join(OUT, 'pull.json'), JSON.stringify(await pull('6686d2e', 'Pull request views')));

// 3. Agent activity the live server observed (real sessions), resolved by path.
console.log('agents…');
const agents = await get(`${MAP}/api/agents`);
writeFileSync(path.join(OUT, 'agents.json'), JSON.stringify({ sessions: agents.sessions, events: agents.events.map(event => ({ ...event, paths: event.paths.map(({ ancestors, ...rest }) => rest) })) }));
console.log(`agents: ${agents.events.length} events, ${agents.sessions.length} sessions`);

// 4. Commits from the history server: the comparison map (timeline layout) and the changes.
const history = await get(`${HISTORY}/api/history`);
const COMMITS = ['d7c679c', 'f573379', '884201a'];
const commits = [];
for (const prefix of COMMITS) {
  const index = history.entries.findIndex(entry => entry.sha.startsWith(prefix));
  const entry = history.entries[index];
  let before = index - 1;
  while (before >= 0 && !history.entries[before].snapshot) before--;
  const baseline = history.entries[before];
  const view = `&snapshot=${entry.snapshot.id}&compareTo=${baseline.snapshot.id}`;
  console.log(`commit ${prefix}…`);
  const changes = [];
  for (let offset = 0; ; offset += 500) {
    const page = await get(`${HISTORY}/api/history/changes?snapshot=${entry.snapshot.id}&compareTo=${baseline.snapshot.id}&limit=500&offset=${offset}`);
    changes.push(...page.items.map(slim));
    if (!page.hasMore) break;
  }
  const changedFiles = new Set(changes.filter(item => item.type === 'file').map(item => item.path));
  const comparison = await hierarchy(HISTORY, view, changedFiles);
  const relations = [];
  const fileIds = new Set(changes.filter(item => item.type === 'file').map(item => item.id));
  for (const file of changes.filter(item => item.type === 'file' && item.change?.status !== 'removed')) {
    const page = await get(`${HISTORY}/api/projection/relations/${encodeURIComponent(file.id)}?scope=contained&direction=outgoing&limit=500${view}`);
    for (const item of page.items) {
      if (!item.change) continue;
      const target = [item.other.id, ...(item.otherAncestors ?? [])].find(id => fileIds.has(id));
      if (target && target !== file.id) relations.push({ from: file.id, to: target, type: item.type, change: item.change });
    }
  }
  const stat = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '-M', `${entry.sha}^1`, entry.sha], { encoding: 'utf8' }).trim().split('\n').map(line => { const [added, removed, file] = line.split('\t'); return { added: Number(added) || 0, removed: Number(removed) || 0, path: file }; });
  const coAuthors = execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly,separator=%x1f)', entry.sha], { encoding: 'utf8' }).trim().split('\x1f').filter(Boolean);
  commits.push({ coAuthors, sha: entry.sha, subject: entry.subject, author: entry.authorName, date: entry.authoredAt, note: entry.note, files: entry.files, stat, changes, relations, map: comparison });
  console.log(`  ${changes.length} changes, ${comparison.nodes.length} nodes, ${relations.length} changed relations`);
}
writeFileSync(path.join(OUT, 'commits.json'), JSON.stringify(commits));
console.log('done');
