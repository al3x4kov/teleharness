// FEAT-19.4 / TASK-19.8 — durable definitions, not an execution engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefinitionStore } from "../lib/temporal/definitions.js";
import { validateDefinition } from "../shared/temporal-definition.js";

export const draft = () => ({ name: "Проверка изменений", directory: "D:/projects/review", inputs: [{name:"task",type:"string",required:true}], steps: [
  {id:"review",type:"model",name:"Проверить",dependsOn:[],engine:"opencode",model:"project-default",instruction:"Проверь задачу",timeoutSeconds:600,maxAttempts:2},
  {id:"approval",type:"approval",name:"Решение",dependsOn:["review"]},
] });
function fixture(t, extra={}) { const dir=mkdtempSync(path.join(os.tmpdir(),"temporal-def-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,"definitions.json");return {file,store:new DefinitionStore({file,...extra})}; }
test("сохранение, публикация и перезапуск сохраняют неизменяемую версию",t=>{
 const {store,file}=fixture(t);const a=store.create("owner",draft());const p=store.publish("owner",a.id,a.revision);
 const changed={...draft(),name:"Новая редакция"};const b=store.save("owner",a.id,p.revision,changed);
 assert.equal(b.versions[0].definition.name,"Проверка изменений");assert.equal(b.draft.name,"Новая редакция");
 const restarted=new DefinitionStore({file});assert.deepEqual(restarted.get("owner",a.id),b);
 b.versions[0].definition.name="tamper";assert.equal(restarted.get("owner",a.id).versions[0].definition.name,"Проверка изменений");
});
test("чужой owner не читает и не меняет определение по прямому ID",t=>{
 const {store}=fixture(t);const a=store.create("alice",draft());assert.deepEqual(store.list("bob"),[]);
 for(const fn of [()=>store.get("bob",a.id),()=>store.save("bob",a.id,1,draft()),()=>store.publish("bob",a.id,1)])assert.throws(fn,{status:404});
 assert.throws(()=>store.get("alice","../../escape"),{status:404});
});
test("CAS: старый редактор и повтор publish не создают лишнюю версию",t=>{
 const {store}=fixture(t);const a=store.create("owner",draft());const p=store.publish("owner",a.id,a.revision);
 assert.throws(()=>store.publish("owner",a.id,a.revision),{status:409});assert.throws(()=>store.save("owner",a.id,a.revision,draft()),{status:409});
 assert.equal(store.get("owner",a.id).versions.length,1);assert.equal(p.revision,2);
});
test("draft можно сохранить незаконченным, публикация проверяет граф",t=>{
 const {store}=fixture(t);const d=draft();d.steps[0].dependsOn=["approval"];
 const a=store.create("owner",d);assert.throws(()=>store.publish("owner",a.id,1),{status:400});assert.equal(store.get("owner",a.id).versions.length,0);
});
test("повреждённый store не превращается в пустой и не перезаписывается",t=>{
 const {store,file}=fixture(t);writeFileSync(file,'{"broken"');
 assert.throws(()=>store.list("owner"),{status:503});assert.throws(()=>store.create("owner",draft()),{status:503});assert.equal(readFileSync(file,"utf8"),'{"broken"');
});
test("ошибка атомарной записи не сообщает об успехе",t=>{
 const {store}=fixture(t,{write:()=>false});assert.throws(()=>store.create("owner",draft()),{status:503});assert.deepEqual(store.list("owner"),[]);
});
test("malformed draft отклоняется, структурное повреждение диска — 503",t=>{
 const {store,file}=fixture(t);
 for(const patch of [{inputs:[null]},{steps:[null]},{steps:[{id:"x",type:"approval",name:"x"}]},{steps:{}}])assert.throws(()=>store.create("owner",{...draft(),...patch}),{status:400});
 const a=store.create("owner",draft());const state=JSON.parse(readFileSync(file,"utf8"));state.items[0].draft={};writeFileSync(file,JSON.stringify(state));
 assert.throws(()=>store.get("owner",a.id),{status:503});
});
test("схема: валидный DAG, duplicate ID, self-edge, отсутствующая зависимость, модель",()=>{
 assert.equal(validateDefinition(draft()).valid,true);
 for(const mutate of [d=>d.steps[1].id="review",d=>d.steps[0].dependsOn=["review"],d=>d.steps[1].dependsOn=["missing"],d=>d.steps[0].engine="shell",d=>d.steps[0].maxAttempts=0,d=>d.steps[0].timeoutSeconds=Infinity]){
 const d=draft();mutate(d);assert.equal(validateDefinition(d).valid,false);
 }
});
test("mapping читает только предков; условная ветвь требует fallback",()=>{
 const d=draft();d.steps[1].mapping={context:{step:"review"}};assert.equal(validateDefinition(d).valid,true);
 d.steps[0].mapping={context:{step:"approval"}};assert.equal(validateDefinition(d).valid,false);delete d.steps[0].mapping;
 d.steps[0].when={input:"task",equals:"yes"};assert.equal(validateDefinition(d).valid,false);
 d.steps[1].mapping.context.fallback="";assert.equal(validateDefinition(d).valid,true);
});
test("ограничения размера и входов; зарезервированные ключи запрещены",()=>{
 for(const mutate of [d=>d.name="x".repeat(161),d=>d.steps=[],d=>d.inputs.push({...d.inputs[0]}),d=>d.inputs[0].name="__proto__",d=>d.steps[0].instruction="x".repeat(16001)]){
 const d=draft();mutate(d);assert.equal(validateDefinition(d).valid,false);
 }
});
test("BUG-264 п.6: удаление — надгробие: пропадает из списка и правки, версии читаются для истории, слаг занят, переживает перезапуск",async t=>{
 const {store,file}=fixture(t);const a=store.create("owner",draft());store.publish("owner",a.id,a.revision);
 const r=store.remove("owner",a.id);assert.equal(r.deleted,true);assert.equal(r.name,"Проверка изменений");
 assert.deepEqual(store.list("owner"),[]);
 assert.throws(()=>store.get("owner",a.id),{status:404});assert.throws(()=>store.remove("owner",a.id),{status:404});
 assert.throws(()=>store.save("owner",a.id,3,draft()),{status:404});assert.throws(()=>store.publish("owner",a.id,3),{status:404});
 assert.throws(()=>store.get("other",a.id,{deleted:true}),{status:404});
 const restarted=new DefinitionStore({file});const tomb=restarted.get("owner",a.id,{deleted:true});
 assert.ok(tomb.deletedAt);assert.equal(tomb.versions[0].definition.name,"Проверка изменений");
 assert.notEqual(restarted.create("owner",draft()).slug,tomb.slug,"папка запусков старого пайпа не переходит новому");
 // запуск, принятый до удаления, готовится по своей версии; расписание удалённого пайпа не срабатывает
 const {prepareRun}=await import("../lib/temporal/prepare-bridge.js");const {DatabaseSync}=await import("node:sqlite");
 const db=new DatabaseSync(":memory:");const wf="0b35f10a-c900-4c74-b290-88eb93bf3cfa",sid="1b35f10a-c900-4c74-b290-88eb93bf3cfa";
 db.exec("CREATE TABLE starts(owner,request_id,definition_id,version,workflow_id UNIQUE,accepted,PRIMARY KEY(owner,request_id)); CREATE TABLE temporal_schedule_refs(id,owner,definition_id,version,accepted)");
 db.prepare("INSERT INTO starts VALUES(?,?,?,?,?,1)").run("owner","k",a.id,1,wf);db.prepare("INSERT INTO temporal_schedule_refs VALUES(?,?,?,?,1)").run(sid,"owner",a.id,1);
 const deps={db,store:restarted,getUser:id=>({id}),dirAllowed:()=>true,engineAllowed:()=>true};
 assert.equal((await prepareRun(deps,{launchRef:wf,workflowId:wf,runId:wf})).steps.length,2);
 await assert.rejects(prepareRun(deps,{launchRef:"schedule/"+sid,workflowId:"teleharness-scheduled-"+sid+"-2026-11-19T09:00:00Z",runId:wf}),{status:404});
});

test("шаг command — валидация с каталогом, ссылки {{input.*}}/{{steps.*}}, condition/artifact, projectPlan и prepareRun", async t => {
 const { projectPlan, prepareRun } = await import("../lib/temporal/prepare-bridge.js");
 const { DatabaseSync } = await import("node:sqlite");
 const catalog = new Map([
  ["run-report", {
   id: "run-report",
   kind: "exec",
   params: [
    { name: "date", required: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    { name: "note", required: false },
   ],
   allow: { roles: ["admin"], users: [] },
  }],
 ]);
 const def = {
  name: "Отчёт по команде",
  directory: "/tmp/proj",
  inputs: [{ name: "date", type: "string", required: true }],
  steps: [
   { id: "collect", type: "command", name: "Собрать", dependsOn: [], command: "run-report", args: { date: "{{input.date}}" }, timeoutSeconds: 600, maxAttempts: 2, successWhen: "exit0" },
   { id: "check", type: "condition", name: "Проверить", dependsOn: ["collect"], check: { source: "step", ref: "collect", op: "contains", value: "OK" } },
   { id: "save", type: "artifact", name: "Сохранить", dependsOn: ["check"], source: "collect", filename: "report.md" },
  ],
 };
 assert.equal(validateDefinition(def, { catalog }).valid, true);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], command: "missing-cmd" }] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], args: {} }] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], args: { date: "2026-11-25", extra: "x" } }] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], args: { date: "{{input.nope}}" } }] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], args: { date: "{{steps.save}}" } }, def.steps[1], def.steps[2]] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], timeoutSeconds: 0 }] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], maxAttempts: 11 }] }, { catalog }).valid, false);
 assert.equal(validateDefinition({ ...def, steps: [{ ...def.steps[0], successWhen: "never" }] }, { catalog }).valid, false);
 const plan = projectPlan(def);
 assert.deepEqual(plan.steps[0], { id: "collect", type: "command", dependsOn: [], timeoutSeconds: 600, maxAttempts: 2 });
 assert.equal("command" in plan.steps[0], false);
 assert.equal("args" in plan.steps[0], false);
 const { store } = fixture(t);
 const rec = store.create("admin-1", def);
 store.publish("admin-1", rec.id, rec.revision, { catalog });
 const recT = store.create("alice", def);
 store.publish("alice", recT.id, recT.revision, { catalog });
 const db = new DatabaseSync(":memory:");
 t.after(() => db.close());
 const wfAdmin = "0b35f10a-c900-4c74-b290-88eb93bf3cf1";
 const wfTenant = "0b35f10a-c900-4c74-b290-88eb93bf3cf2";
 db.exec("CREATE TABLE starts(owner,request_id,definition_id,version,workflow_id UNIQUE,accepted,PRIMARY KEY(owner,request_id));");
 db.prepare("INSERT INTO starts VALUES(?,?,?,?,?,1)").run("admin-1", "k1", rec.id, 1, wfAdmin);
 db.prepare("INSERT INTO starts VALUES(?,?,?,?,?,1)").run("alice", "k2", recT.id, 1, wfTenant);
 const okPlan = await prepareRun({ db, store, getUser: () => ({ id: "admin-1", role: "admin" }), dirAllowed: () => true, engineAllowed: () => true, commandCatalog: catalog }, { launchRef: wfAdmin, workflowId: wfAdmin, runId: wfAdmin });
 assert.equal(okPlan.steps[0].type, "command");
 await assert.rejects(prepareRun({ db, store, getUser: () => ({ id: "alice", role: "user" }), dirAllowed: () => true, engineAllowed: () => true, commandCatalog: catalog }, { launchRef: wfTenant, workflowId: wfTenant, runId: wfTenant }), { status: 403 });
});
