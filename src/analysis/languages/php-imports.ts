import type { Analyzer } from '../../core/analyzer.js';
import { evidence } from '../../core/graph.js';
import { fileAnalysis, type ImportOutcome } from '../facts.js';
import { PhpResolver, PHP_RESOLVER_VERSION } from '../resolution/php.js';

export const phpImportsAnalyzer:Analyzer = {
  name:'php-imports',version:PHP_RESOLVER_VERSION,
  async analyze(context) {
    const files=[...context.files.values()].filter(file=>file.language==='php'&&file.analyzable&&!file.application?.frameworks.includes('laravel')).sort((a,b)=>a.path.localeCompare(b.path,'en'));
    if(!files.length)return;
    const resolver=new PhpResolver(context);resolver.prepare(files);
    const repository=context.graph.entities.get(context.repositoryId)!;
    repository.metadata.phpProjects=resolver.describe();
    for(const file of files) {
      const entity=context.graph.entities.get(file.id)!,analysis=fileAnalysis(entity.metadata.analysis);
      if(!analysis)continue;
      const facts=resolver.facts(file.path);
      entity.metadata.importResolver={adapter:'php',version:PHP_RESOLVER_VERSION,project:resolver.owner(file.path).id,executionUnverified:true};
      if(!facts){analysis.features.imports={status:'failed',reason:'Bounded original PHP syntax facts are unavailable'};continue;}
      const outcomes:unknown[]=[],external:string[]=[];
      const record=(metadata:Record<string,unknown>,outcome:ImportOutcome,line?:number)=>{
        const proof=[{...evidence('php','php-imports',file.path,line,'Original PHP import/load source dependency; runtime activation is unverified'),analyzerVersion:PHP_RESOLVER_VERSION},...'proof'in outcome?outcome.proof:[]];
        const serialized='proof'in outcome?{...outcome,proof}:outcome;
        const details={adapter:'php',version:1,executionUnverified:true,...metadata,...outcome.status==='resolved'?{targetConditions:Object.fromEntries(outcome.targets.map(id=>[id,context.graph.entities.get(id)?.metadata.sourceConditions??[]]))}:{}};
        outcomes.push({...details,outcome:serialized});
        if(outcome.status==='resolved')for(const target of outcome.targets)context.graph.relate(file.id,target,'imports',proof,details,JSON.stringify([metadata.kind,metadata.specifier,metadata.scope,metadata.range,metadata.manifest]));
        else if(outcome.status==='external')external.push(outcome.dependency);
        else context.graph.diagnose({analyzer:'php-imports',severity:'warning',code:`php-import-${outcome.status}`,file:file.path,entityId:file.id,line,reason:outcome.reason});
      };
      for(const imported of facts.imports)record({kind:`use-${imported.kind}`,specifier:imported.specifier,alias:imported.alias,namespace:imported.namespace,scope:imported.scope,range:imported.range,conditions:imported.conditions},resolver.resolve(file.path,imported),imported.range.startLine);
      for(const {site,outcome} of resolver.loads(file.path))record({kind:site.kind,specifier:site.expression,scope:site.scope,range:site.range,conditions:site.conditions},outcome,site.range.startLine);
      for(const load of resolver.composerFiles(file.path))record({kind:'composer-files',specifier:load.specifier,manifest:load.manifest,dev:load.dev,conditions:['Original Composer loader activation and dependency ordering are unverified']},load.outcome);
      for(const change of facts.loaderChanges)context.graph.diagnose({analyzer:'php-imports',severity:'warning',code:'php-loader-change-gap',file:file.path,entityId:file.id,line:change.range.startLine,reason:`Original ${change.name} call may change the runtime lookup/loader state; it is not executed`});
      entity.metadata.importOutcomes=outcomes;entity.metadata.externalImports=[...new Set(external)].sort();
      analysis.features.imports={status:'partial',reason:'Indexed Composer PSR-4/PSR-0/classmap/files and original literal-load/namespace source contracts; namespace use does not execute a loader. Runtime plugins, dynamic loads, namespace-only aliases and scoped references require further profiles'};
    }
  },
};
