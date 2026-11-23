import { cachedAcpModels, discoverAcpModels } from "./acp-models.js";
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
// session_id (from the init line, then the result), kept per teleharness session and
// replayed with --resume - also after an interrupted turn (FEAT-13.12).
// History persistence is portal-side (data/claude-sessions.json, see
// TELEHARNESS_DATA_DIR): opencode stores nothing for these turns, and the /message
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
// liveness rides a dedicated `teleharness.keepalive` event (startedAt, lastOutputAt,
// lastAction) instead of fake `busy` frames.
//
// Zero runtime dependencies - node stdlib only.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_PROVIDERS, CLAUDE_MODELS, CLAUDE_PROVIDER, CODEX_PROVIDER, DEFAULT_CLAUDE_MODEL, isClaudeModel, normalizeCatalog, normalizeCodexCatalog } from "../shared/engine.js";
import { claudeAnswerError } from "../shared/turn-error.js";
import { UPLOAD_DIR, fileRefText, openUnique, sanitizeFilename } from "./attach.js";
import { isClaudeAgentId } from "./claude-agents.js";
import { ClaudeTranscript, toolName } from "./claude-transcript.js";
import { readJsonStore, writeJsonAtomic, writeJsonAtomicAsync } from "./json-store.js";
import { TurnUndo, cutCopy, findTranscript, isInside, projectsRoot, sizeOf } from "./turn-undo.js";
import { KB_CONTEXT_KEY, withSnapshot } from "./kb-cache.js";
import { tenantKitArgs, withJailHook } from "./claude-tenant.js";
import { claudePromptFile } from "./user-prompt.js";
import { groupSpawnOpts, killChildTree as procKillChildTree, killTreeSync as procKillTreeSync } from "./proc.js";
import { parseArgs as parseCodexArgs, codexPolicy, renderDeveloperInstructions } from "./codex-shim.mjs";

import os from "node:os";
import { binDefaults } from "./paths.js";
import { claudeUsageByModel } from "./cost/normalize.js"; // FEAT-20.6

export const CLAUDE_PROVIDER_ID = CLAUDE_PROVIDER;

// The native installer puts the CLI into ~/.local/bin; otherwise `claude` from PATH (npm -g, Homebrew).
const HOME_BIN = binDefaults({ home: os.homedir() }).claudeBin;
export const DEFAULT_BIN = existsSync(HOME_BIN) ? HOME_BIN : "claude";
// The portal checkout itself (D:\Apps\teleharness on prod): admin claude chats may
// always read it (FEAT-13.9), wherever the chat's own directory is.
const PORTAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Pure: the /teleharness/api/provider response with the claude catalog injected.
// normalizeProviders() keeps only CONNECTED providers' models, so the patch
// must touch both lists. Input never mutated; unknown upstream shapes pass
// through as well as they can (tolerant, like the rest of the portal).
// FEAT-18.7: the Codex provider in the same response — only with a non-empty
// catalog (codex installed and logged in); otherwise the response is untouched.
export function codexProviderPatch(resp, catalog = []) {
  if (!Array.isArray(catalog) || catalog.length === 0) return resp;
  const out = { ...resp };
  out.connected = [...(Array.isArray(out.connected) ? out.connected.filter((x) => x !== CODEX_PROVIDER) : []), CODEX_PROVIDER];
  const models = {};
  for (const m of catalog) {
    models[m.id] = { id: m.id, name: m.name, providerID: CODEX_PROVIDER, status: "active", capabilities: { input: { text: true, image: true } }, limit: { context: m.context } };
  }
  out.all = [...(Array.isArray(out.all) ? out.all.filter((x) => x?.id !== CODEX_PROVIDER) : []), { id: CODEX_PROVIDER, name: "Codex (подписка ChatGPT)", models }];
  const def = catalog.find((m) => m.isDefault)?.id ?? catalog[0].id;
  out.default = { ...(out.default ?? {}), [CODEX_PROVIDER]: def };
  return out;
}

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
// <sessionDir>/.teleharness-uploads and become reference text (the CLI reads them
// with its Read tool). `stored` is what the history keeps: the same parts
// with every data: URL swapped for that reference text - base64 images no
// longer bloat claude-sessions.json (BUG-13.6); the client renders the
// reference as an attachment chip. Non-image file parts never reach this
// function as files: server.js materializes them before dispatch.
export function buildTurn(parts, sessionDir) {
  const chunks = [];
  const stored = [];
  const images = [];
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
        const mimeType = part.mime || decoded.mime || "";
        const ref = fileRefText(opened.name, decoded.buf.length, mimeType);
        if (mimeType.startsWith("image/")) images.push({ path: opened.path, mimeType });
        chunks.push(ref);
        stored.push({ type: "text", text: ref });
      } catch (err) {
        // BUG-215: a failed save must stay visible (prompt + history), never a silent drop
        const name = sanitizeFilename(part.filename);
        const note = `[вложение не сохранено: ${name}]`;
        chunks.push(note);
        stored.push({ type: "text", text: note });
        console.log(`[teleharness-claude] attachment not saved (${name}) in ${dirAbs}: ${err?.message ?? err}`);
      }
      continue;
    }
    if (part && typeof part === "object") stored.push({ ...part });
  }
  return { prompt: chunks.join("\n\n"), stored, images };
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
    const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
    return {
      kind: "result",
      claudeSid: typeof evt.session_id === "string" ? evt.session_id : null,
      isError: evt.is_error === true,
      text: typeof evt.result === "string" ? evt.result : "",
      // FEAT-18.5: расход хода (claudeTurnUsage)
      usage: isObj(evt.usage) ? evt.usage : null,
      costUsd: typeof evt.total_cost_usd === "number" && Number.isFinite(evt.total_cost_usd) && evt.total_cost_usd >= 0 ? evt.total_cost_usd : null,
      modelUsage: isObj(evt.modelUsage) ? evt.modelUsage : null,
      // FEAT-20.6: прирост расхода с прошлого `result` (modelUsage и total_cost_usd накопительные)
      sinceLast: isObj(evt.model_usage_since_last_result) ? evt.model_usage_since_last_result : null,
    };
  }
  return null;
}

// FEAT-18.5: расход хода Claude в info ответа — те же поля, что у opencode
// (tokens.input/output/reasoning/cache.read/cache.write/total, cost), и то,
// чего у opencode нет:
//   tokens.context — занятость окна ПОСЛЕДНИМ вызовом модели: input_tokens +
//     cache_read_input_tokens + cache_creation_input_tokens последнего
//     assistant-события основного разговора (lastUsage; запасной вариант —
//     последний элемент result.usage.iterations). usage в `result` — СУММА
//     вызовов хода (проверено на claude-stream-subagent-2.1.322.jsonl), для
//     доли окна не годится;
//   contextWindow — окно модели, как его сообщает CLI (modelUsage[модель].contextWindow).
// cost — total_cost_usd: для подписки это условная цена API, клиент её не
// показывает (пометка «подписка»). Чистая: result — сигнал translateEvent.
export function claudeTurnUsage(result, lastUsage = null, modelID = null) {
  const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const u = isObj(result?.usage) ? result.usage : null;
  const iters = Array.isArray(u?.iterations) ? u.iterations.filter(isObj) : [];
  const last = isObj(lastUsage) ? lastUsage : iters.at(-1) ?? null;
  const out = {};
  const tokens = {};
  if (u) {
    const read = n(u.cache_read_input_tokens);
    const write = n(u.cache_creation_input_tokens);
    Object.assign(tokens, { input: n(u.input_tokens), output: n(u.output_tokens), reasoning: 0, cache: { read, write } });
    tokens.total = tokens.input + tokens.output + read + write;
  }
  const context = last ? n(last.input_tokens) + n(last.cache_read_input_tokens) + n(last.cache_creation_input_tokens) : 0;
  if (context > 0) tokens.context = context;
  if (Object.keys(tokens).length > 0) out.tokens = tokens;
  if (typeof result?.costUsd === "number") out.cost = result.costUsd;
  const mu = isObj(result?.modelUsage) ? result.modelUsage : null;
  if (mu) {
    const entries = Object.values(mu).filter(isObj);
    const hit = (modelID && isObj(mu[modelID]) ? mu[modelID] : null) ?? (entries.length === 1 ? entries[0] : null);
    const w = n(hit?.contextWindow);
    if (w > 0) out.contextWindow = w;
  }
  // FEAT-20.6: разбивка хода по моделям (с субагентами, кэш 5m/1h, costUSD) — для журнала расхода
  const by = claudeUsageByModel(result);
  if (by) out.usageByModel = by.byModel;
  return out;
}

// The multi-step answer (BUG-13.8 / COR-13) is lib/claude-transcript.js now:
// every step keeps its own parts (FEAT-13.19).

// --- child process environment (BUG-13.2 / SEC-9) -----------------------------

// What the CLI itself (and its tools: shell, git, npx-launched MCP servers)
// needs - nothing else. Portal secrets (TELEHARNESS_*) never pass, whatever the list.
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
    if (lk.startsWith("teleharness_")) continue;
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

// FEAT-18.4: mode = the chat's permission mode (lib/binding.js): "ask" → the
// CLI asks the HOST over stdio (control_request can_use_tool, spike 2.1.322 —
// needs --input-format stream-json, see #start); "edits" → acceptEdits;
// "full"/null → the role default (admin adminMode; a tenant never gets more
// than acceptEdits). The tenant keeps --restricted/--strict-mcp-config in
// every mode: the bridge adds a question, never a right.
export const ASK_ARGS = ["--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
// FEAT-20.1 «Сначала план» (спайк 1.4, CLI 2.1.322): план-ход Claude — режим plan
// CLI (только чтение) + мост stdio: вызов ExitPlanMode приходит как can_use_tool,
// портал сохраняет план и отвечает deny — ход завершается без правок.
// "plan-ro" — Codex: только --permission-mode plan (посредник → read-only; флаги
// моста в Codex включили бы workspace-write).
export const PLAN_ARGS = ["--permission-mode", "plan", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
export const PERM_TURN_MODES = ["ask", "edits", "full", "plan", "plan-ro"];
export function permissionArgs(access, { adminMode = "bypassPermissions", addDirs = [PORTAL_ROOT], mcpConfig = null, mode = null } = {}) {
  if (mode === "plan" || mode === "plan-ro") {
    const plan = mode === "plan" ? [...PLAN_ARGS] : ["--permission-mode", "plan"];
    if (access === "tenant") return ["--restricted", "--strict-mcp-config", ...plan];
    if (access !== "admin") return plan;
    const out = plan;
    for (const d of addDirs) if (typeof d === "string" && d.trim()) out.push("--add-dir", d.trim());
    if (mcpConfig) out.push("--mcp-config", mcpConfig);
    return out;
  }
  if (access === "admin") {
    const out = mode === "ask" ? [...ASK_ARGS] : ["--permission-mode", mode === "edits" ? "acceptEdits" : adminMode];
    for (const d of addDirs) if (typeof d === "string" && d.trim()) out.push("--add-dir", d.trim());
    if (mcpConfig) out.push("--mcp-config", mcpConfig);
    return out;
  }
  if (access === "tenant") {
    if (mode === "ask") return ["--restricted", "--strict-mcp-config", ...ASK_ARGS];
    return ["--restricted", "--strict-mcp-config", "--permission-mode", "acceptEdits", "--permission-prompts", "none"];
  }
  return mode === "ask" ? [...ASK_ARGS] : [];
}

// FEAT-18.4: the one line a permission card shows for a CLI tool request —
// the command, the file or the CLI's own description. Pure.
export function askSummary(tool, input, description = null) {
  const i = input && typeof input === "object" ? input : {};
  const pick = [i.command, i.file_path, i.notebook_path, i.path, i.url, i.pattern, description].find((v) => typeof v === "string" && v.trim());
  if (pick) return String(pick).slice(0, 500);
  try {
    return JSON.stringify(i).slice(0, 300);
  } catch {
    return String(tool ?? "");
  }
}

// FEAT-13.10: a broken TELEHARNESS_CLAUDE_MCP_CONFIG must not kill every admin turn
// (the CLI exits on an unreadable --mcp-config). → {file, servers} when the
// file is a readable {"mcpServers": {...}} JSON, else {file: null, error}.
export function checkMcpConfig(file) {
  if (!file) return { file: null, error: null };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { file: null, error: `TELEHARNESS_CLAUDE_MCP_CONFIG ${file}: ${err?.code === "ENOENT" ? "file not found" : err?.message ?? err}` };
  }
  const servers = doc && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? Object.keys(doc.mcpServers) : null;
  if (!servers || servers.length === 0) return { file: null, error: `TELEHARNESS_CLAUDE_MCP_CONFIG ${file}: no "mcpServers"` };
  return { file, servers, error: null };
}

// --- process helpers -----------------------------------------------------------

const imageName = (file) => path.basename(String(file ?? "")).replace(/\.exe$/i, "").toLowerCase();

// {name, startMs} of a live process, null when there is none. Used only for
// orphan cleanup at startup, so a sync call is fine.
// BUG-236: fast Windows fallback when powershell.exe is slow/times out on CI runners.
export function parseTasklistCsv(out) {
  const line = String(out ?? "").trim().split(/\r?\n/).find((l) => l.startsWith("\""));
  if (!line) return null;
  const m = line.match(/^"([^"]+)"/);
  return m ? imageName(m[1]) : null;
}

export function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      try {
        const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { '{0}|{1}' -f $p.ProcessName, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`;
        const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20_000, windowsHide: true }).trim();
        if (!out) return null;
        const [name, start] = out.split("|");
        return { name: imageName(name), startMs: Number(start) || null };
      } catch {
        const out = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
        const name = parseTasklistCsv(out);
        return name ? { name, startMs: null } : null;
      }
    }
    if (process.platform === "linux") {
      // Linux comm is a thread name (Node 24: MainThread), not the executable.
      // Match the binary recorded at spawn, independent of thread renaming.
      return { name: imageName(readlinkSync(`/proc/${pid}/exe`)), startMs: null };
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
  // (data/claude-sessions.json via TELEHARNESS_DATA_DIR); runsPath: live-run mirror
  // for orphan cleanup (default claude-runs.json next to the store);
  // catalogPath: optional model list override (claude-models.json next to
  // the store, FEAT-11.10). binPath override is for tests (a .js/.mjs
  // fixture is spawned with process.execPath).
  //
  // runTimeoutMs: hard cap from the start, OFF by default (a 15-min cap
  // murdered legitimately long dogfood turns, FEAT-13.4);
  // TELEHARNESS_CLAUDE_TIMEOUT_MS is the opt-in kill switch.
  // idleTimeoutMs: kill after this long WITHOUT ANY OUTPUT (ADR-010);
  // TELEHARNESS_CLAUDE_IDLE_MS, default 0 = off (owner decision: turns live until done). Generous on purpose: a
  // silent tool (long build) must not be shot.
  // keepaliveMs: period of the teleharness.keepalive liveness event.
  constructor({
    hub,
    storePath,
    runsPath = storePath ? path.join(path.dirname(storePath), "claude-runs.json") : null,
    catalogPath = storePath ? path.join(path.dirname(storePath), "claude-models.json") : null,
    binPath = process.env.TELEHARNESS_CLAUDE_BIN || DEFAULT_BIN,
    token = process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
    runTimeoutMs = Number(process.env.TELEHARNESS_CLAUDE_TIMEOUT_MS ?? 0),
    idleTimeoutMs = Number(process.env.TELEHARNESS_CLAUDE_IDLE_MS ?? 0),
    acpPostAnswerIdleMs = Number(process.env.TELEHARNESS_ACP_POST_ANSWER_IDLE_MS ?? 600_000),
    keepaliveMs = 30_000,
    maxQueue = 5,
    adminMode = process.env.TELEHARNESS_CLAUDE_ADMIN_MODE || "bypassPermissions",
    addDirs = process.env.TELEHARNESS_CLAUDE_ADD_DIRS ? process.env.TELEHARNESS_CLAUDE_ADD_DIRS.split(";") : [PORTAL_ROOT],
    mcpConfig = process.env.TELEHARNESS_CLAUDE_MCP_CONFIG || null,
    env = process.env,
    procInspect = inspectProcess,
    procKill = killTreeSync,
    log = (msg) => console.log(msg),
    onTurnEnd = null,
    onTurnStart = null,
    onPlan = null,
    onInterrupted = null, // FEAT-20.2: [{sid, dir, at}] ходы, прерванные перезапуском (восстановление при старте)
    agents = null,
    onAgentMissing = null,
    kbSnapshot = null,
    undoRoot = storePath ? path.join(path.dirname(storePath), "turn-undo") : null,
    projectsDir = projectsRoot(env),
    // FEAT-04.11: lib/claude-tenant.js tenantKit() — jailed Bash, teleharness-* skills,
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
    // FEAT-18.7: the codex shim (lib/codex-shim.mjs) spawned instead of the
    // claude CLI for Codex models; the Codex catalog arrives later
    // (setCodexCatalog, lib/codex-catalog.js) — until then no Codex model passes.
    codexBin = process.env.TELEHARNESS_CODEX_SHIM || path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-shim.mjs"),
  } = {}) {
    this.#hub = hub;
    this.#storePath = storePath;
    this.#runsPath = runsPath;
    this.#catalogPath = catalogPath;
    this.#binPath = binPath;
    this.#token = token;
    this.#runTimeoutMs = Number.isFinite(runTimeoutMs) ? runTimeoutMs : 0;
    this.#idleTimeoutMs = Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : 0;
    this.#acpPostAnswerIdleMs = Number.isFinite(acpPostAnswerIdleMs) && acpPostAnswerIdleMs > 0 ? acpPostAnswerIdleMs : 0;
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
    this.#onPlan = typeof onPlan === "function" ? onPlan : null;
    this.#onInterrupted = typeof onInterrupted === "function" ? onInterrupted : null;
    this.#agents = agents;
    this.#onAgentMissing = typeof onAgentMissing === "function" ? onAgentMissing : null;
    this.#kbSnapshot = typeof kbSnapshot === "function" ? kbSnapshot : null;
    this.#undo = undoRoot ? new TurnUndo({ root: undoRoot }) : null;
    this.#projects = projectsDir;
    this.#flushDelayMs = Number.isFinite(flushDelayMs) && flushDelayMs >= 0 ? flushDelayMs : 250;
    this.#flushMaxMs = Number.isFinite(flushMaxMs) && flushMaxMs >= this.#flushDelayMs ? flushMaxMs : 2000;
    this.#storeWriteAsync = typeof storeWriteAsync === "function" ? storeWriteAsync : writeJsonAtomicAsync;
    this.#codexBin = codexBin;
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
  #acpPostAnswerIdleMs;
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
  #onInterrupted = null;
  // BUG-142: ({sid, dir}) right after a user turn is stored (also queued
  // ones); server.js titles the chat from it without waiting for the answer.
  #onTurnStart = null;
  #onPlan = null; // FEAT-20.1: план из ExitPlanMode план-хода
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
  // FEAT-18.7: Codex models of the owner's ChatGPT subscription ([] = Codex off).
  #codexModels = [];
  #codexBin = null;
  // teleharnessSessionID -> { directory, claudeSid, updatedAt?, title?, messages: [{info, parts}] }
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
  // teleharnessSessionID -> live turn (spawned child + timers + transcript state)
  #runs = new Map();
  // teleharnessSessionID -> [queued turn] (follow-ups sent during a live turn)
  #queues = new Map();
  // FEAT-01.77: троттлинг обновлений работы субагента — не чаще раза в 300 мс
  // на часть; последнее состояние доставляется финальными частями хода
  #teleharnessTimer = null;
  #teleharnessPending = new Map(); // partID -> {dir, sid, messageID, op}
  // BUG-184: teleharnessSessionID -> run whose answer is DONE (`result` came) but whose
  // CLI process is still alive, waiting for background tasks of the agent
  // (Bash run_in_background, …). The chat is free; a new message stops the
  // tail; a round the tail runs on its own becomes one more answer.
  #tails = new Map();
  // GET /teleharness/api/provider injection cache: { at, body, etag }
  #provider = { at: 0, body: null, etag: null };

  // --- routing helpers (used by server.js) -----------------------------------

  // The store knows this session (claude turns ran here).
  has(sid) {
    return this.#runs.has(sid) || Boolean(this.#store.sessions[sid]?.messages?.length);
  }

  dirOf(sid) {
    return this.#store.sessions[sid]?.directory ?? null;
  }

  // FEAT-20.6: учёт истории в журнал расхода — {sid: {directory, messages}} (только чтение).
  storeSnapshot() {
    return this.#store.sessions;
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

  // FEAT-18.7: the Codex catalog (model/list entries or already normalized);
  // empty/junk → Codex is off (not offered, its prompts refused).
  setCodexCatalog(list) {
    this.#codexModels = normalizeCodexCatalog(list) ?? [];
    this.#provider = { at: 0, body: null, etag: null }; // the picker sees the change on its next fetch
  }

  codexModels() {
    return this.#codexModels.map((m) => ({ ...m }));
  }

  // FEAT-18.7: which CLI a turn of this model runs on: "claude" | "codex" | null.
  engineOfModel(modelID) {
    if (isClaudeModel(modelID, this.#models)) return "claude";
    if (typeof modelID === "string" && this.#codexModels.some((m) => m.id === modelID)) return "codex";
    return null;
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
    this.#dropTeleharness(); // FEAT-01.77: сессии больше нет — отложенные части не нужны
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
    // FEAT-18.7: Codex keeps no Claude transcript to cut and no file backups.
    if (entry.messages.slice(last.index).some((m) => m?.info?.providerID === CODEX_PROVIDER)) return { status: 409, error: "undo is not available for Codex turns" };
    // BUG-281: у ACP нет хуков отката файлов — честный запрет 409 как у Codex.
    if (entry.messages.slice(last.index).some((m) => Object.hasOwn(ACP_PROVIDERS, m?.info?.providerID))) return { status: 409, error: "undo is not available for ACP turns" };
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
      this.#log(`[teleharness-claude] turn undo failed: ${err?.message ?? err}`);
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
      this.#log(`[teleharness-claude] turn redo failed: ${err?.message ?? err}`);
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
    if (entry.acpSessions) delete entry.acpSessions; // следующий ACP-ход получит только оставшуюся в чате историю
    if (cut) {
      if (!cut.claudeSid || cut.bytes === 0) {
        entry.claudeSid = null;
        delete entry.fork;
      } else entry.fork = { from: cut.claudeSid, bytes: Number.isFinite(cut.bytes) ? cut.bytes : null };
    } else {
      // A turn from before FEAT-01.57: cut before the transcript's last
      // prompt — unless the question never reached the CLI.
      const answer = removed.find((m) => m?.info?.role === "assistant");
      if (entry.claudeSid && answer?.info?.teleharness?.interrupted !== "cancelled") entry.fork = { from: entry.claudeSid, bytes: null };
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

  // BUG-294: чистое завершение зависшего ACP-хода после готового ответа —
  // без [Прервано], без сброса очереди и со сбросом битой ACP-сессии.
  finishHungAcp(sid) {
    const run = this.#runs.get(sid);
    if (!run || !run.acp || run.finalized) return false;
    return this.#kill(sid, "acp-release");
  }

  // Graceful shutdown hook (server.js on SIGTERM): kill every live CLI; the
  // runs file then lets the next start answer the interrupted questions.
  shutdown() {
    for (const [sid, run] of this.#runs) {
      run.abortedBy ??= "restart";
      this.#closeAsks(sid, run, "Портал перезапускается");
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

  // BUG-237: background subagents of a live CLI process are running — by the CLI's own task
  // list (background_tasks_changed: local_agent) or by a running agent part of the answer. The
  // list is the authority: a round the CLI opens meanwhile (a notification of the subagent's own
  // command) replaces the transcript, so the agent part may sit in an earlier answer.
  #agentsRunning(run) {
    if (!run || run.superseded || run.exited) return false;
    // a command a subagent started (parent_task_id) is that subagent's work too
    if ((run.bgList ?? []).some((t) => t?.task_type === "local_agent" || t?.parent_task_id)) return true;
    if ((run.agentHomes ?? []).some((h) => h.transcript.hasRunningTeleharnessRun())) return true;
    return Boolean(run.transcript?.hasRunningTeleharnessRun?.());
  }

  // { sid: {type:"busy"} } for every live turn (server.js healthz counts it).
  busySnapshot() {
    const out = {};
    for (const sid of this.#runs.keys()) out[sid] = { type: "busy" };
    // FEAT-01.77: после `result` CLI ждёт в хвосте запущенного агента —
    // чат остаётся занятым для клиента и healthz, пока агент не завершится
    for (const [sid, tail] of this.#tails) {
      // BUG-237: busy only by background agents (no main turn) — the client shows the band
      if (!out[sid] && this.#agentsRunning(tail)) out[sid] = { type: "busy", bg: true };
    }
    return out;
  }

  #activeTasks(run) {
    const parts = run?.transcript?.parts?.() ?? [];
    const out = [];
    for (const p of parts) {
      if (p?.type !== "tool") continue;
      const st = p.state?.status;
      if (st !== "running" && st !== "pending") continue;
      if (p.tool === "task" || p.tool === "subagent") continue;
      const inp = p.state?.input ?? {};
      const raw = run.access === "admin"
        ? (inp.description || inp.command || inp.CommandLine || inp.command_line || inp.file_path || inp.path || "")
        : "";
      const detail = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      out.push({ id: p.callID || p.id, tool: p.tool || "tool", ...(detail ? { detail } : {}), startedAt: p.state?.time?.start ?? run.startedAt });
    }
    return out;
  }

  #live(sid, run) {
    return {
      startedAt: run.startedAt,
      lastOutputAt: run.lastOutputAt,
      lastAction: run.lastAction,
      queued: this.#queues.get(sid)?.length ?? 0,
      activeTasks: this.#activeTasks(run),
      hasAnswerText: Boolean(run.transcript?.hasText?.()),
    };
  }

  #kill(sid, reason) {
    const tail = this.#tails.get(sid);
    this.#dropTail(sid);
    const run = this.#runs.get(sid);
    if (!run) {
      // FEAT-01.77: «Стоп» посреди работы субагента в хвосте (после `result`)
      // — чат снова свободен: busy снимает #stopTailRuns, клиенту нужен idle
      if (reason === "user" && tail && (tail.teleharnessBusy || tail.transcript?.hasRunningTeleharnessRun?.())) {
        this.#emit(tail.dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
        this.#emit(tail.dir, { type: "session.idle", properties: { sessionID: sid } });
      }
      return false;
    }
    run.abortedBy ??= reason;
    // FEAT-18.4: a stop answers every open request with «deny» first.
    this.#closeAsks(sid, run, "Ход остановлен пользователем");
    this.#endInput(run);
    if (run.acp && process.platform !== "win32") {
      run.child.kill("SIGTERM");
      const escalation = setTimeout(()=>killChildTree(run.child),5000);
      escalation.unref();
      run.child.once("close",()=>clearTimeout(escalation));
    } else killChildTree(run.child);
    return true;
  }

  // --- permission bridge (FEAT-18.4, «Спрашивать») -----------------------------

  // control_request from the CLI: can_use_tool → a portal permission dialog
  // (the same permission.asked event opencode sends: DialogBar, the list
  // badge and Web Push «нужно ваше решение» pick it up as is). Any other
  // request subtype is answered with an error (the CLI goes on).
  #onControl(sid, run, evt) {
    if (evt.type === "control_cancel_request") {
      const id = evt.request_id;
      if (typeof id === "string" && run.asks.delete(id)) this.#emit(run.dir, { type: "permission.replied", properties: { sessionID: sid, id, requestID: id, reply: "reject" } });
      return;
    }
    const id = evt.request_id;
    if (typeof id !== "string" || !id) return;
    const req = evt.request ?? {};
    if (req.subtype !== "can_use_tool" || !run.bridge) {
      this.#writeControl(run, { subtype: "error", request_id: id, error: `unsupported control request: ${req.subtype ?? "?"}` });
      return;
    }
    const tool = typeof req.tool_name === "string" ? req.tool_name : "tool";
    // FEAT-20.1: план-ход — план уходит на одобрение в портал, CLI получает отказ и завершает ход
    if (run.planMode && tool === "ExitPlanMode") {
      const plan = typeof req.input?.plan === "string" ? req.input.plan : "";
      run.plan = plan;
      try {
        this.#onPlan?.({ sid, dir: run.dir, plan });
      } catch {}
      this.#writeControl(run, { subtype: "success", request_id: id, response: { behavior: "deny", message: "План отправлен владельцу на одобрение в портале. Не вноси правки, коротко подтверди и заверши ход." } });
      return;
    }
    const summary = askSummary(tool, req.input, typeof req.description === "string" ? req.description : null);
    const ask = { id, sessionID: sid, tool, input: req.input ?? {}, summary, askedAt: nowMs(), dir: run.dir };
    run.asks.set(id, ask);
    run.lastAction = tool;
    this.#emit(run.dir, { type: "permission.asked", properties: this.#askProps(ask) });
  }

  // The dialog record — the shape of opencode's permission.asked properties
  // (lib/normalize.js extractDialog: permission, patterns, metadata.command).
  #askProps(ask) {
    return { id: ask.id, sessionID: ask.sessionID, permission: ask.tool, patterns: [ask.summary], metadata: { command: ask.summary }, always: [], teleharness: { engine: "claude" } };
  }

  #writeControl(run, response) {
    const stdin = run.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(JSON.stringify({ type: "control_response", response }) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  #endInput(run) {
    if (!run.streamIn) return;
    clearTimeout(run.endInputTimer);
    const stdin = run.child?.stdin;
    try {
      if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
    } catch {}
  }

  // Every open request of the run → «deny» (the turn ends or is stopped) and
  // the dialog leaves the clients.
  #closeAsks(sid, run, message) {
    if (!run.asks?.size) return;
    for (const ask of [...run.asks.values()]) {
      this.#writeControl(run, { subtype: "success", request_id: ask.id, response: { behavior: "deny", message } });
      this.#emit(run.dir, { type: "permission.replied", properties: { sessionID: sid, id: ask.id, requestID: ask.id, reply: "reject" } });
    }
    run.asks.clear();
  }

  // Open bridge requests as GET /teleharness/api/dialogs records ({kind, id, sessionID,
  // directory, askedAt, …}); server.js merges them with opencode's.
  dialogs() {
    const out = [];
    for (const run of this.#runs.values()) {
      for (const ask of run.asks?.values() ?? []) out.push({ kind: "permission", directory: ask.dir ?? null, askedAt: ask.askedAt, ...this.#askProps(ask) });
    }
    return out;
  }

  // The open bridge request with this id ({id, sessionID, dir, tool}) or null.
  dialogOf(id) {
    for (const run of this.#runs.values()) {
      const ask = run.asks?.get(id);
      if (ask) return { id: ask.id, sessionID: ask.sessionID, dir: ask.dir ?? null, tool: ask.tool };
    }
    return null;
  }

  // The person's answer (POST /permission/:id/reply): "once"/"always" → allow
  // with the original input, "reject" → deny with the reason. false = no
  // such open request (answered, the turn ended).
  replyDialog(id, { reply, message = null } = {}) {
    for (const [sid, run] of this.#runs) {
      const ask = run.asks?.get(id);
      if (!ask) continue;
      const allow = reply === "once" || reply === "always";
      const response = allow
        ? { behavior: "allow", updatedInput: ask.input }
        : { behavior: "deny", message: typeof message === "string" && message.trim() ? message.trim().slice(0, 500) : "Пользователь запретил это действие в портале" };
      if (!this.#writeControl(run, { subtype: "success", request_id: id, response })) return false;
      run.asks.delete(id);
      run.lastOutputAt = nowMs();
      this.#emit(run.dir, { type: "permission.replied", properties: { sessionID: sid, id, requestID: id, reply: allow ? "once" : "reject" } });
      return true;
    }
    return false;
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
  // permMode (FEAT-18.4): the chat's permission mode at the moment of sending
  // ("ask" | "edits" | "full" | null = role default); a queued turn keeps it.
  async dispatch({ res, sid, dir, body, access, acpOwner=null, agent = null, kbZone = null, jail = null, systemPrompt = "", workDir = null, portalNote = "", permMode = null, nonInteractive = false, writableRoots = null }) {
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
    // ADR-004 §4: only catalog ids reach the CLI's --model. FEAT-18.7: a Codex
    // model of the Codex catalog runs the same way through the codex shim.
    const provider = parsed?.model?.providerID;
    const acpAgent = Object.hasOwn(ACP_PROVIDERS,provider) ? ACP_PROVIDERS[provider] : null;
    if (acpAgent && (!acpOwner || process.env.TELEHARNESS_ACP === "off")) return send(403,{error:"ACP недоступен"});
    if (acpAgent && modelID !== provider) {
      const dataRoot = path.dirname(this.#storePath);
      const hasModel = (cat) => cat?.availableModels?.some((m) => m.modelId === modelID);
      if (!hasModel(cachedAcpModels(dataRoot, acpOwner, acpAgent))) {
        const refreshed = await discoverAcpModels(dataRoot, acpOwner, acpAgent).catch(() => null);
        if (!hasModel(refreshed)) return send(400, { error: "Модель ACP недоступна" });
      }
    }
    const engine = acpAgent ? "acp" : this.engineOfModel(modelID);
    if (!engine) return send(400, { error: `unknown claude model: ${modelID}` });
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
    let { prompt, stored, images } = buildTurn(parts, dir);
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

    const turn = { engine, acpOwner, acpAgent, dir, prompt, images, modelID, access, userMsgId, agent: isClaudeAgentId(agent) ? agent : null, jail: access === "tenant" && jail?.name && jail?.home ? { name: jail.name, home: jail.home } : null, portalNote: typeof portalNote === "string" ? portalNote : "", systemPrompt: typeof systemPrompt === "string" ? systemPrompt : "", kbDir: tenantKbDir(access, kbZone), workDir: typeof workDir === "string" && workDir ? workDir : null, permMode: ["ask", "edits", "full", "plan"].includes(permMode) ? permMode : null, nonInteractive: Boolean(nonInteractive), writableRoots: Array.isArray(writableRoots) ? writableRoots.filter((d) => typeof d === "string" && d) : null };
    if (busy) {
      const q = this.#queues.get(sid) ?? [];
      q.push(turn);
      this.#queues.set(sid, q);
      const run = this.#runs.get(sid);
      if (run) this.#emit(dir, { type: "teleharness.keepalive", properties: { sessionID: sid, ...this.#live(sid, run) } });
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
      this.#log(`[teleharness-claude] kb snapshot failed: ${err?.message ?? err}`);
      return null;
    }
  }

  #args({ modelID, access, resume, agent = null, agentsFile = null, freshPrompt = false, hooks = null, forkSession = false, jail = null, systemPrompt = "", kbDir = null, rootDir = null, portalNote = "", permMode = null, streamIn = permMode === "ask" || permMode === "plan" }) {
    // FEAT-04.11: a tenant turn with its jail gets the tenant kit — the Bash
    // hook rides the same --settings as the undo hook.
    const kit = access === "tenant" && jail && this.#tenantKit ? this.#tenantKit : null;
    if (kit) hooks = withJailHook(hooks, kit, jail);
    // No positional argument at all: the prompt rides stdin, so no prompt
    // text can ever be parsed as a CLI option (SEC-11) and argv stays short
    // (32K CreateProcess limit, COR-14), UTF-8 intact (BUG-13.2).
    // FEAT-18.4 (design §1 variant А): only «Спрашивать» reads stream-json —
    // the CLI's permission requests need an open stdin to be answered on.
    // BUG-237: every Claude turn reads stream-json — with stdin open the CLI answers at once and
    // keeps background subagents alive after `result` (with text input it holds the answer, then
    // kills them). Codex (the shim) reads stream-json only for «Спрашивать».
    const args = ["-p", "--input-format", streamIn ? "stream-json" : "text", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", modelID];
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
    args.push(...permissionArgs(access, { ...this.#perm, mode: permMode }));
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
        this.#log(`[teleharness-claude] user system prompt not written: ${err?.message ?? err}`);
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
      this.#log(`[teleharness-claude] agents file not written: ${err?.message ?? err}`);
    }
    if (file) return { agent: id, agentsFile: file };
    if (turn.acpAgent === "antigravity") return { error: `Gemini: выбранная роль «${id}» недоступна.` };
    if (turn.engine === "codex") return { error: `Codex: выбранная роль «${id}» недоступна: профиль не найден или каталог не удалось записать. Ход не запущен.` };
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
      // BUG-237: background subagents are working — the message waits for them (queue) instead of
      // killing them; the tail's exit starts it. Background commands only → BUG-184 stop.
      const tail = this.#tails.get(sid);
      if (this.#agentsRunning(tail)) {
        const q = this.#queues.get(sid) ?? [];
        if (!q.includes(turn)) q.push(turn);
        this.#queues.set(sid, q);
        this.#emit(tail.dir, { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
        return;
      }
      this.#dropTail(sid, () => this.#start(sid, turn));
      return;
    }
    const { dir, prompt, modelID, access, userMsgId } = turn;
    // FEAT-18.7: a Codex turn — the shim instead of the claude CLI; no Claude
    // undo hooks, tenant kit or transcript fork (Claude-only machinery).
    const codex = turn.engine === "codex";
    const acp = turn.engine === "acp";
    const acpSessionKey = acp ? createHash("sha256").update(JSON.stringify([turn.acpOwner,turn.acpAgent])).digest("hex") : null;
    const providerID = acp ? "acp-" + turn.acpAgent : codex ? CODEX_PROVIDER : CLAUDE_PROVIDER_ID;
    let asstMsgId = shortId("msgc_a");
    const { agent, agentsFile, error: profileError } = this.#agentOf(sid, turn);
    const rejectProfile = (profileError) => {
      // No child is spawned: a missing selected Codex role must never become
      // an unprofiled model turn. Finish the accepted question and drain queue.
      const completed = nowMs();
      const info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID, modelID, time: { created: completed, completed } };
      const part = { id: shortId("prt"), type: "text", text: profileError };
      this.#insertAnswer(entry, userMsgId, { info, parts: [part] });
      entry.updatedAt = Math.max(entry.updatedAt ?? 0, completed);
      this.#flush();
      this.#emitPart(dir, sid, asstMsgId, { op: "updated", part });
      this.#emit(dir, { type: "message.updated", properties: { sessionID: sid, info } });
      this.#touch(sid, entry, dir, completed);
      const next = this.#queues.get(sid)?.shift();
      if (!this.#queues.get(sid)?.length) this.#queues.delete(sid);
      if (next) setImmediate(() => this.#start(sid, next));
      else {
        this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
        this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
      }
      if (this.#onTurnEnd) setImmediate(() => {
        try {
          const r = this.#onTurnEnd({ sid, dir, reason: null, error: profileError });
          if (r && typeof r.catch === "function") r.catch(() => {});
        } catch {}
      });
      return;
    };
    if (profileError) return rejectProfile(profileError);
    // FEAT-01.57: where the CLI history stands before this turn — a later
    // «Изменить» / «Отменить ход» cuts it back to exactly here.
    // FEAT-04.12 stage B: the CLI's folder (cwd, transcript slug) — the chat's own
    // subfolder when it has one, else the session folder.
    const cwd = turn.workDir || dir;
    const gemini = turn.acpAgent === "antigravity";
    const rolePrompt = gemini && agent ? this.#agents.get(agent)?.prompt : null;
    if (gemini && agent && !rolePrompt) return rejectProfile("Gemini: инструкции выбранной роли недоступны.");
    const roleHash = rolePrompt ? createHash("sha256").update(rolePrompt).digest("hex") : null;
    const sameRole = !gemini || (entry.geminiRoleHash ?? null) === roleHash;
    const { resume, forkSession, copyFile, cut } = acp ? {resume:sameRole ? entry.acpSessions?.[acpSessionKey] ?? null : null,cut:null} : codex ? this.#codexHistoryFor(entry) : this.#historyFor(entry, cwd);
    const userMsg = entry.messages.find((m) => m?.info?.id === userMsgId);
    if (userMsg) userMsg.cut = cut;
    // FEAT-01.58: only the last turn is undoable; this one gets the hook.
    let hooks = null;
    try {
      if (!acp && !codex && this.#undo && this.#undo.startTurn(sid, userMsgId)) hooks = this.#undo.hookSettings(sid, userMsgId);
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
    // FEAT-18.7: «Правки без вопросов» в Codex-ходе (пришли с передачей чата) — как
    // «Спрашивать»: без песочницы Codex на Windows молчаливый режим ничего не запишет.
    const permMode = (codex || acp) && turn.permMode === "edits" ? "ask" : (codex || acp) && turn.permMode === "plan" ? "plan-ro" : turn.permMode ?? null;
    const streamIn = !codex || permMode === "ask"; // BUG-237
    const args = acp ? [] : this.#args({ modelID, access, resume, agent, agentsFile, freshPrompt, hooks, forkSession, jail: codex ? null : turn.jail ?? null, systemPrompt, kbDir: codex ? null : turn.kbDir ?? null, rootDir: turn.workDir ? dir : null, portalNote, permMode, streamIn });
    // FEAT-20.7: Codex в рабочей копии — общий .git репозитория доступен для записи
    if (codex && turn.writableRoots?.length) for (const d of turn.writableRoots) args.push("--teleharness-writable-root", d);
    let instructionsHash = null;
    let effectivePrompt = prompt;
    if (codex) {
      try {
        const parsed = parseCodexArgs(args);
        instructionsHash = createHash("sha256").update(renderDeveloperInstructions(parsed, codexPolicy(parsed))).digest("hex");
        args.push("--teleharness-instructions-hash", instructionsHash);
      } catch (err) {
        return rejectProfile(`Codex: профиль инструкций недоступен: ${err?.message ?? err}. Ход не запущен.`);
      }
      if (resume && entry.codexInstructionsHash !== instructionsHash) {
        const i = args.indexOf("--resume");
        if (i >= 0) args.splice(i, 2);
        effectivePrompt = this.#codexCarryover(entry, userMsgId, portalNote) + prompt;
      }
    }
    const bridge = acp || permMode === "ask" || permMode === "plan";
    if (agent) entry.agentUsed = true;
    if (systemPrompt) entry.userPromptUsed = true;

    if (acp) {
      const prior = entry.messages.slice(0,entry.messages.findIndex(message=>message.info.id===userMsgId));
      const context = prior.map(message=>[message.info.role,...message.parts.filter(part=>part.type==="text").map(part=>part.text)].join(": ")).join("\n").slice(-16000);
      const acpMode = resolveAcpMode(permMode, access === "admin");
      const planNote = acpMode === "plan" || acpMode === "plan-ro"
        ? "[Режим «Сначала план»] Не изменяй файлы и не запускай изменяющие команды. Изучи задачу (только чтение) и верни структурированный план действий — выполнение начнётся только после одобрения плана пользователем."
        : "";
      const tenantAcpNote = access !== "admin"
        ? "[Ограничение пользователя] Работай только с файлами внутри текущей рабочей папки. Не обращайся к файлам за её пределами и не выполняй команды оболочки."
        : "";
      effectivePrompt = JSON.stringify({dataDir:path.dirname(this.#storePath),owner:turn.acpOwner,admin:access === "admin",mcpConfig:access === "admin" ? (this.#perm?.mcpConfig ?? null) : null,agent:turn.acpAgent,modelId:modelID === providerID ? null : modelID,resume,mode:acpMode,nonInteractive:Boolean(turn.nonInteractive),
        context:context ? "[История чата]\n"+context+"\n[Конец истории]\n" : "",
        images:turn.images ?? [],
        prompt:[tenantAcpNote,planNote,rolePrompt,systemPrompt,portalNote,prompt].filter(Boolean).join("\n\n")});
    }
    const binPath = acp ? fileURLToPath(new URL("./acp-shim.mjs",import.meta.url)) : codex ? this.#codexBin : this.#binPath;
    const isScript = /\.(c?js|mjs)$/i.test(binPath);
    // TASK-17.1: на POSIX — своя группа процессов, чтобы «Стоп» убивал shell и MCP вместе с CLI
    const opts = groupSpawnOpts({ cwd: cwd || undefined, windowsHide: true, env: acp ? {PATH:path.dirname(process.execPath)} : childEnv(this.#env, { token: this.#token }), stdio: ["pipe", "pipe", "pipe"] });
    const child = isScript ? spawn(process.execPath, [binPath, ...args], opts) : spawn(binPath, args, opts);

    const startedAt = nowMs();
    const run = {
      acp, child,
      access,
      dir,
      abortedBy: null,
      finalized: false,
      // FEAT-01.77: ход закрыт, но запуск субагента ещё работает (хвост CLI) —
      // чат не гаснет в idle, пока он не завершится
      teleharnessBusy: false,
      // FEAT-13.19: the turn as opencode-shaped parts (steps, reasoning,
      // tool calls, text) — streamed live and stored with the answer.
      transcript: new ClaudeTranscript({ sessionID: sid, messageID: asstMsgId, newId: () => shortId("prt") }),
      claudeSid: null,
      result: null,
      spawnError: null,
      keepalive: null,
      timer: null,
      idleTimer: null,
      acpWatchTimer: null,
      startedAt,
      lastOutputAt: startedAt,
      lastAcpEventAt: startedAt,
      lastAction: null,
      // FEAT-18.4: «Спрашивать» — stdin stays open for control_response lines;
      // asks: request_id → the open permission request of the CLI.
      bridge,
      // BUG-237: stream-json input — stdin open until the CLI has nothing left to run
      streamIn,
      // BUG-237: the CLI's own list of background tasks (background_tasks_changed)
      bgList: [],
      asks: new Map(),
      // FEAT-20.1: план-ход — вызов ExitPlanMode перехватывается (#onControl)
      planMode: permMode === "plan" || permMode === "plan-ro",
      plan: null,
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
    run.info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID, modelID, ...(agent ? { agent } : {}), time: { created: startedAt } };
    this.#emit(dir, {
      type: "message.updated",
      properties: { sessionID: sid, info: { ...run.info, time: { ...run.info.time } } },
    });

    // A queued follow-up starting later is fresh activity too (BUG-13.16).
    this.#touch(sid, entry, dir, startedAt, true);

    // Mirror for orphan cleanup after a restart (ADR-010 §3).
    if (child.pid) {
      this.#saveRun(sid, { pid: child.pid, image: imageName(isScript ? process.execPath : binPath), spawnedAt: startedAt, claudeSid: (codex ? entry.codexSid : entry.claudeSid) ?? null, userMsgId, modelID, ...(acp ? { engine: "acp", providerID, acpSessionKey, claudeSid: null } : codex ? { engine: "codex", codexInstructionsHash: entry.codexInstructionsHash ?? null } : {}) });
    }

    // The prompt: UTF-8 bytes on stdin, then EOF - a CLI waiting for input
    // can never hang the turn (SEC-21).
    child.stdin.on("error", () => {}); // EPIPE when the CLI dies early
    // FEAT-18.4: «Спрашивать» — one stream-json user message, stdin stays open
    // until `result` (the answers to the CLI's requests go there), closed after
    // it or on a stop (#endInput).
    if (acp) child.stdin.write(effectivePrompt+"\n");
    else if (streamIn) child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: effectivePrompt } }) + "\n");
    else child.stdin.end(Buffer.from(effectivePrompt, "utf8"));

    // BUG-184: one CLI process may give several answers — the turn's own, then
    // rounds it runs by itself when a background task of the agent ends. The
    // answer closes on the CLI's `result` (finalize = end of the ROUND); the
    // process may live on as a tail (#tails) until it exits (onExit below).
    const finalize = () => {
      if (run.finalized) return;
      run.finalized = true;
      this.#closeAsks(sid, run, "Ход завершён");
      clearInterval(run.keepalive);
      clearTimeout(run.timer);
      clearTimeout(run.idleTimer);
      clearTimeout(run.acpWatchTimer);
      this.#dropTeleharness(); // FEAT-01.77: финальные части несут последнее состояние — отложенное не нужно
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
      let turnError = null; // FEAT-18.6: текст ошибки хода для onTurnEnd (авто-передача при лимите)
      if (run.spawnError || run.result?.isError) {
        ops.push(...tr.dropText());
        tail = run.spawnError ? `Не удалось запустить ${acp ? "ACP-агент" : codex ? "codex" : "claude"} CLI: ${run.spawnError}` : run.result.text || (acp ? "Агент ACP вернул ошибку" : codex ? "Codex вернул ошибку" : "Claude вернул ошибку");
        turnError = tail;
      } else if (!tr.hasText() && run.result?.text) tail = run.result.text;
      // BUG-182: the CLI died on its own (out of memory, killed): no `result`, not
      // stopped by the portal → an interrupted turn, never a silent half answer.
      if (!run.abortedBy && !run.spawnError && !run.result) {
        run.abortedBy = "crash";
        const how = run.exitSignal ? `signal ${run.exitSignal}` : `code ${run.exitCode ?? "?"}`;
        const tail = String(run.stderrTail ?? "").replace(/\s+/g, " ").trim().slice(-400);
        this.#log(`[teleharness-claude] BUG-182 unexpected exit of claude CLI in ${sid}: ${how}, no result line${tail ? `; stderr tail: ${tail}` : ""}`);
      }
      const reason = run.abortedBy;
      const acpReleased = reason === "acp-release";
      const mark = reason === "idle" ? idleMark(this.#idleTimeoutMs) : reason === "crash" ? crashMark(run) : acpReleased ? "" : MARK[reason] ?? "";
      if (mark) tail = tail ? `${tail}\n\n${mark}` : mark;
      if (!tail && !tr.hasText()) tail = "(пустой ответ)";
      if (tail) ops.push(tr.addText(tail));
      const parts = tr.parts();
      // Без is_error CLI иногда пишет ошибку (лимит) обычным ответом — тот же
      // признак, что у клиента (shared/turn-error.js claudeAnswerError).
      if (!turnError && !reason) turnError = claudeAnswerError(parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n"));

      const completed = nowMs();
      const live = this.#store.sessions[sid] === entry; // gone after forget()
      const info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID, modelID, time: { created: run.startedAt, completed } };
      if (agent) info.agent = agent; // FEAT-13.17: which agent gave this answer
      if (reason && reason !== "deleted" && !acpReleased) info.teleharness = { interrupted: reason };
      else if (acpReleased) info.teleharness = { acpReleased: true };
      if ((!reason || acpReleased) && turnError) info.turnError = true; // FEAT-20.6: статус «ошибка» в журнале расхода (info.teleharness — только прерывания)
      Object.assign(info, claudeTurnUsage(run.result, run.lastUsage, modelID)); // FEAT-18.5
      if (live) {
        // The claude session survives an interrupted turn too: the next
        // prompt resumes WITH the partial work (FEAT-13.12).
        // FEAT-18.7: a Codex thread id lives apart — a chat relayed between
        // Claude and Codex resumes each CLI's own conversation.
        if (acp) {
          // BUG-298: любое прерывание (user, restart, crash, idle, timeout, acp-release)
          // или сбой старта процесса могли оставить нетерминальный шаг в БД ACP-агента.
          // Сбрасываем sessionId — следующий ход стартует чистую сессию с историей чата.
          if (reason || run.spawnError || run.result?.isError) {
            if (entry.acpSessions) delete entry.acpSessions[acpSessionKey];
          } else if (run.claudeSid) {
            (entry.acpSessions ??= {})[acpSessionKey] = run.claudeSid;
            if (gemini) entry.geminiRoleHash = roleHash;
          }
        }
        else if (codex) entry.codexSid = run.claudeSid ?? entry.codexSid ?? null;
        else entry.claudeSid = run.claudeSid ?? entry.claudeSid;
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
      if (tr.hasRunningTeleharnessRun() || this.#agentsRunning(run)) {
        run.teleharnessBusy = true;
        // BUG-237: the main turn is over, only background agents work — «Фоном работает агент»
        this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "busy", bg: true } } });
      }
      else {
        this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
        this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
      }
      if (live && this.#onTurnEnd) {
        const hook = this.#onTurnEnd;
        setImmediate(() => {
          try {
            const r = hook({ sid, dir, reason: acpReleased ? null : reason ?? null, error: !reason || acpReleased ? turnError : null });
            if (r && typeof r.catch === "function") r.catch(() => {});
          } catch {}
        });
      }
    };
    run.finalize = finalize;

    const beat = () => this.#emit(dir, { type: "teleharness.keepalive", properties: { sessionID: sid, ...this.#live(sid, run) } });
    // Liveness without lying (ADR-010 §2): a dedicated event carrying the
    // last REAL output time, not a fake busy frame.
    run.keepalive = setInterval(beat, this.#keepaliveMs);

    // BUG-184: the tail starts a round of its own (a background task ended →
    // the CLI's task notification → `system init`): one more answer to the
    // same question, the chat is busy again while it runs.
    const beginRound = () => {
      // BUG-237: a subagent of the answer that ends here still runs — its events keep going to
      // that answer's agent card (the new round gets a fresh transcript)
      if (run.transcript?.hasRunningTeleharnessRun?.()) (run.agentHomes ??= []).push({ transcript: run.transcript, msgId: asstMsgId, dir });
      asstMsgId = shortId("msgc_a");
      const at = nowMs();
      Object.assign(run, { finalized: false, result: null, emptyResult: null, lastUsage: null, abortedBy: null, startedAt: at, lastOutputAt: at, lastAction: null, autoRound: true, teleharnessBusy: false });
      run.transcript = new ClaudeTranscript({ sessionID: sid, messageID: asstMsgId, newId: () => shortId("prt") });
      run.info = { id: asstMsgId, sessionID: sid, role: "assistant", parentID: userMsgId, providerID, modelID, ...(agent ? { agent } : {}), time: { created: at } };
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
        if (run.asks?.size) run.lastOutputAt = nowMs(); // FEAT-18.4: waits for the person, not hung
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
    if (acp && this.#acpPostAnswerIdleMs > 0) {
      const watch = () => {
        if (run.finalized || run.exited) return;
        const ready = Boolean(
          run.transcript?.hasText?.() &&
          this.#activeTasks(run).length === 0 &&
          !run.transcript?.hasRunningTeleharnessRun?.() &&
          !run.asks?.size,
        );
        const silent = nowMs() - run.lastAcpEventAt;
        if (ready && silent >= this.#acpPostAnswerIdleMs) {
          this.#log(`[teleharness-claude] BUG-294 auto-released hung ACP session ${sid} after ${Math.round(silent / 1000)}s post-answer silence`);
          this.#emit(dir, {
            type: "teleharness.notice",
            properties: {
              sessionID: sid,
              text: "Gemini не закрыл ход после ответа — ход завершён автоматически, следующий ход начнёт новую ACP-сессию с историей чата.",
            },
          });
          this.finishHungAcp(sid);
          return;
        }
        const wait = ready ? Math.max(50, this.#acpPostAnswerIdleMs - silent) : Math.max(50, Math.min(this.#acpPostAnswerIdleMs, 30_000));
        run.acpWatchTimer = setTimeout(watch, wait);
        run.acpWatchTimer.unref?.();
      };
      run.acpWatchTimer = setTimeout(watch, Math.max(50, Math.min(this.#acpPostAnswerIdleMs, 30_000)));
      run.acpWatchTimer.unref?.();
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
        run.lastAcpEventAt = nowMs();
        // FEAT-18.4: the CLI asks the host (permission bridge, «Спрашивать»).
        if (evt.type === "control_request" || evt.type === "control_cancel_request") {
          this.#onControl(sid, run, evt);
          continue;
        }
        // BUG-184: after the answer the tail only waits (task_started / task_updated
        // / task_notification …); a new `system init` opens a round of its own.
        // the CLI reports background tasks of the agent (Bash run_in_background …)
        if (evt.type === "system" && /^(task_started|background_tasks_changed|task_updated)$/.test(String(evt.subtype ?? ""))) run.bgTasks = true;
        // BUG-237: the background tasks are over and the answer is in — nothing keeps the CLI;
        // a round the CLI starts on the notification gets ~10 s, then stdin closes.
        if (evt.type === "system" && evt.subtype === "background_tasks_changed") {
          run.bgList = Array.isArray(evt.tasks) ? evt.tasks : [];
          if (run.bgList.length === 0 && run.finalized && !this.#runs.has(sid)) {
            clearTimeout(run.endInputTimer);
            run.endInputTimer = setTimeout(() => { if (!this.#runs.has(sid) || this.#runs.get(sid) !== run) this.#endInput(run); }, 10_000);
            run.endInputTimer.unref?.();
          }
        }
        // BUG-237: traffic of a subagent started in an earlier answer of this process → that answer
        if (run.agentHomes?.length && (evt.parent_tool_use_id || (evt.type === "system" && /^(task_started|task_updated|task_notification|task_progress)$/.test(String(evt.subtype ?? ""))))) {
          let used = false;
          for (const h of run.agentHomes) {
            const ops = h.transcript.feed(evt);
            if (!ops.length) continue;
            used = true;
            for (const op of ops) this.#emitTeleharnessOp(h.dir, sid, h.msgId, op);
            this.#patchStoredParts(sid, h.msgId, h.transcript.parts());
          }
          run.agentHomes = run.agentHomes.filter((h) => h.transcript.hasRunningTeleharnessRun());
          if (used) {
            if (run.finalized && run.teleharnessBusy && !this.#agentsRunning(run)) {
              run.teleharnessBusy = false;
              this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
              this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
            }
            continue;
          }
        }
        if (run.finalized) {
          if (!run.superseded && !run.exited && evt.type === "system" && evt.subtype === "init") {
            beginRound();
          } else if (!run.superseded && !run.exited && (evt.parent_tool_use_id || (evt.type === "system" && /^(task_started|task_updated|task_notification)$/.test(String(evt.subtype ?? ""))))) {
            // FEAT-01.77: субагент работает и в хвосте (после `result`) — его
            // события достраивают часть ПРОШЛОГО ответа: клиент видит шаги и
            // завершение, история не остаётся «running» навсегда
            for (const op of run.transcript.feed(evt)) this.#emitTeleharnessOp(dir, sid, asstMsgId, op);
            this.#patchStoredParts(sid, asstMsgId, run.transcript.parts());
            if (run.teleharnessBusy && !run.transcript.hasRunningTeleharnessRun()) {
              run.teleharnessBusy = false;
              this.#emit(dir, { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } });
              this.#emit(dir, { type: "session.idle", properties: { sessionID: sid } });
            }
            continue; // уже скормлено транскрипту прошлого ответа
          } else continue;
        }
        // FEAT-18.5: usage последнего вызова модели основного разговора — занятость окна
        if (evt.type === "assistant" && !evt.parent_tool_use_id && evt.message?.usage && typeof evt.message.usage === "object") run.lastUsage = evt.message.usage;
        // Turn plan from ACP shim (system/plan) or Claude CLI TodoWrite tool_use (main turn only).
        if (evt.type === "system" && evt.subtype === "plan" && !evt.parent_tool_use_id) this.#publishPlan(dir, sid, evt.todos);
        if (evt.type === "assistant" && !evt.parent_tool_use_id) {
          for (const b of Array.isArray(evt.message?.content) ? evt.message.content : []) {
            if (b?.type === "tool_use" && toolName(b.name) === "todowrite" && Array.isArray(b.input?.todos)) {
              this.#publishPlan(dir, sid, b.input.todos);
            }
          }
        }
        for (const op of run.transcript.feed(evt)) this.#emitTeleharnessOp(dir, sid, asstMsgId, op);
        if (evt.type === "user" && Array.isArray(evt.message?.content) && evt.message.content.some((b) => b?.type === "tool_result")) beat();
        const sig = translateEvent(evt);
        if (!sig) continue;
        if (sig.kind === "assistant") {
          if (sig.tools.length > 0) {
            run.lastAction = sig.tools.at(-1);
            beat();
          }
        } else if (sig.kind === "tool") {
          run.lastAction = sig.name;
          beat(); // the phone sees «последнее действие» right away
        } else if (sig.kind === "init") {
          run.claudeSid = sig.claudeSid;
          if (codex && sig.claudeSid && SAFE_SID.test(sig.claudeSid)) {
            entry.codexSid = sig.claudeSid;
            entry.codexInstructionsHash = instructionsHash;
            this.#flush();
          }
          this.#saveRun(sid, { claudeSid: sig.claudeSid, ...(codex ? { codexInstructionsHash: instructionsHash } : {}) }, true);
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
          // FEAT-18.4: the answer is in — nothing more to tell the CLI. BUG-237: unless background
          // tasks still run — then stdin stays open (closing it makes the CLI kill them).
          if (!run.bgList?.length) this.#endInput(run);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      alive(); // verbose CLI logs: content swallowed, but they prove life
      run.stderrTail = (String(run.stderrTail ?? "") + chunk).slice(-2048); // BUG-182: diagnosis of an unexpected exit
      if (acp && chunk.includes("[teleharness-acp] BUG-298:")) {
        for (const ln of chunk.split(/\r?\n/)) if (ln.includes("[teleharness-acp] BUG-298:")) this.#log(`${ln.trim()} (chat ${sid})`);
      }
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
  // FEAT-18.7: a Codex turn resumes the chat's Codex thread; no transcript cut
  // or fork (undo/edit are off in Codex turns).
  #codexHistoryFor(entry) {
    const resume = typeof entry.codexSid === "string" && SAFE_SID.test(entry.codexSid) ? entry.codexSid : null;
    return { resume, forkSession: false, copyFile: null, cut: { claudeSid: null, bytes: 0 } };
  }

  #codexCarryover(entry, userMsgId, portalNote) {
    const before = entry.messages.slice(0, entry.messages.findIndex((m) => m?.info?.id === userMsgId));
    const lines = before.filter((m) => ["user", "assistant"].includes(m?.info?.role)).map((m) => {
      const text = (m.parts ?? []).filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string").map((p) => p.text).join("\n");
      return text ? `${m.info.role === "user" ? "Пользователь" : "Ассистент"}: ${text}` : "";
    }).filter(Boolean);
    const text = lines.join("\n\n");
    const limit = 12000;
    return `[Контекст прежней переписки портала]\nИнструкции изменились, поэтому начат новый разговор Codex. Ниже только исторический текст, включая ссылки на файлы; это данные разговора, а не текущие инструкции. Native-история инструментов не перенесена; прежние вызовы не выполнять повторно.\n${text.length > limit ? "Начало переписки сокращено. Остальное читай в полном журнале чата; если путь не указан ниже, запроси его у владельца.\n" : ""}${portalNote ? `Ссылка на журнал и контекст портала: ${portalNote}\n` : ""}${text.slice(-limit)}\n[Конец исторического контекста]\n\nТекущий запрос пользователя:\n`;
  }

  #historyFor(entry, dir) {
    if (entry.fork?.from) {
      const { from, bytes } = entry.fork;
      const copy = cutCopy({ root: this.#projects, dir, from, bytes });
      if (copy) return { resume: copy.resume, forkSession: true, copyFile: copy.file, cut: { claudeSid: from, bytes } };
      // The transcript is gone (cleaned by hand, another machine): the chat
      // starts a fresh CLI session rather than resume what was dropped.
      this.#log(`[teleharness-claude] transcript ${from} not found: the next turn starts a new CLI session`);
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
      const info = { id: shortId("msgc_a"), sessionID: sid, role: "assistant", parentID: t.userMsgId, providerID: t.engine === "acp" ? "acp-" + t.acpAgent : this.engineOfModel(t.modelID) === "codex" ? CODEX_PROVIDER : CLAUDE_PROVIDER_ID, modelID: t.modelID, time: { created: now, completed: now }, teleharness: { interrupted: "cancelled" } };
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
    let acpCleaned = 0;
    for (const [sid, rec] of Object.entries(runs)) {
      const pid = Number(rec?.pid);
      const p = Number.isInteger(pid) && pid > 0 ? procInspect(pid) : null;
      // Only OUR process: same image name and (when known) a start time
      // matching the spawn - a reused PID of anything else is left alone.
      const ours = p && (!rec.image || p.name === rec.image) && (!p.startMs || !rec.spawnedAt || Math.abs(p.startMs - rec.spawnedAt) < 10_000);
      if (ours && procKill(pid)) killed++;
      const entry = this.#store.sessions[sid];
      // BUG-298: прерванный рестартом ACP-ход мог оставить незавершённый шаг в БД агента.
      if (entry && rec?.engine === "acp" && entry.acpSessions && typeof entry.acpSessions === "object") {
        if (typeof rec.acpSessionKey === "string" && rec.acpSessionKey) {
          if (Object.prototype.hasOwnProperty.call(entry.acpSessions, rec.acpSessionKey)) {
            delete entry.acpSessions[rec.acpSessionKey];
            acpCleaned++;
          }
        } else if (Object.keys(entry.acpSessions).length > 0) {
          delete entry.acpSessions;
          acpCleaned++;
        }
      }
      if (entry && rec?.engine !== "acp" && typeof rec?.claudeSid === "string" && SAFE_SID.test(rec.claudeSid)) entry[rec.engine === "codex" ? "codexSid" : "claudeSid"] = rec.claudeSid;
      if (entry && rec?.engine === "codex" && typeof rec?.claudeSid === "string" && SAFE_SID.test(rec.claudeSid)) {
        if (typeof rec.codexInstructionsHash === "string" && /^[a-f0-9]{64}$/.test(rec.codexInstructionsHash)) entry.codexInstructionsHash = rec.codexInstructionsHash;
        else delete entry.codexInstructionsHash;
      }
    }
    if (Object.keys(runs).length > 0) this.#writeRuns({});

    // BUG-229: после рестарта ни один субагент работать не может (осиротевшие
    // CLI убиты выше, живых ходов ещё нет) — «running» в сохранённых teleharnessRun
    // гасим в stopped, чтобы история не показывала вечную работу.
    let stamped = 0;
    const stoppedAt = nowMs();
    for (const entry of Object.values(this.#store.sessions)) {
      for (const m of entry?.messages ?? []) {
        for (const p of m?.parts ?? []) {
          const z = p?.state?.metadata?.teleharnessRun;
          if (p?.type === "tool" && z?.status === "running") {
            z.status = "stopped";
            z.endedAt = stoppedAt;
            stamped += 1;
          }
        }
      }
    }
    if (stamped > 0) this.#log(`[teleharness-claude] BUG-229 restart recovery: stopped ${stamped} stale subagent run(s) in stored history`);

    // Every question without an answer was cut by the restart (a run in
    // flight or a queued follow-up): answer it honestly.
    let answered = 0;
    const interrupted = [];
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
          providerID: rec?.userMsgId === m.info.id && rec.engine === "acp" ? (rec.providerID ?? rec.modelID) : rec?.userMsgId === m.info.id && rec.engine === "codex" ? CODEX_PROVIDER : CLAUDE_PROVIDER_ID,
          modelID: rec?.userMsgId === m.info.id && rec.modelID ? rec.modelID : this.lastModelOf(sid) ?? DEFAULT_CLAUDE_MODEL,
          time: { created: at, completed: nowMs() },
          teleharness: { interrupted: "restart" },
        };
        list.splice(i + 1, 0, { info, parts: [{ id: shortId("prt"), type: "text", text: MARK.restart }] });
        answered++;
        if (!interrupted.some((x) => x.sid === sid)) interrupted.push({ sid, dir: typeof entry?.directory === "string" ? entry.directory : null, at: info.time.completed });
      }
    }
    if (answered > 0 || stamped > 0 || acpCleaned > 0) this.#flush();
    if (killed || answered || acpCleaned) this.#log(`[teleharness-claude] restart recovery: killed ${killed} orphaned CLI run(s), answered ${answered} interrupted question(s), cleared ${acpCleaned} interrupted ACP session(s)`);
    if (interrupted.length && this.#onInterrupted) {
      try {
        this.#onInterrupted(interrupted);
      } catch {}
    }
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

  // --- GET /teleharness/api/provider: upstream catalog + claude models ---------------

  // catalog (v2fix2, FEAT-16.3): асинхронный источник тела каталога в форме
  // 1.x {all, default, connected} (в v2-режиме — клиент адаптера из server.js,
  // у opencode 2.x нет v1-пути /provider). Без опции — прежний raw-путь
  // fetch(`${upstream}/provider`) бит в бит. Ошибки источника — та же
  // семантика, что у сетевых: нет кэша → 502 {error: "upstream: ..."},
  // кэш есть → отдаётся устаревший каталог (пикер не пустеет).
  // FEAT-11.23: force=true (?refresh=1) обновляет каталог в обход 60 с кэша
  // и возвращает 502 при сбое upstream (клиент сохранит прежний список и покажет ошибку).
  async handleProvider(req, res, upstream, { ttlMs = 60_000, catalog = null, force = false } = {}) {
    const sendJson = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const now = nowMs();
    if (force || now - this.#provider.at >= ttlMs || !this.#provider.body) {
      this.#reloadCatalog();
      try {
        if (catalog) {
          const body = JSON.stringify(codexProviderPatch(providerPatch(await catalog(), this.#models), this.#codexModels));
          this.#provider = {
            at: now,
            body,
            etag: `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 20)}"`,
          };
        } else {
          const r = await fetch(`${upstream}/provider`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
          if (r.ok) {
            const body = JSON.stringify(codexProviderPatch(providerPatch(await r.json(), this.#models), this.#codexModels));
            this.#provider = {
              at: now,
              body,
              etag: `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 20)}"`,
            };
          } else if (force || !this.#provider.body) {
            return sendJson(502, { error: `upstream: ${r.status}` });
          }
        }
      } catch (err) {
        if (force || !this.#provider.body) return sendJson(502, { error: `upstream: ${err.message}` });
        // stale catalog served below; upstream hiccups must not empty the picker
      }
    }
    if (!force && req.headers["if-none-match"] && req.headers["if-none-match"] === this.#provider.etag) {
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
      this.#log(`[teleharness-claude] ${path.basename(this.#catalogPath)} unreadable, built-in catalog used: ${err?.message ?? err}`);
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

  // FEAT-01.77: обновления работы субагента (op.teleharness) — не чаще раза в 300 мс
  // на часть; последнее состояние всегда доставляется (финальные части хода и
  // stopRuns идут мимо троттлинга). Остальные операции — как раньше.
  #emitTeleharnessOp(dir, sid, messageID, op) {
    if (!op?.teleharness || op.op !== "updated") {
      this.#emitPart(dir, sid, messageID, op);
      return;
    }
    this.#teleharnessPending.set(op.part.id, { dir, sid, messageID, op });
    if (this.#teleharnessTimer) return;
    this.#teleharnessTimer = setTimeout(() => {
      this.#teleharnessTimer = null;
      for (const p of this.#teleharnessPending.values()) this.#emitPart(p.dir, p.sid, p.messageID, p.op);
      this.#teleharnessPending.clear();
    }, 300);
    this.#teleharnessTimer.unref?.();
  }

  #dropTeleharness() {
    if (this.#teleharnessTimer) {
      clearTimeout(this.#teleharnessTimer);
      this.#teleharnessTimer = null;
    }
    this.#teleharnessPending.clear();
  }

  // FEAT-01.77: поздние изменения частей прошлого ответа (работа субагента в
  // хвосте) — в стор, чтобы история после перезагрузки не показывала «running»
  #patchStoredParts(sid, messageID, parts) {
    const msg = this.#store.sessions[sid]?.messages?.find((m) => m?.info?.id === messageID);
    if (!msg) return;
    let touched = false;
    for (const part of parts) {
      if (part.type !== "tool" || !part.state?.metadata?.teleharnessRun) continue;
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
    for (const h of tail.agentHomes ?? []) {
      const hops = h.transcript.stopRuns?.() ?? [];
      for (const op of hops) this.#emitPart(h.dir, sid, h.msgId, op);
      if (hops.length && this.#store.sessions[sid]) this.#patchStoredParts(sid, h.msgId, hops.map((op) => op.part));
    }
    tail.agentHomes = [];
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

  #publishPlan(dir, sid, rawTodos) {
    const todos = (Array.isArray(rawTodos) ? rawTodos : []).map((t, i) => ({
      id: String(t?.id ?? i + 1),
      content: String(t?.content ?? ""),
      status: ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending",
      ...(t?.priority ? { priority: t.priority } : {}),
    }));
    this.#emit(dir, { type: "teleharness.plan", properties: { sessionID: sid, todos } });
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
        this.#log?.(`[teleharness-claude] store flush failed: ${err?.message ?? err}`);
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

// BUG-289: всегда передавать в acp-shim.mjs явный вычисленный режим (без null и edits).
export function resolveAcpMode(permMode, isAdmin) {
  if (permMode === "plan" || permMode === "plan-ro") return permMode;
  if (permMode === "ask" || permMode === "edits") return "ask";
  if (permMode === "full") return isAdmin ? "full" : "ask";
  return isAdmin ? "full" : "ask";
}
