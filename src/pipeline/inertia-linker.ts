// Inertia pages: the server renders a page component of the client by name.
//
// `Inertia::render('words/index')` (an effect of a controller method, or the
// `inertiaPage` of a route closure) names a component of the same Laravel
// application under `resources/js/pages` (or `Pages`, the older starter
// kits), as `createInertiaApp`'s conventional resolver loads it. The page's
// default export (else the file) gets a `renders` relation from the method or
// the endpoint, so a page journey continues from the controller into the
// client, and a visit made by that page has an entry point. This runs after
// both language analyzers and is never cached: it only joins their results.
import path from 'node:path';
import type { AnalysisContext, Analyzer } from '../core/analyzer.js';
import { ANALYZER_VERSION, evidence, type EffectFact, type Entity } from '../core/graph.js';
import { hasFramework } from '../core/config.js';

const PAGE_DIRECTORIES = ['resources/js/pages', 'resources/js/Pages'];
const EXTENSIONS = ['tsx', 'jsx', 'ts', 'js', 'vue', 'svelte'];

export const inertiaLinker: Analyzer = {
  name: 'inertia-linker', version: ANALYZER_VERSION,
  async analyze(context: AnalysisContext): Promise<void> {
    const { graph } = context;
    const page = (entity: Entity, name: string): { file: string; target: Entity } | undefined => {
      const app = entity.path ? context.files.get(entity.path)?.application : undefined;
      if (!hasFramework(app, 'laravel')) return undefined;
      const base = app.path === '.' ? '' : app.path;
      for (const directory of PAGE_DIRECTORIES) for (const extension of EXTENSIONS) {
        const file = context.files.get(path.posix.join(base, directory, `${name}.${extension}`));
        if (!file) continue;
        const declared = graph.entities.get(file.id)?.metadata.defaultExport;
        const target = graph.entities.get(typeof declared === 'string' ? declared : file.id);
        if (target) return { file: file.path, target };
      }
      return undefined;
    };
    const link = (from: Entity, name: string, line: number | undefined, effect?: EffectFact) => {
      const found = page(from, name);
      if (!found) {
        graph.diagnose({ analyzer: 'inertia-linker', severity: 'warning', code: 'inertia-page-not-found', file: from.path, line, entityId: from.id, reason: `Inertia renders page '${name}', but no ${PAGE_DIRECTORIES[0]}/${name}.{${EXTENSIONS.join(',')}} is indexed in this application` });
        return;
      }
      graph.relate(from.id, found.target.id, 'renders', [evidence('framework', 'inertia-linker', from.path, line, `Inertia renders page '${name}': ${found.file}, by the conventional page resolver (resources/js/pages/<name>)`)], { page: name, forms: ['inertia'] });
      if (effect) { effect.target = found.target.id; effect.targetName = found.target.name; }
    };
    for (const entity of [...graph.entities.values()]) {
      if (entity.type === 'api_endpoint' && typeof entity.metadata.inertiaPage === 'string') link(entity, entity.metadata.inertiaPage, entity.sourceRange?.startLine);
      const effects = entity.language === 'php' && Array.isArray(entity.metadata.effects) ? entity.metadata.effects as EffectFact[] : [];
      for (const effect of effects) if (effect.category === 'response' && effect.operation === 'inertia' && effect.page) link(entity, effect.page, effect.line, effect);
    }
  },
};
