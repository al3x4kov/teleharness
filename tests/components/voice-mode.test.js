// FEAT-06.2 «Голосовой режим» (L2): the «волна» button in the composer (frame
// 1) and its coexistence with hold-to-dictate (FEAT-06.1), the overlay
// (frames 2–6: state labels, mute, Стоп/Перебить, error face, Esc/Space,
// dialog semantics), ChatView wiring (GET /voice), the feed marks «голосом» /
// «озвучено» (frame 7) with the hidden hint never rendered, the send() of the
// hidden part, and Настройки → «Голосовой режим» (frame 8).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";
import { VOICE_HINT, VOICE_MARK } from "../../src/lib/voice-text.js";

let ui, t$;
before(async () => {
  ui = await loadUI({
    Composer: "src/components/chat/Composer.jsx",
    VoiceModeView: "src/components/chat/VoiceModeView.jsx",
    MessageBubble: "src/components/chat/MessageBubble.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
    ChatView: "src/components/views/ChatView.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.me.value = null;
  s.sessions.value = [];
  s.active.value = null;
  s.voiceInfo.value = null;
  s.providerCfg.value = null;
  s.setPrefs({ voice: undefined });
  s.setActiveId(null);
  delete globalThis.SpeechRecognition;
  try {
    delete navigator.mediaDevices;
  } catch {}
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true, writable: true });
  installFetch();
});

const WAVE = 'button.send-btn path[d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"]';
const ARROW = 'button.send-btn path[d="M12 19V5"]';
const MIC = 'button.send-btn path[d="M19 10v1a7 7 0 0 1-14 0v-1"]';
const sendBtn = (root) => $(root, "button.send-btn");
const ta = (root) => $(root, 'textarea[aria-label="Сообщение"]');
const VOICE_INFO = { enabled: true, ready: true, parked: false, voices: [{ id: "irina", name: "Ирина" }, { id: "denis", name: "Денис" }], stt: true, defaultVoice: "irina" };

class FakeRecognition {
  static last = null;
  constructor() {
    this.started = 0;
    FakeRecognition.last = this;
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
}

// ---- composer: frame 1 ------------------------------------------------------

test("composer: «волна» only with an empty field and the voice mode on; text → arrow; no voice mode → as before", () => {
  let opened = 0;
  const { root, rerender } = t$.mount(ui.Composer, { status: "idle", onSend: () => {}, onStop: () => {}, onVoiceMode: () => (opened += 1) });
  assert.ok($(root, WAVE), "empty field → wave");
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Голосовой режим");
  assert.ok(sendBtn(root).classList.contains("is-wave"));
  t$.typeInto(ta(root), "привет");
  assert.ok($(root, ARROW), "text → the send arrow");
  assert.equal($(root, WAVE), null);
  t$.typeInto(ta(root), "");
  rerender({ status: "busy" });
  assert.equal($(root, WAVE), null, "busy + empty → «Стоп», no wave");
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Остановить");
  rerender({ status: "idle", onVoiceMode: null });
  assert.equal($(root, WAVE), null, "voice mode off (GET /voice enabled:false) → no wave");
  assert.ok($(root, ARROW));
  assert.equal(opened, 0);
});

test("composer: a tap on «волна» opens the mode; a 350 ms hold is still the dictation (FEAT-06.1)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.SpeechRecognition = FakeRecognition;
  let opened = 0;
  const { root } = t$.mount(ui.Composer, { status: "idle", onSend: () => {}, onStop: () => {}, onVoiceMode: () => (opened += 1) });
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Голосовой режим — удерживайте для диктовки");
  // tap
  t$.fire(sendBtn(root), "pointerdown", { pointerId: 1, clientY: 500 }, PointerEvent);
  t$.act(() => t.mock.timers.tick(120));
  t$.fire(sendBtn(root), "pointerup", { pointerId: 1 }, PointerEvent);
  t$.click(sendBtn(root));
  assert.equal(opened, 1, "tap → voice mode");
  assert.equal(FakeRecognition.last, null, "no dictation on a tap");
  // hold
  t$.fire(sendBtn(root), "pointerdown", { pointerId: 2, clientY: 500 }, PointerEvent);
  t$.act(() => t.mock.timers.tick(350));
  t$.act(() => {});
  assert.ok($(root, ".voice-hint"), "hold → dictation hint");
  assert.equal(FakeRecognition.last.started, 1);
  t$.fire(sendBtn(root), "pointerup", { pointerId: 2 }, PointerEvent);
  t$.click(sendBtn(root)); // the click after a release is swallowed
  assert.equal(opened, 1, "a hold never opens the voice mode");
  t$.act(() => t.mock.timers.tick(1500));
});

// ---- the overlay: frames 2–6 ----------------------------------------------------

function fakeSession() {
  const calls = [];
  let emit = () => {};
  let snap = { state: "listening", phase: "listening", muted: false, heard: "", subtitle: "", action: null, error: null };
  const factory = (opts) => {
    calls.push(["create", opts.sessionId, opts.prefs]);
    emit = (patch) => t$.act(() => opts.onChange((snap = { ...snap, ...patch })));
    return {
      snapshot: () => snap,
      level: () => 0,
      ttsMode: "server",
      voiceId: "irina",
      toggleMute: () => {
        calls.push(["mute"]);
        const muted = !snap.muted;
        emit({ muted, state: muted ? "muted" : "listening" });
      },
      interrupt: () => calls.push(["interrupt"]),
      stopTurn: () => calls.push(["stopTurn"]),
      retry: () => calls.push(["retry"]),
      close: () => calls.push(["close"]),
    };
  };
  return { factory, calls, emit: (p) => emit(p) };
}

const dialog = () => document.querySelector('[role="dialog"][aria-label="Голосовой режим"]');
const stateText = () => dialog().querySelector(".vm-state").textContent;
const ctl = (label) => dialog().querySelector(`button.vm-ctl[aria-label="${label}"]`);

function mountOverlay({ sid = "ses_v", binding = null } = {}) {
  ui.store.voiceInfo.value = VOICE_INFO;
  if (binding) ui.store.sessions.value = [{ id: sid, title: "Голос", directory: "C:\\Home", zai: binding }];
  const fake = fakeSession();
  let closed = 0;
  const h = t$.mount(ui.VoiceModeView, { sessionId: sid, onClose: () => (closed += 1), createSession: fake.factory });
  return { ...h, fake, closed: () => closed };
}

test("overlay: dialog, top pills (model · agent, voice), «Слушаю…» with Микрофон / Текст / Завершить", () => {
  ui.store.providerCfg.value = { models: [{ id: "glm-5.3", providerID: "zai-coding-plan", label: "GLM-5.3 (zai-coding-plan)" }] };
  const { fake } = mountOverlay({ binding: { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "Sisyphus - ultraworker" } });
  const d = dialog();
  assert.ok(d, "role=dialog «Голосовой режим»");
  assert.equal(d.getAttribute("aria-modal"), "true");
  assert.equal(d.parentElement.parentElement, document.body, "portaled to <body>");
  const pills = $$(d, ".vm-pill").map((p) => p.textContent);
  assert.equal(pills[0], "GLM-5.3 · Sisyphus - ultraworker");
  assert.match(pills[1], /^Голос: Ирина/);
  assert.equal(stateText(), "Слушаю…");
  assert.equal(d.querySelector(".vm-state").getAttribute("role"), "status");
  assert.deepEqual($$(d, "button.vm-ctl").map((b) => b.querySelector("small").textContent), ["Микрофон", "Текст", "Завершить"]);
  assert.ok(ctl("Завершить голосовой режим").classList.contains("is-end"));
  assert.ok($(d, "canvas.vm-orb"), "the orb canvas");
  assert.deepEqual(fake.calls[0].slice(0, 2), ["create", "ses_v"]);
  assert.deepEqual(fake.calls[0][2], { voice: null, rate: 1, pauseMs: 1200, shortAnswers: true });
});

test("overlay: the heard text, «Думаю…» with the tool action and «Стоп», «Говорю» with the sentence and «Перебить»", () => {
  const { fake } = mountOverlay();
  fake.emit({ heard: "Какая столица Франции" });
  assert.match(dialog().querySelector(".vm-sub").textContent, /Какая столица Франции/);
  fake.emit({ state: "thinking", phase: "thinking", heard: "Какая столица Франции?", action: "читает файл" });
  assert.equal(stateText(), "Думаю…");
  const sub = dialog().querySelector(".vm-sub").textContent;
  assert.match(sub, /«Какая столица Франции\?»/);
  assert.match(sub, /Читает файл…/);
  t$.click(ctl("Остановить ответ"));
  assert.deepEqual(fake.calls.at(-1), ["stopTurn"]);
  assert.equal(ctl("Остановить ответ").querySelector("small").textContent, "Стоп");
  fake.emit({ state: "speaking", phase: "speaking", subtitle: "Столица Франции — Париж." });
  assert.equal(stateText(), "Говорю");
  assert.equal(dialog().querySelector(".vm-sub").textContent, "Столица Франции — Париж.");
  t$.click(ctl("Перебить"));
  assert.deepEqual(fake.calls.at(-1), ["interrupt"]);
});

test("overlay: «Микрофон» toggles mute — «Микрофон выключен», pressed «Включить»; Space toggles too", () => {
  const { fake } = mountOverlay();
  t$.click(ctl("Выключить микрофон"));
  assert.deepEqual(fake.calls.at(-1), ["mute"]);
  assert.equal(stateText(), "Микрофон выключен");
  assert.equal(dialog().querySelector(".vm-sub").textContent, "Нажмите микрофон, чтобы продолжить");
  const on = ctl("Включить микрофон");
  assert.equal(on.getAttribute("aria-pressed"), "true");
  assert.ok(on.classList.contains("is-on"));
  assert.equal(on.querySelector("small").textContent, "Включить");
  t$.key(dialog(), " ");
  assert.equal(stateText(), "Слушаю…");
  assert.equal(fake.calls.filter((c) => c[0] === "mute").length, 2);
});

test("overlay: «Текст» hides the live subtitle (never the error / muted text)", () => {
  const { fake } = mountOverlay();
  fake.emit({ heard: "секретная фраза" });
  t$.click(ctl("Субтитры"));
  assert.equal(ctl("Субтитры").getAttribute("aria-pressed"), "false");
  assert.equal(dialog().textContent.includes("секретная фраза"), false);
});

test("overlay: error face — the reason in Russian, «Повторить» + «Завершить», no auto-close", () => {
  const { fake, closed } = mountOverlay();
  fake.emit({
    state: "error",
    phase: "error",
    error: { kind: "mic", title: "Нет доступа к микрофону", text: "Разрешите микрофон для сайта: Настройки → Safari → Микрофон", retry: "mic" },
  });
  assert.equal(stateText(), "Нет доступа к микрофону");
  assert.equal(dialog().querySelector(".vm-sub").textContent, "Разрешите микрофон для сайта: Настройки → Safari → Микрофон");
  assert.deepEqual($$(dialog(), "button.vm-ctl").map((b) => b.querySelector("small").textContent), ["Повторить", "Завершить"]);
  t$.click(ctl("Повторить"));
  assert.deepEqual(fake.calls.at(-1), ["retry"]);
  assert.ok(dialog(), "still open");
  assert.equal(closed(), 0);
});

test("overlay: Esc = «Завершить» (session closed, onClose once)", () => {
  const { fake, closed } = mountOverlay();
  t$.key(dialog(), "Escape");
  assert.equal(closed(), 1);
  assert.ok(fake.calls.some((c) => c[0] === "close"));
  t$.key(document.body, "Escape");
  assert.equal(closed(), 1);
});

test("overlay with the real controller: no microphone → «Микрофон недоступен», denied → «Нет доступа к микрофону»", async () => {
  ui.store.voiceInfo.value = VOICE_INFO;
  t$.mount(ui.VoiceModeView, { sessionId: "ses_x", onClose: () => {} });
  await t$.waitFor(() => stateText() === "Микрофон недоступен");
  t$.cleanup();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) },
    configurable: true,
    writable: true,
  });
  const ctx = { state: "running", destination: {}, createAnalyser: () => ({ connect() {}, getFloatTimeDomainData() {} }), suspend() {} };
  t$.mount(ui.VoiceModeView, { sessionId: "ses_x", ctx, onClose: () => {} });
  await t$.waitFor(() => stateText() === "Нет доступа к микрофону");
  assert.match(dialog().querySelector(".vm-sub").textContent, /Разрешите микрофон для сайта/);
});

// ---- ChatView wiring -------------------------------------------------------------------

test("ChatView: GET /voice enabled → «волна» in the composer, the tap opens the overlay, «Завершить» returns to the chat", async () => {
  const SID = "ses_cv";
  const NOW = Date.now();
  const rec = { id: SID, title: "Голос", directory: "C:\\Home", time: { created: NOW, updated: NOW } };
  installFetch([
    { method: "GET", path: "/zai/api/voice", reply: () => VOICE_INFO },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => [] },
    { method: "GET", path: "/zai/api/session", reply: () => [rec] },
  ]);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => new Promise(() => {}) }, configurable: true, writable: true });
  ui.store.sessions.value = [rec];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  const wave = await t$.waitFor(() => $(root, WAVE));
  assert.ok(fetchCalls.some((c) => c.path === "/zai/api/voice"));
  t$.click(wave.closest("button"));
  await t$.waitFor(() => dialog());
  assert.equal(stateText(), "Слушаю…");
  t$.click(ctl("Завершить голосовой режим"));
  await t$.waitFor(() => !dialog());
  assert.ok($(root, WAVE), "back in the chat");
});

test("ChatView: GET /voice enabled:false → no «волна», dictation face unchanged", async () => {
  const SID = "ses_off";
  const rec = { id: SID, title: "Т", directory: "C:\\Home", time: { created: 1, updated: 1 } };
  installFetch([
    { method: "GET", path: "/zai/api/voice", reply: () => ({ enabled: false, voices: [], stt: false }) },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => [] },
    { method: "GET", path: "/zai/api/session", reply: () => [rec] },
  ]);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => new Promise(() => {}) }, configurable: true, writable: true });
  globalThis.SpeechRecognition = FakeRecognition;
  ui.store.sessions.value = [rec];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => fetchCalls.some((c) => c.path === "/zai/api/voice") && ui.store.voiceInfo.value);
  await t$.flush(3);
  assert.equal($(root, WAVE), null);
  assert.ok($(root, MIC), "hold-to-dictate mic as before");
});

// ---- feed marks: frame 7 ---------------------------------------------------------------

test("feed: «голосом» on the voice message (hint never rendered), «озвучено» on its answer; typed turns unmarked", () => {
  const user = { info: { id: "u1", role: "user", sessionID: "s1", time: { created: 1 } }, parts: [{ id: "p1", type: "text", text: "Какая столица Франции?" }, { id: "p2", type: "text", text: VOICE_HINT, synthetic: true }] };
  const answer = { info: { id: "a1", role: "assistant", sessionID: "s1", modelID: "glm-5.3", providerID: "zai-coding-plan", agent: "build", time: { created: 2, completed: 3 } }, parts: [{ id: "p3", type: "text", text: "Париж." }] };
  const typed = { info: { id: "u2", role: "user", sessionID: "s1", time: { created: 4 } }, parts: [{ id: "p4", type: "text", text: "А теперь текстом" }] };
  const answer2 = { info: { id: "a2", role: "assistant", sessionID: "s1", modelID: "glm-5.3", providerID: "zai-coding-plan", agent: "build", time: { created: 5, completed: 6 } }, parts: [{ id: "p5", type: "text", text: "Хорошо." }] };
  ui.store.active.value = { id: "s1", status: "idle", messages: [user, answer, typed, answer2] };
  const u = t$.mount(ui.MessageBubble, { msg: user });
  assert.equal($(u.root, ".voice-tag").textContent.trim(), "голосом");
  assert.ok($(u.root, ".voice-tag svg"), "mic icon");
  assert.equal($(u.root, ".bubble-text").textContent, "Какая столица Франции?");
  assert.equal(u.root.textContent.includes(VOICE_MARK), false, "the hint is never shown");
  assert.equal(u.root.textContent.includes("Отвечай коротко"), false);
  const a = t$.mount(ui.MessageBubble, { msg: answer });
  assert.ok(byText(a.root, ".voice-tag.is-spoken", "озвучено"));
  const tp = t$.mount(ui.MessageBubble, { msg: typed });
  assert.equal($(tp.root, ".voice-tag"), null);
  const a2 = t$.mount(ui.MessageBubble, { msg: answer2 });
  assert.equal($(a2.root, ".voice-tag"), null);
});

test("store.send({hidden}): the synthetic hint rides after the typed text; the optimistic bubble shows only the text", async () => {
  const SID = "ses_send";
  installFetch([{ method: "POST", path: `/zai/api/session/${SID}/prompt`, reply: () => ({ status: 204, body: null }) }]);
  ui.store.sessions.value = [{ id: SID, title: "Т", directory: "C:\\Home", zai: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, agent: null, prompted: true } }];
  ui.store.active.value = { id: SID, status: "idle", messages: [] };
  const ok = await ui.store.send({ text: "Привет", sessionId: SID, hidden: [{ type: "text", text: VOICE_HINT, synthetic: true }, { type: "text", text: "не synthetic — отброшено" }] });
  assert.equal(ok, true);
  const call = fetchCalls.find((c) => c.method === "POST" && c.path === `/zai/api/session/${SID}/prompt`);
  assert.deepEqual(call.body.parts, [{ type: "text", text: "Привет" }, { type: "text", text: VOICE_HINT, synthetic: true }]);
  const bubble = ui.store.active.value.messages.at(-1);
  const { root } = t$.mount(ui.MessageBubble, { msg: bubble });
  assert.equal($(root, ".bubble-text").textContent, "Привет");
  assert.equal($(root, ".voice-tag").textContent.trim(), "голосом");
});

// ---- Настройки: frame 8 -----------------------------------------------------------------

const vrow = (root, title) => [...root.querySelectorAll(".voice-card .set-row")].find((r) => r.querySelector(".row-title")?.textContent === title);

test("Настройки → «Голосовой режим»: голос, скорость, пауза, короткие ответы, образец; values persist in prefs.voice", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/voice", reply: () => VOICE_INFO },
    { method: "POST", path: "/zai/api/voice/tts", reply: () => ({ status: 503, body: { error: "Голосовой сервис недоступен", code: "unavailable" } }) },
  ]);
  ui.store.me.value = { id: "u_v", name: "Тенант", role: "user" };
  // FEAT-03.23: раздел #/settings/voice
  const { root } = t$.mount(ui.SettingsView, { section: "voice" });
  await t$.waitFor(() => $(root, ".voice-card"));
  assert.equal($(root, ".voice-card .row-title").textContent, "Голосовой режим");
  const voices = vrow(root, "Голос");
  assert.deepEqual($$(voices, ".seg-btn").map((b) => b.textContent), ["Ирина", "Денис"]);
  assert.equal(byText(voices, ".seg-btn", "Ирина").getAttribute("aria-checked"), "true", "default irina");
  assert.deepEqual($$(vrow(root, "Скорость речи"), ".seg-btn").map((b) => b.textContent), ["0,8×", "1,0×", "1,2×", "1,4×"]);
  assert.deepEqual($$(vrow(root, "Отправлять после паузы"), ".seg-btn").map((b) => b.textContent), ["0,8 с", "1,2 с", "1,6 с", "2,0 с"]);
  assert.equal(byText(vrow(root, "Отправлять после паузы"), ".seg-btn", "1,2").getAttribute("aria-checked"), "true");
  const sw = $(vrow(root, "Короткие ответы голосом"), 'button[role="switch"]');
  assert.equal(sw.getAttribute("aria-checked"), "true", "short answers on by default");

  t$.click(byText(voices, ".seg-btn", "Денис"));
  t$.click(byText(vrow(root, "Скорость речи"), ".seg-btn", "1,2×"));
  t$.click(byText(vrow(root, "Отправлять после паузы"), ".seg-btn", "2,0"));
  t$.click(sw);
  assert.deepEqual(ui.store.prefs.value.voice, { voice: "denis", rate: 1.2, pauseMs: 2000, shortAnswers: false });
  assert.equal(JSON.parse(localStorage.getItem("zai.prefs") ?? "{}").voice?.voice, "denis", "persisted");
  assert.equal(byText(vrow(root, "Голос"), ".seg-btn", "Денис").getAttribute("aria-checked"), "true");

  const sample = vrow(root, "Прослушать образец");
  assert.match(sample.textContent, /Привет! Так звучит мой голос\./);
  t$.click($(sample, "button"));
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "POST" && c.path === "/zai/api/voice/tts"));
  const tts = fetchCalls.find((c) => c.path === "/zai/api/voice/tts");
  assert.deepEqual(tts.body, { text: "Привет! Так звучит мой голос.", voice: "denis", rate: 1.2 });
});

test("Настройки: GET /voice enabled:false → no «Голосовой режим» section", async () => {
  installFetch([{ method: "GET", path: "/zai/api/voice", reply: () => ({ enabled: false, voices: [], stt: false }) }]);
  ui.store.me.value = { id: "u_w", name: "Т", role: "user" };
  const { root } = t$.mount(ui.SettingsView);
  await t$.waitFor(() => ui.store.voiceInfo.value);
  await t$.flush(2);
  assert.equal($(root, ".voice-card"), null);
});
