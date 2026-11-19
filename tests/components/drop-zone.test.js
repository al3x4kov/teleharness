// FEAT-01.88: зона перетаскивания файлов в чате (DropZone в ChatView;
// BRIEF-16, макет design/mockups-v2/paste-drop.html кадры 1, 2, 7, 8;
// openspec paste-drop-agent-steps). События — на window, как в браузере:
// dataTransfer и координаты подставляются в событие.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ChatView: "src/components/views/ChatView.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  installFetch();
});

const SID = "ses_dz";
const NOW = Date.now();
const SESSION = { id: SID, title: "Отчёт по продажам", directory: "/home/u/chat", time: { created: NOW, updated: NOW } };
const HISTORY = [
  { info: { id: "m1", role: "user", sessionID: SID, time: { created: NOW } }, parts: [{ id: "p1", type: "text", text: "Собери сводку за квартал" }] },
];

function routes() {
  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => HISTORY },
    { method: "POST", path: "/teleharness/api/upload", reply: (c) => ({ name: c.query.name, size: 1 }) },
  ]);
}

// Область чата 0..400 × 0..800; файлы — подделки DataTransfer.
const RECT = { top: 0, left: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0 };
async function mountChat() {
  routes();
  ui.store.sessions.value = [SESSION];
  const h = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $(h.root, "footer.composer textarea"));
  $(h.root, ".chat").getBoundingClientRect = () => RECT;
  return h;
}
const fileItem = (f, entry = null) => ({ kind: "file", type: f.type, getAsFile: () => f, webkitGetAsEntry: () => entry ?? { isDirectory: false, name: f.name } });
const dt = (items, types = ["Files"]) => ({ types, items, files: items.map((i) => i.getAsFile?.()).filter(Boolean), dropEffect: "none" });
const fireWin = (type, data, x = 200, y = 300) => t$.fire(window, type, {}, Event, { dataTransfer: data, clientX: x, clientY: y, relatedTarget: null });
const zone = () => document.body.querySelector(".dz");
const uploads = () => fetchCalls.filter((c) => c.method === "POST" && c.path === "/teleharness/api/upload");
const xlsx = (n) => new File(["x"], n, { type: "application/vnd.ms-excel" });

test("три файла над лентой → зона «Отпустите, чтобы прикрепить · 3 файла»; отпускание → три загрузки, зона исчезла", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = await mountChat();
  const data = dt([fileItem(xlsx("июль.xlsx")), fileItem(xlsx("август.xlsx")), fileItem(xlsx("сентябрь.xlsx"))]);
  fireWin("dragenter", data);
  assert.equal(fireWin("dragover", data), false, "dragover отменён — иначе drop не придёт");
  const z = zone();
  assert.ok(z, "зона в body (портал)");
  assert.match(z.textContent, /Отпустите, чтобы прикрепить/);
  assert.match(z.querySelector(".dz-count").textContent, /^3 файла$/);
  assert.equal(z.getAttribute("role"), "status");
  assert.equal(data.dropEffect, "copy");
  assert.equal(fireWin("drop", data), false, "браузер не открывает файл");
  assert.equal(zone(), null);
  await t$.waitFor(() => uploads().length === 3);
  assert.deepEqual(uploads().map((c) => c.query.name), ["июль.xlsx", "август.xlsx", "сентябрь.xlsx"]);
  await t$.waitFor(() => $$(root, ".composer-chips .attach").length === 3);
});

test("курсор вне области чата — зоны нет, drop гасится, но ничего не прикрепляется", async () => {
  await mountChat();
  const data = dt([fileItem(xlsx("a.xlsx"))]);
  fireWin("dragenter", data, 600, 300);
  fireWin("dragover", data, 600, 300);
  assert.equal(zone(), null);
  assert.equal(data.dropEffect, "none");
  assert.equal(fireWin("drop", data, 600, 300), false, "страница портала на месте");
  assert.equal(uploads().length, 0);
});

test("тащат текст/ссылку — зоны нет, событие не трогаем", async () => {
  await mountChat();
  const data = dt([{ kind: "string", type: "text/plain" }], ["text/plain", "text/uri-list"]);
  fireWin("dragenter", data);
  assert.equal(fireWin("dragover", data), true, "не отменено");
  assert.equal(zone(), null);
});

test("уход из окна и Esc убирают зону", async () => {
  await mountChat();
  const data = dt([fileItem(xlsx("a.xlsx"))]);
  fireWin("dragenter", data);
  fireWin("dragover", data);
  assert.ok(zone());
  fireWin("dragleave", data, 0, 0);
  assert.equal(zone(), null, "ушли из окна");
  fireWin("dragenter", data);
  fireWin("dragover", data);
  assert.ok(zone());
  t$.key(window, "Escape");
  assert.equal(zone(), null, "Esc");
});

test("папка + файл → файл прикреплён, причина про папку под полем", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = await mountChat();
  const data = dt([fileItem(new File([], "Выгрузки"), { isDirectory: true, name: "Выгрузки" }), fileItem(xlsx("июль.xlsx"))]);
  fireWin("dragenter", data);
  fireWin("dragover", data);
  fireWin("drop", data);
  await t$.waitFor(() => uploads().length === 1);
  assert.equal(uploads()[0].query.name, "июль.xlsx");
  const err = await t$.waitFor(() => $(root, ".composer-error"));
  assert.match(err.textContent, /Выгрузки: папки не прикрепляются — перетащите файлы из неё/);
});

test("чат останавливается → «Сейчас прикрепить нельзя», drop ничего не прикрепляет", async () => {
  const { root } = await mountChat();
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, status: "stopping" };
  });
  await t$.waitFor(() => $(root, 'button[aria-label="Вложить файл"]').disabled === true);
  const data = dt([fileItem(xlsx("a.xlsx"))]);
  fireWin("dragenter", data);
  fireWin("dragover", data);
  assert.match(zone().textContent, /Сейчас прикрепить нельзя/);
  assert.ok(zone().classList.contains("is-no"));
  assert.equal(data.dropEffect, "none");
  assert.equal(fireWin("drop", data), false, "страница на месте");
  assert.equal(zone(), null);
  assert.equal(uploads().length, 0);
});

test("картинки — «2 фото»; браузер без числа элементов — пилюли нет", async () => {
  await mountChat();
  const img = (n) => new File(["x"], n, { type: "image/jpeg" });
  const data = dt([fileItem(img("IMG_2305.jpg")), fileItem(img("IMG_2306.jpg"))]);
  fireWin("dragenter", data);
  fireWin("dragover", data);
  assert.equal(zone().querySelector(".dz-count").textContent, "2 фото");
  fireWin("dragleave", data, 0, 0);
  const safari = { types: ["Files"], items: [], files: [] };
  fireWin("dragenter", safari);
  fireWin("dragover", safari);
  assert.ok(zone());
  assert.equal(zone().querySelector(".dz-count"), null);
});

test("зона — по всей области вида (main.view), а не по узкой колонке .chat (стенд 2026-11-19, десктоп)", async () => {
  const { root } = await mountChat();
  root.classList.add("view");
  root.getBoundingClientRect = () => ({ top: 0, left: 280, width: 1160, height: 900, right: 1440, bottom: 900, x: 280, y: 0 });
  $(root, ".chat").getBoundingClientRect = () => ({ top: 0, left: 500, width: 720, height: 900, right: 1220, bottom: 900, x: 500, y: 0 });
  const data = dt([fileItem(xlsx("a.xlsx"))]);
  fireWin("dragenter", data, 320, 400); // левее колонки, но в области чата
  fireWin("dragover", data, 320, 400);
  const z = zone();
  assert.ok(z, "зона есть у края области");
  assert.equal(z.style.left, "280px");
  assert.equal(z.style.width, "1160px");
  fireWin("dragleave", data, 0, 0);
  fireWin("dragover", data, 100, 400); // над списком чатов
  assert.equal(zone(), null);
});
