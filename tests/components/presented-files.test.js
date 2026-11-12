// FEAT-05.29: файл, показанный агентом ссылкой [имя](абсолютный путь), — карточка в чате
// из исходного места; путь из текста убран; недоступный файл — понятная строка, не голый путь.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    MessageBubble: "src/components/chat/MessageBubble.jsx",
    resetProbes: "src/lib/file-probe.js#resetProbes",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.resetProbes();
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.setActiveId(null);
  installFetch();
});

const SID = "ses_pf";
const DIR = "C:\\Users\\USER";
const OUT1 = "D:\\Portal\\zai\\design\\frame-1.png";
const OUT2 = "D:\\Portal\\zai\\design\\brief.pdf";
const T0 = Date.UTC(2026, 10, 11, 18, 0, 0);
const user = { info: { id: "u1", role: "user", sessionID: SID, time: { created: T0 } }, parts: [{ id: "pu", type: "text", text: "пришли макеты" }] };
const answerOf = (text) => ({ info: { id: "a1", role: "assistant", sessionID: SID, time: { created: T0 + 1000, completed: T0 + 9000 } }, parts: [{ id: "pt", type: "text", text }] });
const setup = (answer) => {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  ui.store.active.value = { id: SID, status: "idle", messages: [user, answer] };
};

test("FEAT-05.29: файл вне папки чата, показанный ссылкой, — карточка с превью; путь в тексте заменён названием", async () => {
  const asked = [];
  installFetch([{ method: "GET", path: "/zai/api/file/exists", reply: (c) => { const p = c.params.getAll("path"); asked.push(...p); return { exists: p.map(() => true) }; } }]);
  const answer = answerOf(`Вот макеты:\n\n![Кадр 1](${OUT1})\n\n[Бриф](${OUT2})`);
  setup(answer);
  const { root } = t$.mount(ui.MessageBubble, { msg: answer });
  assert.equal($$(root, ".file-card").length, 0, "до ответа сервера карточек нет");
  await t$.waitFor(() => $$(root, ".file-card").length === 2);
  assert.deepEqual(asked.sort(), [OUT2, OUT1].sort(), "доступность проверена на сервере");
  const img = $(root, ".file-card.is-image .fc-tile img");
  assert.equal(new URL(img.getAttribute("src"), "https://z").searchParams.get("path"), OUT1, "превью — из исходного места, без копии");
  // строки, где была только ссылка на файл, после появления карточек убраны: карточка — и есть файл
  await t$.waitFor(() => !$(root, ".md").textContent.includes("Кадр 1"));
  const body = $(root, ".md").textContent;
  assert.ok(!body.includes("D:\\Portal"), "пути на сервере в тексте нет: " + body);
  assert.match(body, /Вот макеты:/);
  assert.ok(!body.includes("Бриф"), "название под карточкой не повторяется: " + body);
});

test("FEAT-05.29: файл недоступен этой учётной записи — строка «недоступен в этом чате», не карточка и не путь", async () => {
  installFetch([{ method: "GET", path: "/zai/api/file/exists", reply: (c) => ({ exists: c.params.getAll("path").map(() => false) }) }]);
  const answer = answerOf(`Держите: [Секрет](${OUT2})`);
  setup(answer);
  const { root } = t$.mount(ui.MessageBubble, { msg: answer });
  const note = await t$.waitFor(() => $(root, ".file-card.is-unavailable"));
  assert.match(note.textContent, /brief/);
  assert.match(note.textContent, /недоступен в этом чате/);
  assert.equal(note.tagName, "DIV", "не кнопка — открывать нечего");
  assert.equal($$(root, "button.file-card").length, 0);
  assert.ok(!$(root, ".md").textContent.includes("D:\\Portal"));
});
