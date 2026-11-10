// FEAT-01.57 «Изменить» / «Сгенерировать заново» and FEAT-01.58 «Отменить
// ход» in the real ChatView (L2): the buttons of the last turn, the edit mode
// of the composer, the confirm sheet with the file list, the hidden turn with
// «Ход отменён · Вернуть», the busy state.
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
  ui.store.cancelEdit();
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.busyMap.value = {};
  installFetch();
});

const SID = "ses_rw";
const NOW = Date.now();
const SESSION = { id: SID, title: "Правки", directory: "C:\\work", time: { created: NOW, updated: NOW }, zai: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: null, prompted: true } };
const msg = (id, role, text, at) => ({
  info: { id, role, sessionID: SID, ...(role === "assistant" ? { providerID: "anthropic", modelID: "claude-opus-5-5", parentID: "u2" } : {}), time: { created: NOW + at, completed: role === "assistant" ? NOW + at + 1 : undefined } },
  parts: [{ id: `p_${id}`, type: "text", text }],
});
const HISTORY = [msg("u1", "user", "Первый вопрос", 0), msg("a1", "assistant", "Первый ответ", 10), msg("u2", "user", "Поправь note.txt", 20), msg("a2", "assistant", "Поправил", 30)];

function routes({ list = [SESSION], messages = HISTORY, preview = { engine: "claude", files: [{ path: "note.txt", action: "restore" }, { path: "new.txt", action: "delete" }, { path: "late.txt", action: "restore", skipped: "changed-after" }], shell: true }, revertStatus = 200 } = {}) {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => list },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => messages },
    { method: "GET", path: `/zai/api/session/${SID}/revert`, reply: () => preview },
    { method: "POST", path: `/zai/api/session/${SID}/revert`, reply: (c) => (revertStatus === 200 ? { ok: true, revert: { messageID: c.body.messageID }, files: [], skipped: [] } : { status: revertStatus, body: { error: "turn in progress" } }) },
    { method: "POST", path: `/zai/api/session/${SID}/unrevert`, reply: () => ({ ok: true }) },
    { method: "POST", path: `/zai/api/session/${SID}/prompt`, reply: () => ({ status: 204, body: null }) },
  ]);
}

async function open() {
  routes();
  ui.store.sessions.value = [SESSION];
  const v = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(v.root, ".msg").length >= 4);
  return v.root;
}
const calls = (method, tail) => fetchCalls.filter((c) => c.method === method && c.path === `/zai/api/session/${SID}/${tail}`);

test("buttons: «Изменить» only under the last question, «Сгенерировать заново» and «⋯» only on the last turn; disabled while busy", async () => {
  const root = await open();
  const edits = $$(root, 'button[aria-label="Изменить сообщение"]');
  assert.equal(edits.length, 1, "one pencil");
  assert.ok(edits[0].closest(".msg-user").textContent.includes("Поправь note.txt"), "under the LAST question");
  assert.equal($$(root, 'button[aria-label="Сгенерировать заново"]').length, 1);
  assert.equal($$(root, 'button[aria-label="Действия с ходом"]').length, 1);

  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, status: "busy" };
  });
  assert.equal($(root, 'button[aria-label="Изменить сообщение"]'), null, "no pencil while a turn runs");
});

test("«Изменить»: the text goes into the composer with «Правка сообщения · Отмена»; «Отмена» brings the draft back", async () => {
  const root = await open();
  const ta = $(root, "textarea.composer-ta");
  t$.typeInto(ta, "черновик");
  t$.click($(root, 'button[aria-label="Изменить сообщение"]'));
  await t$.waitFor(() => $(root, ".edit-bar"));
  assert.match($(root, ".edit-bar").textContent, /Правка сообщения/);
  assert.equal($(root, "textarea.composer-ta").value, "Поправь note.txt");
  assert.ok($(root, ".bubble-user.is-editing"), "the edited bubble is marked");
  t$.click(byText(root, ".edit-bar button", "Отмена"));
  await t$.waitFor(() => !$(root, ".edit-bar"));
  assert.equal($(root, "textarea.composer-ta").value, "черновик");
});

test("«Изменить» + send: revert of the last question, then the new text as the next prompt; the old answer leaves the feed", async () => {
  const root = await open();
  t$.click($(root, 'button[aria-label="Изменить сообщение"]'));
  await t$.waitFor(() => $(root, ".edit-bar"));
  t$.typeInto($(root, "textarea.composer-ta"), "Поправь note.txt иначе");
  t$.click($(root, "button.send-btn"));
  await t$.waitFor(() => calls("POST", "prompt").length === 1);
  assert.deepEqual(calls("POST", "revert")[0].body, { messageID: "u2" });
  assert.equal(calls("POST", "prompt")[0].body.parts[0].text, "Поправь note.txt иначе");
  await t$.waitFor(() => !$(root, ".edit-bar"));
  assert.equal(root.textContent.includes("Поправил"), false, "the previous answer is gone");
  assert.equal(root.textContent.includes("Первый ответ"), true);
});

test("«Сгенерировать заново»: revert + the same question again", async () => {
  const root = await open();
  t$.click($(root, 'button[aria-label="Сгенерировать заново"]'));
  await t$.waitFor(() => calls("POST", "prompt").length === 1);
  assert.deepEqual(calls("POST", "revert")[0].body, { messageID: "u2" });
  assert.equal(calls("POST", "prompt")[0].body.parts[0].text, "Поправь note.txt");
});

test("«Отменить ход»: ⋯ → sheet with the files and the shell warning → confirm → «Ход отменён · Вернуть»; «Вернуть» → unrevert", async () => {
  const root = await open();
  t$.click($(root, 'button[aria-label="Действия с ходом"]'));
  const row = await t$.waitFor(() => byText(document.body, ".turn-menu-row", "Отменить ход"));
  t$.click(row);
  await t$.waitFor(() => $$(document.body, ".undo-file").length === 3);
  const files = $$(document.body, ".undo-file").map((li) => li.textContent);
  assert.match(files[0], /note\.txt.*вернётся прежняя версия/);
  assert.match(files[1], /new\.txt.*будет удалён/);
  assert.match(files[2], /late\.txt.*изменён после хода — не откатится/);
  assert.match($(document.body, ".undo-warn").textContent, /командами оболочки, не откатываются/);
  assert.match($(document.body, ".sheet-section-title").textContent, /Откатятся файлы: 2/);
  t$.click(byText(document.body, ".sheet-footer button", "Отменить ход"));
  await t$.waitFor(() => $(root, ".turn-reverted"));
  assert.deepEqual(calls("POST", "revert")[0].body, { messageID: "u2" });
  assert.equal(root.textContent.includes("Поправь note.txt"), false, "the turn is hidden");
  assert.equal(root.textContent.includes("Первый ответ"), true);
  assert.equal($(root, 'button[aria-label="Изменить сообщение"]'), null, "no rewind on a hidden turn");

  t$.click(byText(root, ".turn-reverted button", "Вернуть"));
  await t$.waitFor(() => !$(root, ".turn-reverted"));
  assert.equal(calls("POST", "unrevert").length, 1);
  assert.equal(root.textContent.includes("Поправил"), true, "the turn is back");
});

test("a hidden turn from the server (session.revert) is cut from the feed; a new message drops it for good", async () => {
  routes({ list: [{ ...SESSION, revert: { messageID: "u2" } }] });
  ui.store.sessions.value = [{ ...SESSION, revert: { messageID: "u2" } }];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $(root, ".turn-reverted"));
  assert.equal($$(root, ".msg").length, 2);
  t$.typeInto($(root, "textarea.composer-ta"), "Новый вопрос");
  routes({ messages: HISTORY.slice(0, 2) }); // the server commits the revert with the prompt
  t$.click($(root, "button.send-btn"));
  await t$.waitFor(() => calls("POST", "prompt").length === 1);
  await t$.waitFor(() => !$(root, ".turn-reverted"));
  assert.equal(ui.store.sessions.value.find((s) => s.id === SID).revert, undefined);
  assert.equal(root.textContent.includes("Поправил"), false);
});

test("revert refused (409): a notice, the edit stays in the composer", async () => {
  const root = await open();
  routes({ revertStatus: 409 });
  t$.click($(root, 'button[aria-label="Изменить сообщение"]'));
  await t$.waitFor(() => $(root, ".edit-bar"));
  t$.typeInto($(root, "textarea.composer-ta"), "другой текст");
  t$.click($(root, "button.send-btn"));
  await t$.waitFor(() => calls("POST", "revert").length === 1);
  await t$.flush();
  assert.equal(calls("POST", "prompt").length, 0);
  assert.ok($(root, ".edit-bar"), "still editing");
  assert.equal($(root, "textarea.composer-ta").value, "другой текст");
  assert.match(String(ui.store.notice.value), /Ход уже идёт/);
});

test("BUG-145: opencode-чат в git-папке — шит объясняет, почему отмена недоступна, кнопка неактивна, revert не уходит", async () => {
  const root = await open();
  routes({ preview: { engine: "opencode", files: [], shell: false, blocked: "git-dir" } }); // open() ставит свои маршруты
  t$.click($(root, 'button[aria-label="Действия с ходом"]'));
  t$.click(await t$.waitFor(() => byText(document.body, ".turn-menu-row", "Отменить ход")));
  const note = await t$.waitFor(() => $(document.body, ".undo-note.is-error"));
  assert.match(note.textContent, /папке git-репозитория/);
  const btn = byText(document.body, ".sheet-footer button", "Отменить ход");
  assert.equal(btn.disabled, true);
  t$.click(btn);
  await t$.flush();
  assert.equal(calls("POST", "revert").length, 0);
});
