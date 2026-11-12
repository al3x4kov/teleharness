// C5 DialogBar (L2, TASK-14.7): инлайн-карточка разрешения/вопроса над
// композером — кнопки, «+N» очереди, «Свой ответ», отправка ответа.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ DialogBar: "src/components/chat/DialogBar.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.dialogs.value = [];
  installFetch();
});

const perm = (extra = {}) => ({
  id: "per_1",
  kind: "permission",
  sessionID: "ses_1",
  permission: "bash",
  command: "rm -rf build",
  always: ["rm *"],
  ...extra,
});

const question = (extra = {}) => ({
  id: "que_1",
  kind: "question",
  sessionID: "ses_1",
  questions: [
    {
      header: "Какой вариант?",
      question: "Выберите стратегию",
      options: [{ label: "Быстро", description: "без тестов" }, "Надёжно"],
    },
  ],
  ...extra,
});

test("permission: Отклонить / Разрешить / Всегда разрешать + команда", () => {
  const { root } = t$.mount(ui.DialogBar, { dialog: perm(), queue: 0 });
  const card = $(root, 'section.dlg-card[role="region"]');
  assert.ok(card, "карточка-регион");
  assert.equal(card.getAttribute("aria-label"), "Запрос разрешения");
  assert.ok(byText(root, "button.dlg-btn--reject", "Отклонить"));
  assert.ok(byText(root, "button.dlg-btn--allow", "Разрешить"));
  const always = byText(root, "button.dlg-btn--always", "Всегда разрешать");
  assert.ok(always);
  assert.match(always.textContent, /rm \*/);
  assert.equal($(root, ".dlg-tool").textContent, "bash");
  assert.match($(root, ".dlg-cmd code").textContent, /rm -rf build/);
  assert.equal($(root, ".dlg-queue"), null, "без очереди нет «+N»");
});

test("permission без always — кнопки «Всегда» нет", () => {
  const { root } = t$.mount(ui.DialogBar, { dialog: perm({ always: [] }), queue: 0 });
  assert.equal($(root, ".dlg-btn--always"), null);
  assert.equal($$(root, ".dlg-actions button").length, 2);
});

test("«+N» при очереди диалогов", () => {
  const { root } = t$.mount(ui.DialogBar, { dialog: perm(), queue: 3 });
  assert.equal($(root, ".dlg-queue").textContent, "+3");
  t$.cleanup();
  const q = t$.mount(ui.DialogBar, { dialog: question(), queue: 1 });
  assert.equal($(q.root, ".dlg-queue").textContent, "+1");
});

test("Отклонить → «Отправлено», затем POST reply {reply:'reject'} и диалог уходит", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installFetch([{ method: "POST", path: /^\/zai\/api\/permission\/per_1\/reply$/, reply: () => true }]);
  const d = perm();
  ui.store.dialogs.value = [d];
  const { root } = t$.mount(ui.DialogBar, { dialog: d, queue: 0 });
  t$.click(byText(root, "button", "Отклонить"));
  assert.ok(byText(root, ".dlg-sent", "Отправлено"), "флеш «Отправлено»");
  assert.equal($(root, ".dlg-actions"), null, "кнопки скрыты — повторный тап невозможен");
  assert.equal(fetchCalls.length, 0, "ответ уходит после 150 мс флеша");
  t.mock.timers.tick(150);
  await t$.waitFor(() => fetchCalls.some((c) => c.path === "/zai/api/permission/per_1/reply"));
  const call = fetchCalls.find((c) => c.path === "/zai/api/permission/per_1/reply");
  assert.deepEqual(call.body, { reply: "reject" });
  assert.equal(ui.store.dialogs.value.length, 0, "оптимистично убран из очереди");
});

test("Всегда разрешать → reply 'always'", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installFetch([{ method: "POST", path: /\/permission\/per_1\/reply$/, reply: () => true }]);
  const { root } = t$.mount(ui.DialogBar, { dialog: perm(), queue: 0 });
  t$.click($(root, ".dlg-btn--always"));
  t.mock.timers.tick(150);
  await t$.waitFor(() => fetchCalls.length > 0);
  assert.deepEqual(fetchCalls[0].body, { reply: "always" });
});

test("ошибка отправки: dialog.error → текст ошибки и причина, кнопки снова доступны", () => {
  const { root } = t$.mount(ui.DialogBar, {
    dialog: perm({ error: true, errorReason: "нет соединения с сервером" }),
    queue: 0,
  });
  const err = $(root, '.dlg-error[role="alert"]');
  assert.ok(err);
  assert.match(err.textContent, /Не удалось отправить ответ/);
  assert.match(err.textContent, /нет соединения с сервером/);
  assert.ok(byText(root, "button", "Разрешить"));
});

test("question: заголовок, вопрос, варианты с описанием, «Свой ответ»", () => {
  const { root } = t$.mount(ui.DialogBar, { dialog: question(), queue: 0 });
  assert.equal($(root, "section.dlg-card").getAttribute("aria-label"), "Какой вариант?");
  assert.equal($(root, ".dlg-title").textContent, "Какой вариант?");
  assert.equal($(root, ".dlg-question").textContent, "Выберите стратегию");
  const opts = $$(root, "button.dlg-option");
  assert.deepEqual(opts.map((o) => $(o, ".dlg-option-label").textContent), ["Быстро", "Надёжно"]);
  assert.equal($(opts[0], ".dlg-option-desc").textContent, "без тестов");
  assert.ok(byText(root, "button.dlg-custom-toggle", "Свой ответ"));
});

test("question: вариант → POST answers string[][]", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installFetch([{ method: "POST", path: /\/question\/que_1\/reply$/, reply: () => true }]);
  const { root } = t$.mount(ui.DialogBar, { dialog: question(), queue: 0 });
  t$.click($$(root, "button.dlg-option")[1]);
  assert.ok(byText(root, ".dlg-sent", "Отправлено"));
  t.mock.timers.tick(150);
  await t$.waitFor(() => fetchCalls.length > 0);
  assert.deepEqual(fetchCalls[0].body, { answers: [["Надёжно"]] });
});

test("«Свой ответ»: поле, «Отправить» заблокирована на пустом, отправляет введённое", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installFetch([{ method: "POST", path: /\/question\/que_1\/reply$/, reply: () => true }]);
  const { root } = t$.mount(ui.DialogBar, { dialog: question(), queue: 0 });
  t$.click($(root, ".dlg-custom-toggle"));
  const ta = $(root, "textarea.dlg-custom-input");
  assert.ok(ta, "поле своего ответа");
  const sendBtn = byText(root, "button.dlg-custom-send", "Отправить");
  assert.equal(sendBtn.disabled, true, "пустой ответ не отправить");
  t$.typeInto(ta, "  третий путь  ");
  assert.equal($(root, "button.dlg-custom-send").disabled, false);
  t$.click($(root, "button.dlg-custom-send"));
  t.mock.timers.tick(150);
  await t$.waitFor(() => fetchCalls.length > 0);
  assert.deepEqual(fetchCalls[0].body, { answers: [["третий путь"]] });
});

test("BUG-01.75: поле «Свой ответ» названо для скринридера заголовком вопроса", () => {
  const { root } = t$.mount(ui.DialogBar, { dialog: question(), queue: 0 });
  t$.click(byText(root, "button", "Свой ответ"));
  const field = $(root, "textarea.dlg-custom-input");
  assert.ok(field, "поле открылось");
  assert.equal(field.getAttribute("aria-label"), "Свой ответ: Какой вариант?");
});
