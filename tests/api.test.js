// L1 (TASK-14.9): src/lib/api.js — построение URL (/zai/api/..., ?directory=),
// заголовки/JSON, 401 → onUnauthorized (BUG-007: AppShell переводит me=false →
// LoginView), сетевая ошибка → throw без status → notice в store.
// Без сети и серверов: globalThis.fetch / EventSource подменяются фейками,
// таймеры notice — через mock.timers.
// Run: node --test tests/api.test.js
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { api, onUnauthorized, openEvents } from "../src/lib/api.js";
import { active, me, notice, sessions, setNotice, send, openSession, boot, loadOlder } from "../src/lib/store.js";

const realFetch = globalThis.fetch;
let calls;

// Фейковый fetch: route(url, init) → {status, body} | Error (бросается).
function fakeFetch(route = () => ({ status: 200, body: {} })) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = route(String(url), init);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const raw = r.raw !== undefined ? r.raw : r.body === undefined ? "" : JSON.stringify(r.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(raw),
    };
  };
}

beforeEach(() => fakeFetch());
afterEach(() => {
  globalThis.fetch = realFetch;
  onUnauthorized(null);
});

// ---- построение URL / метод / тело ------------------------------------------

test("GET-ручки бьют в /zai/api/<path> без тела и заголовков", async () => {
  fakeFetch(() => ({ body: [{ id: "s1" }] }));
  assert.deepEqual(await api.listSessions(), [{ id: "s1" }]);
  assert.equal(calls[0].url, "/zai/api/session");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers, undefined, "без тела — без content-type");

  const map = [
    ["getDialogs", "/zai/api/dialogs"],
    ["getProvider", "/zai/api/provider"],
    ["getAgents", "/zai/api/agent"],
    ["getProjects", "/zai/api/project"],
    ["getMcp", "/zai/api/mcp"],
    ["getSessionStatus", "/zai/api/status"],
    ["getHost", "/zai/api/host"],
    ["getUsage", "/zai/api/usage"],
    ["adminUsers", "/zai/api/admin/users"],
  ];
  for (const [fn, url] of map) {
    fakeFetch(() => ({ body: { ok: true } }));
    assert.deepEqual(await api[fn](), { ok: true }, fn);
    assert.equal(calls[0].url, url, fn);
    assert.equal(calls[0].init.method, "GET", fn);
  }
});

test("тело уходит JSON-строкой с content-type application/json", async () => {
  fakeFetch(() => ({ body: { id: "ses_new" } }));
  const body = { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "Sisyphus - ultraworker" };
  await api.createSession(null, body);
  assert.equal(calls[0].url, "/zai/api/session", "без directory — без query");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
});

test("createSession: body по умолчанию {} и null → {}; directory → ?directory= (Windows-путь кодируется)", async () => {
  await api.createSession("D:\\Проекты\\zai");
  assert.equal(calls[0].url, `/zai/api/session?${new URLSearchParams({ directory: "D:\\Проекты\\zai" })}`);
  assert.equal(new URL(calls[0].url, "http://x").searchParams.get("directory"), "D:\\Проекты\\zai");
  assert.equal(calls[0].init.body, "{}");
  fakeFetch();
  await api.createSession("", null);
  assert.equal(calls[0].url, "/zai/api/session", "пустой directory не даёт ?directory=");
  assert.equal(calls[0].init.body, "{}");
});

test("id в пути кодируется (encodeURIComponent), session-ручки несут ?directory=", async () => {
  const dir = "C:\\Users\\USER\\Temp dir";
  const qs = `?${new URLSearchParams({ directory: dir })}`;
  const cases = [
    [() => api.patchBinding("a/b", { agent: "x" }, { directory: dir }), "PATCH", `/zai/api/session/a%2Fb/binding${qs}`],
    [() => api.patchSession("ses 1", { title: "t" }, { directory: dir }), "PATCH", `/zai/api/session/ses%201${qs}`],
    [() => api.deleteSession("ses_1", { directory: dir }), "DELETE", `/zai/api/session/ses_1${qs}`],
    [() => api.abort("ses_1", { directory: dir }), "POST", `/zai/api/session/ses_1/abort${qs}`],
    [() => api.replyPermission("per_1", { reply: "once" }, { directory: dir }), "POST", `/zai/api/permission/per_1/reply${qs}`],
    [() => api.replyQuestion("que_1", { answers: [["a"]] }, { directory: dir }), "POST", `/zai/api/question/que_1/reply${qs}`],
    [() => api.adminUpdateUser("u#1", { name: "n" }), "PATCH", "/zai/api/admin/users/u%231"],
    [() => api.adminRegenerateToken("u1"), "POST", "/zai/api/admin/users/u1/token"],
    [() => api.adminDeleteUser("u1"), "DELETE", "/zai/api/admin/users/u1"],
    [() => api.adminCreateUser({ name: "n" }), "POST", "/zai/api/admin/users"],
  ];
  for (const [call, method, url] of cases) {
    fakeFetch(() => ({ body: { ok: true } }));
    await call();
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].init.method, method);
  }
});

test("delete/abort/reply отдают true, adminDelete — {ok, warnings} независимо от тела ответа", async () => {
  fakeFetch(() => ({ raw: "not json" }));
  assert.equal(await api.deleteSession("s"), true);
  assert.equal(await api.abort("s"), true);
  assert.equal(await api.replyPermission("p", { reply: "reject" }), true);
  assert.equal(await api.replyQuestion("q", { answers: [] }), true);
  assert.deepEqual(await api.adminDeleteUser("u"), { ok: true, warnings: [] });
  assert.equal(calls[0].url, "/zai/api/session/s", "без directory — без query");
});

test("replyPermission/replyQuestion пробрасывают AbortSignal в fetch", async () => {
  const ac = new AbortController();
  await api.replyPermission("p", { reply: "once" }, { signal: ac.signal });
  await api.replyQuestion("q", { answers: [["x"]] }, { signal: ac.signal });
  assert.equal(calls[0].init.signal, ac.signal);
  assert.equal(calls[1].init.signal, ac.signal);
});

test("getMessages: limit/before/directory в query; без опций — без '?'", async () => {
  await api.getMessages("ses_1");
  assert.equal(calls[0].url, "/zai/api/session/ses_1/message");
  fakeFetch(() => ({ body: [] }));
  await api.getMessages("ses_1", { limit: 50, before: "msg_9", directory: "D:\\Portal" });
  const u = new URL(calls[0].url, "http://x");
  assert.equal(u.pathname, "/zai/api/session/ses_1/message");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(u.searchParams.get("before"), "msg_9");
  assert.equal(u.searchParams.get("directory"), "D:\\Portal");
  fakeFetch(() => ({ body: [] }));
  await api.getMessages("ses_1", { limit: 0, before: 0 });
  assert.equal(calls[0].url, "/zai/api/session/ses_1/message?limit=0&before=0", "0 — валидное значение, не отбрасывается");
});

test("prompt: 204 → true; JSON → тело; не-JSON 200 → true; directory в query", async () => {
  fakeFetch(() => ({ status: 204 }));
  assert.equal(await api.prompt("s", { parts: [] }, { directory: "D:\\x" }), true);
  assert.equal(calls[0].url, `/zai/api/session/s/prompt?${new URLSearchParams({ directory: "D:\\x" })}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { parts: [] });
  fakeFetch(() => ({ body: { info: { id: "m" } } }));
  assert.deepEqual(await api.prompt("s", { parts: [] }), { info: { id: "m" } });
  fakeFetch(() => ({ raw: "" }));
  assert.equal(await api.prompt("s", { parts: [] }), true);
});

test("auth: login → user, me → user, logout → true; маршруты /auth/*", async () => {
  fakeFetch(() => ({ body: { user: { id: "u1", name: "N", role: "admin" } } }));
  assert.deepEqual(await api.login("tok"), { id: "u1", name: "N", role: "admin" });
  assert.equal(calls[0].url, "/zai/api/auth/login");
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: "tok" });
  fakeFetch(() => ({ body: { user: { id: "u1" } } }));
  assert.deepEqual(await api.me(), { id: "u1" });
  assert.equal(calls[0].url, "/zai/api/auth/me");
  fakeFetch(() => ({ status: 204 }));
  assert.equal(await api.logout(), true);
  assert.equal(calls[0].url, "/zai/api/auth/logout");
  assert.equal(calls[0].init.method, "POST");
});

// ---- ошибки: 401 (BUG-007), HTTP-отказ, сеть ---------------------------------

test("BUG-007: 401 вне логина → onUnauthorized + throw со status=401", async () => {
  let hits = 0;
  onUnauthorized(() => hits++);
  fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
  await assert.rejects(api.listSessions(), (err) => err.status === 401 && /GET \/session failed: 401/.test(err.message));
  assert.equal(hits, 1);
  await assert.rejects(api.prompt("s", { parts: [] }), { status: 401 });
  assert.equal(hits, 2, "любая ручка, не только GET");
});

test("BUG-007: 401 на /auth/login (неверный токен) НЕ дёргает onUnauthorized", async () => {
  let hits = 0;
  onUnauthorized(() => hits++);
  fakeFetch(() => ({ status: 401 }));
  await assert.rejects(api.login("bad"), { status: 401 });
  assert.equal(hits, 0, "ошибка логина показывается на самом LoginView, без сброса");
});

test("BUG-007: без подписчика 401 просто бросает (нет TypeError)", async () => {
  onUnauthorized(null);
  fakeFetch(() => ({ status: 401 }));
  await assert.rejects(api.me(), { status: 401 });
});

test("BUG-007: проводка AppShell (onUnauthorized → me=false) роняет UI на LoginView", async () => {
  // Повторяем то, что делает AppShell.jsx: подписчик ставит me.value = false.
  me.value = { id: "u1", name: "N", role: "user" };
  onUnauthorized(() => (me.value = false));
  fakeFetch(() => ({ status: 401 }));
  await assert.rejects(api.getHost(), { status: 401 });
  assert.equal(me.value, false);
});

test("boot(): 401 и сетевой сбой /auth/me → me=false (экран входа), успех → user", async () => {
  me.value = null;
  fakeFetch(() => ({ status: 401 }));
  await boot();
  assert.equal(me.value, false);
  me.value = null;
  fakeFetch(() => new TypeError("fetch failed"));
  await boot();
  assert.equal(me.value, false);
  me.value = null;
  fakeFetch(() => ({ body: { user: { id: "u2" } } }));
  await boot();
  assert.deepEqual(me.value, { id: "u2" });
  me.value = null;
});

test("не-2xx (кроме 401) → throw со status, onUnauthorized не вызывается", async () => {
  let hits = 0;
  onUnauthorized(() => hits++);
  for (const status of [400, 403, 404, 409, 500, 503]) {
    fakeFetch(() => ({ status }));
    await assert.rejects(api.getUsage(), (err) => err.status === status);
  }
  assert.equal(hits, 0);
});

test("сетевая ошибка: исходная ошибка fetch пробрасывается, status нет, onUnauthorized молчит", async () => {
  let hits = 0;
  onUnauthorized(() => hits++);
  const boom = new TypeError("fetch failed");
  fakeFetch(() => boom);
  await assert.rejects(api.listSessions(), (err) => err === boom && err.status === undefined);
  assert.equal(hits, 0);
});

// BUG-007/BUG-044 (store разнесён, Г5): причину неудачной отправки говорит сам
// пузырь (info.failReason: network → «проверьте соединение», rejected →
// «сервер отклонил»), а не глобальный notice.
test("send(): сетевой сбой → пузырь failed/network; HTTP-отказ → failed/rejected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  sessions.value = [];
  active.value = { id: "ses_n", title: "", status: "idle", messages: [] };
  fakeFetch(() => new TypeError("fetch failed"));
  await send({ text: "Привет" });
  assert.equal(active.value.status, "idle");
  assert.equal(active.value.messages.length, 1);
  assert.equal(active.value.messages[0].info.failed, true);
  assert.equal(active.value.messages[0].info.failReason, "network");

  active.value = { id: "ses_n", title: "", status: "idle", messages: [] };
  fakeFetch(() => ({ status: 500 }));
  await send({ text: "Ещё" });
  assert.equal(active.value.messages.at(-1).info.failed, true);
  assert.equal(active.value.messages.at(-1).info.failReason, "rejected");
  t.mock.timers.tick(8000);
  active.value = null;
});

test("setNotice: авто-сброс по таймеру, новый текст перезапускает таймер, null гасит сразу", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setNotice("раз", 1000);
  assert.equal(notice.value, "раз");
  t.mock.timers.tick(600);
  setNotice("два", 1000);
  t.mock.timers.tick(600);
  assert.equal(notice.value, "два", "старый таймер снят");
  t.mock.timers.tick(400);
  assert.equal(notice.value, null);
  setNotice("три");
  t.mock.timers.tick(5999);
  assert.equal(notice.value, "три", "дефолт 6000 мс");
  t.mock.timers.tick(1);
  assert.equal(notice.value, null);
  setNotice("x", 1000);
  setNotice(null);
  assert.equal(notice.value, null);
});

// ---- uploadFile / fileUrl ------------------------------------------------------

test("uploadFile: сырой поток в /upload?directory=&name=, content-type из file.type", async () => {
  fakeFetch(() => ({ body: { name: "a b.png", size: 3 } }));
  const file = { name: "a b.png", type: "image/png" };
  assert.deepEqual(await api.uploadFile(file, "D:\\Проект"), { name: "a b.png", size: 3 });
  const u = new URL(calls[0].url, "http://x");
  assert.equal(u.pathname, "/zai/api/upload");
  assert.equal(u.searchParams.get("directory"), "D:\\Проект");
  assert.equal(u.searchParams.get("name"), "a b.png");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "content-type": "image/png" });
  assert.equal(calls[0].init.body, file, "файл уходит как есть, без base64");
});

test("uploadFile: без type/name/directory → octet-stream, name=file, directory=''", async () => {
  fakeFetch(() => ({ body: {} }));
  await api.uploadFile({});
  const u = new URL(calls[0].url, "http://x");
  assert.equal(u.searchParams.get("directory"), "");
  assert.equal(u.searchParams.get("name"), "file");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/octet-stream" });
});

test("uploadFile: не-2xx → throw с err.status; 401 ведёт на экран входа (BUG-007, через request())", async () => {
  let hits = 0;
  onUnauthorized(() => hits++);
  fakeFetch(() => ({ status: 413 }));
  await assert.rejects(api.uploadFile({ name: "x" }, "D:\\"), (err) => err.status === 413 && /failed: 413/.test(err.message));
  assert.equal(hits, 0);
  fakeFetch(() => ({ status: 401 }));
  await assert.rejects(api.uploadFile({ name: "x" }, "D:\\"), /failed: 401/);
  assert.equal(hits, 1, "401 при загрузке → onUnauthorized");
});

test("fileUrl: inline и download=1, Windows-пути кодируются", () => {
  const inline = api.fileUrl("D:\\Portal\\zai", "out\\отчёт.md");
  const u = new URL(inline, "http://x");
  assert.equal(u.pathname, "/zai/api/file");
  assert.equal(u.searchParams.get("directory"), "D:\\Portal\\zai");
  assert.equal(u.searchParams.get("path"), "out\\отчёт.md");
  assert.equal(u.searchParams.has("download"), false);
  const dl = new URL(api.fileUrl(null, "a.txt", true), "http://x");
  assert.equal(dl.searchParams.get("directory"), "");
  assert.equal(dl.searchParams.get("download"), "1");
});

// ---- openEvents (EventSource-заглушка) -----------------------------------------

test("openEvents: /zai/api/event; JSON-события → onEvent, zai.resync → onResync, мусор игнорируется", () => {
  const RealES = globalThis.EventSource;
  let inst;
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      inst = this;
    }
    close() {
      this.closed = true;
    }
  };
  try {
    const events = [];
    let resyncs = 0;
    const h = openEvents({ onEvent: (e) => events.push(e), onResync: () => resyncs++ });
    assert.equal(inst.url, "/zai/api/event");
    inst.onmessage({ data: JSON.stringify({ type: "session.idle", properties: { sessionID: "s" } }) });
    inst.onmessage({ data: JSON.stringify({ type: "zai.resync" }) });
    inst.onmessage({ data: "not json" });
    inst.onmessage({ data: "null" });
    inst.onmessage({ data: JSON.stringify({ type: 5 }) });
    inst.onmessage({ data: JSON.stringify({ noType: true }) });
    assert.deepEqual(events, [{ type: "session.idle", properties: { sessionID: "s" } }]);
    assert.equal(resyncs, 1);
    h.close();
    assert.equal(inst.closed, true);

    // Без колбэков — не падает.
    openEvents();
    inst.onmessage({ data: JSON.stringify({ type: "x" }) });
    inst.onmessage({ data: JSON.stringify({ type: "zai.resync" }) });
  } finally {
    globalThis.EventSource = RealES;
  }
});

// ---- BUG-08.8: постраничная история ------------------------------------------------

test("BUG-08.8: история грузится постранично (openSession шлёт limit, догрузка через before)", async () => {
  sessions.value = [{ id: "ses_p", directory: "D:\\Portal" }];
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ info: { id: `m${from + i}`, role: "user" }, parts: [] }));
  fakeFetch((url) => {
    if (url.includes("/status")) return { body: {} };
    // без заголовков (старый сервер): полная страница = «может быть ещё», курсор — самый старый id
    return { body: url.includes("before=") ? page(3, 0) : page(100, 3) };
  });
  try {
    await openSession("ses_p");
    const first = new URL(calls.find((c) => c.url.includes("/message")).url, "http://x");
    assert.equal(first.searchParams.get("directory"), "D:\\Portal");
    assert.ok(first.searchParams.has("limit"), "первая страница ограничена limit");
    assert.equal(active.value.hasOlder, true);
    assert.equal(active.value.olderCursor, "m3");
    await loadOlder("ses_p");
    const second = new URL(calls.filter((c) => c.url.includes("/message")).at(-1).url, "http://x");
    assert.equal(second.searchParams.get("before"), "m3");
    assert.equal(active.value.messages.length, 103);
    assert.equal(active.value.messages[0].info.id, "m0");
    assert.equal(active.value.hasOlder, false, "неполная страница — начало истории");
  } finally {
    active.value = null;
    sessions.value = [];
  }
});

test("BUG-08.8: getMessagesPage читает x-zai-has-more / x-zai-next-before", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ info: { id: "m5" } }, { info: { id: "m6" } }],
    headers: { get: (k) => ({ "x-zai-has-more": "1", "x-zai-next-before": "m5" })[k] ?? null },
  });
  assert.deepEqual(await api.getMessagesPage("s", { limit: 2, before: "m7" }), {
    list: [{ info: { id: "m5" } }, { info: { id: "m6" } }],
    hasMore: true,
    nextBefore: "m5",
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [{ info: { id: "m0" } }], headers: { get: (k) => (k === "x-zai-has-more" ? "0" : null) } });
  assert.deepEqual(await api.getMessagesPage("s", { limit: 2 }), { list: [{ info: { id: "m0" } }], hasMore: false, nextBefore: null });
});
