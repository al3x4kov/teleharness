// BUG-08.8 (клиент): длинная история грузится страницами (limit) и
// догружается вверх по курсору `before` — прокрутка к началу ленты,
// индикатор загрузки, позиция прокрутки не прыгает, «Начало чата», ошибка с
// «Повторить». Сервер режет страницы так же, как lib/proxy.js (paginateMessages).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";
import { paginateMessages } from "../../lib/proxy.js";

let ui, t$;
before(async () => {
  ui = await loadUI({ ChatView: "src/components/views/ChatView.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.firstTexts.value = {};
  installFetch();
});

const SID = "ses_long";
const NOW = Date.now();
const SESSION = { id: SID, title: "Длинный чат", directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } };
const msg = (i) => {
  const role = i % 2 ? "assistant" : "user";
  const id = `m${String(i).padStart(4, "0")}`;
  return {
    info: { id, role, sessionID: SID, time: { created: NOW + i, completed: role === "assistant" ? NOW + i : undefined } },
    parts: [{ id: `p_${id}`, type: "text", text: `сообщение ${i}` }],
  };
};
const HISTORY = Array.from({ length: 250 }, (_, i) => msg(i));
const asks = () => fetchCalls.filter((c) => c.path === `/zai/api/session/${SID}/message`);
const texts = (root) => $$(root, ".msg").map((el) => el.textContent);

// gate(query) → promise to hold a page; fail(query) → true to answer 502.
function routes({ gate = null, fail = null } = {}) {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [SESSION] },
    {
      method: "GET",
      path: `/zai/api/session/${SID}/message`,
      reply: async (c) => {
        if (gate) await gate(c.query);
        if (fail?.(c.query)) return { status: 502, body: { error: "upstream error" } };
        const limit = c.query.limit ? Number(c.query.limit) : null;
        const r = paginateMessages(HISTORY, { limit, before: c.query.before ?? null });
        const headers = { "x-zai-has-more": r.hasMore ? "1" : "0", ...(r.nextBefore ? { "x-zai-next-before": r.nextBefore } : {}) };
        return { status: 200, body: r.page, headers };
      },
    },
  ]);
}

// happy-dom has no layout: every rendered message is 100px tall.
function fakeLayout(root) {
  const el = $(root, ".chat-messages");
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => $$(root, ".msg").length * 100 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 800 });
  return el;
}
function scrollTo(el, top) {
  el.scrollTop = top;
  t$.fire(el, "scroll");
}

async function openLong(opts) {
  routes(opts);
  ui.store.sessions.value = [SESSION];
  const h = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(h.root, ".msg").length > 0);
  return h;
}

test("BUG-08.8: первая страница — только последние сообщения (limit), без всей истории", async () => {
  const { root } = await openLong();
  assert.equal(asks().length, 1);
  assert.ok(Number(asks()[0].query.limit) > 0, "история запрошена с limit");
  assert.equal(asks()[0].query.before, undefined);
  assert.equal(asks()[0].query.directory, "C:\\Users\\USER");
  const act = ui.store.active.value;
  assert.equal(act.messages.length, Number(asks()[0].query.limit));
  assert.equal(act.hasOlder, true);
  assert.equal(act.messages.at(-1).info.id, "m0249", "последнее сообщение на месте");
  assert.equal(!!byText(root, "button.load-more", "Загрузить ещё"), true);
});

test("BUG-08.8: прокрутка к началу догружает старые сообщения по before; индикатор; позиция не прыгает; «Начало чата» в конце", async () => {
  let release = null;
  const { root } = await openLong({ gate: (q) => (q.before ? new Promise((r) => (release = r)) : null) });
  const el = fakeLayout(root);
  const limit = Number(asks()[0].query.limit);
  // 1) верх ленты: сначала раскрывается то, что уже в сторе (окно 50 → 100)
  while ($$(root, ".msg").length < limit) {
    scrollTo(el, 0);
    await t$.flush();
  }
  assert.equal(asks().length, 1, "пока в сторе есть нераскрытое — без сети");
  // 2) дальше — страница с сервера по курсору
  const firstOnScreen = texts(root)[0];
  scrollTo(el, 10);
  await t$.waitFor(() => asks().length === 2);
  assert.equal(asks()[1].query.before, ui.store.active.value.messages[0].info.id, "курсор = самое старое загруженное");
  const status = await t$.waitFor(() => $(root, '.load-more[role="status"]'));
  assert.match(status.textContent, /Загружаю/);
  assert.equal(!!byText(root, "button.load-more", "Загрузить ещё"), false, "кнопки нет, пока страница едет");
  // повторный скролл к верху во время загрузки не шлёт дубль
  scrollTo(el, 0);
  await t$.flush();
  assert.equal(asks().length, 2);
  const h0 = el.scrollHeight;
  release();
  await t$.waitFor(() => $$(root, ".msg").length === 2 * limit);
  await t$.flush();
  // тот же верхний пузырь остался под глазами: scrollTop сдвинут ровно на прирост высоты
  assert.equal(el.scrollTop, 10 + (el.scrollHeight - h0));
  assert.ok(texts(root).indexOf(firstOnScreen) === limit, "старые сообщения встали ВЫШЕ прежних");
  assert.equal(texts(root)[0], "сообщение 50");
  // 3) последняя страница → «Начало чата», кнопки нет, лишних запросов нет
  scrollTo(el, 0);
  await t$.waitFor(() => asks().length === 3);
  release();
  await t$.waitFor(() => texts(root)[0] === "сообщение 0");
  await t$.flush();
  assert.equal($$(root, ".msg").length, 250);
  assert.equal(!!$(root, "button.load-more"), false);
  assert.equal(!!byText(root, ".history-start", "Начало чата"), true);
  scrollTo(el, 0);
  await t$.flush();
  assert.equal(asks().length, 3, "после начала истории сеть молчит");
});

test("BUG-08.8: сбой догрузки — «Не загрузилось · Повторить», без авто-повтора по скроллу; «Повторить» догружает", async () => {
  let broken = true;
  const { root } = await openLong({ fail: (q) => Boolean(q.before) && broken });
  const el = fakeLayout(root);
  const limit = Number(asks()[0].query.limit);
  while ($$(root, ".msg").length < limit) {
    scrollTo(el, 0);
    await t$.flush();
  }
  scrollTo(el, 0);
  const retry = await t$.waitFor(() => byText(root, "button.load-more", "Повторить"));
  assert.equal(asks().length, 2);
  scrollTo(el, 0);
  await t$.flush();
  assert.equal(asks().length, 2, "скролл не долбит упавший запрос");
  broken = false;
  t$.click(retry);
  await t$.waitFor(() => $$(root, ".msg").length === 2 * limit);
  assert.equal(asks()[2].query.before, asks()[1].query.before);
});

test("BUG-08.8: resync/idle после догрузки не выбрасывает уже загруженные старые страницы", async () => {
  const { root } = await openLong();
  const limit = Number(asks()[0].query.limit);
  await ui.store.loadOlder(SID);
  await t$.flush();
  assert.equal(ui.store.active.value.messages.length, 2 * limit);
  await ui.store.resync();
  await t$.flush(10);
  const act = ui.store.active.value;
  assert.equal(act.messages.length, 2 * limit, "старые страницы на месте");
  assert.equal(act.messages[0].info.id, "m0050");
  assert.equal(act.olderCursor, "m0050");
  assert.equal(act.hasOlder, true);
  assert.equal(new Set(act.messages.map((m) => m.info.id)).size, act.messages.length, "без дублей");
  assert.ok(root);
});

test("BUG-08.8: короткий чат — одна страница, ни кнопки, ни «Начало чата», заголовок по первому вопросу", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [{ ...SESSION, title: "" }] },
    {
      method: "GET",
      path: `/zai/api/session/${SID}/message`,
      reply: (c) => {
        const r = paginateMessages(HISTORY.slice(0, 4), { limit: Number(c.query.limit) });
        return { status: 200, body: r.page, headers: { "x-zai-has-more": "0" } };
      },
    },
  ]);
  ui.store.sessions.value = [{ ...SESSION, title: "" }];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length === 4);
  assert.equal(!!$(root, ".load-more"), false);
  assert.equal(!!$(root, ".history-start"), false);
  assert.equal($(root, "h1.chat-title").textContent, "сообщение 0");
});

test("BUG-08.8: длинный чат без заголовка — шапка не выдаёт середину истории за первый вопрос", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [{ ...SESSION, title: "" }] },
    {
      method: "GET",
      path: `/zai/api/session/${SID}/message`,
      reply: (c) => {
        const r = paginateMessages(HISTORY, { limit: Number(c.query.limit) });
        return { status: 200, body: r.page, headers: { "x-zai-has-more": r.hasMore ? "1" : "0", "x-zai-next-before": r.nextBefore } };
      },
    },
  ]);
  ui.store.sessions.value = [{ ...SESSION, title: "" }];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length > 0);
  assert.equal($(root, "h1.chat-title").textContent, "Без названия");
  assert.equal(ui.store.firstTexts.value[SID], undefined);
});

test("BUG-08.8: сервер без пагинации (отдаёт всё на любой запрос) — страница без новых сообщений = начало истории, без бесконечной догрузки", async () => {
  // мок zai-qa и старые сервера игнорируют limit/before и не шлют x-zai-has-more
  const ALL = HISTORY.slice(0, 120);
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => ALL },
  ]);
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length > 0);
  const el = fakeLayout(root);
  for (let i = 0; i < 12; i++) {
    scrollTo(el, 0);
    await t$.flush();
  }
  await t$.flush();
  assert.equal($$(root, ".msg").length, 120);
  assert.equal(!!byText(root, ".history-start", "Начало чата"), true, "дубли вместо старых сообщений = начало истории");
  assert.ok(asks().length <= 2, `после пустой догрузки сеть молчит (запросов: ${asks().length})`);
});
