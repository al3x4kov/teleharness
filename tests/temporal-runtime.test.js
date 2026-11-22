import {test} from "node:test";
import assert from "node:assert/strict";
import {pipelineRuntime} from "../lib/temporal/runtime.js";

test("таймер ранней версии остаётся читаемым после включения полного runtime",async()=>{
 const calls=[];
 const runtime=pipelineRuntime(":memory:",{namespace:"qa",address:"unused",execute:async(_cli,args)=>{
   calls.push(args[1]);
   return {stdout:JSON.stringify({workflowExecutionInfo:{type:{name:"TeleharnessTimerStepV1"},
     execution:{runId:"timer-run"},status:"WORKFLOW_EXECUTION_STATUS_RUNNING"}})};
 }});
 assert.equal((await runtime.describeRun("timer")).status,"RUNNING");
 assert.deepEqual(calls,["describe"]);runtime.db.close();
});

test("FEAT-19.14: упавший пайп читает состояние шагов запросом (отклонение отличимо от ошибки); сбой запроса не ломает чтение",async()=>{
 const calls=[];let queryFails=false;
 const runtime=pipelineRuntime(":memory:",{namespace:"qa",address:"unused",execute:async(_cli,args)=>{
   calls.push(args[1]);
   if(args[1]==="query"){if(queryFails)throw new Error("no worker");return {stdout:JSON.stringify({queryResult:[{steps:{gate:"rejected"},pending:[],paused:false}]})};}
   return {stdout:JSON.stringify({workflowExecutionInfo:{type:{name:"TeleharnessPipelineV1"},execution:{runId:"r"},status:"WORKFLOW_EXECUTION_STATUS_FAILED"}})};
 }});
 assert.deepEqual((await runtime.describeRun("w")).state.steps,{gate:"rejected"});
 assert.deepEqual(calls,["describe","query"]);
 queryFails=true;const d=await runtime.describeRun("w");assert.equal(d.status,"FAILED");assert.equal(d.state,null);
 runtime.db.close();
});

test("FEAT-20.3 2.5: запуск хранит попытку «Починить CI» и ссылку на событие; отказ шага PR записывается и снимается",async()=>{
 const runtime=pipelineRuntime(":memory:",{namespace:"qa",address:"unused",execute:async()=>({stdout:"{}"})});
 const base={owner:"o",definitionId:"d",version:1,requestId:"11111111-1111-4111-8111-111111111111"};
 const run=await runtime.startPipeline({...base,source:"github",eventRef:"octo/hello · PR #320 · feature/upload · CI «test»",eventUrl:"https://github.com/octo/hello/pull/320",attempt:2,inputs:{repo:"octo/hello"}});
 assert.match(run.workflowId,/^[a-f0-9-]{36}$/);
 let row=runtime.lookupRun("o",run.workflowId);
 assert.equal(row.attempt,2);assert.equal(row.eventUrl,"https://github.com/octo/hello/pull/320");assert.equal(row.stepError,null,"отказа ещё не было");
 // ручной запуск — без попытки и ссылки
 const manual=await runtime.startPipeline({...base,requestId:"22222222-2222-4222-8222-222222222222"});
 const m=runtime.lookupRun("o",manual.workflowId);assert.equal(m.attempt,null);assert.equal(m.eventUrl,null);
 // отказ шага: текст, вид и коммит — обрезаны; повтор с тем же ключом не меняет запуск
 runtime.setStepError(run.workflowId,"pr",{message:"GitHub отклонил отправку: правило репозитория",code:"push_rejected",sha:"5be01d3"});
 const saved=runtime.lookupRun("o",run.workflowId).stepError;
 assert.deepEqual(JSON.parse(saved),{stepId:"pr",message:"GitHub отклонил отправку: правило репозитория",code:"push_rejected",sha:"5be01d3",at:JSON.parse(saved).at});
 assert.equal(typeof JSON.parse(saved).at,"number");
 runtime.setStepError(run.workflowId,"pr",{message:"x".repeat(1000)});
 assert.equal(JSON.parse(runtime.lookupRun("o",run.workflowId).stepError).message.length,300,"текст — до 300 символов");
 assert.equal(JSON.parse(runtime.lookupRun("o",run.workflowId).stepError).code,undefined,"без code — поле опущено");
 // шаг прошёл после повтора — запись снята
 runtime.setStepError(run.workflowId,"pr",null);
 assert.equal(runtime.lookupRun("o",run.workflowId).stepError,null);
 // список читает те же колонки
 const cols=id=>{const r=runtime.listRuns("o").find(x=>x.workflowId===id);return [r.attempt,r.eventUrl,r.stepError];};
 assert.deepEqual(cols(run.workflowId),[2,"https://github.com/octo/hello/pull/320",null]);assert.deepEqual(cols(manual.workflowId),[null,null,null]);
 runtime.db.close();
});
