// FEAT-01.77: сводка по агентам (кадры 1/3), полоса фоновых агентов (кадр 5)
// и подпись прелоадера (кадр 4) — BRIEF-14 и макет design/mockups-v2/subagents.html.
// Компоненты чисто презентационные: данные и подписи времени — пропами.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    AgentSummary: "src/components/chat/AgentSummary.jsx",
    BgAgentsBar: "src/components/chat/BgAgentsBar.jsx",
    TurnPreloader: "src/components/chat/TurnPreloader.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => t$.cleanup());

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const NOW = 1_800_000_000_000;

// ---- AgentSummary -----------------------------------------------------------

test("сводка: «Агенты: 2 работают · 1 в очереди», работающие выделены, role=status, значок агента", () => {
  const { root } = t$.mount(ui.AgentSummary, { summary: { running: 2, queued: 1, done: 0, error: 0, stopped: 0, total: 3 } });
  const el = $(root, ".sa-sum");
  assert.ok(el, "строка сводки");
  assert.equal(el.getAttribute("role"), "status");
  assert.ok($(el, "svg"), "значок агента");
  assert.match(el.textContent, /Агенты:/);
  assert.ok($(el, "b"), "числа работающих выделены");
  assert.equal($(el, "b").textContent, "2 работают");
  assert.match(el.textContent, /1 в очереди/);
});

test("сводка завершённых: «2 готовы · 1 с ошибкой»; формы 1 — в единственном числе", () => {
  const a = t$.mount(ui.AgentSummary, { summary: { running: 0, queued: 0, done: 2, error: 1, stopped: 0, total: 3 } });
  assert.match($(a.root, ".sa-sum").textContent, /^Агенты: 2 готовы · 1 с ошибкой$/);
  const b = t$.mount(ui.AgentSummary, { summary: { running: 1, queued: 1, done: 0, error: 0, stopped: 0, total: 2 } });
  assert.equal($(b.root, "b").textContent, "1 работает");
  const c = t$.mount(ui.AgentSummary, { summary: { running: 0, queued: 0, done: 1, error: 1, stopped: 0, total: 2 } });
  assert.match($(c.root, ".sa-sum").textContent, /1 готов · 1 с ошибкой/);
});

test("сводка не рендерится при total < 2 (один агент — сводки нет)", () => {
  const a = t$.mount(ui.AgentSummary, { summary: { running: 1, queued: 0, done: 0, error: 0, stopped: 0, total: 1 } });
  assert.equal(a.root.innerHTML.trim(), "", "total=1 → пусто");
  const b = t$.mount(ui.AgentSummary, { summary: { running: 2, queued: 0, done: 1, error: 0, stopped: 0 } });
  assert.ok($(b.root, ".sa-sum"), "total можно вычислить из счётчиков");
  const c = t$.mount(ui.AgentSummary, { summary: null });
  assert.equal(c.root.innerHTML.trim(), "", "нет сводки — пусто");
});

test("сводка без счётчиков, только text — текст показывается как есть", () => {
  const { root } = t$.mount(ui.AgentSummary, { summary: { text: "Агенты: 2 работают · 1 в очереди", total: 3 } });
  assert.match($(root, ".sa-sum").textContent, /Агенты: 2 работают · 1 в очереди/);
});

// ---- BgAgentsBar --------------------------------------------------------------

test("полоса: один агент — «Фоном работает агент librarian», таймер от startedAt, role=status", () => {
  const runs = [{ id: "r1", agent: "librarian", background: true, state: "running", startedAt: NOW - 124_000 }];
  const { root } = t$.mount(ui.BgAgentsBar, { runs, now: NOW, fmtDuration: fmtDur, onOpen: () => {} });
  const bar = $(root, ".bg-bar");
  assert.ok(bar, "полоса есть");
  assert.equal(bar.tagName, "BUTTON", "вся полоса — кнопка");
  assert.equal(bar.getAttribute("role"), "status");
  assert.match($(bar, ".bt").textContent, /^Фоном работает агент librarian$/);
  assert.equal($(bar, ".bt b").textContent, "librarian", "имя выделено");
  assert.equal($(bar, "time").textContent, "2:04", "таймер от startedAt");
  assert.ok($(bar, ".sa-pulse"), "точка работы");
});

test("полоса: несколько агентов — «Фоном работают 2 агента», таймер от самого раннего", () => {
  const runs = [
    { id: "r1", agent: "librarian", state: "running", startedAt: NOW - 60_000 },
    { id: "r2", agent: "explorer", state: "running", startedAt: NOW - 200_000 },
  ];
  const { root } = t$.mount(ui.BgAgentsBar, { runs, now: NOW, fmtDuration: fmtDur, onOpen: () => {} });
  assert.match($(root, ".bt").textContent, /^Фоном работают 2 агента$/);
  assert.equal($(root, "time").textContent, "3:20", "от самого раннего startedAt");
});

test("полоса: клик зовёт onOpen с первым запуском; пустой runs — не рендерится", () => {
  const calls = [];
  const runs = [
    { id: "r1", agent: "a", state: "running", startedAt: NOW - 1000 },
    { id: "r2", agent: "b", state: "running", startedAt: NOW - 2000 },
  ];
  const { root } = t$.mount(ui.BgAgentsBar, { runs, now: NOW, fmtDuration: fmtDur, onOpen: (r) => calls.push(r) });
  t$.click($(root, ".bg-bar"));
  assert.deepEqual(calls, [runs[0]], "onOpen(run) первого запуска");
  const empty = t$.mount(ui.BgAgentsBar, { runs: [], now: NOW, fmtDuration: fmtDur, onOpen: () => {} });
  assert.equal(empty.root.innerHTML.trim(), "");
});

// ---- TurnPreloader: подпись про агентов (кадр 4) --------------------------------

test("прелоадер с caption (кадр 4 TASK-01.79): знак-звёздочка .spin и две строки, рисунка-прелоадера нет", () => {
  const { root } = t$.mount(ui.TurnPreloader, { caption: "explorer, librarian · 1 из 3 готов · 1:12" });
  const wrap = $(root, ".msg-preloader");
  assert.ok(wrap.className.includes("is-agents"), "режим с подписью");
  assert.equal(wrap.getAttribute("role"), "status");
  assert.equal(wrap.getAttribute("aria-label"), "Работают агенты");
  assert.ok($(root, ".spin"), "знак-звёздочка");
  assert.equal($(root, "img"), null, "рисунка-прелоадера нет");
  assert.equal($(root, ".turn-preloader"), null, "разметки рисунка нет");
  const t = $(root, ".pre-t");
  assert.ok(t, "текстовый блок рядом со знаком");
  assert.equal($(t, "b").textContent, "Работают агенты");
  assert.equal($(t, "span").textContent, "explorer, librarian · 1 из 3 готов · 1:12");
});

test("прелоадер без caption — прежний вид: подписи нет, «Готовлю ответ…» (старые тесты зелёные)", () => {
  const { root } = t$.mount(ui.TurnPreloader, {});
  assert.equal($(root, ".pre-t"), null);
  assert.ok(!$(root, ".msg-preloader").className.includes("is-agents"));
  const pre = $(root, ".turn-preloader");
  assert.equal(pre.getAttribute("role"), "status");
  assert.equal(pre.getAttribute("aria-label"), "Готовлю ответ…");
  assert.equal($$(pre, "img").length, 4, "оба варианта SVG на месте");
});
