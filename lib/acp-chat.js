// FEAT-20.4 — JSON-RPC ACP v1. Вывод диагностики процесса не передаётся в чат.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { isLimitError } from "../shared/turn-error.js";


// BUG-298: нетерминальные статусы шагов Antigravity (exa.cortex_pb.CortexStepStatus):
// 1=PENDING, 2=RUNNING, 8=GENERATING, 9=WAITING, 11=QUEUED.
// Если после внезапного убийства agy_acp_server в SQLite-БД сессии осталась строка
// с таким статусом, localharness_external при следующем session/load + session/prompt
// никогда не выдаст TrajectoryStateUpdate.STATE_FULLY_IDLE и session/prompt зависнет.
export const ANTIGRAVITY_ACTIVE_STEP_STATUSES = Object.freeze([1, 2, 8, 9, 11]);
const SAFE_AGY_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AGY_STALE_STEPS_SQL = `SELECT 1 AS hit FROM steps WHERE status IN (${ANTIGRAVITY_ACTIVE_STEP_STATUSES.join(",")}) LIMIT 1`;

export function antigravitySessionHasStaleSteps(profileDir, sessionId) {
  if (typeof profileDir !== "string" || !profileDir) return false;
  if (typeof sessionId !== "string" || !SAFE_AGY_SESSION_RE.test(sessionId)) return false;
  const dbPath = path.join(profileDir, ".gemini", "antigravity-acp", "conversations", `${sessionId}.db`);
  if (!existsSync(dbPath)) return false;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return Boolean(db.prepare(AGY_STALE_STEPS_SQL).get());
  } catch {
    // Если файл БД повреждён или остался нечекпоинченный WAL после аварийного убийства —
    // безопаснее пропустить session/load и начать чистую сессию.
    try {
      const wal = statSync(`${dbPath}-wal`);
      if (wal.isFile() && wal.size > 0) return true;
    } catch {}
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

// BUG-293: классификация инструмента ACP. Обычные execute/read/edit/search никогда
// не считаются субагентом, даже если текст команды/заголовка содержит invoke_subagent.
const NON_SUBAGENT_KINDS = new Set([
  "execute", "bash", "shell", "read", "edit", "write", "delete", "move", "search", "grep", "glob", "fetch", "think",
]);
const SUBAGENT_TITLE_RE = /^(?:running\s+)?invoke_subagent(?:\s*\([^)]*\))?$/i;

// BUG-295: сохраняем текст JSON-RPC ошибки агента (в частности 429/quota), чтобы
// классификатор ошибок хода (shared/turn-error.js) и Auto-Relay корректно её распознали.
function acpRpcError(err) {
  const raw = typeof err?.message === "string" ? err.message.trim() : "";
  const data =
    typeof err?.data === "string"
      ? err.data.trim()
      : typeof err?.data?.message === "string"
        ? err.data.message.trim()
        : typeof err?.data?.details === "string"
          ? err.data.details.trim()
          : "";
  const detail = [raw, data]
    .filter((s, i, a) => s && a.indexOf(s) === i)
    .join(": ")
    .replace(/\s+/g, " ")
    .slice(0, 600);
  const text =
    err?.code === -32000 && (!detail || !isLimitError(detail, { engine: "acp" }))
      ? "Требуется вход в аккаунт агента"
      : detail
        ? `Агент ACP вернул ошибку: ${detail}`
        : "Агент отклонил запрос ACP";
  return Object.assign(new Error(text), { code: err?.code });
}


// FEAT-20.35: изоляция тенанта в ACP — запрет shell-инструментов и любых путей вне cwd чата.
const TENANT_DENY_KINDS = new Set(["execute", "bash", "shell", "terminal"]);
const PATH_KEYS = ["path", "file_path", "filePath", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "cwd", "Cwd", "destination", "source"];

function pathWithin(cwd, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return true;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, candidate);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function tenantAcpToolAllowed(tool, cwd) {
  const kind = String(tool?.kind ?? "").toLowerCase();
  if (TENANT_DENY_KINDS.has(kind)) return false;
  const raw = tool?.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput) ? tool.rawInput : {};
  if (typeof raw.command === "string" || typeof raw.CommandLine === "string" || typeof raw.command_line === "string") return false;
  if (!cwd) return true;
  for (const key of PATH_KEYS) {
    if (typeof raw[key] === "string" && !pathWithin(cwd, raw[key])) return false;
  }
  if (Array.isArray(raw.files)) {
    for (const f of raw.files) {
      const pVal = typeof f === "string" ? f : f?.path;
      if (typeof pVal === "string" && !pathWithin(cwd, pVal)) return false;
    }
  }
  return true;
}

export function normalizeAcpTool(update) {
  const raw = update?.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) ? { ...update.rawInput } : {};
  const title = typeof update?.title === "string" ? update.title.trim() : "";
  const kind = update?.kind ?? "tool";
  const hasSubagents = Array.isArray(raw.Subagents) && raw.Subagents.length > 0;
  const isSubagent = hasSubagents || (!NON_SUBAGENT_KINDS.has(String(kind).toLowerCase()) && SUBAGENT_TITLE_RE.test(title));
  if (isSubagent) {
    const first = hasSubagents ? raw.Subagents[0] ?? {} : {};
    const agentName = first.Role || first.TypeName || "subagent";
    const description = first.Prompt || title || "Фоновый субагент";
    return {
      isSubagent: true,
      name: "task",
      description,
      input: { subagent_type: agentName, description, run_in_background: true },
    };
  }
  const name = kind === "execute" ? "bash" : kind;
  const cmd = raw.command ?? raw.CommandLine ?? raw.command_line;
  if (typeof cmd === "string" && cmd.trim() && !raw.command) raw.command = cmd;
  if (title && !raw.description) raw.description = title;
  return {
    isSubagent: false,
    name,
    description: title,
    input: Object.keys(raw).length ? raw : { description: title },
  };
}

// FEAT-20.21: преобразование TELEHARNESS_CLAUDE_MCP_CONFIG ({ mcpServers: { name: cfg } })
// в массив ACP v1 McpServer[] (stdio / http / sse). Ошибки чтения не роняют ход.
function toNameValues(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj)
    .filter(([k, v]) => typeof k === "string" && k && v != null)
    .map(([name, value]) => ({ name, value: String(value) }));
}

export function loadAcpMcpServers(configPath) {
  if (typeof configPath !== "string" || !configPath.trim()) return [];
  let doc;
  try { doc = JSON.parse(readFileSync(configPath, "utf8")); } catch { return []; }
  const map = doc && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? doc.mcpServers : null;
  if (!map) return [];
  const out = [];
  for (const [name, cfg] of Object.entries(map)) {
    if (!name || !cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.disabled === true) continue;
    if ((cfg.type === "http" || cfg.type === "sse") && typeof cfg.url === "string" && cfg.url.trim()) {
      out.push({ name, type: cfg.type, url: cfg.url.trim(), headers: toNameValues(cfg.headers) });
    } else if (typeof cfg.command === "string" && cfg.command.trim()) {
      out.push({
        name,
        command: cfg.command.trim(),
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: toNameValues(cfg.env),
      });
    }
  }
  return out;
}
export async function runAcpChat(
  child,
  {
    cwd,
    resume,
    modelId,
    discoverModels = false,
    prompt,
    images = [],
    mcpServers = [],
    context = "",
    onText,
    onTool = () => {},
    onSession = () => {},
    onPermission = async () => false,
    signal,
  },
) {
  const pending = new Map();
  let sequence = 0;
  let sessionId = null;
  let closed = false;
  const send = (packet) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n");
  function fail(error) {
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  const disconnected = () => fail(new Error("Процесс ACP завершился"));
  child.once("error", disconnected);
  child.once("close", disconnected);
  child.stdin.on("error", disconnected);
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.jsonrpc !== "2.0") return;
    if (msg.method) {
      if (msg.id != null) {
        if (msg.method === "session/request_permission") {
          const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
          const once = options.find((option) => option.kind === "allow_once" && typeof option.optionId === "string") ?? options.find((option) => option.kind === "allow_always" && typeof option.optionId === "string");
          const permitted = Boolean(once && sessionId && msg.params.sessionId === sessionId);
          Promise.resolve(permitted && onPermission(msg.params.toolCall ?? {}))
            .then((allow) => {
              if (!closed)
                send({
                  id: msg.id,
                  result: {
                    outcome: allow && permitted ? { outcome: "selected", optionId: once.optionId } : { outcome: "cancelled" },
                  },
                });
            })
            .catch(() => {
              if (!closed) send({ id: msg.id, result: { outcome: { outcome: "cancelled" } } });
            });
        } else send({ id: msg.id, error: { code: -32601, message: "Unsupported method" } });
      } else if (msg.method === "session/update" && msg.params?.sessionId === sessionId) {
        const update = msg.params.update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") onText(update.content.text);
        else if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate) && typeof update.toolCallId === "string")
          onTool(update);
      }
      return;
    }
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    if (msg.error) request.reject(acpRpcError(msg.error));
    else request.resolve(msg.result);
  });
  function rpc(method, params) {
    if (closed) return Promise.reject(new Error("Соединение с ACP закрыто"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer =
        method === "session/prompt"
          ? null
          : setTimeout(() => {
              pending.delete(id);
              reject(new Error("Агент ACP не ответил на " + method));
            }, 30000);
      timer?.unref();
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  }
  const cancel = () => {
    if (sessionId && !closed) send({ method: "session/cancel", params: { sessionId } });
    fail(new Error("Ход остановлен"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error("Ход остановлен");
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (init?.protocolVersion !== 1) throw new Error("Несовместимая версия ACP");
    let loaded = false;
    if (resume && init.agentCapabilities?.loadSession) {
      try {
        await rpc("session/load", { sessionId: resume, cwd, mcpServers: discoverModels ? [] : (Array.isArray(mcpServers) ? mcpServers : []) });
        loaded = true;
        sessionId = resume;
      } catch (error) {
        if (error.code === -32000 || closed) throw error;
      }
    }
    if (!loaded) {
      const session = await rpc("session/new", { cwd, mcpServers: discoverModels ? [] : (Array.isArray(mcpServers) ? mcpServers : []) });
      if (discoverModels) return { ...(session?.models ?? {}), promptCapabilities: init.agentCapabilities?.promptCapabilities ?? {} };
      sessionId = session?.sessionId;
    }
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Агент не вернул идентификатор чата");
    if (modelId) await rpc("session/set_model", { sessionId, modelId });
    onSession(sessionId);
    const imageBlocks = init.agentCapabilities?.promptCapabilities?.image && Array.isArray(images)
      ? images
          .filter((img) => typeof img?.data === "string" && img.data && typeof img?.mimeType === "string" && img.mimeType.startsWith("image/"))
          .map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }))
      : [];
    const promptBlocks = [...imageBlocks, { type: "text", text: (loaded ? "" : context) + prompt }];
    const result = await rpc("session/prompt", { sessionId, prompt: promptBlocks });
    return { sessionId, loaded, stopReason: result?.stopReason };
  } finally {
    signal?.removeEventListener("abort", cancel);
    lines.close();
  }
}
