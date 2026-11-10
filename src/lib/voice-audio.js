// FEAT-06.2 voice mode — browser audio glue (Web Audio, getUserMedia,
// speechSynthesis). One AudioContext for the whole mode: it is created and
// unlocked INSIDE the tap that opens the mode (iOS plays nothing from a
// context that was not started by a gesture), the microphone and the
// playback both live on it.
import { createFramer, createResampler, FRAME, STT_RATE } from "./voice-vad.js";

let shared = null;

export function audioContext() {
  if (shared && shared.state !== "closed") return shared;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof Ctor !== "function") return null;
  try {
    shared = new Ctor(); // no forced sampleRate: Safari would refuse/garble it
  } catch {
    shared = null;
  }
  return shared;
}

// Call synchronously from the click/tap handler that opens the mode.
export function unlockAudio() {
  const ctx = audioContext();
  if (ctx) {
    try {
      ctx.resume?.();
      const b = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start(0);
    } catch {}
  }
  // The browser-voice fallback needs its own gesture unlock on iOS.
  try {
    const synth = globalThis.speechSynthesis;
    const U = globalThis.SpeechSynthesisUtterance;
    if (synth && typeof U === "function") {
      const u = new U(" ");
      u.volume = 0;
      synth.speak(u);
    }
  } catch {}
  return ctx;
}

export function micSupported() {
  return typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function";
}

// The level the orb shows: RMS of the analyser × 6, as in the concept.
function analyserLevel(analyser, buf) {
  try {
    analyser.getFloatTimeDomainData(buf);
  } catch {
    return 0;
  }
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(s / buf.length) * 6);
}

const WORKLET = `class ZaiVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.b[this.n++] = ch[i];
      if (this.n === this.b.length) { this.port.postMessage(this.b.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("zai-voice-capture", ZaiVoiceCapture);`;

async function captureNode(ctx, onChunk) {
  if (ctx.audioWorklet && typeof globalThis.AudioWorkletNode === "function") {
    try {
      if (!ctx.__zaiVoiceWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        ctx.__zaiVoiceWorklet = true;
      }
      const node = new globalThis.AudioWorkletNode(ctx, "zai-voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e) => onChunk(e.data);
      return node;
    } catch {}
  }
  // Older Safari: ScriptProcessor (deprecated but everywhere).
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  return node;
}

// Microphone → 16 kHz 20 ms frames (onFrame) + a level for the orb.
// Errors: err.code "mic" (permission), "nomic" (no device / no API).
export async function startCapture(ctx, { onFrame }) {
  if (!ctx) throw Object.assign(new Error("no audio"), { code: "nomic" });
  if (!micSupported()) throw Object.assign(new Error("no getUserMedia"), { code: "nomic" });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = err?.name ?? "";
    const code = name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" ? "mic" : "nomic";
    throw Object.assign(new Error(name || "getUserMedia failed"), { code });
  }
  try {
    if (ctx.state === "suspended") await ctx.resume();
  } catch {}
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const buf = new Float32Array(analyser.fftSize);
  src.connect(analyser);
  const resample = createResampler(ctx.sampleRate, STT_RATE);
  let enabled = true;
  const framer = createFramer(FRAME, (f) => onFrame(f));
  const node = await captureNode(ctx, (chunk) => {
    if (enabled) framer.push(resample(chunk));
  });
  const sink = ctx.createGain();
  sink.gain.value = 0; // the processor must be pulled, but never heard
  src.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  return {
    level: () => (enabled ? analyserLevel(analyser, buf) : 0),
    setEnabled(on) {
      enabled = !!on;
      framer.reset();
      for (const t of stream.getAudioTracks()) t.enabled = enabled;
    },
    stop() {
      enabled = false;
      try {
        node.port && (node.port.onmessage = null);
        node.onaudioprocess = null;
        src.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {}
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {}
      }
    },
  };
}

// WAV bytes → AudioBuffer → speakers, with an analyser for the orb.
export function createPlayer(ctx) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const buf = new Float32Array(analyser.fftSize);
  let cur = null;
  return {
    level: () => (cur ? analyserLevel(analyser, buf) : 0),
    decode(bytes) {
      return new Promise((resolve, reject) => {
        try {
          const p = ctx.decodeAudioData(bytes, resolve, reject); // old Safari: callbacks only
          if (p && typeof p.then === "function") p.then(resolve, reject);
        } catch (e) {
          reject(e);
        }
      });
    },
    play(audioBuffer, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        try {
          if (ctx.state === "suspended") ctx.resume?.();
        } catch {}
        const s = ctx.createBufferSource();
        s.buffer = audioBuffer;
        s.connect(analyser);
        cur = s;
        const done = () => {
          if (cur === s) cur = null;
          resolve();
        };
        s.onended = done;
        signal?.addEventListener?.(
          "abort",
          () => {
            try {
              s.stop();
            } catch {}
            done();
          },
          { once: true },
        );
        s.start();
      });
    },
    stop() {
      try {
        cur?.stop();
      } catch {}
      cur = null;
    },
  };
}

// Fallback voice (server TTS unavailable): the system ru-RU voice.
export function browserTtsSupported() {
  return Boolean(globalThis.speechSynthesis) && typeof globalThis.SpeechSynthesisUtterance === "function";
}

export function speakBrowser(text, { rate = 1, signal } = {}) {
  return new Promise((resolve) => {
    const synth = globalThis.speechSynthesis;
    if (!synth || signal?.aborted) return resolve();
    const u = new globalThis.SpeechSynthesisUtterance(text);
    u.lang = "ru-RU";
    u.rate = rate;
    const ru = synth.getVoices?.().find((v) => /^ru/i.test(v.lang));
    if (ru) u.voice = ru;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    signal?.addEventListener?.(
      "abort",
      () => {
        try {
          synth.cancel();
        } catch {}
        finish();
      },
      { once: true },
    );
    synth.speak(u);
  });
}

export function cancelBrowserTts() {
  try {
    globalThis.speechSynthesis?.cancel();
  } catch {}
}

// Screen Wake Lock while the mode is open (re-taken when the page returns —
// the browser drops it on hide). → release().
export function holdWakeLock() {
  let lock = null;
  let released = false;
  const take = async () => {
    try {
      if (released || globalThis.document?.hidden) return;
      lock = await globalThis.navigator?.wakeLock?.request?.("screen");
    } catch {
      lock = null;
    }
  };
  const onVis = () => {
    if (!globalThis.document?.hidden) take();
  };
  take();
  globalThis.document?.addEventListener?.("visibilitychange", onVis);
  return () => {
    released = true;
    globalThis.document?.removeEventListener?.("visibilitychange", onVis);
    try {
      lock?.release?.();
    } catch {}
  };
}
