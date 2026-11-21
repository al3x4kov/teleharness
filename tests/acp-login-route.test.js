// FEAT-20.4
import test from "node:test";
import assert from "node:assert/strict";
import { acpLoginRoute } from "../routes/acp-login.js";
import { dispatchRoute } from "../routes/router.js";

test("FEAT-20.4: маршрут Gemini требует администратора и подтверждения риска до запуска", async () => {
  let status;
  let started = false;
  const sendJson = (_, code) => { status = code; };
  const route = acpLoginRoute({sendJson, readJsonBody:async () => ({action:"start"}), login:{start(){started=true;}}});
  const ctx = {req:{method:"POST"},res:{setHeader(){}},url:new URL("http://test/teleharness/api/acp/gemini/login"),user:{id:"me"}};
  await dispatchRoute([route],{...ctx,admin:false},{sendJson});
  assert.equal(status,403);
  await dispatchRoute([route],{...ctx,admin:true},{sendJson});
  assert.equal(status,400);
  assert.equal(started,false);
});

test("FEAT-20.4: маршрут antigravity принимает адрес страницы вместо кода", async () => {
  let status;
  let payload;
  const sendJson = (_, code, body) => { status=code; payload=body; };
  const login = {
    start(owner, opts) { return {status:"starting", opts}; },
    async submit(owner, id, url) { return {status:"verifying", id, url}; }
  };
  const ctx = {req:{method:"POST"},res:{setHeader(){}},url:new URL("http://test/teleharness/api/acp/antigravity/login"),user:{id:"me"}};
  // Подтверждённый старт, в том числе запасной путь по ключу Gemini API.
  let route = acpLoginRoute({sendJson, readJsonBody:async () => ({action:"start",confirmed:true,method:"api-key",key:"AIzaSyTEST_key-1234567890"}), login, agent:"antigravity"});
  await dispatchRoute([route],{...ctx,admin:true},{sendJson});
  assert.equal(status,200);
  assert.deepEqual(payload.opts,{method:"api-key",key:"AIzaSyTEST_key-1234567890"});
  // Старт без подтверждения не запускает процесс.
  route = acpLoginRoute({sendJson, readJsonBody:async () => ({action:"start"}), login, agent:"antigravity"});
  await dispatchRoute([route],{...ctx,admin:true},{sendJson});
  assert.equal(status,400);
  // Submit передаёт адрес страницы после входа.
  route = acpLoginRoute({sendJson, readJsonBody:async () => ({action:"submit",id:"att-1",url:"http://127.0.0.1:9/?code=4%2Fx&state=s"}), login, agent:"antigravity"});
  await dispatchRoute([route],{...ctx,admin:true},{sendJson});
  assert.equal(status,200);
  assert.deepEqual(payload,{status:"verifying",id:"att-1",url:"http://127.0.0.1:9/?code=4%2Fx&state=s"});
  // Плохая вставка — понятная ошибка без деталей.
  route = acpLoginRoute({sendJson, readJsonBody:async () => ({action:"submit",id:"att-1",url:"не адрес"}), login:{
    ...login, async submit(){ throw new Error("Вставьте адрес страницы после входа"); }
  }, agent:"antigravity"});
  await dispatchRoute([route],{...ctx,admin:true},{sendJson});
  assert.equal(status,400);
  assert.deepEqual(payload,{error:"Вставьте адрес страницы после входа"});
  // Невалидный ключ Gemini API отклоняется до запуска процесса.
  route = acpLoginRoute({sendJson, readJsonBody:async () => ({action:"start",confirmed:true,method:"api-key",key:"short"}), login:{
    start(){ throw Object.assign(new Error("Проверьте ключ Gemini API"),{status:400}); }
  }, agent:"antigravity"});
  await dispatchRoute([route],{...ctx,admin:true},{sendJson});
  assert.equal(status,400);
  assert.deepEqual(payload,{error:"Проверьте ключ Gemini API"});
});
