import type { Analyzer, AnalysisContext } from '../../core/analyzer.js';
import { declarationHashes, evidence, type Entity } from '../../core/graph.js';
import { featureOutcomes, type FileAnalysis } from '../facts.js';
import { PhpSources } from '../php/sources.js';
import { PHP_PARSER_VERSION, PHP_SOURCE_PROFILE, PHP_STRUCTURE_VERSION } from '../php/version.js';

export const phpStructureAnalyzer: Analyzer = {
  name: 'php-structure', version: PHP_STRUCTURE_VERSION,
  analyze:context=>analyzeOriginalPhp(context,false),
};
export const phpLaravelStructureAnalyzer:Analyzer = {
  name:'php-laravel-structure',version:PHP_STRUCTURE_VERSION,
  analyze:context=>analyzeOriginalPhp(context,true),
};
async function analyzeOriginalPhp(context:AnalysisContext,laravel:boolean):Promise<void> {
    const analyzer=laravel?'php-laravel-structure':'php-structure';
    const sources = context.phpSources ??= new PhpSources(context);
    await sources.prepared();
    const legacyByFile=new Map<string,Entity[]>();
    if(laravel)for(const entity of context.graph.entities.values())if(entity.path&&entity.evidence.some(proof=>proof.analyzer==='php-laravel')){
      const entries=legacyByFile.get(entity.path)??[];entries.push(entity);legacyByFile.set(entity.path,entries);
    }
    try {
      for (const file of [...context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
        if (file.language !== 'php' || !file.analyzable || !!file.application?.frameworks.includes('laravel')!==laravel) continue;
        const fileEntity = context.graph.entities.get(file.id)!;
        const analysis: FileAnalysis = { version: 1, adapter: laravel?'php':'php-original-structure', adapterVersion: PHP_STRUCTURE_VERSION, parser: { name: 'php-parser', version: PHP_PARSER_VERSION }, features: featureOutcomes('unsupported', 'Original PHP source structure; semantic services report their own outcomes') };
        if(laravel)for(const feature of ['imports','references','framework','effects','guards']as const)analysis.features[feature]={status:feature==='guards'?'supported':'partial',reason:'Existing Laravel semantic service; original PHP binding reports a separate source profile'};
        fileEntity.metadata.analysis = analysis;
        fileEntity.metadata.phpSourceProfile = PHP_SOURCE_PROFILE;
        try {
          const { content, facts, ast, astGap } = await sources.read(file);
          if (!facts.php) throw Error('PHP provider returned no original-source facts');
          if(laravel&&!ast)for(const feature of ['imports','references','framework','effects','guards']as const)analysis.features[feature]={status:'failed',reason:astGap??'Qualified original PHP tree is unavailable'};
          const ids = new Map<string,string>(), occurrences = new Map<string,number>();
          const legacy=legacyByFile.get(file.path)??[];
          const reused=new Set<string>();
          for (const declaration of facts.declarations) {
            const identity = [file.application?.name ?? '', file.path, declaration.qualifiedName, declaration.kind, declaration.signature];
            const base = JSON.stringify(identity), ordinal = occurrences.get(base) ?? 0;
            occurrences.set(base, ordinal + 1);
            const existing=laravel?legacy.find(entity=>!reused.has(entity.id)&&entity.metadata.qualifiedName===declaration.qualifiedName&&entity.sourceRange?.endLine===declaration.range.endLine&&entity.sourceRange.endColumn===declaration.range.endColumn):undefined;
            if(existing){ids.set(declaration.key,existing.id);reused.add(existing.id);}else ids.set(declaration.key, context.graph.id('symbol', 'php-original', ...identity, ...ordinal ? [`declaration:${ordinal + 1}`] : []));
          }
          // Anonymous source regions have lexical identities, never qualified
          // PHP names. Preorder places an outer region before its descendants.
          const regions = facts.php.regions.filter(region => region.callable);
          const anonymousOccurrences = new Map<string,number>();
          for (const region of regions) {
            const callable = region.callable!;
            if (callable.binding) { ids.set(callable.key, ids.get(callable.binding)!); continue; }
            const parent = callable.parent ? ids.get(callable.parent) ?? file.id : file.id;
            const identity = [file.application?.name ?? '', file.path, parent, region.kind, callable.signature];
            const base = JSON.stringify(identity), ordinal = anonymousOccurrences.get(base) ?? 0;
            anonymousOccurrences.set(base, ordinal + 1);
            ids.set(callable.key, context.graph.id('symbol', 'php-anonymous-source', ...identity, String(ordinal + 1)));
          }
          const details = new Map(facts.php.declarations.map(declaration => [declaration.key, declaration]));
          for (const declaration of facts.declarations) {
            if(reused.has(ids.get(declaration.key)!)) {
              const existing=context.graph.entities.get(ids.get(declaration.key)!)!;
              Object.assign(existing.metadata,{originalSignature:declaration.signature,declarationKind:declaration.kind,declarationForm:declaration.declarationForm,modifiers:declaration.modifiers,sourceConditions:declaration.sourceConditions??[],phpDeclaration:details.get(declaration.key),executionUnverified:true});continue;
            }
            context.graph.contain({ id: ids.get(declaration.key)!, type: declaration.entityType, name: declaration.name, path: file.path, language: 'php', parentId: declaration.parent ? ids.get(declaration.parent) ?? file.id : file.id, sourceRange: declaration.range, metrics: { loc: declaration.range.endLine - declaration.range.startLine + 1 }, metadata: { qualifiedName: declaration.qualifiedName, declarationKind: declaration.kind, role: declaration.kind, signature: declaration.signature, declarationForm: declaration.declarationForm, visibility: declaration.visibility, modifiers: declaration.modifiers, static: declaration.modifiers?.includes('static') ?? false, sourceConditions: declaration.sourceConditions ?? [], phpDeclaration: details.get(declaration.key), executionUnverified: true, ...declarationHashes(content.slice(declaration.start, declaration.end), declaration.nameEnd - declaration.start) }, evidence: [{ ...evidence('php', analyzer, file.path, declaration.range.startLine, `Original PHP ${declaration.kind} source declaration; no autoloading, rendering or execution is inferred`), analyzerVersion: PHP_STRUCTURE_VERSION, endLine: declaration.range.endLine }] });
          }
          for (const region of regions) {
            const callable = region.callable!;
            if (callable.binding) continue;
            context.graph.contain({ id: ids.get(callable.key)!, type: 'function', name: callable.keyword, path: file.path, language: 'php', parentId: callable.parent ? ids.get(callable.parent) ?? file.id : file.id, sourceRange: region.range, metrics: { loc: region.range.endLine - region.range.startLine + 1 }, metadata: { anonymous: true, declarationKind: region.kind, role: region.kind, signature: callable.signature, declarationForm: 'definition', modifiers: callable.modifiers, static: callable.modifiers.includes('static'), sourceConditions: region.conditions, phpCallable: callable, executionUnverified: true, ...declarationHashes(content.slice(region.start, region.end), 0) }, evidence: [{ ...evidence('php', analyzer, file.path, region.range.startLine, `Original PHP anonymous ${region.kind} region; label is its source keyword, not a named PHP symbol. Invocation and runtime capture remain unverified`), analyzerVersion: PHP_STRUCTURE_VERSION, endLine: region.range.endLine }] });
          }
          fileEntity.metadata.phpSyntax = facts.php;
          context.syntax ??= new Map(); context.syntax.set(file.path, { facts, declarations: ids });
          analysis.features.structure = { status: facts.issues.length ? 'partial' : 'supported', ...facts.issues.length ? { reason: `${facts.issues.length} source extraction finding(s); independently parsed declarations retained` } : {} };
          for (const issue of facts.issues) if(!laravel)context.graph.diagnose({ analyzer, severity: 'warning', code: issue.code, file: file.path, entityId: file.id, line: issue.range?.startLine, reason: issue.reason });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          analysis.features.structure = { status: 'failed', reason };
          if(laravel)for(const feature of ['imports','references','framework','effects','guards']as const)analysis.features[feature]={status:'failed',reason};
          context.graph.diagnose({ analyzer, severity: 'warning', code: 'php-structure-failed', file: file.path, entityId: file.id, reason });
        }
      }
    } finally { sources.closeParser(); }
}
