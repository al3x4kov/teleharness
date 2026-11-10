// Validated server configuration (ADR-006, TASK-12.19). Zero-dep, pure core.
//
// Every env variable the portal server reads (server.js, auth.js, file.js)
// is declared here with a type and a default. A typo such as
// ZAI_STALL_ABORT_MS=9oo000 used to turn into NaN and silently disable the
// watchdog; now it is a startup error with a readable message.
//
// Import-time evaluation never throws (modules that import this would crash
// with a raw stack during ESM linking). Instead `configErrors` carries every
// problem and server.js exits with code 1 before listening. Values that
// failed validation fall back to their defaults so imports stay usable.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Portable defaults: everything under the user's home; ~/.zai keeps the
// optional pieces (tenant knowledge-base zones, voice venv + models).
const HOME = os.homedir();
const ZAI_DIR = path.join(HOME, ".zai");
const WIN = process.platform === "win32";

// Schema: name → {type, def, min?, max?, secret?}. def may be a function of
// the partially built config (for derived defaults such as the log dir).
export const SCHEMA = [
  { name: "PORT", type: "int", def: 4170, min: 0, max: 65535 },
  { name: "ZAI_MOCK", type: "bool", def: false },
  { name: "ZAI_UPSTREAM", type: "url", def: "http://127.0.0.1:4096" },
  { name: "ZAI_HOME", type: "path", def: HOME },
  { name: "ZAI_DATA_DIR", type: "path", def: path.join(ROOT, "data") },
  { name: "ZAI_LOG_DIR", type: "path", def: (c) => path.join(c.ZAI_DATA_DIR, "logs") },
  { name: "ZAI_CHAT_DIR", type: "path", def: (c) => c.ZAI_HOME },
  { name: "ZAI_ACCESS_LOG", type: "bool", def: true },
  { name: "ZAI_COOKIE_NAME", type: "string", def: "zai_t" },
  { name: "ZAI_TENANT_HOME", type: "path", def: (c) => path.join(c.ZAI_HOME, ".zai-tenants") },
  { name: "ZAI_TENANT_VAULT", type: "path", def: path.join(ZAI_DIR, "tenants-vault") },
  { name: "ZAI_TENANT_AGENT", type: "string", def: "" },
  // BUG-163: a tenant turn with pictures on a text-only model runs on this vision model of the same provider.
  { name: "ZAI_TENANT_VISION_MODEL", type: "string", def: "glm-5.3-flash" },
  // BUG-180: reasoning effort for a zai-coding-plan/glm-5.3* turn sent without a variant ("off" = provider default).
  { name: "ZAI_GLM_VARIANT", type: "enum", values: ["off", "low", "high", "max"], def: "max" },
  { name: "ZAI_FILE_ROOTS", type: "list", def: (c) => [c.ZAI_HOME] },
  { name: "ZAI_STALL_ABORT_MS", type: "ms", def: 900_000 },
  // FEAT-07.15: dialogs wait for the human; the auto-reject is opt-in only.
  { name: "ZAI_DIALOG_TIMEOUT_MS", type: "ms", def: 0 },
  { name: "ZAI_STALL_REPLAY_MS", type: "ms", def: 180_000 },
  { name: "ZAI_STALL_REPLAY_MAX", type: "int", def: 2, min: 0, max: 100 },
  // BUG-07.7: N identical tool calls in a row abort the turn (0 disables).
  { name: "ZAI_LOOP_ABORT_COUNT", type: "int", def: 8, min: 0, max: 1000 },
  // BUG-07.10: a busy turn silent this long is aborted before a new prompt.
  { name: "ZAI_PROMPT_UNSTICK_MS", type: "ms", def: 120_000 },
  // ADR-003 п.2: deployment kind. A non-prod instance refuses the prod
  // upstream (:4096) — the stand once ran on prod sessions (BUG-12.8).
  { name: "ZAI_ENV", type: "enum", values: ["prod", "stand", "test"], def: "prod" },
  // BUG-01.28: chats living under the system temp tree (smoke/QA probes)
  // are hidden from the session list. 0 shows them.
  { name: "ZAI_HIDE_TEMP_SESSIONS", type: "bool", def: true },
  // Tenant quotas (BUG-12.10). Bytes / requests; 0 disables the limit.
  { name: "ZAI_TENANT_PROMPT_LIMIT", type: "int", def: 8 * 1024 * 1024, min: 0 },
  { name: "ZAI_TENANT_UPLOAD_LIMIT", type: "int", def: 25 * 1024 * 1024, min: 0 },
  { name: "ZAI_TENANT_UPLOAD_QUOTA", type: "int", def: 500 * 1024 * 1024, min: 0 },
  { name: "ZAI_TENANT_RATE_PER_MIN", type: "int", def: 120, min: 0 },
  // Read by lib/claude.js itself (Г3); validated here so a typo is caught.
  { name: "ZAI_CLAUDE_TIMEOUT_MS", type: "ms", def: 0 },
  { name: "ZAI_CLAUDE_IDLE_MS", type: "ms", def: 0 }, // owner decision 2026-11-02: claude turns live until they finish; idle kill is opt-in
  { name: "ZAI_CLAUDE_BIN", type: "string", def: "" },
  // FEAT-13.10: MCP config file for ADMIN claude chats (--mcp-config; tenants
  // never get MCP servers). Empty = none.
  { name: "ZAI_CLAUDE_MCP_CONFIG", type: "string", def: "" },
  // FEAT-13.11: admin knowledge-base root (Obsidian active cache) for the
  // snapshot of the first turn of a Claude chat; "off" = no snapshot.
  // Tenants: their obsidianRoot / ZAI_TENANT_VAULT\<name>. Off by default:
  // point it at your Obsidian «agents» folder to turn the snapshot on.
  { name: "ZAI_KB_ROOT", type: "string", def: "off" },
  // BUG-01.48: chats with no message at all, a default title and older than
  // this many minutes are deleted by the server gc (0 disables).
  { name: "ZAI_GC_EMPTY_MIN", type: "int", def: 30, min: 0, max: 525_600 },
  // Period of the gc sweep (empty chats + leftover tenant folders, BUG-04.6).
  { name: "ZAI_GC_INTERVAL_MS", type: "ms", def: 600_000, min: 200 },
  // FEAT-01.58 / BUG-146: file backups of the last turn of every chat —
  // Claude (PreToolUse hook) and opencode (vault-cache plugin, which uses the
  // same env or <dirname(ZAI_USERS_FILE)>/turn-undo = this default).
  { name: "ZAI_TURN_UNDO_ROOT", type: "path", def: (c) => path.join(c.ZAI_DATA_DIR, "turn-undo") },
  // BUG-13.14: auto titles via a short claude CLI call (0 → heuristic only).
  { name: "ZAI_TITLE_LLM", type: "bool", def: true },
  { name: "ZAI_TITLE_MODEL", type: "string", def: "claude-haiku-4-5" },
  { name: "ZAI_TITLE_TIMEOUT_MS", type: "ms", def: 20_000, min: 1000 },
  // FEAT-06.2 voice mode: local worker (Piper TTS + GigaAM STT). Off, or
  // python/models missing → GET /voice says unavailable, the UI hides it.
  { name: "ZAI_VOICE", type: "bool", def: true },
  { name: "ZAI_VOICE_PYTHON", type: "string", def: WIN ? path.join(ZAI_DIR, "voice", "venv", "Scripts", "python.exe") : path.join(ZAI_DIR, "voice", "venv", "bin", "python3") },
  { name: "ZAI_VOICE_MODELS", type: "string", def: path.join(ZAI_DIR, "voice", "models") },
  { name: "ZAI_VOICE_WORKER", type: "string", def: "" }, // default: ops/voice/voice-worker.py
  // Daily voice quota per tenant (0 = no limit); admin is never limited.
  { name: "ZAI_VOICE_TENANT_TTS_CHARS", type: "int", def: 40_000, min: 0 },
  { name: "ZAI_VOICE_TENANT_STT_SEC", type: "int", def: 1800, min: 0 },
  // BUG-11.13: model of a prompt that names none in a chat without a binding,
  // "provider/model". Empty → upstream /config model, then /provider default.
  { name: "ZAI_DEFAULT_MODEL", type: "string", def: "" },
  // FEAT-07.20 Web Push: 0 switches the feature off (routes answer 503).
  { name: "ZAI_PUSH", type: "bool", def: true },
  // VAPID «sub» (RFC 8292): mailto: or https: contact of the sender.
  { name: "ZAI_PUSH_SUBJECT", type: "string", def: "https://zai.home.example.net/zai/" },
  // Extra endpoint origins besides the known push services (tests / live
  // check with a local fake push service), «;»-separated.
  { name: "ZAI_PUSH_EXTRA_ORIGINS", type: "list", def: [] },
  { name: "ZAI_PUSH_DEBOUNCE_MS", type: "ms", def: 20_000 },
  { name: "ZAI_PUSH_MAX_PER_USER", type: "int", def: 10, min: 1, max: 100 },
  { name: "ZAI_ADMIN_TOKEN", type: "string", def: "", secret: true },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", type: "string", def: "", secret: true },
];

function parseOne(spec, raw) {
  const s = String(raw).trim();
  switch (spec.type) {
    case "int":
    case "ms": {
      if (!/^\d+$/.test(s)) return { error: `ожидалось целое ≥ 0, получено \`${raw}\`` };
      const n = Number(s);
      if (!Number.isSafeInteger(n)) return { error: `слишком большое число \`${raw}\`` };
      if (spec.min != null && n < spec.min) return { error: `ожидалось ≥ ${spec.min}, получено ${n}` };
      if (spec.max != null && n > spec.max) return { error: `ожидалось ≤ ${spec.max}, получено ${n}` };
      return { value: n };
    }
    case "bool":
      if (s === "1") return { value: true };
      if (s === "0") return { value: false };
      return { error: `ожидалось 0 или 1, получено \`${raw}\`` };
    case "url":
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return { error: `ожидался http(s) URL, получено \`${raw}\`` };
        return { value: s.replace(/\/+$/, "") };
      } catch {
        return { error: `ожидался URL, получено \`${raw}\`` };
      }
    case "path":
      if (!/^[A-Za-z]:[\\/]/.test(s) && !(process.platform !== "win32" && s.startsWith("/")))
        return { error: `ожидался абсолютный путь, получено \`${raw}\`` };
      return { value: s };
    case "list":
      return { value: s.split(";").map((x) => x.trim()).filter(Boolean) };
    case "enum":
      if (!spec.values.includes(s)) return { error: `ожидалось одно из ${spec.values.join(" | ")}, получено \`${raw}\`` };
      return { value: s };
    default:
      return { value: s };
  }
}

// Pure: env object → {config, sources, errors}. Never throws.
export function loadConfig(env = {}) {
  const config = {};
  const sources = {};
  const errors = [];
  for (const spec of SCHEMA) {
    const raw = env[spec.name];
    const def = typeof spec.def === "function" ? spec.def(config) : spec.def;
    if (raw === undefined || raw === "") {
      config[spec.name] = def;
      sources[spec.name] = "default";
      continue;
    }
    const r = parseOne(spec, raw);
    if (r.error) {
      errors.push(`${spec.name}: ${r.error}`);
      config[spec.name] = def;
      sources[spec.name] = "default";
    } else {
      config[spec.name] = r.value;
      sources[spec.name] = "env";
    }
  }
  return { config: Object.freeze(config), sources, errors };
}

// One JSON line for the startup log; secrets masked.
export function describeConfig(config, sources) {
  const out = {};
  for (const spec of SCHEMA) {
    const v = config[spec.name];
    out[spec.name] = { value: spec.secret ? (v ? "***" : "") : v, source: sources[spec.name] };
  }
  return JSON.stringify(out);
}

const loaded = loadConfig(process.env);
export const config = loaded.config;
export const configSources = loaded.sources;
export const configErrors = loaded.errors;
