// FEAT-19.5 / TASK-19.8. Private worker entry point, never a public portal route.
import http from 'node:http';
import { stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { renderTemplate, templateRefs } from '../../shared/temporal-template.js';
import { slugOf } from './definitions.js';
import { workspaceOf, runFolderName } from './workspace.js';
import { evaluateCheck, artifactTarget } from './portal-step.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const workflowIdPattern=/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|teleharness-scheduled-[a-f0-9-]{36}-[0-9T:.Z-]{20,40})$/;

function deny(status) { throw Object.assign(new Error('model bridge rejected request'), {status}); }

export function modelBridge({lookupStart,getUser,store,dirAllowed,engineAllowed,adapters,results,ensureDir,prStep,commandStep,stepOutcome}) {
  return async function invoke(action, request, {signal}={}) {
    signal?.throwIfAborted();
    const keys=Object.keys(request??{}).sort().join(',');
    if (!['resolve','execute','step'].includes(action) || !request ||
      !['stepId,workflowId','approved,stepId,workflowId'].includes(keys) ||
      typeof request.workflowId !== 'string' ||
      !workflowIdPattern.test(request.workflowId) ||
      typeof request.stepId !== 'string' || request.stepId.length > 128) deny(400);
    const row=await lookupStart(request.workflowId);
    if (!row) deny(404);
    const user=await getUser(row.owner);
    if (!user || user.id!==row.owner || user.disabled) deny(403);
    const record=store.get(user.id,row.definitionId,{deleted:true}); // BUG-264 п.6: a started run finishes on its version
    const definition=record?.versions.find(v=>v.version===row.version)?.definition;
    const step=definition?.steps.find(s=>s.id===request.stepId);
    if (action==='step') {
      if (keys==='approved,stepId,workflowId' && (step?.type!=='pull_request' || typeof request.approved!=='boolean')) deny(400);
      if (!step || !['condition','artifact','pull_request','command'].includes(step.type)) deny(404);
      if (!dirAllowed(user,definition.directory)) deny(403);
      let inputs={};try{inputs=JSON.parse(row.inputs||'{}')??{};}catch{}
      const answer=async id=>{try{return await results.read(request.workflowId,id);}catch{return null;}};
      if (step.type==='command') {
        if (!commandStep) deny(503);
        const outcome=async error=>{try{await stepOutcome?.({workflowId:request.workflowId,stepId:step.id,error});}catch{}};
        const reply=await commandStep.runStep({
          user, workflowId:request.workflowId, stepId:step.id, definition, step, inputs, signal,
        });
        if (reply?.state==='done') await outcome(null);
        else if (reply?.state==='failed') await outcome({message:reply.error,code:'command_failed'});
        return reply;
      }
      if (step.type==='pull_request') {
        if (!prStep) deny(503);
        const ctx={
          user, workflowId:request.workflowId, stepId: step.id,
          project:definition.directory, workspace:workspaceOf(definition.directory,slugOf(record)),
          pipeName:definition.name, pipeSlug:slugOf(record), inputs,
          description: step.source ? await answer(step.source) : null,
          branch: step.branch ?? null, base: step.base ?? null, title: step.title ?? null,
          mode: step.mode==='same-branch' ? 'same-branch' : 'new',
          approved: request.approved===true,
          sourceEngine: definition.steps.find(s=>s.id===step.source)?.engine ?? null,
          signal,
        };
        const outcome=async(error)=>{if(!stepOutcome)return;try{await stepOutcome({workflowId:request.workflowId,stepId:step.id,error});}catch{}};
        try {
          const out=await prStep(ctx);
          await outcome(null);
          return out;
        } catch(error) {
          await outcome({message:error?.message,code:error?.code,sha:error?.sha});
          throw error;
        }
      }
      if (step.type==='condition') {
        const c=step.check;
        const subject=c.source==='input' ? inputs[c.ref] : await answer(c.ref);
        const value=subject===null||subject===undefined ? false : evaluateCheck(c,subject);
        return {value};
      }
      const text=await answer(step.source);
      if (text===null) return {value:false,missing:true};
      const workspace=workspaceOf(definition.directory,slugOf(record));
      const folder=results?.runFolder?.(request.workflowId,()=>runFolderName(request.workflowId)) ?? runFolderName(request.workflowId);
      const dir=path.join(workspace,'runs',folder);
      await mkdir(dir,{recursive:true});
      const target=artifactTarget(dir,step.filename,existsSync);
      await writeFile(target,text,{flag:'wx'});
      return {value:true,file:path.relative(workspace,target)};
    }
    if (!step || step.type!=='model') deny(404);
    // FEAT-19.16 (U013 п.4): Codex for everyone in pipes; a tenant's Codex answers
    // with text only (no tenant isolation for Codex tools — FEAT-18.7).
    const tenantCodex=step.engine==='codex' && user.role!=='admin';
    if (!dirAllowed(user,definition.directory) || (!tenantCodex && !engineAllowed(user,step.engine))) deny(403);
    const adapter=tenantCodex ? adapters?.codexText : adapters?.[step.engine];
    if (!['claude','opencode','codex','acp'].includes(step.engine) || adapter?.subscriptionOnly!==true ||
      adapter.textOnly!==true || !adapter.models.includes(step.model)) deny(503);
    if (action==='resolve') {
      const state=await adapter.check?.({signal});
      return {tenant:user.id,engine:step.engine,...(state==='quota_wait' || state==='subscription_policy_unverified' ? {state:'quota_wait',reason:state} : {})};
    }
    signal?.throwIfAborted();
    // FEAT-19.16: {{input.*}} / {{steps.*}}, the pipe folder and this run's folder.
    let inputs={};try{inputs=JSON.parse(row.inputs||'{}')??{};}catch{}
    const answers={};
    for(const ref of templateRefs(step.instruction)) if(ref.kind==='steps' && results && !(ref.name in answers)) {
      try{answers[ref.name]=await results.read(request.workflowId,ref.name);}catch{answers[ref.name]='';}
    }
    const baseInstruction=renderTemplate(step.instruction,{inputs,steps:answers});
    const workspace=workspaceOf(definition.directory,slugOf(record));
    const folder=results?.runFolder?.(request.workflowId,()=>runFolderName(request.workflowId)) ?? runFolderName(request.workflowId);
    const runFolder=path.join('runs',folder);
    try{ensureDir?.(path.join(workspace,runFolder));}catch{}
    let reworkNote='';
    try{reworkNote=(await readFile(path.join(workspace,runFolder,`rework-${step.id}.md`),'utf8')).trim();}catch{}
    const instruction=reworkNote?`${baseInstruction}\n\n---\nЗамечания с ревью (доработка):\n${reworkNote}`:baseInstruction;
    const result=await adapter.execute({signal,user,directory:definition.directory,workspace,runFolder,workflowId:request.workflowId,
      stepId:step.id,model:step.model,instruction,timeoutSeconds:step.timeoutSeconds,
      // FEAT-20.7: шаг в рабочей копии запуска (Codex-шаг тенанта текстовый — без копии)
      worktree:step.worktree===true && !tenantCodex,pipeName:definition.name,
      title:'⇄ '+definition.name+' · '+(step.name||step.id),
      onSession:sid=>results?.rememberChat?.(request.workflowId,step.id,sid)});
    if (result?.state==='quota_wait') return {state:'quota_wait'};
    if (typeof result?.receipt!=='string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(result.receipt)) deny(502);
    return {receipt:result.receipt};
  };
}

// sun_path holds 104 bytes on macOS/BSD and 108 on Linux, NUL included; a longer path is truncated silently.
export const SOCKET_PATH_MAX=/darwin|bsd/.test(process.platform) ? 103 : 107;

export async function listenModelBridge(socketPath,invoke,prepareRun) {
  if (Buffer.byteLength(String(socketPath))>SOCKET_PATH_MAX)
    throw Error(`Путь к сокету исполнителя длиннее ${SOCKET_PATH_MAX} байт (${socketPath}) — задайте более короткий каталог данных`);
  const dir=await stat(path.dirname(socketPath));
  if (!path.isAbsolute(socketPath) || dir.uid!==process.getuid() || (dir.mode & 0o077)) deny(403);
  const server=http.createServer(async(req,res)=>{
    let size=0;
    try {
      if(req.method!=='POST' || !['/resolve','/execute','/prepare','/publish','/step'].includes(req.url)) deny(404);
      const chunks=[];
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>1024) deny(413);
        chunks.push(chunk);
      }
      const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.url==='/prepare' && !prepareRun) deny(503);
      let signal;
      if(req.url!=='/prepare') {
        const deadline=Number(req.headers['x-teleharness-deadline-ms']);
        const remaining=deadline-Date.now();
        if(!Number.isSafeInteger(deadline) || remaining<=0) deny(408);
        const disconnected=new AbortController();
        res.once('close',()=>disconnected.abort());
        const maxMs=req.url==='/step' ? 86400000 : 3600000;
        signal=AbortSignal.any([disconnected.signal,AbortSignal.timeout(Math.min(remaining,maxMs))]);
      }
      const result=req.url==='/prepare' ? await prepareRun(request) : await invoke(req.url.slice(1),request,{signal});
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
    } catch(error) {
      const status=Number.isInteger(error.status) && error.status>=400 && error.status<=599 ? error.status : 500;
      const message=String(error?.message??'').slice(0,300)||'model bridge rejected request';
      res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({error:message}));
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  try {await chmod(socketPath,0o600);} catch(error) {server.close();throw error;}
  return server;
}
