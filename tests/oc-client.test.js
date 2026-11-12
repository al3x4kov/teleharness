// Тесты адаптера lib/oc-client.js (FEAT-16.3, tasks 2.2; шаг 1 — без SSE-
// переписывателя, истории и форм: они отложены в tasks 2.3–2.5 и на v1/v2
// отвечают ошибкой «not implemented in step 1»).
//
// Оба транспорта на фейках: v1 — существующий tests/helpers/fake-opencode.mjs
// (отдаёт РОВНО то, что портал получает от opencode 1.19.5: адаптер v1 —
// тонкая обёртка без изменения формы), v2 — новый fake-opencode-v2.mjs
// (контракт docs/opencode-v2/api-map.md §0: /api/*, Basic, конверт
// {location, data}, location[directory] deepObject, {_tag}-ошибки, 204).
// Для каждого метода таблицы design §1.3: путь, адресация папки, тело,
// распаковка конверта, ошибки (4xx/5xx/сеть → единая OcError адаптера).
// Пароль живёт только в заголовке Authorization — ни в ошибках, ни в логах.
// Run: node --test tests/oc-client.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";
import { createOcClient, OcError } from "../lib/oc-client.js";
import * as ocClientNs from "../lib/oc-client.js";

const DIR = "C:\\Users\\USER\\.zai-tenants\\alice";
const PWD = "oc2-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (up, m, p) => up.requests.find((r) => r.method === m && r.path === p);

// v2-запись сессии (api-map §1 №3) и её портал-форма (язык 1.x: location → directory).
const v2Session = (over = {}) => ({
  id: "ses_1",
  title: "Чат",
  model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "max" },
  agent: "orchestrator",
  time: { created: 1, updated: 2 },
  location: { directory: DIR },
  ...over,
});

// ---- v2: транспорт и единая ошибка адаптера ---------------------------------

test("v2: неверный пароль → 401 OcError; пароль не светится в ошибке", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const bad = createOcClient({ api: "v2", base: up.url, password: "НЕ-ТОТ-ПАРОЛЬ" });
    await assert.rejects(() => bad.listSessions({ directory: DIR }), (err) => {
      assert.ok(err instanceof OcError);
      assert.equal(err.status, 401);
      assert.equal(err.body?._tag, "UnauthorizedError");
      assert.ok(!String(err.message).includes("НЕ-ТОТ-ПАРОЛЬ"), "пароль в сообщении ошибки");
      assert.ok(!JSON.stringify({ body: err.body, cause: err.cause?.message }).includes("НЕ-ТОТ-ПАРОЛЬ"), "пароль в теле ошибки");
      return true;
    });
  } finally { await up.close(); }
});

test("v2: пароль уходит только в Authorization: Basic, верный → ok", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    await c.listSessions({ directory: DIR });
    const auth = up.requests[0].authorization;
    assert.match(auth, /^Basic /);
    assert.equal(auth, `Basic ${Buffer.from(`opencode:${PWD}`).toString("base64")}`);
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    assert.equal(decoded, `opencode:${PWD}`);
    // и в журнале запроса нет сырого пароля нигде, кроме заголовка
    const { authorization, ...rest } = up.requests[0];
    assert.ok(!JSON.stringify(rest).includes(PWD), "пароль вне Authorization");
  } finally { await up.close(); }
});

test("v2: 500 {_tag} → OcError со status и телом; сеть → OcError status 0", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    up.route("GET", "/api/mcp", () => ({ status: 500, json: { _tag: "InternalError", message: "boom", kind: "Http" } }));
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    await assert.rejects(() => c.mcpStatus({ directory: DIR }), (err) => {
      assert.ok(err instanceof OcError);
      assert.equal(err.status, 500);
      assert.equal(err.body?._tag, "InternalError");
      assert.match(err.message, /500/);
      return true;
    });
    const dead = createOcClient({ api: "v2", base: up.url, password: PWD, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(() => dead.listProjects(), (err) => {
      assert.ok(err instanceof OcError);
      assert.equal(err.status, 0);
      return true;
    });
  } finally { await up.close(); }
});

// ---- v2: сессии (design §1.3 №1–5) ------------------------------------------

test("v2 listSessions: GET /api/session?directory=, unwrap {data,cursor}, location→directory, variant в модели", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, sessions: [v2Session()] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const list = await c.listSessions({ directory: DIR });
    assert.equal(up.requests[0].path, "/api/session");
    const q0 = new URLSearchParams(up.requests[0].query);
    assert.equal(q0.get("directory"), DIR);
    assert.equal(q0.get("limit"), "200", "BUG-189: страница списка задаётся явно");
    assert.ok(Array.isArray(list));
    assert.equal(list[0].directory, DIR);
    assert.equal(list[0].location, undefined);
    assert.deepEqual(list[0].model, { providerID: "zai-coding-plan", id: "glm-5.3-flash", variant: "max" });
    assert.equal(list[0].id, "ses_1");
  } finally { await up.close(); }
});

test("BUG-189: v2 listSessions отдаёт ВЕСЬ список — проходит курсор, а не первую страницу 50", async () => {
  const many = Array.from({ length: 124 }, (_, i) => v2Session({ id: `ses_${String(i).padStart(3, "0")}` }));
  const up = await startFakeOpencodeV2({ password: PWD, sessions: many });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const list = await c.listSessions({});
    assert.equal(list.length, 124);
    assert.equal(new Set(list.map((s) => s.id)).size, 124, "без дублей");
    assert.equal(list[0].id, "ses_000", "порядок upstream сохранён");
    assert.equal(list.at(-1).id, "ses_123");
    const dirList = await c.listSessions({ directory: DIR });
    assert.equal(dirList.length, 124, "фильтр папки тоже листается до конца");
    assert.ok(up.requests.filter((r) => r.path === "/api/session").every((r) => r.query.includes(`directory=`) || !r.query.includes("directory")));
  } finally { await up.close(); }
});

test("v2 createSession: POST /api/session с папкой в теле location:{directory}; unwrap {data}", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const s = await c.createSession({ directory: DIR, title: "Новый чат", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "orchestrator" });
    const req = at(up, "POST", "/api/session");
    assert.ok(req, "нет POST /api/session");
    assert.deepEqual(req.body.location, { directory: DIR });
    assert.equal(req.body.title, "Новый чат");
    assert.deepEqual(req.body.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });
    assert.equal(req.body.agent, "orchestrator");
    assert.equal(s.id, "ses_f1");
    assert.equal(s.directory, DIR);
    assert.equal(s.location, undefined);
  } finally { await up.close(); }
});

test("v2 getSession: GET /api/session/:id → unwrap {data}, location→directory", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, sessions: [v2Session()] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const s = await c.getSession("ses_1", { directory: DIR });
    assert.equal(up.requests[0].path, "/api/session/ses_1");
    assert.equal(s.directory, DIR);
    assert.equal(s.title, "Чат");
  } finally { await up.close(); }
});

test("v2 patchSession: PATCH 204 → подтверждение повторным GET, запись с новым title (api-map №4)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, sessions: [v2Session()] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const s = await c.patchSession("ses_1", { directory: DIR, title: "Новое имя" });
    const patch = up.requests[0];
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.path, "/api/session/ses_1");
    assert.deepEqual(patch.body, { title: "Новое имя" });
    const get = up.requests[1];
    assert.equal(get?.method, "GET", "после 204 нужен повторный GET");
    assert.equal(get?.path, "/api/session/ses_1");
    assert.equal(s.title, "Новое имя");
    assert.equal(s.directory, DIR);
  } finally { await up.close(); }
});

test("v2 deleteSession: DELETE /api/session/:id, 204 → true; дочерние — дело сервера", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, sessions: [v2Session()] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.equal(await c.deleteSession("ses_1", { directory: DIR }), true);
    const req = up.requests[0];
    assert.equal(req.method, "DELETE");
    assert.equal(req.path, "/api/session/ses_1");
    assert.equal(up.state.sessions.length, 0);
  } finally { await up.close(); }
});

// ---- v2: ход, отмена, занятость, diff, реверт (№7–12) ------------------------

test("v2 prompt: POST /api/session/:id/prompt, parts → {text, files}, metadata-объект проходит, null опускается (Э1)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const file = { type: "file", url: "data:text/plain;base64,SGVsbG8=", filename: "a.txt", mime: "text/plain" };
    const sent = await c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "раз" }, { type: "text", text: "два" }, file], metadata: { kbContext: "x" } });
    const req = at(up, "POST", "/api/session/ses_1/prompt");
    assert.ok(req, "нет POST /api/session/ses_1/prompt");
    assert.equal(req.body.text, "раз\n\nдва");
    // v2fix3: форма 2.2.6 — PromptInput.FileAttachment {uri (обязателен), name?};
    // mime upstream синтезирует из data: URL, поля url/filename/mime из части 1.x
    // в v2-теле не существуют
    assert.deepEqual(req.body.files, [{ uri: file.url, name: "a.txt" }]);
    assert.deepEqual(req.body.metadata, { kbContext: "x" });
    assert.equal(req.body.model, undefined, "модели в теле хода v2 нет");
    assert.ok(sent.id, "unwrap {data: Inbox.User}");
    // metadata null → поле не уходит вовсе (v2 отвечает 400 на null, Э1)
    await c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "три" }], metadata: null });
    const req2 = up.requests.filter((r) => r.method === "POST" && r.path === "/api/session/ses_1/prompt").at(-1);
    assert.equal("metadata" in req2.body, false);
    assert.equal(req2.body.text, "три");
  } finally { await up.close(); }
});

test("BUG-193: v2 prompt — synthetic-части (голосовая подсказка) не в тексте хода, а в metadata.zaiHidden", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    await c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "привет" }, { type: "text", text: "[ГОЛОС: коротко]", synthetic: true }], metadata: { kbContext: "x" } });
    const req = at(up, "POST", "/api/session/ses_1/prompt");
    assert.equal(req.body.text, "привет", "видимый текст — только свои части пользователя");
    assert.deepEqual(req.body.metadata, { kbContext: "x", zaiHidden: "[ГОЛОС: коротко]" });
    // без synthetic — metadata как была, zaiHidden не появляется
    await c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "два" }] });
    const req2 = up.requests.filter((r) => r.method === "POST" && r.path === "/api/session/ses_1/prompt").at(-1);
    assert.equal("metadata" in req2.body, false);
  } finally { await up.close(); }
});

test("BUG-193: история v2 — metadata.zaiHidden возвращается скрытой synthetic-частью (как в 1.x)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, messages: { ses_v: [
    { id: "m1", type: "user", text: "привет", metadata: { zaiHidden: "[ГОЛОС: коротко]" }, time: { created: 1 } },
  ] } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const { messages } = await c.listMessages("ses_v", { directory: DIR });
    assert.deepEqual(messages[0].parts, [{ type: "text", text: "привет" }, { type: "text", text: "[ГОЛОС: коротко]", synthetic: true }]);
  } finally { await up.close(); }
});

test("v2 prompt (v2fix3, vision 0/2 на стенде :4174): files[] в форме 2.2.6 — uri обязателен (data:/file:/путь), name из filename", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    // инлайн-картинка (vision): data: URL как есть, mime не шлём (upstream синтезирует)
    // + файл-путь вложения .zai-uploads (BUG-140/163): голый путь → file:// URI
    await c.prompt({
      directory: DIR,
      sessionID: "ses_1",
      parts: [
        { type: "text", text: "что на картинке?" },
        { type: "file", url: "data:image/png;base64,AABA", filename: "circle.png", mime: "image/png" },
        { type: "file", url: "D:\\w\\proj\\.zai-uploads\\doc.pdf", filename: "doc.pdf", mime: "application/pdf" },
        { type: "file", url: "file:///C:/fixed/ref.txt", filename: "ref.txt" },
        { type: "file", uri: "data:text/plain;base64,WHg=", filename: "already-v2.txt" },
        { type: "file", filename: "broken.txt", mime: "text/plain" }, // нет источника uri
      ],
    });
    const req = up.requests.find((r) => r.method === "POST" && r.path === "/api/session/ses_1/prompt");
    assert.deepEqual(req.body.files, [
      { uri: "data:image/png;base64,AABA", name: "circle.png" },
      { uri: "file:///D:/w/proj/.zai-uploads/doc.pdf", name: "doc.pdf" },
      { uri: "file:///C:/fixed/ref.txt", name: "ref.txt" },
      { uri: "data:text/plain;base64,WHg=", name: "already-v2.txt" },
    ], "url→uri, filename→name, mime выброшен; часть без uri не шлётся (иначе 400 Missing key files[i].uri)");
    assert.equal(Object.keys(req.body.files[0]).some((k) => k === "url" || k === "mime"), false, "полей url/mime в v2-форме нет");
  } finally { await up.close(); }
});

test("v2 prompt: model/agent/variant/system в теле нет — отдельные вызовы §5, system §5.3 → not implemented in step 1", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    await assert.rejects(
      () => c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "x" }], model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, variant: "max" }),
      /not implemented in step 1/,
    );
    await assert.rejects(
      () => c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "x" }], system: "инструкция" }),
      /not implemented in step 1/,
    );
    assert.equal(up.requests.length, 0, "до сети дело не доходит");
  } finally { await up.close(); }
});

test("v2 abort: POST /api/session/:id/interrupt → {interrupted:true}", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.deepEqual(await c.abort("ses_1", { directory: DIR }), { interrupted: true });
    assert.equal(at(up, "POST", "/api/session/ses_1/interrupt")?.path, "/api/session/ses_1/interrupt");
  } finally { await up.close(); }
});

test("v2 busyMap: GET /api/session/active — глобальная карта БЕЗ location/directory, unwrap {data}", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, active: { ses_1: { type: "running" } } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    // TASK-16.7: v2 «running» → язык 1.x «busy» (скрипты выката RealBusy, /zai/api/status, пробы ждут busy)
    assert.deepEqual(await c.busyMap(), { ses_1: { type: "busy" } });
    assert.equal(at(up, "GET", "/api/session/active").query, "", "карта занятости глобальная");
  } finally { await up.close(); }
});

test("v2 sessionDiff: GET /api/session/:id/diff?from=messageID, без location; unwrap {data} (№10)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, diffs: { ses_1: [{ file: "a.txt", patch: "+x", additions: 1, deletions: 0, status: "modified" }] } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const diff = await c.sessionDiff("ses_1", { directory: DIR, messageID: "msg_9" });
    const req = at(up, "GET", "/api/session/ses_1/diff");
    assert.ok(req.query.includes(`from=${encodeURIComponent("msg_9")}`), "messageID → ?from=");
    assert.equal(req.query.includes("location%5Bdirectory%5D"), false, "diff — сессионный маршрут");
    assert.deepEqual(diff, [{ file: "a.txt", patch: "+x", additions: 1, deletions: 0, status: "modified" }]);
  } finally { await up.close(); }
});

test("v2 revert: stage{messageID} (без commit — BUG-206), портал получает превью stage; unrevert — DELETE /revert → true (№11–12)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const preview = await c.revert("ses_1", { directory: DIR, messageID: "msg_9" });
    const stage = at(up, "POST", "/api/session/ses_1/revert/stage");
    const commit = at(up, "POST", "/api/session/ses_1/revert/commit");
    assert.ok(stage, "нет stage");
    assert.deepEqual(stage.body, { messageID: "msg_9" });
    assert.equal(commit, undefined, "BUG-206: commit не сразу — иначе «Вернуть» 409; commit делает следующий ход");
    assert.deepEqual(preview, { messageID: "msg_9", files: [] }, "превью — ответ stage");
    assert.equal(await c.unrevert("ses_1", { directory: DIR }), true);
    assert.equal(at(up, "DELETE", "/api/session/ses_1/revert")?.method, "DELETE", "unrevert — DELETE вместо POST");
  } finally { await up.close(); }
});

// ---- v2: права, dispose, каталоги, конфиг, прогрев (№14–26 + v2-only) --------

test("v2 listPermissions: location[directory] deepObject (НЕ ?directory=), unwrap {location,data}", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, permissions: [{ id: "per_1", sessionID: "ses_1", action: "read", resources: [".env"] }] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const list = await c.listPermissions({ directory: DIR });
    const req = up.requests[0];
    assert.equal(req.path, "/api/permission/request");
    assert.deepEqual(req.queryEntries, [["location[directory]", DIR]], "deepObject-параметр");
    assert.deepEqual(list, [{ id: "per_1", sessionID: "ses_1", action: "read", resources: [".env"], permission: "read", patterns: [".env"], always: [], metadata: { command: ".env" } }], "BUG-205: поля 1.x добавлены, исходные на месте");
  } finally { await up.close(); }
});

test("v2 replyPermission: POST /api/session/:sid/permission/:rid/reply, тело {decision}", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.equal(await c.replyPermission({ directory: DIR, sessionID: "ses_1", requestID: "per_1", reply: "once" }), true);
    const req = up.requests[0];
    assert.equal(req.path, "/api/session/ses_1/permission/per_1/reply");
    assert.deepEqual(req.body, { decision: "once" });
  } finally { await up.close(); }
});

test("v2 disposeInstance: DELETE /api/debug/location?location[directory]= → true (№19)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.equal(await c.disposeInstance({ directory: DIR }), true);
    const req = up.requests[0];
    assert.equal(req.method, "DELETE");
    assert.equal(req.path, "/api/debug/location");
    assert.deepEqual(req.queryEntries, [["location[directory]", DIR]]);
  } finally { await up.close(); }
});

test("BUG-195: v2 disposeInstance — ключ экземпляра 2.2.6 — точная строка пути: шлём обе формы (\\ и /)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.equal(await c.disposeInstance({ directory: "C:\\Users\\USER\\.zai-tenants\\Carol" }), true);
    const dirs = up.requests.filter((r) => r.method === "DELETE" && r.path === "/api/debug/location").map((r) => r.queryEntries[0][1]);
    assert.deepEqual(dirs.sort(), ["C:/Users/USER/.zai-tenants/Carol", "C:\\Users\\USER\\.zai-tenants\\Carol"].sort());
    // путь без разделителей обеих форм — один запрос
    up.requests.length = 0;
    await c.disposeInstance({ directory: "relative-name" });
    assert.equal(up.requests.filter((r) => r.method === "DELETE").length, 1);
  } finally { await up.close(); }
});

test("BUG-192: v2 mcpStatus — живая форма 2.2.6 status:{status,error} разворачивается в строку статуса 1.x", async () => {
  const up = await startFakeOpencodeV2({
    password: PWD,
    mcp: [
      { name: "context7", status: { status: "connected" }, title: "Context7" },
      { name: "marketplace", status: { status: "failed", error: "Request timed out" } },
      { name: "gh", status: { status: "needs_auth" } },
    ],
  });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.deepEqual(await c.mcpStatus({ directory: DIR }), {
      context7: { status: "connected", title: "Context7" },
      marketplace: { status: "failed", error: "Request timed out" },
      gh: { status: "needs_auth" },
    });
  } finally { await up.close(); }
});

test("v2 mcpStatus: массив v2 → карта 1.x {name:{status}}, адресация location[directory] (№20)", async () => {
  const up = await startFakeOpencodeV2({
    password: PWD,
    mcp: [{ name: "playwright", status: "connected" }, { name: "marketplace", status: "failed", error: "Request timed out" }],
  });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const map = await c.mcpStatus({ directory: DIR });
    const req = up.requests[0];
    assert.equal(req.path, "/api/mcp");
    assert.deepEqual(req.queryEntries, [["location[directory]", DIR]], "только deepObject");
    assert.equal(req.query.includes("directory=" + encodeURIComponent(DIR).slice(0, 6)), false, "простой ?directory= не отправляется");
    assert.deepEqual(map, {
      playwright: { status: "connected" },
      marketplace: { status: "failed", error: "Request timed out" },
    }, "карта 1.x: вложенный объект, не строка");
  } finally { await up.close(); }
});

test("v2 listAgents: GET /api/agent → unwrap {location,data} → массив с mode/hidden/permissions (№21)", async () => {
  const agent = { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
  const up = await startFakeOpencodeV2({ password: PWD, agents: [agent] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const list = await c.listAgents();
    assert.equal(up.requests[0].path, "/api/agent");
    assert.deepEqual(list, [agent]);
  } finally { await up.close(); }
});

test("v2 listProviders: /api/provider + /api/model → {all, default, connected} (№22)", async () => {
  const up = await startFakeOpencodeV2({
    password: PWD,
    providers: [
      { id: "zai-coding-plan", name: "Z.ai", activation: "auto" },
      { id: "off", name: "Off", activation: "disabled" },
    ],
    models: [{ id: "glm-5.3", providerID: "zai-coding-plan", variants: [] }],
  });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const cat = await c.listProviders({ directory: DIR });
    const paths = up.requests.map((r) => r.path);
    assert.ok(paths.includes("/api/provider") && paths.includes("/api/model"), `${paths}`);
    for (const r of up.requests) assert.deepEqual(r.queryEntries, [["location[directory]", DIR]]);
    assert.equal(cat.all.length, 2);
    assert.deepEqual(cat.connected, ["zai-coding-plan"], "disabled не в connected (activation)");
    assert.equal(cat.default, null, "дефолт в v2 даёт /api/model/default — см. configGet");
    // v2fix2: модели из /api/model доклеиваются в элементы all без карты
    // (Provider.Info v2 моделей не несёт) — форма 1.x для потребителей портала.
    assert.equal(cat.all[0].models["glm-5.3"].id, "glm-5.3");
    assert.equal(cat.all[1].models, undefined, "провайдер без моделей остаётся без карты");
  } finally { await up.close(); }
});

test("v2 configGet: /api/config + /api/model/default → {default_agent, model, snapshot} (№23, Э1/Э3)", async () => {
  const up = await startFakeOpencodeV2({
    password: PWD,
    configDocs: [{ type: "document", path: "D:\\oc2\\config\\opencode\\opencode.json", info: { default_agent: "orchestrator", snapshots: false } }],
    modelDefault: { id: "glm-5.3", providerID: "zai-coding-plan", variant: "max" },
  });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const cfg = await c.configGet({ directory: DIR });
    const paths = up.requests.map((r) => r.path);
    assert.ok(paths.includes("/api/config") && paths.includes("/api/model/default"), `${paths}`);
    assert.deepEqual(cfg, { default_agent: "orchestrator", model: { id: "glm-5.3", providerID: "zai-coding-plan", variant: "max" }, snapshot: false });
  } finally { await up.close(); }
});

test("v2 warmup: health-check GET /api/mcp с retry (500 → ок, Э2); v1 — GET /config/providers (№24)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    let n = 0;
    up.route("GET", "/api/mcp", () => (++n < 2 ? { status: 500, json: { _tag: "InternalError", message: "cold" } } : { json: { location: { directory: DIR }, data: [] } }));
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const r = await c.warmup({ directory: DIR }, { delayMs: 0 });
    assert.deepEqual(r, { ok: true, status: 200, attempts: 2 });
    assert.equal(up.requests[0].path, "/api/mcp");
    assert.deepEqual(up.requests[0].queryEntries, [["location[directory]", DIR]]);
    assert.equal((await c.warmup({ directory: DIR }, { delayMs: 0 })).attempts, 1, "здоровая папка — одна попытка");
  } finally { await up.close(); }
  const up1 = await startFakeOpencode({});
  try {
    const c = createOcClient({ api: "v1", base: up1.url });
    const r = await c.warmup({ directory: DIR }, { delayMs: 0 });
    assert.equal(up1.requests[0].path, "/config/providers");
    assert.equal(r.ok, true);
  } finally { await up1.close(); }
});

test("v2 listProjects: GET /api/project — голый массив как есть (№25)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, projects: [{ id: "p1", canonical: "D:\\Portal\\zai", vcs: "git", sandboxes: [] }] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.deepEqual(await c.listProjects(), [{ id: "p1", canonical: "D:\\Portal\\zai", vcs: "git", sandboxes: [] }]);
    assert.equal(up.requests[0].path, "/api/project");
  } finally { await up.close(); }
});

test("v2 healthInfo: GET /api/info → версия (№26)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, version: "2.2.6" });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const info = await c.healthInfo();
    assert.equal(up.requests[0].path, "/api/info");
    assert.equal(info.version, "2.2.6");
  } finally { await up.close(); }
});

test("v2 setSessionModel/setSessionAgent: POST …/model {model:{providerID,id,variant}} и …/agent (§5); на v1 — v2-only", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, sessions: [v2Session()] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.equal(await c.setSessionModel("ses_1", { directory: DIR, model: { providerID: "zai-coding-plan", id: "glm-5.3", variant: "max" } }), true);
    const req = up.requests[0];
    assert.equal(req.path, "/api/session/ses_1/model");
    assert.deepEqual(req.body, { model: { providerID: "zai-coding-plan", id: "glm-5.3", variant: "max" } });
    assert.equal(await c.setSessionAgent("ses_1", { directory: DIR, agent: "orchestrator" }), true);
    assert.deepEqual(at(up, "POST", "/api/session/ses_1/agent")?.body, { agent: "orchestrator" });
    // модель реально легла в запись сессии — видна и через getSession
    const s = await c.getSession("ses_1", { directory: DIR });
    assert.deepEqual(s.model, { providerID: "zai-coding-plan", id: "glm-5.3", variant: "max" });
    const v1 = createOcClient({ api: "v1", base: up.url });
    await assert.rejects(() => v1.setSessionModel("ses_1", { directory: DIR, model: { providerID: "p", id: "m" } }), /v2-only/);
  } finally { await up.close(); }
});

// (шаг 1 держал events/listMessages/вопросы заглушками «not implemented» —
//  шаг 2 реализует их: секции ниже)

// ---- №27: слэш-команды (BUG-188, api-map «Команды», живьём :4100) ------------

test("v2 listCommands: GET /api/command?location[directory]= → unwrap {location,data} → массив {name,description}", async () => {
  const commands = [
    { name: "init", description: "guided AGENTS.md setup" },
    { name: "as-test", description: "Пробная команда стенда" },
  ];
  const up = await startFakeOpencodeV2({ password: PWD, commands });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const list = await c.listCommands({ directory: DIR });
    const req = up.requests[0];
    assert.equal(req.path, "/api/command");
    assert.deepEqual(req.queryEntries, [["location[directory]", DIR]], "deepObject-location как у других instance-маршрутов");
    assert.deepEqual(list, commands, "голый массив записей — форма 1.x");
  } finally { await up.close(); }
});

test("v2 runCommand: тело 1.x {command, arguments} → {name, text}; agent/model/variant не утекают; 204 → {status,json:null,text}", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, commands: [{ name: "as-test", description: "x" }] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const out = await c.runCommand("ses_1", { directory: DIR, body: { command: "as-test", arguments: "арг один", agent: "orchestrator", model: "zai-coding-plan/glm-5.3", variant: "max" } });
    const cmds = up.requests.filter((x) => x.method === "POST" && x.path === "/api/session/ses_1/command");
    const req = cmds[0];
    assert.equal(req.path, "/api/session/ses_1/command");
    assert.deepEqual(req.body, { name: "as-test", text: "арг один" }, "тело v2: только name+text — привязку задаёт сама команда/сессия");
    assert.deepEqual(out, { status: 204, json: null, text: "" }, "204 без тела — статус вызывателю");
    // v2-форма тела тоже принимается как есть
    await c.runCommand("ses_1", { body: { name: "as-test", text: "прямой" } });
    assert.deepEqual(up.requests.filter((x) => x.method === "POST" && x.path === "/api/session/ses_1/command")[1].body, { name: "as-test", text: "прямой" });
  } finally { await up.close(); }
});

test("v2 runCommand: неизвестная команда → 404 как ответ (не бросок), {_tag: CommandNotFoundError}; без имени — отказ до сети", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, commands: [{ name: "as-test" }] });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const out = await c.runCommand("ses_1", { body: { command: "no-such", arguments: "x" } });
    assert.equal(out.status, 404);
    assert.equal(out.json?._tag, "CommandNotFoundError");
    assert.equal(out.json?.command, "no-such");
    await assert.rejects(() => c.runCommand("ses_1", { body: { arguments: "x" } }), /runCommand: body\.command/);
    assert.equal(up.requests.filter((x) => x.method === "POST").length, 1, "без имени в сеть не ходим (GET сессии — проверка отката BUG-206 — только у валидного вызова)");
  } finally { await up.close(); }
});

test("v1 listCommands/runCommand: GET /command?directory= (голый массив), POST /session/:id/command — ответ как есть и на 4xx", async () => {
  const commands = [{ name: "review", description: "review changes" }];
  const up = await startFakeOpencode({ commands });
  try {
    const c = createOcClient({ api: "v1", base: up.url });
    assert.deepEqual(await c.listCommands({ directory: DIR }), commands);
    assert.equal(up.requests[0].path, "/command");
    assert.equal(up.requests[0].directory, DIR);
    up.route("POST", "/session/ses_a/command", () => ({ json: { ok: true } }));
    const ok = await c.runCommand("ses_a", { directory: DIR, body: { command: "review", arguments: "" } });
    assert.deepEqual(ok, { status: 200, json: { ok: true }, text: JSON.stringify({ ok: true }) }, "2xx: {status, json, text}");
    up.route("POST", "/session/ses_a/command", () => ({ status: 400, json: { error: "unknown command" } }));
    const bad = await c.runCommand("ses_a", { directory: DIR, body: { command: "zzz", arguments: "" } });
    assert.deepEqual(bad, { status: 400, json: { error: "unknown command" }, text: "" }, "400 — ответ, не бросок (статус нужен вызывателю)");
    const dead = createOcClient({ api: "v1", base: up.url, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(() => dead.runCommand("ses_a", { body: { command: "c", arguments: "" } }), (err) => err instanceof OcError && err.status === 0, "сеть — OcError");
  } finally { await up.close(); }
});

// ---- шаг 3 (FEAT-16.3, hub 3.3): маркер api, busyMap({directory}), вопросы по requestID

test("адаптер: маркер api виден, но не входит в интерфейс (ровно 28 методов)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c2 = createOcClient({ api: "v2", base: up.url, password: PWD });
    const c1 = createOcClient({ api: "v1", base: up.url });
    assert.equal(c2.api, "v2");
    assert.equal(c1.api, "v1");
    assert.equal(Object.keys(c2).length, 28, "неEnumerable-маркер не ломает интерфейс");
  } finally { await up.close(); }
});

test("busyMap: v1 шлёт ?directory= (маршрут directory-scoped), v2 игнорирует (глобальная карта)", async () => {
  const up1 = await startFakeOpencode({});
  try {
    let q1 = null;
    up1.route("GET", "/session/status", (req, body, url) => { q1 = url.search; return { json: { ses_1: { type: "running" } } }; });
    const c1 = createOcClient({ api: "v1", base: up1.url });
    assert.deepEqual(await c1.busyMap({ directory: DIR }), { ses_1: { type: "running" } });
    assert.equal(q1, `?directory=${encodeURIComponent(DIR)}`, "v1 без ?directory= молчит (hub.js:332)");
  } finally { await up1.close(); }
  const up2 = await startFakeOpencodeV2({ password: PWD, active: { ses_9: { type: "running" } } });
  try {
    const c2 = createOcClient({ api: "v2", base: up2.url, password: PWD });
    assert.deepEqual(await c2.busyMap({ directory: DIR }), { ses_9: { type: "busy" } }, "running v2 → busy 1.x");
    const hit = up2.requests.find((r) => r.path === "/api/session/active");
    assert.equal(hit.query, "", "v2: глобальная карта, location не нужен (api-map №9)");
  } finally { await up2.close(); }
});

test("вопросы: v2 принимает requestID как алиас formID (hub передаёт requestID)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.equal(await c.rejectQuestion({ directory: DIR, sessionID: "ses_f1", requestID: "form_1" }), true);
    assert.ok(up.requests.find((r) => r.method === "DELETE" && r.path === "/api/session/ses_f1/form/form_1"), "requestID лёг в путь формы");
  } finally { await up.close(); }
});

// ---- шаг 2, п.1: таймауты на вызов ({timeoutMs, signal}) ---------------------

test("таймауты: короткий метод на зависшем фейке → OcError code=timeout за свой лимит", { timeout: 10_000 }, async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    up.route("GET", "/api/agent", () => new Promise(() => {})); // завис навсегда
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const t0 = Date.now();
    await assert.rejects(() => c.listAgents({ timeoutMs: 150 }), (err) => {
      assert.ok(err instanceof OcError, "OcError");
      assert.equal(err.code, "timeout");
      assert.ok(!String(err.message).includes(PWD), "пароль не в ошибке");
      return true;
    });
    const dt = Date.now() - t0;
    assert.ok(dt >= 120 && dt < 5000, `таймаут сработал через ${dt} мс`);
  } finally { await up.close(); }
});

test("таймауты: длинные (prompt v2 — асинхронный, revert, mcpStatus) не обрываются раньше лимита (BUG-183)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    up.route("POST", "/api/session/ses_x/prompt", async () => { await sleep(150); return { json: { data: { id: "msg_1", sessionID: "ses_x", type: "user" } } }; });
    up.route("POST", "/api/session/ses_x/revert/stage", async () => { await sleep(150); return { json: { data: { messageID: "msg_9", files: [] } } }; });
    up.route("POST", "/api/session/ses_x/revert/commit", () => ({ status: 204 }));
    let mcpHits = 0;
    up.route("GET", "/api/mcp", async () => { await sleep(150); mcpHits++; return { json: { location: { directory: DIR }, data: [] } }; });
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const p = await c.prompt({ directory: DIR, sessionID: "ses_x", parts: [{ type: "text", text: "x" }] });
    assert.ok(p.id, "prompt v2 отвечает сразу (api-map №7: асинхронный), длинный лимит не режет");
    const rv = await c.revert("ses_x", { directory: DIR, messageID: "msg_9" });
    assert.deepEqual(rv, { messageID: "msg_9", files: [] }, "реверт дождался slow-ответа");
    await c.mcpStatus({ directory: DIR });
    assert.equal(mcpHits, 1, "MCP-инициализация не оборвана");
  } finally { await up.close(); }
});

test("таймауты: внешний signal прерывает вызов → OcError code=aborted", { timeout: 10_000 }, async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    up.route("GET", "/api/agent", () => new Promise(() => {}));
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    await assert.rejects(() => c.listAgents({ signal: ac.signal }), (err) => {
      assert.ok(err instanceof OcError, "OcError");
      assert.equal(err.code, "aborted");
      return true;
    });
    assert.ok(Date.now() - t0 < 2000, "прервано сразу по сигналу, не по таймауту");
  } finally { await up.close(); }
});

test("таймауты: таблица DEFAULT_TIMEOUTS — длинные без короткого обрыва, короткие 10–30 с, events без таймаута", () => {
  const T = ocClientNs.DEFAULT_TIMEOUTS;
  assert.ok(T && typeof T === "object", "экспорт DEFAULT_TIMEOUTS");
  // длинные: обрывать нельзя (BUG-183 / CC-28)
  assert.equal(T.prompt, 600_000, "prompt — long (пусть и асинхронный, backstop как PROMPT_OPTS портала)");
  assert.equal(T.revert, 600_000, "реверт — снапшот-операция, без короткого обрыва");
  assert.equal(T.unrevert, 600_000);
  assert.equal(T.listMessages, 600_000, "история: длинная на медленной линии (CC-28)");
  assert.equal(T.runCommand, 600_000, "ход команды — полный ход агента (v1 держит запрос весь ход, BUG-183)");
  assert.ok(T.mcpStatus >= 120_000, `MCP ≥120 с (${T.mcpStatus}): не обрывать init (BUG-183)`);
  assert.ok(T.warmup >= 120_000, `warmup ≥120 с (${T.warmup})`);
  // короткие: 10–30 с
  const short = ["listSessions", "createSession", "getSession", "patchSession", "deleteSession", "abort", "sessionDiff",
    "busyMap", "listPermissions", "replyPermission", "listQuestions", "replyQuestion", "rejectQuestion",
    "disposeInstance", "listAgents", "listProviders", "configGet", "listProjects", "setSessionModel", "setSessionAgent",
    "listCommands"];
  for (const m of short) assert.ok(T[m] >= 10_000 && T[m] <= 30_000, `${m}=${T[m]} — в диапазоне 10–30 с`);
  assert.ok(T.healthInfo >= 5_000 && T.healthInfo <= 30_000, `healthInfo=${T.healthInfo}`);
  assert.equal(T.events, 0, "SSE без таймаута — управляется signal/close");
});

// ---- шаг 2, п.2: SSE-переписыватель (design §2, api-map §2) ------------------

test("SSE v2: дельты → полная message.part.updated с троттлингом, финал на .ended, порядок сохранён", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    const loc = { location: { directory: DIR } };
    up.emit({ type: "session.created", ...loc, data: { sessionID: "ses_1" } });
    up.emit({ type: "session.text.started", ...loc, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0 } });
    up.emit({ type: "session.text.delta", ...loc, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, delta: "При" } });
    up.emit({ type: "session.text.delta", ...loc, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, delta: "вет" } });
    await sleep(250); // окно троттлинга (~100 мс) истекло
    const parts = got.filter((e) => e.type === "message.part.updated");
    assert.ok(parts.length >= 1 && parts.length <= 2, `троттлинг: ${parts.length} эмитов на 2 дельты`);
    const p0 = parts[0];
    assert.equal(p0.directory, DIR, "directory для фильтра хаба");
    assert.equal(p0.properties.sessionID, "ses_1");
    assert.deepEqual(p0.properties.part, { id: "msg_a1:0:text", messageID: "msg_a1", type: "text", text: "Привет", time: {} }, "ПОЛНАЯ часть, не дельта");
    up.emit({ type: "session.text.ended", ...loc, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, text: "Привет, мир!" } });
    await sleep(20);
    const last = got.filter((e) => e.type === "message.part.updated").at(-1);
    assert.equal(last.properties.part.text, "Привет, мир!", "финал с полным текстом (data.text)");
    assert.equal(got[0].type, "session.updated", "session.created → session.updated (design §2)");
    stop.close();
  } finally { await up.close(); }
});

test("SSE v2: reasoning — своя часть type=reasoning; tool-события → tool-часть со state (input/content/error)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    const loc = { location: { directory: DIR } };
    const sid = { sessionID: "ses_1", assistantMessageID: "msg_a1" };
    up.emit({ type: "session.reasoning.delta", ...loc, data: { ...sid, ordinal: 0, delta: "ду" } });
    up.emit({ type: "session.reasoning.delta", ...loc, data: { ...sid, ordinal: 0, delta: "маю" } });
    up.emit({ type: "session.reasoning.ended", ...loc, data: { ...sid, ordinal: 0, text: "думаю" } });
    up.emit({ type: "session.tool.input.started", ...loc, data: { ...sid, id: "call_1", name: "read" } });
    up.emit({ type: "session.tool.called", ...loc, data: { ...sid, id: "call_1", input: { path: "a.txt" }, executed: false } });
    up.emit({ type: "session.tool.success", ...loc, data: { ...sid, id: "call_1", content: [{ type: "text", text: "ok" }], metadata: { truncated: false } } });
    await sleep(250);
    const reasoning = got.filter((e) => e.type === "message.part.updated" && e.properties.part.type === "reasoning");
    assert.equal(reasoning.at(-1).properties.part.text, "думаю", "накоплено и финализировано");
    const tool = got.filter((e) => e.type === "message.part.updated" && e.properties.part.type === "tool").map((e) => e.properties.part);
    assert.ok(tool.length >= 3, `tool-часть обновляется по событиям (${tool.length})`);
    assert.equal(tool[0].id, "call_1");
    assert.equal(tool[0].messageID, "msg_a1");
    assert.equal(tool[0].tool, "read");
    assert.deepEqual(tool.at(-1).state, { status: "completed", input: { path: "a.txt" }, content: [{ type: "text", text: "ok" }], metadata: { truncated: false } }, "финал success");
    stop.close();
  } finally { await up.close(); }
});

test("BUG-196: SSE v2 — события хода без location (execution.*, renamed) получают папку сессии: из прошлых событий или dirOf", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20], dirOf: (sid) => (sid === "ses_old" ? "C:/T/old" : null) });
    await up.waitForSubscription();
    // ses_1: папка известна из текстового события с location
    up.emit({ type: "session.text.delta", location: { directory: DIR }, data: { sessionID: "ses_1", assistantMessageID: "m1", ordinal: 0, delta: "x" } });
    up.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    up.emit({ type: "session.renamed", data: { sessionID: "ses_1", id: "ses_1", title: "Новое имя" } });
    // ses_old: событий с location не было — папку даёт dirOf (индекс сессий хаба)
    up.emit({ type: "session.execution.started", data: { sessionID: "ses_old" } });
    // неизвестная никому сессия — по-прежнему null (не угадываем)
    up.emit({ type: "session.execution.failed", data: { sessionID: "ses_x", error: { message: "e" } } });
    await sleep(250);
    const idle = got.find((e) => e.type === "session.idle");
    assert.equal(idle?.directory, DIR);
    const upd = got.find((e) => e.type === "session.updated" && e.properties.info.title === "Новое имя");
    assert.equal(upd?.directory, DIR);
    const busy = got.find((e) => e.type === "session.status" && e.properties.sessionID === "ses_old");
    assert.equal(busy?.directory, "C:/T/old");
    const err = got.find((e) => e.type === "session.error" && e.properties.sessionID === "ses_x");
    assert.equal(err?.directory, null);
    stop.close();
  } finally { await up.close(); }
});

test("SSE v2: несколько папок в одном глобальном потоке — directory у каждого; без location → directory null", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    const dirB = "C:\\Users\\USER\\.zai-tenants\\bob";
    up.emit({ type: "session.idle", location: { directory: DIR }, data: { sessionID: "ses_a" } });
    up.emit({ type: "session.idle", location: { directory: dirB }, data: { sessionID: "ses_b" } });
    // session.execution.* несут location нет (api-map §2) — BUG-196: папка сессии
    // берётся из её прошлых событий (раньше было null, и тенант событие не получал)
    up.emit({ type: "session.execution.failed", data: { sessionID: "ses_a", error: { type: "provider.no-route", message: "нет модели" } } });
    await sleep(30);
    const idles = got.filter((e) => e.type === "session.idle");
    assert.deepEqual(idles.map((e) => e.directory), [DIR, dirB], "один поток — разные папки");
    const err = got.find((e) => e.type === "session.error");
    assert.equal(err.directory, DIR, "без location — папка из прошлого события сессии (BUG-196)");
    assert.deepEqual(err.properties, { sessionID: "ses_a", error: { type: "provider.no-route", message: "нет модели", name: "provider.no-route", data: { message: "нет модели" } } }, "BUG-202: имя и data.message как в 1.x");
    stop.close();
  } finally { await up.close(); }
});

test("SSE v2: формы→вопросы, права, retry, deleted, неизвестный тип — passthrough с конвертом", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    const loc = { location: { directory: DIR } };
    up.emit({ type: "form.created", ...loc, data: { id: "form_1", sessionID: "ses_1", title: "Продолжить?", fields: [] } });
    up.emit({ type: "permission.asked", ...loc, data: { id: "per_1", sessionID: "ses_1", action: "read", resources: [".env"] } });
    up.emit({ type: "permission.replied", ...loc, data: { sessionID: "ses_1", requestID: "per_1", reply: "once" } });
    up.emit({ type: "session.retry.scheduled", ...loc, data: { sessionID: "ses_1", attempt: 2 } });
    up.emit({ type: "session.deleted", ...loc, data: { sessionID: "ses_1" } });
    up.emit({ type: "session.shell.requested", ...loc, data: { sessionID: "ses_1", command: "dir" } }); // неизвестный тип
    await sleep(30);
    const by = (t) => got.find((e) => e.type === t);
    assert.deepEqual(by("question.asked").properties, { id: "form_1", sessionID: "ses_1", questions: [], fields: [] }, "form.created → question.asked в форме 1.x (Э5, BUG-203)");
    assert.deepEqual(by("permission.asked").properties, { id: "per_1", sessionID: "ses_1", action: "read", resources: [".env"], permission: "read", patterns: [".env"], always: [], metadata: { command: ".env" } }, "BUG-205");
    assert.deepEqual(by("permission.replied").properties, { sessionID: "ses_1", requestID: "per_1", reply: "once" });
    assert.equal(by("session.status").properties.status, "retry", "retry выводится из session.retry.scheduled");
    const del = by("session.deleted");
    assert.deepEqual(del.properties.info, { id: "ses_1", directory: DIR }, "deleted несёт info как в 1.x (BUG-186 cleanup хаба)");
    const unk = by("session.shell.requested");
    assert.deepEqual(unk, { type: "session.shell.requested", properties: { sessionID: "ses_1", command: "dir" }, directory: DIR }, "неизвестный тип — passthrough, не падаем");
    stop.close();
  } finally { await up.close(); }
});

test("SSE v2: обрыв → реконнект с паузой и gap zai.resync; close() останавливает цикл", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    const connects1 = up.sseConnects;
    up.dropSubscriptions(); // обрыв потока
    await up.waitForSubscription(); // реконнект пришёл
    await sleep(30);
    assert.ok(up.sseConnects > connects1, "переподключился");
    assert.ok(got.some((e) => e.type === "zai.resync" && e.directory === null), "gap после реконнекта (Last-Event-ID нет)");
    stop.close();
    await sleep(30);
    const before = up.sseConnects;
    up.dropSubscriptions();
    await sleep(60);
    assert.equal(up.sseConnects, before, "после close() реконнектов нет");
  } finally { await up.close(); }
});

test("SSE v1: per-directory /event?directory= как есть, события 1.x без изменений + directory", async () => {
  const up = await startFakeOpencode({});
  try {
    const c = createOcClient({ api: "v1", base: up.url });
    const got = [];
    const stop = c.events({ directory: DIR, onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription(DIR);
    up.emit({ type: "session.idle", properties: { sessionID: "ses_a" } }, DIR);
    await sleep(20);
    const evt = got.find((e) => e.type === "session.idle");
    assert.deepEqual(evt, { type: "session.idle", properties: { sessionID: "ses_a" }, directory: DIR }, "1.x-событие без изменений, directory приклеен");
    stop.close();
  } finally { await up.close(); }
});

// ---- шаг 2, п.3: история (конвертер + ходок по курсорам, paginateMessages) ----

test("история v2: плоские сообщения → {info, parts}, маркеры idle/*-switched отфильтрованы (api-map §4)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, messages: { ses_c: [
    { id: "msg_5", type: "model-switched", model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "high" }, previous: { id: "glm-5.3-flash", providerID: "zai-coding-plan" } },
    { id: "msg_4", type: "assistant", agent: "build", model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "max" }, time: { created: 20, completed: 30 }, finish: "stop",
      content: [ { type: "reasoning", text: "думаю", time: {} }, { type: "text", text: "Привет" } ] },
    { id: "msg_3", type: "idle", outcome: "succeeded" },
    { id: "msg_2", type: "user", text: "ответь одним словом: привет", time: { created: 10 }, metadata: { turn: "t1" } },
  ] } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const out = await c.listMessages("ses_c", { directory: DIR });
    assert.deepEqual(out.messages.map((m) => m.info.id), ["msg_2", "msg_4"], "старые раньше, маркеры выброшены");
    const [u, a] = out.messages;
    assert.equal(u.info.role, "user");
    assert.deepEqual(u.info, { id: "msg_2", sessionID: "ses_c", role: "user", time: { created: 10 }, metadata: { turn: "t1" } }, "metadata едет в info (Э8)");
    assert.deepEqual(u.parts, [{ type: "text", text: "ответь одним словом: привет" }]);
    assert.equal(a.info.role, "assistant");
    assert.deepEqual(a.info, { id: "msg_4", sessionID: "ses_c", role: "assistant", providerID: "zai-coding-plan", modelID: "glm-5.3-flash", variant: "max", agent: "build", time: { created: 20, completed: 30 }, finish: "stop" }, "finish доехал в info (v2fix1: пробы ждут info.finish)");
    assert.deepEqual(a.parts.map((p) => ({ type: p.type, text: p.text })), [{ type: "reasoning", text: "думаю" }, { type: "text", text: "Привет" }]);
    assert.equal(out.hasMore, false, "взяли всё — дальше пусто");
    assert.equal(out.nextBefore, null);
  } finally { await up.close(); }
});

// ЗАЩИТА «закрыто при отказе» и точность истории (воркер v2fix1, 2026-11-08):
// на реальной форме v2 (api-map §4 + Э4 + стенд :4101) конвертер обязан нести
// finish/rawFinish/tokens/cost в info (пробы песочницы ждут info.finish,
// фронту нужны tokens.input/output/reasoning/total) и переводить tool-часть
// в лицо 1.x: callID/tool и state.output строкой (portal redactPart и пробы
// читают part.tool, state.status, state.output).
test("история v2: реальная форма стенда — finish/tokens/cost в info, tool-часть в лице 1.x (Э4)", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, messages: { ses_r: [
    { id: "msg_10", type: "assistant",
      time: { created: 2_000, streamed: 2_100, completed: 3_000 },
      agent: "Sandbox",
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "max" },
      content: [
        { type: "reasoning", text: "смотрю на файл", native: { reasoningField: "reasoning_content" }, time: { created: 2_100, completed: 2_200 } },
        { type: "tool", id: "call_f46e96f6c1bc4724b894b19f", name: "edit", executed: false,
          state: { status: "completed",
            input: { path: "C:\\w\\ws1\\exp1.txt", oldString: "alpha", newString: "beta" },
            content: [{ type: "text", text: "Edited exp1.txt (1 replacement)" }],
            metadata: { files: [{ file: "exp1.txt", patch: "Index: exp1.txt", status: "modified", additions: 1, deletions: 1 }], truncated: false } },
          time: { created: 2_300, ran: 2_400, completed: 2_500 } },
        { type: "text", text: "Готово" },
      ],
      finish: "stop", rawFinish: "stop", cost: 0,
      tokens: { input: 230, output: 145, reasoning: 30, cache: { read: 16064, write: 0 } } },
    { id: "msg_9", type: "user", text: "правь файл", time: { created: 1_000 } },
  ] } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const out = await c.listMessages("ses_r", { directory: DIR });
    assert.deepEqual(out.messages.map((m) => m.info.id), ["msg_9", "msg_10"]);
    const a = out.messages[1];
    // info: лицо 1.x — finish/rawFinish/tokens/cost выжили; tokens.total
    // синтезирован как в 1.x (input+output+reasoning+cache.read+cache.write)
    assert.deepEqual(a.info, {
      id: "msg_10", sessionID: "ses_r", role: "assistant",
      providerID: "zai-coding-plan", modelID: "glm-5.3-flash", variant: "max",
      agent: "Sandbox",
      time: { created: 2_000, streamed: 2_100, completed: 3_000 },
      finish: "stop", rawFinish: "stop", cost: 0,
      tokens: { input: 230, output: 145, reasoning: 30, cache: { read: 16064, write: 0 }, total: 16469 },
    });
    const tool = a.parts.find((p) => p.type === "tool");
    assert.ok(tool, "tool-часть в content[] доехала");
    assert.equal(tool.callID, "call_f46e96f6c1bc4724b894b19f", "1.x-псевдоним callID из v2 id");
    assert.equal(tool.tool, "edit", "1.x-псевдоним tool из v2 name");
    assert.equal(tool.state.status, "completed");
    assert.deepEqual(tool.state.input, { path: "C:\\w\\ws1\\exp1.txt", oldString: "alpha", newString: "beta" }, "input не тронут (пробы jail читают command)");
    assert.equal(tool.state.output, "Edited exp1.txt (1 replacement)", "state.output строкой — из state.content (лицо 1.x)");
    assert.ok(tool.state.metadata?.files?.[0]?.file === "exp1.txt", "metadata проехал");
  } finally { await up.close(); }
});

// plugin.list (GET /api/plugin, OpenAPI: «Retrieve enabled server plugins and
// their current status») — сырое {status, json, text}: гейт сервера ищет id
// плагина в тексте, форму не нормализуем. Нет маршрута (старый serve) — OcError.
test("pluginList v2: сырое тело /api/plugin; 404 старого serve — OcError", async () => {
  const up = await startFakeOpencodeV2({
    password: PWD,
    plugins: [{ id: "zai-tenant-v2", enabled: true, source: "file", active: true }],
  });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const out = await c.pluginList({ directory: DIR });
    assert.equal(out.status, 200);
    assert.ok(out.text.includes("zai-tenant-v2"), "id плагина в теле — форма не важна");
    const v1 = createOcClient({ api: "v1", base: up.url });
    await assert.rejects(() => v1.pluginList(), /v2-only/);
  } finally { await up.close(); }
  const old = await startFakeOpencodeV2({ password: PWD }); // без plugins — маршрута нет
  try {
    const c = createOcClient({ api: "v2", base: old.url, password: PWD });
    await assert.rejects(() => c.pluginList(), (err) => err instanceof OcError && err.status === 404);
  } finally { await old.close(); }
});

test("история v2: без before — limit новейших, oldest-first; ходка по ?before через курсорные страницы", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, messages: { ses_h: [
    { id: "m5", type: "user", text: "пять", time: { created: 5 } },
    { id: "m4", type: "user", text: "четыре", time: { created: 4 } },
    { id: "m3", type: "user", text: "три", time: { created: 3 } },
    { id: "m2", type: "user", text: "два", time: { created: 2 } },
    { id: "m1", type: "user", text: "один", time: { created: 1 } },
  ] } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    // страница 1: 2 новейших
    const p1 = await c.listMessages("ses_h", { directory: DIR, limit: 2 });
    assert.deepEqual(p1.messages.map((m) => m.info.id), ["m4", "m5"], "oldest-first внутри страницы");
    assert.equal(p1.hasMore, true);
    assert.equal(p1.nextBefore, "m4", "курсор — старейший в странице");
    // страница 2: строго старше m4 — ходок дергает курсорные страницы фейка (?limit&cursor=cN)
    const p2 = await c.listMessages("ses_h", { directory: DIR, before: "m4", limit: 2 });
    assert.deepEqual(p2.messages.map((m) => m.info.id), ["m2", "m3"]);
    assert.equal(p2.hasMore, true);
    assert.equal(p2.nextBefore, "m2");
    // страница 3: конец истории
    const p3 = await c.listMessages("ses_h", { directory: DIR, before: "m2", limit: 2 });
    assert.deepEqual(p3.messages.map((m) => m.info.id), ["m1"]);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextBefore, null, "конец — курсора нет (как paginateMessages)");
    // неизвестный before — та же ошибка, что у портала (proxy.js:101)
    await assert.rejects(() => c.listMessages("ses_h", { directory: DIR, before: "msg_missing" }), /unknown before cursor/);
  } finally { await up.close(); }
});

test("BUG-191: история v2 с limit > 200 — страницы upstream не больше 200, собрано ровно limit", async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ id: `m${String(450 - i).padStart(3, "0")}`, type: "user", text: `№${450 - i}`, time: { created: 450 - i } }));
  const up = await startFakeOpencodeV2({ password: PWD, messages: { ses_big: many } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const p = await c.listMessages("ses_big", { directory: DIR, limit: 400 });
    assert.equal(p.messages.length, 400);
    assert.equal(p.messages.at(-1).info.id, "m450", "новейшее — последним (oldest-first)");
    assert.equal(p.messages[0].info.id, "m051");
    assert.equal(p.hasMore, true);
    const lims = up.requests.filter((r) => r.path === "/api/session/ses_big/message").map((r) => Number(new URLSearchParams(r.query).get("limit")));
    assert.ok(lims.length >= 2 && lims.every((n) => n <= 200), `upstream limit ≤ 200: ${lims}`);
    const whole = await c.listMessages("ses_big", { directory: DIR, all: true, limit: 500 });
    assert.equal(whole.messages.length, 450, "all — вся история");
  } finally { await up.close(); }
});

// FEAT-16.3 (v2fix3, находка Claude на стенде :4174): сырая история v2 несёт
// служебные записи (idle, model-switched, agent-switched) вперемешку с
// сообщениями, а upstream-страница ?limit=N режется по СЫРЫМ записям. limit
// портала обязан считать только видимые сообщения: страница непустая, пока
// есть сообщения; next-before = id старейшего отданного; before с ним работает;
// на последней странице has-more = 0.
const sesMark = (extra = []) => [
  // новыми раньше: служебные записи СВЕРХУ (после ответа ассистента)
  { id: "msg_6", type: "agent-switched", agent: "build" },
  { id: "msg_5", type: "model-switched", model: { id: "glm-5.3-flash", providerID: "zai-coding-plan" }, previous: { id: "glm-5.3-flash", providerID: "zai-coding-plan" } },
  { id: "msg_4", type: "assistant", agent: "build", model: { id: "glm-5.3-flash", providerID: "zai-coding-plan" }, content: [{ type: "text", text: "ответ" }], time: { created: 40 } },
  { id: "msg_3", type: "idle", outcome: "succeeded" },
  { id: "msg_2", type: "user", text: "второй", time: { created: 20 } },
  ...extra,
  { id: "msg_1", type: "user", text: "первый", time: { created: 10 } },
];

test("история v2 (v2fix3): limit=1 со служебными записями — страница из ВИДИМЫХ сообщений, has-more/next-before по ним", async () => {
  const up = await startFakeOpencodeV2({ password: PWD, messages: { ses_m: sesMark() } });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const p1 = await c.listMessages("ses_m", { directory: DIR, limit: 1 });
    assert.deepEqual(p1.messages.map((m) => m.info.id), ["msg_4"], "новейшее видимое сообщение, страница не пустая");
    assert.equal(p1.hasMore, true, "в истории есть ещё сообщения");
    assert.equal(p1.nextBefore, "msg_4", "курсор = старейший отданный");
    // страница 2 по этому курсору: ходок добирает старые записи через маркеры
    const p2 = await c.listMessages("ses_m", { directory: DIR, before: p1.nextBefore, limit: 1 });
    assert.deepEqual(p2.messages.map((m) => m.info.id), ["msg_2"]);
    assert.equal(p2.hasMore, true);
    assert.equal(p2.nextBefore, "msg_2");
    // последняя страница: сообщений больше нет → has-more = 0
    const p3 = await c.listMessages("ses_m", { directory: DIR, before: p2.nextBefore, limit: 1 });
    assert.deepEqual(p3.messages.map((m) => m.info.id), ["msg_1"]);
    assert.equal(p3.hasMore, false, "конец истории");
    assert.equal(p3.nextBefore, null);
  } finally { await up.close(); }
});

test("история v2 (v2fix3): проход всех страниц через курсор собирает ровно видимую историю, без дублей и пропусков", async () => {
  // маркеры вперемешку и ХВОСТ маркеров старше самого старого сообщения:
  // конец upstream не обязан совпадать с концом видимой истории
  const up = await startFakeOpencodeV2({
    password: PWD,
    messages: { ses_w: sesMark([{ id: "msg_t1", type: "idle", outcome: "failed" }, { id: "msg_t2", type: "agent-switched", agent: "plan" }]) },
  });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    const seen = [];
    let page = await c.listMessages("ses_w", { directory: DIR, limit: 2 });
    let guard = 0;
    for (;;) {
      seen.push(...page.messages.map((m) => m.info.id));
      if (!page.hasMore) break;
      assert.ok(page.messages.length > 0, "страница непустая, пока есть сообщения");
      page = await c.listMessages("ses_w", { directory: DIR, before: page.nextBefore, limit: 2 });
      assert.ok(++guard < 50, "ходка не зациклилась");
    }
    // страницы ходки — от новейших к старым, внутри страницы старые раньше:
    // сверяем КАК МНОЖЕСТВО — каждый видимый id ровно один раз (без пропусков)
    assert.deepEqual([...seen].sort(), ["msg_1", "msg_2", "msg_4"], "ровно видимая история, каждый id по одному разу");
    assert.equal(new Set(seen).size, seen.length, "дублей нет");
  } finally { await up.close(); }
});

test("история v1: upstream отдаёт {info, parts} целиком (before не шлём) — нарезка локально по правилам paginateMessages", async () => {
  const up = await startFakeOpencode({ messages: { ses_v: [
    { info: { id: "a", sessionID: "ses_v", role: "user" }, parts: [{ type: "text", text: "1" }] },
    { info: { id: "b", sessionID: "ses_v", role: "assistant" }, parts: [{ type: "text", text: "2" }] },
    { info: { id: "c", sessionID: "ses_v", role: "user" }, parts: [{ type: "text", text: "3" }] },
    { info: { id: "d", sessionID: "ses_v", role: "assistant" }, parts: [{ type: "text", text: "4" }] },
  ] } });
  try {
    let sawQuery = null;
    up.route("GET", "/session/ses_v/message", (req, body, url) => { sawQuery = url.search; return { json: up.state.messages.ses_v }; });
    const c = createOcClient({ api: "v1", base: up.url });
    const p1 = await c.listMessages("ses_v", { limit: 2 });
    assert.deepEqual(p1.messages.map((m) => m.info.id), ["c", "d"]);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.nextBefore, "c");
    assert.equal((sawQuery ?? "").includes("before"), false, "1.x отвечает 400 на before — не шлём (proxy.js:81)");
    const p2 = await c.listMessages("ses_v", { before: "c", limit: 2 });
    assert.deepEqual(p2.messages.map((m) => m.info.id), ["a", "b"]);
    assert.equal(p2.hasMore, false);
    await assert.rejects(() => c.listMessages("ses_v", { before: "zzz" }), /unknown before cursor/);
  } finally { await up.close(); }
});

// ---- шаг 2, п.4: вопросы ↔ формы (tasks 2.5, Э5) ------------------------------

test("формы v2: listQuestions разворачивает конверт /api/form; reply требует {answer:{...}} (Э5), reject — DELETE", async () => {
  const forms = [{ id: "form_1", sessionID: "ses_f1", title: "Продолжить?", fields: [{ id: "q0", label: "Ехать?", type: "boolean" }] }];
  const up = await startFakeOpencodeV2({ password: PWD, forms });
  try {
    const c = createOcClient({ api: "v2", base: up.url, password: PWD });
    assert.deepEqual(await c.listQuestions({ directory: DIR }), [{ id: "form_1", sessionID: "ses_f1", questions: [{ key: "q0", header: "Ехать?", question: "Ехать?", options: [], multiple: false, custom: false }], fields: forms[0].fields }], "BUG-203: Form.Info → вопрос 1.x (kind/directory добавит хаб)");
    const ok = await c.replyQuestion({ directory: DIR, sessionID: "ses_f1", formID: "form_1", answer: { q0: true } });
    assert.equal(ok, true);
    const rep = up.requests.find((r) => r.path === "/api/session/ses_f1/form/form_1/reply");
    assert.ok(rep, "reply дошёл");
    assert.deepEqual(rep.body, { answer: { q0: true } }, "тело {answer:{поле: значение}} — иначе живой v2 даёт 400 (Э5)");
    // плоский answer — отказ ДО похода на фейк
    await assert.rejects(() => c.replyQuestion({ directory: DIR, sessionID: "ses_f1", formID: "form_1", answer: "да" }), /answer/);
    const ok2 = await c.rejectQuestion({ directory: DIR, sessionID: "ses_f1", formID: "form_1", message: "передумали" });
    assert.equal(ok2, true);
    const del = up.requests.find((r) => r.method === "DELETE" && r.path === "/api/session/ses_f1/form/form_1");
    assert.ok(del, "reject — DELETE …/form/{fid}");
    assert.equal(del.query, "?message=%D0%BF%D0%B5%D1%80%D0%B5%D0%B4%D1%83%D0%BC%D0%B0%D0%BB%D0%B8", "message — в query");
  } finally { await up.close(); }
});

test("формы v1: listQuestions — GET /question, replyQuestion — {answers: string[][]}, rejectQuestion — /question/:id/reject", async () => {
  const questions = [{ id: "q_1", sessionID: "ses_v1", questions: [{ question: "Продолжить?", choices: ["Да", "Нет"] }] }];
  const up = await startFakeOpencode({ questions });
  try {
    const c = createOcClient({ api: "v1", base: up.url });
    assert.deepEqual(await c.listQuestions({ directory: DIR }), questions, "1.x список как есть");
    let replyBody = null;
    up.route("POST", "/question/q_1/reply", (req, body) => { replyBody = body; return { json: true }; });
    let rejectQuery = null;
    up.route("POST", "/question/q_1/reject", (req, body, url) => { rejectQuery = url.search; return { json: true }; });
    assert.equal(await c.replyQuestion({ directory: DIR, requestID: "q_1", answers: [["Да"]] }), true);
    assert.deepEqual(replyBody, { answers: [["Да"]] }, "форма ответа 1.x (валидация lib/mock.js:88)");
    assert.equal(await c.rejectQuestion({ directory: DIR, requestID: "q_1" }), true);
    assert.equal(rejectQuery, "?directory=" + encodeURIComponent(DIR));
  } finally { await up.close(); }
});


// ---- v1: тонкая обёртка — РОВНО то, что портал получает от 1.19.5 -----------

const v1Up = (over = {}) => startFakeOpencode({ ...over });
const v1C = (up) => createOcClient({ api: "v1", base: up.url });

test("v1: пароль не нужен — запросы идут без Authorization", async () => {
  const up = await v1Up();
  try {
    await v1C(up).listSessions({ directory: DIR });
    assert.equal(up.requests[0].headers.authorization, undefined);
    assert.equal(up.requests[0].path, "/session");
  } finally { await up.close(); }
});

test("v1 сессии: GET/POST /session (+?directory=), формы 1.19.5 без изменений (№1–5)", async () => {
  const sessions = [{ id: "ses_a", directory: DIR, title: "Чат", time: {} }];
  const up = await v1Up({ sessions });
  try {
    const c = v1C(up);
    assert.deepEqual(await c.listSessions({ directory: DIR }), sessions, "голый массив как есть");
    assert.equal(up.requests[0].path, "/session");
    assert.ok(up.requests[0].directory, "directory в query");
    up.route("POST", "/session", () => ({ json: { id: "ses_new", directory: DIR, title: "Новый чат" } }));
    const created = await c.createSession({ directory: DIR, title: "Новый чат", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "orchestrator" });
    const req = up.requests.find((r) => r.method === "POST" && r.path === "/session");
    assert.deepEqual(req.body, { title: "Новый чат", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "orchestrator" });
    assert.deepEqual(created, { id: "ses_new", directory: DIR, title: "Новый чат" }, "ответ как есть");
    up.route("GET", "/session/ses_a", () => ({ json: sessions[0] }));
    assert.deepEqual(await c.getSession("ses_a", { directory: DIR }), sessions[0]);
    up.route("PATCH", "/session/ses_a", () => ({ json: { id: "ses_a", title: "Новое имя" } }));
    assert.deepEqual(await c.patchSession("ses_a", { directory: DIR, title: "Новое имя" }), { id: "ses_a", title: "Новое имя" });
    const patchReq = up.requests.find((r) => r.method === "PATCH");
    assert.deepEqual(patchReq.body, { title: "Новое имя" });
    up.route("DELETE", "/session/ses_a", () => ({ json: true }));
    assert.equal(await c.deleteSession("ses_a", { directory: DIR }), true);
    assert.ok(up.requests.some((r) => r.method === "DELETE" && r.path === "/session/ses_a"));
  } finally { await up.close(); }
});

test("v1 prompt/abort: prompt_async с телом {parts, model, agent, variant, system} как есть (№7–8)", async () => {
  const up = await v1Up();
  try {
    const c = v1C(up);
    const body = {
      parts: [{ type: "text", text: "привет" }],
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "orchestrator",
      variant: "max",
      system: "инструкция",
    };
    up.route("POST", "/session/ses_a/prompt_async", () => ({ json: { id: "msg_u1" } }));
    const sent = await c.prompt({ directory: DIR, sessionID: "ses_a", ...body });
    const req = up.requests.find((r) => r.method === "POST" && r.path === "/session/ses_a/prompt_async");
    assert.ok(req, "путь /session/ses_a/prompt_async");
    assert.deepEqual(req.body, body, "тело v1 без изменений");
    assert.deepEqual(sent, { id: "msg_u1" });
    up.route("POST", "/session/ses_a/abort", () => ({ json: { ok: true } }));
    assert.deepEqual(await c.abort("ses_a", { directory: DIR }), { ok: true });
    assert.ok(up.requests.some((r) => r.path === "/session/ses_a/abort" && r.method === "POST"));
  } finally { await up.close(); }
});

test("v1 busyMap/diff: /session/status без directory, /session/:id/diff?messageID= (№9–10)", async () => {
  const up = await v1Up({ status: { ses_a: { type: "busy" } } });
  try {
    const c = v1C(up);
    assert.deepEqual(await c.busyMap(), { ses_a: { type: "busy" } });
    assert.ok(up.requests[0].path.startsWith("/session/status"), up.requests[0].path);
    up.route("GET", "/session/ses_a/diff", (rq, b, u) => ({ json: [{ messageID: u.searchParams.get("messageID") ?? null, path: "a.txt", action: "restore" }] }));
    const diff = await c.sessionDiff("ses_a", { directory: DIR, messageID: "msg_9" });
    const req = up.requests.find((r) => r.path === "/session/ses_a/diff");
    assert.equal(req.directory, DIR, "directory в query");
    assert.equal(diff[0].messageID, "msg_9", "messageID передан в query");
    assert.deepEqual(diff[0].path, "a.txt");
  } finally { await up.close(); }
});

test("v1 revert/unrevert: POST /session/:id/revert{messageID}, /unrevert (№11–12)", async () => {
  const up = await v1Up();
  try {
    const c = v1C(up);
    up.route("POST", "/session/ses_a/revert", () => ({ json: { ok: true, revert: { messageID: "msg_9" }, files: [] } }));
    assert.deepEqual(await c.revert("ses_a", { directory: DIR, messageID: "msg_9" }), { ok: true, revert: { messageID: "msg_9" }, files: [] });
    const req = up.requests.find((r) => r.path === "/session/ses_a/revert");
    assert.deepEqual(req.body, { messageID: "msg_9" });
    up.route("POST", "/session/ses_a/unrevert", () => ({ json: { ok: true } }));
    assert.deepEqual(await c.unrevert("ses_a", { directory: DIR }), { ok: true });
  } finally { await up.close(); }
});

test("v1 права и dispose: /permission, /permission/:id/reply{reply}, /instance/dispose (№14,16,19)", async () => {
  const permissions = [{ id: "per_1", sessionID: "ses_a", permission: "read" }];
  const up = await v1Up({ permissions });
  try {
    const c = v1C(up);
    assert.deepEqual(await c.listPermissions({ directory: DIR }), permissions);
    assert.equal(up.requests[0].path, "/permission");
    up.route("POST", "/permission/per_1/reply", () => ({ json: { ok: true } }));
    assert.deepEqual(await c.replyPermission({ directory: DIR, sessionID: "ses_a", requestID: "per_1", reply: "once" }), { ok: true });
    const req = up.requests.find((r) => r.path === "/permission/per_1/reply");
    assert.deepEqual(req.body, { reply: "once" }, "тело 1.x — reply, не decision");
    up.route("POST", "/instance/dispose", () => ({ json: true }));
    assert.equal(await c.disposeInstance({ directory: DIR }), true);
    const d = up.requests.find((r) => r.path === "/instance/dispose");
    assert.equal(d.method, "POST");
    assert.equal(d.directory, DIR);
  } finally { await up.close(); }
});

test("v1 каталоги: /mcp карта, /agent, /provider{all,default,connected}, /config, /project, /global/health (№20–23,25–26)", async () => {
  const up = await v1Up();
  try {
    const c = v1C(up);
    assert.deepEqual(await c.mcpStatus({ directory: DIR }), {}, "пасsthrough карты mcp");
    assert.equal(up.requests.find((r) => r.path === "/mcp").directory, DIR);
    assert.deepEqual(await c.listAgents(), []);
    const catalog = { all: [{ id: "zai-coding-plan", models: {} }], default: { "zai-coding-plan": "glm-5.3" }, connected: ["zai-coding-plan"] };
    up.route("GET", "/provider", () => ({ json: catalog }));
    assert.deepEqual(await c.listProviders({ directory: DIR }), catalog, "пасsthrough {all, default, connected}");
    const cfg = { default_agent: "orchestrator", model: "zai-coding-plan/glm-5.3", snapshot: false };
    up.route("GET", "/config", () => ({ json: cfg }));
    assert.deepEqual(await c.configGet({ directory: DIR }), cfg, "пасsthrough конфига 1.x");
    up.route("GET", "/project", () => ({ json: [{ id: "p1", worktree: DIR }] }));
    assert.deepEqual(await c.listProjects(), [{ id: "p1", worktree: DIR }]);
    up.route("GET", "/global/health", () => ({ json: { healthy: true, version: "1.19.5" } }));
    assert.deepEqual(await c.healthInfo(), { healthy: true, version: "1.19.5" });
    assert.equal(up.requests.find((r) => r.path === "/global/health").path, "/global/health");
  } finally { await up.close(); }
});

test("v1 ошибки: 500 и сеть — та же OcError, что и у v2 (единая форма)", async () => {
  const up = await v1Up();
  try {
    up.route("GET", "/mcp", () => ({ status: 503, json: { error: "poisoned" } }));
    const c = v1C(up);
    await assert.rejects(() => c.mcpStatus({ directory: DIR }), (err) => {
      assert.ok(err instanceof OcError);
      assert.equal(err.status, 503);
      assert.deepEqual(err.body, { error: "poisoned" });
      return true;
    });
    const dead = createOcClient({ api: "v1", base: up.url, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(() => dead.listSessions({ directory: DIR }), (err) => err instanceof OcError && err.status === 0);
  } finally { await up.close(); }
});

// ---- интерфейс design §1.2 есть у обоих транспортов --------------------------

test("интерфейс: все методы design §1.2 (+2 v2-only) объявлены у v1 и v2", () => {
  const expected = [
    "listSessions", "createSession", "getSession", "patchSession", "deleteSession",
    "listMessages", "prompt", "abort", "busyMap", "sessionDiff", "revert", "unrevert",
    "events", "listPermissions", "replyPermission", "listQuestions", "replyQuestion", "rejectQuestion",
    "disposeInstance", "mcpStatus", "listAgents", "listProviders", "configGet", "warmup",
    "listProjects", "healthInfo", "setSessionModel", "setSessionAgent",
  ].sort();
  for (const api of ["v1", "v2"]) {
    const c = createOcClient({ api, base: "http://127.0.0.1:1", password: "x" });
    assert.deepEqual(Object.keys(c).sort(), expected, api);
  }
});

