// FEAT-06.2 voice mode — audio side, pure (Node-importable, no Web Audio):
// resampling to 16 kHz, fixed-size framing, int16 PCM, and the VAD/pause
// segmenter that cuts the user's speech into pieces the server recognizes
// while the user still talks (design.md «Спайк»: GigaAM ≈ 0.5× audio length —
// by the end of the utterance only its last piece is left to recognize).

export const STT_RATE = 16000;
export const FRAME = 320; // 20 ms at 16 kHz

export function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i += 1) s += frame[i] * frame[i];
  return frame.length ? Math.sqrt(s / frame.length) : 0;
}

// Streaming box-average resampler (from → to Hz). The average over each
// output window is a cheap low-pass: 48 kHz → 16 kHz without aliasing hiss.
// Safari runs the AudioContext at the device rate (44.1/48 kHz) — never forced.
export function createResampler(from, to = STT_RATE) {
  const ratio = from / to;
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-9) return (input) => Float32Array.from(input);
  let carry = new Float32Array(0);
  let pos = 0; // fractional start of the next output window inside `carry`
  return (input) => {
    const buf = new Float32Array(carry.length + input.length);
    buf.set(carry, 0);
    buf.set(input, carry.length);
    const out = [];
    while (pos + ratio <= buf.length) {
      const a = Math.floor(pos);
      const b = Math.max(a + 1, Math.floor(pos + ratio));
      let s = 0;
      for (let i = a; i < b; i += 1) s += buf[i];
      out.push(s / (b - a));
      pos += ratio;
    }
    const used = Math.floor(pos);
    carry = buf.slice(used);
    pos -= used;
    return Float32Array.from(out);
  };
}

// Arbitrary chunks → fixed frames of `size` samples.
export function createFramer(size, onFrame) {
  let buf = new Float32Array(size);
  let n = 0;
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i += 1) {
        buf[n++] = chunk[i];
        if (n === size) {
          onFrame(buf);
          buf = new Float32Array(size);
          n = 0;
        }
      }
    },
    reset() {
      n = 0;
    },
  };
}

export function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i += 1) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function concat(frames) {
  let n = 0;
  for (const f of frames) n += f.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

export const VAD_DEFAULTS = Object.freeze({
  sampleRate: STT_RATE,
  pauseMs: 1200, // utterance end (prefs.voice.pauseMs)
  segmentPauseMs: 350, // a short pause cuts a piece for background STT
  minSpeechMs: 120, // voiced time before «speech started» (clicks are ignored)
  minSegmentMs: 200, // voiced time a piece needs to be worth recognizing
  maxSegmentMs: 20_000,
  maxUtteranceMs: 60_000, // server limit per request; the utterance ends here
  preRollMs: 240, // audio kept before the speech start (first syllable)
  ratio: 3, // speech threshold = floor × ratio …
  minThreshold: 0.012, // … but never below this RMS
  floorInit: 0.004,
  floorMin: 0.0015,
  floorMax: 0.05,
});

// Adaptive-threshold VAD over 16 kHz frames. Events:
//   onSpeechStart()                       — speech confirmed (≥ minSpeechMs)
//   onSegment(int16, {index, voicedMs})    — a piece to recognize, in order
//   onUtteranceEnd({segments, voicedMs, reason: "pause"|"max"}) — pause ≥ pauseMs
// voicedMs (getter) — voiced time of the current utterance (barge-in test).
export function createVad(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  let floor = o.floorInit;
  let preRoll = [];
  let preRollMs = 0;
  let candidateMs = 0;
  let inUtt = false;
  let uttMs = 0;
  let silenceMs = 0;
  let voicedMs = 0;
  let seg = null; // {frames, ms, voicedMs} | null between pieces
  let segIndex = 0;
  let segmentsEmitted = 0;

  const frameMs = (f) => (f.length / o.sampleRate) * 1000;
  const updateFloor = (level) => {
    floor = level < floor ? floor * 0.8 + level * 0.2 : floor * 0.98 + level * 0.02;
    floor = Math.min(o.floorMax, Math.max(o.floorMin, floor));
  };
  const keepPreRoll = (f, ms) => {
    preRoll.push(f);
    preRollMs += ms;
    while (preRoll.length > 1 && preRollMs - frameMs(preRoll[0]) >= o.preRollMs) preRollMs -= frameMs(preRoll.shift());
  };

  function cut() {
    if (!seg) return;
    const s = seg;
    seg = null;
    if (s.voicedMs < o.minSegmentMs) return;
    segmentsEmitted += 1;
    o.onSegment?.(floatTo16(concat(s.frames)), { index: segIndex++, voicedMs: s.voicedMs });
  }

  function end(reason) {
    cut();
    const r = { segments: segmentsEmitted, voicedMs, reason };
    inUtt = false;
    uttMs = 0;
    silenceMs = 0;
    voicedMs = 0;
    candidateMs = 0;
    segmentsEmitted = 0;
    preRoll = [];
    preRollMs = 0;
    o.onUtteranceEnd?.(r);
  }

  return {
    get threshold() {
      return Math.max(o.minThreshold, floor * o.ratio);
    },
    get inSpeech() {
      return inUtt;
    },
    get voicedMs() {
      return voicedMs;
    },
    setPause(ms) {
      if (Number.isFinite(ms) && ms > 0) o.pauseMs = ms;
    },
    // Drops the current utterance silently (mute, a new phase).
    reset() {
      inUtt = false;
      seg = null;
      uttMs = 0;
      silenceMs = 0;
      voicedMs = 0;
      candidateMs = 0;
      segmentsEmitted = 0;
      preRoll = [];
      preRollMs = 0;
    },
    push(frame) {
      const level = rms(frame);
      const ms = frameMs(frame);
      const voiced = level > Math.max(o.minThreshold, floor * o.ratio);
      if (!inUtt) {
        if (!voiced) updateFloor(level);
        keepPreRoll(frame, ms);
        candidateMs = voiced ? candidateMs + ms : 0;
        if (candidateMs >= o.minSpeechMs) {
          inUtt = true;
          seg = { frames: preRoll, ms: preRollMs, voicedMs: candidateMs };
          uttMs = preRollMs;
          voicedMs = candidateMs;
          silenceMs = 0;
          preRoll = [];
          preRollMs = 0;
          o.onSpeechStart?.();
        }
        return level;
      }
      uttMs += ms;
      if (voiced) {
        silenceMs = 0;
        voicedMs += ms;
        if (!seg) {
          seg = { frames: preRoll, ms: preRollMs, voicedMs: 0 };
          preRoll = [];
          preRollMs = 0;
        }
        seg.frames.push(frame);
        seg.ms += ms;
        seg.voicedMs += ms;
      } else {
        silenceMs += ms;
        updateFloor(level);
        if (seg) {
          seg.frames.push(frame);
          seg.ms += ms;
        } else keepPreRoll(frame, ms);
      }
      if (seg && ((silenceMs >= o.segmentPauseMs && seg.voicedMs >= o.minSegmentMs) || seg.ms >= o.maxSegmentMs)) cut();
      if (silenceMs >= o.pauseMs) end("pause");
      else if (uttMs >= o.maxUtteranceMs) end("max");
      return level;
    },
  };
}
