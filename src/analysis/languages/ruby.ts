import type { AnalysisContext, Analyzer } from '../../core/analyzer.js';
import { ANALYZER_VERSION, evidence } from '../../core/graph.js';
import { fileKey } from '../../pipeline/cache.js';
import { fileAnalysis } from '../facts.js';
import { RubyResolver, RUBY_RESOLVER_VERSION } from '../resolution/ruby.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { RubySymbols, RUBY_SYMBOL_VERSION } from './ruby-symbols.js';
import { RubyAutoloadCatalog, RUBY_AUTOLOAD_VERSION } from '../resolution/ruby-autoload.js';
import { RUBY_PROFILE_VERSION } from './ruby-profile.js';
import { RailsRegistrations, RAILS_VERSION } from '../frameworks/rails.js';

export const RUBY_IMPORT_VERSION = `${ANALYZER_VERSION}:ruby-imports:4`;
export const rubyAnalyzer: Analyzer = {
  name: 'ruby-imports', version: RUBY_IMPORT_VERSION,
  async analyze(context): Promise<void> {
    const files = [...context.files.values()].filter(file => file.language === 'ruby' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (!files.length) return;
    const resolver = context.ruby = new RubyResolver(context), repository = context.graph.entities.get(context.repositoryId)!;
    resolver.prepare(files);
    const autoload = context.rubyAutoload = new RubyAutoloadCatalog(context, resolver);
    const symbols = context.rubySymbols = new RubySymbols(context, resolver, autoload); symbols.prepare(files);
    repository.metadata.projects = [...Array.isArray(repository.metadata.projects) ? repository.metadata.projects : [], ...resolver.describe()];
    repository.metadata.rubyAutoloadProfiles = autoload.describe();
    const run = async () => {
      for (const file of files) {
        const entity = context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis); if (!analysis) continue;
        const facts = resolver.facts(file.path);
        if (!facts) { analysis.features.imports = { status: 'failed', reason: 'Ruby syntax facts are unavailable' }; continue; }
        entity.metadata.importResolver = { adapter: 'ruby', version: RUBY_IMPORT_VERSION, project: resolver.owner(file.path)?.id };
        const outcomes: unknown[] = [], external: string[] = [];
        for (const load of symbols.fileLoads(file.path)) {
          const { outcome, site } = load;
          const proof = [{ ...evidence('syntax', 'ruby-imports', file.path, site.range.startLine, `Ruby ${load.kind} source dependency`), analyzerVersion: RUBY_IMPORT_VERSION, endLine: site.range.endLine }, ...('proof' in outcome ? outcome.proof : [])];
          const scopes = resolver.ancestors(file.path, site.scope), owner = scopes.find(scope => scope.owner)?.owner;
          const metadata = { adapter: 'ruby', version: 1, kind: load.kind, specifier: load.specifier, range: site.range, ...(load.constant ? { constant: load.constant, lazy: true } : {}), wrapped: load.wrapped, conditions: load.conditions, ...(owner ? { scopeId: context.syntax?.get(file.path)?.declarations.get(owner) } : {}) };
          const serialized = outcome.status === 'resolved' ? { status: outcome.status, targets: [outcome.target.id], proof, conditions: [...outcome.conditions, ...load.conditions] } : 'proof' in outcome ? { ...outcome, proof, conditions: [...outcome.conditions, ...load.conditions] } : outcome;
          outcomes.push({ ...metadata, outcome: serialized });
          if (outcome.status === 'resolved') context.graph.relate(file.id, outcome.target.id, 'imports', proof, metadata, JSON.stringify([load.kind, load.specifier, load.constant ?? '', metadata.scopeId ?? '', load.conditions, load.wrapped]));
          else if (outcome.status === 'external') external.push(outcome.dependency);
          else context.graph.diagnose({ analyzer: 'ruby-imports', severity: 'warning', code: `ruby-import-${outcome.status}`, file: file.path, entityId: file.id, line: site.range.startLine, reason: outcome.reason });
        }
        for (const gap of facts.gaps) context.graph.diagnose({ analyzer: 'ruby-imports', severity: 'warning', code: `ruby-${gap.kind}-gap`, file: file.path, entityId: file.id, line: gap.range.startLine, reason: gap.reason });
        entity.metadata.importOutcomes = outcomes; entity.metadata.externalImports = [...new Set(external)].sort();
        analysis.features.imports = { status: 'partial', reason: 'Literal Ruby loads and lazy activation, recorded load-path/cwd inputs and version-qualified autoload contracts; executable gem activation, dynamic runtime loading and loader hooks require further profiles' };
      }
      new RailsRegistrations(context, symbols, autoload).run();
      symbols.analyze(files);
      autoload.annotate();
    };
    if (context.cache) await context.cache.unit(context, this.name, 'repository', { version: RUBY_IMPORT_VERSION, symbols: RUBY_SYMBOL_VERSION, rails: RAILS_VERSION, autoload: RUBY_AUTOLOAD_VERSION, profiles: RUBY_PROFILE_VERSION, autoloadInputs: autoload.describe(), syntax: STRUCTURE_VERSION, resolver: RUBY_RESOLVER_VERSION, config: context.config, projects: resolver.describe(), files: [...context.files.values()].filter(file => file.language === 'ruby' || file.path.endsWith('/Gemfile.lock') || file.path === 'Gemfile.lock').map(file => fileKey(context, file.path)), paths: [...context.files.values()].map(file => [file.path, file.language, file.analyzable]), observedFiles: [...context.fileInventory ?? []].sort(), availability: files.map(file => [file.path, resolver.facts(file.path)?.complete]), directories: [...context.directoryInventory ?? []].sort() }, run);
    else await run();
  },
};
