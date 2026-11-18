// FEAT-19.7 — расписание закрепляет версию, права и политики.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleService, scheduleOptions } from '../lib/temporal/schedules.js';
import { scheduleRoutes } from '../routes/temporal-schedules.js';
import { DefinitionError } from '../lib/temporal/definitions.js';
import { dispatchRoute } from '../routes/router.js';

const params={definitionId:'d',version:1,cron:'0 9 * * 1-5',timezone:'Europe/Moscow',overlap:'buffer-one',catchupSeconds:120};
test('разрешён cron из пяти полей, IANA timezone и явные политики',()=>{
  assert.equal(scheduleOptions(params).timezone,'Europe/Moscow');
  for(const bad of [{timezone:'Fake/Zone'},{cron:'TZ=UTC 0 0 * * *'},{cron:'60 1 * * *'},{overlap:'terminate-other'},{catchupSeconds:0},{owner:'other'},{version:0},{requestId:['4ae8da84-a0f5-47c9-9151-c008247510e1']},{overlap:['skip']}])assert.throws(()=>scheduleOptions({...params,...bad}),{status:400});
});
test('создание сохраняет ссылку до запуска и повторяет тот же запрос безопасно',async()=>{
  const calls=[]; let paused=false; let service;
  const execute=async (_cli,args)=>{
    calls.push(args);
    if(args[1]==='create'){
      const input=JSON.parse(args[args.indexOf('--input')+1]);
      const id=input.launchRef.split('/')[1];
      assert.equal(service.get('alice',id).version,1);
      assert.equal(args[args.indexOf('--workflow-id')+1],'teleharness-scheduled-'+id);
      assert.equal(args[args.indexOf('--time-zone')+1],params.timezone);
      assert.equal(args[args.indexOf('--overlap-policy')+1],'BufferOne');
      assert.equal(args[args.indexOf('--catchup-window')+1],'120s');
    }
    if(args[1]==='toggle' && args.includes('--pause'))paused=true;
    if(args[1]==='toggle' && args.includes('--unpause'))paused=false;
    return {stdout:JSON.stringify({schedule:{state:{paused}},info:{futureActionTimes:['2026-12-01T06:00:00Z']}})};
  };
  service=scheduleService(':memory:',{execute});
  const request={...params,requestId:'4ae8da84-a0f5-47c9-9151-c008247510e1'};
  const first=await service.create('alice',request);
  assert.equal((await service.create('alice',request)).id,first.id);
  assert.equal(calls.filter(c=>c[1]==='create').length,1);
  await assert.rejects(service.create('alice',{...request,version:2}),{status:409});
  assert.throws(()=>service.get('bob',first.id),{status:404});
  assert.equal((await service.setPaused('alice',first.id,true)).paused,true);
  assert.equal((await service.setPaused('alice',first.id,false)).paused,false);
  assert.equal((await service.describe(service.get('alice',first.id))).nextTimes[0],'2026-12-01T06:00:00Z');
});
test('маршруты перепроверяют права текущего владельца перед созданием и возобновлением',async()=>{
  let allowed=true; const entry={...params,id:'4ae8da84-a0f5-47c9-9151-c008247510e1'};
  const deps={schedules:{create:async()=>entry,get:()=>entry,list:()=>[entry],describe:async x=>x,setPaused:async()=>entry},
    store:{get:()=>({versions:[{version:1,definition:{name:'Отчёт',directory:'/work',inputs:[],steps:[{type:'model',engine:'claude'}]}}]})},
    dirAllowed:()=>true,engineAllowed:()=>allowed,readJsonBody:r=>r.body,sendJson:(res,status,body)=>Object.assign(res,{status,body})};
  async function call(method,suffix='',body=params){
    const res={};await dispatchRoute(scheduleRoutes(deps),{req:{method,body},res,url:new URL('http://localhost/teleharness/api/temporal/schedules'+suffix),user:{id:'alice',role:'tenant'}},deps);return res;
  }
  assert.equal((await call('POST')).status,201);
  assert.equal((await call('GET')).body[0].name,'Отчёт');
  deps.draining=true;
  assert.equal((await call('POST','/'+entry.id+'/resume',{})).status,503);
  assert.equal((await call('POST','/'+entry.id+'/pause',{})).status,200);
  assert.equal((await call('GET')).body.length,1);
  deps.draining=false;
  const initial=deps.store.get;
  deps.store.get=()=>({versions:[{version:1,definition:{directory:'/work',inputs:[],steps:[{type:'condition'}]}}]});
  assert.equal((await call('POST')).status,422);
  deps.store.get=initial;
  deps.validatePipeline=()=>{throw new DefinitionError(422,'Подписка недоступна');};
  assert.equal((await call('POST')).status,422);
  allowed=false;
  assert.equal((await call('POST')).status,403);
  assert.equal((await call('POST','/'+entry.id+'/resume',{})).status,403);
  // FEAT-19.14: lost access is shown (firings are skipped), not silently hidden.
  const blocked=(await call('GET')).body;
  assert.equal(blocked.length,1);assert.match(blocked[0].blocked,/срабатывания пропускаются/);assert.equal(blocked[0].name,'Отчёт');
  deps.store.get=()=>{throw new DefinitionError(404,'нет');};
  assert.deepEqual((await call('GET')).body,[]);
});
