import assert from 'node:assert/strict';
import test from 'node:test';
import { modelBridge } from '../lib/temporal/model-bridge.js';

const workflowId='11430397-c55f-447e-a6d8-39b914a278ad';
function setup(role='tenant',engine='claude'){
  const calls=[];
  const adapter={subscriptionOnly:true, textOnly:true, models:['test'],
    execute:async request=>{calls.push(request);return {receipt:'ref-1'};}};
  return {calls, invoke:modelBridge({
    lookupStart:async()=>({owner:'a',definitionId:'d',version:3}),
    getUser:async()=>({id:'a',role}), store:{get:()=>({versions:[{version:3,definition:{directory:'/p',steps:[
      {id:'s',type:'model',engine,model:'test',instruction:'answer'}]}}]})},
    dirAllowed:()=>true,engineAllowed:()=>true, adapters:{[engine]:adapter}
  })};
}
test('FEAT-19.5 dispatches immutable instructions only after a fresh authorization',async()=>{
  const {invoke,calls}=setup();
  const request={workflowId,stepId:'s'};
  assert.deepEqual(await invoke('resolve',request),{tenant:'a',engine:'claude'});
  assert.deepEqual(await invoke('execute',request),{receipt:'ref-1'});
  assert.equal(calls[0].instruction,'answer');
  await assert.rejects(invoke('execute',{...request,owner:'admin'}));
  assert.equal(calls.length,1);
});
test('TASK-19.8 → FEAT-19.16 (U013 п.4): Codex тенанта — только текстовый адаптер, никогда ход с файлами',async()=>{
  const {invoke,calls}=setup('tenant','codex');
  await assert.rejects(invoke('execute',{workflowId,stepId:'s'})); // нет текстового адаптера → отказ до внешнего эффекта
  assert.equal(calls.length,0);
  const text=[];const files=[];
  const mk=list=>({subscriptionOnly:true,textOnly:true,models:['test'],execute:async r=>{list.push(r);return {receipt:'ref-t'};}});
  const bridge=modelBridge({lookupStart:async()=>({owner:'a',definitionId:'d',version:3}),getUser:async()=>({id:'a',role:'tenant'}),
    store:{get:()=>({versions:[{version:3,definition:{name:'P',directory:'/p',steps:[{id:'s',type:'model',engine:'codex',model:'test',instruction:'answer'}]}}]})},
    dirAllowed:()=>true,engineAllowed:(_u,e)=>e!=='codex',adapters:{codex:mk(files),codexText:mk(text)}});
  assert.deepEqual(await bridge('execute',{workflowId,stepId:'s'}),{receipt:'ref-t'});
  assert.equal(text.length,1);assert.equal(files.length,0);
});
test('FEAT-19.16: подстановки входов и ответов шагов, папка пайпа и запуска, связь с разговором', { skip: process.platform === "win32" && "Linux/macOS-only feature (POSIX paths, Unix socket, uid)" },async()=>{
  const calls=[];const chats=[];
  const bridge=modelBridge({lookupStart:async()=>({owner:'a',definitionId:'d',version:1,inputs:JSON.stringify({task:'отчёт'})}),getUser:async()=>({id:'a',role:'admin'}),
    store:{get:()=>({id:'00000000-0000-4000-8000-000000000000',slug:'ревью',versions:[{version:1,definition:{name:'Ревью',directory:'/p',steps:[{id:'draft',type:'model'},{id:'s',type:'model',name:'Проверка',engine:'claude',model:'m',instruction:'Сделай {{input.task}} по {{steps.draft}}',dependsOn:['draft']}]}}]})},
    dirAllowed:()=>true,engineAllowed:()=>true,ensureDir:()=>{},
    results:{read:async(_w,step)=>step==='draft'?'черновику':'',runFolder:(_w,make)=>'20261118-1200-abcd1234',rememberChat:(w,st,sid)=>chats.push([st,sid])},
    adapters:{claude:{subscriptionOnly:true,textOnly:true,models:['m'],execute:async r=>{calls.push(r);r.onSession('ses_1');return {receipt:'r1'};}}}});
  await bridge('execute',{workflowId,stepId:'s'});
  assert.equal(calls[0].instruction,'Сделай отчёт по черновику');
  assert.equal(calls[0].workspace,'/p/pipelines/ревью');assert.equal(calls[0].runFolder,'runs/20261118-1200-abcd1234');
  assert.equal(calls[0].title,'⇄ Ревью · Проверка');assert.deepEqual(chats,[['s','ses_1']]);
});

test('Claude dispatch refuses unreadable billing policy and extra usage',async()=>{
  const { claudeTextAdapter }=await import('../lib/temporal/claude-text.js');
  for(const data of [{},{extra_usage:{is_enabled:true}},{extra_usage:{is_enabled:false}}]) {
    const adapter=claudeTextAdapter({token:'fixture',artifactDirectory:'/tmp',
      usage:async()=>data,run:async()=>{assert.fail('No model dispatch allowed');}});
    assert.equal(await adapter.check(),'subscription_policy_unverified');
    await assert.rejects(adapter.execute({model:'haiku',instruction:'test'}));
  }
});

test('opencode refuses a profile that grants permissions after deny-all',async()=>{
  const {opencodeTextAdapter}=await import('../lib/temporal/opencode-text.js');
  const deny={action:'*',resource:'*',effect:'deny'};
  const oc={api:'v2',listAgents:async()=>[{id:'temporal-text',permissions:[deny,{...deny,action:'shell',effect:'allow'}]}]};
  const adapter=opencodeTextAdapter({oc,workDirectory:'/tmp',artifactDirectory:'/tmp'});
  await assert.rejects(adapter.check(),e=>e.status===503);
});

test('OpenCode stage policy permits only Coding Plan and denies tools',async()=>{
  const {readFile}=await import('node:fs/promises');
  const cfg=JSON.parse(await readFile(new URL('../ops/temporal/opencode-text.json',import.meta.url)));
  assert.deepEqual(cfg.policies,[{action:'provider.use',resource:'*',effect:'deny'},
    {action:'provider.use',resource:'zai-coding-plan',effect:'allow'}]);
  assert.deepEqual(cfg.agents['temporal-text'].permissions,[{action:'*',resource:'*',effect:'deny'}]);
  assert.equal(cfg.plugins,undefined);
});

test('expired dispatch does not invoke the subscription transport',async()=>{
  const {invoke,calls}=setup();
  const signal=AbortSignal.abort();
  await assert.rejects(invoke('execute',{workflowId,stepId:'s'},{signal}));
  assert.deepEqual(calls,[]);
});

test("текст инструкции подписочного CLI передаётся по stdin",async t=>{
  const {claudeTextAdapter}=await import("../lib/temporal/claude-text.js");
  const {mkdtemp,readFile,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const path=await import("node:path");
  const folder=await mkdtemp(path.join(tmpdir(),"qa-model-result-"));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const text="private fixture";
  const adapter=claudeTextAdapter({token:"fixture",artifactDirectory:folder,
    usage:async()=>({extra_usage:{is_enabled:false},five_hour:{utilization:0},seven_day:{utilization:0}}),
    run:async(_cmd,args,_options,stdin)=>{assert(!args.includes(text));assert.equal(stdin,text);return {stdout:'{"result":"ok"}'};}});
  const result=await adapter.execute({model:"haiku",instruction:text,timeoutSeconds:1});
  assert.equal(await readFile(path.join(folder,result.receipt),"utf8"),"ok");
});

test('FEAT-19.15: без источника лимитов Claude работает по подтверждению владельца; доказанные доплаты всё равно блокируют; лимит → quota_wait',async()=>{
  const { claudeTextAdapter }=await import('../lib/temporal/claude-text.js');
  const {mkdtempSync,readFileSync}=await import('node:fs');const os=(await import('node:os')).default;const path=(await import('node:path')).default;
  const dir=mkdtempSync(path.join(os.tmpdir(),'claude-art-'));
  const ok=claudeTextAdapter({token:'t',artifactDirectory:dir,attested:true,run:async()=>({stdout:JSON.stringify({is_error:false,result:'Готово'})})});
  assert.equal(await ok.check(),'ready');
  const r=await ok.execute({model:'haiku',instruction:'x'});assert.equal(readFileSync(path.join(dir,r.receipt),'utf8'),'Готово');
  const noAttest=claudeTextAdapter({token:'t',artifactDirectory:dir,run:async()=>assert.fail('no dispatch')});
  assert.equal(await noAttest.check(),'subscription_policy_unverified');
  const extra=claudeTextAdapter({token:'t',artifactDirectory:dir,attested:true,usage:async()=>({extra_usage:{is_enabled:true}}),run:async()=>assert.fail('no dispatch')});
  assert.equal(await extra.check(),'subscription_policy_unverified');
  for(const out of [{stdout:JSON.stringify({is_error:true,result:'Claude AI usage limit reached|1763470800'})},Object.assign(new Error('exit 1'),{stdout:'5-hour limit reached ∙ resets 3pm'})]){
    const lim=claudeTextAdapter({token:'t',artifactDirectory:dir,attested:true,run:async()=>{if(out instanceof Error)throw out;return out;}});
    assert.deepEqual(await lim.execute({model:'haiku',instruction:'x'}),{state:'quota_wait'});
  }
});

test('FEAT-19.16: шаг портала — условие по входу/ответу и артефакт в папке запуска',async()=>{
  const {mkdtempSync,readFileSync,existsSync}=await import('node:fs');const os=(await import('node:os')).default;const path=(await import('node:path')).default;
  const root=mkdtempSync(path.join(os.tmpdir(),'bridge-step-'));
  const steps=[{id:'check',type:'model'},{id:'c1',type:'condition',check:{source:'step',ref:'check',op:'contains',value:'ок'}},
    {id:'c2',type:'condition',check:{source:'input',ref:'branch',op:'equals',value:'main'}},{id:'save',type:'artifact',source:'check',filename:'итог.md'},{id:'m',type:'model'}];
  const bridge=modelBridge({lookupStart:async()=>({owner:'a',definitionId:'d',version:1,inputs:JSON.stringify({branch:'dev'})}),getUser:async()=>({id:'a',role:'tenant'}),
    store:{get:()=>({slug:'p',versions:[{version:1,definition:{name:'P',directory:root,steps}}]})},dirAllowed:()=>true,engineAllowed:()=>true,
    results:{read:async(_w,id)=>{if(id==='check')return 'Всё ОК';throw new Error('нет');},runFolder:()=> 'run1'},adapters:{}});
  assert.deepEqual(await bridge('step',{workflowId,stepId:'c1'}),{value:true});
  assert.deepEqual(await bridge('step',{workflowId,stepId:'c2'}),{value:false});
  const a=await bridge('step',{workflowId,stepId:'save'});
  assert.equal(a.file,path.join('runs','run1','итог.md'));assert.equal(readFileSync(path.join(root,'pipelines','p',a.file),'utf8'),'Всё ОК');
  assert.equal((await bridge('step',{workflowId,stepId:'save'})).file,path.join('runs','run1','итог (2).md'));
  await assert.rejects(bridge('step',{workflowId,stepId:'m'}));
});

test("listenModelBridge: a socket path over the OS limit fails with a clear reason instead of a silent truncation", async () => {
  const { listenModelBridge: listen, SOCKET_PATH_MAX } = await import("../lib/temporal/model-bridge.js");
  const long = "/tmp/" + "d".repeat(SOCKET_PATH_MAX) + "/worker.sock";
  await assert.rejects(listen(long, async () => ({})), (e) => /длиннее \d+ байт/.test(e.message) && e.message.includes("каталог данных"));
});
