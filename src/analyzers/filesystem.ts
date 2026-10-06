import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applicationAt, gitIgnored, matchesGlob, type ApplicationConfig } from '../core/config.js';
import { ANALYZER_VERSION, evidence } from '../core/graph.js';
import { CODE_LANGUAGES, headerLanguage, languageOf } from '../core/languages.js';
import type { Analyzer, AnalysisContext, ScannedFile } from '../core/analyzer.js';

/** An application's facts: `framework` is the primary one (what it is), `frameworks` and `ecosystems` everything its configuration and manifests say. */
function applicationMetadata(app: ApplicationConfig): Record<string, unknown> {
  return { ...(app.frameworks.length ? { framework: app.frameworks[0] } : {}), frameworks: app.frameworks, ecosystems: app.ecosystems };
}
export const filesystemAnalyzer: Analyzer = {
  name: 'filesystem', version: ANALYZER_VERSION,
  async analyze(context: AnalysisContext): Promise<void> {
    const { root, config, graph } = context;
    graph.addEntity({ id: context.repositoryId, type: 'repository', name: config.repository.name, metadata: {}, evidence: [evidence('filesystem', 'filesystem', undefined, undefined, 'Repository scan root')] });
    // A materialized commit holds tracked files only: there is nothing ignored to prune.
    const ignored = context.revision ? undefined : await gitIgnored(root);
    if (!context.revision && !ignored) graph.diagnose({ analyzer: 'filesystem', severity: 'info', code: 'git-ignore-unavailable', reason: 'Git ignored-file inventory unavailable; using configured/default ignores' });
    const ignoredFiles = ignored?.files ?? new Set<string>();
    const ignoredDirectories = ignored?.directories ?? new Set<string>();
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
          graph.contain({ id, type: app ? 'application' : 'directory', name: app?.name ?? entry.name, path: rel, parentId, metadata: app ? applicationMetadata(app) : {}, evidence: facts });
          await scan(rel, id);
        } else if (entry.isFile()) {
          const file = path.join(root, rel);
          const info = await stat(file);
          const language = languageOf(rel);
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
          const application = applicationAt(config.applications, rel);
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
      graph.contain({ id: parent, type: 'application', name: rootApp.name, path: '.', parentId: context.repositoryId, metadata: applicationMetadata(rootApp), evidence: [evidence('filesystem', 'filesystem', undefined, undefined, 'Application manifest at repository root')] });
    }
    await scan('', parent);
    measureLanguages(context);
    for (const app of config.applications) if (!context.applicationIds.has(app.name)) graph.diagnose({ analyzer: 'filesystem', severity: 'error', code: 'application-not-scanned', file: app.path, reason: 'Configured application was pruned by ignore rules' });
  },
};
/**
 * Per application (and for files outside any): `.h` headers take the language
 * of the sources beside them (`headerLanguage`); the application records the
 * measured lines of each code language (`metadata.languages`) and is written
 * in the one with the most (`language`).
 */
function measureLanguages(context: AnalysisContext): void {
  const { graph } = context;
  const groups = new Map<string, ScannedFile[]>();
  for (const file of context.files.values()) { const key = file.application?.name ?? ''; groups.set(key, [...groups.get(key) ?? [], file]); }
  for (const [name, files] of groups) {
    const sources = new Set(files.filter(file => file.language && !file.path.endsWith('.h')).map(file => file.language!));
    const header = headerLanguage(sources);
    if (header !== 'c') for (const file of files) if (file.path.endsWith('.h')) { file.language = header; graph.entities.get(file.id)!.language = header; }
    const appId = name ? context.applicationIds.get(name) : undefined;
    const application = appId ? graph.entities.get(appId) : undefined;
    if (!application) continue;
    const lines = new Map<string, number>();
    for (const file of files) {
      const loc = graph.entities.get(file.id)?.metrics?.loc;
      if (file.language && CODE_LANGUAGES.has(file.language) && loc) lines.set(file.language, (lines.get(file.language) ?? 0) + loc);
    }
    const measured = [...lines].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
    if (!measured.length) continue;
    application.language = measured[0]![0];
    application.metadata.languages = Object.fromEntries(measured);
  }
}
