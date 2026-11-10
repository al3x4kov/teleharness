// zai 1.7.2 (openspec bugfix-1.7.2), L2 tests for fixes that were confirmed
// live on prod 2026-11-03 but had no autotest: BUG-03.14 (tenant Settings),
// BUG-05.12 (20 attachments), BUG-05.14 (image viewer header), BUG-07.18
// (question tool title in Russian) — plus BUG-05.13 (a picture made by a
// bash command gets a preview; a missing one hides).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    Composer: "src/components/chat/Composer.jsx",
    FileViewer: "src/components/chat/FileViewer.jsx",
    ToolCard: "src/components/chat/ToolCard.jsx",
    MessageBubble: "src/components/chat/MessageBubble.jsx",
    resetProbes: "src/lib/file-probe.js#resetProbes",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.me.value = null;
  s.sessions.value = [];
  s.active.value = null;
  s.about.value = null;
  s.mcp.value = null;
  s.host.value = null;
  s.setActiveId(null);
  installFetch();
});

const SID = "ses_fx";
const DIR = "D:\\Chats\\fx";
const NOW = Date.now();

// ---- BUG-03.14: tenant Settings --------------------------------------------------

// BUG-03.20 / FEAT-03.21 (owner 2026-11-05) supersede the «Доступно
// администратору» placeholders of BUG-03.14: a tenant sees its own MCP
// servers and no owner-machine sections at all — still no load errors.
test("BUG-03.14 → BUG-03.20/FEAT-03.21: участник — MCP списком, «Компьютера» нет, «Доступно администратору» нет; /host не спрашивается; версия opencode видна", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/about", reply: () => ({ version: "1.7.2", opencodeVersion: "1.19.5" }) },
    { method: "GET", path: "/zai/api/mcp", reply: () => ({ marketplace: { status: "connected" }, websearch: { status: "failed" } }) },
  ]);
  ui.store.me.value = { id: "u_t", name: "Тенант", role: "user" };
  // FEAT-03.23: корень без admin-строк; MCP и версии — в своих разделах
  const top = t$.mount(ui.SettingsView);
  await t$.flush(5);
  assert.equal(top.root.textContent.includes("Компьютер"), false);
  top.unmount();
  const about = t$.mount(ui.SettingsView, { section: "about" });
  await t$.waitFor(() => /opencode 1\.19\.5/.test(about.root.textContent));
  assert.match(byText(about.root, ".set-value", "opencode").textContent, /^Teleharness .+ · opencode 1\.19\.5 · Claude Code$/);
  about.unmount();
  const { root } = t$.mount(ui.SettingsView, { section: "mcp" });
  await t$.waitFor(() => $$(root, ".mcp-row").length === 2);
  await t$.flush(5);
  assert.equal(root.textContent.includes("Доступно администратору"), false);
  assert.deepEqual($$(root, ".mcp-name").map((el) => el.textContent).sort(), ["marketplace", "websearch"]);
  assert.equal($$(root, ".mcp-why").length, 0, "участнику причина сбоя не показывается");
  assert.equal($$(root, ".row-title").some((el) => el.textContent === "Компьютер"), false, "«Компьютер» скрыт целиком");
  assert.equal(root.textContent.includes("Не удалось загрузить"), false, "ни одной ошибки загрузки");
  const paths = fetchCalls.map((c) => c.path);
  assert.equal(paths.includes("/zai/api/host"), false, "тенант не спрашивает /host (403)");
  assert.equal(paths.includes("/zai/api/usage"), false);
});

// ---- BUG-05.12: 20 attachments ----------------------------------------------------

const fakeFile = (name, size = 10, type = "application/pdf") => ({ name, size, type });
function pickFiles(root, files) {
  const input = $(root, 'input[type="file"]');
  Object.defineProperty(input, "files", { value: files, configurable: true });
  t$.fire(input, "change");
}

test("BUG-05.12: 20 вложений — 20 чипов в ряду .composer-chips, у каждого ✕; удаление чипа загруженного файла шлёт DELETE /upload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installFetch([
    { method: "POST", path: "/zai/api/upload", reply: (c) => ({ name: `s-${c.query.name}`, size: 10 }) },
    { method: "DELETE", path: "/zai/api/upload", reply: () => ({ ok: true }) },
  ]);
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const { root } = t$.mount(ui.Composer, { sessionId: SID, status: "idle", onSend: () => {}, onStop: () => {} });
  pickFiles(root, Array.from({ length: 20 }, (_, i) => fakeFile(`doc-${i}.pdf`)));
  await t$.waitFor(() => fetchCalls.filter((c) => c.method === "POST" && c.path === "/zai/api/upload").length === 20);
  await t$.waitFor(() => !root.querySelector(".is-uploading, .is-progress"));
  const row = $(root, ".composer-chips");
  assert.equal(!!row, true);
  assert.equal(row.querySelectorAll(".attach").length, 20);
  assert.equal(row.querySelectorAll("button.attach-x").length, 20);
  assert.equal($(root, ".composer-error"), null, "20 — в пределах лимита");
  const x = $$(row, "button.attach-x").find((b) => b.getAttribute("aria-label") === "Убрать doc-3.pdf");
  t$.click(x);
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "DELETE"));
  const del = fetchCalls.find((c) => c.method === "DELETE");
  assert.equal(del.path, "/zai/api/upload");
  assert.deepEqual(del.query, { directory: DIR, name: "s-doc-3.pdf" });
  assert.equal(row.querySelectorAll(".attach").length, 19);
  assert.equal(row.textContent.includes("doc-3.pdf"), false);
});

// ---- BUG-05.14: image viewer header -------------------------------------------------

const subText = () => ($(document.body, ".file-sub")?.textContent ?? "").replace(/\u00a0/g, " ");
function loadImage(img, w, h) {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  t$.fire(img, "load");
}

test("BUG-05.14: картинка из data:URL — шапка «PNG · W×H · размер»", async () => {
  const png = `data:image/png;base64,${Buffer.from(new Uint8Array(315)).toString("base64")}`;
  t$.mount(ui.FileViewer, { file: { dataUrl: png, name: "chart.png" }, onClose: () => {} });
  const img = await t$.waitFor(() => $(document.body, ".file-panel img.file-img"));
  loadImage(img, 1024, 768);
  await t$.waitFor(() => subText() === "PNG · 1024×768 · 315 Б");
});

test("BUG-05.14: картинка-результат по пути — формат, пиксели и вес из HEAD", async () => {
  // Фейковый fetch не умеет заголовки ответа — HEAD с content-length отдаём сами.
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) =>
    (init.method ?? "GET").toUpperCase() === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "2048" } }) : real(u, init);
  try {
    ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
    ui.store.setActiveId(SID);
    t$.mount(ui.FileViewer, { file: { path: `${DIR}\\shot.jpeg`, name: "shot.jpeg" }, onClose: () => {} });
    const img = await t$.waitFor(() => $(document.body, ".file-panel img.file-img"));
    loadImage(img, 640, 480);
    await t$.waitFor(() => subText() === "JPG · 640×480 · 2 КБ");
  } finally {
    globalThis.fetch = real;
  }
});

// ---- BUG-07.18: question tool title ----------------------------------------------

const qPart = (state) => ({ id: "p_q", type: "tool", tool: "question", callID: "c1", state: { status: "completed", ...state } });

test("BUG-07.18: инструмент вопроса — «Вопрос агента · <первый вопрос>», не «question · Asked 1 question»", () => {
  const { root } = t$.mount(ui.ToolCard, {
    part: qPart({ title: "Asked 1 question", input: { questions: [{ question: "Какой формат отчёта нужен?", options: [] }] } }),
  });
  const name = $(root, ".tool-name").textContent;
  assert.equal(name, "Вопрос агента · Какой формат отчёта нужен?");
  assert.equal(/question|Asked/i.test(root.querySelector(".tool-head").textContent), false);
});

test("BUG-07.18: без текста вопроса — счёт по-русски (2 вопроса, 5 вопросов, 21 вопрос)", () => {
  const a = t$.mount(ui.ToolCard, { part: qPart({ title: "Asked 2 questions", input: { questions: [{}, {}] } }) });
  assert.equal($(a.root, ".tool-name").textContent, "Вопрос агента · 2 вопроса");
  const b = t$.mount(ui.ToolCard, { part: qPart({ title: "Asked 5 questions", input: {} }) });
  assert.equal($(b.root, ".tool-name").textContent, "Вопрос агента · 5 вопросов");
  const c = t$.mount(ui.ToolCard, { part: qPart({ title: "Asked 21 questions", input: {} }) });
  assert.equal($(c.root, ".tool-name").textContent, "Вопрос агента · 21 вопрос");
});

// ---- BUG-05.13: a picture made by a bash command -----------------------------------

const asstWithBash = (status, command) => ({
  info: { id: "a_b", role: "assistant", sessionID: SID, time: { created: NOW, completed: NOW } },
  parts: [
    { id: "p_t", type: "tool", tool: "bash", callID: "c2", state: { status, input: { command, description: "plot" }, output: "", time: { start: NOW, end: NOW } } },
    { id: "p_x", type: "text", text: "Готово, график построен." },
  ],
});

test("BUG-05.13 + BUG-090: картинка, созданная командой bash, получает превью после подтверждения сервером; нет файла — нет карточки и нет <img> (нет 404)", async () => {
  ui.resetProbes();
  let exists = true;
  installFetch([{ method: "GET", path: "/zai/api/file/exists", reply: (c) => ({ exists: c.params.getAll("path").map(() => exists) }) }]);
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const { root } = t$.mount(ui.MessageBubble, { msg: asstWithBash("completed", "python plot.py --out charts/sales.png") });
  await t$.waitFor(() => $(root, ".file-card.is-image"));
  const fig = $(root, ".file-card.is-image");
  const img = $(fig, ".fc-tile img");
  const src = new URL(img.getAttribute("src"), "https://zai.test");
  assert.equal(src.pathname, "/zai/api/file");
  assert.equal(src.searchParams.get("path"), `${DIR}\\charts\\sales.png`);
  assert.equal(src.searchParams.get("directory"), DIR);
  assert.equal($(fig, ".fc-name").textContent, "sales");
  assert.equal($(fig, ".fc-sub").textContent, "Изображение · PNG");
  t$.cleanup();
  ui.resetProbes();
  exists = false;
  const again = t$.mount(ui.MessageBubble, { msg: asstWithBash("completed", "python plot.py --out charts/sales.png") }).root;
  await t$.flush();
  assert.equal($(again, ".file-card"), null, "несуществующая картинка из команды не показывает карточку");
  assert.equal($$(again, "img").length, 0, "и не грузится (нет 404 в консоли)");
});

test("BUG-05.13: незавершённый вызов bash превью не даёт", () => {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const { root } = t$.mount(ui.MessageBubble, { msg: asstWithBash("running", "python plot.py --out sales.png") });
  assert.equal($(root, ".file-card"), null);
});
