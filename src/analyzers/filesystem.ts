import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { matchesGlob } from '../core/config.js';
import { ANALYZER_VERSION, evidence } from '../core/graph.js';
import type { Analyzer, AnalysisContext } from '../core/analyzer.js';

const execute = promisify(execFile);
const LANGUAGES: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.php': 'php', '.css': 'css', '.scss': 'scss', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.md': 'markdown', '.html': 'html', '.sql': 'sql', '.sh': 'shell', '.xml': 'xml', '.svg': 'xml' };
export const filesystemAnalyzer: Analyzer = {
  name: 'filesystem', version: ANALYZER_VERSION,
  async analyze(context: AnalysisContext): Promise<void> {
    const { root, config, graph } = context;
    graph.addEntity({ id: context.repositoryId, type: 'repository', name: config.repository.name, metadata: {}, evidence: [evidence('filesystem', 'filesystem', undefined, undefined, 'Repository scan root')] });
    let ignored: string[] = [];
    // A materialized commit holds tracked files only: there is nothing ignored to prune.
    if (!context.revision) try {
      const result = await execute('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      ignored = result.stdout.split('\0').filter(Boolean);
    } catch {
      graph.diagnose({ analyzer: 'filesystem', severity: 'info', code: 'git-ignore-unavailable', reason: 'Git ignored-file inventory unavailable; using configured/default ignores' });
    }
    const ignoredFiles = new Set(ignored.filter(file => !file.endsWith('/')));
    const ignoredDirectories = new Set(ignored.filter(file => file.endsWith('/')).map(file => file.slice(0, -1)));
    const shouldIgnore = (relative: string) => config.ignore.some(glob => matchesGlob(relative, glob)) || ignoredFiles.has(relative) || ignoredDirectories.has(relative);
    const appAt = (relative: string) => config.applications.find(app => app.path === relative);
    async function scan(relative: string, parentId: string): Promise<void> {
      const absolute = path.join(root, relative);
      for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (shouldIgnore(rel)) continue;
        if (entry.isSymbolicLink()) { graph.diagnose({ analyzer: 'filesystem', severity: 'info', code: 'symlink-skipped', file: rel, reason: 'Symlinks are not followed' }); continue; }
        const facts = [evidence('filesystem', 'filesystem', rel)];
        if (entry.isDirectory()) {
          const app = appAt(rel);
          const id = graph.id(app ? 'application' : 'directory', app?.name ?? rel);
          if (app) context.applicationIds.set(app.name, id);
          graph.contain({ id, type: app ? 'application' : 'directory', name: app?.name ?? entry.name, path: rel, parentId, metadata: app ? { framework: app.type } : {}, evidence: facts });
          await scan(rel, id);
        } else if (entry.isFile()) {
          const file = path.join(root, rel);
          const info = await stat(file);
          const language = LANGUAGES[path.extname(rel).toLowerCase()];
          const id = graph.id('file', rel);
          let loc: number | undefined;
          let digest: string | undefined;
          let analyzable = false;
          let skipReason: string | undefined;
          if (info.size > config.maxFileBytes) skipReason = 'File exceeds maxFileBytes';
          else if (language) {
            const buffer = await readFile(file);
            if (buffer.includes(0)) skipReason = 'Binary content';
            else {
              const content = buffer.toString('utf8');
              loc = content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
              digest = createHash('sha256').update(buffer).digest('hex');
              analyzable = true;
            }
          } else skipReason = 'Unsupported text extension or binary asset';
          const application = config.applications.find(app => app.path === '.' || rel.startsWith(`${app.path}/`));
          graph.contain({ id, type: 'file', name: entry.name, path: rel, ...(language ? { language } : {}), parentId, metadata: { extension: path.extname(rel), bytes: info.size, ...(digest ? { contentHash: digest } : {}), ...(skipReason ? { analysisSkipped: skipReason } : {}) }, ...(loc !== undefined ? { metrics: { loc } } : {}), evidence: facts });
          context.files.set(rel, { path: rel, absolutePath: file, id, language, analyzable, application });
          if (skipReason && language) graph.diagnose({ analyzer: 'filesystem', severity: 'warning', code: 'file-content-skipped', file: rel, entityId: id, reason: skipReason });
        }
      }
    }
    const rootApp = appAt('.');
    let parent = context.repositoryId;
    if (rootApp) {
      parent = graph.id('application', rootApp.name);
      context.applicationIds.set(rootApp.name, parent);
      graph.contain({ id: parent, type: 'application', name: rootApp.name, path: '.', parentId: context.repositoryId, metadata: { framework: rootApp.type }, evidence: [evidence('filesystem', 'filesystem', undefined, undefined, 'Application manifest at repository root')] });
    }
    await scan('', parent);
    for (const app of config.applications) if (!context.applicationIds.has(app.name)) graph.diagnose({ analyzer: 'filesystem', severity: 'error', code: 'application-not-scanned', file: app.path, reason: 'Configured application was pruned by ignore rules' });
  },
};
