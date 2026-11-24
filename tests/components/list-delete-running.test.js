// BUG-216 (BUG-01.73): удаление занятого чата из списков «Чаты» и проекта —
// то же предупреждение, что в меню чата (FEAT-01.69: «Ответ ещё идёт — он
// будет остановлен»), и сначала стоп хода (POST abort), затем DELETE — как
// делает deleteChat в меню (ChatMenu). Свободный чат — как раньше: без
// предупреждения и без abort.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    HomeView: "src/components/views/HomeView.jsx",
    ProjectView: "src/components/views/ProjectView.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.pins.value = [];
  s.busyMap.value = {};
  s.dialogs.value = [];
  s.active.value = null;
  s.setNotice(null);
  installFetch();
});

const NOW = Date.now();
const DIR = "D:\\qa-proj";
const ses = (id, directory = "C:\\Users\\USER") => ({ id, title: "Чат " + id, directory, time: { created: NOW, updated: NOW } });

function routes(id) {
  installFetch([
    { method: "POST", path: `/teleharness/api/session/${id}/abort`, reply: () => true },
    { method: "DELETE", path: `/teleharness/api/session/${id}`, reply: () => true },
  ]);
}

// abort/DELETE конкретного чата в порядке отправки
const stopThenDelete = (id) =>
  fetchCalls
    .filter((c) => c.path === `/teleharness/api/session/${id}/abort` || (c.method === "DELETE" && c.path === `/teleharness/api/session/${id}`))
    .map((c) => c.method);
const anyAbort = () => fetchCalls.some((c) => c.method === "POST" && /\/abort$/.test(c.path));
const deleteBtn = (rootEl, id) =>
  [...rootEl.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "") === `Удалить чат «Чат ${id}»`);

async function openDelete(h, id) {
  t$.click(deleteBtn(h.root, id));
  return t$.waitFor(() => $(document.body, '.modal[aria-label="Удалить чат?"]'));
}

test("HomeView: занятый чат — в окне удаления предупреждение «Ответ ещё идёт», затем abort → DELETE; строка исчезает", async () => {
  ui.store.sessions.value = [ses("ses_run"), ses("ses_idle")];
  ui.store.busyMap.value = { ses_run: { type: "busy" } };
  routes("ses_run");
  const h = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(h.root, ".swipe").length >= 2);
  // источник занятости — тот же, что рисует бейдж «работает» (FEAT-01.31)
  const busyRow = $$(h.root, ".swipe").find((r) => $(r, ".badge-busy"));
  assert.ok(busyRow, "у занятой строки есть бейдж «работает»");
  const dlg = await openDelete(h, "ses_run");
  assert.match(dlg.textContent, /«Чат ses_run» будет удалён/);
  const warn = $(dlg, ".modal-warn");
  assert.ok(warn, "предупреждение показано");
  assert.match(warn.textContent, /Ответ ещё идёт — он будет остановлен/);
  assert.equal(warn.getAttribute("role"), "status");
  t$.click(byText(dlg, "button", "Удалить"));
  await t$.waitFor(() => stopThenDelete("ses_run").length >= 2);
  assert.deepEqual(stopThenDelete("ses_run"), ["POST", "DELETE"], "сначала стоп хода, потом удаление");
  await t$.waitFor(() => !ui.store.sessions.value.some((s) => s.id === "ses_run"));
  assert.equal($(document.body, '.modal[aria-label="Удалить чат?"]'), null, "окно закрылось");
});

test("HomeView: свободный чат — предупреждения нет, abort не уходил, удаляется как раньше", async () => {
  ui.store.sessions.value = [ses("ses_idle")];
  routes("ses_idle");
  const h = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(h.root, ".swipe").length >= 1);
  const dlg = await openDelete(h, "ses_idle");
  assert.equal($(dlg, ".modal-warn"), null, "без предупреждения о работающем ходе");
  t$.click(byText(dlg, "button", "Удалить"));
  await t$.waitFor(() => !ui.store.sessions.value.some((s) => s.id === "ses_idle"));
  assert.deepEqual(stopThenDelete("ses_idle"), ["DELETE"], "один DELETE, без abort");
  assert.equal(anyAbort(), false, "abort не уходил");
});

test("ProjectView: занятый чат проекта — предупреждение, затем abort → DELETE", async () => {
  ui.store.sessions.value = [ses("ses_prun", DIR), ses("ses_pidle", DIR)];
  ui.store.busyMap.value = { ses_prun: { type: "busy" } };
  routes("ses_prun");
  const h = t$.mount(ui.ProjectView, { id: DIR });
  await t$.waitFor(() => $$(h.root, ".swipe").length >= 2);
  const dlg = await openDelete(h, "ses_prun");
  const warn = $(dlg, ".modal-warn");
  assert.ok(warn, "предупреждение показано");
  assert.match(warn.textContent, /Ответ ещё идёт — он будет остановлен/);
  t$.click(byText(dlg, "button", "Удалить"));
  await t$.waitFor(() => stopThenDelete("ses_prun").length >= 2);
  assert.deepEqual(stopThenDelete("ses_prun"), ["POST", "DELETE"], "сначала стоп хода, потом удаление");
  await t$.waitFor(() => !ui.store.sessions.value.some((s) => s.id === "ses_prun"));
});

test("ProjectView: свободный чат — предупреждения нет, abort не уходил", async () => {
  ui.store.sessions.value = [ses("ses_pidle", DIR)];
  routes("ses_pidle");
  const h = t$.mount(ui.ProjectView, { id: DIR });
  await t$.waitFor(() => $$(h.root, ".swipe").length >= 1);
  const dlg = await openDelete(h, "ses_pidle");
  assert.equal($(dlg, ".modal-warn"), null);
  t$.click(byText(dlg, "button", "Удалить"));
  await t$.waitFor(() => !ui.store.sessions.value.some((s) => s.id === "ses_pidle"));
  assert.deepEqual(stopThenDelete("ses_pidle"), ["DELETE"], "один DELETE, без abort");
  assert.equal(anyAbort(), false, "abort не уходил");
});

test("BUG-304: ProjectView скрывает pipeline-step сессии и нормализует слеши/хвостовые слеши каталога", async () => {
  ui.store.sessions.value = [
    ses("ses_norm", "D:/qa-proj/"),
    { ...ses("ses_pipe", DIR), title: "⇄ Шаг 1 (пайплайн)" },
    ses("ses_other", "D:\\other-proj"),
  ];
  const h = t$.mount(ui.ProjectView, { id: DIR });
  await t$.waitFor(() => $$(h.root, ".swipe").length === 1);
  assert.match(h.root.textContent, /Чат ses_norm/);
  assert.doesNotMatch(h.root.textContent, /Шаг 1/);
  assert.doesNotMatch(h.root.textContent, /Чат ses_other/);
});

test("BUG-304: двойной клик по «Удалить» в DeleteModal отправляет только один DELETE", async () => {
  let resolveDel;
  installFetch([
    {
      method: "DELETE",
      path: "/teleharness/api/session/ses_dbl",
      reply: () => new Promise((r) => { resolveDel = () => r(true); }),
    },
  ]);
  ui.store.sessions.value = [ses("ses_dbl")];
  const h = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(h.root, ".swipe").length === 1);
  const dlg = await openDelete(h, "ses_dbl");
  const btn = byText(dlg, "button", "Удалить");
  t$.click(btn);
  t$.click(btn);
  await t$.flush();
  assert.equal(btn.disabled, true, "кнопка заблокирована пока DELETE в полёте");
  assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 1, "ушёл ровно один DELETE");
  resolveDel();
  await t$.waitFor(() => !ui.store.sessions.value.some((s) => s.id === "ses_dbl"));
});
