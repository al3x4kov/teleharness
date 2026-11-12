// BUG-214 (SRV-04/SRV-10/SRV-33/SRV-34): устойчивость потока событий v2.
// 1) Пауза переподключения сбрасывается соединением, прожившим stableMs.
// 2) Буфер кадра без разделителя больше 8 МБ рвёт соединение, цикл живёт.
// 3) Терминальное событие хода чистит карты переписывателя; knownDir — по
//    session.deleted и потолком 5000.
// Всё на фейковом fetchImpl с телом-ReadableStream (кадры «data: …\n\n») и
// прямых вызовах createV2Rewriter — без сокетов и sleeps по возможности.
// Run: node --test --test-timeout=60000 tests/oc-client-stream.test.js
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createOcClient, createV2Rewriter } from "../lib/oc-client.js";

const DIR = "C:\\Users\\USER\\.zai-tenants\\alice";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}
const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;

// Тело-поток с собственным сценарием: индекс соединения решает, что отдать.
function bodyFor(idx, calls, scenario) {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        await scenario(idx, controller, enc);
      } catch { /* цикл ушёл в реконнект — поток бросаем */ }
    },
    cancel() {
      calls[idx].dropped = true;
      if (!calls[idx].end) calls[idx].end = Date.now();
    },
  });
}

// ---- 1) сброс паузы после устойчивого соединения -----------------------------

test("BUG-214: соединение дольше stableMs сбрасывает паузу переподключения до backoffMs[0]; zai.resync как раньше", async () => {
  const backoff = [40, 200, 900];
  const calls = [];
  const fetchImpl = async () => {
    const idx = calls.length;
    calls.push({ start: Date.now(), end: 0, dropped: false });
    return {
      ok: true,
      body: bodyFor(idx, calls, async (i, controller, enc) => {
        if (i < 5) {
          // пять коротких обрывов: кадр — и сразу конец
          controller.enqueue(enc.encode(frame({ type: "ping", data: { n: i } })));
          calls[i].end = Date.now();
          controller.close();
        } else if (i === 5) {
          // устойчивое соединение: живёт дольше stableMs (20 мс)
          controller.enqueue(enc.encode(frame({ type: "ping", data: { n: i } })));
          await sleep(60);
          controller.enqueue(enc.encode(frame({ type: "ping", data: { n: i, tail: true } })));
          calls[i].end = Date.now();
          controller.close();
        } else {
          calls[i].end = Date.now();
          controller.close();
        }
      }),
    };
  };
  const c = createOcClient({ api: "v2", base: "http://127.0.0.1:9", password: "p", fetchImpl });
  const got = [];
  const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: backoff, stableMs: 20 });
  try {
    assert.ok(await waitUntil(() => calls.length >= 7, 8000), "7 соединений: 5 обрывов + устойчивое + реконнект");
    const pause = calls[6].start - calls[5].end;
    assert.ok(pause < 300, `пауза после устойчивого соединения = ${pause} мс, ждём backoffMs[0]=${backoff[0]}`);
    assert.equal(got.filter((e) => e.type === "zai.resync").length, 6, "zai.resync на каждом переподключении, как раньше");
    assert.ok(got.some((e) => e.type === "ping" && e.properties?.n === 5 && e.properties?.tail), "устойчивое соединение доставило кадры");
  } finally {
    stop.close();
  }
});

// ---- 2) потолок буфера кадра ---------------------------------------------------

test("BUG-214: кадр без разделителя больше 8 МБ рвёт соединение с записью в лог, цикл живёт", async () => {
  const calls = [];
  const got = [];
  const logMock = mock.method(console, "log", (...a) => {});
  const fetchImpl = async () => {
    const idx = calls.length;
    calls.push({ start: Date.now(), end: 0, dropped: false });
    return {
      ok: true,
      body: bodyFor(idx, calls, async (i, controller, enc) => {
        if (i === 0) {
          controller.enqueue(enc.encode("x".repeat(9 * 1024 * 1024))); // > 8 МБ без "\n\n"
          await sleep(30_000); // соединение «висит», кадр не кончается
        } else {
          controller.enqueue(enc.encode(frame({ type: "ping", data: { ok: true } })));
          controller.close();
        }
      }),
    };
  };
  const c = createOcClient({ api: "v2", base: "http://127.0.0.1:9", password: "p", fetchImpl });
  const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
  try {
    assert.ok(await waitUntil(() => got.some((e) => e.type === "ping"), 3000), "цикл жив: реконнект доставил кадр");
    assert.ok(calls.length >= 2, "соединение разорвано и переподключено");
    assert.equal(calls[0].dropped, true, "залипший поток отменён");
    assert.equal(got.some((e) => e.properties?.big || e.big), false, "гигантский кадр не ушёл в onEvent");
    logMock.mock.restore();
    assert.ok(String(logMock.mock.calls.map((c2) => c2.arguments.join(" "))).includes("BUG-214"), "в логе запись о переполнении");
  } finally {
    if (!logMock.mock.restored) logMock.mock.restore();
    stop.close();
  }
});

// ---- 3) чистка карт переписывателя ---------------------------------------------

test("BUG-214: терминальное событие хода чистит text/tool/pending этой сессии; чужая не задета", () => {
  const emitted = [];
  const rw = createV2Rewriter({ emit: (e) => emitted.push(e), throttleMs: 5 });
  const textDelta = (sid, m, delta) => ({
    type: "session.text.delta",
    location: { directory: DIR },
    data: { sessionID: sid, assistantMessageID: m, ordinal: 0, delta },
  });

  rw(textDelta("s1", "m1", "х"));
  rw({ type: "session.tool.called", location: { directory: DIR }, data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash", input: { command: "ls" } } });
  assert.deepEqual(rw._sizes(), { text: 1, tool: 1, knownDir: 1, pending: 1, turnUser: 0 }, "ход в работе: всё накапливается");
  rw({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
  assert.deepEqual(rw._sizes(), { text: 0, tool: 0, knownDir: 1, pending: 0, turnUser: 0 }, "ход закрыт — части чисты, папка осталась");
  assert.equal(emitted.at(-1)?.type, "message.part.updated", "отложенная часть сброшена (flush) ДО чистки");

  // execution.failed тоже терминальное (в т.ч. прерывание «Стоп»)
  rw(textDelta("s2", "m2", "у"));
  rw({ type: "session.execution.failed", data: { sessionID: "s2", error: { type: "aborted", message: "стоп" } } });
  assert.deepEqual(rw._sizes(), { text: 0, tool: 0, knownDir: 2, pending: 0, turnUser: 0 }, "failed — чистка как у успеха");

  // терминальное событие ЧУЖОЙ сессии ничего лишнего не удаляет
  rw(textDelta("s3", "m3", "з"));
  rw({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
  assert.deepEqual(rw._sizes(), { text: 1, tool: 0, knownDir: 3, pending: 1, turnUser: 0 }, "чужой ход не тронут");

  // session.deleted: конец сессии — чистится и папка
  rw({ type: "session.deleted", data: { id: "s3", sessionID: "s3" } });
  assert.deepEqual(rw._sizes(), { text: 0, tool: 0, knownDir: 2, pending: 0, turnUser: 0 }, "deleted чистит и части, и папку");
});

test("BUG-214: 1000 ходов подряд — карты переписывателя не растут линейно", () => {
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 1 });
  for (let t = 0; t < 1000; t += 1) {
    const d = { sessionID: `ses_${t}`, assistantMessageID: `m_${t}`, ordinal: 0 };
    rw({ type: "session.text.delta", location: { directory: DIR }, data: { ...d, delta: "x" } });
    rw({ type: "session.tool.called", data: { ...d, id: `c_${t}`, name: "bash", input: {} } });
    rw({ type: "session.execution.succeeded", data: { sessionID: `ses_${t}` } });
  }
  const s = rw._sizes();
  assert.equal(s.text, 0, "text чист после каждого хода");
  assert.equal(s.tool, 0, "tool чист после каждого хода");
  assert.equal(s.pending, 0, "pending чист после каждого хода");
  assert.ok(s.knownDir <= 5000, `knownDir ограничена потолком (${s.knownDir})`);
});

test("BUG-214: knownDir держит потолок 5000 — при переполнении вытесняется самая старая запись", () => {
  const rw = createV2Rewriter({ emit: () => {} });
  for (let i = 0; i < 5010; i += 1) {
    rw({ type: "session.idle", location: { directory: "C:/x" }, data: { sessionID: `s${i}` } });
  }
  assert.equal(rw._sizes().knownDir, 5000, "потолок не превышен");
  assert.equal(rw._sizes().pending, 0);
});
