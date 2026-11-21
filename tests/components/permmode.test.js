// FEAT-18.4 / FEAT-18.3 (L2): пилюля «Режим прав» в ModelBar (выбор, показ,
// тенанту нет «Без вопросов», во время хода не меняется, откат при отказе)
// и фильтр «Ждут вас» в списке чатов (источник — открытые диалоги, как у
// бейджа «⏸ разрешение»).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ModelBar: "src/components/chat/ModelBar.jsx", HomeView: "src/components/views/HomeView.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.providerCfg.value = null;
  ui.store.notice.value = null;
  ui.store.dialogs.value = [];
  ui.store.busyMap.value = {};
  ui.store.me.value = null;
  installFetch();
});

const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const CFG = { models: [{ id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5 (anthropic)" }, { id: "glm-5.3", providerID: "zai-coding-plan", label: "GLM-5.3 (zai-coding-plan)" }] };
function seed(teleharness, role = "admin") {
  ui.store.me.value = { id: role === "admin" ? "admin" : "u_t", role };
  ui.store.providerCfg.value = CFG;
  ui.store.sessions.value = [{ id: "ses_m", title: "", directory: "C:\\Home", time: { created: 1, updated: 1 }, teleharness }];
}
const permPill = (root) => $(root, ".model-bar .perm-pill");
const sheetRows = () => [...document.querySelectorAll(".sheet button.picker-row")];
const titles = () => sheetRows().map((r) => r.querySelector(".picker-row-title").textContent);

test("admin, Claude-чат без выбора: пилюля «Без вопросов» (умолчание), три режима; выбор «Спрашивать» → PATCH {permMode}", async () => {
  installFetch([{ method: "PATCH", path: /\/binding$/, reply: (c) => ({ teleharness: { engine: "claude", model: OPUS, agent: null, prompted: true, permMode: c.body.permMode } }) }]);
  seed({ model: OPUS, agent: null, prompted: true });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  assert.equal($$(root, ".model-pill").length, 2, "пилюли модели и агента не тронуты");
  assert.equal(permPill(root).textContent.trim(), "Без вопросов");
  assert.equal(permPill(root).getAttribute("aria-label"), "Режим прав: Без вопросов. Сменить");
  t$.click(permPill(root));
  await t$.flush();
  assert.equal(document.querySelector(".sheet").getAttribute("aria-label"), "Режим прав");
  assert.deepEqual(titles(), ["Спрашивать", "Правки без вопросов", "Без вопросов"]);
  assert.equal(sheetRows()[2].getAttribute("aria-pressed"), "true");
  assert.match(document.querySelector(".sheet .picker-foot").textContent, /со следующего хода/);
  t$.click(sheetRows()[0]);
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PATCH"));
  assert.deepEqual(fetchCalls.find((c) => c.method === "PATCH").body, { permMode: "ask" });
  await t$.waitFor(() => permPill(root).textContent.trim() === "Спрашивать");
  assert.ok(permPill(root).classList.contains("is-ask"));
});

test("тенант: умолчание «Правки», пункта «Без вопросов» нет", async () => {
  seed({ model: OPUS, agent: null, prompted: true }, "user");
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  assert.equal(permPill(root).textContent.trim(), "Правки");
  t$.click(permPill(root));
  await t$.flush();
  assert.deepEqual(titles(), ["Спрашивать", "Правки без вопросов"]);
  assert.match(document.querySelector(".sheet .picker-foot").textContent, /только администратору/);
});

test("тенант: сохранённый «full» не показывается шире роли; opencode-чат тенанта — режима прав нет, «Сначала план» серый с причиной (FEAT-20.1 N-22)", async () => {
  seed({ model: OPUS, agent: null, prompted: true, permMode: "full" }, "user");
  let m = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  assert.equal(permPill(m.root).textContent.trim(), "Правки");
  t$.cleanup();
  seed({ model: GLM, agent: "ask", prompted: true }, "user");
  m = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  assert.equal(permPill(m.root).textContent.trim(), "План", "режима прав нет — пилюля ведёт только к «Сначала план»");
  t$.click(permPill(m.root));
  await t$.flush();
  assert.equal(sheetRows().length, 0, "режимов прав opencode тенанту нет");
  const box = document.querySelector(".sheet .pl-toggle input");
  assert.equal(box.disabled, true);
  assert.match(document.querySelector(".sheet .pl-toggle").textContent, /нет агента «plan».*администратора/);
});

test("во время хода режим не меняется: пункты выключены, подсказка", async () => {
  seed({ model: OPUS, agent: null, prompted: true, permMode: "ask" });
  ui.store.busyMap.value = { ses_m: { type: "busy" } };
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  t$.click(permPill(root));
  await t$.flush();
  assert.ok(sheetRows().every((r) => r.disabled));
  assert.match(document.querySelector(".sheet").textContent, /Идёт ответ/);
});

test("отказ сервера (403) — откат режима и понятный текст", async () => {
  installFetch([{ method: "PATCH", path: /\/binding$/, reply: () => ({ status: 403, body: { error: "permission mode not allowed" } }) }]);
  seed({ model: OPUS, agent: null, prompted: true, permMode: "ask" });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  t$.click(permPill(root));
  await t$.flush();
  t$.click(sheetRows()[1]);
  await t$.waitFor(() => ui.store.notice.value);
  assert.match(String(ui.store.notice.value?.text ?? ui.store.notice.value), /только администратору/);
  await t$.waitFor(() => permPill(root).textContent.trim() === "Спрашивать");
});

const NOW = Date.now();
const ses = (id, title) => ({ id, title, directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } });

test("HomeView: «Ждут вас» — только чаты с открытым запросом; счётчик; «Показать все» при пустом", async () => {
  const list = [ses("ses_a", "Отчёт"), ses("ses_b", "Задача"), ses("ses_c", "Письмо")];
  installFetch([{ method: "GET", path: "/teleharness/api/session", reply: () => list }]);
  ui.store.sessions.value = list;
  ui.store.dialogs.value = [
    { kind: "permission", id: "per_1", sessionID: "ses_a" },
    { kind: "question", id: "que_1", sessionID: "ses_c" },
  ];
  const { root } = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(root, ".swipe").length === 3);
  const chip = $(root, ".filter-chip");
  assert.ok(chip, "фильтр показан, когда кто-то ждёт");
  assert.equal(chip.getAttribute("aria-pressed"), "false");
  assert.equal($(root, ".filter-count").textContent, "2");
  t$.click(chip);
  await t$.waitFor(() => $$(root, ".swipe").length === 2);
  const shown = $$(root, ".session-title").map((e) => e.textContent);
  assert.deepEqual(shown.sort(), ["Отчёт", "Письмо"]);
  assert.equal($(root, ".filter-chip").getAttribute("aria-pressed"), "true");
  // запросы закрыты — пусто и кнопка «Показать все»
  ui.store.dialogs.value = [];
  await t$.waitFor(() => /никто не ждёт/.test(root.textContent));
  const all = $$(root, ".link-btn").find((b) => b.textContent === "Показать все");
  t$.click(all);
  await t$.waitFor(() => $$(root, ".swipe").length === 3);
  assert.equal($(root, ".filter-chip"), null, "никто не ждёт — фильтра нет");
});

// Стенд 2026-11-15: первое сообщение opencode-чата в режиме «Спрашивать» сбрасывало пилюлю на «Без вопросов»
// (до перезагрузки): клиент отмечал чат «prompted» копией привязки из bindingOf — без permMode и relays.
test("первое сообщение не теряет режим прав и отметки передач чата", async () => {
  const SID = "ses_first";
  installFetch([{ method: "POST", path: `/teleharness/api/session/${SID}/prompt`, reply: () => ({ status: 204, body: null }) }]);
  ui.store.me.value = { id: "admin", role: "admin" };
  ui.store.providerCfg.value = CFG;
  const relays = [{ at: 1, from: { engine: "claude" }, to: { engine: "opencode" } }];
  ui.store.sessions.value = [{ id: SID, title: "Т", directory: "C:\Home", time: { created: 1, updated: 1 }, teleharness: { engine: "opencode", model: GLM, agent: null, prompted: false, permMode: "ask", relays } }];
  ui.store.active.value = { id: SID, status: "idle", messages: [] };
  const ok = await ui.store.send({ text: "привет", sessionId: SID });
  assert.equal(ok, true);
  const z = ui.store.sessions.value.find((s) => s.id === SID).teleharness;
  assert.equal(z.prompted, true, "чат отмечен как начатый");
  assert.equal(z.permMode, "ask", "режим прав сохранён");
  assert.deepEqual(z.relays, relays, "отметки передач сохранены");
});
