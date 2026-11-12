// C2 ChatView (L2, TASK-14.7): экраны пустой ленты (not-found / история не
// загрузилась / «Чем займёмся?»), баннеры низа: stall «Ответа долго нет» убран (FEAT-07.22),
// replay «попытка N/M», исчерпано «Отправить снова», ошибка хода. Кейсы
// TC-CHAT-001, TC-STALL-001/002, BUG-01.19, BUG-016.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ChatView: "src/components/views/ChatView.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.dialogs.value = [];
  if (s.stalled) s.stalled.value = false;
  if (s.pendingMap) s.pendingMap.value = {};
  installFetch();
});

const SID = "ses_cv";
const NOW = Date.now();
const SESSION = { id: SID, title: "Отчёт", directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } };
const msg = (id, role, text, extra = {}) => ({
  info: { id, role, sessionID: SID, time: { created: NOW, completed: role === "assistant" ? NOW : undefined }, ...extra },
  parts: [{ id: `p_${id}`, type: "text", text }],
});
const HISTORY = [msg("m1", "user", "Привет"), msg("m2", "assistant", "Здравствуйте")];

function routes({ list = [SESSION], messages = HISTORY, msgStatus = 200 } = {}) {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => list },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => (msgStatus === 200 ? messages : { status: msgStatus, body: { error: "x" } }) },
    { method: "GET", path: /\/zai\/api\/session\/[^/]+\/message$/, reply: () => ({ status: 404, body: { error: "not found" } }) },
  ]);
}
const bottomText = (root) => $(root, ".chat-bottom")?.textContent ?? "";

test("чат, которого нет в списке, + 404 истории → «Чат не найден» и «К чатам»", async () => {
  routes({ list: [] });
  const { root } = t$.mount(ui.ChatView, { id: "ses_gone" });
  const hero = await t$.waitFor(() => byText(root, "h2.hero", "Чат не найден"));
  assert.equal(!!hero, true);
  assert.equal(!!byText(root, "button.empty-cta", "К чатам"), true);
});

test("чат в списке, история упала → «История не загрузилась» + «Повторить» перезапрашивает", async () => {
  routes({ msgStatus: 502 });
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => byText(root, "h2.hero", "История не загрузилась"));
  const before = fetchCalls.filter((c) => c.path === `/zai/api/session/${SID}/message`).length;
  routes();
  t$.click(byText(root, "button.empty-cta", "Повторить"));
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  const after = fetchCalls.filter((c) => c.path === `/zai/api/session/${SID}/message`).length;
  assert.equal(after >= 1 && after + before >= 2, true, "повторный GET истории");
});

// FEAT-09.20: пустой чат — знак zai и приветствие по времени суток + имя.
test("пустой чат → знак и приветствие «…, <имя>» и композер (FEAT-09.20)", async () => {
  routes({ messages: [] });
  ui.store.sessions.value = [SESSION];
  ui.store.me.value = { id: "u1", name: "Anna Kim", role: "admin" };
  const { root } = t$.mount(ui.ChatView, { id: SID });
  const h = await t$.waitFor(() => $(root, ".chat-greeting h2.hero"));
  assert.match(h.textContent, /^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), Anna Kim$/);
  assert.ok($(root, ".chat-greeting svg.zai-mark"), "знак zai над приветствием");
  assert.equal(!!$(root, "footer.composer textarea"), true);
});

test("шапка чата: из «Чатов» — кнопка ☰ меню, не «Назад» (FEAT-09.20)", async () => {
  routes();
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $(root, ".chat-header"));
  assert.ok($(root, '.chat-header .menu-btn[aria-label="Меню"]'), "кнопка меню");
  assert.equal($(root, '.chat-header [aria-label="Назад"]'), null, "без «Назад»");
});

test("stall: busy + тишина → баннера «Ответа долго нет» и «Прервать» нет, ■ в композере есть (FEAT-07.22)", async () => {
  routes();
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  t$.act(() => { ui.store.active.value = { ...ui.store.active.value, status: "busy" }; ui.store.stalled.value = true; });
  await t$.flush();
  assert.equal(bottomText(root).includes("Ответа долго нет"), false, "тишина хода не даёт баннера (FEAT-07.22)");
  assert.equal(!!byText(root, ".chat-bottom button.stall-btn", "Прервать"), false, "кнопки «Прервать» нет");
  assert.equal($$(root, ".chat-bottom .stall-bar").length, 0, "низ чата без баннеров");
  assert.ok($(root, '.composer button[aria-label="Остановить"]'), "остановка — кнопкой ■ композера");
  t$.act(() => { ui.store.active.value = { ...ui.store.active.value, status: "idle" }; ui.store.stalled.value = false; });
});

test("replay: «попытка 1/2» → исчерпано → «Отправить снова» (TC-STALL-002)", async () => {
  routes();
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  t$.act(() => { ui.store.pendingMap.value = { [SID]: { replays: 0, max: 2 } }; });
  await t$.flush();
  assert.match(bottomText(root), /попытка 1\/2/);
  t$.act(() => { ui.store.pendingMap.value = { [SID]: { replays: 2, max: 2 } }; });
  await t$.flush();
  assert.match(bottomText(root), /Ответ не пришёл/);
  assert.equal(!!byText(root, ".chat-bottom button.stall-btn", "Отправить снова"), true);
  t$.act(() => { ui.store.pendingMap.value = {}; });
  await t$.flush();
  assert.equal($$(root, ".chat-bottom .stall-bar").length, 0, "ответ пришёл — баннеров нет");
});

test("ошибка хода (turnError) → баннер с заголовком, «Повторить» и «×» (BUG-07.14)", async () => {
  routes();
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, status: "idle", turnError: { title: "Модель недоступна", text: "Провайдер вернул ошибку", actions: ["retry"] } };
  });
  await t$.flush();
  const bar = $(root, ".stall-bar.turn-error");
  assert.equal(!!bar, true);
  assert.match(bar.textContent, /Модель недоступна\./);
  assert.equal(!!byText(root, ".turn-error button.stall-btn", "Повторить"), true);
  assert.equal(!!$(root, '.turn-error button[aria-label="Скрыть"]'), true);
});

test("картинка по относительному имени из текста не загрузилась → карточка скрыта целиком; абсолютный путь — карточка с иконкой (ISSUE-003, FEAT-05.17)", async () => {
  const dir = SESSION.directory;
  const answer = msg("m2", "assistant", `Скриншоты: shots/v2-qa-viewer-png.png и ${dir}\\abs-shot.png`);
  routes({ messages: [msg("m1", "user", "Покажи"), answer] });
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  // BUG-090: the guessed relative picture is checked first (/file/exists —
  // here unanswered → unknown) and never gets an <img>: no 404 probe.
  await t$.waitFor(() => $$(root, ".file-card.is-image").length === 1);
  await t$.flush();
  const imgs = $$(root, ".file-card .fc-tile img");
  assert.equal(imgs.length, 1, "only the absolute (not guessed) picture loads");
  t$.act(() => {
    for (const img of imgs) img.dispatchEvent(new window.Event("error"));
  });
  await t$.flush();
  const cards = $$(root, ".file-card");
  assert.equal(cards.length, 1, "угаданная относительная картинка исчезла");
  assert.match(cards[0].getAttribute("aria-label"), /abs-shot\.png/);
  assert.equal($$(cards[0], ".fc-tile img").length, 0, "абсолютный путь — карточка остаётся, вместо миниатюры иконка");
  assert.equal(root.textContent.includes("v2-qa-viewer-png.png"), true, "имя осталось только в тексте ответа");
});
