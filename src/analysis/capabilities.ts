import type { Analyzer } from '../core/analyzer.js';
import { ANALYZER_VERSION } from '../core/graph.js';
import { hasFramework } from '../core/config.js';
import { CODE_LANGUAGES } from '../core/languages.js';
import { featureOutcomes, fileAnalysis, type FileAnalysis } from './facts.js';
import ts from 'typescript';
import { createRequire } from 'node:module';
const phpVersion: string = createRequire(import.meta.url)('php-parser/package.json').version;
const typescriptVersion = ts.version;

/** Record actual file outcomes, including the existing analyzers. No new
 * language enters call coverage solely because it has a structural parser. */
export const capabilitiesAnalyzer: Analyzer = {
  name: 'analysis-capabilities', version: ANALYZER_VERSION,
  async analyze(context): Promise<void> {
    const diagnostics = new Map<string, string[]>();
    for (const diagnostic of context.graph.diagnostics.values()) if (diagnostic.file) {
      const list = diagnostics.get(diagnostic.file) ?? []; list.push(diagnostic.code); diagnostics.set(diagnostic.file, list);
    }
    for (const file of context.files.values()) {
      if (!CODE_LANGUAGES.has(file.language ?? '')) continue;
      const entity = context.graph.entities.get(file.id)!;
      if (fileAnalysis(entity.metadata.analysis)) continue;
      const analysis: FileAnalysis = { version: 1, adapter: 'recognition-only', adapterVersion: ANALYZER_VERSION, features: featureOutcomes('unsupported', 'No language analysis adapter is active') };
      if (!file.analyzable) analysis.features = featureOutcomes('disabled', String(entity.metadata.analysisSkipped ?? 'File content is unavailable'));
      else {
        const isTs = ['typescript', 'javascript'].includes(file.language ?? '') && !!context.typescript?.projectFor(file.path);
        const php = file.language === 'php' && hasFramework(file.application, 'laravel');
        if (isTs || php) {
          analysis.adapter = isTs ? 'typescript' : 'php';
          analysis.parser = { name: isTs ? 'typescript' : 'php-parser', version: isTs ? typescriptVersion : phpVersion };
          if (isTs && /\.d\.[cm]?ts$/.test(file.path)) {
            analysis.features = featureOutcomes('disabled', 'Used for type information; runtime declarations and behavior are not extracted');
            entity.metadata.analysis = analysis;
            continue;
          }
          const errors = diagnostics.get(file.path) ?? [];
          const failed = errors.some(code => /(?:typescript|php)-parse-error|indexed-source-unavailable/.test(code));
          analysis.features.structure = { status: failed ? 'failed' : 'supported', ...(failed ? { reason: 'Source parsing or indexed source access failed' } : {}) };
          for (const feature of ['imports', 'references', 'effects'] as const) analysis.features[feature] = { status: failed ? 'failed' : 'partial', reason: failed ? 'Source parsing or indexed source access failed' : 'Static binding supports a documented subset; dynamic dispatch can remain unresolved' };
          analysis.features.guards = { status: failed ? 'failed' : 'supported' };
          if (hasFramework(file.application, isTs ? 'nextjs' : 'laravel') || Array.isArray(entity.metadata.frameworkPacks) && entity.metadata.frameworkPacks.length) analysis.features.framework = { status: failed ? 'failed' : 'partial', reason: 'Static framework conventions and registrations; unsupported forms produce diagnostics' };
        } else if (['typescript', 'javascript', 'php'].includes(file.language ?? '')) analysis.features = featureOutcomes('disabled', 'The existing semantic analyzer requires a compatible application context');
      }
      entity.metadata.analysis = analysis;
    }
  },
};
