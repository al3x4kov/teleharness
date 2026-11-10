// FEAT-06.2 voice mode — pure logic: sentence segmenter + speech cleaner,
// VAD/pause segmenter on synthetic frames, resampler, the conversation state
// machine and the speech queue (fakes), voice prefs sanitizing, the hidden
// hint / «голосом» / «озвучено» marks, upsertPart with a synthetic placeholder.
// Run: node --test tests/voice-mode.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_HINT,
  VOICE_MARK,
  answerText,
  capitalize,
  cleanForSpeech,
  createSentenceSegmenter,
  isSpokenAnswer,
  isVoiceMessage,
  voiceHintPart,
} from "../src/lib/voice-text.js";
import { createFramer, createResampler, createVad, floatTo16, rms } from "../src/lib/voice-vad.js";
import { createSpeechQueue, createVoiceMachine, STATE_LABEL, VOICE_ERRORS } from "../src/lib/voice-machine.js";
import { orbStateOf, simLevel } from "../src/lib/voice-orb.js";
import { sanitizeVoicePrefs, voicePrefs } from "../src/lib/store/state.js";
import { firstUserText, upsertPart } from "../src/lib/normalize.js";
import { resendParts } from "../src/lib/turn.js";

const tick = () => new Promise((r) => setImmediate(r));

// ---- sentence segmenter ------------------------------------------------------

test("segmenter: streamed text → sentences once, as they complete", () => {
  const seg = createSentenceSegmenter();
  assert.deepEqual(seg.push("В сентябре выручка выросла"), []);
  assert.deepEqual(seg.push("В сентябре выручка выросла на 7 %, до 3,75 млн рублей."), []); // the next char decides
  assert.deepEqual(seg.push("В сентябре выручка выросла на 7 %, до 3,75 млн рублей. Основной"), [
    "В сентябре выручка выросла на 7 %, до 3,75 млн рублей.",
  ]);
  assert.deepEqual(seg.push("В сентябре выручка выросла на 7 %, до 3,75 млн рублей. Основной вклад дала Москва! Ещё"), [
    "Основной вклад дала Москва!",
  ]);
  assert.deepEqual(seg.flush("В сентябре выручка выросла на 7 %, до 3,75 млн рублей. Основной вклад дала Москва! Ещё вопросы?"), ["Ещё вопросы?"]);
});

test("segmenter: numbers, abbreviations, initials and file names are not sentence ends", () => {
  const seg = createSentenceSegmenter();
  const text =
    "Рост 3.75 процента, т. е. почти четыре. Файл sales.xlsx готов, см. Рис. 3 ниже. Автор А. С. Пушкин писал в 10 ч. утра. Итог… неплохой. Всё";
  assert.deepEqual(seg.push(text), [
    "Рост 3.75 процента, т. е. почти четыре.",
    "Файл sales.xlsx готов, см. Рис. 3 ниже.",
    "Автор А. С. Пушкин писал в 10 ч. утра.",
    "Итог… неплохой.",
  ]);
  assert.deepEqual(seg.flush(text), ["Всё"]);
});

test("segmenter + cleanForSpeech keep what the server normalizer reads out (FEAT-06.3)", () => {
  assert.deepEqual(createSentenceSegmenter().flush("Это г. Москва, ул. Ленина, д. 5, кв. 7. Там и встретимся."), [
    "Это г. Москва, ул. Ленина, д. 5, кв. 7.",
    "Там и встретимся.",
  ]);
  const c = cleanForSpeech("Скорость 23 км/ч, рост 12%, −5 °C, 3,75 млн ₽, №5, 100 м². Подробно: https://example.com/a", { final: true });
  assert.match(c, /23 км\/ч, рост 12%, −5 °C, 3,75 млн ₽, №5, 100 м²\./);
  assert.match(c, /Подробно: ссылка в чате$/);
});

test("BUG-167: «ссылка https://…» keeps one «ссылка»", () => {
  assert.match(cleanForSpeech("Вот ссылка https://example.com/a", { final: true }), /Вот ссылка в чате$/);
  assert.match(cleanForSpeech("Открой по ссылке: https://example.com/a", { final: true }), /Открой по ссылке в чате$/);
  assert.match(cleanForSpeech("Смотри https://example.com", { final: true }), /Смотри ссылка в чате$/);
});

test("segmenter: ? ! … with closing quotes, newlines end sentences, empty pieces dropped", () => {
  const seg = createSentenceSegmenter();
  const out = seg.flush("Он спросил: «Готово?» Да!\n\n— \nПервый пункт\nВторой пункт...");
  assert.deepEqual(out, ["Он спросил: «Готово?»", "Да!", "Первый пункт", "Второй пункт..."]);
});

test("segmenter: a long run without punctuation is cut at a comma near maxLen", () => {
  const seg = createSentenceSegmenter({ maxLen: 80 });
  const long = "раз два три четыре пять шесть семь восемь девять десять, одиннадцать двенадцать тринадцать четырнадцать пятнадцать";
  const out = seg.push(long);
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith("десять,"), out[0]);
  assert.deepEqual(seg.flush(long), ["одиннадцать двенадцать тринадцать четырнадцать пятнадцать"]);
});

test("segmenter: a long FIRST sentence is cut at its first clause (voice starts sooner); later ones are whole", () => {
  const s1 = "Париж известен как столица искусства и культуры — Лувр, Нотр-Дам, Версаль привлекают миллионы туристов.";
  const s2 = "Город славится революционной историей, элегантной архитектурой и романтичными улочками вдоль Сены.";
  const seg = createSentenceSegmenter();
  // Streaming: once the first sentence runs past 60 chars (BUG-166), its first clause goes out.
  assert.deepEqual(seg.push(s1.slice(0, 95)), ["Париж известен как столица искусства и культуры —"]);
  assert.deepEqual(seg.push(`${s1} ${s2} Ещё`), ["Лувр, Нотр-Дам, Версаль привлекают миллионы туристов.", s2]);
  // Whole text at once: the same split; a short first sentence stays whole.
  assert.deepEqual(createSentenceSegmenter().flush(`${s1} ${s2}`), ["Париж известен как столица искусства и культуры —", "Лувр, Нотр-Дам, Версаль привлекают миллионы туристов.", s2]);
  assert.deepEqual(createSentenceSegmenter().flush("Да, конечно. Это Париж."), ["Да, конечно.", "Это Париж."]);
});

test("cleanForSpeech: code blocks, tables, links, markup never reach the voice", () => {
  const md = "## Итог\n**Выручка** выросла. См. [отчёт](https://x.test/r).\n```js\nconst a = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n- пункт `один`\nhttps://example.com";
  const c = cleanForSpeech(md, { final: true });
  assert.ok(!/[`*#|]/.test(c), c);
  assert.match(c, /Выручка выросла/);
  assert.match(c, /См\. отчёт\./);
  assert.match(c, /Код — в чате\./);
  assert.match(c, /Таблица — в чате\./);
  assert.match(c, /пункт один/);
  assert.ok(!c.includes("const a"));
  assert.ok(!c.includes("example.com"));
});

test("segmenter: an unclosed code fence is never spoken half-way; closed → «Код — в чате.»", () => {
  const seg = createSentenceSegmenter();
  assert.deepEqual(seg.push("Вот пример.\n```js\nconst a = 1;"), ["Вот пример."]);
  assert.deepEqual(seg.push("Вот пример.\n```js\nconst a = 1;\nconsole.log(a);"), []);
  assert.deepEqual(seg.push("Вот пример.\n```js\nconst a = 1;\n```\nГотово. Дальше"), ["Код — в чате.", "Готово."]);
});

// ---- marks, answer text --------------------------------------------------------

test("voice hint: synthetic part, short/bare variants, «голосом»/«озвучено» derived from the feed", () => {
  assert.deepEqual(voiceHintPart(true), { type: "text", text: VOICE_HINT, synthetic: true });
  assert.deepEqual(voiceHintPart(false), { type: "text", text: VOICE_MARK, synthetic: true });
  assert.ok(VOICE_HINT.startsWith("[Голосовой режим] Отвечай на языке пользователя (по умолчанию по-русски), коротко и разговорно, 1–4 предложения")); // BUG-165
  const u = { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "Сколько?" }, voiceHintPart(true)] };
  const plain = { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "Текстом" }] };
  // A typed text that merely starts with the mark is not a voice message (not synthetic).
  const fake = { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: VOICE_HINT }] };
  const feed = [
    u,
    { info: { id: "a1", role: "assistant" }, parts: [] },
    { info: { id: "a2", role: "assistant" }, parts: [] },
    plain,
    { info: { id: "a3", role: "assistant" }, parts: [] },
  ];
  assert.equal(isVoiceMessage(u), true);
  assert.equal(isVoiceMessage(plain), false);
  assert.equal(isVoiceMessage(fake), false);
  assert.equal(isSpokenAnswer(feed, "a1"), true);
  assert.equal(isSpokenAnswer(feed, "a2"), true);
  assert.equal(isSpokenAnswer(feed, "a3"), false);
  assert.equal(isSpokenAnswer(feed, "u1"), false);
  assert.equal(isSpokenAnswer(feed, "nope"), false);
  // The hint is never the user's words: first text / resend skip it.
  assert.equal(firstUserText([u]), "Сколько?");
  assert.deepEqual(resendParts(u), [{ type: "text", text: "Сколько?" }]);
});

test("answerText: only new assistant TEXT parts (no reasoning/tools/synthetic), in order", () => {
  const msgs = [
    { info: { id: "a0", role: "assistant" }, parts: [{ type: "text", text: "старый ответ" }] },
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "вопрос" }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "reasoning", text: "думаю" }, { type: "text", text: "Сейчас прочитаю." }, { type: "tool", tool: "read" }] },
    { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "служебное", synthetic: true }, { type: "text", text: "Готово." }] },
  ];
  assert.equal(answerText(msgs, new Set(["a0", "u1"])), "Сейчас прочитаю.\n\nГотово.");
  assert.equal(capitalize("  привет  как дела "), "Привет как дела");
  assert.equal(capitalize(""), "");
});

test("upsertPart: the synthetic placeholder is replaced only by the synthetic server part", () => {
  const msg = { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "Привет" }, voiceHintPart(true)] };
  // The hint arrives first — it must not take the typed text's place.
  let m = upsertPart(msg, { id: "p2", type: "text", text: VOICE_HINT, synthetic: true });
  m = upsertPart(m, { id: "p1", type: "text", text: "Привет" });
  assert.deepEqual(
    m.parts.map((p) => [p.id, p.text, !!p.synthetic]),
    [["p1", "Привет", false], ["p2", VOICE_HINT, true]],
  );
});

// ---- VAD ----------------------------------------------------------------------

const FR = 320; // 20 ms
const noise = (amp) => Float32Array.from({ length: FR }, (_, i) => amp * Math.sin(i * 1.7) * 0.5);
const voice = (amp = 0.2) => Float32Array.from({ length: FR }, (_, i) => amp * Math.sin((i * 2 * Math.PI * 220) / 16000) * 1.4);
function feed(vad, gen, ms) {
  for (let t = 0; t < ms; t += 20) vad.push(gen());
}

test("VAD: speech start, pieces cut at short pauses, utterance end at pauseMs", () => {
  const ev = [];
  const vad = createVad({
    pauseMs: 1200,
    onSpeechStart: () => ev.push(["start"]),
    onSegment: (pcm, m) => ev.push(["seg", m.index, pcm.length]),
    onUtteranceEnd: (r) => ev.push(["end", r.segments, r.reason]),
  });
  feed(vad, () => noise(0.002), 500); // quiet room: the floor settles
  feed(vad, () => voice(), 600); // «первая часть»
  assert.deepEqual(ev[0], ["start"]);
  feed(vad, () => noise(0.002), 400); // short pause → piece 0
  assert.equal(ev.filter((e) => e[0] === "seg").length, 1);
  feed(vad, () => voice(), 500); // «вторая часть»
  feed(vad, () => noise(0.002), 1100); // piece 1 at 350 ms, no end yet
  assert.equal(ev.filter((e) => e[0] === "seg").length, 2);
  assert.equal(ev.some((e) => e[0] === "end"), false);
  feed(vad, () => noise(0.002), 200); // 1300 ms of silence → end
  const end = ev.find((e) => e[0] === "end");
  assert.deepEqual(end, ["end", 2, "pause"]);
  const segs = ev.filter((e) => e[0] === "seg");
  assert.deepEqual(segs.map((e) => e[1]), [0, 1]);
  assert.ok(segs[0][2] >= 0.6 * 16000, "piece 0 holds its speech (+ pre-roll)");
});

test("VAD: clicks are not speech; the threshold adapts to a noisy room", () => {
  const ev = [];
  const vad = createVad({ onSpeechStart: () => ev.push("start"), onUtteranceEnd: () => ev.push("end") });
  feed(vad, () => noise(0.002), 400);
  vad.push(voice(0.3)); // 20 ms click
  feed(vad, () => noise(0.002), 400);
  assert.deepEqual(ev, []);
  const quiet = vad.threshold;
  feed(vad, () => noise(0.03), 3000); // fan noise: the floor rises
  assert.ok(vad.threshold > quiet, `${vad.threshold} > ${quiet}`);
  assert.deepEqual(ev, [], "steady noise never starts an utterance");
});

test("VAD: max utterance 60 s, reset drops the utterance, voicedMs grows while speaking", () => {
  const ends = [];
  const vad = createVad({ maxUtteranceMs: 3000, maxSegmentMs: 1000, onUtteranceEnd: (r) => ends.push(r) , onSegment: () => {} });
  feed(vad, () => noise(0.002), 200);
  feed(vad, () => voice(), 400);
  assert.ok(vad.inSpeech && vad.voicedMs >= 300);
  vad.reset();
  assert.equal(vad.inSpeech, false);
  assert.equal(vad.voicedMs, 0);
  feed(vad, () => voice(), 3500);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, "max");
  assert.ok(ends[0].segments >= 2, "long speech is cut into ≤ maxSegmentMs pieces");
});

test("resampler 48k→16k / 44.1k→16k keeps the length; framer; int16; rms", () => {
  const r48 = createResampler(48000, 16000);
  let n = 0;
  for (let i = 0; i < 10; i++) n += r48(new Float32Array(4800).fill(0.5)).length;
  assert.equal(n, 16000);
  const r44 = createResampler(44100, 16000);
  let m = 0;
  for (let i = 0; i < 10; i++) m += r44(new Float32Array(4410)).length;
  assert.ok(Math.abs(m - 16000) <= 1, String(m));
  assert.ok(Math.abs(r48(new Float32Array(48).fill(0.5))[0] - 0.5) < 1e-6);
  const frames = [];
  const fr = createFramer(320, (f) => frames.push(f.length));
  fr.push(new Float32Array(500));
  fr.push(new Float32Array(500));
  assert.deepEqual(frames, [320, 320, 320]);
  assert.deepEqual([...floatTo16(Float32Array.from([0, 1, -1, 2]))], [0, 32767, -32768, 32767]);
  assert.ok(Math.abs(rms(Float32Array.from([0.5, -0.5])) - 0.5) < 1e-9);
});

// ---- state machine -------------------------------------------------------------

function rig({ sendOk = true } = {}) {
  let clock = 1000;
  const log = [];
  const snaps = [];
  const m = createVoiceMachine({
    send: async (t) => (log.push(["send", t]), sendOk),
    stopTurn: () => log.push(["stopTurn"]),
    stopPlayback: () => log.push(["stopPlayback"]),
    onChange: (s) => snaps.push(s),
    now: () => clock,
  });
  return { m, log, snaps, advance: (ms) => (clock += ms) };
}

test("machine: listening → sending → thinking → speaking → listening (hands-free loop)", async () => {
  const { m, log } = rig();
  m.start();
  assert.equal(m.state, "listening");
  m.heard("Какая столица");
  assert.equal(m.snapshot().heard, "Какая столица");
  assert.equal(m.endOfSpeech(), true);
  assert.equal(m.state, "sending");
  await m.utterance("Какая столица Франции?");
  assert.deepEqual(log, [["send", "Какая столица Франции?"]]);
  assert.equal(m.state, "thinking");
  m.action("читает файл");
  assert.equal(m.snapshot().action, "читает файл");
  assert.equal(m.speakStart("Париж."), true);
  assert.equal(m.state, "speaking");
  assert.equal(m.snapshot().subtitle, "Париж.");
  m.speakIdle(); // the turn still runs → thinking between sentences
  assert.equal(m.state, "thinking");
  m.speakStart("Это всё.");
  m.turnEnd({ pending: true });
  assert.equal(m.state, "speaking", "the queue is heard out");
  m.speakIdle();
  assert.equal(m.state, "listening");
  assert.equal(STATE_LABEL[m.state], "Слушаю…");
});

test("machine: empty utterance keeps listening; mute shows «Микрофон выключен» and blocks sending", async () => {
  const { m, log } = rig();
  m.start();
  m.endOfSpeech();
  await m.utterance("   ");
  assert.equal(m.state, "listening");
  assert.equal(m.toggleMute(), true);
  assert.equal(m.state, "muted");
  assert.equal(STATE_LABEL.muted, "Микрофон выключен");
  assert.equal(m.endOfSpeech(), false);
  await m.utterance("ещё");
  assert.deepEqual(log, []);
  m.toggleMute();
  assert.equal(m.state, "listening");
});

test("machine: barge-in needs ≥300 ms of speech and ignores the first 300 ms of playback", async () => {
  const { m, log, advance } = rig();
  m.start();
  await m.utterance("Расскажи");
  m.speakStart("Первое предложение.");
  assert.equal(m.speech(800), false, "echo right at playback start is ignored");
  advance(400);
  assert.equal(m.speech(200), false, "too short");
  assert.equal(m.speech(320), true);
  assert.equal(m.state, "listening");
  assert.ok(m.silenced, "the rest of the interrupted turn is not spoken");
  assert.deepEqual(log.at(-1), ["stopPlayback"]);
  assert.equal(m.speakStart("Второе."), false);
  assert.equal(log.some((e) => e[0] === "stopTurn"), false, "barge-in does not abort the turn");
});

test("machine: «Перебить» stops playback; «Стоп» aborts the turn via stopTurn", async () => {
  const { m, log } = rig();
  m.start();
  await m.utterance("Вопрос");
  m.speakStart("Ответ.");
  m.interrupt();
  assert.equal(m.state, "listening");
  await m.utterance("Другой вопрос");
  assert.equal(m.silenced, false, "a new turn speaks again");
  assert.equal(m.state, "thinking");
  m.stop();
  assert.deepEqual(log.slice(-2), [["stopPlayback"], ["stopTurn"]]);
  assert.equal(m.state, "listening");
  m.turnEnd({ error: "Ход прервался" }); // the aborted turn's end is not an error face
  assert.equal(m.state, "listening");
});

test("machine: errors — send failed, turn failed, empty answer; «Повторить» resends; never closes itself", async () => {
  const r1 = rig({ sendOk: false });
  r1.m.start();
  await r1.m.utterance("Привет");
  assert.equal(r1.m.state, "error");
  assert.equal(r1.m.snapshot().error.title, VOICE_ERRORS.send.title);

  const { m, log } = rig();
  m.start();
  await m.utterance("Привет");
  m.turnEnd({ error: "Модель недоступна. Нажмите «Повторить»." });
  assert.equal(m.state, "error");
  assert.equal(m.snapshot().error.title, "Ход прервался");
  assert.equal(m.snapshot().error.text, "Модель недоступна. Нажмите «Повторить».");
  assert.equal(m.retry(), "resend");
  await tick();
  assert.deepEqual(log.filter((e) => e[0] === "send"), [["send", "Привет"], ["send", "Привет"]]);
  assert.equal(m.state, "thinking");
  m.turnEnd({ empty: true });
  assert.equal(m.state, "error");
  assert.equal(m.snapshot().error.title, "Пустой ответ");

  m.fail("mic");
  assert.equal(m.snapshot().error.title, "Нет доступа к микрофону");
  assert.equal(m.snapshot().error.text, "Разрешите микрофон для сайта: Настройки → Safari → Микрофон");
  assert.equal(m.retry(), "mic");
  assert.equal(m.state, "listening");
  m.fail("quota");
  assert.equal(m.snapshot().error.title, "Дневной лимит голосового режима исчерпан");
  m.close();
  assert.equal(m.state, "closed");
  m.fail("network");
  assert.equal(m.state, "closed");
});

// ---- speech queue -----------------------------------------------------------------

test("speech queue: plays in order, prefetches the next sentence while one plays, clear() stops", async () => {
  const ev = [];
  const plays = [];
  const q = createSpeechQueue({
    synth: async (t) => (ev.push(`synth:${t}`), `wav:${t}`),
    play: (a) => new Promise((res) => plays.push({ a, res })),
    onStart: (t) => ev.push(`start:${t}`),
    onIdle: () => ev.push("idle"),
  });
  q.enqueue("Раз.");
  q.enqueue("Два.");
  q.enqueue("Три.");
  await tick();
  await tick();
  assert.deepEqual(ev, ["synth:Раз.", "synth:Два.", "start:Раз."]);
  assert.equal(plays.length, 1);
  plays[0].res();
  await tick();
  await tick();
  assert.ok(ev.includes("start:Два.") && ev.includes("synth:Три."), ev.join(","));
  q.clear();
  plays[1].res();
  await tick();
  assert.equal(ev.includes("start:Три."), false);
  assert.equal(q.busy, false);
});

test("speech queue: a synthesis error clears the queue and reports once", async () => {
  const errs = [];
  let idle = 0;
  const q = createSpeechQueue({
    synth: async (t) => {
      if (t === "Два.") throw Object.assign(new Error("quota"), { status: 429 });
      return t;
    },
    play: async () => {},
    onError: (e, t) => errs.push([e.status, t]),
    onIdle: () => (idle += 1),
  });
  q.enqueue("Раз.");
  q.enqueue("Два.");
  q.enqueue("Три.");
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(errs, [[429, "Два."]]);
  assert.equal(q.busy, false);
  assert.ok(idle >= 1);
});

// ---- orb + prefs ---------------------------------------------------------------------

test("orb: states map to the concept's five faces; simulated envelope stays in 0..1", () => {
  assert.equal(orbStateOf("listening"), "listen");
  assert.equal(orbStateOf("sending"), "think");
  assert.equal(orbStateOf("thinking"), "think");
  assert.equal(orbStateOf("speaking"), "speak");
  assert.equal(orbStateOf("muted"), "mute");
  assert.equal(orbStateOf("error"), "error");
  for (let t = 0; t < 20; t += 0.37) {
    for (const s of ["listen", "think", "speak", "mute", "error"]) {
      const v = simLevel(s, t);
      assert.ok(v >= 0 && v <= 1, `${s}@${t}=${v}`);
    }
  }
  assert.equal(simLevel("mute", 3), 0);
});

test("prefs.voice: sanitized to the Настройки choices, short answers on by default", () => {
  assert.deepEqual(sanitizeVoicePrefs(undefined), { voice: null, rate: 1, pauseMs: 1200, shortAnswers: true });
  assert.deepEqual(sanitizeVoicePrefs({ voice: "denis", rate: 1.4, pauseMs: 2000, shortAnswers: false }), {
    voice: "denis",
    rate: 1.4,
    pauseMs: 2000,
    shortAnswers: false,
  });
  assert.deepEqual(sanitizeVoicePrefs({ voice: "../x", rate: 9, pauseMs: 5, shortAnswers: "no" }), {
    voice: null,
    rate: 1,
    pauseMs: 1200,
    shortAnswers: true,
  });
  assert.deepEqual(voicePrefs({ voice: { rate: "1.2" } }), { voice: null, rate: 1.2, pauseMs: 1200, shortAnswers: true });
});

test("BUG-166: an 85-char first sentence is cut at its first clause (prod: 2.3 s before the voice)", () => {
  const s1 = "Париж славится своей архитектурой — Эйфелева башня, Нотр-Дам, дворцы вдоль Сены.";
  assert.deepEqual(createSentenceSegmenter().flush(s1), ["Париж славится своей архитектурой —", "Эйфелева башня, Нотр-Дам, дворцы вдоль Сены."]);
  assert.deepEqual(createSentenceSegmenter().flush("Берлин."), ["Берлин."]);
});
