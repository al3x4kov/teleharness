// Validated server configuration (ADR-006, TASK-12.19). Zero-dep, pure core.
//
// Every env variable the portal server reads (server.js, auth.js, file.js)
// is declared here with a type and a default. A typo such as
// TELEHARNESS_STALL_ABORT_MS=9oo000 used to turn into NaN and silently disable the
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
// Portable defaults: everything under the user's home; ~/.teleharness keeps the
// optional pieces (tenant knowledge-base zones, voice venv + models).
const HOME = os.homedir();
const TELEHARNESS_DIR = path.join(HOME, ".teleharness");
const WIN = process.platform === "win32";

// Defaults by platform — the same layout everywhere (Windows, macOS, Linux): everything under the
// user's home, optional pieces under ~/.teleharness. Only separators and the venv's python path differ.
// The schema below spells the same values out; this function documents them and is what tests check.
export function platformDefaults(platform = process.platform, home = os.homedir()) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const teleharness = p.join(home, ".teleharness");
  return {
    home,
    tenantHome: p.join(home, ".teleharness-tenants"),
    tenantVault: p.join(teleharness, "tenants-vault"),
    fileRoots: [home],
    kbRoot: "off",
    voicePython: platform === "win32" ? p.join(teleharness, "voice", "venv", "Scripts", "python.exe") : p.join(teleharness, "voice", "venv", "bin", "python3"),
    voiceModels: p.join(teleharness, "voice", "models"),
  };
}

// BUG-224 (BUG-12.33): порты прод-upstream opencode (1.x и 2.x). Не-прод
// экземпляр (TELEHARNESS_ENV stand/test) отказывается работать с любым из них —
// server.js (ADR-003 п.2); тесты сверяют с FORBIDDEN_PORTS tests/helpers/env.mjs.
export const PROD_UPSTREAM_PORTS = [4096, 4196];

// Schema: name → {type, def, min?, max?, secret?}. def may be a function of
// the partially built config (for derived defaults such as the log dir).
export const SCHEMA = [
  { name: "PORT", type: "int", def: 4170, min: 0, max: 65535 },
  // TASK-17.1: адрес прослушивания; в контейнере — 0.0.0.0 (наружу публикует только edge)
  { name: "TELEHARNESS_LISTEN_HOST", type: "string", def: "127.0.0.1" },
  { name: "TELEHARNESS_MOCK", type: "bool", def: false },
  { name: "TELEHARNESS_UPSTREAM", type: "url", def: "http://127.0.0.1:4096" },
  { name: "TELEHARNESS_HOME", type: "path", def: HOME },
  { name: "TELEHARNESS_DATA_DIR", type: "path", def: path.join(ROOT, "data") },
  { name: "TELEHARNESS_LOG_DIR", type: "path", def: (c) => path.join(c.TELEHARNESS_DATA_DIR, "logs") },
  { name: "TELEHARNESS_CHAT_DIR", type: "path", def: (c) => c.TELEHARNESS_HOME },
  { name: "TELEHARNESS_ACCESS_LOG", type: "bool", def: true },
  { name: "TELEHARNESS_COOKIE_NAME", type: "string", def: "teleharness_t" },
  { name: "TELEHARNESS_TENANT_HOME", type: "path", def: (c) => path.join(c.TELEHARNESS_HOME, ".teleharness-tenants") },
  { name: "TELEHARNESS_TENANT_VAULT", type: "path", def: path.join(TELEHARNESS_DIR, "tenants-vault") },
  { name: "TELEHARNESS_TENANT_AGENT", type: "string", def: "" },
  // BUG-163: a tenant turn with pictures on a text-only model runs on this vision model of the same provider.
  { name: "TELEHARNESS_TENANT_VISION_MODEL", type: "string", def: "glm-5.3-flash" },
  // BUG-180: reasoning effort for a zai-coding-plan/glm-5.3* turn sent without a variant ("off" = provider default).
  { name: "TELEHARNESS_GLM_VARIANT", type: "enum", values: ["off", "low", "high", "max"], def: "max" },
  { name: "TELEHARNESS_FILE_ROOTS", type: "list", def: (c) => [c.TELEHARNESS_HOME] },
  { name: "TELEHARNESS_STALL_ABORT_MS", type: "ms", def: 900_000 },
  // FEAT-07.15: dialogs wait for the human; the auto-reject is opt-in only.
  { name: "TELEHARNESS_DIALOG_TIMEOUT_MS", type: "ms", def: 0 },
  { name: "TELEHARNESS_STALL_REPLAY_MS", type: "ms", def: 180_000 },
  { name: "TELEHARNESS_STALL_REPLAY_MAX", type: "int", def: 2, min: 0, max: 100 },
  // BUG-07.7: N identical tool calls in a row abort the turn (0 disables).
  { name: "TELEHARNESS_LOOP_ABORT_COUNT", type: "int", def: 8, min: 0, max: 1000 },
  // BUG-07.10: a busy turn silent this long is aborted before a new prompt.
  { name: "TELEHARNESS_PROMPT_UNSTICK_MS", type: "ms", def: 120_000 },
  // ADR-003 п.2: deployment kind. A non-prod instance refuses the prod
  // upstream (:4096) — the stand once ran on prod sessions (BUG-12.8).
  { name: "TELEHARNESS_ENV", type: "enum", values: ["prod", "stand", "test"], def: "prod" },
  // BUG-01.28: chats living under the system temp tree (smoke/QA probes)
  // are hidden from the session list. 0 shows them.
  { name: "TELEHARNESS_HIDE_TEMP_SESSIONS", type: "bool", def: true },
  // Tenant quotas (BUG-12.10). Bytes / requests; 0 disables the limit.
  { name: "TELEHARNESS_TENANT_PROMPT_LIMIT", type: "int", def: 8 * 1024 * 1024, min: 0 },
  { name: "TELEHARNESS_TENANT_UPLOAD_LIMIT", type: "int", def: 25 * 1024 * 1024, min: 0 },
  { name: "TELEHARNESS_TENANT_UPLOAD_QUOTA", type: "int", def: 500 * 1024 * 1024, min: 0 },
  { name: "TELEHARNESS_TENANT_RATE_PER_MIN", type: "int", def: 120, min: 0 },
  // Read by lib/claude.js itself (Г3); validated here so a typo is caught.
  { name: "TELEHARNESS_CLAUDE_TIMEOUT_MS", type: "ms", def: 0 },
  { name: "TELEHARNESS_CLAUDE_IDLE_MS", type: "ms", def: 0 }, // owner decision 2026-11-02: claude turns live until they finish; idle kill is opt-in
  { name: "TELEHARNESS_CLAUDE_BIN", type: "string", def: "" },
  // FEAT-13.10: MCP config file for ADMIN claude chats (--mcp-config; tenants
  // never get MCP servers). Empty = none.
  { name: "TELEHARNESS_CLAUDE_MCP_CONFIG", type: "string", def: "" },
  // FEAT-13.11: admin knowledge-base root (Obsidian active cache) for the
  // snapshot of the first turn of a Claude chat; "off" = no snapshot.
  // Tenants: their obsidianRoot / TELEHARNESS_TENANT_VAULT\<name>. Off by default:
  // point it at your Obsidian «agents» folder to turn the snapshot on.
  { name: "TELEHARNESS_KB_ROOT", type: "string", def: "off" },
  // BUG-01.48: chats with no message at all, a default title and older than
  // this many minutes are deleted by the server gc (0 disables).
  { name: "TELEHARNESS_GC_EMPTY_MIN", type: "int", def: 30, min: 0, max: 525_600 },
  // BUG-195: opencode instance of a chat folder is released after this many idle
  // minutes (0 = never; the owner's HOME / chat dir are never released).
  { name: "TELEHARNESS_INSTANCE_IDLE_MIN", type: "int", def: 30, min: 0, max: 525_600 },
  // BUG-195: period of the idle-instance sweep.
  { name: "TELEHARNESS_INSTANCE_SWEEP_MS", type: "ms", def: 300_000, min: 1000 },
  // Period of the gc sweep (empty chats + leftover tenant folders, BUG-04.6).
  { name: "TELEHARNESS_GC_INTERVAL_MS", type: "ms", def: 600_000, min: 200 },
  // FEAT-01.58 / BUG-146: file backups of the last turn of every chat —
  // Claude (PreToolUse hook) and opencode (vault-cache plugin, which uses the
  // same env or <dirname(TELEHARNESS_USERS_FILE)>/turn-undo = this default).
  { name: "TELEHARNESS_TURN_UNDO_ROOT", type: "path", def: (c) => path.join(c.TELEHARNESS_DATA_DIR, "turn-undo") },
  // BUG-13.14: auto titles via a short claude CLI call (0 → heuristic only).
  { name: "TELEHARNESS_TITLE_LLM", type: "bool", def: true },
  { name: "TELEHARNESS_TITLE_MODEL", type: "string", def: "claude-haiku-4-5" },
  { name: "TELEHARNESS_TITLE_TIMEOUT_MS", type: "ms", def: 20_000, min: 1000 },
  // FEAT-06.2 voice mode: local worker (Piper TTS + GigaAM STT). Off, or
  // python/models missing → GET /voice says unavailable, the UI hides it.
  { name: "TELEHARNESS_VOICE", type: "bool", def: true },
  { name: "TELEHARNESS_VOICE_PYTHON", type: "string", def: WIN ? path.join(TELEHARNESS_DIR, "voice", "venv", "Scripts", "python.exe") : path.join(TELEHARNESS_DIR, "voice", "venv", "bin", "python3") },
  { name: "TELEHARNESS_VOICE_MODELS", type: "string", def: path.join(TELEHARNESS_DIR, "voice", "models") },
  { name: "TELEHARNESS_VOICE_WORKER", type: "string", def: "" }, // default: ops/voice/voice-worker.py
  // Daily voice quota per tenant (0 = no limit); admin is never limited.
  { name: "TELEHARNESS_VOICE_TENANT_TTS_CHARS", type: "int", def: 40_000, min: 0 },
  { name: "TELEHARNESS_VOICE_TENANT_STT_SEC", type: "int", def: 1800, min: 0 },
  // BUG-11.13: model of a prompt that names none in a chat without a binding,
  // "provider/model". Empty → upstream /config model, then /provider default.
  { name: "TELEHARNESS_DEFAULT_MODEL", type: "string", def: "" },
  // FEAT-07.20 Web Push: 0 switches the feature off (routes answer 503).
  { name: "TELEHARNESS_PUSH", type: "bool", def: true },
  // VAPID «sub» (RFC 8292): mailto: or https: contact of the sender.
  { name: "TELEHARNESS_PUSH_SUBJECT", type: "string", def: "https://teleharness.home.example.net/teleharness/" },
  // Extra endpoint origins besides the known push services (tests / live
  // check with a local fake push service), «;»-separated.
  { name: "TELEHARNESS_PUSH_EXTRA_ORIGINS", type: "list", def: [] },
  { name: "TELEHARNESS_PUSH_DEBOUNCE_MS", type: "ms", def: 20_000 },
  { name: "TELEHARNESS_PUSH_MAX_PER_USER", type: "int", def: 10, min: 1, max: 100 },
  { name: "TELEHARNESS_ADMIN_TOKEN", type: "string", def: "", secret: true },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", type: "string", def: "", secret: true },
  // FEAT-16.3 (tasks 3.2): версия API opencode для адаптера lib/oc-client.js —
  // "v1" (1.19.5, по умолчанию) | "v2" (2.x: /api/*, Basic-авторизация).
  { name: "TELEHARNESS_OC_API", type: "string", def: "v1" },
  // Пароль Basic-авторизации v2; секрет — в логах маскируется, в ответах
  // портала не участвует (только заголовок Authorization к opencode).
  { name: "TELEHARNESS_OC_PASSWORD", type: "string", def: "", secret: true },
  // FEAT-16.3 (v2fix1): кэш ответа plugin.list гейта «закрыто при отказе» —
  // позитив (плагин подтверждён) и негатив (не подтверждён). Короткий негатив,
  // чтобы ходы пошли сразу после загрузки плагина; тесты сажают короче.
  { name: "TELEHARNESS_PLUGIN_GATE_TTL_MS", type: "ms", def: 15_000 },
  { name: "TELEHARNESS_PLUGIN_GATE_TTL_NEG_MS", type: "ms", def: 3_000 },
  // TASK-12.29: порог rss (МБ) для healthz `degraded`; 0 — контроль выключен.
  { name: "TELEHARNESS_MEM_WARN_MB", type: "int", def: 1500, min: 0 },
  // TASK-04.15 (SEC-27): дата включительного закрытия окна legacy-куки с
  // сырым токеном (ADR-009 п.4); после неё ветка legacy не срабатывает.
  { name: "TELEHARNESS_LEGACY_COOKIE_UNTIL", type: "string", def: "2026-12-02" },
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
