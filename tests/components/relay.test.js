// FEAT-11.18 (шаг В): Relay в интерфейсе — пункт меню чата и лист выбора (кадр 3), кнопки на
// плашке лимита (кадр 1), отметка передачи в ленте (кадр 2), полоска «остаток на исходе» (кадр 6).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ChatView: "src/components/views/ChatView.jsx", menuItems: "src/components/ChatMenu.jsx#menuItems" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.busyMap.value = {};
  s.active.value = null;
  s.subscriptions.value = null;
  s.providerCfg.value = null;
  s.setNotice(null);
  s.me.value = null;
  installFetch();
});

const SID = "ses_relay";
const T0 = Date.UTC(2026, 10, 12, 11, 0, 0);
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const PROVIDERS = {
  all: [
    { id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" }, "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash" } } },
    { id: "anthropic", models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" }, "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" } } },
  ],
  connected: ["zai-coding-plan", "anthropic"],
  default: {},
};
const session = (teleharness) => ({ id: SID, title: "Миграция отчётов", directory: "C:\\Users\\USER", time: { created: T0, updated: T0 }, teleharness });
const msg = (id, role, at, text, extra = {}) => ({ info: { id, role, sessionID: SID, time: { created: at, completed: role === "assistant" ? at + 500 : undefined }, ...extra }, parts: [{ id: `p_${id}`, type: "text", text }] });
const HISTORY = [msg("u1", "user", T0, "Перенеси отчёты"), msg("a1", "assistant", T0 + 1000, "Перенёс три из пяти"), msg("u2", "user", T0 + 60_000, "Продолжай"), msg("a2", "assistant", T0 + 61_000, "Продолжаю с четвёртого")];

function routes({ teleharness, messages = HISTORY, extra = [], cards = [] } = {}) {
  const s = session(teleharness);
  installFetch([
    ...extra,
    { method: "GET", path: "/teleharness/api/session", reply: () => [s] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => messages },
    { method: "GET", path: "/teleharness/api/provider", reply: () => PROVIDERS },
    { method: "GET", path: "/teleharness/api/subscriptions", reply: () => ({ providers: cards }) },
    { method: "GET", path: "/teleharness/api/me/pins", reply: () => ({ ids: [], max: 200 }) },
  ]);
  return s;
}
async function openChat(opts) {
  const s = routes(opts);
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  ui.store.sessions.value = [s];
  await ui.store.loadProviders?.();
  const h = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(h.root, ".msg").length >= 2);
  return h;
}
const claudeBinding = { engine: "claude", model: OPUS, agent: null, prompted: true, source: "stored" };
const glmBinding = { engine: "opencode", model: GLM, agent: null, prompted: true, source: "stored" };

test("FEAT-11.18: menuItems — пункт передачи есть только с обработчиком; недоступен на пустом чате и во время хода", () => {
  assert.deepEqual(ui.menuItems({}).map((i) => i.id), ["pin", "rename", "delete"]);
  const it = (o) => ui.menuItems({ relay: true, ...o }).find((i) => i.id === "relay");
  assert.equal(it({}).label, "Продолжить в другом движке");
  assert.equal(it({}).disabled, false);
  assert.equal(it({ empty: true }).disabled, true);
  assert.match(it({ running: true }).note, /Дождитесь конца хода/);
  assert.equal(it({ offline: true }).disabled, true);
});

test("FEAT-11.18 (кадр 2): отметка передачи стоит в ленте между ходами прежнего и нового движка", async () => {
  const mark = { at: T0 + 30_000, from: { engine: "claude", ...OPUS }, to: { engine: "opencode", ...GLM } };
  const { root } = await openChat({ teleharness: { ...glmBinding, relays: [mark] } });
  const el = await t$.waitFor(() => $(root, ".relay-mark"));
  assert.match(el.textContent, /Claude Opus 5\.5/);
  assert.match(el.textContent, /GLM-5\.3/);
  assert.match(el.getAttribute("aria-label"), /Чат передан: .* → /);
  const order = $$(root, ".msg, .relay-mark").map((n) => (n.classList.contains("relay-mark") ? "MARK" : n.textContent.slice(0, 12)));
  const iMark = order.indexOf("MARK");
  assert.ok(iMark > 0 && iMark < order.length - 1, "отметка — внутри ленты: " + order.join(" | "));
  assert.ok(order.slice(0, iMark).some((x) => /Перенёс три/.test(x)), "до отметки — ответ прежнего движка");
  assert.ok(order.slice(iMark).some((x) => /Продолжай/.test(x)), "после отметки — следующий запрос");
});

test("FEAT-11.18 (кадр 3): меню чата → лист выбора → передача уходит на сервер, привязка чата обновляется", async () => {
  let sent = null;
  const { root } = await openChat({
    teleharness: claudeBinding,
    extra: [{ method: "PATCH", path: `/teleharness/api/session/${SID}/binding`, reply: (c) => { sent = c.body; return { id: SID, teleharness: { ...glmBinding, model: c.body.model, relays: [{ at: Date.now(), from: { engine: "claude", ...OPUS }, to: { engine: "opencode", ...c.body.model } }] } }; } }],
  });
  t$.click($(root, '.chat-header button[aria-label="Действия с чатом"]'));
  const item = document.querySelector('.chat-menu [data-act="relay"]');
  assert.ok(item, "пункт «Продолжить в другом движке» есть");
  t$.click(item);
  const sheet = await t$.waitFor(() => document.querySelector('.sheet[aria-label="Продолжить в другом движке"]'));
  assert.match(sheet.textContent, /Чат и папка остаются теми же/);
  const row = [...sheet.querySelectorAll(".picker-row")].find((r) => /GLM-5\.3 Flash/.test(r.textContent));
  assert.ok(row, "в листе — модели обоих движков");
  t$.click(row);
  await t$.waitFor(() => sent != null);
  assert.deepEqual(sent, { relay: true, model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" } }, "из меню — без автопродолжения и без причины");
  await t$.waitFor(() => document.querySelector(".sheet") == null);
  assert.equal(ui.store.sessions.value.find((s) => s.id === SID).teleharness.engine, "opencode");
  assert.equal(fetchCalls.some((c) => c.method === "POST" && /\/prompt/.test(c.path)), false, "сообщение за пользователя не отправляется");
});

test("FEAT-11.18 (кадр 1): плашка лимита — «Продолжить в …» передаёт чат и сразу просит новый движок продолжить", async () => {
  const calls = [];
  const limitMsg = msg("a3", "assistant", T0 + 120_000, "", { error: { name: "APIError", data: { message: "Claude usage limit reached" } } });
  const { root } = await openChat({
    teleharness: claudeBinding,
    messages: [...HISTORY, msg("u3", "user", T0 + 119_000, "Доделай пятый"), limitMsg],
    extra: [
      { method: "PATCH", path: `/teleharness/api/session/${SID}/binding`, reply: (c) => { calls.push(["relay", c.body]); return { id: SID, teleharness: { ...glmBinding, relays: [{ at: Date.now(), from: { engine: "claude", ...OPUS }, to: { engine: "opencode", ...GLM } }] } }; } },
      { method: "POST", path: `/teleharness/api/session/${SID}/prompt`, reply: (c) => { calls.push(["prompt", c.body]); return { status: 204 }; } },
    ],
  });
  const bar = await t$.waitFor(() => $(root, ".turn-error"));
  assert.match(bar.textContent, /Исчерпан лимит подписки Claude/);
  const primary = $(bar, ".relay-primary");
  assert.ok(primary, "главная кнопка передачи на плашке");
  assert.match(primary.textContent, /Продолжить в GLM-5\.3( Flash)? · opencode/, "человеческое имя модели и движок");
  assert.ok(byText(bar, "button", "Другая модель…"));
  assert.ok(byText(bar, "button", "Повторить"), "прежнее действие осталось");
  t$.click(primary);
  await t$.waitFor(() => calls.some((c) => c[0] === "prompt"));
  assert.equal(calls[0][0], "relay");
  assert.equal(calls[0][1].relay, true);
  assert.equal(calls[0][1].reason, "limit");
  assert.equal(calls[0][1].model.providerID, "zai-coding-plan", "предложен другой движок");
  const text = calls.find((c) => c[0] === "prompt")[1].parts.map((p) => p.text).join(" ");
  assert.match(text, /Продолжай с того места, где остановился прежний ход/);
  assert.equal($(root, ".turn-error"), null, "плашка лимита ушла");
});

test("FEAT-11.18 (кадр 6): остаток z.ai меньше 15 % — полоска с предложением передать; «Скрыть» убирает; при 50 % полоски нет", async () => {
  const low = [{ id: "zai", title: "z.ai", state: "ok", windows: [{ kind: "hours", number: 5, percent: 91, resetAt: T0 + 3600_000 }, { kind: "week", number: 1, percent: 30 }] }];
  const h = await openChat({ teleharness: glmBinding, cards: low });
  const strip = await t$.waitFor(() => $(h.root, ".quota-strip"));
  assert.match(strip.textContent, /z\.ai: осталось 9% на 5 ч/);
  assert.match(strip.textContent, /Можно продолжить этот чат в другом движке/);
  assert.ok([...strip.querySelectorAll("button")].some((b) => /^Продолжить в Claude /.test(b.textContent)), "предложен Claude: " + strip.textContent);
  t$.click(byText(strip, "button", "Скрыть"));
  await t$.waitFor(() => $(h.root, ".quota-strip") == null);
  h.unmount();
  ui.store.subscriptions.value = null;
  const h2 = await openChat({ teleharness: glmBinding, cards: [{ id: "zai", state: "ok", windows: [{ kind: "hours", number: 5, percent: 50 }] }] });
  await t$.flush(5);
  assert.equal($(h2.root, ".quota-strip"), null);
});

// EPIC-18 стенд 2026-11-15: плашка лимита на телефоне — текст во всю ширину, действия строкой ниже.
test("плашка лимита переносит действия под текст, длинная кнопка переносит подпись", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../src/components/relay.css", import.meta.url), "utf8").replace(/\r/g, "");
  const body = (sel) => {
    const at = css.indexOf("\n" + sel + " {");
    assert.ok(at >= 0, "нет правила " + sel);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(body(".turn-error"), /flex-wrap: wrap/);
  assert.match(body(".turn-error .turn-error-actions"), /flex: 1 1 100%/);
  assert.match(body(".turn-error .stall-btn"), /white-space: normal/);
  assert.match(body(".turn-error .stall-btn"), /min-height: 44px/);
});

// BUG-264 п.5 (усиление BUG-239): на 320 px кнопка «Продолжить в …» плашки квоты наезжала на текст —
// .turn-error-actions с flex: none шире остатка строки, а текст (min-width: 0) сжимался в колонку по слову.
// Плашка квоты переносится: текст не уже 220 px, иначе действия уходят строкой ниже.
test("BUG-264 п.5: плашка квоты на узком экране — действия под текстом, кнопки ≥ 44 px и переносят подпись", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../src/components/relay.css", import.meta.url), "utf8").replace(/\r/g, "");
  // все блоки, где селектор стоит в строке перед «{» (в т.ч. последним в группе)
  const body = (sel) => {
    const parts = css.split("\n" + sel + " {").slice(1);
    assert.ok(parts.length, "нет правила " + sel);
    return parts.map((p) => p.slice(0, p.indexOf("}"))).join("\n");
  };
  assert.match(body(".quota-strip"), /flex-wrap: wrap/);
  assert.match(body(".quota-strip .stall-text"), /flex: 1 1 220px/);
  assert.match(body(".quota-strip .turn-error-actions"), /flex: 0 1 auto/);
  assert.match(body(".quota-strip .turn-error-actions"), /max-width: 100%/);
  assert.match(body(".quota-strip .turn-error-actions"), /margin-left: auto/);
  assert.match(body(".quota-strip .stall-btn"), /white-space: normal/);
  assert.match(body(".quota-strip .stall-btn"), /min-height: 44px/);
  assert.match(body(".quota-strip .stall-btn"), /max-width: 100%/);
  // структура, на которую опираются правила
  const low = [{ id: "zai", title: "z.ai", state: "ok", windows: [{ kind: "week", number: 1, percent: 100, resetAt: T0 + 3600_000 }] }];
  const h = await openChat({ teleharness: glmBinding, cards: low });
  const strip = await t$.waitFor(() => $(h.root, ".quota-strip"));
  assert.ok($(strip, ":scope > .stall-text"), "текст — прямой потомок плашки");
  const actions = $(strip, ":scope > .turn-error-actions");
  assert.ok(actions, "действия — прямой потомок плашки");
  assert.ok($$(actions, "button.stall-btn").length >= 2, "кнопки плашки — .stall-btn: " + actions.outerHTML);
});
