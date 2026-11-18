// FEAT-19.14: GET /temporal/runs returns a per-run summary (status, current
// step, waiting decision) so the list never needs «Проверить состояние».
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRun, runSummaryCache } from "../lib/temporal/run-summary.js";

const steps=[{id:"wait",name:"Подготовка",type:"timer"},{id:"gate",name:"Одобрение",type:"approval"},{id:"pub",name:"Публикация",type:"timer"}];
const d=(status,state)=>({workflowId:"w",runId:"r",status,state,startTime:"2026-11-18T09:31:00Z"});

test("ждёт решения: kind wait, текущий шаг — одобрение, 2 из 3",()=>{
  const s=summarizeRun(d("RUNNING",{paused:false,pending:["gate"],steps:{wait:"completed",gate:"running",pub:"waiting"}}),steps);
  assert.equal(s.kind,"wait");assert.equal(s.current.name,"Одобрение");assert.equal(s.current.index,2);assert.equal(s.stepsTotal,3);assert.equal(s.waiting,true);
});
test("квота, пауза, идёт",()=>{
  assert.equal(summarizeRun(d("RUNNING",{paused:false,pending:[],steps:{wait:"quota_wait"}}),steps).kind,"quota");
  assert.equal(summarizeRun(d("RUNNING",{paused:true,pending:["gate"],steps:{wait:"completed",gate:"running"}}),steps).kind,"paused");
  assert.equal(summarizeRun(d("RUNNING",{paused:false,pending:[],steps:{wait:"running"}}),steps).kind,"run");
});
test("конечные статусы",()=>{
  for(const [st,k] of [["COMPLETED","ok"],["FAILED","err"],["TIMED_OUT","err"],["CANCELED","cancel"],["TERMINATED","term"]])
    assert.equal(summarizeRun(d(st,null),steps).kind,k);
  const rejected=summarizeRun(d("FAILED",{steps:{wait:"completed",gate:"rejected"}}),steps);
  assert.equal(rejected.kind,"rejected");
});
test("недоступное состояние не превращается в «идёт»",()=>{
  assert.equal(summarizeRun(null,steps).kind,"unavailable");
});
test("кэш: завершённый запуск не перечитывается, идущий — после ttl; ошибка — unavailable",async()=>{
  let calls=0,t=0;const describe=async id=>{calls++;if(id==="bad")throw new Error("x");return d(id==="done"?"COMPLETED":"RUNNING",{steps:{}});};
  const c=runSummaryCache(describe,{ttlMs:3000,now:()=>t});
  await c.describe("done");await c.describe("done");assert.equal(calls,1);
  await c.describe("live");t=1000;await c.describe("live");assert.equal(calls,2);t=5000;await c.describe("live");assert.equal(calls,3);
  assert.equal(await c.describe("bad"),null);
});
