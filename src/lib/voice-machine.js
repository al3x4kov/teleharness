// FEAT-06.2 voice mode — the conversation state machine and the speech queue.
// Pure (Node-importable): every side effect is an injected function, so the
// tests drive it with fakes.
//
//   listening → sending → thinking → speaking → listening   (hands-free loop)
//   + muted (a flag: listening while muted shows «Микрофон выключен»; a
//     playing answer is heard out), error (never closes by itself), closed.
//
// sending = the utterance ended: waiting for the last recognized piece and
// the POST of the prompt. thinking = the turn runs (tool actions in the
// subtitle). speaking = a sentence plays; between sentences of a turn that is
// still running the face goes back to thinking.
// Barge-in: the user speaks ≥ bargeInMs while a sentence plays, the first
// ignoreMs of each playback ignored (speaker echo) → playback stops, the rest
// of that turn stays silent (its text is in the chat), listening again.
// «Стоп» (thinking/speaking) aborts the turn through the store's stop().

import { t } from "./i18n.js";

// Titles/texts/labels are getters: resolved in the active UI language on read.
const ERROR_RETRY = { mic: "mic", nomic: "mic", stt: "listen", network: "listen", quota: "listen", send: "resend", turn: "resend", empty: "resend" };
export const VOICE_ERRORS = Object.freeze(
  Object.fromEntries(
    Object.entries(ERROR_RETRY).map(([kind, retry]) => [
      kind,
      Object.freeze({
        get title() {
          return t(`voice.error.${kind}.title`);
        },
        get text() {
          return t(`voice.error.${kind}.text`);
        },
        retry,
      }),
    ]),
  ),
);

const STATE_KEY = {
  listening: "voice.state.listening",
  sending: "voice.state.thinking",
  thinking: "voice.state.thinking",
  speaking: "voice.state.speaking",
  muted: "voice.state.muted",
};
export const STATE_LABEL = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(Object.entries(STATE_KEY).map(([st, key]) => [st, { get: () => t(key), enumerable: true }])),
  ),
);

export function createVoiceMachine({
  send = async () => true,
  stopTurn = () => {},
  stopPlayback = () => {},
  onChange = () => {},
  onPhase = () => {},
  now = () => Date.now(),
  bargeInMs = 300,
  ignoreMs = 300,
} = {}) {
  const s = {
    phase: "listening",
    muted: false,
    heard: "", // what was recognized (live while listening, the sent text later)
    subtitle: "", // the sentence being spoken
    action: null, // the turn's last tool action label
    error: null, // {kind, title, text, retry}
  };
  let playingSince = 0;
  let turnDone = true;
  let playing = false;
  let silenced = false; // interrupted: the rest of this turn is not spoken
  let spokeAny = false;
  let lastUtterance = "";
  let sendSeq = 0;

  const snapshot = () => ({ ...s, state: s.phase === "listening" && s.muted ? "muted" : s.phase });
  const emit = () => onChange(snapshot());
  function setPhase(p) {
    const prev = s.phase;
    s.phase = p;
    if (p !== prev) onPhase(p, prev);
  }

  function toListening() {
    playing = false;
    s.heard = "";
    s.subtitle = "";
    s.action = null;
    setPhase("listening");
    emit();
  }

  async function doSend(text) {
    const seq = ++sendSeq;
    lastUtterance = text;
    s.heard = text;
    s.subtitle = "";
    s.action = null;
    s.error = null;
    turnDone = false;
    silenced = false;
    spokeAny = false;
    playing = false;
    setPhase("sending");
    emit();
    let ok = false;
    try {
      ok = await send(text);
    } catch {
      ok = false;
    }
    if (seq !== sendSeq || s.phase === "closed") return ok;
    if (!ok) {
      turnDone = true;
      fail("send");
      return false;
    }
    if (s.phase === "sending") {
      setPhase("thinking");
      emit();
    }
    return true;
  }

  function fail(kind, override = {}) {
    if (s.phase === "closed") return;
    const base = VOICE_ERRORS[kind] ?? VOICE_ERRORS.network;
    s.error = { kind, ...base, ...override };
    playing = false;
    silenced = true;
    try {
      stopPlayback();
    } catch {}
    setPhase("error");
    emit();
  }

  const api = {
    get state() {
      return snapshot().state;
    },
    get phase() {
      return s.phase;
    },
    get muted() {
      return s.muted;
    },
    // true while the current turn must not be spoken (interrupted / failed).
    get silenced() {
      return silenced;
    },
    get lastUtterance() {
      return lastUtterance;
    },
    snapshot,
    start() {
      s.error = null;
      toListening();
    },
    // Live recognition text while listening.
    heard(text) {
      if (s.phase !== "listening") return;
      s.heard = String(text ?? "");
      emit();
    },
    // The utterance ended (pause): the last piece is being recognized.
    endOfSpeech() {
      if (s.phase !== "listening" || s.muted) return false;
      setPhase("sending");
      emit();
      return true;
    },
    // The recognized utterance: empty → keep listening; else → send.
    utterance(text) {
      const t = String(text ?? "").trim();
      if (s.phase !== "listening" && s.phase !== "sending") return Promise.resolve(false);
      if (!t || s.muted) {
        s.heard = "";
        toListening();
        return Promise.resolve(false);
      }
      return doSend(t);
    },
    action(label) {
      if (s.phase !== "thinking" && s.phase !== "sending") return;
      if (s.action === (label ?? null)) return;
      s.action = label ?? null;
      emit();
    },
    // A sentence starts playing.
    speakStart(sentence) {
      if (silenced || (s.phase !== "thinking" && s.phase !== "sending" && s.phase !== "speaking")) return false;
      playing = true;
      spokeAny = true;
      playingSince = now();
      s.subtitle = String(sentence ?? "");
      setPhase("speaking");
      emit();
      return true;
    },
    // The speech queue is empty.
    speakIdle() {
      playing = false;
      if (s.phase !== "speaking") return;
      if (turnDone) toListening();
      else {
        s.subtitle = "";
        setPhase("thinking");
        emit();
      }
    },
    // The turn is over. pending = sentences still queued/playing.
    turnEnd({ error = null, empty = false, pending = false } = {}) {
      turnDone = true;
      if (s.phase !== "sending" && s.phase !== "thinking" && s.phase !== "speaking") return;
      if (error && !spokeAny) return fail("turn", typeof error === "string" ? { text: error } : {});
      if (empty && !spokeAny && !pending) return fail("empty");
      if (!pending && !playing) toListening();
    },
    // VAD: voiced time of the current utterance → barge-in? (true = done)
    speech(voicedMs) {
      if (s.phase !== "speaking" || s.muted || !playing) return false;
      if (now() - playingSince < ignoreMs || voicedMs < bargeInMs) return false;
      api.interrupt();
      return true;
    },
    // «Перебить» / tap on the orb / barge-in.
    interrupt() {
      if (s.phase !== "speaking" && !(s.phase === "thinking" && spokeAny)) return;
      silenced = true;
      try {
        stopPlayback();
      } catch {}
      s.heard = "";
      toListening();
    },
    // «Стоп»: abort the turn.
    stop() {
      if (s.phase !== "thinking" && s.phase !== "sending" && s.phase !== "speaking") return;
      silenced = true;
      turnDone = true;
      try {
        stopPlayback();
      } catch {}
      try {
        stopTurn();
      } catch {}
      s.heard = "";
      toListening();
    },
    toggleMute() {
      if (s.phase === "closed") return s.muted;
      s.muted = !s.muted;
      emit();
      return s.muted;
    },
    fail,
    // «Повторить»: the error's own way back. → the retry kind.
    retry() {
      if (s.phase !== "error") return null;
      const kind = s.error?.retry ?? "listen";
      s.error = null;
      if (kind === "resend" && lastUtterance) {
        doSend(lastUtterance);
        return kind;
      }
      s.heard = "";
      toListening();
      return kind;
    },
    close() {
      if (s.phase === "closed") return;
      silenced = true;
      playing = false;
      try {
        stopPlayback();
      } catch {}
      setPhase("closed");
      emit();
    },
  };
  return api;
}

// Sentence → audio → playback, in order. While one sentence plays the next
// one is already being synthesized (prefetch), so the gap between sentences
// is the decode time, not the synthesis time.
//   synth(text, signal) → Promise<audio>; play(audio, signal) → Promise<void>
//   onStart(text) — a sentence starts; onIdle() — the queue ran dry;
//   onError(err, text) — synthesis/playback failed (the queue is cleared).
export function createSpeechQueue({ synth, play, onStart = () => {}, onIdle = () => {}, onError = () => {}, prefetch = 1 } = {}) {
  let items = [];
  let playing = false;
  let gen = 0;
  let ctl = typeof AbortController === "function" ? new AbortController() : null;

  function fill() {
    // While a sentence plays, `prefetch` more are synthesized; idle — one more.
    const ahead = playing ? prefetch : prefetch + 1;
    for (let i = 0; i < Math.min(items.length, ahead); i += 1) {
      const it = items[i];
      if (!it.audio) {
        it.audio = Promise.resolve()
          .then(() => synth(it.text, ctl?.signal))
          .then((a) => ({ a }), (e) => ({ e }));
      }
    }
  }

  async function pump() {
    if (playing || items.length === 0) return;
    playing = true;
    const g = gen;
    const it = items.shift();
    fill();
    let failed = null;
    try {
      const r = await it.audio;
      if (g !== gen) return;
      if (r.e) throw r.e;
      onStart(it.text);
      await play(r.a, ctl?.signal);
    } catch (e) {
      if (g === gen) failed = e;
    } finally {
      if (g === gen) {
        playing = false;
        if (failed) {
          items = [];
          onError(failed, it.text);
          onIdle();
        } else if (items.length > 0) pump();
        else onIdle();
      }
    }
  }

  return {
    get busy() {
      return playing || items.length > 0;
    },
    get length() {
      return items.length;
    },
    enqueue(text) {
      const t = String(text ?? "").trim();
      if (!t) return;
      items.push({ text: t, audio: null });
      fill();
      pump();
    },
    clear() {
      gen += 1;
      items = [];
      playing = false;
      try {
        ctl?.abort();
      } catch {}
      ctl = typeof AbortController === "function" ? new AbortController() : null;
    },
  };
}
