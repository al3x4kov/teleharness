// TASK-14.17 (QA-06): unit-тесты браузерной аудио-обвязки src/lib/voice-audio.js.
// Покрыты все 9 экспортов: audioContext, unlockAudio, micSupported, startCapture,
// createPlayer, browserTtsSupported, speakBrowser, cancelBrowserTts, holdWakeLock —
// каждый с фейками API и в чистом Node (нет API → false / безопасный no-op).
// Прогон: node --test tests/voice-audio.test.js. Реальной сети и микрофона нет.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  audioContext,
  unlockAudio,
  micSupported,
  startCapture,
  createPlayer,
  browserTtsSupported,
  speakBrowser,
  cancelBrowserTts,
  holdWakeLock,
} from "../src/lib/voice-audio.js";
import { FRAME } from "../src/lib/voice-vad.js";

// ---- подмена globalThis (восстановление LIFO в afterEach) ----------------------
const stash = [];
function setG(key, value) {
  stash.push([key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null]);
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
afterEach(() => {
  while (stash.length) {
    const [k, d] = stash.pop();
    if (d) Object.defineProperty(globalThis, k, d);
    else delete globalThis[k];
  }
});

// Микрозадачи выравниваем setImmediate (детерминированно, без sleep).
const drain = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

// ---- фейки ----------------------------------------------------------------------
// Внимание: voice-audio хранит общий контекст в module-level `shared` — тесты
// audioContext/unlockAudio упорядочены так, чтобы этот кэш не протекал.
function makeCtx() {
  const ctx = {
    state: "running",
    sampleRate: 48000,
    destination: {},
    nodes: { script: [], sources: [] },
    resumed: 0,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({
      fftSize: 0,
      connect() {},
      getFloatTimeDomainData: (buf) => buf.fill(0.1), // уровень орба 0.1×6 = 0.6
    }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const node = { onaudioprocess: null, connect() {}, disconnect() {} };
      ctx.nodes.script.push(node);
      return node;
    },
    createBuffer: () => ({}),
    createBufferSource: () => {
      const node = { buffer: null, connect() {}, startedAt: null, start: (t) => (node.startedAt = t ?? 0) };
      ctx.nodes.sources.push(node);
      return node;
    },
    resume: async () => {
      ctx.resumed += 1;
    },
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
const loudChunk = () => Float32Array.from({ length: 4096 }, () => 0.4);

// ---- проверки возможностей -------------------------------------------------------

test("micSupported: true только при navigator.mediaDevices.getUserMedia-функции", () => {
  setG("navigator", undefined);
  assert.equal(micSupported(), false, "нет navigator");
  setG("navigator", {});
  assert.equal(micSupported(), false, "нет mediaDevices");
  setG("navigator", { mediaDevices: {} });
  assert.equal(micSupported(), false, "нет getUserMedia");
  setG("navigator", { mediaDevices: { getUserMedia: 42 } });
  assert.equal(micSupported(), false, "getUserMedia не функция");
  setG("navigator", { mediaDevices: { getUserMedia() {} } });
  assert.equal(micSupported(), true);
});

test("browserTtsSupported: нужны и speechSynthesis, и SpeechSynthesisUtterance", () => {
  assert.equal(browserTtsSupported(), false, "в чистом Node оба отсутствуют");
  setG("speechSynthesis", {});
  assert.equal(browserTtsSupported(), false, "synth без конструктора");
  setG("SpeechSynthesisUtterance", class {});
  assert.equal(browserTtsSupported(), true);
});

test("cancelBrowserTts: без synth — безопасный no-op; с synth — cancel вызван", () => {
  assert.doesNotThrow(() => cancelBrowserTts(), "нет speechSynthesis");
  let cancels = 0;
  setG("speechSynthesis", {
    cancel: () => {
      cancels += 1;
    },
  });
  cancelBrowserTts();
  assert.equal(cancels, 1);
  setG("speechSynthesis", {
    cancel() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => cancelBrowserTts(), "ошибка cancel проглатывается");
});

// ---- audioContext / unlockAudio ---------------------------------------------------

test("audioContext: без конструктора null; с фейком один общий инстанс; closed → новый; бросающий → null", () => {
  assert.equal(audioContext(), null, "в Node нет AudioContext, кэш пуст при первом вызове");
  let created = 0;
  class FakeAC {
    constructor() {
      created += 1;
      this.state = "running";
    }
  }
  setG("AudioContext", FakeAC);
  const a = audioContext();
  assert.ok(a instanceof FakeAC);
  assert.equal(audioContext(), a, "второй вызов возвращает общий контекст");
  a.state = "closed";
  const b = audioContext();
  assert.notEqual(b, a, "закрытый контекст пересоздаётся");
  assert.equal(created, 2);
  b.state = "closed"; // иначе общий кэш вернёт живой инстанс, не дойдя до конструктора
  setG("AudioContext", class {
    constructor() {
      throw new Error("boom");
    }
  });
  assert.equal(audioContext(), null, "исключение конструктора → null");
});

test("unlockAudio: без AudioContext — null и без исключений", () => {
  assert.doesNotThrow(() => {
    const ctx = unlockAudio();
    assert.equal(ctx, null);
  });
});

test("unlockAudio: resume + пустой buffer source; системному голосу — жест-разблокировка", () => {
  const ctx = makeCtx();
  setG("AudioContext", function FakeAC() {
    return ctx; // new вернёт объект из конструктора — достаточно для теста
  });
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  const spoken = [];
  setG("SpeechSynthesisUtterance", FakeUtterance);
  setG("speechSynthesis", { speak: (u) => spoken.push(u) });
  const got = unlockAudio();
  assert.equal(got, ctx);
  assert.equal(ctx.resumed, 1);
  assert.equal(ctx.nodes.sources.length, 1, "создан buffer source");
  assert.equal(ctx.nodes.sources[0].startedAt, 0, "source запущен");
  assert.equal(spoken.length, 1, " utterance для iOS-разблокировки произнесён");
  assert.equal(spoken[0].text, " ");
  assert.equal(spoken[0].volume, 0, "беззвучно");
});

// ---- startCapture ------------------------------------------------------------------

test("startCapture: без ctx и без getUserMedia → код nomic; отказ → mic; прочее → nomic", async () => {
  await assert.rejects(startCapture(null, { onFrame() {} }), (e) => e.code === "nomic", "нет контекста");
  setG("navigator", { userAgent: "Node.js/24" }); // нет mediaDevices
  await assert.rejects(startCapture(makeCtx(), { onFrame() {} }), (e) => e.code === "nomic", "нет getUserMedia");
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
  await assert.rejects(startCapture(makeCtx(), { onFrame() {} }), (e) => e.code === "mic", "нет разрешения");
  setG("navigator", {
    userAgent: "Node.js/24",
    mediaDevices: {
      getUserMedia: async () => {
        const e = new Error("no device");
        e.name = "NotFoundError";
        throw e;
      },
    },
  });
  await assert.rejects(startCapture(makeCtx(), { onFrame() {} }), (e) => e.code === "nomic", "нет устройства");
});

test("startCapture happy path: кадры по 320 сэмплов, level 0.6, setEnabled/stop", async () => {
  const ctx = makeCtx();
  const stream = makeStream();
  setMic(stream);
  const frames = [];
  const capture = await startCapture(ctx, { onFrame: (f) => frames.push(f) });
  const node = ctx.nodes.script[0];
  assert.ok(node?.onaudioprocess, "узел захвата создан (ScriptProcessor без AudioWorklet)");
  for (let i = 0; i < 3; i += 1) node.onaudioprocess({ inputBuffer: { getChannelData: () => loudChunk() } });
  // 48кГц → 16кГц: 3×4096 = 4096 сэмплов = 12 полных кадров по 320.
  assert.equal(frames.length, 12);
  assert.ok(frames.every((f) => f.length === FRAME), "кадры ровно FRAME");
  assert.ok(Math.abs(frames[0][0] - 0.4) < 1e-6, "значения проходят ресемпл без искажений");
  assert.ok(Math.abs(capture.level() - 0.6) < 1e-6, "RMS×6 с анализатора (float32 ≈ 0.6)");
  capture.setEnabled(false);
  assert.equal(stream.tracks[0].enabled, false, "трек заглушён");
  const at = frames.length;
  node.onaudioprocess({ inputBuffer: { getChannelData: () => loudChunk() } });
  assert.equal(frames.length, at, "кадры при выключении не идут");
  assert.equal(capture.level(), 0, "уровень при выключении нулевой");
  capture.setEnabled(true);
  assert.equal(stream.tracks[0].enabled, true);
  node.onaudioprocess({ inputBuffer: { getChannelData: () => loudChunk() } });
  assert.ok(frames.length > at, "кадры снова идут");
  capture.stop();
  assert.equal(node.onaudioprocess, null, "обработчик снят");
  assert.ok(stream.tracks.every((tr) => tr.stopped), "треки остановлены");
  assert.doesNotThrow(() => capture.stop(), "повторный stop безопасен");
});

// ---- createPlayer --------------------------------------------------------------------

function playerCtx() {
  const ctx = makeCtx();
  ctx.createBufferSource = () => {
    const node = { buffer: null, onended: null, connect() {}, started: false, stoppedCount: 0, start() { node.started = true; ctx.nodes.sources.push(node); }, stop() { node.stoppedCount += 1; node.onended?.call(node); } };
    return node;
  };
  return ctx;
}

test("createPlayer.decode: callback-стиль, promise-стиль, ошибки — все пути", async () => {
  const ctx = playerCtx();
  const buf = { fake: true };
  ctx.decodeAudioData = (bytes, ok) => ok(buf); // старый Safari
  assert.deepEqual(await createPlayer(ctx).decode(new ArrayBuffer(8)), buf);
  ctx.decodeAudioData = () => Promise.resolve(buf); // современный
  assert.deepEqual(await createPlayer(ctx).decode(new ArrayBuffer(8)), buf);
  ctx.decodeAudioData = (bytes, ok, err) => err(new Error("bad"));
  await assert.rejects(createPlayer(ctx).decode(new ArrayBuffer(8)), /bad/);
  ctx.decodeAudioData = () => Promise.reject(new Error("worse"));
  await assert.rejects(createPlayer(ctx).decode(new ArrayBuffer(8)), /worse/);
});

test("createPlayer.play: abort до старта — source не создаётся; обычный play — до onended", async () => {
  const ctx = playerCtx();
  const player = createPlayer(ctx);
  const buf = { fake: true };
  const ctl = new AbortController();
  ctl.abort();
  await player.play(buf, ctl.signal);
  assert.equal(ctx.nodes.sources.length, 0, "abort до старта — тишина");

  const done = player.play(buf);
  const src = ctx.nodes.sources[0];
  assert.ok(src.started, "source запущен");
  assert.equal(src.buffer, buf);
  assert.ok(Math.abs(player.level() - 0.6) < 1e-6, "уровень идёт с анализатора, пока играет");
  src.onended();
  await done;
  assert.equal(player.level(), 0, "после окончания уровень нулевой");
});

test("createPlayer: stop останавливает играющее; abort-сигнал тоже", async () => {
  const ctx = playerCtx();
  const player = createPlayer(ctx);
  assert.doesNotThrow(() => player.stop(), "stop без игрыющего безопасен");

  const done = player.play({ fake: true });
  player.stop();
  assert.equal(ctx.nodes.sources[0].stoppedCount, 1);
  await done;

  const ctl = new AbortController();
  const done2 = player.play({ fake: true }, ctl.signal);
  const src2 = ctx.nodes.sources[1];
  ctl.abort(); // слушатель: s.stop() + resolve
  await done2;
  assert.ok(src2.stoppedCount >= 1, "abort сигнала останавливает source");
});

// ---- speakBrowser -------------------------------------------------------------------

function fakeTts() {
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      FakeUtterance.last = this;
    }
    static last = null;
  }
  const spoken = [];
  let cancels = 0;
  setG("SpeechSynthesisUtterance", FakeUtterance);
  setG("speechSynthesis", {
    speak: (u) => spoken.push(u),
    cancel: () => (cancels += 1),
    getVoices: () => [{ lang: "en-US", name: "Eng" }, { lang: "ru-RU", name: "Milena" }],
  });
  return { FakeUtterance, spoken, canceled: () => cancels };
}

test("speakBrowser: без synth — мгновенный resolve (no-op)", async () => {
  await speakBrowser("привет");
  const ctl = new AbortController();
  ctl.abort();
  await speakBrowser("привет", { signal: ctl.signal }); // abort до старта — тоже no-op
});

test("speakBrowser: ru-голос, lang/rate, resolve по onend и по onerror", async () => {
  const { FakeUtterance } = fakeTts();
  const p = speakBrowser("Привет", { rate: 1.2 });
  const u = FakeUtterance.last;
  assert.equal(u.text, "Привет");
  assert.equal(u.lang, "ru-RU");
  assert.equal(u.rate, 1.2);
  assert.equal(u.voice.name, "Milena");
  u.onend();
  await p;
  const p2 = speakBrowser("Ещё раз");
  FakeUtterance.last.onerror();
  await p2; // onerror тоже завершает промис
});

test("speakBrowser: abort-сигнал → synth.cancel + resolve", async () => {
  const { FakeUtterance, canceled } = fakeTts();
  const ctl = new AbortController();
  const p = speakBrowser("Длинная фраза", { signal: ctl.signal });
  assert.ok(FakeUtterance.last, "utterance ушёл в synth");
  ctl.abort();
  await p;
  assert.equal(canceled(), 1);
});

// ---- holdWakeLock -------------------------------------------------------------------

function fakeDoc({ hidden = false } = {}) {
  const listeners = {};
  const doc = {
    hidden,
    addEventListener: (n, f) => (listeners[n] = f),
    removeEventListener: (n, f) => {
      if (listeners[n] === f) delete listeners[n];
    },
  };
  return { doc, listeners };
}
function fakeWakeLock() {
  let requests = 0;
  let releases = 0;
  setG("navigator", {
    userAgent: "Node.js/24",
    wakeLock: {
      request: async () => {
        requests += 1;
        return { release: () => (releases += 1) };
      },
    },
  });
  return { asked: () => requests, released: () => releases };
}

test("holdWakeLock: без document/wakeLock release безопасен (двойной тоже)", () => {
  const release = holdWakeLock();
  assert.doesNotThrow(() => {
    release();
    release();
  });
});

test("holdWakeLock: берёт lock, release отдаёт его и снимает слушателя", async () => {
  const { doc, listeners } = fakeDoc();
  setG("document", doc);
  const wl = fakeWakeLock();
  const release = holdWakeLock();
  await drain();
  assert.equal(wl.asked(), 1, "lock взят при открытии");
  release();
  assert.equal(wl.released(), 1, "lock отдан");
  doc.hidden = false;
  listeners.visibilitychange?.(); // страница «вернулась»
  await drain();
  assert.equal(wl.asked(), 1, "после release повторный захват не нужен");
  assert.equal(listeners.visibilitychange, undefined, "слушатель снят");
});

test("holdWakeLock: скрытая страница не берёт lock; возврат — берёт снова", async () => {
  const { doc, listeners } = fakeDoc({ hidden: true });
  setG("document", doc);
  const wl = fakeWakeLock();
  const release = holdWakeLock();
  await drain();
  assert.equal(wl.asked(), 0, "document.hidden → запроса нет");
  doc.hidden = false;
  listeners.visibilitychange?.();
  await drain();
  assert.equal(wl.asked(), 1, "возврат на страницу → перезахват");
  release();
});

test("holdWakeLock: после release перезахвата нет", async () => {
  const { doc, listeners } = fakeDoc();
  setG("document", doc);
  const wl = fakeWakeLock();
  const release = holdWakeLock();
  await drain();
  release();
  doc.hidden = true;
  listeners.visibilitychange?.(); // ушёл со страницы
  doc.hidden = false;
  listeners.visibilitychange?.(); // вернулся
  await drain();
  assert.equal(wl.asked(), 1, "released-флаг блокирует повторный захват");
});
