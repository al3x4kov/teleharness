// BUG-232: после передачи чата движок получает ходы, которых у него нет, прямо в запросе —
// скрытой частью, один раз. Настоящий server.js, подставной opencode и подставной Claude CLI
// (на «ECHO» отвечает полученным запросом — видно, что именно дошло до модели).
// Run: node --test tests/relay-catchup-server.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { waitFor } from "./helpers/wait.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const ADMIN = "c".repeat(20) + "-admin-token-" + "7".repeat(24);
const TMP = mkdtempSync(path.join(tmpdir(), "zai-relay-cu-"));
const KB = path.join(TMP, "kb");
const DIR = path.join(TMP, "proj");
mkdirSync(DIR, { recursive: true });
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const SID = "ses_cu";
const T0 = Date.now() - 120_000;
const MARK = "Передача чата: ходы, сделанные в другом движке";
const q = `?directory=${encodeURIComponent(DIR)}`;
let up, srv;
const api = (p, { method = "GET", body } = {}) => fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, origin: srv.base, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const relay = (model) => api(`/zai/api/session/${SID}/binding${q}`, { method: "PATCH", body: { relay: true, model } });
const prompt = (text) => api(`/zai/api/session/${SID}/prompt${q}`, { method: "POST", body: { parts: [{ type: "text", text }] } });
const feed = async () => (await api(`/zai/api/session/${SID}/message${q}`)).json();
// ответ подставного Claude на «ECHO …» — JSON с полученным запросом
const claudeGot = async (needle) => {
  const m = await waitFor(async () => (await feed()).find((x) => x.info.role === "assistant" && x.parts.some((p) => p.type === "text" && p.text.includes('"prompt"') && p.text.includes(needle))), { what: `ответ Claude на «${needle}»`, timeout: 15_000 });
  return JSON.parse(m.parts.find((p) => p.type === "text" && p.text.includes('"prompt"')).text.replace(/\(resumed\)/g, "").trim()).prompt;
};

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/provider", () => ({ json: { all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } }], connected: ["zai-coding-plan"], default: {} } }));
  up.route("POST", `/session/${SID}/prompt_async`, () => ({ status: 204 }));
  up.state.sessions.push({ id: SID, directory: DIR, title: "Чат туда и обратно", model: GLM });
  up.state.messages[SID] = [
    { info: { id: "u1", role: "user", sessionID: SID, time: { created: T0 } }, parts: [{ id: "p1", type: "text", text: "Начни перенос отчётов" }] },
    { info: { id: "a1", role: "assistant", sessionID: SID, modelID: "glm-5.3", time: { created: T0 + 1000, completed: T0 + 5000 } }, parts: [{ id: "p2", type: "text", text: "Перенёс три из пяти." }] },
  ];
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_KB_ROOT: KB, ZAI_JOURNAL_DEBOUNCE_MS: "20", ZAI_CLAUDE_BIN: FIXTURE, ZAI_CLAUDE_TIMEOUT_MS: "8000" } });
});
after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test("BUG-232: первая передача opencode → Claude — Claude получает ходы opencode в запросе; в ленте вставки нет", async () => {
  assert.equal((await relay(HAIKU)).status, 200);
  assert.ok((await prompt("ECHO первый")).status < 300);
  const got = await claudeGot("ECHO первый");
  assert.ok(got.includes(MARK), "вложение дошло до модели");
  assert.match(got, /Пользователь: Начни перенос отчётов/);
  assert.match(got, /Агент \(glm-5\.3\): Перенёс три из пяти\./);
  assert.match(got, /Полная история чата — в журнале: .*-ses_cu\.md/);
  const mine = (await feed()).find((m) => m.info.role === "user" && m.parts.some((p) => p.text === "ECHO первый"));
  assert.ok(mine.parts.filter((p) => p.type === "text" && !p.synthetic).every((p) => !p.text.includes(MARK)), "в видимом тексте запроса вставки нет");
});

test("BUG-232: следующий запрос тому же движку — вложения уже нет (разово)", async () => {
  assert.ok((await prompt("ECHO второй")).status < 300);
  const got = await claudeGot("ECHO второй");
  assert.ok(!got.includes(MARK), "повторно не вкладывается: " + got.slice(0, 300));
});

test("BUG-232: Claude → opencode — opencode получает ходы Claude скрытой частью, не больше одной", async () => {
  await waitFor(async () => (await api("/zai/api/status")).json().then((s) => !(SID in (s ?? {}))), { what: "ход Claude закончился" });
  assert.equal((await relay(GLM)).status, 200);
  assert.ok((await prompt("Продолжай")).status < 300);
  const sent = await waitFor(() => up.requests.find((r) => r.method === "POST" && r.path === `/session/${SID}/prompt_async`), { what: "ход ушёл в opencode" });
  const hidden = sent.body.parts.filter((p) => p.type === "text" && p.synthetic === true && p.text.includes(MARK));
  assert.equal(hidden.length, 1, JSON.stringify(sent.body.parts).slice(0, 400));
  assert.match(hidden[0].text, /Пользователь: ECHO первый/);
  assert.match(hidden[0].text, /Пользователь: ECHO второй/);
  assert.match(hidden[0].text, /Агент \(claude-haiku-4-5\): /);
  assert.doesNotMatch(hidden[0].text, /Начни перенос отчётов\n/, "свои собственные ходы движку не пересказываются");
  assert.equal(sent.body.parts[0].text, "Продолжай");
});

test("BUG-232: возврат opencode → Claude — в запросе только пропущенный промежуток; сценарий «второе сообщение» отвечаем", async () => {
  // ход, сделанный в opencode, пока Claude чат не вёл
  const now = Date.now();
  up.state.messages[SID].push(
    { info: { id: "u2", role: "user", sessionID: SID, time: { created: now } }, parts: [{ id: "p3", type: "text", text: "Назови кодовое слово" }] },
    { info: { id: "a2", role: "assistant", sessionID: SID, modelID: "glm-5.3", time: { created: now + 500, completed: now + 900 } }, parts: [{ id: "p4", type: "text", text: "ОПАЛ" }] },
  );
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await relay(HAIKU)).status, 200);
  assert.ok((await prompt("ECHO третий: что я просил в прошлом сообщении?")).status < 300);
  const got = await claudeGot("ECHO третий");
  assert.ok(got.includes(MARK));
  assert.match(got, /Пользователь: Назови кодовое слово/);
  assert.match(got, /Агент \(glm-5\.3\): ОПАЛ/);
  assert.doesNotMatch(got, /Перенёс три из пяти/, "то, что Claude уже получал при первой передаче, повторно не вкладывается");
  assert.doesNotMatch(got, /Пользователь: ECHO первый/, "собственные ходы Claude не пересказываются");
});
