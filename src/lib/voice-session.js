// FEAT-06.2 voice mode — the controller of one open voice mode: microphone →
// VAD → background STT (server GigaAM, Web Speech fallback) → the machine →
// send() into the open chat (its engine/model/agent, + the hidden hint) →
// the answer as it streams → sentences → TTS (server Piper, speechSynthesis
// fallback) → speakers → listening again.
//
// createVoiceSession({sessionId, ctx, prefs, info, onChange}) →
//   {snapshot, level, voiceLabel, toggleMute, interrupt, stopTurn, retry, close}
// The component (VoiceModeView) only renders snapshots and calls actions.
import { effect } from "@preact/signals";
import { active, send, stop as stopTurnInStore, voiceApi } from "./store.js";
import { createRecognizer, isMicError, speechSupported } from "./voice.js";
import { t } from "./i18n.js";
import { answerText, capitalize, createSentenceSegmenter, voiceHintPart } from "./voice-text.js";
import { createVad } from "./voice-vad.js";
import { createSpeechQueue, createVoiceMachine } from "./voice-machine.js";
import { browserTtsSupported, cancelBrowserTts, createPlayer, speakBrowser, startCapture } from "./voice-audio.js";

const isSafari = () => {
  const ua = String(globalThis.navigator?.userAgent ?? "");
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|CriOS\/|FxiOS\//.test(ua);
};

// Server error → machine error kind (null = fall back to the browser engine).
function errorKind(err) {
  if (err?.name === "AbortError") return "abort";
  const st = Number(err?.status) || 0;
  if (st === 429 || err?.body?.code === "quota") return "quota";
  if (st === 503) return null; // unavailable / parked / failed → browser engine
  if (!st) return "network";
  return "network";
}

export function createVoiceSession({ sessionId, ctx = null, prefs = {}, info = null, onChange = () => {} } = {}) {
  const voice = prefs.voice || info?.defaultVoice || "irina";
  const rate = Number(prefs.rate) || 1;
  let sttMode = info?.stt ? "server" : speechSupported() ? "browser" : "none";
  let ttsMode = info?.enabled ? "server" : browserTtsSupported() ? "browser" : "text";
  let closed = false;
  let capture = null;
  const player = ctx ? createPlayer(ctx) : null;

  // ---- the machine ------------------------------------------------------
  const machine = createVoiceMachine({
    send: (text) => sendUtterance(text),
    stopTurn: () => stopTurnInStore(),
    stopPlayback: () => {
      queue.clear();
      player?.stop();
      cancelBrowserTts();
    },
    onChange: (snap) => {
      if (!closed || snap.phase === "closed") onChange(snap);
    },
    onPhase: (phase, prev) => {
      // A fresh utterance after the turn: forget what the VAD half-heard while
      // the mode was busy (barge-in keeps it — that speech is the new turn).
      if (phase === "sending" || (phase === "listening" && prev !== "speaking")) {
        vad.reset();
        held = [];
        if (phase === "listening") utt = { pieces: [], texts: [] };
      }
      syncBrowserStt();
    },
  });

  // ---- speech queue ------------------------------------------------------
  async function synth(text, signal) {
    if (ttsMode === "server" && player) {
      try {
        const bytes = await voiceApi.tts({ text, voice, rate }, { signal });
        return { buffer: await player.decode(bytes) };
      } catch (err) {
        const kind = errorKind(err);
        if (kind) throw err;
        ttsMode = browserTtsSupported() ? "browser" : "text"; // 503: keep talking with the system voice
      }
    }
    return { text };
  }
  async function play(audio, signal) {
    if (audio.buffer && player) return player.play(audio.buffer, signal);
    if (ttsMode === "browser") return speakBrowser(audio.text, { rate, signal });
    // No voice at all: the subtitle stays up for a reading pause.
    await new Promise((r) => {
      const t = setTimeout(r, Math.min(6000, 400 + audio.text.length * 55));
      signal?.addEventListener?.("abort", () => (clearTimeout(t), r()), { once: true });
    });
  }
  const queue = createSpeechQueue({
    synth,
    play,
    onStart: (text) => machine.speakStart(text),
    onIdle: () => machine.speakIdle(),
    onError: (err) => {
      const kind = errorKind(err);
      if (kind && kind !== "abort") machine.fail(kind);
    },
  });

  // ---- sending + watching the answer ------------------------------------
  let watch = null; // {known:Set, seg, sawBusy, lastText, done}
  let stopWatch = null;

  function sendUtterance(text) {
    const act = active.peek();
    if (!act || act.id !== sessionId) return Promise.resolve(false);
    watch = { known: new Set(act.messages.map((m) => m.info?.id)), seg: createSentenceSegmenter(), lastText: "", sawBusy: false, done: false };
    const p = send({ text, sessionId, hidden: [voiceHintPart(prefs.shortAnswers !== false)] });
    return Promise.resolve(p).then((ok) => {
      if (!ok && watch) watch.done = true;
      return ok !== false;
    });
  }

  function onActive(act) {
    if (closed || !watch || watch.done || !act || act.id !== sessionId) return;
    const busy = act.status === "busy" || act.status === "stopping";
    if (busy) watch.sawBusy = true;
    const text = answerText(act.messages, watch.known);
    if (text !== watch.lastText) {
      watch.lastText = text;
      for (const s of watch.seg.push(text)) if (!machine.silenced) queue.enqueue(s);
    }
    if (busy) machine.action(act.lastAction?.label ?? null);
    if (!busy && watch.sawBusy) {
      watch.done = true;
      for (const s of watch.seg.flush(text)) if (!machine.silenced) queue.enqueue(s);
      machine.turnEnd({
        error: act.turnError ? t("voice.error.turnSuffix", { title: act.turnError.title }) : null,
        empty: !text.trim(),
        pending: queue.busy,
      });
    }
  }

  // ---- listening: VAD + server STT --------------------------------------
  // The utterance being recognized: one promise per piece (in order) and
  // the texts that are back so far (the live subtitle).
  let utt = { pieces: [], texts: [] };
  let held = []; // pieces heard while the answer plays (sent on barge-in)
  const vad = createVad({
    pauseMs: Number(prefs.pauseMs) || 1200,
    onSegment: (pcm) => {
      if (sttMode !== "server" || machine.muted) return;
      if (machine.phase === "listening") recognize(pcm);
      else if (machine.phase === "speaking") held.push(pcm);
    },
    onUtteranceEnd: () => {
      held = [];
      if (sttMode !== "server") return;
      const { pieces } = utt;
      utt = { pieces: [], texts: [] };
      if (machine.phase !== "listening" || pieces.length === 0) return;
      machine.endOfSpeech();
      Promise.all(pieces).then((texts) => {
        if (closed || machine.phase !== "sending") return;
        machine.utterance(capitalize(texts.filter(Boolean).join(" ")));
      });
    },
  });

  function recognize(pcm) {
    const mine = utt;
    const i = mine.pieces.length;
    const p = voiceApi
      .stt(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
      .then((r) => String(r?.text ?? "").trim())
      .catch((err) => {
        const kind = errorKind(err);
        if (kind === null) {
          // 503: the server engine is gone — the browser takes over.
          sttMode = speechSupported() ? "browser" : "none";
          if (sttMode === "none") machine.fail("stt");
          else syncBrowserStt();
        } else if (kind !== "abort") machine.fail(kind);
        return "";
      });
    mine.pieces.push(p);
    p.then((text) => {
      mine.texts[i] = text;
      if (mine === utt && machine.phase === "listening") machine.heard(capitalize(mine.texts.filter(Boolean).join(" ")));
    });
  }

  function onFrame(frame) {
    if (closed || machine.muted) return;
    vad.push(frame);
    if (machine.phase === "speaking" && vad.inSpeech && machine.speech(vad.voicedMs)) {
      // Barge-in: what was heard over the answer is the start of the new utterance.
      if (sttMode === "server") {
        const h = held;
        held = [];
        for (const pcm of h) recognize(pcm);
      }
    }
  }

  // ---- listening: browser STT fallback ----------------------------------
  let rec = null;
  let recText = "";
  let pauseTimer = 0;
  function syncBrowserStt() {
    const want = !closed && sttMode === "browser" && machine.phase === "listening" && !machine.muted;
    if (want && !rec) {
      recText = "";
      rec = createRecognizer({
        onPartial: (committed, interim) => {
          recText = `${committed} ${interim}`.trim();
          machine.heard(capitalize(recText));
          clearTimeout(pauseTimer);
          pauseTimer = setTimeout(() => {
            if (!recText || machine.phase !== "listening") return;
            const t = capitalize(recText);
            stopRec();
            machine.endOfSpeech();
            machine.utterance(t);
          }, Number(prefs.pauseMs) || 1200);
        },
        onError: (msg, code) => {
          rec = null;
          if (isMicError(code)) machine.fail("mic", micText());
          else machine.fail("network", { text: msg });
        },
        onEnd: () => {
          rec = null;
        },
      });
      rec?.start();
    } else if (!want && rec) stopRec();
  }
  function stopRec() {
    clearTimeout(pauseTimer);
    const r = rec;
    rec = null;
    recText = "";
    try {
      r?.abort();
    } catch {}
  }

  const micText = () => (isSafari() ? {} : { text: t("voice.error.micBrowser") });

  async function openMic() {
    try {
      capture?.stop();
      capture = await startCapture(ctx, { onFrame });
      if (closed) {
        capture.stop();
        return;
      }
      capture.setEnabled(!machine.muted);
      if (sttMode === "none") machine.fail("stt");
      // BUG-225: machine.start() фазу не меняет — распознавание браузера запускаем здесь,
      // иначе сессия показывала «Слушаю…» с несозданным распознавателем
      else syncBrowserStt();
    } catch (err) {
      capture = null;
      if (closed) return;
      machine.fail(err?.code === "mic" ? "mic" : "nomic", err?.code === "mic" ? micText() : {});
    }
  }

  // ---- start ------------------------------------------------------------
  machine.start();
  stopWatch = effect(() => onActive(active.value));
  openMic();

  return {
    snapshot: () => machine.snapshot(),
    get ttsMode() {
      return ttsMode;
    },
    voiceId: voice,
    // Orb level: the mic while listening, the voice while speaking; null =
    // the orb's own simulated envelope (thinking, browser voice).
    level(state) {
      if (state === "listen") return capture ? capture.level() : 0;
      if (state === "speak") return ttsMode === "server" && player ? player.level() : null;
      if (state === "mute" || state === "error") return 0;
      return null;
    },
    toggleMute() {
      const m = machine.toggleMute();
      capture?.setEnabled(!m);
      vad.reset();
      utt = { pieces: [], texts: [] };
      held = [];
      syncBrowserStt();
      return m;
    },
    interrupt: () => machine.interrupt(),
    stopTurn: () => machine.stop(),
    retry() {
      const kind = machine.retry();
      if (kind === "mic" || (kind && !capture)) openMic();
      syncBrowserStt();
    },
    close() {
      if (closed) return;
      machine.close();
      closed = true;
      stopWatch?.();
      stopRec();
      queue.clear();
      player?.stop();
      cancelBrowserTts();
      capture?.stop();
      capture = null;
      try {
        ctx?.suspend?.();
      } catch {}
    },
  };
}
