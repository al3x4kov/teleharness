// Прелоадер заменён на v3 владельца 2026-11-04 (робот бросает жетон «ai»; preloader-v3-light/dark.svg).
// L2 (FEAT-03.19): «Детализация выполнения» — переключатель в Настройках и
// лента чата в обоих режимах. Выключено (по умолчанию): пока ход формируется —
// прелоадер «человечек бросает ai в корзину», после — только полноценный ответ
// (без размышлений, инструментов, «Шаг N», промежуточного текста). Включено —
// как раньше: живые шаги, точки набора, строка «Работает…».
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";
import { readFileSync } from "node:fs";

// FEAT-03.19: прелоадер v3 — файлы владельца (замена 2026-11-04).
const V3 = {
  light: readFileSync(new URL("../../src/components/chat/preloader-v3-light.svg", import.meta.url), "utf8"),
  dark: readFileSync(new URL("../../src/components/chat/preloader-v3-dark.svg", import.meta.url), "utf8"),
};

let ui, t$;
before(async () => {
  ui = await loadUI({
    MessageList: "src/components/chat/MessageList.jsx",
    TurnPreloader: "src/components/chat/TurnPreloader.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
    ToolCard: "src/components/chat/ToolCard.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.setPrefs({ execDetail: false });
  s.me.value = null;
  s.sessions.value = [];
  s.active.value = null;
  s.about.value = null;
  s.setActiveId(null);
  installFetch();
});

const SID = "ses_ed";
// Ожидание по реальному времени (постепенный вывод идёт таймером, а t$.waitFor крутит только микрозадачи).
async function until(cond, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    t$.act(() => {});
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}
const DIR = "D:\\Chats\\ed";
const T = Date.now() - 60_000;

const user = (id, t, text) => ({ info: { id, role: "user", sessionID: SID, time: { created: t } }, parts: [{ id: `${id}_p`, type: "text", text }] });
const step = (id, t, parts, { done = true, error = null } = {}) => ({
  info: { id, role: "assistant", sessionID: SID, time: { created: t, ...(done ? { completed: t + 500 } : {}) }, ...(error ? { error } : {}) },
  parts,
});
const readTool = (id) => ({ id, type: "tool", tool: "read", callID: id, state: { status: "completed", input: { filePath: "D:\\Chats\\ed\\README.md" }, output: "три строки", title: "README.md" } });

function turn({ last = { done: true } } = {}) {
  return [
    step("a1", T + 1000, [{ id: "s1", type: "step-start" }, { id: "r1", type: "reasoning", text: "Надо прочитать README", time: { start: T, end: T + 900 } }, { id: "t1", type: "text", text: "Сейчас прочитаю README." }, readTool("k1")]),
    step("a2", T + 2000, [{ id: "s2", type: "step-start" }, { id: "t2", type: "text", text: "Итог: zai — мобильный клиент поверх opencode." }], last),
  ];
}

function mountFeed(messages, { busy = false, live = null } = {}) {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  ui.store.active.value = { id: SID, messages, status: busy ? "busy" : "idle" };
  return t$.mount(ui.MessageList, { sessionId: SID, messages, streamingId: null, busy, live });
}

// ---- Настройки ----------------------------------------------------------------------

test("FEAT-03.19: в Настройках «Детализация выполнения» выключена по умолчанию; переключатель сохраняет выбор", async () => {
  installFetch([{ method: "GET", path: "/zai/api/about", reply: () => ({ version: "1.11.0", opencodeVersion: "1.19.5" }) }]);
  ui.store.me.value = { id: "u_t", name: "Тенант", role: "user" };
  const { root } = t$.mount(ui.SettingsView);
  const title = $$(root, ".row-title").find((el) => el.textContent === "Детализация выполнения");
  assert.ok(title, "строка есть и у не-admin");
  const sw = $(root, `.switch[aria-labelledby="${title.id}"]`);
  assert.equal(sw.getAttribute("role"), "switch");
  assert.equal(sw.getAttribute("aria-checked"), "false", "по умолчанию выключено");
  t$.fire(sw, "click");
  await t$.waitFor(() => sw.getAttribute("aria-checked") === "true");
  assert.equal(ui.store.prefs.value.execDetail, true, "выбор в prefs (localStorage)");
  t$.fire(sw, "click");
  await t$.waitFor(() => sw.getAttribute("aria-checked") === "false");
  assert.equal(ui.store.execDetailOn(ui.store.prefs.value), false);
});

// ---- Лента: детализация выключена ------------------------------------------------------

test("FEAT-03.19: выключено — пока ход формируется, виден только прелоадер (без шагов, точек набора и «Работает…»)", async () => {
  const feed = [user("u1", T, "Прочитай README"), ...turn({ last: { done: false } })];
  const h = mountFeed(feed, { busy: true, live: { since: T, lastAction: { label: "чтение файла", at: T } } });
  const pre = $(h.root, ".turn-preloader");
  assert.ok(pre, "прелоадер в ленте");
  assert.equal(pre.getAttribute("role"), "status");
  assert.equal(pre.getAttribute("aria-label"), "Готовлю ответ…");
  // Прелоадер v3 владельца (замена 2026-11-04): два <img> — светлый и тёмный, SVG из файлов владельца.
  const src = (sel) => decodeURIComponent($(pre, sel).getAttribute("src").replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
  assert.equal(src(".tp-theme-light .tp-anim"), V3.light, "светлый — байт в байт preloader-v3-light.svg");
  assert.equal(src(".tp-theme-dark .tp-anim"), V3.dark, "тёмный — байт в байт preloader-v3-dark.svg");
  for (const t of ["light", "dark"]) {
    const still = src(`.tp-theme-${t} .tp-still`);
    assert.equal(still, V3[t].replace('class="turn-preloader ', 'class="turn-preloader tp-static '), `${t}: статичная копия — тот же SVG + корневой tp-static`);
  }
  assert.ok($$(pre, "img").every((i) => i.getAttribute("alt") === ""), "картинки декоративные — смысл в role=status");
  assert.equal($$(h.root, ".msg-assistant:not(.msg-preloader)").length, 0, "шаги хода не показаны");
  assert.equal(!!$(h.root, ".tool-card"), false);
  assert.equal(!!$(h.root, ".reasoning-head"), false);
  assert.equal(!!$(h.root, ".msg-typing"), false, "точек набора нет");
  assert.equal(!!$(h.root, ".turn-live"), false, "строки «Работает…» нет");
  assert.equal(h.root.textContent.includes("Сейчас прочитаю README."), false);
});

test("FEAT-03.19: выключено — ход завершён: прелоадер исчез, виден только полноценный ответ", async () => {
  const feed = [user("u1", T, "Прочитай README"), ...turn()];
  const h = mountFeed(feed, { busy: true });
  assert.ok($(h.root, ".turn-preloader"));
  ui.store.active.value = { id: SID, messages: feed, status: "idle" };
  h.rerender({ busy: false, messages: feed });
  await t$.waitFor(() => !$(h.root, ".turn-preloader"));
  // с 2026-11-04 ~23:00 ответ выводится постепенно — ждём окончания вывода (реальное время)
  assert.ok(await until(() => !!$(h.root, ".copy-turn") && /Итог: zai — мобильный клиент поверх opencode\./.test($(h.root, ".msg-assistant")?.textContent ?? "")), "вывод закончился, текст целиком");
  const answers = $$(h.root, ".msg-assistant");
  assert.equal(answers.length, 1, "один ответ на ход");
  assert.match(answers[0].textContent, /Итог: zai — мобильный клиент поверх opencode\./);
  assert.equal(h.root.textContent.includes("Сейчас прочитаю README."), false, "промежуточного текста нет");
  assert.equal(!!$(h.root, ".tool-card"), false, "карточек инструментов нет");
  assert.equal(!!$(h.root, ".reasoning-head"), false, "размышлений нет");
  assert.equal(!!$(h.root, ".step-label"), false, "«Шаг N» нет");
  assert.ok($(answers[0], ".copy-turn"), "подвал хода (копировать) на месте");
});

test("FEAT-03.19: выключено — ошибка хода видна, прелоадер не висит", async () => {
  const err = { name: "APIError", data: { message: "rate limit exceeded", statusCode: 429 } };
  const feed = [user("u1", T, "Прочитай README"), step("a1", T + 1000, [{ id: "s1", type: "step-start" }, readTool("k1")], { error: err })];
  const h = mountFeed(feed, { busy: false });
  assert.equal(!!$(h.root, ".turn-preloader"), false);
  assert.ok($(h.root, ".msg-turn-error"), "отметка ошибки хода");
  assert.equal(!!$(h.root, ".tool-card"), false);
});

// ---- Лента: детализация включена (как раньше) ------------------------------------------

test("FEAT-03.19: включено — живые шаги, точки набора и «Работает…», прелоадера нет", async () => {
  ui.store.setPrefs({ execDetail: true });
  const h1 = mountFeed([user("u1", T, "Прочитай README")], { busy: true, live: { since: T } });
  assert.ok($(h1.root, '.msg-typing[role="status"]'), "точки набора до первой части — status (BUG-01.38)");
  assert.ok($(h1.root, ".turn-live"), "строка «Работает…»");
  assert.equal(!!$(h1.root, ".turn-preloader"), false);
  t$.cleanup();
  const feed = [user("u1", T, "Прочитай README"), ...turn({ last: { done: false } })];
  const h2 = mountFeed(feed, { busy: true });
  assert.ok($(h2.root, ".tool-card"), "карточка инструмента видна");
  assert.ok($(h2.root, ".reasoning-head"), "размышления видны");
  assert.ok(h2.root.textContent.includes("Сейчас прочитаю README."), "промежуточный текст виден");
  assert.equal(!!$(h2.root, ".turn-preloader"), false);
});

test("FEAT-03.19 v3: в обоих SVG анимации только под prefers-reduced-motion: no-preference, подпись «Готовлю ответ…», без скриптов и внешних ссылок", () => {
  for (const [name, svg] of Object.entries(V3)) {
    const anim = [...svg.matchAll(/animation:\s*tp-/g)].map((m) => m.index);
    assert.ok(anim.length >= 5, `${name}: анимированы робот, рука, жетон, корзина`);
    const gate = svg.indexOf("@media (prefers-reduced-motion: no-preference)");
    assert.ok(gate >= 0 && anim.every((i) => i > gate), `${name}: все анимации — внутри media no-preference`);
    assert.ok(svg.includes(">Готовлю ответ…</text>"), `${name}: подпись`);
    assert.equal(/<script|\son[a-z]+=|href="https?:/i.test(svg), false, `${name}: без скриптов и внешних ссылок`);
  }
});

test("FEAT-03.19 v3: chat.css выбирает вариант по теме; старого прелоадера (человечек) в стилях нет", () => {
  const css = readFileSync(new URL("../../src/components/chat.css", import.meta.url), "utf8");
  assert.match(css, /\.turn-preloader \.tp-theme-light \{ display: none; \}/, "по умолчанию (тёмная) светлый скрыт");
  assert.match(css, /:root\[data-theme="light"\] \.turn-preloader \.tp-theme-light \{ display: block; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.turn-preloader \.tp-theme-dark \{ display: none; \}/);
  assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\) \.turn-preloader \.tp-theme-light \{ display: block; \}/);
  assert.match(css, /\.turn-preloader \.tp-still \{ display: none; \}/, "статичная копия скрыта по умолчанию");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.turn-preloader \.tp-anim \{ display: none; \}\s*\.turn-preloader \.tp-still \{ display: block; \}/, "reduce — статичная копия");
  assert.equal(/tp-arm|tp-word|tp-basket/.test(css), false, "правил старого прелоадера нет");
});

// ---- Постепенный вывод готового ответа (уточнение владельца 2026-11-04 ~23:00) ----

test("FEAT-03.19: ход завершился на глазах — прелоадер исчез, ответ выводится постепенно с начала, подвал — по окончании", async () => {
  const running = [user("u1", T, "Прочитай README"), ...turn({ last: { done: false } })];
  const h = mountFeed(running, { busy: true });
  assert.ok($(h.root, ".turn-preloader"));
  const done = [user("u1", T, "Прочитай README"), ...turn()];
  ui.store.active.value = { id: SID, messages: done, status: "idle" };
  h.rerender({ busy: false, messages: done });
  const full = "Итог: zai — мобильный клиент поверх opencode.";
  const body = () => [...h.root.querySelectorAll(".msg-assistant .md, .msg-assistant .markdown, .msg-assistant p")].map((e) => e.textContent).join("") || ($(h.root, ".msg-assistant")?.textContent ?? "");
  assert.equal(!!$(h.root, ".turn-preloader"), false, "прелоадер снят сразу");
  assert.equal(body().includes(full), false, "в первый кадр ответ не вставлен целиком");
  assert.equal(!!$(h.root, ".copy-turn"), false, "подвал хода — после вывода");
  assert.ok($(h.root, ".msg-assistant").classList.contains("is-streaming"), "выглядит как живой стрим");
  const seen = [];
  const ok = await until(() => {
    const txt = $(h.root, ".msg-assistant")?.textContent ?? "";
    const i = txt.indexOf("Итог");
    seen.push(i >= 0 ? txt.slice(i).replace(/Копировать ответ.*$/, "").length : 0);
    return txt.includes(full) && !!$(h.root, ".copy-turn");
  });
  assert.ok(ok, "ответ выведен целиком и появился подвал");
  const partial = seen.filter((n) => n > 0 && n < full.length);
  assert.ok(partial.length >= 2, `были промежуточные состояния: ${seen.join(",")}`);
  assert.ok(seen.every((n, k) => k === 0 || n >= seen[k - 1] || n === 0), "текст только растёт");
  assert.equal($(h.root, ".msg-assistant").classList.contains("is-streaming"), false, "по окончании — обычный ответ");
});

test("FEAT-03.19: история (чат открыт уже свободным) — ответ сразу целиком, без вывода", async () => {
  const done = [user("u1", T, "Прочитай README"), ...turn()];
  const h = mountFeed(done, { busy: false });
  assert.match($(h.root, ".msg-assistant").textContent, /Итог: zai — мобильный клиент поверх opencode\./);
  assert.ok($(h.root, ".copy-turn"), "подвал сразу");
});

test("FEAT-03.19: с детализацией — без постепенного вывода (стрим идёт как раньше)", async () => {
  ui.store.setPrefs({ execDetail: true });
  const running = [user("u1", T, "Прочитай README"), ...turn({ last: { done: false } })];
  const h = mountFeed(running, { busy: true });
  const done = [user("u1", T, "Прочитай README"), ...turn()];
  ui.store.active.value = { id: SID, messages: done, status: "idle" };
  h.rerender({ busy: false, messages: done });
  assert.ok(h.root.textContent.includes("Итог: zai — мобильный клиент поверх opencode."), "текст целиком сразу");
});
