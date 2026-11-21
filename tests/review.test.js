// FEAT-20.1: ревью — чистые части: сообщение агенту (лимиты, EN, переименование,
// удалённые строки, фрагмент без номеров), контракт элемента ревью для доски,
// исход отправленного комментария, проверка комментария, «Сначала план» в привязке
// и в аргументах CLI. Каждое правило карточки — отдельный тест.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REVIEW_LIMITS, buildReviewMessage, planExecText, rangeLabel, reviewMarker } from "../shared/review-message.js";
import { NEEDS_YOU, ReviewError, cleanComment, commentOutcome, filesOf, statusOf, summaryOf } from "../lib/review.js";
import { OC_PLAN_RULES, makeBinding, patchBinding, planUnsupported } from "../lib/binding.js";
import { PLAN_ARGS, permissionArgs } from "../lib/claude.js";
import { codexPolicy, parseArgs as parseCodexArgs } from "../lib/codex-shim.mjs";
import { OutcomeObserver, buildBoard } from "../lib/attention.js";

const c = (over = {}) => ({ id: "c_" + Math.random().toString(36).slice(2, 10), file: "auth/session.js", side: "new", from: 42, to: 47, quote: ["a", "b"], text: "Проверь срок токена", ...over });

test("кр. 6: одно сообщение — общий комментарий, путь, строки, цитата, текст и маркер ревизии", () => {
  const m = buildReviewMessage({
    id: "rv_AAAAAAAAAAAA", revision: 2, general: "В целом ок",
    comments: [c(), c({ file: "api/x.js", from: 3, to: 3, quote: ["x"], text: "Имя" }), c({ side: "file", from: null, to: null, quote: [], text: "Нужен тест" })],
    files: [{ path: "auth/session.js", oldPath: "auth/token.js", status: "R" }, { path: "api/x.js", status: "M" }],
  });
  assert.match(m.text, /^## Ревью · 4 комментария к 2 файлам \(ревизия 2\)/);
  assert.match(m.text, /В целом ок/);
  assert.match(m.text, /### auth\/session\.js \(переименован из auth\/token\.js\)/, "N-16: оба пути");
  assert.match(m.text, /\*\*Строки 42–47:\*\*\n```\na\nb\n```\nПроверь срок токена/);
  assert.match(m.text, /\*\*Строка 3:\*\*/);
  assert.match(m.text, /\*\*Файл целиком:\*\*\nНужен тест/);
  assert.deepEqual(reviewMarker(m.text), { id: "rv_AAAAAAAAAAAA", revision: 2 });
  assert.equal(m.count, 4);
  assert.equal(m.fileCount, 2);
  assert.equal(m.shortened, false);
});

test("N-15/N-17: удалённые строки и фрагмент без номеров — «около строки» с цитатой", () => {
  assert.equal(rangeLabel(c({ side: "old", from: 10, to: 14 })), "Удалённые строки 10–14");
  const m = buildReviewMessage({ id: "rv_BBBBBBBBBBBB", revision: 1, comments: [c({ from: null, to: null, quote: ["const t = 1;"] })] });
  assert.match(m.text, /\*\*Около строки \(номер неизвестен\):\*\*\n```\nconst t = 1;\n```/);
});

test("N-19: больше 30 000 символов — цитаты до 5 строк, тексты комментариев целиком", () => {
  const long = Array.from({ length: 20 }, (_, i) => "x".repeat(60) + i);
  const comments = Array.from({ length: 45 }, (_, i) => c({ from: i * 10 + 1, to: i * 10 + 20, quote: long, text: `Комментарий ${i} ` + "т".repeat(250) }));
  const m = buildReviewMessage({ id: "rv_CCCCCCCCCCCC", revision: 1, comments });
  assert.ok(m.text.length <= REVIEW_LIMITS.message, `длина ${m.text.length}`);
  assert.equal(m.shortened, true);
  assert.equal(m.quoteLines, 5);
  for (let i = 0; i < 45; i++) assert.ok(m.text.includes(`Комментарий ${i} ` + "т".repeat(250)), `комментарий ${i} целиком`);
  assert.match(m.text, /… ещё 15 строк цитаты/);
});

test("сообщение без места даже без цитат — tooLong (сервер отвечает 413), тексты не режутся", () => {
  const comments = Array.from({ length: 10 }, (_, i) => c({ from: i + 1, to: i + 1, text: "ж".repeat(4000) }));
  const m = buildReviewMessage({ id: "rv_DDDDDDDDDDDD", revision: 1, comments });
  assert.equal(m.tooLong, true);
});

test("N-35: английский интерфейс — Review · 3 comments on 2 files, lines 42–47", () => {
  const m = buildReviewMessage({ id: "rv_EEEEEEEEEEEE", revision: 1, lang: "en", comments: [c(), c({ from: 1, to: 1 }), c({ file: "b.js" })] });
  assert.match(m.text, /^## Review · 3 comments on 2 files \(revision 1\)/);
  assert.match(m.text, /\*\*Lines 42–47:\*\*/);
  assert.match(m.text, /\*\*Line 1:\*\*/);
});

test("цитата с ``` внутри не ломает блок кода", () => {
  const m = buildReviewMessage({ id: "rv_FFFFFFFFFFFF", revision: 1, comments: [c({ quote: ["```js", "x"] })] });
  assert.match(m.text, /````\n```js\nx\n````/);
});

const item = (over = {}) => ({
  id: "rv_GGGGGGGGGGGG", source: { kind: "chat", sid: "ses_1" }, title: "Токен", dir: "/p/teleharness", project: { name: "teleharness" }, engine: "claude", model: "claude-opus-5-5",
  state: "pending", mode: "snapshot", revision: 1, since: 1000, updatedAt: 1000,
  revisions: [{ n: 1, turns: ["m1", "m2"], files: [{ path: "a.js", additions: 3, deletions: 1 }, { path: "b.js", additions: 1, deletions: 0 }, { path: "c.js", additions: 0, deletions: 2 }, { path: "d.js", additions: 1, deletions: 1 }] }],
  comments: [{ state: "draft" }, { state: "draft" }, { state: "draft" }, { state: "sent" }], sends: [], reviewed: {}, ...over,
});

test("кр. 18: элемент ревью — key review:<id>, status waiting, needsYou, files, drafts, href", () => {
  const s = summaryOf(item());
  assert.equal(s.key, "review:rv_GGGGGGGGGGGG");
  assert.equal(s.status, "waiting");
  assert.equal(s.needsYou, true);
  assert.equal(s.files, 4);
  assert.equal(s.turns, 2);
  assert.equal(s.drafts, 3);
  assert.equal(s.additions, 5);
  assert.equal(s.href, "#/review/rv_GGGGGGGGGGGG");
  assert.equal(s.source, "chat");
});

test("BUG-277: название пункта — текущее название чата (на конце первого хода чат ещё «Чат»)", async () => {
  assert.equal(summaryOf(item({ title: null })).title, "Чат");
  assert.equal(summaryOf(item({ title: null }), { chatTitle: "Функция скидки в orders.js" }).title, "Функция скидки в orders.js");
  const { ReviewService, ReviewStore } = await import("../lib/review.js");
  const svc = new ReviewService({ store: new ReviewStore({ dir: "/nonexistent-teleharness-test", log: () => {} }), objectsRoot: "/x", tmpDir: "/x", titleOf: (it) => (it.source.sid === "ses_1" ? "  Новое имя  " : null) });
  assert.equal(svc.summary(item({ title: "Чат" })).title, "Новое имя");
  assert.equal(svc.summary(item({ source: { kind: "chat", sid: "ses_2" } })).title, "Токен", "нет названия чата — прежнее");
  const broken = new ReviewService({ store: new ReviewStore({ dir: "/nonexistent-teleharness-test", log: () => {} }), objectsRoot: "/x", tmpDir: "/x", titleOf: () => { throw new Error("boom"); } });
  assert.equal(broken.summary(item()).title, "Токен", "ошибка поиска названия не ломает сводку");
});

test("кр. 18: статусы и needsYou — истина только у waiting/decision/changed/interrupted", () => {
  assert.equal(statusOf(item({ state: "returned" })), "returned");
  assert.equal(statusOf(item({ state: "interrupted" })), "interrupted");
  assert.equal(statusOf(item({ stale: true })), "changed");
  assert.equal(statusOf(item({ chatDeleted: true })), "chat-deleted");
  assert.deepEqual([...NEEDS_YOU].sort(), ["changed", "decision", "interrupted", "waiting"]);
  assert.equal(summaryOf(item({ state: "returned" })).needsYou, false);
  assert.equal(summaryOf(item({ chatDeleted: true })).needsYou, false);
});

test("доска: ждущее ревью — в «Ждёт вас» и счётчике, «Агент правит» — только во вкладке (Scenario «Элемент ревью на доске»)", () => {
  const b = buildBoard({ now: 5000, since: 0, chats: [], live: { busy: {}, dialogs: [] }, outcomes: {}, runs: [], user: { seen: {}, snooze: {} }, sources: { reviews: "ok" },
    reviews: [summaryOf(item()), summaryOf(item({ id: "rv_HHHHHHHHHHHH", state: "returned" }))] });
  assert.equal(b.counts.needs, 1);
  assert.equal(b.counts.review, 1);
  assert.equal(b.reviews.length, 2);
  assert.equal(b.items.find((i) => i.key === "review:rv_GGGGGGGGGGGG").href, "#/review/rv_GGGGGGGGGGGG");
});

test("turns: файлы пункта — объединение ходов по пути", () => {
  const it = item({ mode: "turns", revisions: [{ n: 1, files: [{ path: "a", additions: 1, deletions: 0, status: "M" }] }, { n: 2, files: [{ path: "a", additions: 2, deletions: 1, status: "M" }, { path: "b", additions: 1, deletions: 0, status: "A" }] }] });
  const f = filesOf(it);
  assert.equal(f.length, 2);
  assert.equal(f.find((x) => x.path === "a").additions, 3);
});

test("кр. 7: исход комментария — «строки изменились» / «не менялись» по патчу между ревизиями", () => {
  const patch = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -44,2 +44,2 @@\n-old44\n+new44\n ctx\n";
  assert.equal(commentOutcome({ side: "new", from: 42, to: 47, file: "a.js" }, patch), "changed");
  assert.equal(commentOutcome({ side: "new", from: 1, to: 5, file: "a.js" }, patch), "unchanged");
  assert.equal(commentOutcome({ side: "new", from: 1, to: 5, file: "a.js" }, null), "unchanged");
  assert.equal(commentOutcome({ side: "file", file: "a.js" }, patch), "changed");
  assert.equal(commentOutcome({ side: "new", from: 1, to: 2 }, "gone"), "gone");
});

test("кр. 3/N-18: комментарий — не больше 200 строк, сторона обязательна, текст ≤ 4000", () => {
  assert.throws(() => cleanComment({ side: "new", file: "a", from: 10, to: 260, text: "x" }, { revision: 1 }), (e) => e instanceof ReviewError && e.code === "too-many-lines");
  assert.throws(() => cleanComment({ side: "nope", file: "a", text: "x" }, { revision: 1 }), ReviewError);
  assert.throws(() => cleanComment({ side: "new", file: "a", from: 1, text: "x".repeat(4001) }, { revision: 1 }), ReviewError);
  const ok = cleanComment({ side: "new", file: "a", from: 47, to: 42, text: "x" }, { revision: 2 });
  assert.deepEqual([ok.from, ok.to, ok.revision], [42, 47, 2]);
  const g = cleanComment({ side: "general", text: "Общий" }, { revision: 1 });
  assert.equal(g.file, null);
});

test("кр. 12: «Сначала план» — флаг привязки переживает правку, 400 на не-boolean", () => {
  const cur = makeBinding({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } });
  const on = patchBinding(cur, { planFirst: true });
  assert.equal(on.binding.planFirst, true);
  const again = patchBinding(on.binding, { permMode: "ask" });
  assert.equal(again.binding.planFirst, true);
  assert.equal(patchBinding(on.binding, { planFirst: false }).binding.planFirst, undefined);
  assert.equal(patchBinding(cur, { planFirst: "yes" }).status, 400);
});

test("кр. 12/N-22: где «Сначала план» недоступен — причина", () => {
  assert.equal(planUnsupported({ engine: "claude", admin: false }), null);
  assert.equal(planUnsupported({ engine: "codex", admin: true }), null);
  assert.equal(planUnsupported({ engine: "opencode", admin: true }), null);
  assert.match(planUnsupported({ engine: "opencode", admin: false }), /нет агента «plan»/);
  assert.deepEqual(OC_PLAN_RULES.map((r) => `${r.action}:${r.effect}`), ["edit:deny", "shell:ask"]);
});

test("кр. 12: план-ход Claude — --permission-mode plan + мост stdio; тенант сохраняет --restricted", () => {
  const a = permissionArgs("admin", { mode: "plan", addDirs: [] });
  assert.deepEqual(a, PLAN_ARGS);
  const t = permissionArgs("tenant", { mode: "plan" });
  assert.deepEqual(t.slice(0, 2), ["--restricted", "--strict-mcp-config"]);
  assert.ok(t.includes("plan") && t.includes("stdio"));
});

test("кр. 12: план-ход Codex — только --permission-mode plan → посредник read-only", () => {
  const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--model", "gpt-6.1-sol", ...permissionArgs("admin", { mode: "plan-ro", addDirs: [] })];
  const pol = codexPolicy(parseCodexArgs(args));
  assert.equal(pol.sandbox, "read-only");
  assert.equal(pol.mode, "plan");
});

test("ход выполнения одобренного плана несёт текст плана и пометку правок", () => {
  assert.match(planExecText("1. Сделать X", { edited: true }), /одобрен с моими правками[\s\S]*1\. Сделать X/);
});

test("наблюдатель исходов: начало и любой конец хода opencode (в т. ч. «Стоп») для снимков ревью", () => {
  const ev = [];
  const o = new OutcomeObserver({ onTurnStart: (sid) => ev.push(["start", sid]), onTurnEnd: (sid, r) => ev.push(["end", sid, r.kind]) });
  const st = (sid, type) => JSON.stringify({ type: "session.status", properties: { sessionID: sid, status: { type } } });
  o.observe(st("s1", "busy"));
  o.observe(st("s1", "busy"));
  o.observe(st("s1", "idle"));
  o.observe(st("s2", "busy"));
  o.noteUserStop("s2");
  o.observe(st("s2", "idle"));
  assert.deepEqual(ev, [["start", "s1"], ["end", "s1", "done"], ["start", "s2"], ["end", "s2", "stopped"]]);
});

test("кр. 8: «Принять и закоммитить» → Git получает файлы пункта один раз (git-client)", async () => {
  const mem = new Map();
  const prev = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    const { giveReviewSelection, takeReviewSelection } = await import("../src/lib/git-client.js");
    giveReviewSelection("ses_1", ["src/a.js", "b.md"]);
    assert.deepEqual(takeReviewSelection("ses_1"), ["src/a.js", "b.md"]);
    assert.equal(takeReviewSelection("ses_1"), null, "второй раз — обычная предвыборка");
  } finally {
    globalThis.sessionStorage = prev;
  }
});

// BUG-273 (BUG-20.11): проект карточки ревью — проект чата, а не папка копии/чата;
// строка «что случилось» не повторяет «Ревью · N файлов» метаданных.
test("BUG-273: summaryOf — проект из папки чата (projectDir), не из папки копии; без неё — как раньше", () => {
  const wt = item({ dir: "/p/shop/.teleharness-worktrees/mul-function-v-fayle-src-calc-js-pkmp", project: { name: "mul-function-v-fayle-src-calc-js-pkmp" } });
  assert.deepEqual(summaryOf(wt, { projectDir: "/p/shop" }).project, { name: "shop", dir: "/p/shop" });
  const tenant = item({ dir: "/t/alice/proj/e06394835ffe0011", project: { name: "e06394835ffe0011" } });
  assert.deepEqual(summaryOf(tenant, { projectDir: "/t/alice/proj" }).project, { name: "proj", dir: "/t/alice/proj" });
  assert.deepEqual(summaryOf(item()).project, { name: "teleharness", dir: "/p/teleharness" });
});

test("BUG-273: ReviewService.projectDirOf — проект в summaries/list/detail совпадает с проектом чата", async () => {
  const { ReviewService, ReviewStore } = await import("../lib/review.js");
  const data = mkdtempSync(path.join(os.tmpdir(), "teleharness-rv-273-"));
  try {
    const svc = new ReviewService({ store: new ReviewStore({ dir: path.join(data, "review"), log: () => {} }), objectsRoot: path.join(data, "o"), tmpDir: path.join(data, "t"), log: () => {},
      projectDirOf: (it) => (it.source?.sid === "ses_1" ? "/p/shop" : null) });
    const d = svc.store.data("u1");
    d.items.rv_GGGGGGGGGGGG = { ...item({ dir: "/p/shop/.wt/x-pkmp", project: { name: "x-pkmp" } }), owner: "u1", version: 1, base: { at: 1 } };
    d.items.rv_HHHHHHHHHHHH = { ...item({ id: "rv_HHHHHHHHHHHH", source: { kind: "chat", sid: "ses_other" }, dir: "/p/teleharness" }), owner: "u1", version: 1, base: { at: 1 } };
    const s = svc.summaries("u1");
    assert.deepEqual(s.find((x) => x.id === "rv_GGGGGGGGGGGG").project, { name: "shop", dir: "/p/shop" });
    assert.deepEqual(s.find((x) => x.id === "rv_HHHHHHHHHHHH").project, { name: "teleharness", dir: "/p/teleharness" }, "нет папки чата — папка пункта");
    assert.deepEqual(svc.list("u1").items.find((x) => x.id === "rv_GGGGGGGGGGGG").project, { name: "shop", dir: "/p/shop" });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("BUG-273: доска — у карточки ревью нет строки-повтора «Ревью · N файлов»; проект в фильтре — проект чата", () => {
  const b = buildBoard({ now: 5000, since: 0, chats: [{ id: "ses_1", title: "Токен", dir: "/p/shop", engine: "claude" }], live: { busy: {}, dialogs: [] }, outcomes: { ses_1: { kind: "done", at: 4000 } }, runs: [], user: { seen: {}, snooze: {} }, sources: { reviews: "ok" },
    reviews: [summaryOf(item({ dir: "/p/shop/.wt/x-pkmp", revisions: [{ n: 1, turns: ["m"], files: [{ path: "a.js", additions: 4, deletions: 0 }] }] }), { projectDir: "/p/shop" })] });
  const rv = b.items.find((i) => i.key === "review:rv_GGGGGGGGGGGG");
  assert.equal(rv.snippet, null, "число файлов уже в строке состояния («Ревью · 1 файл»)");
  assert.deepEqual(rv.project, { name: "shop", dir: "/p/shop" });
  assert.deepEqual(b.projects, [{ dir: "/p/shop", name: "shop" }], "один проект в фильтре");
});
