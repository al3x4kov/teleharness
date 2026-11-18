// FEAT-19.5. Dedicated OpenCode v2 instance with no tools, plugins or tenant files.
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const provider='zai-coding-plan';
const models=['glm-5.3','glm-5.3-flash'];
const agent='temporal-text';
function unavailable() {throw Object.assign(new Error('OpenCode subscription transport unavailable'),{status:503});}

export function opencodeTextAdapter({oc,workDirectory,artifactDirectory,quota}) {
  async function check({signal}={}) {
    signal?.throwIfAborted();
    if (oc?.api!=='v2' || !workDirectory || !artifactDirectory) unavailable();
    const profile=(await oc.listAgents({timeoutMs:5000,signal})).find(a=>a.id===agent);
    const rules=profile?.permissions ?? [];
    const deny=rules.findLastIndex(r=>r.action==='*' && r.resource==='*' && r.effect==='deny');
    if (deny<0 || rules.slice(deny+1).some(r=>r.effect!=='deny')) unavailable();
    const catalog=await oc.listProviders({directory:workDirectory,timeoutMs:5000,signal});
    if (!catalog.connected.includes(provider) ||
        !models.every(m=>catalog.all.find(p=>p.id===provider)?.models?.[m])) unavailable();
    if(quota) {
      const info=await quota();
      if(info?.ok && info.windows?.some(w=>['week','hours'].includes(w.kind) && w.percent>=100)) return 'quota_wait';
    }
    return 'ready';
  }
  async function execute({model,instruction,timeoutSeconds,signal:callerSignal}) {
    const id=model?.replace(/^zai-coding-plan\//,'');
    if (!models.includes(id)) unavailable();
    const timeoutMs=Math.max(1,Math.min(timeoutSeconds || 120,600))*1000;
    const timeout=AbortSignal.timeout(timeoutMs);
    const signal=callerSignal ? AbortSignal.any([callerSignal,timeout]) : timeout;
    if(await check({signal})!=='ready') return {state:'quota_wait'};
    signal.throwIfAborted();
    const options={directory:workDirectory,signal,timeoutMs};
    const session=await oc.createSession({...options,title:'Temporal',agent,model:{providerID:provider,id}});
    try {
      signal.throwIfAborted();
      await oc.prompt({...options,sessionID:session.id,parts:[{type:'text',text:instruction}]});
      for (;;) {
        const {messages}=await oc.listMessages(session.id,options);
        const reply=messages.findLast(m=>m.info.role==='assistant');
        if(reply?.info.error?.name==='provider.quota' && messages.filter(m=>m.info.role==='assistant').length===1 &&
           !reply.parts.some(p=>p.type==='tool' || (['reasoning','text'].includes(p.type) && p.text)))
          return {state:'quota_wait'};
        if(reply?.info.error) throw new Error('OpenCode model error');
        if(reply?.info.finish) {
          if(reply.info.providerID!==provider || reply.info.modelID!==id ||
            reply.info.finish!=='stop' || reply.parts.some(p=>p.type==='tool')) unavailable();
          const text=reply.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n');
          if(!text) unavailable();
          await mkdir(artifactDirectory,{recursive:true,mode:0o700});
          const receipt=randomUUID();
          await writeFile(path.join(artifactDirectory,receipt),text,{flag:'wx',mode:0o600});
          return {receipt};
        }
        await delay(400,undefined,{signal});
      }
    } finally {
      await oc.deleteSession(session.id,{directory:workDirectory,timeoutMs:10000});
    }
  }
  return {models:[...models,...models.map(id=>provider+'/'+id)],subscriptionOnly:true,textOnly:true,check,execute};
}
