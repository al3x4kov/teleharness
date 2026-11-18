// @suite server
// FEAT-19.4 / TASK-19.8: real auth middleware + persistence + tenant isolation.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawnPortal} from "./helpers/spawn-server.mjs";
import {startFakeOpencode} from "./helpers/fake-opencode.mjs";
const ADMIN="temporal-test-admin-"+"a".repeat(40);
let up,srv,alice,bob;
function api(route,{token=ADMIN,method="GET",body,headers={}}={}) {
 return fetch(srv.base+route,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
before(async()=>{
 up=await startFakeOpencode();srv=await spawnPortal({upstream:up.url,env:{TELEHARNESS_ADMIN_TOKEN:ADMIN}});
 alice=await(await api("/teleharness/api/admin/users",{method:"POST",body:{name:"temporal-alice"}})).json();
 bob=await(await api("/teleharness/api/admin/users",{method:"POST",body:{name:"temporal-bob"}})).json();
});
after(async()=>{await srv?.stop();await up?.close();});
const base="/teleharness/api/temporal";
test("реальный сервер: auth, owner, CAS, immutable versions, CSRF",async()=>{
 const anonymous=await fetch(srv.base+base+"/definitions");assert.equal(anonymous.status,401);
 const draft={name:"Проверка",directory:alice.user.directories[0],inputs:[],steps:[{id:"wait",name:"Решение",type:"approval",dependsOn:[]}]};
 const created=await api(base+"/definitions",{token:alice.token,method:"POST",body:{draft}});
 assert.equal(created.status,201,await created.clone().text());const record=await created.json();
 for(const token of [bob.token,ADMIN]) {
  assert.equal((await api(base+"/definitions/"+record.id,{token})).status,404);
  assert.deepEqual(await(await api(base+"/definitions",{token})).json(),[]);
 }
 assert.equal((await api(base+"/definitions",{token:bob.token,method:"POST",body:{draft}})).status,403);
 const published=await api(base+`/definitions/${record.id}/publish`,{token:alice.token,method:"POST",body:{revision:1}});
 assert.equal(published.status,200);assert.equal((await published.json()).versions[0].definition.name,"Проверка");
 const conflict=await api(base+`/definitions/${record.id}`,{token:alice.token,method:"PUT",body:{revision:1,draft:{...draft,name:"Lost"}}});assert.equal(conflict.status,409);
 const edited=await api(base+`/definitions/${record.id}`,{token:alice.token,method:"PUT",body:{revision:2,draft:{...draft,name:"Новый"}}});assert.equal(edited.status,200);
 assert.equal((await edited.json()).versions[0].definition.name,"Проверка");
 const csrf=await api(base+"/definitions",{token:alice.token,method:"POST",body:{draft},headers:{origin:"https://foreign.invalid"}});assert.equal(csrf.status,403);
 const capabilities=await(await api(base+"/capabilities",{token:alice.token})).json();assert.equal(capabilities.execution.available,false);assert(capabilities.engines.includes("codex"));assert.equal(capabilities.codexTextOnly,true); // FEAT-19.16 U013 п.4
 assert.equal((await api(base+"/runs",{token:alice.token})).status,503);
});

test("выпуск немодельных пайпов не включает модели из окружения портала",async()=>{
 const isolated=await spawnPortal({upstream:up.url,env:{TELEHARNESS_ENV:"prod",TELEHARNESS_ADMIN_TOKEN:ADMIN,
   TELEHARNESS_TEMPORAL_PIPELINES:"1",CLAUDE_CODE_OAUTH_TOKEN:"sample-for-capability-test"}});
 try {
   const response=await fetch(isolated.base+base+"/capabilities",{headers:{authorization:"Bearer "+ADMIN}});
   assert.equal(response.status,200);
   const caps=await response.json();
   assert.equal(caps.pipelineAvailable,true);
   assert.deepEqual(caps.subscriptionModels,{});
 } finally {await isolated.stop();}
});
