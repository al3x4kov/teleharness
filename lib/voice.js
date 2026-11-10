// Voice mode server side (FEAT-06.2): one long-lived local worker
// (ops/voice/voice-worker.py — Piper TTS + GigaAM STT, spike 2026-11-05 on
// a GPU-less mini PC: Piper ≈0.4 s per sentence warm, GigaAM ≈0.5× audio length,
// Whisper base/small lost on both speed and accuracy) driven over JSON lines.
//
// - lazy start, warm-up of the default voice + STT right after the spawn;
// - one request at a time (CPU shared with opencode / claude), FIFO queue;
// - a crashed worker is respawned on the next call; 3 crashes within a
//   minute park the service for 5 minutes (status reports it);
// - per-user daily quota for tenants (TTS characters, STT seconds).
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";

export const VOICE_NAMES = { irina: "Ирина", denis: "Денис", dmitri: "Дмитрий", ruslan: "Руслан" };
export const DEFAULT_VOICE = "irina";
export const MAX_TTS_CHARS = 600;
export const MAX_STT_SECONDS = 60;
const PCM_BYTES_PER_SEC = 16000 * 2;

export function voiceLabel(id) {
  return VOICE_NAMES[id] ?? (typeof id === "string" && id ? id[0].toUpperCase() + id.slice(1) : "");
}

// Text a TTS request may carry: no markdown/code noise, capped. FEAT-06.3:
// what the speech normalizer needs survives — snake_case and file names,
// «C#» / «#5», «~5 мин» (примерно), «5 > 3»; only markup goes.
export function cleanTtsText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*+/g, " ")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, " ")
    .replace(/(?<![\p{L}+])#+(?!\d)/gu, " ")
    .replace(/(^|\n)[ \t]*>+/g, "$1 ")
    .replace(/~~|~(?![ \t]?\d)/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

export class VoiceService {
  #python;
  #script;
  #env;
  #spawn;
  #log;
  #timeoutMs;
  #child = null;
  #buf = "";
  #seq = 0;
  #pending = new Map();
  #queue = Promise.resolve();
  #crashes = [];
  #parkedUntil = 0;
  #info = null;

  constructor({ python, script, models = null, spawn = nodeSpawn, log = (m) => console.log(m), timeoutMs = 60_000, exists = existsSync } = {}) {
    this.#python = python;
    this.#script = script;
    this.#env = { ...process.env, ...(models ? { ZAI_VOICE_MODELS: models } : {}) };
    this.#spawn = spawn;
    this.#log = log;
    this.#timeoutMs = timeoutMs;
    this.available = Boolean(python && script && exists(python) && exists(script));
  }

  get parked() {
    return Date.now() < this.#parkedUntil;
  }

  #start() {
    const args = /\.py$/i.test(this.#script) ? ["-I", "-X", "utf8", this.#script] : [this.#script];
    const child = this.#spawn(this.#python, args, { stdio: ["pipe", "pipe", "pipe"], env: this.#env, windowsHide: true });
    this.#child = child;
    this.#buf = "";
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (d) => this.#onData(String(d)));
    child.stderr?.on?.("data", (d) => this.#log(`[zai-voice] ${String(d).trim().slice(0, 300)}`));
    child.on("error", (err) => this.#onExit(child, `spawn error: ${err?.message ?? err}`));
    child.on("exit", (code) => this.#onExit(child, `exit ${code}`));
    // Warm the default voice + STT so the first real request is not 8 s.
    this.#send({ op: "warm", voices: [DEFAULT_VOICE], stt: true }, 120_000).catch(() => {});
  }

  #onData(chunk) {
    this.#buf += chunk;
    let i;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || "voice worker error"));
    }
  }

  #onExit(child, why) {
    if (this.#child !== child) return;
    this.#child = null;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`voice worker stopped (${why})`));
    }
    this.#pending.clear();
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((t) => now - t < 60_000), now];
    if (this.#crashes.length >= 3) {
      this.#parkedUntil = now + 5 * 60_000;
      this.#crashes = [];
      this.#log(`[zai-voice] worker crashed 3× in a minute — parked for 5 min (${why})`);
    } else this.#log(`[zai-voice] worker stopped: ${why}`);
  }

  #send(req, timeoutMs = this.#timeoutMs) {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("voice worker not running"));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("voice worker timeout"));
        // a hung worker is replaced: the next call spawns a fresh one
        if (this.#child === child) this.#child = null;
        try {
          child.kill();
        } catch {}
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    });
  }

  // Serialized call; spawns the worker when needed.
  call(req, timeoutMs) {
    const run = this.#queue.then(() => {
      if (!this.available) throw Object.assign(new Error("voice mode is not installed on the server"), { code: "unavailable" });
      if (this.parked) throw Object.assign(new Error("voice worker is restarting"), { code: "parked" });
      if (!this.#child) this.#start();
      return this.#send(req, timeoutMs);
    });
    this.#queue = run.catch(() => null);
    return run;
  }

  async info() {
    if (!this.available) return { available: false, voices: [], stt: false };
    if (!this.#info) {
      try {
        const r = await this.call({ op: "ping" }, 20_000);
        this.#info = { voices: Array.isArray(r.voices) ? r.voices : [], stt: r.stt === true };
      } catch {
        return { available: true, ready: false, parked: this.parked, voices: [], stt: false };
      }
    }
    return { available: true, ready: true, parked: this.parked, ...this.#info };
  }

  async tts({ text, voice = DEFAULT_VOICE, rate = 1 }) {
    const r = await this.call({ op: "tts", text: cleanTtsText(text), voice, rate });
    return Buffer.from(r.wav ?? "", "base64");
  }

  // FEAT-06.3 debug: the text the worker will actually speak (normalized).
  async norm(text) {
    const r = await this.call({ op: "norm", text: cleanTtsText(text) }, 20_000);
    return { text: String(r.text ?? ""), ms: Number(r.normMs ?? 0) };
  }

  async stt(pcm) {
    const r = await this.call({ op: "stt", pcm: Buffer.from(pcm).toString("base64") });
    return String(r.text ?? "");
  }

  stop() {
    const c = this.#child;
    this.#child = null;
    try {
      c?.stdin?.end();
      c?.kill();
    } catch {}
  }
}

// Seconds of 16 kHz int16 mono PCM.
export function pcmSeconds(bytes) {
  return (Number(bytes) || 0) / PCM_BYTES_PER_SEC;
}

// Per-user daily usage (tenants only; admin is never limited).
export class VoiceQuota {
  #day = "";
  #used = new Map();
  constructor({ ttsChars = 40_000, sttSeconds = 1800, now = () => new Date() } = {}) {
    this.ttsChars = ttsChars;
    this.sttSeconds = sttSeconds;
    this.now = now;
  }
  #roll() {
    const d = this.now().toISOString().slice(0, 10);
    if (d !== this.#day) {
      this.#day = d;
      this.#used.clear();
    }
  }
  #get(uid) {
    this.#roll();
    if (!this.#used.has(uid)) this.#used.set(uid, { tts: 0, stt: 0 });
    return this.#used.get(uid);
  }
  // → true when allowed (and counted).
  takeTts(uid, chars) {
    const u = this.#get(uid);
    if (this.ttsChars > 0 && u.tts + chars > this.ttsChars) return false;
    u.tts += chars;
    return true;
  }
  takeStt(uid, seconds) {
    const u = this.#get(uid);
    if (this.sttSeconds > 0 && u.stt + seconds > this.sttSeconds) return false;
    u.stt += seconds;
    return true;
  }
}
