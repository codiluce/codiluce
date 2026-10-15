import path from 'node:path';
import type { Analyzer } from '../core/analyzer.js';
import { evidence } from '../core/graph.js';

/** Configured entry points work even when a language has no runtime adapter.
 * Only an exact source path and an unambiguous indexed callable can bind.
 * Missing/unsupported source produces a visible entry with a handler gap. */
export const configuredFlowEntries: Analyzer = {
  name:'configured-flow-entries',version:'1',
  async analyze(context) {
    for (const app of context.config.applications) for (const configured of app.flowEntries ?? []) {
      const relative=path.posix.join(app.path === '.' ? '' : app.path,configured.path);
      const existing=[...context.graph.entities.values()].some(entity=>entity.type === 'user_flow' && entity.path === relative && entity.metadata.registration === 'configured' && (entity.name === configured.name || configured.selector && entity.name.startsWith(`${configured.name} `)));
      if (existing) continue;
      const candidates=[...context.graph.entities.values()].filter(entity=>entity.path === relative && ['function','method','component'].includes(entity.type) && (entity.metadata.qualifiedName === configured.symbol || entity.name === configured.symbol));
      const handler=candidates.length === 1 ? candidates[0] : undefined;
      const gap=!handler ? `Configured source symbol ${configured.symbol} is missing, unavailable or ambiguous` : configured.selector ? 'This source adapter did not resolve the configured selector; the whole function remains a lower bound' : undefined;
      const fact=evidence('framework','configured-flow-entries',context.files.has(relative) ? relative : undefined,handler?.sourceRange?.startLine,'Explicit configuration selects this source entry; the trigger is a recorded assumption');
      const id=context.graph.id('configured-flow',app.name,relative,configured.name);
      context.graph.contain({id,type:'user_flow',name:configured.name,path:relative,parentId:context.applicationIds.get(app.name)!,...(handler?.sourceRange ? {sourceRange:handler.sourceRange}:{}),metadata:{flowKind:configured.kind ?? 'function',registration:'configured',...(gap ? {flowGaps:[{line:handler?.sourceRange?.startLine ?? 1,text:gap}]}:{})},evidence:[fact]});
      if (handler) context.graph.relate(id,handler.id,'handles',[fact]);
      if (gap) context.graph.diagnose({analyzer:'configured-flow-entries',severity:'warning',code:'unresolved-flow-entry',entityId:id,file:relative,reason:gap});
    }
  },
};
