// FEAT-16.3, tasks 3.2/3.4/3.5/3.6: сервер против opencode v2 (ZAI_OC_API=v2).
// Весь upstream-слой портала (server.js, routes/catalog.js, instance-health)
// идёт через адаптер lib/oc-client.js; контракт для браузера — прежний.
// Вход по Bearer-токену админа (как в bug186-server.test.js); фейк —
// tests/helpers/fake-opencode-v2.mjs (Basic-пароль, конверт {location, data}).
// v2fix2 (2026-11-08): /zai/api/provider у админа и тенантов в v2-режиме тоже
// через клиента — claude.handleProvider получает опцию catalog (источник
// v2 из server.js), lib/claude.js склеивает claude-модели как в v1.
// Run: node --test --test-concurrency=1 tests/v2-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";
import { createOcClient } from "../lib/oc-client.js";

const ADMIN = "b".repeat(24) + "-v2srv-" + "2".repeat(24);
const PW = "oc2-password-НЕ-ПОПАДЕТ-В-ОТВЕТЫ-7q1x";
const DIR = "C:\\w\\v2proj";
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const FLASH2 = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash-2" };

let up, srv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, { method = "GET", body, token = ADMIN } = {}) =>
  fetch(srv.base + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

// Журнал upstream-вызовов одной сессии: [path, body] по порядку прихода.
const sidOps = (sid, kind) =>
  up.requests
    .filter((r) => r.path === `/api/session/${sid}/${kind}`)
    .map((r) => r.body);

before(async () => {
  up = await startFakeOpencodeV2({
    password: PW,
    sessions: [
      {
        id: "ses_seed",
        title: "seed",
        location: { directory: DIR },
        model: { providerID: FLASH.providerID, id: FLASH.modelID },
        agent: "orchestrator",
        time: { created: 1_000, updated: 2_000 },
      },
      {
        id: "ses_mark",
        title: "markers",
        location: { directory: DIR },
        model: { providerID: FLASH.providerID, id: FLASH.modelID },
        agent: "orchestrator",
        time: { created: 3_000, updated: 4_000 },
      },
    ],
    agents: [
      { name: "orchestrator", mode: "primary" },
      // Песочный агент для тенантского дефолта (deny-all — маркер sandbox,
      // policy.js agentCan читает v1-поле permission у записи любого вида)
      { name: "ask", mode: "primary", hidden: false, permission: [{ permission: "*", pattern: "*", action: "deny" }] },
    ],
    mcp: [{ name: "playwright", status: "connected" }],
    // v2fix2: реалистичный каталог (api-map §10 + OpenAPI 2.2.6) — Provider.Info
    // v2 моделей НЕ несёт (только id/name/activation), модели — плоский список
    // /api/model (Model.Info: id, providerID, capabilities, limit, status).
    providers: [{ id: "zai-coding-plan", name: "Z.AI", activation: "auto" }],
    models: [
      { id: "glm-5.3", providerID: "zai-coding-plan", name: "GLM-5.3", status: "active", capabilities: { input: { text: true, image: true }, output: { text: true } }, limit: { context: 200_000 } },
      { id: "glm-5.3-flash", providerID: "zai-coding-plan", name: "GLM-5.3 Flash", status: "active", capabilities: { input: { text: true, image: true }, output: { text: true } }, limit: { context: 200_000 } },
      { id: "glm-5.3-highspeed", providerID: "zai-coding-plan", name: "GLM-5.3 Highspeed", status: "active", capabilities: { input: { text: true, image: false }, output: { text: true } }, limit: { context: 200_000 } },
    ],
    modelDefault: { providerID: FLASH.providerID, id: FLASH.modelID },
    configDocs: [{ info: { default_agent: "orchestrator", model: { providerID: FLASH.providerID, id: FLASH.modelID }, snapshots: false } }],
    permissions: [{ id: "per_1", sessionID: "ses_seed", permission: "bash", title: "run ls", time: { created: Date.now() } }],
    forms: [{ id: "frm_1", sessionID: "ses_seed", title: "Выбор", form: { fields: [] }, time: { created: Date.now() } }],
    // история ses_seed, НОВЫМИ раньше (курсорная пагинация v2, api-map §4)
    messages: {
      ses_seed: [
        { id: "msg_5", type: "user", text: "пятый", time: { created: 5_000 } },
        { id: "msg_4", type: "assistant", model: { providerID: FLASH.providerID, id: FLASH.modelID }, agent: "orchestrator", content: [{ type: "text", text: "четыре" }], time: { created: 4_000 } },
        { id: "msg_3", type: "user", text: "третий", time: { created: 3_000 } },
        { id: "msg_2", type: "assistant", model: { providerID: FLASH.providerID, id: FLASH.modelID }, agent: "orchestrator", content: [{ type: "text", text: "два" }], time: { created: 2_000 } },
        { id: "msg_1", type: "user", text: "первый", time: { created: 1_000 } },
      ],
      // v2fix3 (FEAT-16.3, находка Claude на стенде :4174): служебные записи
      // вперемешку — upstream-страница ?limit=N режется по сырным записям,
      // а заголовки x-zai-* обязаны считать только видимые сообщения
      ses_mark: [
        { id: "mk_3", type: "agent-switched", agent: "build" },
        { id: "msg_a", type: "assistant", model: { providerID: FLASH.providerID, id: FLASH.modelID }, agent: "build", content: [{ type: "text", text: "ответ" }], time: { created: 40_000 } },
        { id: "mk_2", type: "idle", outcome: "succeeded" },
        { id: "mk_1", type: "model-switched", model: { providerID: FLASH.providerID, id: FLASH.modelID }, previous: { providerID: FLASH.providerID, id: FLASH.modelID } },
        { id: "msg_u", type: "user", text: "вопрос", time: { created: 30_000 } },
        { id: "mk_0", type: "idle", outcome: "failed" },
      ],
    },
    diffs: { ses_seed: [{ file: "a.txt", status: "modified" }] },
    // 3.8 (BUG-188 на v2): список команд папки для слэша — «/as-spec текст»
    commands: [{ name: "as-spec", description: "spec-driven development probe" }],
    // Защита «закрыто при отказе» (v2fix1): plugin.list подтверждает плагин
    // песочницы — иначе тенантские ходы портал закрывает 403. Гейт-тесты
    // в конце файла переопределяют маршрут через up.route.
    plugins: [{ id: "zai-tenant-v2", source: { type: "local" }, state: { status: "active" } }],
  });
  srv = await spawnPortal({
    upstream: up.url,
    env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_OC_API: "v2", ZAI_OC_PASSWORD: PW, ZAI_ACCESS_LOG: "1", ZAI_HIDE_TEMP_SESSIONS: "0", ZAI_PLUGIN_GATE_TTL_MS: "500", ZAI_PLUGIN_GATE_TTL_NEG_MS: "500" },
  });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("вход: Bearer-токен пускает, неверный — 401; login отдаёт identity", async () => {
  const bad = await api("/zai/api/session", { token: "wrong" });
  assert.equal(bad.status, 401);
  const login = await api("/zai/api/auth/login", { method: "POST", token: null, body: { token: ADMIN } });
  assert.equal(login.status, 200);
  const me = await (await login).json();
  assert.equal(me.user?.role, "admin");
  // фейк видел Basic-авторизацию адаптера именно с паролем v2
  const authed = up.requests.filter((r) => r.path === "/api/session").every((r) => r.authorization === `Basic ${Buffer.from(`opencode:${PW}`).toString("base64")}`);
  assert.ok(authed, "клиент ходит в v2 с Basic-паролем");
});

test("список чатов: v2-сессии в языке 1.x (directory, model)", async () => {
  const res = await api("/zai/api/session");
  assert.equal(res.status, 200);
  const list = await res.json();
  const seed = list.find((s) => s.id === "ses_seed");
  assert.ok(seed, JSON.stringify(list));
  assert.equal(seed.directory, DIR);
  assert.equal(seed.model?.providerID, FLASH.providerID);
  assert.equal(seed.model?.id, FLASH.modelID); // лицо сессии 1.x: model {providerID, id}
});

test("создание чата: location в теле, запись в индексе, прогрев папки", async () => {
  const res = await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator", title: "новый" } });
  assert.equal(res.status, 200);
  const created = await res.json();
  assert.ok(created.id?.startsWith("ses_f"), JSON.stringify(created));
  const post = up.requests.find((r) => r.method === "POST" && r.path === "/api/session" && r.body?.location?.directory);
  assert.ok(post, "POST /api/session несёт location:{directory}");
  assert.equal(post.body.title, "новый");
  assert.ok(up.state.sessions.some((s) => s.id === created.id));
  // BUG-183 прогрев (tasks 3.6, design §6): warmup(/api/mcp) + провайдер/модели
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const warm = up.requests.filter((r) => ["GET /api/mcp", "GET /api/provider", "GET /api/model"].includes(`${r.method} ${r.path}`));
    if (warm.length >= 3) break;
    await sleep(100);
  }
  for (const p of ["/api/mcp", "/api/provider", "/api/model"]) {
    assert.ok(
      up.requests.some((r) => r.method === "GET" && r.path === p && r.queryEntries.some(([k, v]) => k === "location[directory]" && v)),
      `прогрев долбится в ${p} с location`,
    );
  }
});

test("ход v2: модель через POST /model ПЕРЕД prompt, без model/agent/system в теле хода (3.5)", async () => {
  const res = await api("/zai/api/session/ses_seed/prompt", {
    method: "POST",
    body: { parts: [{ type: "text", text: "turn-A" }], model: FLASH, agent: "orchestrator" },
  });
  assert.equal(res.status, 204);
  const model = sidOps("ses_seed", "model").at(-1);
  const agent = sidOps("ses_seed", "agent").at(-1);
  const prompt = sidOps("ses_seed", "prompt").at(-1);
  assert.deepEqual(model?.model, { providerID: FLASH.providerID, id: FLASH.modelID, variant: "max" }); // ZAI_GLM_VARIANT (BUG-180)
  assert.equal(agent?.agent, "orchestrator");
  assert.equal(prompt?.text, "turn-A");
  assert.equal(prompt?.model, undefined);
  assert.equal(prompt?.agent, undefined);
  assert.equal(prompt?.variant, undefined);
  assert.equal(prompt?.system, undefined); // Э9: систем-промпт — 4.4, в v2 пока не едет
});

test("BUG-209: ход v2 — свой системный промпт пользователя едет в metadata.system (плагин-мост), напоминание — скрыто", async () => {
  let r = await api("/zai/api/me/system-prompt", { method: "PUT", body: { text: "Пиши в конце ПОДСОЛНУХ" } });
  assert.equal(r.status, 200);
  try {
    r = await api("/zai/api/session/ses_seed/prompt", { method: "POST", body: { parts: [{ type: "text", text: "turn-S" }] } });
    assert.equal(r.status, 204);
    const prompt = sidOps("ses_seed", "prompt").at(-1);
    assert.equal(prompt?.text, "turn-S", "видимый текст — без промпта и напоминания");
    assert.equal(prompt?.system, undefined, "в теле хода v2 поля system нет");
    assert.match(prompt?.metadata?.system ?? "", /ПОДСОЛНУХ/);
    assert.match(prompt?.metadata?.zaiHidden ?? "", /ПОДСОЛНУХ/, "напоминание — скрытой частью (BUG-193)");
  } finally {
    await api("/zai/api/me/system-prompt", { method: "PUT", body: { text: "" } });
  }
});

test("BUG-210: удаление последнего чата папки освобождает экземпляр opencode этой папки (папку можно удалить)", async () => {
  const dir = DIR + "\\bug210-" + Date.now().toString(36);
  let res = await api(`/zai/api/session?directory=${encodeURIComponent(dir)}`, { method: "POST", body: { model: FLASH, title: "на удаление" } });
  assert.equal(res.status, 200);
  const created = await res.json();
  res = await api(`/zai/api/session/${created.id}`, { method: "DELETE" });
  assert.ok(res.status >= 200 && res.status < 300, `delete ${res.status}`);
  const fwd = dir.replace(/\\/g, "/");
  const end = Date.now() + 5000;
  let hit = null;
  while (Date.now() < end && !hit) {
    hit = up.requests.find((r) => r.method === "DELETE" && r.path === "/api/debug/location" && r.queryEntries.some(([k, v]) => k === "location[directory]" && (v === dir || v === fwd)));
    if (!hit) await sleep(100);
  }
  assert.ok(hit, "после удаления — DELETE /api/debug/location для папки чата");
});

test("per-session очередь: параллельные ходы не interleaving-ятся (3.5, design §116)", async () => {
  const [a, b] = await Promise.all([
    api("/zai/api/session/ses_seed/prompt", { method: "POST", body: { parts: [{ type: "text", text: "par-A" }], model: FLASH, agent: "orchestrator" } }),
    api("/zai/api/session/ses_seed/prompt", { method: "POST", body: { parts: [{ type: "text", text: "par-B" }], model: FLASH2, agent: "orchestrator" } }),
  ]);
  assert.equal(a.status, 204);
  assert.equal(b.status, 204);
  // Журнал: (model, agent, prompt) каждого хода — сплошная тройка, ходы
  // не вклиниваются друг в друга (иначе модель чужого хода переключится).
  const seq = up.requests
    .filter((r) => /^\/api\/session\/ses_seed\/(model|agent|prompt)$/.test(r.path))
    .slice(-6)
    .map((r) => r.path.split("/").at(-1));
  assert.equal(seq.length, 6, JSON.stringify(seq));
  for (let i = 0; i < 6; i += 3) assert.deepEqual(seq.slice(i, i + 3), ["model", "agent", "prompt"], JSON.stringify(seq));
});

// ---- 3.8: слэш-команды v2 (BUG-188 на v2) ------------------------------------

const waitFor = async (fn, { timeoutMs = 15_000, stepMs = 50, what = "condition" } = {}) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await sleep(stepMs);
  }
};
const sidSeq = (sid, kinds) =>
  up.requests
    .filter((r) => r.path === `/api/session/${sid}/${r.path.split("/").at(-1)}` && kinds.includes(r.path.split("/").at(-1)))
    .map((r) => ({ kind: r.path.split("/").at(-1), body: r.body }));

test("слэш v2 [1]: admin «/as-spec текст» → binding на сессию (model/agent) и command {name,text} одной очередью, prompt молчит", async () => {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator", title: "slash-v2" } })).json();
  assert.ok(s.id, JSON.stringify(s));

  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "/as-spec утилита считает слова" }] } });
  assert.equal(r.status, 204, `204 сразу: ${await r.text()}`);

  // одной per-session очередью: model → agent → command (без interleaving с prompt)
  const seq = await waitFor(() => {
    const ops = sidSeq(s.id, ["model", "agent", "command"]);
    return ops.length >= 3 ? ops : null;
  }, { what: "model+agent+command" });
  assert.deepEqual(seq.map((o) => o.kind), ["model", "agent", "command"], JSON.stringify(seq));
  assert.deepEqual(seq[0].body.model, { providerID: FLASH.providerID, id: FLASH.modelID, variant: "max" }, "variant привязки — ZAI_GLM_VARIANT (BUG-180)");
  assert.equal(seq[1].body.agent, "orchestrator");
  assert.deepEqual(seq[2].body, { name: "as-spec", text: "утилита считает слова" }, "тело v2 {name, text} — agent/model команды не принимает");
  assert.equal(sidOps(s.id, "prompt").length, 0, "prompt не вызывался — команда ушла через /command");
  // список команд папки подгрузлен с папкой чата (deepObject location, кэш 60 с)
  assert.ok(
    up.requests.some((rq) => rq.method === "GET" && rq.path === "/api/command" && rq.queryEntries.some(([k, v]) => k === "location[directory]" && v === s.directory)),
    "GET /api/command с папкой чата",
  );
});

test("слэш v2 [2]: admin «/нетакой текст» (имени нет в списке) → обычный v2-ход prompt", async () => {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator", title: "slash-v2-miss" } })).json();
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "/нетакой текст" }] } });
  assert.equal(r.status, 204, await r.text());
  const p = await waitFor(() => sidOps(s.id, "prompt")[0], { what: "prompt" });
  assert.equal(p.text, "/нетакой текст", "исходный текст без раскрытия");
  assert.equal(sidOps(s.id, "command").length, 0, "/command не вызывался");
});

test("слэш v2 [3]: tenant «/as-spec текст» → prompt, команды не раскрываются и список не читается", async () => {
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "t188v2" } })).json();
  assert.ok(created.token, JSON.stringify(created));
  const tdir = created.user.directories[0];
  const s = await (await api("/zai/api/session", { method: "POST", token: created.token, body: { model: FLASH } })).json();
  assert.ok(s.id, JSON.stringify(s));

  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "/as-spec утилита считает слова" }] } });
  assert.equal(r.status, 204, await r.text());
  const p = await waitFor(() => sidOps(s.id, "prompt")[0], { what: "tenant prompt" });
  assert.equal(p.text, "/as-spec утилита считает слова", "текст ушёл как есть");
  assert.equal(sidOps(s.id, "command").length, 0, "/command для тенанта не вызывался");
  assert.ok(
    !up.requests.some((rq) => rq.method === "GET" && rq.path === "/api/command" && rq.queryEntries.some(([k, v]) => k === "location[directory]" && v === tdir)),
    "тенантский ход даже не смотрел список команд",
  );
});

test("история с пагинацией x-zai-* (3.4)", async () => {
  const p1 = await api("/zai/api/session/ses_seed/message?limit=2");
  assert.equal(p1.status, 200);
  assert.equal(p1.headers.get("x-zai-has-more"), "1");
  assert.equal(p1.headers.get("x-zai-next-before"), "msg_4");
  const page1 = await p1.json();
  assert.deepEqual(page1.map((m) => m.info?.id), ["msg_4", "msg_5"]); // две новейшие, старые раньше

  const p2 = await api("/zai/api/session/ses_seed/message?limit=2&before=msg_4");
  const page2 = await p2.json();
  assert.equal(p2.headers.get("x-zai-has-more"), "1");
  assert.equal(p2.headers.get("x-zai-next-before"), "msg_2");
  assert.deepEqual(page2.map((m) => m.info?.id), ["msg_2", "msg_3"]);

  const p3 = await api("/zai/api/session/ses_seed/message?limit=2&before=msg_2");
  const page3 = await p3.json();
  assert.equal(p3.headers.get("x-zai-has-more"), "0");
  assert.equal(p3.headers.get("x-zai-next-before"), null);
  assert.deepEqual(page3.map((m) => m.info?.id), ["msg_1"]);

  const bad = await api("/zai/api/session/ses_seed/message?before=msg_99");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "unknown before cursor" });

  const whole = await api("/zai/api/session/ses_seed/message");
  const list = await whole.json();
  assert.deepEqual(list.map((m) => m.info?.id), ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"]); // вся история, старые раньше
});

// v2fix3 (FEAT-16.3): служебные записи (idle, *-switched) в сырой истории v2.
// Заголовки x-zai-* и страницы обязаны считать только сообщения портала:
// limit=1 → одно видимое сообщение, next-before = его id, before с ним
// работает, проход страниц собирает ровно видимую историю, последняя
// страница — has-more = 0.
// v2fix3 (vision 0/2 на стенде :4174): вложение-картинка едет в v2-форме
// files[] = {uri, name} (PromptInput.FileAttachment 2.2.6) — инлайн data: URL
// для картинок на модели со зрением, без полей url/filename/mime из 1.x
// (upstream отвечает 400 "Missing key at files[0].uri" на форму 1.x).
test("prompt с картинкой: files[] в форме 2.2.6 — uri data: URL, name из filename (v2fix3)", async () => {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator", title: "vision-v2fix3" } })).json();
  assert.ok(s.id, JSON.stringify(s));
  const r = await api(`/zai/api/session/${s.id}/prompt`, {
    method: "POST",
    body: { parts: [
      { type: "text", text: "что на картинке?" },
      { type: "file", url: "data:image/png;base64,AABA", filename: "circle.png", mime: "image/png" },
    ] },
  });
  assert.equal(r.status, 204, `204 сразу: ${await r.text()}`);
  const p = await waitFor(() => sidOps(s.id, "prompt")[0], { what: "prompt" });
  assert.equal(p.text, "что на картинке?", "текстовые части склеены, файловая в files[]");
  assert.deepEqual(p.files, [{ uri: "data:image/png;base64,AABA", name: "circle.png" }], "uri обязателен, name из filename, url/mime не уезжают");
});

test("история с пагинацией x-zai-* при служебных записях (v2fix3)", async () => {
  const p1 = await api("/zai/api/session/ses_mark/message?limit=1");
  assert.equal(p1.status, 200);
  const page1 = await p1.json();
  assert.deepEqual(page1.map((m) => m.info?.id), ["msg_a"], "страница из видимых сообщений, не пустая");
  assert.equal(p1.headers.get("x-zai-has-more"), "1");
  assert.equal(p1.headers.get("x-zai-next-before"), "msg_a", "курсор присутствует и указывает на старейший отданный");

  const seen = [...page1.map((m) => m.info?.id)];
  let cursor = p1.headers.get("x-zai-next-before");
  let last = p1;
  for (let i = 0; i < 10 && cursor; i++) {
    const p = await api(`/zai/api/session/ses_mark/message?limit=1&before=${encodeURIComponent(cursor)}`);
    assert.equal(p.status, 200, `before=${cursor} работает`);
    last = p;
    const page = await p.json();
    assert.equal(p.headers.get("x-zai-has-more"), page.length > 0 ? p.headers.get("x-zai-has-more") : "0", "пустая страница = конец");
    if (p.headers.get("x-zai-has-more") === "1") assert.ok(page.length > 0, "страница непустая, пока есть сообщения");
    seen.push(...page.map((m) => m.info?.id));
    cursor = p.headers.get("x-zai-next-before");
  }
  assert.deepEqual(seen, ["msg_a", "msg_u"], "ровно видимая история, без дублей и пропусков");
  assert.equal(last.headers.get("x-zai-has-more"), "0", "на последней странице has-more = 0");
  assert.equal(last.headers.get("x-zai-next-before"), null);

  // вся история без limit — тоже только видимые
  const all = await (await api("/zai/api/session/ses_mark/message")).json();
  assert.deepEqual(all.map((m) => m.info?.id), ["msg_u", "msg_a"]);
});

test("abort → interrupt; удаление чата v2", async () => {
  const ab = await api("/zai/api/session/ses_seed/abort", { method: "POST" });
  assert.equal(ab.status, 200, `abort: ${ab.status} ${await ab.text()} | srv.log: ${srv.log.slice(-1200)}`);
  assert.ok(up.requests.some((r) => r.method === "POST" && r.path === "/api/session/ses_seed/interrupt"));

  const del = await api("/zai/api/session/ses_seed", { method: "DELETE" });
  assert.equal(del.status, 200, `delete: ${del.status} ${await del.text()} | srv.log: ${srv.log.slice(-1200)}`);
  assert.ok(!up.state.sessions.some((s) => s.id === "ses_seed"), "сессия удалена upstream");
  const again = await api("/zai/api/session/ses_seed", { method: "DELETE" });
  assert.equal(again.status, 404);
});

test("permissions и формы: reply уходит в v2-маршруты с decision/answer", async () => {
  const perm = await api("/zai/api/permission/per_1/reply", { method: "POST", body: { reply: "allow" } });
  assert.equal(perm.status, 200);
  const permCall = up.requests.find((r) => r.path === "/api/session/ses_seed/permission/per_1/reply");
  assert.ok(permCall, "reply permission попал в v2-маршрут");
  assert.deepEqual(permCall.body, { decision: "allow" });

  const form = await api("/zai/api/question/frm_1/reply", { method: "POST", body: { answers: { choice: "a" } } });
  assert.equal(form.status, 200);
  const formCall = up.requests.find((r) => r.path === "/api/session/ses_seed/form/frm_1/reply");
  assert.ok(formCall, "ответ на форму попал в v2-маршрут");
  assert.deepEqual(formCall.body, { answer: { choice: "a" } }); // Э5: {answer:{...}}, не плоская строка
});

test("mcp, агенты — из v2; каталог моделей в форме 1.x с claude-моделями (v2fix2)", async () => {
  const mcp = await api("/zai/api/mcp");
  assert.equal(mcp.status, 200);
  const mcpData = await mcp.json();
  assert.deepEqual(mcpData, { playwright: { status: "connected" } }); // карта 1.x из массива v2

  const agents = await api("/zai/api/agent");
  assert.equal(agents.status, 200);
  const agentsData = await agents.json();
  assert.ok(Array.isArray(agentsData) && agentsData.some((a) => a?.name === "orchestrator"), JSON.stringify(agentsData));

  // v2fix2: каталог больше не 502 — вместо v1 /provider источником служит
  // клиент v2 (listProviders №22 + доклейка моделей из /api/model).
  const prov = await api("/zai/api/provider");
  const provRaw = await prov.text();
  assert.equal(prov.status, 200, `каталог: ${prov.status} ${provRaw}`);
  const cat = JSON.parse(provRaw);
  assert.deepEqual(Object.keys(cat).sort(), ["all", "connected", "default"], "форма 1.x {all, default, connected}");
  assert.ok(cat.connected.includes("zai-coding-plan"), JSON.stringify(cat.connected));
  assert.ok(cat.connected.includes("anthropic"), "claude-провайдер приклеен к connected");
  const zai = cat.all.find((p) => p?.id === "zai-coding-plan");
  assert.ok(zai?.models?.["glm-5.3-flash"], "glm-5.3-flash из /api/model доклеен в all");
  assert.ok(zai?.models?.["glm-5.3"] && zai?.models?.["glm-5.3-highspeed"], "весь список моделей провайдера");
  const anthropic = cat.all.find((p) => p?.id === "anthropic");
  assert.ok(anthropic?.models?.["claude-opus-5-5"] && anthropic?.models?.["claude-haiku-4-5"], "claude-модели приклеены к каталогу");
  assert.equal(cat.default?.anthropic, "claude-opus-5-5", "дефолт claude-группы — свежайший Opus");
  assert.ok(!JSON.stringify(cat).includes(PW), "пароль не просачивается в каталог");
});

test("каталог для тенанта (v2fix2): providerForUser — без claude-группы, модели свои", async () => {
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "t-catalog" } })).json();
  assert.ok(created.token, JSON.stringify(created));
  const prov = await api("/zai/api/provider", { token: created.token });
  const provRaw = await prov.text();
  assert.equal(prov.status, 200, `tenant provider: ${prov.status} ${provRaw}`);
  const cat = JSON.parse(provRaw);
  assert.deepEqual(cat.connected, ["zai-coding-plan"], "только подключённые неклауд-провайдеры");
  assert.equal(cat.all.length, 1, JSON.stringify(cat.all));
  assert.equal(cat.all[0]?.id, "zai-coding-plan");
  assert.ok(cat.all[0]?.models?.["glm-5.3-flash"], "модели провайдера видны тенанту");
  assert.equal(cat.all[0]?.models?.["claude-opus-5-5"], undefined, "claude-моделей тенанту нет (движок закрыт)");
  assert.equal(cat.default?.anthropic, undefined, "claude-дефолт вырезан");
});

test("healthz: ok и без пароля; SSE-кадры без пароля", async () => {
  const h = await api("/zai/api/healthz");
  assert.equal(h.status, 200);
  const hText = JSON.stringify(await h.json());
  assert.ok(!hText.includes(PW), "healthz не показывает пароль v2");
  assert.ok(hText.includes('"ok":true'), hText);

  const sse = await api("/zai/api/event");
  const reader = sse.body.getReader();
  const { value } = await reader.read();
  const frames = Buffer.from(value).toString("utf8");
  assert.ok(!frames.includes(PW), "SSE не показывает пароль v2");
  await reader.cancel().catch(() => {});
});

test("лечение папки (3.6): poisoned /api/mcp → dispose через /api/debug/location", async () => {
  up.route("GET", "/api/mcp", () => ({ status: 503, json: { _tag: "InternalError", message: "poisoned" } }));
  const res = await api("/zai/api/mcp");
  assert.equal(res.status, 503); // повтор после dispose тоже не удался — читаемая 503
  const disposed = up.requests.some((r) => r.method === "DELETE" && r.path === "/api/debug/location");
  assert.ok(disposed, "лечение = DELETE /api/debug/location (design §6), а не POST /instance/dispose");
  // возвращаем здоровый mcp (тот же контракт, что у дефолтного маршрута фейка)
  up.route("GET", "/api/mcp", (req, body, url) => ({
    json: { location: { directory: url.searchParams.get("location[directory]") ?? "C:\\Windows\\System32" }, data: up.state.mcp },
  }));
});

test("пароль v2 не появляется ни в access-логах, ни в stdout сервера", async () => {
  await sleep(300);
  const { readdirSync, readFileSync } = await import("node:fs");
  const logsDir = srv.env.ZAI_LOG_DIR;
  const files = readdirSync(logsDir);
  assert.ok(files.length > 0, "access-лог включён и что-то пишет");
  for (const f of files) {
    const text = readFileSync(`${logsDir}\\${f}`, "utf8");
    assert.ok(!text.includes(PW), `пароль v2 в access-логе ${f}`);
  }
  assert.ok(!srv.log.includes(PW), "пароль v2 в stdout/stderr сервера");
});

test("приватная очередь адаптера: enqueueTurn сериализует и не ломается на ошибке", async () => {
  const c = createOcClient({ api: "v2", base: up.url, password: PW });
  const order = [];
  const t1 = c.enqueueTurn("s", async () => {
    order.push("a1");
    await sleep(20);
    order.push("a2");
    throw new Error("fail-a");
  });
  const t2 = c.enqueueTurn("s", () => (order.push("b1"), "ok"));
  const t3 = c.enqueueTurn("t", () => order.push("c1")); // другая сессия — параллельно
  await Promise.allSettled([t1, t2, t3]);
  assert.deepEqual(order.filter((x) => x !== "c1"), ["a1", "a2", "b1"]);
  assert.ok(order.includes("c1"));
  assert.equal(typeof c.enqueueTurn, "function");
});

// ---- защита «закрыто при отказе» (v2fix1, 2026-11-08) -------------------------
// opencode 2.x при непогрузке плагина пишет только WARN и продолжает работать
// БЕЗ песочницы. Портал в v2-режиме НЕ пускает ходы тенантов, пока serve не
// подтвердит плагин через plugin.list (GET /api/plugin); админ не затронут.
// Последними в файле: гейт-кэш портала живёт после переключений маршрута.
const PLUGIN_ROUTE = () => ({ json: { location: { directory: up.state.sessions[0]?.location?.directory ?? "C:\\x" }, data: [{ id: "zai-tenant-v2", source: { type: "local" }, state: { status: "active" } }] } });
// Claude review: listed but NOT active (failed load) must not confirm the gate.
const PLUGIN_FAILED_ROUTE = () => ({ json: { location: { directory: "C:\\x" }, data: [{ id: "zai-tenant-v2", source: { type: "local" }, state: { status: "failed" } }] } });

test("гейт [1]: плагин не подтверждён (404) — тенант 403 с понятным текстом, admin ход уходит upstream", async () => {
  up.route("GET", "/api/plugin", () => ({ status: 404, json: { _tag: "NotFoundError", message: "нет маршрута (старый serve)" } }));
  await sleep(600); // истёк позитивный кэш гейта от ранних тенантских тестов (TTL 500 мс)
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "t-gate" } })).json();
  assert.ok(created.token, JSON.stringify(created));
  const s = await (await api("/zai/api/session", { method: "POST", token: created.token, body: { model: FLASH } })).json();
  assert.ok(s.id, JSON.stringify(s));
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "ход без песочницы" }] } });
  assert.equal(r.status, 403, `403 ожидался: ${r.status} ${await r.text()}`);
  const body = await (await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "ход без песочницы 2" }] } })).text();
  assert.match(body, /sandbox plugin not confirmed/i, `текст отказа: ${body}`);
  assert.equal(sidOps(s.id, "prompt").length, 0, "upstream prompt НЕ вызывался");
  // админ не затронут: ход уходит в upstream как обычно (своя сессия —
  // ранние тесты удаляют ses_seed)
  const as = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator", title: "gate-admin" } })).json();
  assert.ok(as.id, JSON.stringify(as));
  const ar = await api(`/zai/api/session/${as.id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "admin при закрытом гейте" }], model: FLASH, agent: "orchestrator" } });
  assert.equal(ar.status, 204, `admin prompt: ${ar.status} ${await ar.text()}`);
  await waitFor(() => sidOps(as.id, "prompt").some((b) => b?.text === "admin при закрытом гейте"), { what: "admin prompt upstream" });
  // чтение истории и binding тенанта не блокируются — гейт только на ходы
  const hist = await api(`/zai/api/session/${s.id}/message`, { token: created.token });
  assert.equal(hist.status, 200, `tenant history: ${hist.status}`);
  const bind = await api(`/zai/api/session/${s.id}/binding`, { method: "PATCH", token: created.token, body: { model: FLASH } });
  assert.notEqual(bind.status, 403, `binding: ${bind.status} ${await bind.text()}`);
});

test("гейт [1b]: плагин в списке, но не active (не загрузился) — тенант 403 (Claude review)", async () => {
  up.route("GET", "/api/plugin", PLUGIN_FAILED_ROUTE);
  await sleep(600);
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "t-gate1b" } })).json();
  const s = await (await api("/zai/api/session", { method: "POST", token: created.token, body: { model: FLASH } })).json();
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "плагин упал" }] } });
  assert.equal(r.status, 403, `403 ожидался: ${r.status} ${await r.text()}`);
  assert.equal(sidOps(s.id, "prompt").length, 0, "upstream prompt НЕ вызывался");
});

test("гейт [2]: serve подтвердил плагин — тенантский ход уходит upstream", async () => {
  up.route("GET", "/api/plugin", PLUGIN_ROUTE); // вернули подтверждение
  await sleep(600); // истёк негативный кэш гейта из [1] (TTL 500 мс) — новый опрос
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "t-gate2" } })).json();
  const s = await (await api("/zai/api/session", { method: "POST", token: created.token, body: { model: FLASH } })).json();
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "ход с песочницей" }] } });
  assert.equal(r.status, 204, `tenant prompt: ${r.status} ${await r.text()}`);
  await waitFor(() => sidOps(s.id, "prompt").some((b) => b?.text === "ход с песочницей"), { what: "tenant prompt upstream" });
  // возвращаем исходный маршрут на случай будущих тестов после гейтов
  up.route("GET", "/api/plugin", PLUGIN_ROUTE);
});
