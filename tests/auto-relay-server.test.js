// FEAT-18.6: авто-передача при лимите на настоящем server.js — настройка пользователя
// (GET/PUT /me/auto-relay), лимит хода Claude (подставной CLI, режим LIMIT) и opencode
// (session.error подставного upstream), выбор модели, «продолжи», не чаще раза на ход,
// тенант — только свои модели.
// Run: node --test --test-concurrency=1 tests/auto-relay-server.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { waitFor } from "./helpers/wait.mjs";
import { RELAY_RESUME_TEXT } from "../shared/relay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const ADMIN = "a".repeat(20) + "-admin-token-" + "6".repeat(24);
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-autorelay-"));
const KB = path.join(TMP, "kb");
const DIR = path.join(TMP, "proj");
mkdirSync(DIR, { recursive: true });
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const LIMIT_ERR = { name: "APIError", data: { message: "429 Too Many Requests: rate limit exceeded" } };
const T0 = Date.now() - 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up, srv, tenant;

const api = (p, { method = "GET", body, token = ADMIN } = {}) =>
  fetch(srv.base + p, { method, headers: { authorization: `Bearer ${token}`, origin: srv.base, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const q = (dir) => `?directory=${encodeURIComponent(dir)}`;
const setting = (body, token) => api("/teleharness/api/me/auto-relay", { method: "PUT", body, token });
const relay = (sid, model, dir = DIR) => api(`/teleharness/api/session/${sid}/binding${q(dir)}`, { method: "PATCH", body: { relay: true, model } });
const prompt = (sid, text, { dir = DIR, token } = {}) => api(`/teleharness/api/session/${sid}/prompt${q(dir)}`, { method: "POST", body: { parts: [{ type: "text", text }] }, token });
const teleharnessOf = async (sid) => (await (await api("/teleharness/api/session")).json()).find((s) => s.id === sid)?.teleharness ?? null;
const marksOf = async (sid) => (await teleharnessOf(sid))?.relays ?? [];
const resumes = (sid) => up.requests.filter((r) => r.method === "POST" && r.path === `/session/${sid}/prompt_async` && (r.body?.parts ?? []).some((p) => p.text === RELAY_RESUME_TEXT));
const limitEvent = (sid) => up.emit({ type: "session.error", properties: { sessionID: sid, error: LIMIT_ERR } });

function chat(id, directory, history = true) {
  up.state.sessions.push({ id, directory, title: `чат ${id}`, model: GLM });
  if (history)
    up.state.messages[id] = [
      { info: { id: `${id}_u1`, role: "user", sessionID: id, time: { created: T0 } }, parts: [{ id: `${id}_p1`, type: "text", text: "Начни перенос отчётов" }] },
      { info: { id: `${id}_a1`, role: "assistant", sessionID: id, modelID: "glm-5.3", time: { created: T0 + 1000, completed: T0 + 5000 } }, parts: [{ id: `${id}_p2`, type: "text", text: "Перенёс три из пяти." }] },
    ];
}

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/provider", () => ({ json: { all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" }, "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash" } } }], connected: ["zai-coding-plan"], default: {} } }));
  // агент тенанта — в песочнице (без task и external_directory), как в chat-folder-server
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "task", pattern: "*", action: "deny" }, { permission: "external_directory", pattern: "*", action: "deny" }] }] }));
  chat("ses_off", DIR);
  chat("ses_c", DIR);
  srv = await spawnPortal({
    upstream: up.url,
    env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_KB_ROOT: KB, TELEHARNESS_JOURNAL_DEBOUNCE_MS: "20", TELEHARNESS_CLAUDE_BIN: FIXTURE, TELEHARNESS_CLAUDE_TIMEOUT_MS: "8000", TELEHARNESS_AUTO_RELAY_DELAY_MS: "50", TELEHARNESS_TENANT_AGENT: "Sandbox" },
  });
  tenant = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "relay-auto", engines: ["opencode", "claude"] } })).json();
  chat("ses_t", tenant.user.directories[0]);
  await up.waitForSubscription();
});
after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test("FEAT-18.6: настройка по умолчанию выключена; плохая форма — 400", async () => {
  const r = await api("/teleharness/api/me/auto-relay");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { on: false, order: [], max: 3 });
  assert.equal((await setting({ on: "да" })).status, 400);
  assert.equal((await setting({ on: true, order: [GLM, FLASH, HAIKU, { providerID: "x", modelID: "y" }] })).status, 400, "не больше трёх");
});

test("FEAT-18.6: выключено — ход Claude упал по лимиту, чат остаётся на Claude (плашка с кнопкой)", async () => {
  assert.equal((await relay("ses_off", HAIKU)).status, 200);
  assert.ok((await prompt("ses_off", "LIMIT")).status < 300);
  const feed = async () => (await api(`/teleharness/api/session/ses_off/message${q(DIR)}`)).json();
  await waitFor(async () => (await feed()).some((m) => m.info.role === "assistant" && m.parts.some((p) => /usage limit reached/.test(p.text ?? ""))), { label: "ответ Claude с лимитом", timeoutMs: 15_000 });
  await sleep(400);
  const marks = await marksOf("ses_off");
  assert.equal(marks.length, 1, "только ручная передача");
  assert.equal((await teleharnessOf("ses_off")).engine, "claude");
});

test("FEAT-18.6: включение сохраняется у пользователя (видно после перезахода)", async () => {
  const r = await setting({ on: true, order: [HAIKU, GLM, FLASH] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { on: true, order: [HAIKU, GLM, FLASH], max: 3 });
  assert.deepEqual(await (await api("/teleharness/api/me/auto-relay")).json(), { on: true, order: [HAIKU, GLM, FLASH], max: 3 });
});

test("FEAT-18.6: клиент не может поставить отметку «лимит, авто» сам", async () => {
  chat("ses_m", DIR);
  const r = await api(`/teleharness/api/session/ses_m/binding${q(DIR)}`, { method: "PATCH", body: { relay: true, model: FLASH, reason: "limit-auto" } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).relay.reason, undefined);
});

test("FEAT-18.6: Claude упал по лимиту → чат передан первой запасной (текущая пропущена) с отметкой и продолжает", async () => {
  assert.equal((await relay("ses_c", HAIKU)).status, 200);
  assert.ok((await prompt("ses_c", "LIMIT")).status < 300);
  const marks = await waitFor(async () => {
    const m = await marksOf("ses_c");
    return m.length === 2 ? m : null;
  }, { label: "авто-передача", timeoutMs: 15_000 });
  assert.equal(marks[1].reason, "limit-auto");
  assert.deepEqual(marks[1].from, { engine: "claude", providerID: "anthropic", modelID: "claude-haiku-4-5" });
  assert.deepEqual(marks[1].to, { engine: "opencode", providerID: "zai-coding-plan", modelID: "glm-5.3" }, "HAIKU — текущая, берётся следующая: GLM");
  const teleharness = await teleharnessOf("ses_c");
  assert.equal(teleharness.engine, "opencode");
  const sent = await waitFor(() => resumes("ses_c")[0], { label: "ход «продолжи» ушёл в opencode" });
  assert.deepEqual(sent.body.model, GLM);
});

test("FEAT-18.6: лимит и на запасной в том же цикле — второй передачи нет; ход пользователя открывает новый цикл", async () => {
  limitEvent("ses_c");
  await sleep(600);
  assert.equal((await marksOf("ses_c")).length, 2, "не чаще раза на ход");
  assert.equal((await teleharnessOf("ses_c")).engine, "opencode");
  // пользователь пишет сам — новый ход, новый цикл
  assert.ok((await prompt("ses_c", "ещё раз")).status < 300);
  limitEvent("ses_c");
  const marks = await waitFor(async () => {
    const m = await marksOf("ses_c");
    return m.length === 3 ? m : null;
  }, { label: "вторая авто-передача в новом цикле", timeoutMs: 10_000 });
  assert.equal(marks[2].reason, "limit-auto");
  assert.deepEqual(marks[2].to, { engine: "claude", providerID: "anthropic", modelID: "claude-haiku-4-5" }, "первая в порядке, не текущая");
});

test("FEAT-18.6: тенант — только свои модели; недоступная запасная → без передачи; доступная → передача", async () => {
  const tok = tenant.token;
  assert.deepEqual(await (await api("/teleharness/api/me/auto-relay", { token: tok })).json(), { on: false, order: [], max: 3 }, "у тенанта своя настройка");
  assert.equal((await setting({ on: true, order: [{ providerID: "zai-coding-plan", modelID: "glm-9" }] }, tok)).status, 403, "модели нет в каталоге");
  assert.equal((await setting({ on: true, order: [HAIKU] }, tok)).status, 200, "Claude разрешён — можно");
  // администратор забирает Claude: сохранённая запасная стала недоступна
  const p = await api(`/teleharness/api/admin/users/${tenant.user.id}`, { method: "PATCH", body: { engines: ["opencode"] } });
  assert.equal(p.status, 200, await p.text());
  assert.equal((await setting({ on: true, order: [HAIKU] }, tok)).status, 403, "Claude больше не разрешён");
  limitEvent("ses_t");
  await sleep(600);
  assert.equal((await marksOf("ses_t")).length, 0, "нет доступной запасной — плашка, без передачи; " + srv.log.split(/\n/).filter((l) => /teleharness-autorelay/.test(l)).join(" | "));
  assert.equal((await setting({ on: true, order: [FLASH] }, tok)).status, 200);
  limitEvent("ses_t");
  const marks = await waitFor(async () => {
    const m = await marksOf("ses_t");
    return m.length === 1 ? m : null;
  }, { label: "авто-передача тенанта", timeoutMs: 10_000 });
  assert.equal(marks[0].reason, "limit-auto");
  assert.deepEqual(marks[0].to.modelID, "glm-5.3-flash");
  const sent = await waitFor(() => resumes("ses_t")[0], { label: "ход «продолжи» тенанта" }).catch((err) => {
    throw new Error(`${err.message}; ${srv.log.split(/\n/).filter((l) => /teleharness-autorelay|ses_t/.test(l)).join(" | ")}`);
  });
  assert.deepEqual(sent.body.model, FLASH);
  assert.equal(sent.body.agent, "Sandbox", "ход тенанта — на его агенте");
  // настройка администратора тенанту не видна и наоборот
  assert.deepEqual((await (await api("/teleharness/api/me/auto-relay")).json()).order, [HAIKU, GLM, FLASH]);
});
