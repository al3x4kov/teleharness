// zai 1.7.2 client joints to the server half (openspec bugfix-1.7.2):
//   BUG-11.13 / BUG-082  an empty turn (EmptyTurnError: live session.error and
//                        info.error in history) → its own card «Модель вернула
//                        пустой ответ» with «Повторить» (resend of the last
//                        question);
//   BUG-04.6  / BUG-077  DELETE /admin/users/:id answers warnings → «Доступ»
//                        tells the admin which folders stayed and that the
//                        server retries.
// Run: node --test tests/components/joints-172.test.js
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    AccessSection: "src/components/views/AccessSection.jsx",
    deleteWarningsText: "src/components/views/AccessSection.jsx#deleteWarningsText",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.dialogs.value = [];
  s.active.value = null;
  if (s.pendingMap) s.pendingMap.value = {};
  installFetch();
});

const SID = "ses_empty";
const NOW = Date.now();
const SESSION = { id: SID, title: "Пустой ход", directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } };
const EMPTY = { name: "EmptyTurnError", data: { message: "Модель завершила ход без ответа и без ошибки (пустой ответ)." } };
const user = { info: { id: "m1", role: "user", sessionID: SID, time: { created: NOW } }, parts: [{ id: "p1", type: "text", text: "Столица Италии?" }] };
const emptyAnswer = (error) => ({
  info: { id: "m2", role: "assistant", sessionID: SID, time: { created: NOW, completed: NOW }, ...(error ? { error } : {}) },
  parts: [{ id: "p2", type: "step-start" }],
});

function routes(messages) {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => messages },
    { method: "POST", path: `/zai/api/session/${SID}/prompt`, reply: () => ({ status: 204, body: null }) },
  ]);
}

test("BUG-11.13: info.error EmptyTurnError in history → card «Модель вернула пустой ответ» + «Повторить» resends the last question", async () => {
  routes([user, emptyAnswer(EMPTY)]);
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  const bar = await t$.waitFor(() => $(root, ".stall-bar.turn-error"));
  assert.match(bar.textContent, /Модель вернула пустой ответ\./);
  assert.doesNotMatch(bar.textContent, /Провайдер вернул ошибку/, "not the generic «unknown» face");
  const retry = byText(root, ".turn-error button.stall-btn", "Повторить");
  assert.ok(retry, "«Повторить» is offered");
  t$.click(retry);
  const call = await t$.waitFor(() => fetchCalls.find((c) => c.method === "POST" && c.path === `/zai/api/session/${SID}/prompt`));
  assert.equal(call.body.parts.find((p) => p.type === "text")?.text, "Столица Италии?");
});

test("BUG-11.13: live SSE session.error EmptyTurnError → the same card", async () => {
  routes([user]);
  ui.store.sessions.value = [SESSION];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 1);
  t$.act(() => {
    ui.store.handleEvent({ type: "session.error", properties: { sessionID: SID, error: EMPTY, zai: { emptyTurn: true, messageID: "m2" } } });
  });
  const bar = await t$.waitFor(() => $(root, ".stall-bar.turn-error"));
  assert.match(bar.textContent, /Модель вернула пустой ответ/);
  assert.ok(byText(root, ".turn-error button.stall-btn", "Повторить"));
});

test("BUG-04.6: deleteWarningsText — folders kept + retry, failed chats, unreachable agent; none → null", () => {
  assert.equal(ui.deleteWarningsText("bob", { ok: true, warnings: [] }), null);
  assert.equal(ui.deleteWarningsText("bob", undefined), null);
  const t = ui.deleteWarningsText("bob", {
    ok: true,
    warnings: [
      { kind: "folder", path: "D:\\Chats\\bob", reason: "EBUSY", retry: true },
      { kind: "folder", path: "D:\\Vault\\bob", reason: "EPERM" },
      { kind: "session", sessionID: "ses_x", reason: "сервер агента не удалил чат" },
      { kind: "sessions", reason: "сервер агента недоступен — чаты учётной записи не удалены" },
    ],
  });
  assert.match(t.title, /«bob» удалена/);
  const all = t.lines.join("\n");
  assert.match(all, /D:\\Chats\\bob.*повторит удаление автоматически/);
  assert.match(all, /D:\\Vault\\bob — удалите вручную/);
  assert.match(all, /чатов: 1/);
  assert.match(all, /Сервер агента недоступен/);
});

test("BUG-04.6: «Удалить» with warnings in the answer → the admin sees which folder stayed and that it is retried", async () => {
  let users = [
    { id: "admin", name: "admin", role: "admin", directories: [] },
    { id: "bob", name: "bob", role: "user", directories: ["D:\\Chats\\bob"] },
  ];
  installFetch([
    { method: "GET", path: "/zai/api/admin/users", reply: () => users },
    {
      method: "DELETE",
      path: "/zai/api/admin/users/bob",
      reply: () => {
        users = users.filter((u) => u.id !== "bob");
        return { ok: true, removedSessions: 1, removedDirs: 1, warnings: [{ kind: "folder", path: "D:\\Chats\\bob", reason: "EBUSY: resource busy", retry: true }] };
      },
    },
  ]);
  const { root } = t$.mount(ui.AccessSection, {});
  const del = await t$.waitFor(() => byText(root, "button.access-btn", "Удалить"));
  t$.click(del);
  t$.click(await t$.waitFor(() => byText(root, "button.access-btn", "Да, удалить")));
  const note = await t$.waitFor(() => $(root, ".access-delwarn"));
  assert.equal(note.getAttribute("role"), "alert");
  assert.match(note.textContent, /Учётная запись «bob» удалена/);
  assert.match(note.textContent, /D:\\Chats\\bob/);
  assert.match(note.textContent, /повторит удаление автоматически/);
  await t$.waitFor(() => !$$(root, ".access-user .row-title").some((e) => /bob/.test(e.textContent)));
  t$.click(byText(root, ".access-delwarn button", "Понятно"));
  await t$.waitFor(() => !$(root, ".access-delwarn"));
});

test("BUG-04.6: a clean delete shows no warning note", async () => {
  let users = [{ id: "eve", name: "eve", role: "user", directories: [] }];
  installFetch([
    { method: "GET", path: "/zai/api/admin/users", reply: () => users },
    { method: "DELETE", path: "/zai/api/admin/users/eve", reply: () => ((users = []), { ok: true, removedSessions: 0, removedDirs: 2, warnings: [] }) },
  ]);
  const { root } = t$.mount(ui.AccessSection, {});
  t$.click(await t$.waitFor(() => byText(root, "button.access-btn", "Удалить")));
  t$.click(await t$.waitFor(() => byText(root, "button.access-btn", "Да, удалить")));
  await t$.waitFor(() => !$$(root, ".access-user").length);
  await t$.flush();
  assert.equal($(root, ".access-delwarn"), null);
});
