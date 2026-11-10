// Критерии приёмки items, помеченных verified без автотеста (финальное ревью
// 2026-11-02, docs/reviews/2026-11-02/final-fixes.md). Каждый тест проверяет
// КРИТЕРИЙ карточки, а не реализацию; падение = дефект вернулся.
//   BUG-01.44 / BUG-072 (ISSUE-014) — Tab вперёд доходит до ✎/🗑 строки чата
//   BUG-03.14 / BUG-066 (ISSUE-008) — у тенанта нет ошибок загрузки в
//                                     Настройках, версии видны всем ролям
//   BUG-05.12 / BUG-067 (ISSUE-009) — 20 вложений: ✕ ≥ 44px, ряд чипов с
//                                     ограниченной высотой, удалённый чип не
//                                     оставляет файла на сервере
//   BUG-05.14 / BUG-070 (ISSUE-012) — шапка картинки: формат, пиксели, вес
//   BUG-07.18 / BUG-071 (ISSUE-013) — заголовок инструмента вопроса по-русски
//                                     и с содержанием вопроса
// Смежные проверки 1.7.2 — tests/components/inprogress-fixes.test.js и
// tests/client-172.test.js; здесь — недостающие стороны критериев.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    HomeView: "src/components/views/HomeView.jsx",
    focusablesIn: "src/components/Pickers.jsx#focusablesIn",
    SettingsView: "src/components/views/SettingsView.jsx",
    Composer: "src/components/chat/Composer.jsx",
    FileViewer: "src/components/chat/FileViewer.jsx",
    ToolCard: "src/components/chat/ToolCard.jsx",
    MessageBubble: "src/components/chat/MessageBubble.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.me.value = null;
  s.sessions.value = [];
  s.about.value = null;
  s.mcp.value = null;
  s.mcpError.value = false;
  s.host.value = null;
  s.setActiveId(null);
  installFetch();
});

const NOW = Date.now();
const SID = "ses_vc";
const DIR = "D:\\Chats\\vc";
const css = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const ruleOf = (text, selector) => {
  const at = text.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `нет правила ${selector}`);
  return text.slice(at, text.indexOf("}", at));
};

// ---- BUG-01.44: порядок Tab в строке чата ---------------------------------------

test("BUG-01.44: Tab вперёд — ссылка строки → ✎ → 🗑 → следующая строка (действия после ссылки, не выключены из порядка)", async () => {
  ui.store.sessions.value = [
    { id: "ses_a", title: "Отчёт", directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } },
    { id: "ses_b", title: "План", directory: "C:\\Users\\USER", time: { created: NOW - 1000, updated: NOW - 1000 } },
  ];
  const { root } = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(root, ".swipe").length === 2);
  const rows = $$(root, ".swipe");
  // Порядок Tab = порядок фокусируемых в DOM (tabindex > 0 в строках нет).
  const order = ui.focusablesIn(rows[0].parentElement.closest("ul, ol, section, div") ?? root).filter((el) => rows.some((r) => r.contains(el)));
  const label = (el) => (el.tagName === "A" ? `link:${el.getAttribute("href")}` : el.getAttribute("aria-label"));
  assert.deepEqual(order.map(label), [
    "link:#/chat/ses_a",
    "Переименовать чат «Отчёт»",
    "Удалить чат «Отчёт»",
    "link:#/chat/ses_b",
    "Переименовать чат «План»",
    "Удалить чат «План»",
  ]);
  for (const el of order) {
    assert.equal(el.tabIndex >= 0, true, `${label(el)}: не tabindex=-1`);
    assert.equal(el.getAttribute("tabindex") == null || Number(el.getAttribute("tabindex")) <= 0, true, "без положительного tabindex (не ломает порядок)");
  }
  // Фокус в строке открывает действия (иначе Tab попал бы на невидимую кнопку).
  const reveal = ruleOf(css("src/components/views.css"), ".swipe:has(:focus-visible) .swipe-actions");
  assert.match(reveal, /visibility:\s*visible/);
});

// ---- BUG-03.14: тенант в Настройках -----------------------------------------------

const ABOUT = { version: "1.8.6", opencodeVersion: "1.19.5" };

test("BUG-03.14 (с FEAT-03.21): тенант — /host и /claude/agents не запрашиваются, /mcp — да (свои серверы); ошибок загрузки нет", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/about", reply: () => ABOUT },
    { method: "GET", path: "/zai/api/mcp", reply: () => ({ marketplace: { status: "connected" } }) },
    { method: "GET", path: "/zai/api/host", reply: () => ({ status: 403, body: { error: "admin only" } }) },
    { method: "GET", path: "/zai/api/claude/agents", reply: () => ({ status: 403, body: { error: "admin only" } }) },
  ]);
  ui.store.me.value = { id: "u_t", name: "julia", role: "user" };
  await ui.store.loadCatalogs();
  const { root } = t$.mount(ui.SettingsView, { section: "about" });
  await t$.waitFor(() => /opencode 1\.19\.5/.test(root.textContent));
  await t$.flush(5);
  const asked = new Set(fetchCalls.map((c) => c.path));
  for (const p of ["/zai/api/host", "/zai/api/claude/agents"]) assert.equal(asked.has(p), false, `тенант не спрашивает ${p}`);
  assert.equal(asked.has("/zai/api/mcp"), true, "FEAT-03.21: тенант видит свои MCP");
  assert.equal(ui.store.mcpError.value, false);
  assert.equal(/Не удалось загрузить/.test(root.textContent), false, "ни одной ошибки загрузки");
  assert.equal(byText(root, "button", "Повторить"), null);
});

test("BUG-03.14: версии видны всем ролям — у админа та же строка «О приложении» из /about", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/about", reply: () => ABOUT },
    { method: "GET", path: "/zai/api/host", reply: () => ({}) },
    { method: "GET", path: "/zai/api/usage", reply: () => ({}) },
  ]);
  const lines = {};
  for (const role of ["user", "admin"]) {
    ui.store.me.value = { id: `u_${role}`, name: role, role };
    ui.store.about.value = null;
    const h = t$.mount(ui.SettingsView, { section: "about" });
    await t$.waitFor(() => /opencode 1\.19\.5/.test(h.root.textContent));
    lines[role] = byText(h.root, ".set-value", "opencode").textContent;
    h.unmount();
  }
  assert.match(lines.user, /^Teleharness .+ · opencode 1\.19\.5 · Claude Code$/);
  assert.equal(lines.admin, lines.user);
});

// ---- BUG-05.12: 20 вложений ----------------------------------------------------

test("BUG-05.12: ✕ ≥ 44px, ряд чипов ограничен по высоте с прокруткой (шапка не закрыта)", () => {
  const chat = css("src/components/chat.css");
  const x = ruleOf(chat, ".attach-x");
  const px = (prop) => Number(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(x)?.[1] ?? 0);
  assert.ok(px("width") >= 44 || px("min-width") >= 44, "ширина ✕ ≥ 44px");
  assert.ok(px("height") >= 44 || px("min-height") >= 44, "высота ✕ ≥ 44px");
  const chips = ruleOf(chat, ".composer-chips");
  assert.match(chips, /max-height:/);
  assert.match(chips, /overflow-y:\s*auto/);
});

test("BUG-05.12: удаление всех 20 чипов — по DELETE /upload на каждый загруженный файл, сирот не остаётся", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stored = new Set();
  installFetch([
    { method: "POST", path: "/zai/api/upload", reply: (c) => (stored.add(`u-${c.query.name}`), { name: `u-${c.query.name}`, size: 10 }) },
    { method: "DELETE", path: "/zai/api/upload", reply: (c) => (stored.delete(c.query.name), { ok: true }) },
  ]);
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const { root } = t$.mount(ui.Composer, { sessionId: SID, status: "idle", onSend: () => {}, onStop: () => {} });
  const input = $(root, 'input[type="file"]');
  Object.defineProperty(input, "files", { value: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.pdf`, size: 10, type: "application/pdf" })), configurable: true });
  t$.fire(input, "change");
  await t$.waitFor(() => stored.size === 20);
  await t$.waitFor(() => !root.querySelector(".is-uploading, .is-progress"));
  for (let i = 0; i < 20; i += 1) {
    const x = $(root, "button.attach-x");
    assert.ok(x, `чип ${i + 1} доступен`);
    t$.click(x);
    await t$.flush(2);
  }
  await t$.waitFor(() => fetchCalls.filter((c) => c.method === "DELETE").length === 20);
  assert.equal(stored.size, 0, `на сервере остались: ${[...stored].join(", ")}`);
  assert.equal($$(root, ".attach").length, 0);
  for (const c of fetchCalls.filter((x) => x.method === "DELETE")) assert.equal(c.query.directory, DIR);
});

// ---- BUG-05.14: шапка картинки ---------------------------------------------------

const subText = () => ($(document.body, ".file-sub")?.textContent ?? "").replace(/\u00a0/g, " ");
function loaded(img, w, h) {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  t$.fire(img, "load");
}

test("BUG-05.14: любой формат картинки — «ФОРМАТ · W×H · вес», не «Изображение»", async () => {
  const b64 = (n, mime) => `data:${mime};base64,${Buffer.from(new Uint8Array(n)).toString("base64")}`;
  const cases = [
    { file: { dataUrl: b64(2048, "image/webp"), name: "shot.webp" }, w: 800, h: 600, want: "WEBP · 800×600 · 2 КБ" },
    { file: { dataUrl: b64(100, "image/gif"), name: "anim.gif" }, w: 16, h: 16, want: "GIF · 16×16 · 100 Б" },
    { file: { dataUrl: b64(315, "image/png"), name: "вставка" }, w: 1, h: 2, want: "PNG · 1×2 · 315 Б", note: "имя без расширения — формат из data:URL" },
    { file: { dataUrl: b64(500, "image/jpeg"), name: "photo.jpeg" }, w: 3, h: 4, want: "JPG · 3×4 · 500 Б" },
  ];
  for (const c of cases) {
    const h = t$.mount(ui.FileViewer, { file: c.file, onClose() {} });
    const img = await t$.waitFor(() => $(document.body, ".file-panel img.file-img"));
    loaded(img, c.w, c.h);
    await t$.waitFor(() => subText() === c.want).catch(() => assert.fail(`${c.file.name}: «${subText()}» вместо «${c.want}»${c.note ? ` (${c.note})` : ""}`));
    assert.equal(/Изображение/.test(subText()), false);
    h.unmount();
  }
});

// ---- BUG-07.18: заголовок инструмента вопроса --------------------------------------

const qPart = (status, state = {}) => ({ id: `p_${status}`, type: "tool", tool: "question", callID: "c1", state: { status, ...state } });

test("BUG-07.18: во всех состояниях (ждёт/идёт/готово/ошибка) заголовок по-русски и с текстом первого непустого вопроса", () => {
  const input = { questions: [{ question: "  " }, { question: "Какой отчёт нужен — краткий или полный?", options: [] }, { question: "Второй?" }] };
  for (const status of ["pending", "running", "completed", "error"]) {
    const { root } = t$.mount(ui.ToolCard, { part: qPart(status, { title: "Asked 3 questions", input }) });
    const head = $(root, ".tool-head").textContent;
    assert.equal($(root, ".tool-name").textContent, "Вопрос агента · Какой отчёт нужен — краткий или полный?", status);
    assert.equal(/\bquestion\b|Asked/i.test(head), false, `${status}: в шапке нет английского`);
  }
});

test("BUG-07.18: длинный вопрос обрезается, а не растягивает шапку; в ленте ответа — тот же русский заголовок", () => {
  const long = "Как назвать файл отчёта, если в нём будут данные за несколько месяцев и несколько отделов сразу?";
  const a = t$.mount(ui.ToolCard, { part: qPart("completed", { input: { questions: [{ question: long }] } }) });
  const desc = $(a.root, ".tool-desc").textContent.replace(/^ · /, "");
  assert.ok(desc.length <= 80, `длина ${desc.length}`);
  assert.ok(desc.endsWith("…"));
  assert.ok(long.startsWith(desc.slice(0, -1)));
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const msg = {
    info: { id: "a_q", role: "assistant", sessionID: SID, time: { created: NOW, completed: NOW } },
    parts: [qPart("completed", { title: "Asked 1 question", input: { questions: [{ question: "Продолжать?" }] }, time: { start: NOW, end: NOW } }), { id: "p_t", type: "text", text: "Ок." }],
  };
  const b = t$.mount(ui.MessageBubble, { msg });
  assert.equal(/Asked 1 question|question ·/i.test(b.root.textContent), false);
  assert.match(b.root.textContent, /Вопрос агента · Продолжать\?/);
});
