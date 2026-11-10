// BUG-092 (BUG-05.18): files a Claude/opencode turn made with a SCRIPT become
// file cards from the server's per-turn list; names only guessed from the
// text are shown when the server confirms them (no 404 probes).
// Scenario from a real chat (2026-11-03).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$, tf;
before(async () => {
  // turn-files from the SAME bundle as MessageBubble (a separate import would
  // be a second module instance with its own signal).
  const TF = "src/lib/turn-files.js";
  ui = await loadUI({
    MessageBubble: "src/components/chat/MessageBubble.jsx",
    turnFiles: `${TF}#turnFiles`,
    turnWindows: `${TF}#turnWindows`,
    loadTurnFiles: `${TF}#loadTurnFiles`,
    serverFilesFor: `${TF}#serverFilesFor`,
    resetProbes: "src/lib/file-probe.js#resetProbes",
  });
  t$ = createHarness(ui);
  tf = { turnFiles: ui.turnFiles, turnWindows: ui.turnWindows, loadTurnFiles: ui.loadTurnFiles, serverFilesFor: ui.serverFilesFor };
});
afterEach(() => {
  t$.cleanup();
  tf.turnFiles.value = { key: null, sid: null, byLast: null };
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.setActiveId(null);
  installFetch();
});

const SID = "ses_tf";
const DIR = "C:\\Users\\USER";
const T0 = Date.UTC(2026, 10, 3, 16, 33, 30);
const NAMES = ["random.md", "random.csv", "random.html", "random.docx", "random.png", "random.svg", "random.jpeg"];
const TEXT = "Я создал по одному файлу каждого типа в папке C:\\Users\\USER\\random_files\\.\n\n| Файл | Содержимое |\n|---|---|\n" +
  NAMES.map((n) => `| \`${n}\` | x |`).join("\n");
const user = { info: { id: "u1", role: "user", sessionID: SID, time: { created: T0 } }, parts: [{ id: "pu", type: "text", text: "Сгенерируй мне рандомный md, csv, html, word, png,svg,jpeg" }] };
const answer = { info: { id: "a1", role: "assistant", sessionID: SID, time: { created: T0 + 1000, completed: T0 + 32_000 } }, parts: [{ id: "pt", type: "text", text: TEXT }] };

const setup = () => {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  ui.store.active.value = { ...(ui.store.active.value ?? {}), id: SID, status: "idle", messages: [user, answer] };
};

test("turnWindows: закрытый ход → окно [вопрос, завершение]; незакрытый — нет", () => {
  assert.deepEqual(tf.turnWindows([user, answer]), [{ last: "a1", start: T0, end: T0 + 32_000 }]);
  const open = { ...answer, info: { ...answer.info, time: { created: T0 + 1000 } } };
  assert.deepEqual(tf.turnWindows([user, open]), []);
});

test("loadTurnFiles: один запрос на набор закрытых ходов, повтор не шлётся, ошибка → null (старое поведение)", async () => {
  const calls = [];
  const fetcher = async (dir, wins) => { calls.push([dir, wins]); return { files: [[`${DIR}\\random_files\\random.md`]] }; };
  await tf.loadTurnFiles(SID, DIR, [user, answer], { fetcher });
  await tf.loadTurnFiles(SID, DIR, [user, answer], { fetcher });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [DIR, [[T0, T0 + 32_000]]]);
  assert.deepEqual(tf.serverFilesFor(SID, "a1"), [`${DIR}\\random_files\\random.md`]);
  assert.equal(tf.serverFilesFor("other", "a1"), null);
  // a new closed turn → a new request; its failure → null (old behaviour)
  const u2 = { ...user, info: { ...user.info, id: "u2", time: { created: T0 + 60_000 } } };
  const a2 = { ...answer, info: { ...answer.info, id: "a2", time: { created: T0 + 61_000, completed: T0 + 70_000 } } };
  await tf.loadTurnFiles(SID, DIR, [user, answer, u2, a2], { fetcher: async () => { throw new Error("404"); } });
  assert.equal(tf.serverFilesFor(SID, "a1"), null);
});

test("Claude-ход без tool-частей: 7 файлов скрипта из списка сервера → 7 карточек (сценарий владельца)", () => {
  setup();
  tf.turnFiles.value = { key: "k", sid: SID, byLast: new Map([["a1", NAMES.map((n) => `${DIR}\\random_files\\${n}`)]]) };
  const { root } = t$.mount(ui.MessageBubble, { msg: answer });
  const subs = $$(root, ".file-card .fc-sub").map((e) => e.textContent);
  assert.deepEqual(subs, ["Документ · MD", "Таблица · CSV", "Код · HTML", "Документ · DOCX", "Изображение · PNG", "Изображение · SVG", "Изображение · JPEG"]);
  const imgs = $$(root, ".file-card .fc-tile img").map((i) => new URL(i.getAttribute("src"), "https://z").searchParams.get("path"));
  assert.deepEqual(imgs, ["random.png", "random.svg", "random.jpeg"].map((n) => `${DIR}\\random_files\\${n}`), "миниатюры — по НАСТОЯЩЕМУ пути");
  assert.ok(!imgs.some((p) => p === `${DIR}\\random.png`), "угаданный неверный путь не грузится (нет 404)");
});

test("сервер ничего не нашёл — угаданные картинки не грузятся вовсе (нет 404 в консоли)", () => {
  setup();
  tf.turnFiles.value = { key: "k", sid: SID, byLast: new Map([["a1", []]]) };
  const { root } = t$.mount(ui.MessageBubble, { msg: answer });
  assert.equal($$(root, ".file-card").length, 0);
});

test("BUG-090: список сервера не загружен (ход идёт) — угаданная картинка сначала проверяется /file/exists, <img> только у существующей", async () => {
  ui.resetProbes();
  const asked = [];
  installFetch([{
    method: "GET",
    path: "/zai/api/file/exists",
    reply: (c) => {
      const paths = c.params.getAll("path");
      asked.push(...paths);
      return { exists: paths.map((p) => p.endsWith("\\random.png")) };
    },
  }]);
  setup();
  const { root } = t$.mount(ui.MessageBubble, { msg: answer });
  assert.equal($$(root, ".file-card.is-image").length, 0, "до ответа сервера — ни карточки, ни <img>");
  assert.equal($$(root, "img").length, 0);
  await t$.waitFor(() => $$(root, ".file-card.is-image").length === 1);
  assert.deepEqual(asked.map((p) => p.split("\\").pop()).sort(), ["random.jpeg", "random.png", "random.svg"], "один пакетный запрос на угаданные картинки");
  const imgs = $$(root, ".file-card .fc-tile img").map((i) => new URL(i.getAttribute("src"), "https://z").searchParams.get("path"));
  assert.deepEqual(imgs, [`${DIR}\\random.png`], "картинки, которых нет на диске, не грузятся (нет 404 в консоли)");
});

test("BUG-090: ошибка проверки — угаданная картинка не показывается (никакого 404)", async () => {
  ui.resetProbes();
  installFetch([{ method: "GET", path: "/zai/api/file/exists", reply: () => ({ status: 500, body: { error: "x" } }) }]);
  setup();
  const { root } = t$.mount(ui.MessageBubble, { msg: answer });
  await t$.flush();
  assert.equal($$(root, ".file-card.is-image").length, 0);
  assert.equal($$(root, "img").length, 0);
});

test("файл из write/edit и тот же файл в списке сервера — одна карточка", () => {
  setup();
  const p = `${DIR}\\notes.md`;
  const step = { ...answer, parts: [
    { id: "w", type: "tool", tool: "write", callID: "c", state: { status: "completed", input: { filePath: p, content: "x" }, output: "", time: { start: T0, end: T0 } } },
    { id: "b", type: "tool", tool: "bash", callID: "c2", state: { status: "completed", input: { command: "python gen.py" }, output: "saved chart.png", time: { start: T0, end: T0 } } },
    { id: "t", type: "text", text: "Готово." },
  ] };
  tf.turnFiles.value = { key: "k", sid: SID, byLast: new Map([["a1", [p, `${DIR}\\gen\\chart.png`]]]) };
  const { root } = t$.mount(ui.MessageBubble, { msg: step });
  assert.deepEqual($$(root, ".file-card").map((c) => c.getAttribute("title")), ["notes.md", "chart.png"]);
});

test("BUG-094: файл, который ход не называл (чужой чат/процесс в общей папке), карточкой не становится", () => {
  setup();
  const step = { ...answer, parts: [{ id: "t", type: "text", text: "ок" }] };
  tf.turnFiles.value = { key: "k", sid: SID, byLast: new Map([["a1", [`${DIR}\\probe-leak.txt`, `${DIR}\\.playwright-mcp\\shot.png`]]]) };
  const { root } = t$.mount(ui.MessageBubble, { msg: step });
  assert.equal($$(root, ".file-card").length, 0);
});
