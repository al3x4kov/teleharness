// FEAT-19.4 / TASK-19.8: route contracts and server-side authorization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { temporalRoutes } from "../routes/temporal.js";
import { DefinitionStore } from "../lib/temporal/definitions.js";
import { dispatchRoute } from "../routes/router.js";

const draft=()=>({name:"Review",directory:path.resolve("project"),inputs:[],steps:[{id:"wait",type:"approval",name:"Решение",dependsOn:[]}]});
function fixture(t) {
 const tmp=mkdtempSync(path.join(os.tmpdir(),"temporal-route-"));t.after(()=>rmSync(tmp,{recursive:true,force:true}));
 const deps={store:new DefinitionStore({file:path.join(tmp,"definitions.json")}),sendJson:(res,status,body)=>Object.assign(res,{status,body}),readJsonBody:async req=>req.body,dirAllowed:(_u,d)=>d===path.resolve("project"),engineAllowed:(_u,e)=>e==="opencode"};
 const table=temporalRoutes(deps);
 async function call(method,url,body,user={id:"alice",role:"tenant"}) {
  const res={};await dispatchRoute(table,{req:{method,body},res,url:new URL("http://localhost/teleharness/api/temporal"+url),user,admin:user.role==="admin"},deps);return res;
 }
 return {call,deps};
}
test("create → edit → validate → publish; owner берётся из ctx",async t=>{
 const {call}=fixture(t);const a=await call("POST","/definitions",{draft:draft()});assert.equal(a.status,201);assert.equal(a.body.owner,"alice");
 const id=a.body.id;assert.equal((await call("POST",`/definitions/${id}/validate`,{})).body.valid,true);
 const p=await call("POST",`/definitions/${id}/publish`,{revision:1});assert.equal(p.status,200);assert.equal(p.body.versions.length,1);
 assert.equal((await call("POST",`/definitions/${id}/publish`,{revision:1})).status,409);
});
test("чужой ID: get/save/publish/validate запрещены, список пустой",async t=>{
 const {call}=fixture(t);const a=await call("POST","/definitions",{draft:draft()});const bob={id:"bob",role:"tenant"};
 for(const [method,suffix] of [["GET",""],["PUT",""],["POST","/validate"],["POST","/publish"]])assert.equal((await call(method,`/definitions/${a.body.id}${suffix}`,{draft:draft(),revision:1},bob)).status,404);
 assert.deepEqual((await call("GET","/definitions",undefined,bob)).body,[]);
});
test("отозванная папка скрывает определение и запрещает публикацию",async t=>{
 const {call,deps}=fixture(t);const a=await call("POST","/definitions",{draft:draft()});deps.dirAllowed=()=>false;
 assert.deepEqual((await call("GET","/definitions")).body,[]);
 assert.equal((await call("GET",`/definitions/${a.body.id}`)).status,403);
 assert.equal((await call("POST",`/definitions/${a.body.id}/publish`,{revision:1})).status,403);
});
test("publish проверяет права на текущую ревизию после чтения body",async t=>{
 const {call,deps}=fixture(t);const a=await call("POST","/definitions",{draft:draft()});
 deps.readJsonBody=async req=>{
  const changed=draft();changed.steps=[{id:"model",type:"model",name:"Проверка",dependsOn:[],engine:"opencode",model:"project-default",instruction:"check",timeoutSeconds:60,maxAttempts:1}];
  deps.store.save("alice",a.body.id,1,changed);deps.engineAllowed=()=>false;return req.body;
 };
 assert.equal((await call("POST",`/definitions/${a.body.id}/publish`,{revision:2})).status,403);
 assert.equal(deps.store.get("alice",a.body.id).versions.length,0);
});
test("save не возвращает отозванные версии, добавленные во время чтения body",async t=>{
 const {call,deps}=fixture(t);const a=await call("POST","/definitions",{draft:draft()});
 deps.readJsonBody=async req=>{
  const changed={...draft(),directory:path.resolve("revoked-project")};
  deps.store.save("alice",a.body.id,1,changed);deps.store.publish("alice",a.body.id,2);return req.body;
 };
 assert.equal((await call("PUT",`/definitions/${a.body.id}`,{revision:3,draft:draft()})).status,403);
 assert.equal(deps.store.get("alice",a.body.id).revision,3);
});
test("FEAT-19.16 (U013 п.4): Codex в пайпах доступен тенанту даже без Codex в чатах; прочие движки проверяются заново при публикации",async t=>{
 const {call,deps}=fixture(t);const d=draft();d.steps=[{id:"model",type:"model",name:"Проверка",dependsOn:[],engine:"codex",model:"project-default",instruction:"check",timeoutSeconds:60,maxAttempts:1}];
 deps.engineAllowed=(_u,e)=>e!=="codex";assert.equal((await call("POST","/definitions",{draft:d})).status,201);
 assert.equal((await call("GET","/capabilities")).body.codexTextOnly,true);
 d.steps[0].engine="claude";const a=await call("POST","/definitions",{draft:d});assert.equal(a.status,201);
 deps.engineAllowed=()=>false;assert.equal((await call("POST",`/definitions/${a.body.id}/publish`,{revision:1})).status,403);
});
test("нет симуляции runtime; invalid JSON и ownership spoofing отклонены",async t=>{
 const {call}=fixture(t);assert.equal((await call("GET","/temporal")).status,undefined);
 const c=await call("GET","/capabilities");assert.equal(c.body.execution.available,false);assert.equal(c.body.definitions,true);
 assert.equal((await call("GET","/runs")).status,503);
 assert.equal((await call("POST","/definitions",null)).status,400);
 assert.equal((await call("POST","/definitions",{draft:{...draft(),steps:{}}})).status,400);
 assert.equal((await call("POST","/definitions",{draft:draft(),owner:"bob"})).status,400);
 const d=draft();d.directory="../escape";assert.equal((await call("POST","/definitions",{draft:d})).status,400);
});

test("старт использует опубликованный таймер и текущие права владельца", async t => {
  const {call, deps} = fixture(t);
  const requests = [];
  deps.startTimer = async request => { requests.push(request); return {workflowId:"test-run"}; };
  const timer = draft();
  timer.steps = [{id:"wait", name:"Ждать", type:"timer", seconds:1, dependsOn:[]}];
  const {body:record} = await call("POST", "/definitions", {draft:timer});
  const body = {definitionId:record.id, version:1, requestId:"11e48cdf-3352-49d3-a8d0-4156afd3655e"};
  assert.equal((await call("POST", "/runs", body)).status, 404);
  await call("POST", `/definitions/${record.id}/publish`, {revision:1});
  timer.steps[0].seconds = 60;
  await call("PUT", `/definitions/${record.id}`, {revision:2, draft:timer});
  assert.equal((await call("POST", "/runs", body, {id:"bob",role:"tenant"})).status, 404);
  assert.equal((await call("POST", "/runs", body)).status, 202);
  assert.equal(requests[0].seconds, 1);
  assert.equal(requests[0].owner, "alice");
  deps.dirAllowed = () => false;
  assert.equal((await call("POST", "/runs", body)).status, 403);
  assert.equal(requests.length, 1);
});

test("FEAT-19.14: список запусков отдаёт сводку, attention считает ждущих; чужие не видны",async t=>{
 const {call,deps}=fixture(t);
 const a=await call("POST","/definitions",{draft:draft()});await call("POST",`/definitions/${a.body.id}/publish`,{revision:1});
 const rows=[{owner:"alice",workflowId:"w1",definitionId:a.body.id,version:1,accepted:1},{owner:"alice",workflowId:"teleharness-scheduled-4ae8da84-a0f5-47c9-9151-c008247510e1-2026-11-18T09:00:00Z",definitionId:a.body.id,version:1,accepted:1}];
 deps.listRuns=async owner=>rows.filter(r=>r.owner===owner);
 deps.describeRun=async id=>id==="w1"?{workflowId:id,runId:"r",status:"RUNNING",state:{paused:false,pending:["wait"],steps:{wait:"running"}}}:{workflowId:id,runId:"r",status:"COMPLETED",state:null};
 const list=await call("GET","/runs");assert.equal(list.status,200);
 assert.equal(list.body[0].summary.kind,"wait");assert.equal(list.body[0].summary.current.name,"Решение");assert.equal(list.body[0].source,"manual");
 assert.equal(list.body[1].summary.kind,"ok");assert.equal(list.body[1].source,"schedule");
 assert.equal((await call("GET","/attention")).body.waiting,1);
 assert.deepEqual((await call("GET","/runs",undefined,{id:"bob",role:"tenant"})).body,[]);
 assert.equal((await call("GET","/attention",undefined,{id:"bob",role:"tenant"})).body.waiting,0);
});
test("FEAT-19.14: Temporal недоступен — сводка unavailable, а не «выполняется»",async t=>{
 const {call,deps}=fixture(t);
 const a=await call("POST","/definitions",{draft:draft()});await call("POST",`/definitions/${a.body.id}/publish`,{revision:1});
 deps.listRuns=async()=>[{owner:"alice",workflowId:"w9",definitionId:a.body.id,version:1,accepted:1}];
 deps.describeRun=async()=>{throw new Error("down");};
 assert.equal((await call("GET","/runs")).body[0].summary.kind,"unavailable");
});

test("BUG-251: проекты пользователя без папок пайпов; по умолчанию — последний проект пайпов; папка пайпа создаётся",async t=>{
 const {call,deps}=fixture(t);const made=[];
 deps.ensureDir=d=>made.push(d);deps.defaultProject=()=>path.resolve("project");
 deps.projectsFor=async()=>[path.resolve("project"),path.resolve("project","pipelines","x"),"relative",path.resolve("elsewhere")];
 let p=await call("GET","/projects");
 assert.deepEqual(p.body.projects.map(x=>x.directory),[path.resolve("project")]);assert.equal(p.body.default,path.resolve("project"));
 const a=await call("POST","/definitions",{draft:draft()});
 assert.equal(a.body.folder,"pipelines/review");assert.deepEqual(made,[path.resolve("project","pipelines","review")]);
 const b=await call("POST","/definitions",{draft:draft()});assert.equal(b.body.folder,"pipelines/review-2");
 assert.equal((await call("GET","/definitions/"+a.body.id)).body.folder,"pipelines/review");
});

test("BUG-259: повторная публикация без изменений отклоняется, после правки — новая версия",async t=>{
 const {call}=fixture(t);const a=await call("POST","/definitions",{draft:draft()});
 const p1=await call("POST",`/definitions/${a.body.id}/publish`,{revision:1});assert.equal(p1.body.versions.length,1);
 const p2=await call("POST",`/definitions/${a.body.id}/publish`,{revision:p1.body.revision});
 assert.equal(p2.status,409);assert.match(p2.body.error,/Изменений нет.*версия 1/);
 const d={...draft(),steps:[{...draft().steps[0],name:"Решение 2"}]};
 const sv=await call("PUT",`/definitions/${a.body.id}`,{revision:p1.body.revision,draft:d});
 const p3=await call("POST",`/definitions/${a.body.id}/publish`,{revision:sv.body.revision});assert.equal(p3.status,200);assert.equal(p3.body.versions.length,2);
 // same content in another key order is still «no changes»
 const reordered=JSON.parse(JSON.stringify(d,Object.keys(d).reverse()));
 const sv2=await call("PUT",`/definitions/${a.body.id}`,{revision:p3.body.revision,draft:{steps:d.steps,inputs:d.inputs,directory:d.directory,name:d.name}});
 assert.equal((await call("POST",`/definitions/${a.body.id}/publish`,{revision:sv2.body.revision})).status,409);
});
