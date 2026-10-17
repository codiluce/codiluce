import type { HarnessId } from './registry.js';

/** Self-contained native extensions: no Codiluce installation or SDK dependency at load time. */
export function collectorSource(provider: HarnessId, root: string, stateDirectory: string): string {
  const prelude = `// Codiluce observer v1. Generated for this repository; no tool or permission mutations.\nimport { readFile } from 'node:fs/promises';\nimport path from 'node:path';\nconst ROOT = ${JSON.stringify(root)}, STATE = ${JSON.stringify(stateDirectory)};\nconst queue = []; let sending = false;\nconst fields = ['file_path','filePath','path','paths','absolute_path','AbsolutePath','TargetFile','target_file','FilePath','directory','Path','SearchDirectory','TargetDirectory','command','cmd','command_line','CommandLine','workdir','cwd','working_directory','Cwd','pattern','query','SearchTerm','Pattern','patch','input'];\nfunction safeArgs(args) { const out = {}; if (args && typeof args === 'object') for (const key of fields) { const value = args[key]; if (typeof value === 'string') out[key] = value.slice(0,65536); else if (Array.isArray(value)) out[key] = value.filter(item => typeof item === 'string').slice(0,40); } return out; }\nfunction emit(payload) {\n  try { const body = JSON.stringify({ provider: ${JSON.stringify(provider)}, payload }); if (body.length > 240000 || queue.length >= 32) return; queue.push(body); void drain(); } catch {}\n}\nasync function drain() {\n  if (sending) return; sending = true;\n  try { while(queue.length) { const body = queue.shift(); try {\n    const endpoint = JSON.parse(await readFile(path.join(STATE,'serve.json'),'utf8'));\n    const url = new URL('/api/agents/events',endpoint.url);\n    if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password) { queue.length = 0; break; }\n    await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Codiluce-Request':'activity'},body,signal:AbortSignal.timeout(1500),redirect:'error'});\n  } catch { queue.length = 0; } } } finally { sending = false; }\n}\n`;
  if (provider === 'pi') return prelude + `
export default function codiluce(pi) {
  for (const type of ['session_start','session_shutdown','agent_start','agent_settled','tool_call','tool_result']) {
    pi.on(type, (event,ctx) => {
      try {
        const cwd = ctx.cwd, session_id = ctx.sessionManager.getSessionId();
        if (typeof cwd !== 'string' || typeof session_id !== 'string') return;
        emit({event:type,cwd,session_id,toolName:event.toolName,input:safeArgs(event.input),toolCallId:event.toolCallId,isError:event.isError === true,...(event.toolCallId?{source_event_id:type+':'+event.toolCallId}:{})});
      } catch {}
      // undefined is essential: never block a call or replace a result.
    });
  }
}
`;
  if (provider === 'opencode') return prelude + `
export const Codiluce = async ({directory,worktree,client}) => {
  const cwd = directory || worktree;
  const parents = new Map(), pending = new Map();
  const base = (event,input) => ({event,cwd,sessionID:input.sessionID,callID:input.callID,tool:input.tool,parentSessionID:parents.get(input.sessionID),...(input.callID?{source_event_id:event+':'+input.callID}:{})});
  return {
    'tool.execute.before': async (input,output) => {
      try { const args=safeArgs(output.args); const key=JSON.stringify([input.sessionID,input.callID]); pending.set(key,args); if(pending.size>128) pending.delete(pending.keys().next().value); emit({...base('tool.execute.before',input),args}); } catch {}
    },
    'tool.execute.after': async (input,output) => {
      try { const key=JSON.stringify([input.sessionID,input.callID]); const args=pending.get(key)||safeArgs(input.args); pending.delete(key); emit({...base('tool.execute.after',input),args}); } catch {}
    },
    event: async ({event}) => {
      try {
        const props=event.properties||{}, info=props.info||{};
        if(info.id && info.parentID) { parents.set(info.id,info.parentID); if(parents.size>100) parents.delete(parents.keys().next().value); }
        if(['session.created','session.status','session.idle','session.error'].includes(event.type)) emit({event:event.type,cwd,sessionID:props.sessionID||info.id,parentSessionID:parents.get(props.sessionID||info.id),title:info.title,properties:{status:props.status},error:event.type==='session.error'});
      } catch {}
    }
  };
};
`;
  if (provider === 'openclaw') return prelude + `
export default {
  id:'codiluce',name:'Codiluce activity',description:'Passive repository activity observations',
  register(api) {
    // Resolve configured agent workspaces; a global messaging agent is not assumed to belong to ROOT.
    const workspace = (ctx) => {
      if (ctx.workspaceDir || ctx.cwd) return ctx.workspaceDir || ctx.cwd;
      const agents=api.config?.agents;
      const selected=Array.isArray(agents?.list) ? agents.list.find(item=>item.id===ctx.agentId) : undefined;
      return selected?.workspace || (ctx.agentId === 'main' ? agents?.defaults?.workspace : undefined);
    };
    for (const event of ['before_tool_call','after_tool_call','session_start','session_end','agent_end']) {
      api.on(event,(data,ctx) => {
        try {
          const cwd=workspace(ctx||{}); if(!cwd) return;
          const call=data.toolCallId||ctx?.toolCallId;
          emit({event,cwd,context:{sessionId:ctx?.sessionId,sessionKey:ctx?.sessionKey,toolCallId:ctx?.toolCallId},data:{sessionId:data.sessionId,toolName:data.toolName,toolCallId:data.toolCallId,params:safeArgs(data.params),success:data.success,error:!!data.error},...(call?{source_event_id:event+':'+call}:{})});
        } catch {}
      });
    }
  }
};
`;
  throw new Error(`No native collector for ${provider}`);
}
