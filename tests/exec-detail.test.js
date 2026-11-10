// L1 (FEAT-03.19): лента без «Детализации выполнения» — src/lib/exec-detail.js.
// Пока ход формируется — он скрыт (прелоадер), после — один «ответ хода»:
// текст последнего шага с текстом, карточки файлов, ошибка, без шагов.
// Run: node --test tests/exec-detail.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactFeed, mergeTurn } from "../src/lib/exec-detail.js";

const T = 1_700_000_000_000;
const user = (id, t, text = "вопрос") => ({ info: { id, role: "user", time: { created: t } }, parts: [{ id: `${id}_p`, type: "text", text }] });
const step = (id, t, parts, extra = {}) => ({
  info: { id, role: "assistant", time: { created: t, ...(extra.done === false ? {} : { completed: t + 500 }) }, ...(extra.error ? { error: extra.error } : {}) },
  parts,
});
const txt = (id, text) => ({ id, type: "text", text });
const tool = (id) => ({ id, type: "tool", tool: "read", state: { status: "completed", input: { filePath: "D:/w/a.txt" } } });
const reasoning = (id) => ({ id, type: "reasoning", text: "думаю" });

const turnSteps = () => [
  step("a1", T + 1, [{ id: "s1", type: "step-start" }, reasoning("r1"), txt("t1", "Сейчас прочитаю файл."), tool("k1")]),
  step("a2", T + 2, [{ id: "s2", type: "step-start" }, tool("k2")]),
  step("a3", T + 3, [{ id: "s3", type: "step-start" }, txt("t3", "Итог: в файле три строки.")]),
];

test("закрытый ход сворачивается в одно сообщение: id последнего шага, только итоговый текст", () => {
  const feed = [user("u1", T), ...turnSteps()];
  const { messages, preloader } = compactFeed(feed, { busy: false });
  assert.equal(preloader, false);
  assert.equal(messages.length, 2);
  const m = messages[1];
  assert.equal(m.compact, true);
  assert.equal(m.info.id, "a3");
  const texts = m.parts.filter((p) => p.type === "text").map((p) => p.text);
  assert.deepEqual(texts, ["Итог: в файле три строки."], "промежуточный текст «Сейчас прочитаю файл.» не попадает");
  assert.deepEqual(m.parts.filter((p) => p.type === "tool").map((p) => p.id), ["k1", "k2"], "tool-части остаются — из них карточки файлов");
});

test("идущий ход скрыт целиком, вместо него прелоадер", () => {
  const steps = turnSteps();
  steps[2] = step("a3", T + 3, [{ id: "s3", type: "step-start" }, txt("t3", "Итог: в файле")], { done: false });
  const { messages, preloader } = compactFeed([user("u1", T), ...steps], { busy: true });
  assert.equal(preloader, true);
  assert.deepEqual(messages.map((m) => m.info.id), ["u1"], "ни одного шага хода, пока он формируется");
});

test("занят, а ход ещё не начался (хвост — вопрос пользователя) — прелоадер; прошлые ходы видны ответом", () => {
  const feed = [user("u1", T), ...turnSteps(), user("u2", T + 10)];
  const { messages, preloader } = compactFeed(feed, { busy: true });
  assert.equal(preloader, true);
  assert.deepEqual(messages.map((m) => m.info.id), ["u1", "a3", "u2"]);
});

test("свободен — прелоадера нет, пустая лента остаётся пустой", () => {
  assert.deepEqual(compactFeed([], { busy: false }), { messages: [], preloader: false });
  assert.deepEqual(compactFeed(null), { messages: [], preloader: false });
});

test("ошибка любого шага переезжает в итоговое сообщение; ход без текста — без текста", () => {
  const err = { name: "APIError", data: { message: "rate limit" } };
  const m = mergeTurn([step("a1", T, [tool("k1")], { error: err }), step("a2", T + 1, [{ id: "s", type: "step-start" }])]);
  assert.equal(m.info.id, "a2");
  assert.deepEqual(m.info.error, err);
  assert.equal(m.parts.some((p) => p.type === "text"), false);
});

test("пустой и синтетический текст не считается ответом — берётся последний шаг с настоящим текстом", () => {
  const m = mergeTurn([
    step("a1", T, [txt("t1", "Ответ здесь.")]),
    step("a2", T + 1, [txt("t2", "   "), { id: "t3", type: "text", text: "служебное", synthetic: true }]),
  ]);
  assert.deepEqual(m.parts.filter((p) => p.type === "text").map((p) => p.id), ["t1"]);
  assert.equal(m.info.id, "a2", "подвал хода — на последнем шаге");
});

test("исходные сообщения не мутируются", () => {
  const feed = [user("u1", T), ...turnSteps()];
  const snap = JSON.stringify(feed);
  compactFeed(feed, { busy: false });
  assert.equal(JSON.stringify(feed), snap);
});

// ---- постепенный вывод готового ответа (уточнение владельца 2026-11-04 ~23:00) ----
import { REVEAL, revealPlan, revealSlices, revealTarget } from "../src/lib/exec-detail.js";

test("revealPlan: ~250 символов/с, не короче 0,6 с и не дольше 4 с; пусто — без вывода", () => {
  assert.deepEqual(revealPlan(0), { durationMs: 0, ticks: 0, step: 0 });
  assert.deepEqual(revealPlan(NaN), { durationMs: 0, ticks: 0, step: 0 });
  assert.equal(revealPlan(20).durationMs, REVEAL.minMs, "короткий ответ — 0,6 с");
  assert.equal(revealPlan(500).durationMs, 2000, "500 символов — 2 с");
  assert.equal(revealPlan(100000).durationMs, REVEAL.maxMs, "длинный — не дольше 4 с");
  for (const n of [1, 37, 500, 12345]) {
    const p = revealPlan(n);
    assert.ok(p.step * p.ticks >= n, `${n}: за ticks шагов выводится всё`);
  }
});

test("revealSlices: части выводятся по порядку, следующая — после предыдущей", () => {
  assert.deepEqual(revealSlices(["Привет", "мир"], 0), ["", ""]);
  assert.deepEqual(revealSlices(["Привет", "мир"], 3), ["При", ""]);
  assert.deepEqual(revealSlices(["Привет", "мир"], 8), ["Привет", "ми"]);
  assert.deepEqual(revealSlices(["Привет", "мир"], 99), ["Привет", "мир"]);
});

test("revealTarget: последний свёрнутый ответ с текстом; вопрос пользователя или ответ без текста — нет", () => {
  const feed = [user("u1", T), ...turnSteps()];
  assert.equal(revealTarget(compactFeed(feed).messages), "a3");
  assert.equal(revealTarget(compactFeed([user("u1", T)]).messages), null);
  const noText = compactFeed([user("u1", T), step("a1", T + 1, [tool("k1")])]).messages;
  assert.equal(revealTarget(noText), null);
  assert.equal(revealTarget([]), null);
});
