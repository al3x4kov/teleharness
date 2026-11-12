// BUG-188: слэш-команды opencode в GLM-чатах не раскрываются (OmO → slim
// лишился хука auto-slash-command). Портал сам распознаёт «/имя аргументы»
// в одиночном текстовом part и зовёт upstream POST /session/:id/command
// вместо prompt_async. Только admin (тенанту команда могла бы задать своего
// агента в обход Sandbox), только opencode-биндинг, только одиночный текст
// (вложения — обычный prompt), имя — из списка команд папки.
//
// Сценарии (tests.md A3, фейк tests/helpers/fake-opencode.mjs):
//   1. admin «/as-spec текст»     → POST /session/:id/command (тело из
//      привязки: command/arguments/agent/model-строка/variant), prompt_async
//      НЕ вызывался, клиент получил 204 не дожидаясь синхронного upstream-хода;
//   2. admin «/нетакой текст»     → prompt_async с исходным текстом;
//   3. tenant «/as-spec текст»    → prompt_async (команды тенанту не раскрываются);
//   4. admin вложение + «/as-spec» → prompt_async.
// Run: node --test --test-concurrency=1 tests/bug188-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-bug188-" + "8".repeat(24);
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const COMMANDS = [{ name: "as-spec", template: "Invoke the spec-driven-development skill…", agent: null, model: null, subtask: false }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 15_000, stepMs = 50, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await sleep(stepMs);
  }
}

let up, srv, home;
const api = (p, { method = "GET", body, token = ADMIN } = {}) =>
  fetch(`${srv.base}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

before(async () => {
  up = await startFakeOpencode({ commands: COMMANDS });
  let n = 0;
  up.route("GET", "/provider", () => ({
    all: [{ id: "zai-coding-plan", name: "Z.AI", models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash", capabilities: { input: { text: true, image: true } } } } }],
    connected: ["zai-coding-plan"],
    default: { "zai-coding-plan": "glm-5.3-flash" },
  }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3-flash", default_agent: "orchestrator" } }));
  up.route("GET", "/agent", () => ({
    json: [
      { name: "orchestrator", mode: "primary", permission: [] },
      // Песочный агент для тенантского дефолта (deny-all — маркер sandbox).
      { name: "ask", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "deny" }] },
    ],
  }));
  up.route("POST", "/instance/dispose", () => ({ json: true }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_b188_${++n}`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  // Сценарий 1: upstream-ход команды МЕДЛЕННЫЙ (синхронный /command отвечает
  // только после хода) — клиент обязан получить 204, не дожидаясь его.
  up.route("POST", "/session/ses_b188_1/command", async () => {
    await sleep(1200); // пауза по смыслу: upstream-ход специально медленный — 204 обязан прийти раньше него (BUG-188)
    return { json: { info: { id: "msg_cmd1", role: "assistant" }, parts: [{ type: "text", text: "готово" }] } };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
  home = srv.env.ZAI_HOME;
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

const chatDir = (id) => up.state.sessions.find((s) => s.id === id)?.directory ?? null;
const cmdsOf = (id) => up.requests.filter((rq) => rq.method === "POST" && rq.path === `/session/${id}/command`);
const promptsOf = (id) => up.requests.filter((rq) => rq.method === "POST" && rq.path === `/session/${id}/prompt_async`);

async function adminChat() {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator" } })).json();
  assert.ok(s.id, JSON.stringify(s));
  return s.id;
}

test("BUG-188 [1]: admin «/as-spec текст» → upstream /command из привязки, prompt_async молчит, 204 не ждёт ход", async () => {
  const id = await adminChat(); // первый POST /session → ses_b188_1 (медленный маршрут /command)
  assert.equal(id, "ses_b188_1", `порядок сценариев сломался: ${id}`);

  const t0 = Date.now();
  const r = await api(`/zai/api/session/${id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "/as-spec утилита считает слова" }] } });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 204, `клиент получил 204 (${elapsed} мс): ${await r.text()}`);
  assert.ok(elapsed < 1000, `204 пришёл ДО синхронного upstream-хода (${elapsed} мс ≥ 1000)`);

  // Upstream получил POST /session/:id/command с телом из привязки.
  const cmd = await waitFor(() => cmdsOf(id)[0], { what: "upstream POST /command" });
  assert.equal(cmd.directory, home);
  assert.deepEqual(cmd.body, {
    command: "as-spec",
    arguments: "утилита считает слова",
    agent: "orchestrator",
    model: "zai-coding-plan/glm-5.3-flash",
    variant: "max", // BUG-180: GLM-5.3 без варианта → ZAI_GLM_VARIANT (дефолт max)
  });
  assert.equal(promptsOf(id).length, 0, "prompt_async не вызывался");
  // Список команд папки подгрузлен с папкой чата (кэш на 60 с).
  assert.ok(up.requests.some((rq) => rq.method === "GET" && rq.path === "/command" && rq.directory === home), "GET /command с папкой чата");
});

test("BUG-188 [2]: admin «/нетакой текст» (имени нет в списке команд) → обычный prompt_async", async () => {
  const id = await adminChat();
  const r = await api(`/zai/api/session/${id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "/нетакой текст" }] } });
  assert.equal(r.status, 204, await r.text());
  const p = await waitFor(() => promptsOf(id)[0], { what: "prompt_async" });
  assert.equal(p.directory, home);
  assert.deepEqual(p.body.parts, [{ type: "text", text: "/нетакой текст" }], "исходный текст без раскрытия");
  assert.deepEqual(p.body.model, FLASH, "модель из привязки");
  assert.equal(cmdsOf(id).length, 0, "/command не вызывался");
});

test("BUG-188 [3]: tenant «/as-spec текст» → prompt_async, команды не раскрываются", async () => {
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "t188" } })).json();
  assert.ok(created.token, JSON.stringify(created));
  const tdir = created.user.directories[0];
  const s = await (await api("/zai/api/session", { method: "POST", token: created.token, body: { model: FLASH } })).json();
  assert.ok(s.id, JSON.stringify(s));
  assert.equal(s.zai?.engine, "opencode", JSON.stringify(s.zai));

  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "/as-spec утилита считает слова" }] } });
  assert.equal(r.status, 204, await r.text());
  const p = await waitFor(() => promptsOf(s.id)[0], { what: "tenant prompt_async" });
  assert.equal(p.directory, tdir);
  assert.deepEqual(p.body.parts, [{ type: "text", text: "/as-spec утилита считает слова" }], "текст ушёл как есть");
  assert.equal(cmdsOf(s.id).length, 0, "upstream /command для тенанта не вызывался");
  assert.ok(!up.requests.some((rq) => rq.method === "GET" && rq.path === "/command" && rq.directory === tdir), "тенантский ход даже не смотрел список команд");
});

test("BUG-188 [4]: вложение + «/as-spec» → обычный prompt_async с обеими частями", async () => {
  const id = await adminChat();
  const body = {
    parts: [
      { type: "text", text: "/as-spec опиши это" },
      { type: "file", mime: "text/plain", filename: "a.txt", url: "data:text/plain;base64,0JLRgdC10L0=" },
    ],
  };
  const r = await api(`/zai/api/session/${id}/prompt`, { method: "POST", body });
  assert.equal(r.status, 204, await r.text());
  await waitFor(() => promptsOf(id)[0], { what: "prompt_async" });
  assert.equal(cmdsOf(id).length, 0, "команда с вложением уходит обычным ходом");
  const p = promptsOf(id)[0];
  assert.equal(p.body.parts.length, 2, "обе части дошли (file part материализуется сервером)");
  assert.ok(p.body.parts.some((x) => x.type === "text" && x.text.includes("/as-spec опиши это")));
});
