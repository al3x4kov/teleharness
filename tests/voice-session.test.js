// TASK-14.17 (QA-06): unit-тесты автомата createVoiceSession (src/lib/voice-session.js).
// Прогон: node --test tests/voice-session.test.js
//
// Клиентский код в Node: браузерные API подменяются на globalThis (navigator,
// SpeechRecognition, speechSynthesis), сеть — фейковый fetch, реального
// микрофона и сети нет. Хранилище (store) — настоящее: send/stop/voiceApi
// ходят через подменённый fetch, лента кормится через signal active.
// src/ не правится: вскрытые дефекты оформлены todo-тестами (рядом — тест,
// фиксирующий фактическое поведение).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { active, sessions } from "../src/lib/store.js";
import { createVoiceSession } from "../src/lib/voice-session.js";
import { VOICE_ERRORS } from "../src/lib/voice-machine.js";
import { VOICE_HINT } from "../src/lib/voice-text.js";

const SID = "ses_voice";
const INFO_SERVER = { enabled: true, ready: true, stt: true, voices: [{ id: "irina", name: "Ирина" }], defaultVoice: "irina" };
const INFO_NO_STT = { enabled: true, ready: true, stt: false, voices: [], defaultVoice: "irina" };

// ---- подмена globalThis (восстановление LIFO в afterEach) --------------------
const stash = [];
function setG(key, value) {
  stash.push([key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null]);
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
function restoreGlobals() {
  while (stash.length) {
    const [k, d] = stash.pop();
    if (d) Object.defineProperty(globalThis, k, d);
    else delete globalThis[k];
  }
}

// ---- фейковый fetch: маршруты → Response, журнал вызовов ---------------------
// Спецответы: "hang" — никогда не отвечает; "network" — обрыв; {status, body, raw}.
function installFetch(extra = []) {
  const calls = [];
  const BASE = [
    { method: "POST", path: /^\/zai\/api\/session\/.+\/prompt$/, reply: () => ({ status: 204, body: null }) },
    { method: "POST", path: /^\/zai\/api\/session\/.+\/abort$/, reply: () => ({ status: 204, body: null }) },
    { method: "GET", path: /^\/zai\/api\/session\/.+\/message$/, reply: () => ({ list: [], hasMore: false, nextBefore: null }) },
    { method: "POST", path: "/zai/api/voice/stt", reply: () => ({ text: "привет как дела" }) },
    { method: "POST", path: "/zai/api/voice/tts", reply: () => ({ status: 200, body: new ArrayBuffer(64), raw: true }) },
  ];
  setG("fetch", async (input, init = {}) => {
    const u = new URL(String(input), "https://zai.test");
    const method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    calls.push({ method, path: u.pathname, body });
    const r = [...extra, ...BASE].find((x) => (!x.method || x.method === method) && (x.path instanceof RegExp ? x.path.test(u.pathname) : x.path === u.pathname));
    if (!r) return new Response(JSON.stringify({ error: "no route", path: u.pathname }), { status: 404, headers: { "content-type": "application/json" } });
    if (r.reply === "hang") return new Promise(() => {});
    if (r.reply === "network") throw new TypeError("fetch failed");
    const out = typeof r.reply === "function" ? r.reply() : r.reply;
    if (out && typeof out === "object" && "status" in out) {
      const payload = out.raw ? out.body : out.body == null ? null : JSON.stringify(out.body);
      return new Response(payload, { status: out.status, headers: { "content-type": out.raw ? "application/octet-stream" : "application/json" } });
    }
    return new Response(JSON.stringify(out ?? null), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

// ---- фейковые браузерные API --------------------------------------------------
// Аудио-граф: nodes.script — ScriptProcessor (кадры микрофона), nodes.sources —
// BufferSource-ы плеера (onended триггерит тест вручную — детерминированно).
function makeCtx() {
  const ctx = {
    state: "running",
    sampleRate: 48000,
    suspended: false,
    stopped: 0,
    nodes: { script: [], sources: [] },
    destination: {},
    resume: async () => {
      ctx.state = "running";
    },
    suspend: async () => {
      ctx.suspended = true;
    },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({
      fftSize: 0,
      connect() {},
      getFloatTimeDomainData: (buf) => buf.fill(0),
    }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const node = { onaudioprocess: null, connect() {}, disconnect() {} };
      ctx.nodes.script.push(node);
      return node;
    },
    createBufferSource: () => {
      const node = { buffer: null, onended: null, connect() {}, start() { ctx.nodes.sources.push(node); }, stop() { ctx.stopped += 1; node.onended?.call(node); } };
      return node;
    },
    decodeAudioData: (bytes, ok) => ok({ bytes }),
  };
  return ctx;
}

function makeStream() {
  const tracks = [{ enabled: true, stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getAudioTracks: () => tracks, getTracks: () => tracks };
}

function setMic(stream) {
  setG("navigator", { userAgent: "Node.js/24", mediaDevices: { getUserMedia: async () => stream } });
}
const micDenied = () =>
  setG("navigator", {
    userAgent: "Node.js/24",
    mediaDevices: {
      getUserMedia: async () => {
        const e = new Error("denied");
        e.name = "NotAllowedError";
        throw e;
      },
    },
  });

class FakeRecognition {
  static last = null;
  constructor() {
    this.started = 0;
    this.abortedCount = 0;
    FakeRecognition.last = this;
  }
  start() {
    this.started += 1;
  }
  abort() {
    this.abortedCount += 1;
    this.onend?.();
  }
}

// ---- драйверы -----------------------------------------------------------------
// Микрозадачи магазина/очереди выравниваем реальными setImmediate (мок-таймеры
// их не трогают) — детерминированно, без sleep.
const drain = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
const loudChunk = () => Float32Array.from({ length: 4096 }, () => 0.4);
const silentChunk = () => new Float32Array(4096);
function pushChunks(ctx, chunks) {
  for (const node of ctx.nodes.script) for (const c of chunks) node.onaudioprocess?.({ inputBuffer: { getChannelData: () => c } });
}
// Громкие кадры (сегмент на распознавание) + тишина > pauseMs (конец высказывания).
async function driveUtterance(ctx) {
  pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk()]);
  await drain();
  pushChunks(ctx, Array.from({ length: 18 }, silentChunk));
  await drain();
}
// Только до среза сегмента (350 мс тишины при ≥200 мс голоса): хватает, чтобы
// /voice/stt был вызван, без конца высказывания.
async function driveSegment(ctx) {
  pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk(), ...Array.from({ length: 6 }, silentChunk)]);
  await drain();
}

// ---- сессия --------------------------------------------------------------------
const opened = [];
function openSession(opts = {}) {
  const snapshots = [];
  const session = createVoiceSession({
    sessionId: SID,
    ctx: opts.ctx ?? null,
    prefs: { voice: "irina", rate: 1, pauseMs: 1200, shortAnswers: true, ...(opts.prefs ?? {}) },
    info: "info" in opts ? opts.info : INFO_SERVER,
    onChange: (s) => snapshots.push(s),
  });
  opened.push(session);
  return { session, snapshots };
}
// Последовательность фаз без повторов (emit бывает по несколько раз на фазу).
const uniqPhases = (snaps) => snaps.map((s) => s.phase).filter((p, i, a) => i === 0 || p !== a[i - 1]);

const BOUND = { id: SID, title: "Голос", directory: "C:\\Home", zai: { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "build", prompted: true } };
const userMsg = { info: { id: "u1", role: "user", sessionID: SID, time: { created: 1 } }, parts: [{ id: "p_u1", type: "text", text: "Какая столица Франции?" }] };
const assistantMsg = (text) => ({ info: { id: "a1", role: "assistant", sessionID: SID, time: { created: 2 } }, parts: [{ id: "p_a1", type: "text", text }] });
const setActiveIdle = (messages, extra = {}) => {
  active.value = { id: SID, status: "idle", messages, ...extra };
};
// Помощник для тестов закрытия: после close — ни запросов, ни onChange, ни таймеров.
async function assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream, rec }) {
  const nCalls = calls.length;
  const nSnaps = snapshots.length;
  t.mock.timers.tick(60000); // уцелевший таймер выстрелил бы здесь
  active.value = { id: "ses_other", status: "busy", messages: [] }; // подписка watch снята
  await drain();
  assert.equal(calls.length, nCalls, "после close нет новых сетевых вызовов");
  assert.equal(snapshots.length, nSnaps, "onChange молчит после close");
  assert.equal(snapshots.at(-1)?.phase, "closed", "финальный снапшот — closed");
  if (ctx) assert.ok(ctx.suspended, "ctx.suspend вызван");
  if (stream) assert.ok(stream.tracks.every((tr) => tr.stopped), "треки микрофона остановлены");
  if (rec) assert.ok(rec.abortedCount >= 1, "browser-распознаватель прерван");
}

beforeEach(() => {
  active.value = null;
  sessions.value = [];
});
afterEach(() => {
  while (opened.length) {
    try {
      opened.pop().close();
    } catch {}
  }
  active.value = null;
  sessions.value = [];
  restoreGlobals();
});

// ---- старт и ошибки микрофона ----------------------------------------------------

test("старт серверного режима: listening, микрофон включён, ttsMode/voiceId/level", async () => {
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  assert.deepEqual(uniqPhases(snapshots), ["listening"], "первый onChange — listening");
  assert.equal(snapshots[0].state, "listening");
  assert.equal(session.voiceId, "irina");
  assert.equal(session.ttsMode, "server");
  assert.equal(session.level("listen"), 0, "анализатор с нулями");
  assert.equal(session.level("speak"), 0, "плеер есть, ничего не играет");
  assert.equal(session.level("mute"), 0);
  assert.equal(session.level("error"), 0);
  assert.equal(session.level("think"), null, "прочие состояния — null");
  assert.equal(stream.tracks[0].enabled, true, "capture.setEnabled(!muted)");
});

test("нет getUserMedia → error «Микрофон недоступен» (nomic)", async () => {
  setG("navigator", { userAgent: "Node.js/24" }); // без mediaDevices
  installFetch();
  const { snapshots } = openSession({ ctx: makeCtx() });
  await drain();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].phase, "error");
  assert.equal(snapshots[1].error.kind, "nomic");
  assert.equal(snapshots[1].error.title, VOICE_ERRORS.nomic.title);
});

test("getUserMedia отказ (NotAllowedError) → error mic с подсказкой про настройки", async () => {
  micDenied();
  installFetch();
  const { snapshots } = openSession({ ctx: makeCtx() });
  await drain();
  assert.equal(snapshots[1].phase, "error");
  assert.equal(snapshots[1].error.kind, "mic");
  assert.match(snapshots[1].error.text, /Разрешите микрофон для сайта в настройках браузера/);
});

test("micText: в Safari — короткая подсказка про Настройки → Safari → Микрофон", async () => {
  setG("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    mediaDevices: {
      getUserMedia: async () => {
        const e = new Error("denied");
        e.name = "NotAllowedError";
        throw e;
      },
    },
  });
  installFetch();
  const { snapshots } = openSession({ ctx: makeCtx() });
  await drain();
  assert.equal(snapshots[1].error.kind, "mic");
  assert.equal(snapshots[1].error.text, VOICE_ERRORS.mic.text);
});

test("STT недоступен нигде (info.stt:false, нет SpeechRecognition) → error stt после захвата", async () => {
  setMic(makeStream());
  installFetch();
  const { snapshots } = openSession({ ctx: makeCtx(), info: INFO_NO_STT });
  await drain();
  assert.equal(snapshots[1].phase, "error");
  assert.equal(snapshots[1].error.kind, "stt");
  assert.equal(snapshots[1].error.title, VOICE_ERRORS.stt.title);
});

// ---- руки-свободны: полный цикл --------------------------------------------------

test("полный цикл: utterance → sending → thinking → speaking → listening; hint в prompt; tts с голосом", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  assert.equal(snapshots.at(-1).phase, "thinking", "prompt принят → думает");
  assert.equal(snapshots.filter((s) => s.phase === "sending").at(-1)?.heard, "Привет как дела", "услышанное от STT");
  const prompt = calls.find((c) => c.path.endsWith("/prompt"));
  assert.equal(prompt.body.parts[0].text, "Привет как дела");
  assert.equal(prompt.body.parts[1].text, VOICE_HINT, "скрытая подсказка идёт вторым part");
  assert.equal(prompt.body.parts[1].synthetic, true);
  setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж.")]);
  await drain();
  assert.equal(snapshots.at(-1).phase, "speaking", "фраза играет, пока тест не завершит её");
  ctx.nodes.sources[0].onended(); // конец озвучки
  await drain();
  assert.deepEqual(uniqPhases(snapshots), ["listening", "sending", "thinking", "speaking", "listening"], "весь цикл автомата");
  const speak = snapshots.find((s) => s.phase === "speaking");
  assert.equal(speak.subtitle, "Столица Франции — Париж.");
  const tts = calls.filter((c) => c.path === "/zai/api/voice/tts");
  assert.equal(tts.length, 1);
  assert.deepEqual(tts[0].body, { text: "Столица Франции — Париж.", voice: "irina", rate: 1 });
});

test("две фразы ответа: озвучка по порядку, listening после последней", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж. А население — два миллиона человек.")]);
  await drain();
  assert.equal(snapshots.at(-1).phase, "speaking", "первая фраза играет, ход завершён");
  assert.equal(snapshots.at(-1).subtitle, "Столица Франции — Париж.");
  assert.equal(calls.filter((c) => c.path === "/zai/api/voice/tts").length, 2, "обе фразы синтезируются (prefetch)");
  ctx.nodes.sources[0].onended(); // конец первой
  await drain();
  assert.equal(snapshots.at(-1).phase, "speaking");
  assert.equal(snapshots.at(-1).subtitle, "А население — два миллиона человек.");
  ctx.nodes.sources[1].onended(); // конец второй
  await drain();
  assert.equal(snapshots.at(-1).phase, "listening", "очередь пуста → слушаю");
  assert.equal(session.level("speak"), 0);
});

test("стриминг: первая фраза говорится, пока ход busy; после неё — thinking, не listening", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  active.value = { id: SID, status: "busy", messages: [userMsg, assistantMsg("Столица Франции — Париж. А насе")] };
  await drain();
  assert.equal(snapshots.at(-1).phase, "speaking", "ответ говорит прямо во время хода");
  ctx.nodes.sources[0].onended();
  await drain();
  assert.equal(snapshots.at(-1).phase, "thinking", "фраза кончилась, ход ещё busy → думает");
  active.value = { id: SID, status: "idle", messages: [userMsg, assistantMsg("Столица Франции — Париж. А население — два миллиона человек.")] };
  await drain();
  assert.equal(snapshots.at(-1).phase, "speaking");
  ctx.nodes.sources[1].onended();
  await drain();
  assert.equal(snapshots.at(-1).phase, "listening");
});

test("turnError → error turn с текстом про «Повторить»; retry — resend последней реплики", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  setActiveIdle([userMsg], { turnError: { title: "Ход прервался" } });
  await drain();
  assert.equal(snapshots.at(-1).phase, "error");
  assert.equal(snapshots.at(-1).error.kind, "turn");
  assert.match(snapshots.at(-1).error.text, /Повторить/);
  session.retry();
  await drain();
  assert.equal(snapshots.at(-1).phase, "thinking", "resend ушёл → думает");
  const prompts = calls.filter((c) => c.path.endsWith("/prompt"));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].body.parts[0].text, "Привет как дела", "повторяется последняя реплика");
});

test("пустой ответ → error empty; retry пересылает реплику (resend)", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  setActiveIdle([userMsg]); // ответа нет вовсе
  await drain();
  assert.equal(snapshots.at(-1).phase, "error");
  assert.equal(snapshots.at(-1).error.kind, "empty");
  session.retry(); // empty.retry = "resend" — реплика уходит снова
  await drain();
  assert.equal(snapshots.at(-1).phase, "thinking");
  assert.equal(calls.filter((c) => c.path.endsWith("/prompt")).length, 2);
});

test("чужой активный чат → error send, prompt не уходит", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  active.value = { id: "ses_other", status: "idle", messages: [] }; // голос открыт не в том чате
  const { snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  assert.equal(snapshots.at(-1).phase, "error");
  assert.equal(snapshots.at(-1).error.kind, "send");
  assert.equal(calls.filter((c) => c.path.endsWith("/prompt")).length, 0);
});

// ---- ошибки STT --------------------------------------------------------------------

test("STT 429 → error quota; заголовок про дневной лимит", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  installFetch([{ method: "POST", path: "/zai/api/voice/stt", reply: () => ({ status: 429, body: { code: "quota" } }) }]);
  const { snapshots } = openSession({ ctx });
  await drain();
  await driveSegment(ctx);
  assert.equal(snapshots.at(-1).phase, "error");
  assert.equal(snapshots.at(-1).error.kind, "quota");
  assert.equal(snapshots.at(-1).error.title, VOICE_ERRORS.quota.title);
});

test("STT сетевой обрыв → error network", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  installFetch([{ method: "POST", path: "/zai/api/voice/stt", reply: "network" }]);
  const { snapshots } = openSession({ ctx });
  await drain();
  await driveSegment(ctx);
  assert.equal(snapshots.at(-1).phase, "error");
  assert.equal(snapshots.at(-1).error.kind, "network");
  assert.equal(snapshots.at(-1).error.title, VOICE_ERRORS.network.title);
});

test("STT 503 → переключение на browser-распознавание без ошибки", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch([{ method: "POST", path: "/zai/api/voice/stt", reply: () => ({ status: 503, body: { code: "unavailable" } }) }]);
  setG("SpeechRecognition", FakeRecognition);
  FakeRecognition.last = null;
  const { session, snapshots } = openSession({ ctx });
  await drain();
  pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk(), ...Array.from({ length: 6 }, silentChunk)]);
  await drain();
  assert.equal(snapshots.at(-1).phase, "listening", "ошибки нет — движок сменился");
  assert.ok(FakeRecognition.last?.started >= 1, "browser-распознаватель запущен из catch 503");
  pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk(), ...Array.from({ length: 6 }, silentChunk)]);
  await drain();
  assert.equal(calls.filter((c) => c.path === "/zai/api/voice/stt").length, 1, "после смены движка сервер не спрашивается");
  assert.equal(snapshots.at(-1).phase, "listening");
});

// ---- browser STT -------------------------------------------------------------------

function browserEnv(extraRoutes = []) {
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch(extraRoutes);
  setG("SpeechRecognition", FakeRecognition);
  FakeRecognition.last = null;
  sessions.value = [BOUND];
  setActiveIdle([]); // без активного чата send() вернул бы false → error send
  return { ...openSession({ ctx, info: INFO_NO_STT }), calls, ctx, stream };
}
function sayPartial(rec, committed, interim) {
  rec.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: committed }, isFinal: true }, { 0: { transcript: interim }, isFinal: false }],
  });
}


test("BUG-225: browser-STT стартует сразу при открытии сессии", async () => {
  browserEnv();
  await drain();
  assert.equal(FakeRecognition.last?.started, 1, "ожидание: rec создан и запущен при открытии");
});

test("browser-STT: partial → heard; пауза pauseMs → utterance → prompt → thinking", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, snapshots, calls } = browserEnv();
  return (async () => {
    await drain();
    session.toggleMute(); // обход дефекта старта: смена фазы будит syncBrowserStt
    session.toggleMute();
    await drain();
    const rec = FakeRecognition.last;
    assert.ok(rec?.started >= 1, "распознаватель запущен");
    sayPartial(rec, "привет", " как дела");
    assert.equal(snapshots.at(-1).heard, "Привет как дела");
    assert.equal(snapshots.at(-1).phase, "listening");
    t.mock.timers.tick(1300); // пауза 1200 мс → конец высказывания
    await drain();
    assert.equal(snapshots.at(-1).phase, "thinking", "реплика отправлена");
    assert.equal(calls.filter((c) => c.path.endsWith("/prompt")).length, 1, "prompt ушёл");
  })();
});

test("browser-STT: mute глушит распознаватель, unmute запускает заново", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session } = browserEnv();
  return (async () => {
    await drain();
    session.toggleMute(); // старт дефектен (rec не создан),mute ничего не прерывает
    await drain();
    session.toggleMute(); // unmute → syncBrowserStt запускает rec
    await drain();
    assert.ok(FakeRecognition.last?.started >= 1, "распознаватель запущен");
    session.toggleMute(); // mute при живом rec → abort
    await drain();
    assert.ok(FakeRecognition.last?.abortedCount >= 1, "при mute recognizer прерван");
    const before = FakeRecognition.last;
    session.toggleMute(); // снова listening
    await drain();
    assert.ok(FakeRecognition.last !== before, "unmute создаёт новый распознаватель");
    assert.ok(FakeRecognition.last?.started >= 1, "unmute запускает распознаватель заново");
  })();
});

// ---- ошибки TTS --------------------------------------------------------------------

test("TTS 429 → error quota, очередь и плеер остановлены", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch([{ method: "POST", path: "/zai/api/voice/tts", reply: () => ({ status: 429, body: { code: "quota" } }) }]);
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж.")]);
  await drain();
  assert.equal(snapshots.at(-1).phase, "error");
  assert.equal(snapshots.at(-1).error.kind, "quota");
  assert.equal(ctx.stopped, 0, "нечего останавливать — до плеера не дошло");
  assert.equal(calls.filter((c) => c.path === "/zai/api/voice/tts").length, 1, "синтез не повторяется");
});

test("TTS 503 → системный голос (browser): utterance ru-RU, voice ru, onend → listening", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch([{ method: "POST", path: "/zai/api/voice/tts", reply: () => ({ status: 503, body: { code: "unavailable" } }) }]);
  const FakeUtterance = class {
    constructor(text) {
      this.text = text;
      FakeUtterance.last = this;
    }
    static last = null;
  };
  const spoken = [];
  setG("SpeechSynthesisUtterance", FakeUtterance);
  setG("speechSynthesis", {
    speak: (u) => spoken.push(u),
    cancel: () => {},
    getVoices: () => [{ lang: "en-US", name: "Eng" }, { lang: "ru-RU", name: "Milena" }],
  });
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж.")]);
  await drain();
  assert.equal(session.ttsMode, "browser", "движок озвучки сменился");
  assert.equal(snapshots.at(-1).phase, "speaking");
  const u = FakeUtterance.last;
  assert.equal(u.text, "Столица Франции — Париж.");
  assert.equal(u.lang, "ru-RU");
  assert.equal(u.rate, 1);
  assert.equal(u.voice.name, "Milena", "выбран русский системный голос");
  assert.equal(spoken.length, 1);
  u.onend();
  await drain();
  assert.equal(snapshots.at(-1).phase, "listening");
});

test("TTS 503 без speechSynthesis → режим «текст»: субтитр держится паузой и уходит", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = makeCtx();
  setMic(makeStream());
  installFetch([{ method: "POST", path: "/zai/api/voice/tts", reply: () => ({ status: 503, body: { code: "unavailable" } }) }]);
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    await driveUtterance(ctx);
    setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж.")]);
    await drain();
    assert.equal(session.ttsMode, "text");
    assert.equal(snapshots.at(-1).phase, "speaking", "субтитр показан");
    assert.equal(snapshots.at(-1).subtitle, "Столица Франции — Париж.");
    t.mock.timers.tick(2000); // пауза чтения 400 + 24×55 мс
    await drain();
    assert.equal(snapshots.at(-1).phase, "listening");
  })();
});

// ---- перебивание и mute --------------------------------------------------------------

test("барж-ин: ≥300 мс речи во время ответа → перебивание, очередь очищена", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    await driveUtterance(ctx);
    setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж. А население — два миллиона человек.")]);
    await drain();
    assert.equal(snapshots.at(-1).phase, "speaking");
    t.mock.timers.tick(400); // проигрывание идёт дольше ignoreMs
    pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk(), loudChunk()]); // ~340 мс речи
    await drain();
    assert.equal(snapshots.at(-1).phase, "listening", "барж-ин перебил ответ");
    ctx.nodes.sources[0].onended(); // доигрывание оборванной фразы
    await drain();
    assert.equal(snapshots.at(-1).phase, "listening", "оборванная фраза не возвращает speaking");
    assert.equal(calls.filter((c) => c.path === "/zai/api/voice/tts").length, 2, "новых синтезов нет");
  })();
});

test("interrupt: в thinking без сказанного — no-op; в speaking → listening", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  assert.equal(snapshots.at(-1).phase, "thinking");
  session.interrupt();
  assert.equal(snapshots.at(-1).phase, "thinking", "перебивать нечего");
  setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж.")]);
  await drain();
  assert.equal(snapshots.at(-1).phase, "speaking");
  session.interrupt();
  assert.equal(snapshots.at(-1).phase, "listening");
  ctx.nodes.sources[0].onended();
  await drain();
  assert.equal(snapshots.at(-1).phase, "listening", "очередь очищена — speakIdle не придёт");
});

test("stopTurn: abort на сервере, назад к слушанию, ответ после остановки не озвучивается", async () => {
  const ctx = makeCtx();
  setMic(makeStream());
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  await drain();
  await driveUtterance(ctx);
  assert.equal(snapshots.at(-1).phase, "thinking");
  session.stopTurn();
  await drain();
  assert.equal(snapshots.at(-1).phase, "listening");
  assert.ok(calls.some((c) => c.path.endsWith("/abort")), "POST abort ушёл");
  setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж.")]);
  await drain();
  assert.equal(calls.filter((c) => c.path === "/zai/api/voice/tts").length, 0, "остановленный ход молчит");
});

test("toggleMute: микрофон и трек глушатся; кадры при mute не распознаются", async () => {
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch();
  const { session, snapshots } = openSession({ ctx });
  await drain();
  assert.equal(session.toggleMute(), true);
  assert.equal(snapshots.at(-1).state, "muted");
  assert.equal(snapshots.at(-1).phase, "listening");
  assert.equal(stream.tracks[0].enabled, false, "трек выключен");
  pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk()]);
  await drain();
  assert.equal(calls.filter((c) => c.path === "/zai/api/voice/stt").length, 0, "при mute кадры не идут в VAD");
  assert.equal(session.toggleMute(), false);
  assert.equal(snapshots.at(-1).state, "listening");
  assert.equal(stream.tracks[0].enabled, true);
});

// ---- закрытие не оставляет жизни ---------------------------------------------------

test("close из listening (browser-STT с pending-паузой): rec прерван, таймеры мертвы", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, snapshots, calls, ctx, stream } = browserEnv();
  return (async () => {
    await drain();
    session.toggleMute();
    session.toggleMute();
    await drain();
    const rec = FakeRecognition.last;
    sayPartial(rec, "не", " отправлено");
    session.close();
    await assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream });
    assert.equal(calls.filter((c) => c.path.endsWith("/prompt")).length, 0, "пауза не превратилась в отправку");
  })();
});

test("close из listening (server): захват и ctx закрыты, подписки мертвы", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch();
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    session.close();
    await assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream });
  })();
});

test("close из sending (STT висит): utterance не доходит до prompt", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch([{ method: "POST", path: "/zai/api/voice/stt", reply: "hang" }]);
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    pushChunks(ctx, [loudChunk(), loudChunk(), loudChunk(), ...Array.from({ length: 18 }, silentChunk)]);
    await drain();
    assert.equal(snapshots.at(-1).phase, "sending");
    session.close();
    await assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream });
    assert.equal(calls.filter((c) => c.path.endsWith("/prompt")).length, 0, "висящий STT не превратился в отправку");
  })();
});

test("close из thinking: повторная ревизия ленты не будит автомат", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    await driveUtterance(ctx);
    assert.equal(snapshots.at(-1).phase, "thinking");
    session.close();
    await assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream });
  })();
});

test("close из speaking: плеер остановлен, озвучка не продолжается", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch();
  sessions.value = [BOUND];
  setActiveIdle([]);
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    await driveUtterance(ctx);
    setActiveIdle([userMsg, assistantMsg("Столица Франции — Париж. А население — два миллиона человек.")]);
    await drain();
    assert.equal(snapshots.at(-1).phase, "speaking");
    session.close();
    assert.ok(ctx.stopped >= 1, "player.stop остановил играющий источник");
    for (const s of ctx.nodes.sources) s.onended(); // «доигрывание» после close
    await drain();
    await assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream });
    assert.equal(calls.filter((c) => c.path === "/zai/api/voice/tts").length, 2, "синтез не продолжился");
  })();
});

test("close из error и из muted: тихо и без таймеров", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const calls = installFetch([{ method: "POST", path: "/zai/api/voice/stt", reply: "network" }]);
  const { session, snapshots } = openSession({ ctx });
  return (async () => {
    await drain();
    await driveSegment(ctx); // сегмент → /voice/stt → сетевой обрыв → error
    assert.equal(snapshots.at(-1).phase, "error");
    session.close();
    await assertNoLifeAfterClose(t, { snapshots, calls, ctx, stream });

    // muted-вариант на второй сессии
    const ctx2 = makeCtx();
    const stream2 = makeStream();
    setMic(stream2);
    const calls2 = installFetch();
    const { session: s2, snapshots: snaps2 } = openSession({ ctx: ctx2 });
    await drain();
    s2.toggleMute();
    s2.close();
    await assertNoLifeAfterClose(t, { snapshots: snaps2, calls: calls2, ctx: ctx2, stream: stream2 });
  })();
});
