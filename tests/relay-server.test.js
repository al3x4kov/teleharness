// FEAT-11.18 (шаг В): передача чата на другой движок — маршрут, привязка, отметки, лента, системный промпт.
// Run: node --test tests/relay-server.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { waitFor } from "./helpers/wait.mjs";

const ADMIN = "r".repeat(20) + "-admin-token-" + "8".repeat(24);
const TMP = mkdtempSync(path.join(tmpdir(), "zai-relay-srv-"));
const KB = path.join(TMP, "kb");
const DIR = path.join(TMP, "proj");
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const T0 = Date.now() - 120_000;
let up, srv, tenant;
const api = (p, { method = "GET", body, token = ADMIN } = {}) => fetch(srv.base + p, { method, headers: { authorization: `Bearer ${token}`, origin: srv.base, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const binding = (id, body, opts) => api(`/zai/api/session/${id}/binding?directory=${encodeURIComponent(DIR)}`, { method: "PATCH", body, ...opts });

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/provider", () => ({ json: { all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" }, "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash" } } }], connected: ["zai-coding-plan"], default: {} } }));
  up.route("POST", "/session/ses_r/prompt_async", () => ({ status: 204 }));
  up.state.sessions.push({ id: "ses_r", directory: DIR, title: "Чат для передачи", model: GLM }, { id: "ses_busy", directory: DIR, title: "занят", model: GLM });
  up.state.messages.ses_r = [
    { info: { id: "u1", role: "user", sessionID: "ses_r", time: { created: T0 } }, parts: [{ id: "p1", type: "text", text: "Начни перенос отчётов" }] },
    { info: { id: "a1", role: "assistant", sessionID: "ses_r", modelID: "glm-5.3", time: { created: T0 + 1000, completed: T0 + 5000 } }, parts: [{ id: "p2", type: "text", text: "Перенёс три из пяти." }] },
  ];
  up.state.status.ses_busy = { type: "busy" };
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_KB_ROOT: KB, ZAI_JOURNAL_DEBOUNCE_MS: "20" } });
  tenant = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "relay-user" } })).json();
  // чат в собственной папке пользователя: ему разрешён только opencode
  up.state.sessions.push({ id: "ses_t", directory: tenant.user.directories[0], title: "чат пользователя", model: GLM });
});
after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  rmSync(TMP, { recursive: true, force: true });
});

test("FEAT-11.18: обычная смена движка у чата с сообщениями по-прежнему запрещена (409)", async () => {
  const r = await binding("ses_r", { model: HAIKU });
  assert.equal(r.status, 409, await r.text());
});

test("FEAT-11.18: передача opencode → Claude: привязка меняется, отметка записана и видна в списке чатов, журнал собран", async () => {
  const r = await binding("ses_r", { relay: true, model: HAIKU, reason: "limit" });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.zai.engine, "claude");
  assert.deepEqual(body.zai.model, HAIKU);
  assert.equal(body.zai.agent, null, "агент opencode в Claude не переносится");
  assert.equal(body.zai.relays.length, 1);
  assert.deepEqual(body.relay.from, { engine: "opencode", providerID: "zai-coding-plan", modelID: "glm-5.3" });
  assert.deepEqual(body.relay.to, { engine: "claude", providerID: "anthropic", modelID: "claude-haiku-4-5" });
  assert.equal(body.relay.reason, "limit");
  const list = await (await api("/zai/api/session")).json();
  const rec = list.find((s) => s.id === "ses_r");
  assert.equal(rec.zai.engine, "claude");
  assert.equal(rec.zai.relays.length, 1, "отметка едет в записи чата — клиент рисует её в ленте");
  // журнал записан в момент передачи: новому движку есть что читать
  const jdir = path.join(KB, "journal");
  await waitFor(() => existsSync(jdir) && readdirSync(jdir).some((n) => n.endsWith("-ses_r.md")), { what: "журнал при передаче" });
  await waitFor(() => /Передача/.test(readFileSync(path.join(jdir, readdirSync(jdir).find((n) => n.endsWith("-ses_r.md"))), "utf8")), { what: "отметка передачи в журнале" });
  const j = readFileSync(path.join(jdir, readdirSync(jdir).find((n) => n.endsWith("-ses_r.md"))), "utf8");
  assert.match(j, /Перенёс три из пяти\./);
  assert.match(j, /\*\*Передача\*\* · [^\n]* glm-5\.3 → claude-haiku-4-5/);
});

test("FEAT-11.18: лента чата с передачей — история прежнего движка на месте", async () => {
  const r = await api(`/zai/api/session/ses_r/message?directory=${encodeURIComponent(DIR)}`);
  assert.equal(r.status, 200);
  const msgs = await r.json();
  assert.deepEqual(msgs.map((m) => m.info.id), ["u1", "a1"]);
});

test("FEAT-11.18: возврат Claude → opencode (другая модель); следующий ход получает строку о передаче и путь к журналу", async () => {
  const r = await binding("ses_r", { relay: true, model: FLASH });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.zai.engine, "opencode");
  assert.equal(body.zai.relays.length, 2);
  const p = await api(`/zai/api/session/ses_r/prompt?directory=${encodeURIComponent(DIR)}`, { method: "POST", body: { parts: [{ type: "text", text: "Продолжай" }], model: GLM } });
  assert.ok(p.status < 300, `prompt ${p.status} ${await p.text()}`);
  const sent = await waitFor(() => up.requests.find((q) => q.method === "POST" && q.path === "/session/ses_r/prompt_async"), { what: "ход ушёл в opencode" });
  assert.deepEqual(sent.body.model, FLASH, "модель хода — из привязки после передачи, а не из тела запроса");
  const sys = String(sent.body.system ?? "");
  assert.match(sys, /Этот чат передан тебе от другого движка или модели \(claude-haiku-4-5 → glm-5\.3-flash\)/);
  assert.match(sys, /-ses_r\.md/);
  assert.match(sys, /прочитай журнал/);
});

test("FEAT-11.18: отказы — та же модель, ход идёт, движок не разрешён пользователю, чужая папка", async () => {
  assert.equal((await binding("ses_r", { relay: true, model: FLASH })).status, 400, "та же модель");
  assert.equal((await binding("ses_busy", { relay: true, model: HAIKU })).status, 409, "ход идёт");
  const t = await api(`/zai/api/session/ses_t/binding?directory=${encodeURIComponent(tenant.user.directories[0])}`, { method: "PATCH", body: { relay: true, model: HAIKU }, token: tenant.token });
  assert.equal(t.status, 403, "пользователю без Claude передача на Claude закрыта: " + (await t.text()));
  const t2 = await api(`/zai/api/session/ses_t/binding?directory=${encodeURIComponent(tenant.user.directories[0])}`, { method: "PATCH", body: { relay: true, model: FLASH }, token: tenant.token });
  assert.equal(t2.status, 200, "на разрешённую модель своего движка — можно");
  assert.ok((await binding("ses_r", { relay: true, model: HAIKU }, { token: tenant.token })).status >= 403, "чужой чат пользователю недоступен");
  assert.equal((await binding("ses_r", { relay: true })).status, 400, "нет модели");
});

test("FEAT-11.18: удаление чата убирает его отметки передачи", async () => {
  up.route("DELETE", "/session/ses_r", () => ({ status: 200, json: true }));
  const r = await api(`/zai/api/session/ses_r?directory=${encodeURIComponent(DIR)}`, { method: "DELETE" });
  assert.ok(r.status < 300);
  const store = path.join(srv.tmp.data, "relays.json");
  await waitFor(() => !existsSync(store) || !("ses_r" in JSON.parse(readFileSync(store, "utf8"))), { what: "отметки удалены" });
});
