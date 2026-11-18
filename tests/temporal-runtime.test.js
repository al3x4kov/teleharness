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
