// Claude runner: chat turns for anthropic/* models via the claude CLI
// (Claude Code headless), instead of the opencode proxy. A claude turn is a
// ONE-SHOT process per prompt: `claude -p --input-format text --output-format
// stream-json ...` spawned in the session directory, the prompt written to
// its stdin as UTF-8; its stream-json lines are translated into the portal
// SSE contract and broadcast through the hub, so the existing UI renders the
// answer with zero frontend changes. Since FEAT-13.19 the turn is the same
// parts opencode sends (step-start / reasoning / tool / text, built by
// lib/claude-transcript.js): a Claude chat shows its work step by step.
//
// Conversation continuity rides the CLI itself: every run carries a claude
// session_id (from the init line, then the result), kept per zai session and
// replayed with --resume - also after an interrupted turn (FEAT-13.12).
// History persistence is portal-side (data/claude-sessions.json, see
// ZAI_DATA_DIR): opencode stores nothing for these turns, and the /message
// route in server.js merges this store with whatever upstream history the
// session had before its first claude prompt.
//
// Agents (FEAT-13.17): a chat bound to a Claude agent of the portal catalog
// (lib/claude-agents.js) runs with `--agents <compiled json> --agent <id>`;
// without one the argv is exactly the pre-agent one. Spike 2026-11-03 (CLI
// 2.1.316): the CLI snapshots the system prompt per conversation and replays
// it on --resume, IGNORING a different --agent (or its absence); `--system-
// prompt-snapshot off` re-renders it every turn, so it rides every agent
// turn and every resume of a chat that ever ran with an agent.
//
// Lifecycle (ADR-010): live runs are mirrored to data/claude-runs.json; a
// portal restart kills the orphaned CLI processes (image name + start time
// checked, never a foreign PID) and answers every unanswered question with
// «[Прервано рестартом портала]». A turn silent for idleTimeoutMs is killed;
// liveness rides a dedicated `zai.keepalive` event (startedAt, lastOutputAt,
// lastAction) instead of fake `busy` frames.
//
// Zero runtime dependencies - node stdlib only.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_MODELS, CLAUDE_PROVIDER, DEFAULT_CLAUDE_MODEL, isClaudeModel, normalizeCatalog } from "../shared/engine.js";
import { UPLOAD_DIR, fileRefText, openUnique, sanitizeFilename } from "./attach.js";
import { isClaudeAgentId } from "./claude-agents.js";
import { ClaudeTranscript } from "./claude-transcript.js";
import { readJsonStore, writeJsonAtomic, writeJsonAtomicAsync } from "./json-store.js";
import { TurnUndo, cutCopy, findTranscript, isInside, projectsRoot, sizeOf } from "./turn-undo.js";
import { KB_CONTEXT_KEY, withSnapshot } from "./kb-cache.js";
import { tenantKitArgs, withJailHook } from "./claude-tenant.js";
import { claudePromptFile } from "./user-prompt.js";
import { groupSpawnOpts, killChildTree as procKillChildTree, killTreeSync as procKillTreeSync } from "./proc.js";

import os from "node:os";
import { binDefaults } from "./paths.js";

export const CLAUDE_PROVIDER_ID = CLAUDE_PROVIDER;

// The native installer puts the CLI into ~/.local/bin; otherwise `claude` from PATH (npm -g, Homebrew).
const HOME_BIN = binDefaults({ home: os.homedir() }).claudeBin;
export const DEFAULT_BIN = existsSync(HOME_BIN) ? HOME_BIN : "claude";
// The portal checkout itself (D:\Portal\zai on prod): admin claude chats may
// always read it (FEAT-13.9), wherever the chat's own directory is.
const PORTAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Pure: the /zai/api/provider response with the claude catalog injected.
// normalizeProviders() keeps only CONNECTED providers' models, so the patch
// must touch both lists. Input never mutated; unknown upstream shapes pass
// through as well as they can (tolerant, like the rest of the portal).
export function providerPatch(resp, catalog = CLAUDE_MODELS) {
  const out = { ...(resp && typeof resp === "object" ? resp : {}) };
  const connected = Array.isArray(out.connected) ? out.connected.slice() : [];
  if (!connected.includes(CLAUDE_PROVIDER_ID)) connected.push(CLAUDE_PROVIDER_ID);
  out.connected = connected;
  const all = Array.isArray(out.all) ? out.all.filter((x) => x?.id !== CLAUDE_PROVIDER_ID) : [];
  const models = {};
  for (const m of catalog) {
    models[m.id] = {
      id: m.id,
      name: m.name,
      providerID: CLAUDE_PROVIDER_ID,
      status: "active",
      capabilities: { input: { text: true, image: true } },
      limit: { context: m.context },
    };
  }
  all.push({ id: CLAUDE_PROVIDER_ID, name: "Claude (подписка)", models });
  out.all = all;
  // Group default = the freshest Opus: normalizeProviders sorts each
  // provider's default first, so it tops the picker group.
  const def = isClaudeModel(DEFAULT_CLAUDE_MODEL, catalog) ? DEFAULT_CLAUDE_MODEL : catalog[0]?.id;
  out.default = { ...(out.default ?? {}), ...(def ? { [CLAUDE_PROVIDER_ID]: def } : {}) };
  return out;
}

function decodeDataUrl(url) {
  const comma = String(url ?? "").indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) return { buf: Buffer.from(payload, "base64"), mime: meta.replace(/;base64$/i, "") || null };
    return { buf: Buffer.from(decodeURIComponent(payload), "utf8"), mime: meta || null };
  } catch {
    return null;
  }
}

// Prompt parts -> { prompt, stored }. Text parts join; inline images land in
// <sessionDir>/.zai-uploads and become reference text (the CLI reads them
// with its Read tool). `stored` is what the history keeps: the same parts
// with every data: URL swapped for that reference text - base64 images no
// longer bloat claude-sessions.json (BUG-13.6); the client renders the
// reference as an attachment chip. Non-image file parts never reach this
// function as files: server.js materializes them before dispatch.
export function buildTurn(parts, sessionDir) {
  const chunks = [];
  const stored = [];
  for (const part of parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string") {
      if (part.text.trim()) chunks.push(part.text);
      stored.push({ ...part });
      continue;
    }
    if (part?.type === "file" && typeof part.url === "string" && part.url.startsWith("data:")) {
      const decoded = decodeDataUrl(part.url);
      if (!decoded || decoded.buf.length === 0) continue;
      const dirAbs = path.join(String(sessionDir ?? "."), UPLOAD_DIR);
      try {
        mkdirSync(dirAbs, { recursive: true });
        // BUG-218 (SRV-05, design §2): the file is created exclusively (flag
        // "wx") — parallel turns of the same folder cannot clobber each other
        const opened = openUnique(dirAbs, sanitizeFilename(part.filename));
        try {
          writeFileSync(opened.fd, decoded.buf);
        } finally {
          closeSync(opened.fd);
        }
        const ref = fileRefText(opened.name, decoded.buf.length, part.mime || decoded.mime);
        chunks.push(ref);
        stored.push({ type: "text", text: ref });
      } catch (err) {
        // BUG-215: a failed save must stay visible (prompt + history), never a silent drop
        const name = sanitizeFilename(part.filename);
        const note = `[вложение не сохранено: ${name}]`;
        chunks.push(note);
        stored.push({ type: "text", text: note });
        console.log(`[zai-claude] attachment not saved (${name}) in ${dirAbs}: ${err?.message ?? err}`);
      }
      continue;
    }
    if (part && typeof part === "object") stored.push({ ...part });
  }
  return { prompt: chunks.join("\n\n"), stored };
}

export function buildPrompt(parts, sessionDir) {
  return buildTurn(parts, sessionDir).prompt;
}

// Pure translation of one stream-json line -> runner signal. The runner owns
// sequencing; this owns shapes. Returns null for ignorable lines. Subagent
// traffic (parent_tool_use_id set) never becomes answer text - only the
// main conversation's text reaches the chat.
//   { kind: "init", claudeSid }
//   { kind: "message_start", messageId }
//   { kind: "delta", text }
//   { kind: "tool", name }
//   { kind: "assistant", messageId, text, tools }
//   { kind: "result", claudeSid, isError, text }
export function translateLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  return translateEvent(evt);
}

// The same for an already parsed line (the runner parses once and feeds both
// this and the transcript).
export function translateEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const sub = Boolean(evt.parent_tool_use_id);
  if (evt.type === "system" && evt.subtype === "init") {
    return typeof evt.session_id === "string" && evt.session_id ? { kind: "init", claudeSid: evt.session_id } : null;
  }
  if (evt.type === "stream_event") {
    const e = evt.event;
    if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
      return typeof e.content_block.name === "string" ? { kind: "tool", name: e.content_block.name } : null;
    }
    if (sub) return null;
    if (e?.type === "message_start") return { kind: "message_start", messageId: e.message?.id ?? null };
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
      const text = e.delta.text;
      return typeof text === "string" && text ? { kind: "delta", text } : null;
    }
    return null;
  }
  if (evt.type === "assistant") {
    const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
    const text = sub
      ? ""
      : blocks
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
    const tools = blocks.filter((b) => b?.type === "tool_use" && typeof b.name === "string").map((b) => b.name);
    if (!text && tools.length === 0) return null;
    return { kind: "assistant", messageId: typeof evt.message?.id === "string" ? evt.message.id : null, text, tools };
  }
  if (evt.type === "result") {
    return {
      kind: "result",
      claudeSid: typeof evt.session_id === "string" ? evt.session_id : null,
      isError: evt.is_error === true,
      text: typeof evt.result === "string" ? evt.result : "",
    };
  }
  return null;
}

// The multi-step answer (BUG-13.8 / COR-13) is lib/claude-transcript.js now:
// every step keeps its own parts (FEAT-13.19).

// --- child process environment (BUG-13.2 / SEC-9) -----------------------------

// What the CLI itself (and its tools: shell, git, npx-launched MCP servers)
// needs - nothing else. Portal secrets (ZAI_*) never pass, whatever the list.
const ENV_ALLOW = new Set(
  [
    "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "OS",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "ProgramData", "ALLUSERSPROFILE", "PUBLIC",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
    "CommonProgramFiles(x86)", "CommonProgramW6432", "PSModulePath",
    "USERNAME", "USERDOMAIN", "COMPUTERNAME", "USER", "LOGNAME", "SHELL",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
    "LANG", "LANGUAGE", "TZ", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", // macOS / Linux
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ].map((k) => k.toLowerCase()),
);
// CLAUDE_* / ANTHROPIC_*: the owner's CLI auth and configuration.
const ENV_PREFIX_ALLOW = ["claude_", "anthropic_", "lc_"];

export function childEnv(src = process.env, { token = null } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(src ?? {})) {
    if (typeof v !== "string") continue;
    const lk = k.toLowerCase();
    if (lk.startsWith("zai_")) continue;
    if (ENV_ALLOW.has(lk) || ENV_PREFIX_ALLOW.some((p) => lk.startsWith(p))) out[k] = v;
  }
  if (token && !Object.keys(out).some((k) => k.toUpperCase() === "CLAUDE_CODE_OAUTH_TOKEN")) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  return out;
}

// --- permission profiles (FEAT-13.9 / ADR-004) --------------------------------

// access: "admin" → no permission dead ends (headless -p cannot ask), the
// portal checkout readable, optional MCP config (FEAT-13.10); "tenant" →
// the CLI's restricted mode + acceptEdits (BUG-144: dontAsk denied every Edit/Write): no code-running tools, edits allowed only in
// the working directory, no user/project settings or MCP servers, anything
// that would prompt is denied. Unspecified → legacy (no permission flags:
// the owner's ~/.claude settings decide) until server.js passes the role.
// BUG-169: the --add-dir of a tenant turn — its own zone root (Windows path),
// or null (admin, no zone, vault off). Pure.
export function tenantKbDir(access, kbZone) {
  if (access !== "tenant" || !kbZone?.tenant || typeof kbZone.root !== "string" || !kbZone.root.trim()) return null;
  return path.resolve(kbZone.root.trim());
}

export function permissionArgs(access, { adminMode = "bypassPermissions", addDirs = [PORTAL_ROOT], mcpConfig = null } = {}) {
  if (access === "admin") {
    const out = ["--permission-mode", adminMode];
    for (const d of addDirs) if (typeof d === "string" && d.trim()) out.push("--add-dir", d.trim());
    if (mcpConfig) out.push("--mcp-config", mcpConfig);
    return out;
  }
  if (access === "tenant") {
    return ["--restricted", "--strict-mcp-config", "--permission-mode", "acceptEdits", "--permission-prompts", "none"];
  }
  return [];
}

// FEAT-13.10: a broken ZAI_CLAUDE_MCP_CONFIG must not kill every admin turn
// (the CLI exits on an unreadable --mcp-config). → {file, servers} when the
// file is a readable {"mcpServers": {...}} JSON, else {file: null, error}.
export function checkMcpConfig(file) {
  if (!file) return { file: null, error: null };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { file: null, error: `ZAI_CLAUDE_MCP_CONFIG ${file}: ${err?.code === "ENOENT" ? "file not found" : err?.message ?? err}` };
  }
  const servers = doc && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? Object.keys(doc.mcpServers) : null;
  if (!servers || servers.length === 0) return { file: null, error: `ZAI_CLAUDE_MCP_CONFIG ${file}: no "mcpServers"` };
  return { file, servers, error: null };
}

// --- process helpers -----------------------------------------------------------

const imageName = (file) => path.basename(String(file ?? "")).replace(/\.exe$/i, "").toLowerCase();

// {name, startMs} of a live process, null when there is none. Used only for
// orphan cleanup at startup, so a sync call is fine.
export function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { '{0}|{1}' -f $p.ProcessName, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
      if (!out) return null;
      const [name, start] = out.split("|");
      return { name: imageName(name), startMs: Number(start) || null };
    }
    const out = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim();
    return out ? { name: imageName(out), startMs: null } : null;
  } catch {
    return null;
  }
}

// Kill a process with its whole tree (claude.exe spawns shells and MCP
// servers; a plain TerminateProcess leaves them running on Windows).
// TASK-17.1: Windows — taskkill /T; POSIX — группа процессов (lib/proc.js).
export function killTreeSync(pid) {
  return procKillTreeSync(pid);
}

function killChildTree(child) {
  procKillChildTree(child);
}

const nowMs = () => Date.now();
const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const SAFE_SID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const MARK = {
  user: "[Прервано]",
  timeout: "[Прервано по таймауту]",
  restart: "[Прервано рестартом портала]",
  cancelled: "[Отменено: ход остановлен до начала]",
};
const THINKING_SETTINGS = { showThinkingSummaries: true };
const crashMark = (run) =>
  `[Прервано: процесс Claude завершился неожиданно (${run.exitSignal ? `сигнал ${run.exitSignal}` : `код ${run.exitCode ?? "?"}`}). Сделанное сохранено — напишите «Продолжай», и ход продолжится с этого места.]`;
const idleMark = (ms) => `[Прервано по бездействию: нет вывода ${Math.max(1, Math.round(ms / 60_000))} мин]`;

export class ClaudeRunner {
  // hub: EventHub (uses emit() + markManaged()); storePath: JSON persistence
  // (data/claude-sessions.json via ZAI_DATA_DIR); runsPath: live-run mirror
  // for orphan cleanup (default claude-runs.json next to the store);
  // catalogPath: optional model list override (claude-models.json next to
  // the store, FEAT-11.10). binPath override is for tests (a .js/.mjs
  // fixture is spawned with process.execPath).
  //
  // runTimeoutMs: hard cap from the start, OFF by default (a 15-min cap
  // murdered legitimately long dogfood turns, FEAT-13.4);
  // ZAI_CLAUDE_TIMEOUT_MS is the opt-in kill switch.
  // idleTimeoutMs: kill after this long WITHOUT ANY OUTPUT (ADR-010);
  // ZAI_CLAUDE_IDLE_MS, default 0 = off (owner decision: turns live until done). Generous on purpose: a
  // silent tool (long build) must not be shot.
  // keepaliveMs: period of the zai.keepalive liveness event.
  constructor({
    hub,
    storePath,
    runsPath = storePath ? path.join(path.dirname(storePath), "claude-runs.json") : null,
    catalogPath = storePath ? path.join(path.dirname(storePath), "claude-models.json") : null,
    binPath = process.env.ZAI_CLAUDE_BIN || DEFAULT_BIN,
    token = process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
    runTimeoutMs = Number(process.env.ZAI_CLAUDE_TIMEOUT_MS ?? 0),
    idleTimeoutMs = Number(process.env.ZAI_CLAUDE_IDLE_MS ?? 0),
    keepaliveMs = 30_000,
    maxQueue = 5,
    adminMode = process.env.ZAI_CLAUDE_ADMIN_MODE || "bypassPermissions",
    addDirs = process.env.ZAI_CLAUDE_ADD_DIRS ? process.env.ZAI_CLAUDE_ADD_DIRS.split(";") : [PORTAL_ROOT],
    mcpConfig = process.env.ZAI_CLAUDE_MCP_CONFIG || null,
    env = process.env,
    procInspect = inspectProcess,
    procKill = killTreeSync,
    log = (msg) => console.log(msg),
    onTurnEnd = null,
    onTurnStart = null,
    agents = null,
    onAgentMissing = null,
    kbSnapshot = null,
    undoRoot = storePath ? path.join(path.dirname(storePath), "turn-undo") : null,
    projectsDir = projectsRoot(env),
    // FEAT-04.11: lib/claude-tenant.js tenantKit() — jailed Bash, zai-* skills,
    // marketplace for tenant chats; null → tenants keep the file-only profile.
    tenantKit = null,
    // FEAT-03.22: where the --append-system-prompt-file files of users'
    // own system prompts are written (content-addressed).
    promptDir = storePath ? path.join(path.dirname(storePath), "claude-prompts") : null,
    // FEAT-05.29: правило портала (о показе файлов в чате) — раздел того же файла,
    // в каждом ходе; null → файла без инструкций пользователя нет, как раньше.
    portalRule = null,
    // TASK-13.27 (design §5): the store is written deferred - flushDelayMs
    // after the LAST change, capped at flushMaxMs from the FIRST unsaved
    // change. Defaults 250/2000. Tests shrink both and may inject the async
    // write backend (storeWriteAsync) to count disk writes.
    flushDelayMs = 250,
    flushMaxMs = 2000,
    storeWriteAsync = null,
  } = {}) {
    this.#hub = hub;
    this.#storePath = storePath;
    this.#runsPath = runsPath;
    this.#catalogPath = catalogPath;
    this.#binPath = binPath;
    this.#token = token;
    this.#runTimeoutMs = Number.isFinite(runTimeoutMs) ? runTimeoutMs : 0;
    this.#idleTimeoutMs = Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : 0;
    this.#keepaliveMs = keepaliveMs;
    this.#maxQueue = maxQueue;
    this.#perm = { adminMode, addDirs, mcpConfig };
    this.#tenantKit = tenantKit;
    this.#promptDir = promptDir;
    this.#portalRule = typeof portalRule === "string" && portalRule.trim() ? portalRule : null;
    this.#env = env;
    this.#log = log;
    this.#onTurnEnd = typeof onTurnEnd === "function" ? onTurnEnd : null;
    this.#onTurnStart = typeof onTurnStart === "function" ? onTurnStart : null;
    this.#agents = agents;
    this.#onAgentMissing = typeof onAgentMissing === "function" ? onAgentMissing : null;
    this.#kbSnapshot = typeof kbSnapshot === "function" ? kbSnapshot : null;
    this.#undo = undoRoot ? new TurnUndo({ root: undoRoot }) : null;
    this.#projects = projectsDir;
    this.#flushDelayMs = Number.isFinite(flushDelayMs) && flushDelayMs >= 0 ? flushDelayMs : 250;
    this.#flushMaxMs = Number.isFinite(flushMaxMs) && flushMaxMs >= this.#flushDelayMs ? flushMaxMs : 2000;
    this.#storeWriteAsync = typeof storeWriteAsync === "function" ? storeWriteAsync : writeJsonAtomicAsync;
    this.#store = this.#loadStore();
    this.#reloadCatalog();
    this.#recover(procInspect, procKill);
  }

  #hub;
  #storePath;
  #runsPath;
  #catalogPath;
  #binPath;
  #token;
  #runTimeoutMs;
  #idleTimeoutMs;
  #keepaliveMs;
  #maxQueue;
  #perm;
  #tenantKit;
  #promptDir;
  #portalRule;
  #env;
  #log;
  // BUG-13.14: called after every finished turn of a live chat
  // ({sid, dir, reason}); server.js hangs the auto-titler on it.
  #onTurnEnd = null;
  // BUG-142: ({sid, dir}) right after a user turn is stored (also queued
  // ones); server.js titles the chat from it without waiting for the answer.
  #onTurnStart = null;
  // FEAT-13.17: ClaudeAgentCatalog (has/compiledFile/nameOf) or null = no
  // agents; onAgentMissing({sid, dir, agent, name}) when a bound agent is
  // gone from the catalog at the start of its turn (server.js resets the
  // binding and tells the client).
  #agents = null;
  #onAgentMissing = null;
  // FEAT-13.11: ({dir, sid, zone}) => snapshot text | null (lib/kb-cache.js
  // buildSnapshot); null = no knowledge-base cache for Claude chats.
  #kbSnapshot = null;
  // FEAT-01.58: file backups of the last turn (lib/turn-undo.js) or null.
  #undo = null;
  // FEAT-01.57: where the CLI keeps its transcripts (~/.claude/projects).
  #projects = null;
  #models = CLAUDE_MODELS;
  // zaiSessionID -> { directory, claudeSid, updatedAt?, title?, messages: [{info, parts}] }
  #store = { version: 1, sessions: {} };
  // TASK-13.27: deferred store write state (see #flush).
  #flushDelayMs = 250;
  #flushMaxMs = 2000;
  #storeWriteAsync = writeJsonAtomicAsync;
  #storeTimer = null;
  #storeDirty = false;
  #storeDirtySince = 0;
  #storeWriting = false;
  #storeWriteQueued = false;
  // zaiSessionID -> live turn (spawned child + timers + transcript state)
  #runs = new Map();
  // zaiSessionID -> [queued turn] (follow-ups sent during a live turn)
  #queues = new Map();
  // FEAT-01.77: троттлинг обновлений работы субагента — не чаще раза в 300 мс
  // на часть; последнее состояние доставляется финальными частями хода
  #zaiTimer = null;
  #zaiPending = new Map(); // partID -> {dir, sid, messageID, op}
  // BUG-184: zaiSessionID -> run whose answer is DONE (`result` came) but whose
  // CLI process is still alive, waiting for background tasks of the agent
  // (Bash run_in_background, …). The chat is free; a new message stops the
  // tail; a round the tail runs on its own becomes one more answer.
  #tails = new Map();
  // GET /zai/api/provider injection cache: { at, body, etag }
  #provider = { at: 0, body: null, etag: null };

  // --- routing helpers (used by server.js) -----------------------------------

  // The store knows this session (claude turns ran here).
  has(sid) {
    return this.#runs.has(sid) || Boolean(this.#store.sessions[sid]?.messages?.length);
  }

  dirOf(sid) {
    return this.#store.sessions[sid]?.directory ?? null;
  }

  // Every chat the store knows (account deletion sweeps them by directory).
  sessionIds() {
    return Object.keys(this.#store.sessions);
  }

  // Model of the latest claude answer in this chat (binding inference for
  // chats created before session-bindings existed); null when none.
  lastModelOf(sid) {
    const list = this.#store.sessions[sid]?.messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const info = list[i]?.info;
      if (info?.role === "assistant" && typeof info.modelID === "string" && info.modelID) return info.modelID;
    }
    return null;
  }

  // --- activity (BUG-13.16) -------------------------------------------------

  // Last activity of a claude chat in ms (turn start/end, new message), or
  // null. Claude turns never touch the upstream record, so its time.updated
  // stays at creation; GET /session lifts it to this value. Older store
  // entries without updatedAt fall back to their newest message time.
  activityOf(sid) {
    const e = this.#store.sessions[sid];
    if (!e) return null;
    let at = Number.isFinite(e.updatedAt) ? e.updatedAt : 0;
    for (const m of e.messages ?? []) {
      const t = m?.info?.time ?? {};
      at = Math.max(at, Number(t.completed) || 0, Number(t.created) || 0);
    }
    return at > 0 ? at : null;
  }

  // Record activity (persisted with the next/own flush) and tell every
  // client: session.updated with time.updated re-sorts the chat list live,
  // the same way opencode's own session.updated does for its chats.
  #touch(sid, entry, dir, at = nowMs(), flush = false) {
    if (!entry || this.#store.sessions[sid] !== entry) return;
    entry.updatedAt = Math.max(Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0, at);
    if (flush) this.#flush();
    const info = { id: sid, time: { updated: entry.updatedAt } };
    if (entry.directory) info.directory = entry.directory;
    this.#emit(dir ?? entry.directory, { type: "session.updated", properties: { sessionID: sid, info } });
  }

  // --- titles (BUG-13.14) -----------------------------------------------------

  // {title, source: "auto"|"user"|"upstream"} or null.
  titleInfo(sid) {
    const e = this.#store.sessions[sid];
    return e && typeof e.title === "string" && e.title ? { title: e.title, source: e.titleSource ?? null } : null;
  }

  // Stored with the chat; a chat renamed before its first prompt gets an
  // entry of its own (dispatch reuses it).
  setTitle(sid, title, source) {
    const t = String(title ?? "").trim();
    if (typeof sid !== "string" || !sid || !t) return;
    const entry = (this.#store.sessions[sid] ??= { directory: null, claudeSid: null, messages: [] });
    entry.title = t.slice(0, 200);
    entry.titleSource = source ?? null;
    this.#flush();
  }

  // Raw text of the first user message (snapshot included, if any).
  firstUserText(sid) {
    for (const m of this.#store.sessions[sid]?.messages ?? []) {
      if (m?.info?.role !== "user") continue;
      const text = (m.parts ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n\n");
      if (text.trim()) return text;
    }
    return "";
  }

  // The current claude catalog (built-in or data/claude-models.json).
  models() {
    return this.#models.map((m) => ({ ...m }));
  }

  // Claude-side messages (oldest first) or null when none stored.
  messages(sid) {
    const list = this.#store.sessions[sid]?.messages;
    return Array.isArray(list) && list.length > 0 ? list.map((m) => ({ info: structuredClone(m.info), parts: structuredClone(m.parts) })) : null;
  }

  // BUG-164: the answer of the turn running right now (no time.completed),
  // with every part streamed so far; null when no turn runs. Without it a
  // reload or a resync mid-turn showed nothing of the work already done.
  liveAnswer(sid) {
    const run = this.#runs.get(sid);
    if (!run?.info || run.finalized) return null;
    let parts = [];
    try {
      parts = run.transcript.parts();
    } catch {}
    return { info: structuredClone(run.info), parts };
  }

  // Upstream history (best effort) + claude history (+ the running answer,
  // BUG-164), merged oldest-first.
  async mergedMessages(sid, dir, upstream) {
    const own = this.messages(sid) ?? [];
    const live = this.liveAnswer(sid);
    if (live && !own.some((m) => m.info?.id === live.info.id)) own.push(live);
    let upstreamList = [];
    try {
      const u = new URL(`/session/${encodeURIComponent(sid)}/message`, upstream);
      if (dir) u.searchParams.set("directory", dir);
      const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list)) upstreamList = list;
      }
    } catch {} // upstream down: claude history alone still renders
    const created = (m) => Number(m?.info?.time?.created ?? 0);
    return [...upstreamList, ...own].sort((a, b) => created(a) - created(b));
  }

  forget(sid) {
    this.#queues.delete(sid);
    this.#dropZai(); // FEAT-01.77: сессии больше нет — отложенные части не нужны
    this.#kill(sid, "deleted");
    delete this.#store.sessions[sid];
    this.#flush();
    try {
      this.#undo?.forget(sid); // FEAT-01.58: the chat's file backups go with it
    } catch {}
  }

  // --- rewind: «Изменить», «Сгенерировать заново», «Отменить ход» -----------
  // (FEAT-01.57 / FEAT-01.58). Only the LAST turn, only when nothing runs.
  // revert hides the last turn (its question and every answer after it) and
  // rolls back the files its write/edit tools changed; the messages stay in
  // the store until the next prompt commits the revert (or «Вернуть» brings
  // them back) — the same contract as opencode's session.revert.

  // {messageID, at} of a pending revert, or null.
  revertOf(sid) {
    const r = this.#store.sessions[sid]?.revert;
    return r?.messageID ? { messageID: r.messageID, at: r.at ?? null } : null;
  }

  // The last user message of a chat ({id, index}) or null.
  #lastUser(entry) {
    const list = entry?.messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i]?.info?.role === "user") return { id: list[i].info.id, index: i };
    return null;
  }

  // Busy, a queue, or not the last question → {status, error}; else null.
  #rewindProblem(sid, entry, messageID) {
    if (!entry) return { status: 404, error: "session not found" };
    if (this.#runs.has(sid) || (this.#queues.get(sid)?.length ?? 0) > 0) return { status: 409, error: "turn in progress" };
    const last = this.#lastUser(entry);
    if (!last || last.id !== messageID) return { status: 409, error: "not the last turn" };
    // BUG-184: a tail of the turn being undone must not add an answer to it later.
    this.#dropTail(sid);
    return null;
  }

  // within(path) for the file list: a tenant sees only its chat folder.
  #within(entry, access) {
    const dir = entry?.directory;
    return access === "admin" ? null : (p) => Boolean(dir) && isInside(p, dir);
  }

  // What «Отменить ход» will do: {files: [{path, action, skipped?}], shell}.
  revertPreview(sid, messageID, { access = "admin" } = {}) {
    const entry = this.#store.sessions[sid];
    const problem = this.#rewindProblem(sid, entry, messageID);
    if (problem) return problem;
    const files = this.#undo ? this.#undo.preview(sid, messageID, { within: this.#within(entry, access) }) : [];
    return { files, shell: true };
  }

  revert(sid, messageID, { access = "admin" } = {}) {
    const entry = this.#store.sessions[sid];
    if (entry?.revert) {
      if (entry.revert.messageID === messageID && !this.#runs.has(sid)) return { ok: true, files: [], skipped: [], revert: this.revertOf(sid) };
      return { status: 409, error: "already reverted" };
    }
    const problem = this.#rewindProblem(sid, entry, messageID);
    if (problem) return problem;
    let res = { files: [], skipped: [] };
    try {
      if (this.#undo) res = this.#undo.revert(sid, messageID, { within: this.#within(entry, access) });
    } catch (err) {
      this.#log(`[zai-claude] turn undo failed: ${err?.message ?? err}`);
    }
    entry.revert = { messageID, at: nowMs() };
    this.#flush();
    this.#emitRevert(sid, entry);
    return { ok: true, files: res.files, skipped: res.skipped, revert: this.revertOf(sid) };
  }

  // «Вернуть»: the hidden turn and its files come back.
  unrevert(sid) {
    const entry = this.#store.sessions[sid];
    if (!entry) return { status: 404, error: "session not found" };
    if (!entry.revert) return { status: 409, error: "nothing to restore" };
    if (this.#runs.has(sid)) return { status: 409, error: "turn in progress" };
    let files = [];
    try {
      if (this.#undo) files = this.#undo.unrevert(sid, entry.revert.messageID).files;
    } catch (err) {
      this.#log(`[zai-claude] turn redo failed: ${err?.message ?? err}`);
    }
    delete entry.revert;
    this.#flush();
    this.#emitRevert(sid, entry);
    return { ok: true, files };
  }

  #emitRevert(sid, entry) {
    const info = { id: sid, revert: this.revertOf(sid) };
    if (entry.directory) info.directory = entry.directory;
    this.#emit(entry.directory, { type: "session.updated", properties: { sessionID: sid, info } });
  }

  // The next prompt after a revert: the hidden messages go for good, and the
  // CLI history continues from the point before the dropped question.
  #commitRevert(sid, entry, dir) {
    const turnId = entry.revert.messageID;
    delete entry.revert;
    const i = entry.messages.findIndex((m) => m?.info?.id === turnId);
    try {
      this.#undo?.drop(sid, turnId);
    } catch {}
    if (i < 0) return;
    const cut = entry.messages[i].cut ?? null;
    const removed = entry.messages.splice(i);
    if (cut) {
      if (!cut.claudeSid || cut.bytes === 0) {
        entry.claudeSid = null;
        delete entry.fork;
      } else entry.fork = { from: cut.claudeSid, bytes: Number.isFinite(cut.bytes) ? cut.bytes : null };
    } else {
      // A turn from before FEAT-01.57: cut before the transcript's last
      // prompt — unless the question never reached the CLI.
      const answer = removed.find((m) => m?.info?.role === "assistant");
      if (entry.claudeSid && answer?.info?.zai?.interrupted !== "cancelled") entry.fork = { from: entry.claudeSid, bytes: null };
    }
    for (const m of removed) this.#emit(dir, { type: "message.removed", properties: { sessionID: sid, messageID: m.info.id } });
    this.#emitRevert(sid, entry);
  }

  // Stop: kill the live turn AND drop the follow-ups queued behind it (each
  // gets an honest «cancelled» answer). True when a turn was running.
  abort(sid) {
    this.#dropQueue(sid);
    return this.#kill(sid, "user");
  }

  // Graceful shutdown hook (server.js on SIGTERM): kill every live CLI; the
  // runs file then lets the next start answer the interrupted questions.
  shutdown() {
    for (const run of this.#runs.values()) {
      run.abortedBy ??= "restart";
      if (run.child?.pid) killTreeSync(run.child.pid);
    }
    for (const tail of this.#tails.values()) {
      tail.superseded = true;
      if (tail.child?.pid) killTreeSync(tail.child.pid);
    }
  }

  // Liveness for /status (BUG-13.3): { sid: {startedAt, lastOutputAt,
  // lastAction, queued} } for every live claude turn.
  liveness() {
    const out = {};
    for (const [sid, run] of this.#runs) out[sid] = this.#live(sid, run);
    return out;
  }

  // { sid: {type:"busy"} } for every live turn (server.js healthz counts it).
  busySnapshot() {
    const out = {};
    for (const sid of this.#runs.keys()) out[sid] = { type: "busy" };
    // FEAT-01.77: после `result` CLI ждёт в хвосте запущенного агента —
    // чат остаётся занятым для клиента и healthz, пока агент не завершится
    for (const [sid, tail] of this.#tails) {
      if (!out[sid] && !tail.superseded && tail.transcript?.hasRunningZaiRun?.()) out[sid] = { type: "busy" };
    }
    return out;
  }

  #live(sid, run) {
    return { startedAt: run.startedAt, lastOutputAt: run.lastOutputAt, lastAction: run.lastAction, queued: this.#queues.get(sid)?.length ?? 0 };
  }

  #kill(sid, reason) {
    const tail = this.#tails.get(sid);
    this.#dropTail(sid);
    const run = this.#runs.get(sid);
    if (!run) {
      // FEAT-01.77: «Стоп» посреди работы субагента в хвосте (после `result`)
      // — чат снова свободен: busy снимает #stopTailRuns, клиенту нужен idle
      if (reason === "user" && tail && (tail.zaiBusy || tail.transcript?.hasRunningZaiRun?.())) {
        this.#emit(tail.dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
        this.#emit(tail.dir, { type: "session.idle", properties: { sessionID: sid } });
      }
      return false;
    }
    run.abortedBy ??= reason;
    killChildTree(run.child);
    return true;
  }

  // BUG-184: stop a tail (its background tasks die with it). then() runs once
  // the process is gone — the next CLI of the chat must not share the
  // transcript with a dying one. No tail → then() right away.
  #dropTail(sid, then = null) {
    const tail = this.#tails.get(sid);
    if (!tail) {
      if (then) then();
      return false;
    }
    if (!tail.superseded) {
      // FEAT-01.77: гаснущий хвост уносит с собой работающих субагентов —
      // до_kill отмечаем их stopped в части прошлого ответа
      this.#stopTailRuns(sid, tail);
    }
    tail.superseded = true;
    if (then) (tail.onClosed ??= []).push(then);
    // A tail without background tasks is just exiting (transcript flush): let
    // it finish — a kill is slower (taskkill) and could cut the write. Kill
    // only a tail that waits for tasks, or one that does not go in 5 s.
    if (tail.bgTasks) killChildTree(tail.child);
    else if (!tail.dropTimer) {
      tail.dropTimer = setTimeout(() => killChildTree(tail.child), 5000);
      tail.dropTimer.unref?.();
    }
    return true;
  }

  // --- the turn --------------------------------------------------------------

  // Answers 204 immediately (the client awaits the HTTP round-trip only; the
  // answer itself arrives as hub events). Body: the materialized prompt
  // Buffer from server.js (file parts already swapped for text refs).
  // access: "admin" | "tenant" (FEAT-13.9 permission profile; server.js
  // passes the caller's role), anything else = legacy flags.
  // A prompt during a live turn is QUEUED (BUG-13.7): stored and shown now,
  // run as the next turn; 409 only when the queue is full.
  // agent: the chat binding's Claude-agent id (FEAT-13.17) or null — never
  // the body's; a queued turn keeps the agent of the moment it was sent.
  // kbZone: the caller's knowledge-base zone (lib/kb-cache.js zoneForUser)
  // or null — FEAT-13.11: the FIRST turn of a chat gets the snapshot in
  // front of its prompt; the stored user text stays clean (FEAT-01.32), the
  // snapshot rides as metadata.kbContext of the first text part.
  // jail: {name, home} of a tenant (lib/claude-tenant.js tenantJailFor) — the
  // tenant kit (jailed Bash, skills, marketplace) needs it; null → file tools only.
  // systemPrompt: the user's own system prompt (FEAT-03.22), "" = none.
  // workDir (FEAT-04.12 stage B): the tenant chat's own subfolder (lib/chat-folder.js) —
  // the CLI runs there; dir stays the session folder (events, store, the tenant root).
  async dispatch({ res, sid, dir, body, access, agent = null, kbZone = null, jail = null, systemPrompt = "", workDir = null, portalNote = "" }) {
    const send = (status, obj) => {
      res.writeHead(status, obj ? { "content-type": "application/json" } : undefined);
      res.end(obj ? JSON.stringify(obj) : undefined);
    };
    let parsed = null;
    try {
      parsed = JSON.parse((Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""))).toString("utf8"));
    } catch {}
    // BUG-215: a truncated/non-JSON body (or no parts) would run as an EMPTY
    // turn (204, a wasted turn, an empty question in history) — reject before
    // any store write or CLI spawn.
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.parts)) return send(400, { error: "bad json body" });
    const parts = parsed.parts;
    const modelID = String(parsed?.model?.modelID ?? DEFAULT_CLAUDE_MODEL);
    // ADR-004 §4: only catalog ids reach the CLI's --model.
    if (!isClaudeModel(modelID, this.#models)) return send(400, { error: `unknown claude model: ${modelID}` });
    // BUG-184: a tail being stopped for a new turn counts as busy (that turn
    // starts once the process is gone; later messages queue behind it).
    const busy = this.#runs.has(sid) || this.#tails.get(sid)?.superseded === true;
    if (busy && (this.#queues.get(sid)?.length ?? 0) >= this.#maxQueue) return send(409, { error: "claude queue full: wait for the current answer" });
    // FEAT-01.57/01.58: a prompt after «Изменить» / «Отменить ход» commits
    // the revert — before the snapshot check (the first question may be gone).
    const pending = this.#store.sessions[sid];
    // BUG-184: a tail being stopped is not a live answer — the revert commits now
    if (pending?.revert && !this.#runs.has(sid)) this.#commitRevert(sid, pending, dir);

    // An opencode agent name must never reach a claude turn (BUG-11.2): only
    // a catalog id from the binding does.
    let { prompt, stored } = buildTurn(parts, dir);
    const snapshot = this.#snapshotFor(sid, dir, kbZone, stored);
    if (snapshot) {
      prompt = withSnapshot(snapshot, prompt);
      const first = stored.find((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim());
      first.metadata = { ...(first.metadata ?? {}), [KB_CONTEXT_KEY]: snapshot };
    }
    const created = nowMs();
    const userMsgId = shortId("msgc_u");

    // Persist the user turn BEFORE spawning: a spawn failure (or a restart)
    // must still leave the question in history (the store is what /message
    // serves).
    const entry = (this.#store.sessions[sid] ??= { directory: dir ?? null, claudeSid: null, messages: [] });
    entry.directory = dir ?? entry.directory ?? null;
    entry.messages.push({ info: { id: userMsgId, sessionID: sid, role: "user", time: { created } }, parts: stored });
    entry.updatedAt = Math.max(Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0, created);
    this.#flush();

    send(204);

    this.#hub?.markManaged?.(sid);
    this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
    // info-only shape, like the upstream wire: the client's upsertIncoming
    // replaces the optimistic tmp- bubble by role+order and keeps its parts.
    this.#emit(dir, { type: "message.updated", properties: { sessionID: sid, info: { id: userMsgId, sessionID: sid, role: "user", time: { created } } } });
    this.#touch(sid, entry, dir, created); // BUG-13.16: the chat climbs the list now
    // BUG-142: the question is stored — the chat can be titled now, not
    // hours later when a long turn ends (onTurnEnd stays the safety net).
    if (this.#onTurnStart) {
      const hook = this.#onTurnStart;
      setImmediate(() => {
        try {
          const r = hook({ sid, dir });
          if (r && typeof r.catch === "function") r.catch(() => {});
        } catch {}
      });
    }

    const turn = { dir, prompt, modelID, access, userMsgId, agent: isClaudeAgentId(agent) ? agent : null, jail: access === "tenant" && jail?.name && jail?.home ? { name: jail.name, home: jail.home } : null, portalNote: typeof portalNote === "string" ? portalNote : "", systemPrompt: typeof systemPrompt === "string" ? systemPrompt : "", kbDir: tenantKbDir(access, kbZone), workDir: typeof workDir === "string" && workDir ? workDir : null };
    if (busy) {
      const q = this.#queues.get(sid) ?? [];
      q.push(turn);
      this.#queues.set(sid, q);
      const run = this.#runs.get(sid);
      if (run) this.#emit(dir, { type: "zai.keepalive", properties: { sessionID: sid, ...this.#live(sid, run) } });
      return;
    }
    this.#start(sid, turn);
  }

  // The snapshot for the first user turn of a chat with typed text, or null.
  // Never throws: a broken vault must not break the chat.
  #snapshotFor(sid, dir, zone, stored) {
    if (!this.#kbSnapshot || !zone?.root) return null;
    if ((this.#store.sessions[sid]?.messages ?? []).some((m) => m?.info?.role === "user")) return null;
    if (!stored.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim())) return null;
    try {
      const snap = this.#kbSnapshot({ dir, sid, zone });
      return typeof snap === "string" && snap.trim() ? snap : null;
    } catch (err) {
      this.#log(`[zai-claude] kb snapshot failed: ${err?.message ?? err}`);
      return null;
    }
  }

  #args({ modelID, access, resume, agent = null, agentsFile = null, freshPrompt = false, hooks = null, forkSession = false, jail = null, systemPrompt = "", kbDir = null, rootDir = null, portalNote = "" }) {
    // FEAT-04.11: a tenant turn with its jail gets the tenant kit — the Bash
    // hook rides the same --settings as the undo hook.
    const kit = access === "tenant" && jail && this.#tenantKit ? this.#tenantKit : null;
    if (kit) hooks = withJailHook(hooks, kit, jail);
    // No positional argument at all: the prompt rides stdin, so no prompt
    // text can ever be parsed as a CLI option (SEC-11) and argv stays short
    // (32K CreateProcess limit, COR-14), UTF-8 intact (BUG-13.2).
    const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", modelID];
    // FEAT-13.19: without it `-p` streams thinking blocks with EMPTY text;
    // with it the CLI sends its thinking summaries (spike CLI 2.1.316).
    // FEAT-01.58: the same settings carry the PreToolUse backup hook.
    args.push("--settings", JSON.stringify(hooks ? { ...THINKING_SETTINGS, hooks } : THINKING_SETTINGS));
    if (resume && SAFE_SID.test(resume)) {
      args.push("--resume", resume);
      // FEAT-01.57: a cut copy of the history → a new CLI session of its own.
      if (forkSession) args.push("--fork-session");
    }
    // FEAT-13.17: the agents file (no prompt text on argv: COR-14) and the
    // catalog id; the snapshot switch lets an agent change between turns.
    if (agent && agentsFile) args.push("--agents", agentsFile, "--agent", agent);
    if ((agent && agentsFile) || freshPrompt) args.push("--system-prompt-snapshot", "off");
    args.push(...permissionArgs(access, this.#perm));
    // BUG-169: the tenant's own knowledge-base zone for its file tools (the
    // snapshot rules send it there); never for admin, never another zone.
    if (access === "tenant" && kbDir) args.push("--add-dir", kbDir);
    // FEAT-04.12 stage B: a chat working in its subfolder still reaches the whole
    // tenant folder (its other chats, attachments) — the same user.
    if (rootDir) args.push("--add-dir", rootDir);
    // FEAT-03.22: the user's prompt goes in ONE --append-system-prompt-file
    // (for a tenant: the kit prompt + the user's section). A file that
    // cannot be written → the turn runs without it (logged), never fails.
    let promptFile = kit?.promptFile ?? null;
    // FEAT-11.18: к правилу портала добавляется строка о журнале этого чата
    const portal = [this.#portalRule, portalNote].filter(Boolean).join("\n\n") || null;
    if ((systemPrompt || portal) && this.#promptDir) {
      try {
        promptFile = claudePromptFile(this.#promptDir, systemPrompt, kit?.promptFile ?? null, portal);
      } catch (err) {
        this.#log(`[zai-claude] user system prompt not written: ${err?.message ?? err}`);
      }
    }
    if (kit) args.push(...tenantKitArgs(kit, { promptFile }));
    else if (promptFile) args.push("--append-system-prompt-file", promptFile);
    return args;
  }

  // The turn's agent: {agent, agentsFile} when the catalog still has it;
  // a vanished agent → no agent + onAgentMissing (FEAT-13.17).
  #agentOf(sid, turn) {
    const id = turn.agent;
    if (!id) return { agent: null, agentsFile: null };
    let file = null;
    try {
      file = this.#agents?.has(id) ? this.#agents.compiledFile() : null;
    } catch (err) {
      this.#log(`[zai-claude] agents file not written: ${err?.message ?? err}`);
    }
    if (file) return { agent: id, agentsFile: file };
    const name = this.#agents?.nameOf?.(id) ?? id;
    if (this.#onAgentMissing) {
      try {
        this.#onAgentMissing({ sid, dir: turn.dir, agent: id, name });
      } catch {}
    }
    return { agent: null, agentsFile: null };
  }

  #start(sid, turn) {
    const entry = this.#store.sessions[sid];
    if (!entry) return;
    // BUG-184: the previous answer's CLI still waits for its background tasks —
    // stop it first; this turn resumes the same CLI session once it is gone.
    if (this.#tails.has(sid)) {
      this.#dropTail(sid, () => this.#start(sid, turn));
      return;
    }
    const { dir, prompt, modelID, access, userMsgId } = turn;
    let asstMsgId = shortId("msgc_a");
    const { agent, agentsFile } = this.#agentOf(sid, turn);
    // FEAT-01.57: where the CLI history stands before this turn — a later
    // «Изменить» / «Отменить ход» cuts it back to exactly here.
    // FEAT-04.12 stage B: the CLI's folder (cwd, transcript slug) — the chat's own
    // subfolder when it has one, else the session folder.
    const cwd = turn.workDir || dir;
    const { resume, forkSession, copyFile, cut } = this.#historyFor(entry, cwd);
    const userMsg = entry.messages.find((m) => m?.info?.id === userMsgId);
    if (userMsg) userMsg.cut = cut;
    // FEAT-01.58: only the last turn is undoable; this one gets the hook.
    let hooks = null;
    try {
      if (this.#undo && this.#undo.startTurn(sid, userMsgId)) hooks = this.#undo.hookSettings(sid, userMsgId);
    } catch {}
    // A chat that ever ran with an agent re-renders its system prompt on
    // every resume — also on a turn back to «no agent» (spike 2026-11-03).
    // FEAT-03.22: the CLI replays the system prompt recorded on the first
    // turn; a chat with a user prompt now or before re-renders it every turn
    // (the prompt may have changed or been cleared in Настройки).
    const systemPrompt = turn.systemPrompt ?? "";
    // FEAT-11.18: строка о журнале появляется со второго хода — записанный CLI промпт не переигрываем
    const portalNote = typeof turn.portalNote === "string" ? turn.portalNote : "";
    const freshPrompt = Boolean(resume && (entry.agentUsed || entry.userPromptUsed || systemPrompt || portalNote));
    const args = this.#args({ modelID, access, resume, agent, agentsFile, freshPrompt, hooks, forkSession, jail: turn.jail ?? null, systemPrompt, kbDir: turn.kbDir ?? null, rootDir: turn.workDir ? dir : null, portalNote });
    if (agent) entry.agentUsed = true;
    if (systemPrompt) entry.userPromptUsed = true;

    const isScript = /\.(c?js|mjs)$/i.test(this.#binPath);
    // TASK-17.1: на POSIX — своя группа процессов, чтобы «Стоп» убивал shell и MCP вместе с CLI
    const opts = groupSpawnOpts({ cwd: cwd || undefined, windowsHide: true, env: childEnv(this.#env, { token: this.#token }), stdio: ["pipe", "pipe", "pipe"] });
    const child = isScript ? spawn(process.execPath, [this.#binPath, ...args], opts) : spawn(this.#binPath, args, opts);

    const startedAt = nowMs();
    const run = {
      child,
      dir,
      abortedBy: null,
      finalized: false,
      // FEAT-01.77: ход закрыт, но запуск субагента ещё работает (хвост CLI) —
      // чат не гаснет в idle, пока он не завершится
      zaiBusy: false,
      // FEAT-13.19: the turn as opencode-shaped parts (steps, reasoning,
      // tool calls, text) — streamed live and stored with the answer.
      transcript: new ClaudeTranscript({ sessionID: sid, messageID: asstMsgId, newId: () => shortId("prt") }),
      claudeSid: null,
      result: null,
      spawnError: null,
      keepalive: null,
      timer: null,
      idleTimer: null,
      startedAt,
      lastOutputAt: startedAt,
      lastAction: null,
    };
    this.#runs.set(sid, run);
    this.#hub?.markManaged?.(sid);
    this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
    // ISSUE-003: the answer exists (empty, open) from the moment its turn
    // starts, tied to its question via parentID — the client places it right
    // after that question and flips a queued bubble from «В очереди» to
    // accepted, exactly like opencode's own assistant messages.
    // BUG-164: the open answer's head is kept on the run — the history route
    // serves it with the parts so far (reload / resync mid-turn).
    run.info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID: CLAUDE_PROVIDER_ID, modelID, ...(agent ? { agent } : {}), time: { created: startedAt } };
    this.#emit(dir, {
      type: "message.updated",
      properties: { sessionID: sid, info: { ...run.info, time: { ...run.info.time } } },
    });

    // A queued follow-up starting later is fresh activity too (BUG-13.16).
    this.#touch(sid, entry, dir, startedAt, true);

    // Mirror for orphan cleanup after a restart (ADR-010 §3).
    if (child.pid) {
      this.#saveRun(sid, { pid: child.pid, image: imageName(isScript ? process.execPath : this.#binPath), spawnedAt: startedAt, claudeSid: entry.claudeSid ?? null, userMsgId, modelID });
    }

    // The prompt: UTF-8 bytes on stdin, then EOF - a CLI waiting for input
    // can never hang the turn (SEC-21).
    child.stdin.on("error", () => {}); // EPIPE when the CLI dies early
    child.stdin.end(Buffer.from(prompt, "utf8"));

    // BUG-184: one CLI process may give several answers — the turn's own, then
    // rounds it runs by itself when a background task of the agent ends. The
    // answer closes on the CLI's `result` (finalize = end of the ROUND); the
    // process may live on as a tail (#tails) until it exits (onExit below).
    const finalize = () => {
      if (run.finalized) return;
      run.finalized = true;
      clearInterval(run.keepalive);
      clearTimeout(run.timer);
      clearTimeout(run.idleTimer);
      this.#dropZai(); // FEAT-01.77: финальные части несут последнее состояние — отложенное не нужно
      if (this.#runs.get(sid) === run) this.#runs.delete(sid);
      // FEAT-01.58: what the turn left in its files (undo never clobbers later changes).
      if (!run.sealed) {
        run.sealed = true;
        try {
          this.#undo?.seal(sid, userMsgId);
        } catch {}
      }

      // FEAT-13.19: close open tool calls / reasoning; errors, marks and the
      // empty-answer note ride a trailing text part of their own.
      const tr = run.transcript;
      // FEAT-01.77: «Стоп»/таймаут/падение убивают субагентов вместе с процессом
      // CLI — незавершённые запуски получают stopped (последнее состояние);
      // нормальный `result` с живым хвостом запуски не трогает
      const hardEnd = Boolean(run.abortedBy || run.spawnError || (!run.result && run.exited));
      const ops = [...(hardEnd ? tr.stopRuns() : []), ...tr.finish()];
      let tail = "";
      if (run.spawnError || run.result?.isError) {
        ops.push(...tr.dropText());
        tail = run.spawnError ? `Не удалось запустить claude CLI: ${run.spawnError}` : run.result.text || "Claude вернул ошибку";
      } else if (!tr.hasText() && run.result?.text) tail = run.result.text;
      // BUG-182: the CLI died on its own (out of memory, killed): no `result`, not
      // stopped by the portal → an interrupted turn, never a silent half answer.
      if (!run.abortedBy && !run.spawnError && !run.result) {
        run.abortedBy = "crash";
        const how = run.exitSignal ? `signal ${run.exitSignal}` : `code ${run.exitCode ?? "?"}`;
        const tail = String(run.stderrTail ?? "").replace(/\s+/g, " ").trim().slice(-400);
        this.#log(`[zai-claude] BUG-182 unexpected exit of claude CLI in ${sid}: ${how}, no result line${tail ? `; stderr tail: ${tail}` : ""}`);
      }
      const reason = run.abortedBy;
      const mark = reason === "idle" ? idleMark(this.#idleTimeoutMs) : reason === "crash" ? crashMark(run) : MARK[reason] ?? "";
      if (mark) tail = tail ? `${tail}\n\n${mark}` : mark;
      if (!tail && !tr.hasText()) tail = "(пустой ответ)";
      if (tail) ops.push(tr.addText(tail));
      const parts = tr.parts();

      const completed = nowMs();
      const live = this.#store.sessions[sid] === entry; // gone after forget()
      const info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID: CLAUDE_PROVIDER_ID, modelID, time: { created: run.startedAt, completed } };
      if (agent) info.agent = agent; // FEAT-13.17: which agent gave this answer
      if (reason && reason !== "deleted") info.zai = { interrupted: reason };
      if (live) {
        // The claude session survives an interrupted turn too: the next
        // prompt resumes WITH the partial work (FEAT-13.12).
        entry.claudeSid = run.claudeSid ?? entry.claudeSid;
        // FEAT-01.57: the fork took (the CLI named its new session); without
        // a session id (spawn failure) the next turn forks again.
        if (forkSession && run.claudeSid) delete entry.fork;
        this.#insertAnswer(entry, userMsgId, { info, parts });
        entry.updatedAt = Math.max(Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0, completed);
        this.#flush();
        // Removals, then every final part: a client that missed a live frame
        // still ends with exactly the stored answer.
        for (const op of ops) if (op.op === "removed") this.#emitPart(dir, sid, asstMsgId, op);
        for (const part of parts) this.#emitPart(dir, sid, asstMsgId, { op: "updated", part });
        this.#emit(dir, { type: "message.updated", properties: { sessionID: sid, info } });
        this.#touch(sid, entry, dir, completed);
      }

      const next = live ? this.#queues.get(sid)?.shift() : null;
      if (next) {
        if (this.#queues.get(sid)?.length === 0) this.#queues.delete(sid);
        setImmediate(() => this.#start(sid, next));
        return;
      }
      this.#queues.delete(sid);
      // FEAT-01.77: у хода остался работающий запуск агента (фоновый субагент,
      // CLI ждёт его в хвосте — BUG-184) — в idle не гаснем: busy держится по
      // busySnapshot/хвосту, пока запуск не завершится (или не будет остановлен)
      if (tr.hasRunningZaiRun()) run.zaiBusy = true;
      else {
        this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
        this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
      }
      if (live && this.#onTurnEnd) {
        const hook = this.#onTurnEnd;
        setImmediate(() => {
          try {
            const r = hook({ sid, dir, reason: reason ?? null });
            if (r && typeof r.catch === "function") r.catch(() => {});
          } catch {}
        });
      }
    };
    run.finalize = finalize;

    const beat = () => this.#emit(dir, { type: "zai.keepalive", properties: { sessionID: sid, ...this.#live(sid, run) } });
    // Liveness without lying (ADR-010 §2): a dedicated event carrying the
    // last REAL output time, not a fake busy frame.
    run.keepalive = setInterval(beat, this.#keepaliveMs);

    // BUG-184: the tail starts a round of its own (a background task ended →
    // the CLI's task notification → `system init`): one more answer to the
    // same question, the chat is busy again while it runs.
    const beginRound = () => {
      asstMsgId = shortId("msgc_a");
      const at = nowMs();
      Object.assign(run, { finalized: false, result: null, emptyResult: null, abortedBy: null, startedAt: at, lastOutputAt: at, lastAction: null, autoRound: true, zaiBusy: false });
      run.transcript = new ClaudeTranscript({ sessionID: sid, messageID: asstMsgId, newId: () => shortId("prt") });
      run.info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID: CLAUDE_PROVIDER_ID, modelID, ...(agent ? { agent } : {}), time: { created: at } };
      this.#tails.delete(sid);
      this.#runs.set(sid, run);
      this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
      this.#emit(dir, { type: "message.updated", properties: { sessionID: sid, info: { ...run.info, time: { ...run.info.time } } } });
      run.keepalive = setInterval(beat, this.#keepaliveMs);
    };
    if (this.#runTimeoutMs > 0) {
      run.timer = setTimeout(() => {
        run.abortedBy ??= "timeout";
        killChildTree(child);
      }, this.#runTimeoutMs);
    }
    if (this.#idleTimeoutMs > 0) {
      const check = () => {
        const silent = nowMs() - run.lastOutputAt;
        if (silent >= this.#idleTimeoutMs) {
          run.abortedBy ??= "idle";
          killChildTree(child);
          return;
        }
        run.idleTimer = setTimeout(check, this.#idleTimeoutMs - silent);
      };
      run.idleTimer = setTimeout(check, this.#idleTimeoutMs);
    }

    const alive = () => {
      run.lastOutputAt = nowMs();
    };
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      alive();
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        // BUG-184: after the answer the tail only waits (task_started / task_updated
        // / task_notification …); a new `system init` opens a round of its own.
        // the CLI reports background tasks of the agent (Bash run_in_background …)
        if (evt.type === "system" && /^(task_started|background_tasks_changed|task_updated)$/.test(String(evt.subtype ?? ""))) run.bgTasks = true;
        if (run.finalized) {
          if (!run.superseded && !run.exited && evt.type === "system" && evt.subtype === "init") {
            beginRound();
          } else if (!run.superseded && !run.exited && (evt.parent_tool_use_id || (evt.type === "system" && /^(task_started|task_updated|task_notification)$/.test(String(evt.subtype ?? ""))))) {
            // FEAT-01.77: субагент работает и в хвосте (после `result`) — его
            // события достраивают часть ПРОШЛОГО ответа: клиент видит шаги и
            // завершение, история не остаётся «running» навсегда
            for (const op of run.transcript.feed(evt)) this.#emitZaiOp(dir, sid, asstMsgId, op);
            this.#patchStoredParts(sid, asstMsgId, run.transcript.parts());
            if (run.zaiBusy && !run.transcript.hasRunningZaiRun()) {
              run.zaiBusy = false;
              this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
              this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
            }
            continue; // уже скормлено транскрипту прошлого ответа
          } else continue;
        }
        for (const op of run.transcript.feed(evt)) this.#emitZaiOp(dir, sid, asstMsgId, op);
        const sig = translateEvent(evt);
        if (!sig) continue;
        if (sig.kind === "assistant") {
          if (sig.tools.length > 0) run.lastAction = sig.tools.at(-1);
        } else if (sig.kind === "tool") {
          run.lastAction = sig.name;
          beat(); // the phone sees «последнее действие» right away
        } else if (sig.kind === "init") {
          run.claudeSid = sig.claudeSid;
          this.#saveRun(sid, { claudeSid: sig.claudeSid }, true);
        } else if (sig.kind === "result") {
          if (sig.claudeSid) run.claudeSid = sig.claudeSid;
          // BUG-184: an EMPTY successful round is CLI housekeeping — a resumed
          // session first acks the notification of a background task that died
          // with the previous process (init → result ""), then answers. Not the
          // answer: wait for the next round. A round the tail opened by itself
          // for nothing is taken back. Exit after it = a plain empty answer.
          const content = run.transcript.parts().some((p) => (p.type === "text" && p.text?.trim()) || p.type === "tool");
          if (!content && !sig.isError && !String(sig.text ?? "").trim()) {
            run.emptyResult = sig;
            if (run.autoRound) {
              run.finalized = true;
              clearInterval(run.keepalive);
              if (this.#runs.get(sid) === run) this.#runs.delete(sid);
              this.#tails.set(sid, run);
              this.#emit(dir, { type: "message.removed", properties: { sessionID: sid, messageID: asstMsgId } });
              this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
              this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
              const next = this.#queues.get(sid)?.shift();
              if (this.#queues.get(sid)?.length === 0) this.#queues.delete(sid);
              if (next) setImmediate(() => this.#start(sid, next));
            }
            continue;
          }
          run.result = sig;
          // BUG-184: the answer is complete NOW — do not wait for the process
          // (it may wait for background tasks for hours). It stays a tail.
          this.#tails.set(sid, run);
          finalize();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      alive(); // verbose CLI logs: content swallowed, but they prove life
      run.stderrTail = (String(run.stderrTail ?? "") + chunk).slice(-2048); // BUG-182: diagnosis of an unexpected exit
    });
    child.on("error", (err) => {
      // spawn failure (ENOENT etc.): surface as the assistant turn's text
      run.spawnError = err.message;
      finalize();
    });
    child.on("close", (code, signal) => {
      run.exitCode = code;
      run.exitSignal = signal;
      run.exited = true;
      clearTimeout(run.dropTimer);
      // A round still open at exit: stopped for a new message (BUG-184) or
      // ended without `result` (BUG-182 crash, stop, timeout) — finalize marks it.
      if (run.superseded && !run.finalized) run.abortedBy ??= "user";
      // BUG-184: only an empty round before the exit — a plain empty answer, not a crash;
      // a round the tail opened by itself for nothing is simply taken back.
      if (!run.finalized && !run.result && run.emptyResult && !run.abortedBy) {
        if (run.autoRound) {
          run.finalized = true;
          clearInterval(run.keepalive);
          if (this.#runs.get(sid) === run) this.#runs.delete(sid);
          this.#emit(dir, { type: "message.removed", properties: { sessionID: sid, messageID: asstMsgId } });
          this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
          this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
        } else run.result = run.emptyResult;
      }
      finalize();
      // the process is gone: orphan record, the cut copy (FEAT-01.57), the tail
      if (this.#tails.get(sid) === run) this.#tails.delete(sid);
      if (!this.#runs.has(sid)) this.#saveRun(sid, null);
      if (copyFile) rmSync(copyFile, { force: true });
      for (const fn of run.onClosed ?? []) setImmediate(fn);
      // A message queued while the tail was being stopped (undo, delete, …):
      // nothing else starts it — the chat is free now.
      setImmediate(() => {
        if (this.#runs.has(sid) || this.#tails.has(sid)) return;
        const next = this.#store.sessions[sid] ? this.#queues.get(sid)?.shift() : null;
        if (this.#queues.get(sid)?.length === 0) this.#queues.delete(sid);
        if (next) this.#start(sid, next);
      });
    });
  }

  // The CLI history of the next turn (FEAT-01.57): {resume, forkSession,
  // copyFile, cut}. A pending fork (after a committed revert) resumes from a
  // cut copy of the transcript with --fork-session; cut = where the history
  // stands before this turn ({claudeSid, bytes}; bytes null = unknown).
  #historyFor(entry, dir) {
    if (entry.fork?.from) {
      const { from, bytes } = entry.fork;
      const copy = cutCopy({ root: this.#projects, dir, from, bytes });
      if (copy) return { resume: copy.resume, forkSession: true, copyFile: copy.file, cut: { claudeSid: from, bytes } };
      // The transcript is gone (cleaned by hand, another machine): the chat
      // starts a fresh CLI session rather than resume what was dropped.
      this.#log(`[zai-claude] transcript ${from} not found: the next turn starts a new CLI session`);
      delete entry.fork;
      entry.claudeSid = null;
      return { resume: null, forkSession: false, copyFile: null, cut: { claudeSid: null, bytes: 0 } };
    }
    const resume = entry.claudeSid ?? null;
    if (!resume) return { resume: null, forkSession: false, copyFile: null, cut: { claudeSid: null, bytes: 0 } };
    const file = findTranscript(this.#projects, dir, resume);
    return { resume, forkSession: false, copyFile: null, cut: { claudeSid: resume, bytes: file ? sizeOf(file) : null } };
  }

  // Answers land right after their own question: with queued follow-ups the
  // store order stays question/answer pairs.
  #insertAnswer(entry, userMsgId, msg) {
    const i = entry.messages.findIndex((m) => m?.info?.id === userMsgId);
    if (i < 0) return void entry.messages.push(msg);
    // BUG-184: a later answer to the same question (a round of the tail) goes
    // after the earlier ones.
    let j = i + 1;
    while (entry.messages[j]?.info?.role === "assistant" && entry.messages[j].info.parentID === userMsgId) j++;
    entry.messages.splice(j, 0, msg);
  }

  #dropQueue(sid) {
    const q = this.#queues.get(sid);
    this.#queues.delete(sid);
    const entry = this.#store.sessions[sid];
    if (!q?.length || !entry) return;
    for (const t of q) {
      const now = nowMs();
      const info = { id: shortId("msgc_a"), sessionID: sid, role: "assistant", parentID: t.userMsgId, providerID: CLAUDE_PROVIDER_ID, modelID: t.modelID, time: { created: now, completed: now }, zai: { interrupted: "cancelled" } };
      const partId = shortId("prt");
      this.#insertAnswer(entry, t.userMsgId, { info, parts: [{ id: partId, type: "text", text: MARK.cancelled }] });
      this.#emit(t.dir, { type: "message.part.updated", properties: { sessionID: sid, part: { id: partId, messageID: info.id, type: "text", text: MARK.cancelled } } });
      this.#emit(t.dir, { type: "message.updated", properties: { sessionID: sid, info } });
    }
    this.#flush();
  }

  // --- restart recovery (BUG-13.5 / ADR-010 §3-4) ---------------------------

  #recover(procInspect, procKill) {
    const runs = this.#loadRuns();
    let killed = 0;
    for (const [sid, rec] of Object.entries(runs)) {
      const pid = Number(rec?.pid);
      const p = Number.isInteger(pid) && pid > 0 ? procInspect(pid) : null;
      // Only OUR process: same image name and (when known) a start time
      // matching the spawn - a reused PID of anything else is left alone.
      const ours = p && (!rec.image || p.name === rec.image) && (!p.startMs || !rec.spawnedAt || Math.abs(p.startMs - rec.spawnedAt) < 10_000);
      if (ours && procKill(pid)) killed++;
      const entry = this.#store.sessions[sid];
      if (entry && typeof rec?.claudeSid === "string" && SAFE_SID.test(rec.claudeSid)) entry.claudeSid = rec.claudeSid;
    }
    if (Object.keys(runs).length > 0) this.#writeRuns({});

    // BUG-229: после рестарта ни один субагент работать не может (осиротевшие
    // CLI убиты выше, живых ходов ещё нет) — «running» в сохранённых zaiRun
    // гасим в stopped, чтобы история не показывала вечную работу.
    let stamped = 0;
    const stoppedAt = nowMs();
    for (const entry of Object.values(this.#store.sessions)) {
      for (const m of entry?.messages ?? []) {
        for (const p of m?.parts ?? []) {
          const z = p?.state?.metadata?.zaiRun;
          if (p?.type === "tool" && z?.status === "running") {
            z.status = "stopped";
            z.endedAt = stoppedAt;
            stamped += 1;
          }
        }
      }
    }
    if (stamped > 0) this.#log(`[zai-claude] BUG-229 restart recovery: stopped ${stamped} stale subagent run(s) in stored history`);

    // Every question without an answer was cut by the restart (a run in
    // flight or a queued follow-up): answer it honestly.
    let answered = 0;
    for (const [sid, entry] of Object.entries(this.#store.sessions)) {
      const list = Array.isArray(entry?.messages) ? entry.messages : [];
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m?.info?.role !== "user") continue;
        if (list[i + 1]?.info?.role === "assistant") continue;
        const at = Number(m.info.time?.created) || nowMs();
        const rec = runs[sid];
        const info = {
          id: shortId("msgc_a"),
          sessionID: sid,
          role: "assistant",
          parentID: m.info.id,
          providerID: CLAUDE_PROVIDER_ID,
          modelID: rec?.userMsgId === m.info.id && rec.modelID ? rec.modelID : this.lastModelOf(sid) ?? DEFAULT_CLAUDE_MODEL,
          time: { created: at, completed: nowMs() },
          zai: { interrupted: "restart" },
        };
        list.splice(i + 1, 0, { info, parts: [{ id: shortId("prt"), type: "text", text: MARK.restart }] });
        answered++;
      }
    }
    if (answered > 0 || stamped > 0) this.#flush();
    if (killed || answered) this.#log(`[zai-claude] restart recovery: killed ${killed} orphaned CLI run(s), answered ${answered} interrupted question(s)`);
  }

  #loadRuns() {
    if (!this.#runsPath) return {};
    const raw = readJsonStore(this.#runsPath, {
      fallback: () => ({ version: 1, runs: {} }),
      validate: (r) => Boolean(r && typeof r === "object" && r.runs && typeof r.runs === "object"),
    });
    return raw.runs;
  }

  #runsCache = null;

  // rec null → remove; merge → patch the existing record.
  #saveRun(sid, rec, merge = false) {
    if (!this.#runsPath) return;
    this.#runsCache ??= {};
    if (rec === null) delete this.#runsCache[sid];
    else if (merge) {
      if (!this.#runsCache[sid]) return;
      this.#runsCache[sid] = { ...this.#runsCache[sid], ...rec };
    } else this.#runsCache[sid] = rec;
    this.#writeRuns(this.#runsCache);
  }

  #writeRuns(runs) {
    if (this.#runsPath) writeJsonAtomic(this.#runsPath, { version: 1, runs });
  }

  // --- GET /zai/api/provider: upstream catalog + claude models ---------------

  // catalog (v2fix2, FEAT-16.3): асинхронный источник тела каталога в форме
  // 1.x {all, default, connected} (в v2-режиме — клиент адаптера из server.js,
  // у opencode 2.x нет v1-пути /provider). Без опции — прежний raw-путь
  // fetch(`${upstream}/provider`) бит в бит. Ошибки источника — та же
  // семантика, что у сетевых: нет кэша → 502 {error: "upstream: ..."},
  // кэш есть → отдаётся устаревший каталог (пикер не пустеет).
  async handleProvider(req, res, upstream, { ttlMs = 60_000, catalog = null } = {}) {
    const sendJson = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const now = nowMs();
    if (now - this.#provider.at >= ttlMs || !this.#provider.body) {
      this.#reloadCatalog();
      try {
        if (catalog) {
          const body = JSON.stringify(providerPatch(await catalog(), this.#models));
          this.#provider = {
            at: now,
            body,
            etag: `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 20)}"`,
          };
        } else {
          const r = await fetch(`${upstream}/provider`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
          if (r.ok) {
            const body = JSON.stringify(providerPatch(await r.json(), this.#models));
            this.#provider = {
              at: now,
              body,
              etag: `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 20)}"`,
            };
          } else if (!this.#provider.body) {
            return sendJson(502, { error: `upstream: ${r.status}` });
          }
        }
      } catch (err) {
        if (!this.#provider.body) return sendJson(502, { error: `upstream: ${err.message}` });
        // stale catalog served below; upstream hiccups must not empty the picker
      }
    }
    if (req.headers["if-none-match"] && req.headers["if-none-match"] === this.#provider.etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", etag: this.#provider.etag, "cache-control": "no-cache" });
    res.end(this.#provider.body);
  }

  // data/claude-models.json (an array like CLAUDE_MODELS) overrides the
  // built-in list without a code change; junk or absence → built-in.
  #reloadCatalog() {
    if (!this.#catalogPath || !existsSync(this.#catalogPath)) {
      this.#models = CLAUDE_MODELS;
      return;
    }
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(this.#catalogPath, "utf8")); // owner's config: never moved aside
    } catch (err) {
      this.#log(`[zai-claude] ${path.basename(this.#catalogPath)} unreadable, built-in catalog used: ${err?.message ?? err}`);
    }
    this.#models = normalizeCatalog(Array.isArray(raw) ? raw : raw?.models) ?? CLAUDE_MODELS;
  }

  // --- store -----------------------------------------------------------------

  // One transcript op (FEAT-13.19) as the opencode SSE event.
  #emitPart(dir, sid, messageID, op) {
    if (op.op === "updated") this.#emit(dir, { type: "message.part.updated", properties: { sessionID: sid, part: op.part } });
    else if (op.op === "delta") this.#emit(dir, { type: "message.part.delta", properties: { sessionID: sid, messageID, partID: op.partID, field: op.field, delta: op.delta } });
    else if (op.op === "removed") this.#emit(dir, { type: "message.part.removed", properties: { sessionID: sid, messageID, partID: op.partID } });
  }

  // FEAT-01.77: обновления работы субагента (op.zai) — не чаще раза в 300 мс
  // на часть; последнее состояние всегда доставляется (финальные части хода и
  // stopRuns идут мимо троттлинга). Остальные операции — как раньше.
  #emitZaiOp(dir, sid, messageID, op) {
    if (!op?.zai || op.op !== "updated") {
      this.#emitPart(dir, sid, messageID, op);
      return;
    }
    this.#zaiPending.set(op.part.id, { dir, sid, messageID, op });
    if (this.#zaiTimer) return;
    this.#zaiTimer = setTimeout(() => {
      this.#zaiTimer = null;
      for (const p of this.#zaiPending.values()) this.#emitPart(p.dir, p.sid, p.messageID, p.op);
      this.#zaiPending.clear();
    }, 300);
    this.#zaiTimer.unref?.();
  }

  #dropZai() {
    if (this.#zaiTimer) {
      clearTimeout(this.#zaiTimer);
      this.#zaiTimer = null;
    }
    this.#zaiPending.clear();
  }

  // FEAT-01.77: поздние изменения частей прошлого ответа (работа субагента в
  // хвосте) — в стор, чтобы история после перезагрузки не показывала «running»
  #patchStoredParts(sid, messageID, parts) {
    const msg = this.#store.sessions[sid]?.messages?.find((m) => m?.info?.id === messageID);
    if (!msg) return;
    let touched = false;
    for (const part of parts) {
      if (part.type !== "tool" || !part.state?.metadata?.zaiRun) continue;
      const i = msg.parts.findIndex((p) => p?.id === part.id);
      const clone = structuredClone(part);
      if (i >= 0) msg.parts[i] = clone;
      else msg.parts.push(clone);
      touched = true;
    }
    if (touched) this.#flush();
  }

  // FEAT-01.77: хвост гасится («Стоп», новое сообщение, удаление чата) —
  // субагенты умирают вместе с процессом CLI; часть прошлого ответа получает
  // stopped, доставляется клиенту и сохраняется
  #stopTailRuns(sid, tail) {
    const ops = tail.transcript?.stopRuns?.() ?? [];
    if (!ops.length) return;
    const msgId = tail.info?.id ?? null;
    for (const op of ops) if (msgId) this.#emitPart(tail.dir, sid, msgId, op);
    if (!this.#store.sessions[sid]) return;
    this.#patchStoredParts(sid, msgId, ops.map((op) => op.part));
  }

  #emit(dir, event) {
    this.#hub?.emit?.(event, dir ?? null);
  }

  #loadStore() {
    if (!this.#storePath) return { version: 1, sessions: {} };
    return readJsonStore(this.#storePath, {
      fallback: () => ({ version: 1, sessions: {} }),
      validate: (raw) => Boolean(raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"),
    });
  }

  #flush() {
    if (!this.#storePath) return;
    // TASK-13.27 (design §5): a turn touches the store many times - mark it
    // dirty and write ONCE (async tmp+rename) after flushDelayMs of quiet,
    // never later than flushMaxMs after the FIRST unsaved change. Reads go
    // through memory, so the delay is invisible to the portal; flushNow()
    // is the immediate path for shutdown and tests.
    if (!this.#storeDirty) {
      this.#storeDirty = true;
      this.#storeDirtySince = Date.now();
    }
    if (this.#storeTimer) return;
    const elapsed = Date.now() - this.#storeDirtySince;
    const delay = Math.max(0, Math.min(this.#flushDelayMs, this.#flushMaxMs - elapsed));
    const timer = setTimeout(() => {
      this.#storeTimer = null;
      this.#writeStoreAsync();
    }, delay);
    timer.unref?.(); // TASK-13.27: a dirty store must not keep the process alive
    this.#storeTimer = timer;
  }

  // One disk write at a time; changes that arrived during a write are saved
  // by one more write after it.
  #writeStoreAsync() {
    if (this.#storeWriting) {
      this.#storeWriteQueued = true;
      return;
    }
    this.#storeWriting = true;
    // The payload is serialized at call time: everything up to NOW goes on
    // disk; later changes mark the store dirty again.
    this.#storeDirty = false;
    this.#storeDirtySince = 0;
    this.#storeWriteAsync(this.#storePath, this.#store, { log: (m) => this.#log(m) }).then(
      (ok) => {
        this.#storeWriting = false;
        const again = this.#storeWriteQueued || this.#storeDirty;
        this.#storeWriteQueued = false;
        if (!ok && !this.#storeDirty) {
          // the write failed with no newer changes: stay dirty for the next one
          this.#storeDirty = true;
          this.#storeDirtySince = Date.now();
        }
        if (again) this.#flush();
      },
      (err) => {
        // writeJsonAtomicAsync resolves false instead of throwing; this is a
        // safety net so the timer chain can never die on a rejection.
        this.#storeWriting = false;
        this.#storeWriteQueued = false;
        this.#storeDirty = true;
        this.#storeDirtySince = Date.now();
        this.#log?.(`[zai-claude] store flush failed: ${err?.message ?? err}`);
      },
    );
  }

  // Immediate synchronous save (SIGINT/SIGTERM/uncaughtException in server.js,
  // and tests). Idempotent; safe without a store path. If an async write is
  // still in flight, one more write re-lands the newest state after it.
  flushNow() {
    if (this.#storeTimer) {
      clearTimeout(this.#storeTimer);
      this.#storeTimer = null;
    }
    if (!this.#storePath) return true;
    const ok = writeJsonAtomic(this.#storePath, this.#store, { log: (m) => this.#log(m) });
    if (this.#storeWriting) this.#storeWriteQueued = true;
    else if (ok) {
      this.#storeDirty = false;
      this.#storeDirtySince = 0;
    }
    return ok;
  }
}
