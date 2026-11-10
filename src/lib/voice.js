// Voice dictation engine for the composer: Web Speech API tuned for iOS
// Safari (research 2026-10-31). The interface exists ONLY in secure contexts
// since Safari 26.0 ([SecureContext], WebKit f60ba77) — on http://LAN-IP it
// is undefined and speechSupported() is false; the composer then behaves
// exactly as before. Chrome has gated the mic on insecure origins since v60.
//
// iOS quirks handled here:
//  - the recognizer auto-stops after ~1 minute / at phrase ends → respawn in
//    onend while the session stays active (guarded, never on fatal errors);
//  - Safari's stop()/abort() often leaves the mic hot → call start() once
//    before stop() (known workaround);
//  - "no-speech"/"aborted" are restart noise; fatal errors end the session
//    with a human-readable Russian reason for the composer toast.
import { t } from "./i18n.js";

export function speechSupported() {
  try {
    return (
      typeof globalThis.SpeechRecognition === "function" ||
      typeof globalThis.webkitSpeechRecognition === "function"
    );
  } catch {
    return false;
  }
}

const ERROR_KEYS = {
  "not-allowed": "voice.rec.notAllowed",
  "service-not-allowed": "voice.rec.serviceNotAllowed",
  "audio-capture": "voice.rec.audioCapture",
  network: "voice.rec.network",
};

export function errorText(code) {
  return t(ERROR_KEYS[code] ?? "voice.rec.unknown");
}

// A recognizer error that means "no usable microphone" (vs network/other).
export function isMicError(code) {
  return code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture";
}

// Committed text accumulator: finals append, interim rides separately.
export function createTranscript() {
  let base = "";
  return {
    get text() {
      return base;
    },
    addFinal(chunk) {
      const t = String(chunk ?? "").trim();
      if (t) base = base ? `${base} ${t}` : t;
    },
    reset() {
      base = "";
    },
  };
}

const RESTART_DELAY_MS = 150; // iOS needs a beat between stop and respawn

export function createRecognizer({ lang = "ru-RU", onPartial, onError, onEnd } = {}) {
  const Ctor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (typeof Ctor !== "function") return null;
  let rec = null;
  let active = false;
  let restartTimer = 0;
  const transcript = createTranscript();

  function spawn() {
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        const chunk = res[0]?.transcript ?? "";
        if (res.isFinal) transcript.addFinal(chunk);
        else interim += chunk;
      }
      onPartial?.(transcript.text, interim);
    };
    r.onerror = (e) => {
      const code = e?.error ?? "unknown";
      if (code === "no-speech" || code === "aborted") return; // restart noise
      active = false;
      clearTimeout(restartTimer);
      onError?.(errorText(code), code);
    };
    r.onend = () => {
      if (!active) {
        rec = null;
        onEnd?.();
        return;
      }
      // Auto-stopped by the engine (phrase end / ~60s cap): keep listening.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (active) spawn();
      }, RESTART_DELAY_MS);
    };
    rec = r;
    try {
      r.start();
    } catch {
      // start() racing a still-dying instance: onend respawn recovers
    }
  }

  return {
    start() {
      if (active) return;
      transcript.reset();
      active = true;
      spawn();
    },
    // Committed text so far (finals only — never the shaky interim).
    committed() {
      return transcript.text;
    },
    stop() {
      if (!active) return;
      active = false;
      clearTimeout(restartTimer);
      // Safari stop() bug: the mic stays hot unless start() precedes stop().
      try {
        rec?.start();
      } catch {}
      try {
        rec?.stop();
      } catch {}
    },
    abort() {
      active = false;
      clearTimeout(restartTimer);
      try {
        rec?.abort();
      } catch {}
    },
  };
}
