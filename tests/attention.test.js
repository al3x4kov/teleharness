// FEAT-20.2: доска внимания — чистая сборка (buildBoard), хранилище отметок
// и исходов (AttentionStore), сводка «Пока вас не было», наблюдатель исходов
// opencode-чатов. Каждое правило карточки — отдельный тест.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATTENTION, AttentionStore, OutcomeObserver, awaySummary, buildBoard, cleanPushPrefs, clip, isAttentionKey, outcomeOfError } from "../lib/attention.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const chat = (id, extra = {}) => ({ id, title: `Чат ${id}`, dir: "/p/teleharness", engine: "claude", model: "claude-opus-5-5", ...extra });
const board = (over = {}) => buildBoard({ now: NOW, since: 0, chats: [], live: { busy: {}, dialogs: [] }, outcomes: {}, runs: [], user: { seen: {}, snooze: {} }, ...over });
const byKey = (b) => Object.fromEntries(b.items.map((it) => [it.key, it]));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "teleharness-attn-"));

test("кр. 2: четыре секции с числами; спокойные просмотренные чаты не показываются (кр. 9)", () => {
  const b = board({
    chats: [chat("a"), chat("b"), chat("c"), chat("d"), chat("calm")],
    live: { busy: { b: { since: NOW - 5 * MIN, lastEvent: NOW - 10_000 } }, dialogs: [{ id: "per_1", sessionID: "a", kind: "permission", askedAt: NOW - 12 * MIN, props: { permission: "bash", metadata: { command: "npm run migrate" } } }] },
    outcomes: { c: { kind: "done", at: NOW - MIN, snippet: "Готово: отчёт" }, d: { kind: "limit", at: NOW - 2 * MIN, snippet: "usage limit" }, calm: { kind: "done", at: NOW - 60 * MIN } },
    user: { seen: { "chat:calm": NOW - 30 * MIN }, snooze: {} },
  });
  assert.deepEqual({ ...b.counts }, { needs: 1, review: 0, working: 1, done: 1, failed: 1, unknown: 0, snoozed: 0, older: 0 });
  const k = byKey(b);
  assert.equal(k["chat:a"].state, "needs");
  assert.equal(k["chat:a"].reason, "permission");
  assert.deepEqual(k["chat:a"].permission, { id: "per_1", tool: "bash", summary: "npm run migrate" });
  assert.equal(k["chat:b"].state, "working");
  assert.equal(k["chat:c"].snippet, "Готово: отчёт");
  assert.equal(k["chat:d"].reason, "limit");
  assert.equal(k["chat:calm"], undefined, "просмотренный чат — не элемент");
  assert.deepEqual(b.items.map((it) => it.state), ["needs", "failed", "working", "done"], "порядок секций");
});

test("кр. 2: «Ждёт вас» — самые давние первыми, остальные — свежие первыми; закреплённые — первыми в секции", () => {
  const b = board({
    chats: [chat("x"), chat("y"), chat("d1"), chat("d2"), chat("d3")],
    live: { busy: {}, dialogs: [
      { id: "q1", sessionID: "x", kind: "question", askedAt: NOW - 3 * MIN, props: {} },
      { id: "q2", sessionID: "y", kind: "question", askedAt: NOW - 40 * MIN, props: {} },
    ] },
    outcomes: { d1: { kind: "done", at: NOW - 3 * MIN }, d2: { kind: "done", at: NOW - MIN }, d3: { kind: "done", at: NOW - 9 * MIN } },
    pins: ["d3"],
  });
  assert.deepEqual(b.items.map((it) => it.key), ["chat:y", "chat:x", "chat:d3", "chat:d2", "chat:d1"]);
  assert.equal(b.items[2].pinned, true);
});

test("кр. 3, N-20: запрос субагента поднимается в родителя; субагенты и шаги пайпа — не элементы", () => {
  const b = board({
    chats: [chat("parent", { title: "Миграция базы" }), chat("kid", { parentID: "parent", title: "Explore", agent: "explore" }), chat("step", { step: true }), chat("stepkid", { parentID: "step" })],
    live: { busy: { kid: { since: NOW, lastEvent: NOW } }, dialogs: [
      { id: "p1", sessionID: "kid", kind: "permission", askedAt: NOW - MIN, props: { permission: "read" } },
      { id: "p2", sessionID: "stepkid", kind: "permission", askedAt: NOW - MIN, props: {} },
    ] },
    outcomes: { step: { kind: "done", at: NOW } },
  });
  assert.deepEqual(b.items.map((it) => it.key), ["chat:parent"]);
  assert.equal(b.items[0].state, "needs");
  assert.equal(b.items[0].agent, "explore", "«разрешение у агента Explore»");
  assert.equal(b.items[0].permission, null, "запрос субагента отвечается в чате, не с доски");
});

test("кр. 5, N-28: непросмотренное — событие позже отметки; снова готово после просмотра", () => {
  const base = { chats: [chat("a")], outcomes: { a: { kind: "done", at: NOW - MIN } } };
  assert.equal(board({ ...base, user: { seen: { "chat:a": NOW - 2 * MIN }, snooze: {} } }).counts.done, 1);
  assert.equal(board({ ...base, user: { seen: { "chat:a": NOW - MIN }, snooze: {} } }).counts.done, 0, "отметка = событие → просмотрено");
  assert.equal(board({ ...base, since: NOW }).counts.done, 0, "миграция: до выката — просмотрено");
});

test("кр. 8, N-17: отложенный — вне счётчиков до срока; новое событие возвращает его сразу", () => {
  const snooze = { "chat:a": { until: NOW + 60 * MIN, at: NOW - 5 * MIN } };
  let b = board({ chats: [chat("a")], outcomes: { a: { kind: "done", at: NOW - 10 * MIN } }, user: { seen: {}, snooze } });
  assert.equal(b.counts.done, 0);
  assert.equal(b.counts.snoozed, 1);
  assert.equal(b.items[0].snoozedFrom, "done");
  b = board({ chats: [chat("a")], live: { busy: {}, dialogs: [{ id: "p", sessionID: "a", kind: "permission", askedAt: NOW - MIN }] }, outcomes: { a: { kind: "done", at: NOW - 10 * MIN } }, user: { seen: {}, snooze } });
  assert.equal(b.counts.needs, 1, "новый запрос после отложения — сразу в «Ждёт вас»");
  assert.equal(b.items[0].returned, true);
  b = board({ chats: [chat("a")], outcomes: { a: { kind: "done", at: NOW - 10 * MIN } }, user: { seen: {}, snooze: { "chat:a": { until: NOW - 1, at: NOW - 5 * MIN } } } });
  assert.equal(b.counts.done, 1, "срок вышел");
});

test("кр. 9: «Готово» старше 7 дней и «Упало» старше 14 — в «Старше», вне счётчиков", () => {
  const b = board({
    chats: [chat("d"), chat("f"), chat("f2")],
    outcomes: { d: { kind: "done", at: NOW - 8 * 24 * 60 * MIN }, f: { kind: "error", at: NOW - 15 * 24 * 60 * MIN }, f2: { kind: "error", at: NOW - 13 * 24 * 60 * MIN } },
  });
  assert.equal(b.counts.older, 2);
  assert.equal(b.counts.done, 0);
  assert.equal(b.counts.failed, 1);
});

test("кр. 9, N-21: не больше 200 элементов, «показаны 200 из N», числа секций полные", () => {
  const chats = [];
  const outcomes = {};
  for (let i = 0; i < 412; i++) {
    chats.push(chat("c" + i));
    outcomes["c" + i] = { kind: i % 3 ? "done" : "error", at: NOW - i * 1000 };
  }
  const b = board({ chats, outcomes });
  assert.equal(b.items.length, ATTENTION.maxItems);
  assert.deepEqual(b.truncated, { shown: 200, total: 412 });
  assert.equal(b.counts.done + b.counts.failed, 412);
  assert.ok(b.items.slice(0, b.counts.failed).every((it) => it.state === "failed"), "сначала упавшие");
});

test("кр. 9: фильтр по проекту и поиск по названию", () => {
  const b = board({
    chats: [chat("a", { dir: "/p/teleharness" }), chat("b", { dir: "/p/other", title: "Отчёт" }), chat("c", { dir: "/p/teleharness", title: "Отчёт по продажам" })],
    outcomes: { a: { kind: "done", at: NOW }, b: { kind: "done", at: NOW }, c: { kind: "done", at: NOW } },
    filter: { project: "/p/teleharness", q: "отчёт" },
  });
  assert.deepEqual(b.items.map((it) => it.key), ["chat:c"]);
  assert.equal(b.counts.done, 1);
  assert.equal(b.projects.length, 2, "список проектов для фильтра — по всем элементам");
});

test("кр. 13, N-9: «нет вестей» после 5 мин тишины; фоновые агенты", () => {
  const b = board({
    chats: [chat("q"), chat("bg")],
    live: { busy: { q: { since: NOW - 20 * MIN, lastEvent: NOW - 9 * MIN }, bg: { since: NOW - 41 * MIN, lastEvent: null, bg: true, bgAgents: 2 } }, dialogs: [] },
  });
  const k = byKey(b);
  assert.equal(k["chat:q"].reason, "quiet");
  assert.equal(Math.round(k["chat:q"].silentMs / MIN), 9);
  assert.equal(k["chat:bg"].reason, "bg");
  assert.equal(k["chat:bg"].bgAgents, 2);
});

test("кр. 13, N-10: opencode недоступен — «Неизвестно», Claude — как есть; исходы на месте", () => {
  const b = board({
    chats: [chat("oc", { engine: "opencode" }), chat("cl"), chat("ocdone", { engine: "opencode" })],
    live: { busy: { oc: { since: NOW - MIN, lastEvent: NOW }, cl: { since: NOW - MIN, lastEvent: NOW } }, dialogs: [] },
    outcomes: { ocdone: { kind: "done", at: NOW } },
    sources: { opencode: "down" },
  });
  const k = byKey(b);
  assert.equal(k["chat:oc"].state, "unknown");
  assert.equal(k["chat:cl"].state, "working");
  assert.equal(k["chat:ocdone"].state, "done");
});

test("кр. 12, 13: перезапуск и зависание — «Упало или остановлено»; ошибка входа — разный текст admin/тенант", () => {
  const base = { chats: [chat("r"), chat("s"), chat("a")], outcomes: { r: { kind: "restart", at: NOW }, s: { kind: "stalled", at: NOW }, a: { kind: "auth", at: NOW, snippet: "OAuth token expired" } } };
  const b = board({ ...base, admin: true });
  const k = byKey(b);
  assert.equal(b.counts.failed, 3);
  assert.equal(k["chat:r"].reason, "restart");
  assert.equal(k["chat:s"].reason, "stalled");
  assert.match(k["chat:a"].snippet, /Нужен вход/);
  assert.match(byKey(board({ ...base, admin: false }))["chat:a"].snippet, /сообщите администратору/);
});

test("кр. 3: запуски Temporal — решение, работа, готово, упало; отмена человеком — не «упало»; недоступен — «Неизвестно»", () => {
  const run = (id, kind, extra = {}) => ({ workflowId: id, name: "Пайп " + id, directory: "/p/teleharness", summary: { kind, startTime: new Date(NOW - 10 * MIN).toISOString(), closeTime: ["ok", "err", "cancel", "term", "rejected"].includes(kind) ? new Date(NOW - MIN).toISOString() : null, current: { name: "Проверка" } }, ...extra });
  const b = board({ runs: [run("w", "wait"), run("r", "run"), run("q", "quota"), run("ok", "ok"), run("e", "err"), run("c", "cancel"), run("u", "unavailable"), run("t", "term", { pipeDeleted: true })] });
  const k = byKey(b);
  assert.equal(k["run:w"].state, "needs");
  assert.equal(k["run:w"].reason, "decision");
  assert.equal(k["run:w"].href, "#/temporal/run/w");
  assert.equal(k["run:r"].state, "working");
  assert.equal(k["run:q"].reason, "quota");
  assert.equal(k["run:ok"].state, "done");
  assert.equal(k["run:e"].state, "failed");
  assert.equal(k["run:c"], undefined, "отменён человеком");
  assert.equal(k["run:u"].state, "unknown");
  assert.equal(k["run:t"].pipeDeleted, true);
  assert.equal(k["run:w"].snippet, "Шаг «Проверка»");
  assert.equal(board({ runs: [run("ok", "ok")], since: NOW }).counts.done, 0, "миграция: завершённые до выката — просмотрены");
});

test("кр. 21, N-32: ревью — needsYou в «Ждёт вас» и счётчиках; «Агент правит» — только на вкладке; запуск с ревью — один элемент", () => {
  const rv = (id, status, extra = {}) => ({ id, key: `review:${id}`, source: "chat", title: "Ревью " + id, project: { name: "zai", dir: "/p/teleharness" }, status, needsYou: ["waiting", "decision", "changed", "interrupted"].includes(status), files: 7, since: NOW - 25 * MIN, href: `#/review/${id}`, ...extra });
  const b = board({
    chats: [chat("a")],
    live: { busy: {}, dialogs: [{ id: "p", sessionID: "a", kind: "permission", askedAt: NOW - 40 * MIN }] },
    reviews: [rv("r1", "waiting"), rv("r2", "returned"), rv("r3", "decision", { source: "run", runId: "wf1" })],
    runs: [{ workflowId: "wf1", name: "Задача → PR", directory: "/p/teleharness", summary: { kind: "wait", startTime: new Date(NOW - 30 * MIN).toISOString() } }],
  });
  assert.equal(b.counts.needs, 3);
  assert.equal(b.counts.review, 2);
  assert.deepEqual(b.items.map((it) => it.key), ["chat:a", "review:r1", "review:r3"], "разрешение 40 мин — раньше ревью 25 мин; run:wf1 не отдельным элементом");
  assert.equal(b.items[1].href, "#/review/r1");
  assert.equal(b.items[1].review.status, "waiting");
  assert.equal(b.reviews.length, 3, "вкладка «Ждёт ревью» получает всю очередь");
  assert.equal(board({}).reviews, null, "нет источника ревью — null (sources.reviews off)");
});

test("кр. 2: строка «что случилось» ≤ 140 символов; ключи элементов", () => {
  assert.equal(clip("x".repeat(500)).length, 140);
  assert.equal(clip("  две\n\nстроки  "), "две строки");
  assert.equal(clip(""), null);
  assert.ok(isAttentionKey("chat:ses_1"));
  assert.ok(isAttentionKey("run:teleharness-1.2"));
  assert.ok(!isAttentionKey("chat:../x"));
  assert.ok(!isAttentionKey("foo:1"));
});

test("N-27: остановка пользователем — не исход; лимит, вход, ошибка — по общему классификатору", () => {
  assert.equal(outcomeOfError(null), "done");
  assert.equal(outcomeOfError({ name: "MessageAbortedError" }), null);
  assert.equal(outcomeOfError({ message: "usage limit reached" }), "limit");
  assert.equal(outcomeOfError({ message: "OAuth token expired" }, { engine: "claude" }), "auth");
  assert.equal(outcomeOfError({ message: "boom" }), "error");
});

test("AttentionStore: исходы и отметки переживают перезапуск; идемпотентная отметка; лимиты", () => {
  const dir = tmp();
  try {
    let t = NOW;
    const s1 = new AttentionStore({ dir, now: () => t, log: () => {} });
    assert.equal(s1.since, NOW, "миграция: since = первый запуск");
    s1.setOutcome("ses_a", { kind: "done", snippet: "  ответ  " });
    s1.setOutcome("ses_b", { kind: "bogus" });
    assert.equal(s1.outcome("ses_b"), null);
    assert.equal(s1.markSeen("u1", ["chat:ses_a"], NOW), 1);
    assert.equal(s1.markSeen("u1", ["chat:ses_a"], NOW), 0, "повтор — без изменений");
    assert.equal(s1.markSeen("u1", ["chat:ses_a"], NOW - 5), 0, "отметка не двигается назад");
    s1.snooze("u1", "chat:ses_x", NOW + MIN);
    t = NOW + 1000;
    const s2 = new AttentionStore({ dir, now: () => t, log: () => {} });
    assert.equal(s2.since, NOW);
    assert.equal(s2.outcome("ses_a").snippet, "ответ");
    assert.equal(s2.user("u1").seen["chat:ses_a"], NOW);
    assert.equal(s2.user("u1").snooze["chat:ses_x"].until, NOW + MIN);
    assert.equal(s2.user("../evil"), null, "имя файла пользователя проверяется");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("кр. 14: удалённый чат — отметки, отложения, события и исход удаляются у всех пользователей", () => {
  const dir = tmp();
  try {
    const s = new AttentionStore({ dir, now: () => NOW, log: () => {} });
    s.setOutcome("ses_d", { kind: "done" });
    s.markSeen("u1", ["chat:ses_d", "chat:ses_keep"]);
    s.snooze("u2", "chat:ses_d", NOW + MIN);
    s.addEvent(["u1"], { kind: "done", key: "chat:ses_d", text: "x" });
    s.forgetKey("chat:ses_d", { sid: "ses_d" });
    const fresh = new AttentionStore({ dir, now: () => NOW, log: () => {} });
    assert.equal(fresh.outcome("ses_d"), null);
    assert.equal("chat:ses_d" in fresh.user("u1").seen, false);
    assert.equal("chat:ses_keep" in fresh.user("u1").seen, true);
    assert.equal("chat:ses_d" in fresh.user("u2").snooze, false);
    assert.equal(fresh.user("u1").events.length, 0);
    s.dropUser("u1");
    assert.equal(existsSync(path.join(dir, "users", "u1.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("кр. 6: сводка «Пока вас не было» — после ≥ 30 мин отсутствия и хотя бы одного события; «Понятно» скрывает", () => {
  const dir = tmp();
  try {
    let t = NOW;
    const s = new AttentionStore({ dir, now: () => t, log: () => {} });
    s.touch("u1");
    t += 10 * MIN;
    s.addEvent(["u1"], { kind: "done", text: "Готово: «a»" });
    s.touch("u1");
    assert.equal(awaySummary(s.user("u1"), { now: t }), null, "короткое отсутствие — сводки нет");
    t += 6 * 60 * MIN;
    s.addEvent(["u1"], { at: t - 60 * MIN, kind: "done", text: "Готово" });
    s.addEvent(["u1"], { at: t - 50 * MIN, kind: "limit", text: "Лимит подписки: «b»" });
    s.addEvent(["u1"], { at: t - 49 * MIN, kind: "relay", text: "Relay: «b» автоматически продолжен на GPT-6.1 Sol" });
    s.addEvent(["u1"], { at: t - 30 * MIN, kind: "crash", text: "Сервер аварийно перезапустился в 03:12" });
    s.touch("u1");
    const runs = [{ workflowId: "w", name: "Ночное", summary: { kind: "ok", closeTime: new Date(t - 20 * MIN).toISOString() } }];
    const a = awaySummary(s.user("u1"), { runs, now: t });
    assert.equal(a.durationMs, 6 * 60 * MIN);
    assert.equal(a.counts.done, 1);
    assert.equal(a.counts.failed, 1);
    assert.equal(a.counts.runs, 1);
    assert.equal(a.counts.relay, 1);
    assert.equal(a.counts.crash, 1);
    assert.deepEqual(a.events.map((e) => e.kind), ["limit", "relay", "crash", "run-done"]);
    s.ackAway("u1");
    assert.equal(awaySummary(s.user("u1"), { runs, now: t }), null, "«Понятно» — на всех устройствах");
    const s2 = new AttentionStore({ dir, now: () => t, log: () => {} });
    assert.equal(awaySummary(s2.user("u1"), { runs, now: t }), null, "переживает перезапуск");
    s2.touch("u1", t + 40 * MIN);
    assert.equal(awaySummary(s2.user("u1"), { now: t + 40 * MIN }), null, "отсутствие без событий — сводки нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("кр. 15: настройки push — только известные поля, по умолчанию всё включено, тихие часы выключены", () => {
  assert.deepEqual(cleanPushPrefs({}), { needs: true, failed: true, done: true, quiet: { on: false, from: "23:00", to: "08:00", tz: null } });
  assert.equal(cleanPushPrefs({ done: false }).done, false);
  assert.deepEqual(cleanPushPrefs({ quiet: { on: true, from: "22:30", to: "07:00", tz: "Europe/Moscow" } }).quiet, { on: true, from: "22:30", to: "07:00", tz: "Europe/Moscow" });
  assert.equal(cleanPushPrefs({ done: "no" }), null);
  assert.equal(cleanPushPrefs({ quiet: { from: "25:00" } }), null);
  assert.equal(cleanPushPrefs([]), null);
});

test("наблюдатель opencode: busy→idle = готово; ошибка; стоп человеком и MessageAbortedError — не исход; зависание; Claude — мимо", () => {
  const got = [];
  const asks = [];
  const o = new OutcomeObserver({ isManaged: (sid) => sid === "cl", onOutcome: (sid, rec) => got.push([sid, rec.kind]), onAsk: (sid) => asks.push(sid) });
  const ev = (type, props) => o.observe(JSON.stringify({ type, properties: props }));
  ev("session.status", { sessionID: "a", status: { type: "busy" } });
  ev("session.idle", { sessionID: "a" });
  ev("session.status", { sessionID: "b", status: { type: "busy" } });
  ev("session.error", { sessionID: "b", error: { name: "APIError", data: { message: "rate limit 429" } } });
  ev("session.idle", { sessionID: "b" });
  ev("session.status", { sessionID: "c", status: { type: "busy" } });
  ev("session.error", { sessionID: "c", error: { name: "MessageAbortedError" } });
  ev("session.idle", { sessionID: "c" });
  ev("session.status", { sessionID: "d", status: { type: "busy" } });
  o.noteUserStop("d");
  ev("session.idle", { sessionID: "d" });
  ev("session.status", { sessionID: "s", status: { type: "busy" } });
  ev("teleharness.turn.stalled", { sessionID: "s" });
  ev("session.error", { sessionID: "s", error: { name: "MessageAbortedError" } });
  ev("session.idle", { sessionID: "s" });
  ev("session.status", { sessionID: "cl", status: { type: "busy" } });
  ev("session.idle", { sessionID: "cl" });
  ev("session.idle", { sessionID: "never-busy" });
  ev("permission.asked", { sessionID: "a", id: "per" });
  assert.deepEqual(got, [["a", "done"], ["b", "limit"], ["s", "stalled"]]);
  assert.deepEqual(asks, ["a"]);
  // следующий ход после «Стопа» снова даёт исход
  ev("session.status", { sessionID: "d", status: { type: "busy" } });
  ev("session.idle", { sessionID: "d" });
  assert.deepEqual(got.at(-1), ["d", "done"]);
  const raw = readFileSync(new URL("../lib/attention.js", import.meta.url), "utf8");
  assert.ok(!/fetch\(|anthropic|openai/i.test(raw), "сводка и доска — без вызова модели");
});

// BUG-272 (BUG-20.10): opencode 2.x после execution.failed не шлёт session.idle —
// ход с ошибкой провайдера (429 provider.quota) не давал исхода и пропадал с доски,
// а следующий ход того же чата не считался новым.
test("BUG-272: ход opencode 2.x с ошибкой 429 через переписыватель v2 — исход limit; следующий ход — новый", async () => {
  const { createV2Rewriter } = await import("../lib/oc-client.js");
  const got = [];
  const starts = [];
  const o = new OutcomeObserver({ onOutcome: (sid, rec) => got.push([sid, rec.kind, rec.errorKind]), onTurnStart: (sid) => starts.push(sid) });
  const rw = createV2Rewriter({ emit: (e) => o.observe(JSON.stringify(e), e.directory ?? null) });
  const feed = (e) => { const out = rw(e); if (out) o.observe(JSON.stringify(out), out.directory ?? null); };
  const loc = { directory: "/p/shop" };
  const turn = () => {
    feed({ type: "session.inbox.enqueued", location: loc, data: { sessionID: "q", inboxID: "in1", item: { type: "user" } } });
    feed({ type: "session.execution.started", location: loc, data: { sessionID: "q" } });
    feed({ type: "session.step.started", location: loc, data: { sessionID: "q", assistantMessageID: "m1" } });
    feed({ type: "session.step.failed", location: loc, data: { sessionID: "q", error: { type: "provider.quota", message: "429 Weekly/Monthly Limit Exhausted" } } });
    feed({ type: "session.execution.failed", location: loc, data: { sessionID: "q", error: { type: "provider.quota", message: "429 Weekly/Monthly Limit Exhausted" } } });
  };
  turn();
  assert.deepEqual(got, [["q", "limit", "limit"]], "ход с 429 — исход «лимит» на доске");
  turn();
  assert.equal(got.length, 2, "повтор промпта — снова исход");
  assert.deepEqual(starts, ["q", "q"], "каждый ход — новый (снимок ревью перед ходом)");
  // «Стоп» (execution.failed aborted) — конец хода без исхода, следующий ход снова даёт исход
  feed({ type: "session.execution.started", location: loc, data: { sessionID: "q" } });
  o.noteUserStop("q");
  feed({ type: "session.execution.failed", location: loc, data: { sessionID: "q", error: { type: "aborted", message: "Aborted" } } });
  assert.equal(got.length, 2);
  feed({ type: "session.execution.started", location: loc, data: { sessionID: "q" } });
  feed({ type: "session.execution.succeeded", location: loc, data: { sessionID: "q" } });
  assert.deepEqual(got.at(-1), ["q", "done", null]);
});

test("BUG-303: awaySummary — run-failed инкрементирует только counts.failed и не задваивает counts.runs", () => {
  const dir = tmp();
  try {
    let t = NOW;
    const s = new AttentionStore({ dir, now: () => t, log: () => {} });
    s.touch("u1");
    t += 60 * MIN;
    s.touch("u1");
    const runs = [
      { workflowId: "w-ok", name: "Успешный", summary: { kind: "ok", closeTime: new Date(t - 20 * MIN).toISOString() } },
      { workflowId: "w-err", name: "Упавший", summary: { kind: "err", closeTime: new Date(t - 10 * MIN).toISOString() } },
    ];
    const a = awaySummary(s.user("u1"), { runs, now: t });
    assert.equal(a.counts.runs, 1, "run-failed не должен попадать в counts.runs");
    assert.equal(a.counts.failed, 1, "run-failed инкрементирует counts.failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BUG-303: attentionRoutes — POST /teleharness/api/attention/snooze принимает ключ review:* своего ревью и даёт 404 на чужое", async () => {
  const { attentionRoutes } = await import("../routes/attention.js");
  const dir = tmp();
  try {
    const store = new AttentionStore({ dir, now: () => NOW, log: () => {} });
    const pings = [];
    const routes = attentionRoutes({
      sendJson: (res, status, body) => { res.status = status; res.body = body; },
      readJsonBody: async (req) => req.body,
      store,
      chatsFor: async () => [],
      live: () => ({ busy: {}, dialogs: [] }),
      sources: () => ({ opencode: "ok" }),
      boardRuns: async () => [],
      reviews: async (u) => (u.id === "u1" ? [{ id: "rv_AAAAAAAAAAAA", key: "review:rv_AAAAAAAAAAAA" }] : []),
      pinsOf: () => [],
      ping: (uid, reason) => pings.push([uid, reason]),
      now: () => NOW,
    });
    const snooze = routes.find((r) => r.path === "/teleharness/api/attention/snooze");
    const resOk = {};
    await snooze.handler({
      req: { body: { key: "review:rv_AAAAAAAAAAAA", until: NOW + 60 * MIN } },
      res: resOk,
      user: { id: "u1" },
      admin: false,
    });
    assert.equal(resOk.status, 200, "своё ревью можно отложить");
    assert.equal(store.user("u1").snooze["review:rv_AAAAAAAAAAAA"]?.until, NOW + 60 * MIN);
    assert.deepEqual(pings, [["u1", "snooze"]]);

    const resForeign = {};
    await snooze.handler({
      req: { body: { key: "review:rv_BBBBBBBBBBBB", until: NOW + 60 * MIN } },
      res: resForeign,
      user: { id: "u1" },
      admin: false,
    });
    assert.equal(resForeign.status, 404, "чужое/несуществующее ревью — 404");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

