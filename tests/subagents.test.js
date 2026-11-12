// FEAT-01.77: чистый модуль «запуск агента» (src/lib/subagents.js) — модель
// design §2 на живых фикстурах opencode 2.2.6 и собранной вручную Claude-части.
// Ленты получены прогоном сырых событий через createV2Rewriter (lib/oc-client.js).
// Run: node --test tests/subagents.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createV2Rewriter } from "../lib/oc-client.js";
import { makeMessage } from "../src/lib/normalize.js";
import {
  activeRuns,
  agentRun,
  cleanAgentOutput,
  fmtDuration,
  groupSteps,
  nowLine,
  pathTail,
  preloaderCaption,
  runsOfMessages,
  stepLabel,
  summarize,
} from "../src/lib/subagents.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const SYNC = readJson("v2-subagent-sync.json");
const BG = readJson("v2-subagent-background.json");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---- прогон сырых событий v2 через переписыватель → ленты сессий + занятость

function replay(fx) {
  const feeds = new Map(); // sessionID → сообщения
  const busy = new Set(); // sessionID → ход идёт (session.status busy / session.idle)
  const emit = (evt) => {
    const type = evt?.type;
    const p = evt?.properties ?? {};
    const sid = p.sessionID;
    if (type === "message.updated") {
      const info = p.info ?? p;
      const arr = feeds.get(sid) ?? [];
      const i = arr.findIndex((m) => m.info.id === info.id);
      if (i >= 0) arr[i] = { info: { ...arr[i].info, ...info }, parts: arr[i].parts };
      else arr.push({ info: { ...info }, parts: [] });
      feeds.set(sid, arr);
      return;
    }
    if (type === "message.part.updated") {
      const part = p.part;
      const arr = feeds.get(sid) ?? [];
      let m = arr.find((x) => x.info.id === part.messageID);
      if (!m) {
        m = { info: { id: part.messageID, sessionID: sid, role: "assistant", time: {} }, parts: [] };
        arr.push(m);
        feeds.set(sid, arr);
      }
      const i = m.parts.findIndex((x) => x.id === part.id);
      if (i >= 0) m.parts[i] = { ...m.parts[i], ...part };
      else m.parts.push({ ...part });
      return;
    }
    if (type === "session.status" && (p.status === "busy" || p.status?.type === "busy")) busy.add(sid);
    if (type === "session.idle") busy.delete(sid);
  };
  const rewrite = createV2Rewriter({ emit, throttleMs: 0 });
  let n = 0;
  const ctx = {
    childFeed: (id) => feeds.get(id) ?? null,
    busy: (id) => busy.has(id),
    tokensOf: () => null,
    now: () => 0,
    engine: "opencode",
  };
  return {
    feeds,
    ctx,
    feedTo: async (k) => {
      for (; n < k; n += 1) {
        // переписыватель часть событий эмитит сам, часть возвращает вызывающему
        const ev = rewrite(fx.events[n]);
        if (ev) emit(ev);
      }
      await tick(20); // троттлинг переписывателя (0 мс → микротаски/таймеры)
    },
    all: async () => {
      await replay_feedTo();
      return { feeds, ctx };
    },
  };
  async function replay_feedTo() {
    await feedTo(fx.events.length);
  }
}

// Метаданные из session.tool.progress переписыватель сейчас отбрасывает (чинит
// параллельный серверный исполнитель) — для промежуточных снимков ставим childId руками.
function patchPartMeta(messages, callID, patch) {
  for (const m of messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p?.type === "tool" && (p.callID ?? p.id) === callID) {
        p.state = { ...p.state, metadata: { ...(p.state?.metadata ?? {}), ...patch } };
      }
    }
  }
}

// Ввод на queued-снимке переписыватель пока не кладёт в часть (в живом потоке
// он приходит JSON-строкой в session.tool.input.ended как d.text — положит в
// state.input серверный исполнитель); для контракта клиента ставим руками.
function patchPartInput(messages, callID, input) {
  for (const m of messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p?.type === "tool" && (p.callID ?? p.id) === callID) {
        p.state = { ...p.state, input };
      }
    }
  }
}
const evIdx = (fx, pred) => fx.events.findIndex(pred);
const evIdxLast = (fx, pred) => fx.events.map((e, i) => (pred(e) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);

// ---- (а) v2-subagent-sync: обычный запуск, состояния по ходу ----------------

test("FEAT-01.77 (а): запуск в очереди → работает → готов (v2-subagent-sync)", async () => {
  const MAIN = SYNC.sessionID;
  const CHILD = "ses_e36eb8e5cffeiN1GF5pBbIeL7U";
  const CALL = "call_5ebef332437a4021944ff6fb";
  const r = replay(SYNC);

  // в очереди: ввод инструмента известен, вызов ещё не начат (часть pending)
  await r.feedTo(evIdx(SYNC, (e) => e.type === "session.tool.input.ended" && e.data?.id === CALL) + 1);
  const calledInput = SYNC.events.find((e) => e.type === "session.tool.called" && e.data?.id === CALL).data.input;
  patchPartInput(r.feeds.get(MAIN), CALL, calledInput);
  let runs = runsOfMessages(r.feeds.get(MAIN) ?? [], r.ctx);
  assert.equal(runs.length, 1, "одна карточка агента");
  let run = runs[0];
  assert.equal(run.state, "queued");
  assert.equal(run.agent, "explorer");
  assert.equal(run.description, "Список файлов в текущей папке");
  assert.equal(run.background, false);
  assert.equal(run.childId, null);
  assert.equal(run.id, CALL);
  assert.equal(run.now, null, "у очереди нет строки «сейчас»");

  // работает: childId известен (в живом прогоне — руками, см. patchPartMeta),
  // дочерняя сессия занята, шагов ещё нет → «Думает»
  await r.feedTo(evIdx(SYNC, (e) => e.type === "session.tool.progress" && e.data?.id === CALL) + 1);
  patchPartMeta(r.feeds.get(MAIN), CALL, { sessionID: CHILD, status: "running" });
  run = runsOfMessages(r.feeds.get(MAIN) ?? [], r.ctx)[0];
  assert.equal(run.state, "running");
  assert.equal(run.childId, CHILD);
  assert.deepEqual(run.now, { verb: "Думает", object: "" });

  // работает: в дочерней ленте видны glob и read — «Читает <путь>»
  await r.feedTo(evIdx(SYNC, (e) => e.type === "session.tool.called" && e.data?.id === "call_34feeceb0c8346298c7300ca") + 1);
  // работающий шаг несёт ввод (state.input) в реальном opencode; переписыватель
  // кладёт его только на success — ставим руками, чинит серверный исполнитель
  patchPartInput(r.feeds.get(CHILD), "call_34feeceb0c8346298c7300ca", SYNC.events.find((e) => e.type === "session.tool.called" && e.data?.id === "call_34feeceb0c8346298c7300ca").data.input);
  run = runsOfMessages(r.feeds.get(MAIN) ?? [], r.ctx)[0];
  assert.equal(run.state, "running");
  assert.equal(run.steps.length, 2, "glob и read — два шага");
  assert.equal(run.steps[0].tool, "glob");
  assert.equal(run.steps[0].status, "running");
  assert.deepEqual(run.now, { verb: "Читает", object: "…\\tmp\\w2-fixture-mwbohnze" }); // у пути — хвост (pathTail)

  // готов: полный прогон
  await r.feedTo(SYNC.events.length);
  run = runsOfMessages(r.feeds.get(MAIN) ?? [], r.ctx)[0];
  assert.equal(run.state, "done");
  assert.equal(run.now, null);
  assert.equal(run.steps.length, 2);
  assert.deepEqual(stepLabel(run.steps[0]), { verb: "Список файлов", object: "**/*" });
  assert.equal(stepLabel(run.steps[1]).verb, "Прочитал");
  assert.equal(run.steps[0].note, "0 файлов", "note из metadata.count у glob (метаданные фикстуры)");
  assert.ok(String(run.output).includes("каталог пуст"), "output — итоговый текст дочерней сессии");
  assert.equal(typeof run.endedAt, "number", "живая часть несёт время завершения (адаптер ставит time.completed на tool.success)");

  // история (через адаптер) несёт время: startedAt/endedAt из части
  const hist = SYNC.history.messages.map((m) => makeMessage(m.info, m.parts));
  const run2 = runsOfMessages(hist, r.ctx)[0];
  assert.equal(run2.state, "done");
  assert.equal(run2.startedAt, 1794374920201);
  assert.equal(run2.endedAt, 1794374938087);

  // токены дочерней сессии — из ctx.tokensOf
  const run3 = runsOfMessages(hist, { ...r.ctx, tokensOf: (id) => (id === CHILD ? 7668 : null) })[0];
  assert.equal(run3.tokens, 7668);
});

// ---- (б) v2-subagent-background: два фоновых --------------------------------

test("FEAT-01.77 (б): фоновые запуски — running при завершённой части, сводка и подпись", async () => {
  const MAIN = BG.sessionID;
  const C1 = "ses_e368062e1ffeCMv0fHa0hnaQ3c"; // файлы
  const C2 = "ses_e368062daffezgIQH2FzfuWa6N"; // semver
  const r = replay(BG);

  // обе части уже completed с metadata.status:"running" (навсегда), дети заняты
  await r.feedTo(evIdxLast(BG, (e) => e.type === "session.execution.started" && e.data?.sessionID === C2) + 1);
  let runs = runsOfMessages(r.feeds.get(MAIN) ?? [], r.ctx);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((x) => x.background), [true, true], "оба фоном");
  assert.deepEqual(runs.map((x) => x.state), ["running", "running"]);
  assert.deepEqual(runs.map((x) => x.childId), [C1, C2]);
  const s = summarize(runs);
  assert.equal(s.total, 2);
  assert.equal(s.running, 2);
  assert.equal(s.text, "Агенты: 2 работают");
  assert.equal(activeRuns(runs).length, 2);
  assert.match(preloaderCaption(runs, Date.now()), /^explorer ×2 · 0 из 2 готовы/);

  // после — готово
  await r.feedTo(BG.events.length);
  runs = runsOfMessages(r.feeds.get(MAIN) ?? [], r.ctx);
  assert.deepEqual(runs.map((x) => x.state), ["done", "done"]);
  assert.equal(summarize(runs).text, "Агенты: 2 готовы");
  assert.equal(preloaderCaption(runs, Date.now()), "", "без активных запусков подпись пустая");
  assert.ok(String(runs[1].output).includes("MAJOR.MINOR.PATCH"), "output semver-агента");
  assert.ok(String(runs[0].output).includes("пуста"), "output агента по файлам");

  // подпись прелоадера со временем — от старта самого раннего активного запуска;
  // история смотрится «как живая»: дети заняты, финального текста в их лентах ещё нет
  const r2 = replay(BG);
  await r2.feedTo(evIdxLast(BG, (e) => e.type === "session.execution.started" && e.data?.sessionID === C2) + 1);
  const hist = BG.history.messages.map((m) => makeMessage(m.info, m.parts));
  const runsHist = runsOfMessages(hist, r2.ctx);
  const t0 = 1794381943617; // time.created первой части
  assert.equal(preloaderCaption(runsHist, t0 + 72_000), "explorer ×2 · 0 из 2 готовы · 1:12");

  // имён больше двух — «и ещё N»
  const four = ["a", "b", "c", "d"].map((agent) => ({ state: "running", agent, startedAt: t0, steps: [] }));
  assert.match(preloaderCaption(four, t0 + 61_000), /^a, b и ещё 2 · /);
});

// ---- (в) Claude: zaiRun в части инструмента ---------------------------------

const CLAUDE_CTX = { childFeed: () => null, busy: () => false, tokensOf: () => null, now: () => 0, engine: "claude" };

test("FEAT-01.77 (в): Claude-запуск строится из part.state.metadata.zaiRun", () => {
  const T0 = 1_700_000_000_000;
  const running = agentRun(
    {
      type: "tool",
      tool: "task",
      callID: "toolu_1",
      state: {
        status: "completed",
        input: { subagent_type: "explorer", description: "Найти файлы", prompt: "…" },
        metadata: {
          zaiRun: {
            status: "running",
            startedAt: T0,
            steps: [
              { id: "s1", kind: "tool", tool: "glob", object: "**/*", status: "done" },
              { id: "s2", kind: "tool", tool: "read", object: "server.js", status: "running" },
            ],
          },
        },
      },
    },
    CLAUDE_CTX,
  );
  assert.equal(running.state, "running");
  assert.equal(running.agent, "explorer");
  assert.equal(running.description, "Найти файлы");
  assert.equal(running.background, false, "TASK-01.81: пилюля «фоном» только у явного фонового запуска (CLI исполняет Agent асинхронно всегда)");
  assert.equal(running.childId, null);
  assert.equal(running.startedAt, T0);
  assert.equal(running.endedAt, null);
  assert.equal(running.steps.length, 2);
  assert.deepEqual(running.now, { verb: "Читает", object: "server.js" });

  const done = agentRun(
    {
      type: "tool",
      tool: "task",
      callID: "toolu_1",
      state: {
        status: "completed",
        input: { subagent_type: "explorer", description: "Найти файлы" },
        metadata: {
          zaiRun: {
            status: "completed",
            startedAt: T0,
            endedAt: T0 + 9000,
            steps: [
              { id: "s1", kind: "tool", tool: "glob", object: "**/*", status: "done" },
              { id: "s2", kind: "tool", tool: "read", object: "server.js", status: "done" },
            ],
            output: "Нашёл 3 файла",
          },
        },
      },
    },
    CLAUDE_CTX,
  );
  assert.equal(done.state, "done");
  assert.equal(done.endedAt, T0 + 9000);
  assert.equal(done.output, "Нашёл 3 файла");
  assert.equal(done.now, null);
  assert.equal(done.tokens, null, "у Claude ленты нет — токенов нет");
});

// ---- (г) ошибка и остановка ---------------------------------------------------

test("FEAT-01.77 (г): ошибка и остановка — свои состояния и причина одной строкой", () => {
  const OC_CTX = { childFeed: () => null, busy: () => false, tokensOf: () => null, now: () => 0, engine: "opencode" };
  // часть инструмента в ошибке
  const failed = agentRun(
    {
      type: "tool",
      tool: "subagent",
      callID: "c9",
      state: { status: "error", input: { agent: "explorer", description: "d" }, error: { name: "ProcessError", data: { message: "агент упал: 429" } } },
    },
    OC_CTX,
  );
  assert.equal(failed.state, "error");
  assert.equal(failed.error, "агент упал: 429");

  // дочерняя сессия прервана — «остановлен», не «готов»
  const stopped = agentRun(
    {
      type: "tool",
      tool: "subagent",
      callID: "c10",
      state: { status: "completed", input: { agent: "explorer", description: "d" }, metadata: { sessionID: "ses_stop", status: "running" } },
    },
    {
      ...OC_CTX,
      childFeed: () => [
        { info: { id: "u1", role: "user" }, parts: [] },
        { info: { id: "a1", role: "assistant" }, parts: [{ id: "t1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a.js" } } }] },
        { info: { id: "zai-end:u1", role: "assistant", error: { name: "MessageAbortedError", data: { message: "interrupted" } } }, parts: [] },
      ],
    },
  );
  assert.equal(stopped.state, "stopped");
  assert.equal(nowLine(stopped), null);

  // ход дочерней сессии упал без ошибки части — ошибка из ленты
  const feedErr = agentRun(
    {
      type: "tool",
      tool: "subagent",
      callID: "c11",
      state: { status: "completed", input: { agent: "explorer", description: "d" }, metadata: { sessionID: "ses_ferr", status: "running" } },
    },
    {
      ...OC_CTX,
      childFeed: () => [{ info: { id: "zai-end:u2", role: "assistant", error: { name: "APIError", data: { message: "429 Too Many Requests" } } }, parts: [] }],
    },
  );
  assert.equal(feedErr.state, "error");
  assert.equal(feedErr.error, "429 Too Many Requests");

  // Claude: status stopped / failed из zaiRun
  const cStop = agentRun(
    { type: "tool", tool: "task", callID: "t9", state: { status: "completed", input: { subagent_type: "fixer" }, metadata: { zaiRun: { status: "stopped", startedAt: 1 } } } },
    CLAUDE_CTX,
  );
  assert.equal(cStop.state, "stopped");
  const cFail = agentRun(
    { type: "tool", tool: "task", callID: "t8", state: { status: "completed", input: { subagent_type: "fixer" }, metadata: { zaiRun: { status: "failed", error: { message: "упал" } } } } },
    CLAUDE_CTX,
  );
  assert.equal(cFail.state, "error");
  assert.equal(cFail.error, "упал");
});

// ---- BUG-229: Claude-запуск без zaiRun --------------------------------------

test("BUG-229: Claude-часть без zaiRun в завершённом ходе — готов (времена из части), в живом хвосте — работает", () => {
  const T0 = 1_700_000_000_000;
  const part = (over = {}) => ({
    type: "tool",
    tool: "task",
    callID: "toolu_l1",
    messageID: "mc_live",
    state: { status: "completed", input: { subagent_type: "explorer", description: "Найти файлы" }, time: { start: T0, end: T0 + 5000 }, ...over },
  });
  const liveCtx = { ...CLAUDE_CTX, liveMessage: (mid) => mid === "mc_live" };
  // живой ход: часть completed, уведомление ещё не доехало — работает
  assert.equal(agentRun(part(), liveCtx).state, "running");
  // завершённый ход: уведомления не будет (история до FEAT-01.77) — готов, времена честные из части
  const done = agentRun(part(), CLAUDE_CTX);
  assert.equal(done.state, "done");
  assert.equal(done.startedAt, T0);
  assert.equal(done.endedAt, T0 + 5000);
  assert.equal(done.now, null);
  // вызов без результата: в завершённом ходе — остановлен, в живом — в очереди
  assert.equal(agentRun(part({ status: "pending", time: { start: T0 } }), CLAUDE_CTX).state, "stopped");
  assert.equal(agentRun(part({ status: "pending", time: { start: T0 } }), liveCtx).state, "queued");
  // zaiRun — источник истины: running в сохранённой истории остаётся работающим
  assert.equal(agentRun(part({ metadata: { zaiRun: { status: "running", startedAt: T0 } } }), CLAUDE_CTX).state, "running");
  // ошибка части — ошибка, где бы ни была
  assert.equal(agentRun(part({ status: "error", error: { data: { message: "429" } } }), CLAUDE_CTX).state, "error");
});

// ---- (д) вложенные запуски и защита от циклов/глубины ------------------------

test("FEAT-01.77 (д): вложенный запуск — depth, защита от цикла и глубины > 5", () => {
  const grand = [
    {
      info: { id: "g1", role: "assistant" },
      parts: [
        // цикл: внук ссылается на childId родителя — не разворачивается второй раз
        { id: "cg", type: "tool", tool: "subagent", callID: "cg", state: { status: "completed", input: { agent: "explorer" }, metadata: { sessionID: "c1" } } },
        { id: "t1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "x.js" } } },
      ],
    },
  ];
  const mid = [
    { info: { id: "m1", role: "assistant" }, parts: [{ id: "cm", type: "tool", tool: "subagent", callID: "cm", state: { status: "completed", input: { agent: "librarian" }, metadata: { sessionID: "c2" } } }] },
  ];
  const ctxN = {
    childFeed: (id) => (id === "c1" ? mid : id === "c2" ? grand : null),
    busy: () => false,
    tokensOf: () => null,
    now: () => 0,
    engine: "opencode",
  };
  const parent = [
    { info: { id: "p1", role: "assistant" }, parts: [{ id: "cp", type: "tool", tool: "subagent", callID: "cp", state: { status: "completed", input: { agent: "explorer" }, metadata: { sessionID: "c1" } } }] },
  ];
  const runs = runsOfMessages(parent, ctxN);
  assert.deepEqual(runs.map((x) => [x.agent, x.depth]), [["explorer", 0], ["librarian", 1], ["explorer", 2]], "вложенные сразу после родителя");
  assert.equal(runs.length, 3, "цикл c1 не разворачивается повторно");

  // глубина больше 5 не разворачивается
  const feeds = {};
  for (let i = 1; i <= 7; i += 1) {
    feeds[`c${i}`] = [
      {
        info: { id: `m${i}`, role: "assistant" },
        parts: [{ id: `t${i}`, type: "tool", tool: "subagent", callID: `t${i}`, state: { status: "completed", input: { agent: "x" }, metadata: { sessionID: `c${i + 1}` } } }],
      },
    ];
  }
  const runsDeep = runsOfMessages(
    [{ info: { id: "p", role: "assistant" }, parts: [{ id: "tp", type: "tool", tool: "subagent", callID: "tp", state: { status: "completed", input: { agent: "x" }, metadata: { sessionID: "c1" } } }] }],
    { ...ctxN, childFeed: (id) => feeds[id] ?? null },
  );
  assert.equal(runsDeep.length, 6, "depth 0..5, глубже — стоп");
  assert.equal(Math.max(...runsDeep.map((x) => x.depth)), 5);
});

// ---- legacy 1.x и глаголы/числа ----------------------------------------------

test("FEAT-01.77: поля opencode 1.x (task, subagent_type, run_in_background, sessionId)", () => {
  const run = agentRun(
    {
      type: "tool",
      tool: "task",
      callID: "c1x",
      state: {
        status: "completed",
        input: { subagent_type: "fixer", description: "Тесты", run_in_background: true },
        metadata: { sessionId: "ses_1x", agent: "fixer" },
        time: { start: 1000, end: 6000 },
      },
    },
    {
      childFeed: (id) => (id === "ses_1x" ? [{ info: { id: "a", role: "assistant" }, parts: [{ id: "tx", type: "text", text: "Готово" }] }] : null),
      busy: () => false,
      tokensOf: () => null,
      now: () => 0,
      engine: "opencode",
    },
  );
  assert.equal(run.agent, "fixer", "metadata.agent сильнее input");
  assert.equal(run.childId, "ses_1x");
  assert.equal(run.background, true, "run_in_background: true");
  assert.equal(run.state, "done");
});

test("FEAT-01.77: глаголы, сводка и длительность по брифу", () => {
  assert.deepEqual(stepLabel({ tool: "read", status: "running", object: "a.js" }), { verb: "Читает", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "read", status: "done", object: "a.js" }), { verb: "Прочитал", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "glob", status: "running", object: "**/*" }), { verb: "Смотрит файлы", object: "**/*" });
  assert.deepEqual(stepLabel({ tool: "grep", status: "done", object: "x" }), { verb: "Поиск", object: "x" });
  assert.deepEqual(stepLabel({ tool: "webfetch", status: "running", object: "http…" }), { verb: "Ищет в сети", object: "http…" });
  assert.deepEqual(stepLabel({ tool: "bash", status: "running", object: "ls" }), { verb: "Запускает команду", object: "ls" });
  assert.deepEqual(stepLabel({ tool: "shell", status: "done", object: "ls" }), { verb: "Команда", object: "ls" });
  assert.deepEqual(stepLabel({ tool: "edit", status: "running", object: "a.js" }), { verb: "Правит файл", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "write", status: "done", object: "b.js" }), { verb: "Записал", object: "b.js" });
  assert.deepEqual(stepLabel({ kind: "agent", tool: "subagent", object: "fixer" }), { verb: "Запустил агента", object: "fixer" });
  assert.deepEqual(stepLabel({ kind: "reasoning" }), { verb: "Думает", object: "" });
  assert.deepEqual(stepLabel({ kind: "text" }), { verb: "Пишет ответ", object: "" });
  assert.deepEqual(stepLabel({ tool: "mytool", status: "done", object: "" }), { verb: "mytool", object: "" });

  assert.deepEqual(nowLine({ state: "running", steps: [] }), { verb: "Думает", object: "" });
  assert.equal(nowLine({ state: "queued", steps: [] }), null);

  assert.equal(fmtDuration(42_000), "0:42");
  assert.equal(fmtDuration(68_000), "1:08");
  assert.equal(fmtDuration(3_723_000), "1:02:03");

  const R = (state, agent = "explorer") => ({ state, agent, steps: [], startedAt: null });
  assert.equal(summarize([]).text, "");
  assert.equal(summarize([R("running")]).text, "Агенты: 1 работает");
  assert.equal(summarize([R("running"), R("running", "fixer"), R("queued", "librarian")]).text, "Агенты: 2 работают · 1 в очереди");
  assert.equal(summarize([R("done"), R("done", "fixer"), R("error", "librarian")]).text, "Агенты: 2 готовы · 1 с ошибкой");
  assert.equal(summarize([R("stopped")]).text, "Агенты: 1 остановлен");
  const s = summarize([R("done"), R("running")]);
  assert.deepEqual({ ...s, text: undefined }, { running: 1, queued: 0, done: 1, error: 0, stopped: 0, total: 2, text: undefined });
});

test("FEAT-01.77: у пути в шаге показывается хвост — имя файла видно в одну строку", async () => {
  const { pathTail } = await import("../src/lib/subagents.js");
  assert.equal(pathTail("D:\\zai-stage\\tmp\\sa-x\\a.txt"), "…\\sa-x\\a.txt");
  assert.equal(pathTail("/srv/zai/home/a/b.txt"), "…/a/b.txt");
  assert.equal(pathTail("a.txt"), "a.txt");
});

test("FEAT-01.77: длительность фонового запуска — до конца работы дочерней сессии, а не до момента запуска", async () => {
  const { agentRun } = await import("../src/lib/subagents.js");
  const part = { id: "call_bg", callID: "call_bg", type: "tool", tool: "subagent", time: { created: 1000, ran: 1100, completed: 1200 },
    state: { status: "completed", input: { agent: "explorer", background: true, description: "задача" }, metadata: { sessionID: "ses_child", status: "running" } } };
  const feed = [{ info: { id: "a1", role: "assistant", time: { created: 1300, completed: 21000 } }, parts: [{ id: "t1", type: "text", text: "готово" }] }];
  const ctx = { childFeed: () => feed, busy: () => false, tokensOf: () => null, now: () => 30000, engine: "opencode" };
  const run = agentRun(part, ctx);
  assert.equal(run.state, "done");
  assert.equal(run.endedAt, 21000, "конец — по ответу дочерней сессии");
  // без ленты у фонового запуска конец неизвестен: время части (момент запуска) не подставляется
  const noFeed = agentRun(part, { ...ctx, childFeed: () => null });
  assert.notEqual(noFeed.endedAt, 1200);
});

test("FEAT-01.77: вызов, оборванный «Стоп» (ошибка «Subagent cancelled»), — состояние «остановлен», а не «ошибка»", async () => {
  const { agentRun } = await import("../src/lib/subagents.js");
  const ctx = { childFeed: () => null, busy: () => false, tokensOf: () => null, now: () => 5000, engine: "opencode" };
  const mk = (error) => ({ id: "c1", callID: "c1", type: "tool", tool: "subagent", time: { created: 1000 }, state: { status: "error", input: { agent: "explorer", description: "задача" }, metadata: { sessionID: "ses_k" }, error } });
  assert.equal(agentRun(mk("Subagent cancelled (sessionID: ses_k)"), ctx).state, "stopped");
  assert.equal(agentRun(mk({ name: "MessageAbortedError", data: { message: "aborted" } }), ctx).state, "stopped");
  assert.equal(agentRun(mk("command npm test is denied"), ctx).state, "error");
});

// ---- TASK-01.79: шаги по макету, note, группировка, чистка ответа, задача -----

test("TASK-01.79: подписи шагов по брифу — список файлов, поиск, правка, запись, сеть", () => {
  assert.deepEqual(stepLabel({ tool: "glob", status: "done", object: "**/*" }), { verb: "Список файлов", object: "**/*" });
  assert.deepEqual(stepLabel({ tool: "list", status: "done", object: "src" }), { verb: "Список файлов", object: "src" });
  assert.deepEqual(stepLabel({ tool: "ls", status: "done", object: "src" }), { verb: "Список файлов", object: "src" });
  assert.deepEqual(stepLabel({ tool: "ls", status: "running", object: "src" }), { verb: "Смотрит файлы", object: "src" });
  assert.deepEqual(stepLabel({ tool: "list", status: "running", object: "src" }), { verb: "Смотрит файлы", object: "src" });
  assert.deepEqual(stepLabel({ tool: "grep", status: "running", object: "x" }), { verb: "Ищет", object: "x" });
  assert.deepEqual(stepLabel({ tool: "read", status: "done", object: "a.js" }), { verb: "Прочитал", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "read", status: "running", object: "a.js" }), { verb: "Читает", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "bash", status: "running", object: "ls" }), { verb: "Запускает команду", object: "ls" });
  assert.deepEqual(stepLabel({ tool: "shell", status: "done", object: "ls" }), { verb: "Команда", object: "ls" });
  assert.deepEqual(stepLabel({ tool: "edit", status: "done", object: "a.js" }), { verb: "Правка", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "edit", status: "running", object: "a.js" }), { verb: "Правит файл", object: "a.js" });
  assert.deepEqual(stepLabel({ tool: "write", status: "done", object: "b.js" }), { verb: "Записал", object: "b.js" });
  assert.deepEqual(stepLabel({ tool: "write", status: "running", object: "b.js" }), { verb: "Пишет файл", object: "b.js" });
  assert.deepEqual(stepLabel({ tool: "websearch", status: "done", object: "q" }), { verb: "Поиск в сети", object: "q" });
  assert.deepEqual(stepLabel({ tool: "webfetch", status: "running", object: "http…" }), { verb: "Ищет в сети", object: "http…" });
  assert.deepEqual(stepLabel({ tool: "webfetch", status: "done", object: "http…" }), { verb: "Поиск в сети", object: "http…" });
  assert.deepEqual(stepLabel({ kind: "agent", tool: "subagent", object: "fixer" }), { verb: "Запустил агента", object: "fixer" }, "остальное как сейчас");
});

test("TASK-01.79: note шага — короткий итог из metadata.count/matches дочерней ленты (русские формы)", () => {
  const partOf = (tool, meta, input) => ({ id: "t1", type: "tool", tool, callID: "t1", state: { status: "completed", input, ...(meta ? { metadata: meta } : {}) } });
  const runOf = (toolPart) =>
    agentRun(
      { type: "tool", tool: "subagent", callID: "c1", state: { status: "completed", input: { agent: "explorer", description: "d" }, metadata: { sessionID: "ses_note", status: "completed" } } },
      {
        childFeed: () => [{ info: { id: "a1", role: "assistant" }, parts: [toolPart] }],
        busy: () => false,
        tokensOf: () => null,
        now: () => 0,
        engine: "opencode",
      },
    );
  assert.equal(runOf(partOf("glob", { count: 214, truncated: false }, { pattern: "**/*" })).steps[0].note, "214 файлов");
  assert.equal(runOf(partOf("glob", { count: 1 }, { pattern: "**/*" })).steps[0].note, "1 файл");
  assert.equal(runOf(partOf("glob", { count: 2 }, { pattern: "**/*" })).steps[0].note, "2 файла");
  assert.equal(runOf(partOf("glob", { count: 0, truncated: false }, { pattern: "**/*" })).steps[0].note, "0 файлов");
  assert.equal(runOf(partOf("grep", { matches: 3 }, { pattern: "x" })).steps[0].note, "3 совпадения");
  assert.equal(runOf(partOf("grep", { matches: 1 }, { pattern: "x" })).steps[0].note, "1 совпадение");
  assert.equal(runOf(partOf("grep", { matches: 5 }, { pattern: "x" })).steps[0].note, "5 совпадений");
  // нет данных — нет note; у инструментов вне списка/поиска note нет
  assert.equal(runOf(partOf("glob", { truncated: false }, { pattern: "**/*" })).steps[0].note, null);
  assert.equal(runOf(partOf("read", { count: 5 }, { filePath: "a.js" })).steps[0].note, null);
  assert.equal(runOf(partOf("bash", {}, { command: "ls" })).steps[0].note, null);
});

test("TASK-01.79: groupSteps — подряд завершённые одного инструмента в группу; работающий и ошибка отдельно", () => {
  const s = (id, tool, status = "done", object = "") => ({ id, kind: "tool", tool, object, status });
  // пять чтений подряд → одна группа с count: 5
  const five = ["a.js", "b.js", "c.js", "d.js", "e.js"].map((o, i) => s(`r${i}`, "read", "done", `…\\dir\\${o}`));
  const g = groupSteps(five);
  assert.equal(g.length, 1, "пять подряд — одна группа");
  assert.equal(g[0].count, 5);
  assert.equal(g[0].tool, "read");
  assert.equal(g[0].kind, "tool");
  assert.equal(g[0].status, "done");
  assert.deepEqual(g[0].objects, ["a.js", "b.js", "c.js", "d.js", "e.js"], "в группе — только имена файлов");
  // одиночный шаг хранит полный хвост объекта
  const one = groupSteps([s("1", "read", "done", "…\\dir\\a.js")]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].objects, ["…\\dir\\a.js"], "в одиночной строке полный хвост");
  // работающий шаг и шаг с ошибкой — всегда отдельной строкой
  const mix = groupSteps([s("1", "read"), s("2", "read", "running"), s("3", "read", "error"), s("4", "read")]);
  assert.equal(mix.length, 4);
  assert.equal(mix[1].status, "running");
  assert.equal(mix[2].status, "error");
  assert.equal(mix[3].count, 1, "после разрыва группа начинается заново");
  // разные инструменты не смешиваются
  assert.equal(groupSteps([s("1", "read"), s("2", "glob"), s("3", "read")]).length, 3);
  // note группы — от первого шага с note
  const withNote = [s("1", "glob", "done", "**/*"), s("2", "glob", "done", "src")];
  withNote[0].note = "214 файлов";
  assert.equal(groupSteps(withNote)[0].note, "214 файлов");
});

test("TASK-01.79: cleanAgentOutput — <answer>, обёртки results/files, markdown не трогается", () => {
  assert.equal(cleanAgentOutput("начало\n<answer>\n**Ответ**\n- пункт\n</answer>\nконец"), "**Ответ**\n- пункт", "есть answer — берётся содержимое");
  assert.equal(cleanAgentOutput("<results>\n<files>\n- a.txt\n- b.txt\n</files>\n</results>"), "- a.txt\n- b.txt", "обёртки-строки убраны, содержимое осталось");
  assert.equal(cleanAgentOutput("# Заголовок\n\n**жирный** и `код`\n"), "# Заголовок\n\n**жирный** и `код`", "обычный markdown без изменений");
  assert.equal(cleanAgentOutput("<subagent sessionID=\"ses_x\" state=\"completed\">\n<results>\n<files></files>\n<answer>\nкаталог пуст\n</answer>\n</results>\n</subagent>"), "каталог пуст", "живая форма вывода субагента");
  assert.equal(cleanAgentOutput(""), "");
  assert.equal(cleanAgentOutput(null), "");
});

test("TASK-01.79: у шагов Claude с путём — хвост пути (BUG-227), команда и шаблон не трогаются", () => {
  const z = (steps) =>
    agentRun(
      { type: "tool", tool: "task", callID: "t1", state: { status: "completed", input: { subagent_type: "explorer", description: "d" }, metadata: { zaiRun: { status: "completed", startedAt: 1, endedAt: 2, steps, output: "ok" } } } },
      CLAUDE_CTX,
    );
  const run = z([
    { id: "s1", kind: "tool", tool: "read", object: "C:\\Users\\USER\\zai-qa-tmp\\claude-subagent-rec\\a.txt", status: "done" },
    { id: "s2", kind: "tool", tool: "bash", object: "Get-ChildItem -Force C:\\tmp", status: "done" },
    { id: "s3", kind: "tool", tool: "glob", object: "**/*", status: "done" },
    { id: "s4", kind: "tool", tool: "grep", object: "src/lib/auth.ts", status: "done" },
  ]);
  assert.equal(run.steps[0].object, "…\\claude-subagent-rec\\a.txt", "путь — хвост");
  assert.equal(run.steps[1].object, "Get-ChildItem -Force C:\\tmp", "команда с пробелом — не путь");
  assert.equal(run.steps[2].object, "**/*", "шаблон — не путь");
  assert.equal(run.steps[3].object, "…/lib/auth.ts", "путь со слешами — хвост");
  assert.equal(pathTail("D:\\zai-stage\\tmp\\sa-x\\a.txt"), "…\\sa-x\\a.txt", "pathTail как был");
});

test("TASK-01.79: задача без служебной заглушки — title части только неслужебный, иначе input.description", () => {
  const OC_CTX5 = { childFeed: () => null, busy: () => false, tokensOf: () => null, now: () => 0, engine: "opencode" };
  const part = (title, description) => ({
    type: "tool",
    tool: "subagent",
    callID: "c1",
    state: { status: "completed", input: { agent: "explorer", ...(description != null ? { description } : {}) }, ...(title != null ? { title } : {}) },
  });
  assert.equal(agentRun(part("Задача агенту", "Реальная задача"), OC_CTX5).description, "Реальная задача", "заглушка заменена описанием");
  assert.equal(agentRun(part("task", "Реальная задача"), OC_CTX5).description, "Реальная задача");
  assert.equal(agentRun(part("agent", "d"), OC_CTX5).description, "d");
  assert.equal(agentRun(part("subagent", "d"), OC_CTX5).description, "d");
  assert.equal(agentRun(part("Задача агенту", ""), OC_CTX5).description, "", "нет данных — пустая строка, не заглушка");
  assert.equal(agentRun(part("Структура каталогов", "d"), OC_CTX5).description, "Структура каталогов", "неслужебный title используется");
  assert.equal(agentRun(part(null, "Из описания"), OC_CTX5).description, "Из описания");
});
