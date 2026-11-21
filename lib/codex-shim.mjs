// FEAT-18.7 (design «Варианты адаптера», вариант А): посредник между раннером
// портала (lib/claude.js ClaudeRunner) и `codex app-server`. Раннер запускает
// этот скрипт ВМЕСТО claude CLI (бинарь-скрипт: process.execPath + файл, как
// фейковые CLI тестов) с тем же argv и тем же stdin; посредник отвечает на
// stdout тем подмножеством stream-json claude CLI, которое читают раннер
// (translateEvent, claudeTurnUsage, #onControl) и транскрипт
// (lib/claude-transcript.js). Поэтому история, очередь, восстановление после
// рестарта, живость, диалоги разрешений, push и контекст работают для Codex без
// второй реализации раннера.
//
// Снизу — `codex app-server` (JSON-RPC 2.0, одна JSON-строка = сообщение,
// codex-cli 0.169.0, записи tests/fixtures/codex-appserver-*-0.169.0.jsonl):
//   initialize → initialized → account/read → thread/start | thread/resume |
//   thread/fork → turn/start {threadId, input:[{type:"text",text}]} →
//   уведомления item/* … → turn/completed.
//
// Подмножество claude stream-json, которое пишет посредник:
//   {"type":"system","subtype":"init","session_id":<threadId>,…}   первым
//   {"type":"stream_event","event":{message_start|content_block_start|
//     content_block_delta(text_delta|thinking_delta)|content_block_stop}}
//   {"type":"assistant","message":{id,content:[text|thinking|tool_use],usage}}
//   {"type":"user","message":{content:[tool_result]}}
//   {"type":"control_request","request_id","request":{subtype:"can_use_tool",…}}
//   {"type":"control_cancel_request","request_id"}
//   {"type":"system","subtype":"codex_activity"}  — признак жизни (раннер его
//     не разбирает, но считает выводом: длинная команда без вывода не «зависла»)
//   {"type":"result",subtype,is_error,result,session_id,usage,modelUsage}
// total_cost_usd не пишется: Codex идёт по подписке ChatGPT.
//
// Второй режим: `node codex-shim.mjs --teleharness-catalog` — без хода: вход и
// каталог моделей одной JSON-строкой (для lib/codex-catalog.js / проверки
// доступности движка).
//
// FEAT-18.8: флаг `--teleharness-oneshot` — разовый запрос «Предложить сообщение»
// (lib/oneshot.js): тред эфемерный (thread/start {ephemeral:true}, в истории
// Codex не остаётся), песочница read-only, approvalPolicy never (спросить
// некого), без --resume. Остальное — обычный ход: stdin → ответ, строка result.
//
// Ноль зависимостей: только stdlib (и ./proc.js портала — тоже stdlib).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { killChildTree } from "./proc.js";

export const CLIENT_INFO = { name: "teleharness-portal", title: "Teleharness", version: "1.0.0" };
export const CATALOG_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 30_000;
const ACTIVITY_EVERY_MS = 5_000;
const INTERRUPT_WAIT_MS = 3_000;
const CLOSE_WAIT_MS = 2_000;
export const LIMIT_INFOS = new Set(["usageLimitExceeded", "rateLimitExceeded"]);

// --- argv (подмножество claude CLI, которое передаёт раннер: #args/permissionArgs) ---

// Флаги claude со значением: значение пропускается вместе с флагом, даже если
// посредник его не использует (иначе путь/JSON попал бы в «неизвестные»).
const VALUE_FLAGS = new Set([
  "--input-format", "--output-format", "--model", "--settings", "--resume", "--append-system-prompt-file",
  "--add-dir", "--permission-mode", "--permission-prompts", "--permission-prompt-tool", "--mcp-config",
  "--agents", "--agent", "--system-prompt-snapshot", "--tools", "--allowedTools", "--disallowedTools", "--plugin-dir", "--teleharness-instructions-hash", "--teleharness-writable-root",
]);
const BOOL_FLAGS = new Set(["-p", "--print", "--verbose", "--include-partial-messages", "--fork-session", "--restricted", "--strict-mcp-config", "--teleharness-oneshot"]);

// Разбор argv. Чистая. unknown — то, что посредник не знает (пишется в stderr,
// ход не падает: новая версия раннера может добавить флаг раньше посредника).
export function parseArgs(argv = []) {
  const o = { inputFormat: "text", outputFormat: "stream-json", model: null, resume: null, fork: false, promptFile: null, addDirs: [], permissionMode: null, permissionPrompts: null, permissionPromptTool: null, restricted: false, catalog: false, oneshot: false, ignored: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--teleharness-catalog") o.catalog = true;
    else if (BOOL_FLAGS.has(a)) {
      if (a === "--fork-session") o.fork = true;
      else if (a === "--restricted") o.restricted = true;
      else if (a === "--teleharness-oneshot") o.oneshot = true;
      else if (a === "--strict-mcp-config") o.ignored.push(a);
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      i++;
      if (typeof v !== "string") {
        o.unknown.push(a);
        continue;
      }
      if (a === "--input-format") o.inputFormat = v;
      else if (a === "--output-format") o.outputFormat = v;
      else if (a === "--model") o.model = v;
      else if (a === "--resume") o.resume = v;
      else if (a === "--append-system-prompt-file") o.promptFile = v;
      else if (a === "--agents") o.agentsFile = v;
      else if (a === "--agent") o.agent = v;
      else if (a === "--teleharness-instructions-hash") o.instructionsHash = v;
      else if (a === "--add-dir") o.addDirs.push(v);
      // FEAT-20.7: общий .git рабочей копии — запись разрешена (иначе git commit в копии падает в workspace-write)
      else if (a === "--teleharness-writable-root") o.writableRoots = [...(o.writableRoots ?? []), v];
      else if (a === "--permission-mode") o.permissionMode = v;
      else if (a === "--permission-prompts") o.permissionPrompts = v;
      else if (a === "--permission-prompt-tool") o.permissionPromptTool = v;
      else o.ignored.push(a);
    } else o.unknown.push(a);
  }
  return o;
}

// Режим прав портала → политика Codex (design «Решения»). Выводится ровно из
// того, что permissionArgs() (lib/claude.js) пишет для каждого режима:
//   ask (ASK_ARGS: --permission-prompts host / --permission-prompt-tool stdio)
//       → untrusted + workspace-write (каждая не «доверенная» команда — вопрос)
//   tenant (--restricted), не ask → on-request + workspace-write
//   --permission-mode acceptEdits / default / dontAsk → on-request + workspace-write
//   --permission-mode plan → never + read-only (BUG-270: read-only песочница запрещает запись, а чтение не отклоняется без моста)
//   --permission-mode bypassPermissions (admin «Без вопросов») → never + danger-full-access
//   без флагов (роль не передана) → on-request + workspace-write
// Тенант НИКОГДА не получает danger-full-access, что бы ни пришло в argv.
// Вне stream-json спросить некого: запросы on-request получают decline.
export function codexPolicy(o) {
  // FEAT-18.8: разовый запрос — только чтение и без вопросов, что бы ни пришло ещё
  if (o.oneshot) return { mode: "plan", approvalPolicy: "never", sandbox: "read-only", tenant: Boolean(o.restricted), canAsk: false };
  const ask = o.permissionPromptTool === "stdio" || o.permissionPrompts === "host";
  let mode;
  let approvalPolicy;
  let sandbox;
  if (ask) [mode, approvalPolicy, sandbox] = ["ask", "untrusted", "workspace-write"];
  else if (o.restricted) [mode, approvalPolicy, sandbox] = ["edits", "on-request", "workspace-write"];
  else if (o.permissionMode === "bypassPermissions") [mode, approvalPolicy, sandbox] = ["full", "never", "danger-full-access"];
  else if (o.permissionMode === "plan") [mode, approvalPolicy, sandbox] = ["plan", "never", "read-only"];
  else [mode, approvalPolicy, sandbox] = ["edits", "on-request", "workspace-write"];
  if (o.restricted && sandbox === "danger-full-access") [approvalPolicy, sandbox] = ["on-request", "workspace-write"];
  return { mode, approvalPolicy, sandbox, tenant: Boolean(o.restricted), canAsk: o.inputFormat === "stream-json" };
}

// Catalog profiles supply instructions only. Claude tools restrictions cannot
// be enforced by app-server, so reject them rather than widening access.
export function renderDeveloperInstructions(o, pol, read = (f) => readFileSync(f, "utf8")) {
  let profile = "";
  if (o.agent || o.agentsFile) {
    if (!o.agent || !o.agentsFile || !/^[a-z][a-z0-9-]{0,31}$/.test(o.agent)) throw new Error("Codex profile: invalid selection");
    let rec;
    try {
      const catalog = JSON.parse(read(o.agentsFile));
      rec = Object.hasOwn(catalog ?? {}, o.agent) ? catalog[o.agent] : null;
    } catch { throw new Error("Codex profile: compiled catalog is unreadable or malformed"); }
    if (!isObj(rec) || typeof rec.prompt !== "string" || !rec.prompt.trim()) throw new Error("Codex profile: selected prompt is missing or malformed");
    if (Object.hasOwn(rec, "tools")) throw new Error("Codex profile: tools restrictions are unsupported; profile refused");
    // The shipped Workflow has two Claude-runtime bullets. Replace those
    // assertions with the real runtime, without changing its workflow rules.
    profile = rec.prompt.split(/\r?\n/).filter((line) => !/^- (?:Тебя запускает портал Teleharness:|Права хода широкие \(без запросов разрешений\))/.test(line)).join("\n");
    profile = `Portal role: ${o.agent}\n${profile}\n\nCodex execution context (takes precedence over runtime or permission claims in the role):\nThis turn runs through Codex app-server. The selected portal role is an instruction profile, not a native Claude agent or tools API. Model: ${o.model ?? "app-server default"}. Approval policy: ${pol.approvalPolicy}. Sandbox: ${pol.sandbox}. Use only tools and permissions actually available in this turn. Permission questions use the portal approval bridge when available; owner questions belong in the response.\n`;
  }
  // The runner fingerprints this exact effective text and refreshes the
  // native thread when it changes; resume alone cannot update its baseline.
  const portal = o.promptFile ? read(o.promptFile) : "";
  return [profile, portal].filter(Boolean).join("\n\n");
}

// --- бинарь codex -----------------------------------------------------------

const TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const isScriptPath = (p) => /\.(c?js|mjs)$/i.test(p);

// Как запустить codex: {cmd, args, env} или null (не установлен). Без
// shell:true — ни один аргумент не проходит через оболочку.
//   TELEHARNESS_CODEX_BIN: JS-файл → node + файл; иначе исполняемый файл как есть.
//   Иначе глобальный @openai/codex: сразу НАТИВНЫЙ codex(.exe) из пакета
//   платформы (как это делает его bin/codex.js) — на Windows обёртка-node
//   держала бы дочерний codex.exe, и kill обёртки оставлял бы его сиротой;
//   запасной вариант — bin/codex.js пакета через node; затем codex(.exe) в PATH.
export function codexCommand(env = process.env, { platform = process.platform, arch = process.arch, execPath = process.execPath, exists = existsSync, read = (f) => readFileSync(f, "utf8") } = {}) {
  const pick = (k) => {
    const hit = Object.keys(env ?? {}).find((x) => (platform === "win32" ? x.toUpperCase() === k : x === k));
    const v = hit ? env[hit] : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const p = platform === "win32" ? path.win32 : path.posix;
  const forced = pick("TELEHARNESS_CODEX_BIN");
  if (forced) {
    if (!exists(forced)) return null;
    return isScriptPath(forced) ? { cmd: execPath, args: [forced], env: {} } : { cmd: forced, args: [], env: {} };
  }
  const exe = platform === "win32" ? "codex.exe" : "codex";
  const triple = TRIPLES[`${platform}-${arch}`] ?? null;
  const platPkg = `codex-${platform}-${arch}`;
  const nodeDir = p.dirname(execPath);
  const prefixes = [pick("npm_config_prefix"), pick("NPM_CONFIG_PREFIX")].filter(Boolean);
  const roots = [];
  for (const pre of prefixes) roots.push(p.join(pre, "node_modules"), p.join(pre, "lib", "node_modules"));
  if (platform === "win32") {
    roots.push(p.join(nodeDir, "node_modules"));
    const appData = pick("APPDATA");
    if (appData) roots.push(p.join(appData, "npm", "node_modules"));
  } else {
    roots.push(p.join(nodeDir, "..", "lib", "node_modules"));
    const home = pick("HOME");
    if (home) roots.push(p.join(home, ".npm-global", "lib", "node_modules"));
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  }
  for (const root of roots) {
    const pkg = p.join(root, "@openai", "codex");
    if (!exists(p.join(pkg, "package.json"))) continue;
    const managed = { CODEX_MANAGED_PACKAGE_ROOT: pkg, CODEX_MANAGED_BY_NPM: "1" };
    if (triple) {
      for (const vendor of [p.join(pkg, "node_modules", "@openai", platPkg, "vendor"), p.join(root, "@openai", platPkg, "vendor"), p.join(pkg, "vendor")]) {
        const bin = p.join(vendor, triple, "bin", exe);
        if (exists(bin)) return { cmd: bin, args: [], env: managed };
      }
    }
    let rel = "bin/codex.js";
    try {
      const j = JSON.parse(read(p.join(pkg, "package.json")));
      rel = typeof j.bin === "string" ? j.bin : (j.bin?.codex ?? rel);
    } catch {}
    const js = p.join(pkg, rel);
    if (exists(js)) return { cmd: execPath, args: [js], env: {} };
  }
  const PATH = pick("PATH") ?? "";
  for (const dir of PATH.split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const f = p.join(dir, exe);
    if (exists(f)) return { cmd: f, args: [], env: {} };
  }
  return null;
}

// --- перевод Codex → claude (чистые помощники) ------------------------------

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// TokenUsageBreakdown Codex → usage claude. У Codex inputTokens ВКЛЮЧАЕТ
// кэшированные (запись 0.169.0: input 15607, cached 12288), у claude
// input_tokens — без кэша; сумма input+cache_read+cache_creation (так
// claudeTurnUsage считает занятость окна) = inputTokens Codex.
export function claudeUsage(b) {
  if (!isObj(b)) return null;
  const cached = num(b.cachedInputTokens);
  const write = num(b.cacheWriteInputTokens);
  return { input_tokens: Math.max(0, num(b.inputTokens) - cached - write), output_tokens: num(b.outputTokens), cache_read_input_tokens: cached, cache_creation_input_tokens: write };
}

// FEAT-20.6: прирост хода Codex → запись modelUsage claude (inputTokens без кэша, как у Anthropic).
export function codexTurnModelUsage(b) {
  const u = claudeUsage(b) ?? {};
  return { inputTokens: num(u.input_tokens), outputTokens: num(b?.outputTokens), cacheReadInputTokens: num(u.cache_read_input_tokens), cacheCreationInputTokens: num(u.cache_creation_input_tokens), reasoningOutputTokens: num(b?.reasoningOutputTokens) };
}

const sumUsage = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = num(out[k]) + num(v);
  return out;
};
const diffBreakdown = (cur, prev) => {
  const out = {};
  for (const k of ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) out[k] = Math.max(0, num(cur?.[k]) - num(prev?.[k]));
  return out;
};

// Показ команды: app-server на Windows оборачивает её в
// `"…powershell.exe" -Command "…"`; commandActions несёт саму команду.
export function commandText(item) {
  const acts = Array.isArray(item?.commandActions) ? item.commandActions : [];
  if (acts.length === 1 && typeof acts[0]?.command === "string" && acts[0].command.trim()) return acts[0].command;
  if (Array.isArray(item?.command)) return item.command.join(" ");
  return typeof item?.command === "string" ? item.command : "";
}

// Элемент Codex → вызов инструмента claude {name, input} или null (не шаг).
// Имена — те, что лента уже умеет (TOOL_NAMES транскрипта).
export function toolOf(item) {
  if (!isObj(item)) return null;
  switch (item.type) {
    case "commandExecution":
      return { name: "Bash", input: { command: commandText(item) } };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
      const allAdd = changes.length > 0 && changes.every((c) => c.kind?.type === "add");
      const first = changes[0] ?? {};
      const input = { file_path: typeof first.path === "string" ? first.path : "" };
      if (allAdd && changes.length === 1) input.content = String(first.diff ?? "");
      else if (changes.length === 1) input.diff = String(first.diff ?? "");
      if (changes.length > 1) input.files = changes.map((c) => `${c.kind?.type ?? "update"} ${c.path}`);
      return { name: allAdd ? "Write" : "Edit", input };
    }
    case "webSearch":
      return { name: "WebSearch", input: { query: typeof item.query === "string" ? item.query : "" } };
    case "mcpToolCall":
      return { name: `mcp__${item.server ?? "mcp"}__${item.tool ?? "tool"}`, input: isObj(item.arguments) ? item.arguments : { arguments: item.arguments ?? null } };
    case "dynamicToolCall":
      return { name: String(item.tool ?? "tool"), input: isObj(item.arguments) ? item.arguments : { arguments: item.arguments ?? null } };
    case "imageView":
      return { name: "Read", input: { file_path: String(item.path ?? "") } };
    default:
      return null;
  }
}

// Итог завершённого элемента → tool_result {content, is_error}.
export function toolResultOf(item) {
  const st = item?.status;
  if (item?.type === "commandExecution") {
    const out = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    if (st === "declined") return { content: out || "Команда отклонена (нет разрешения)", is_error: true };
    const code = Number.isInteger(item.exitCode) ? item.exitCode : null;
    const tail = code != null && code !== 0 ? `\n[exit code ${code}]` : "";
    const text = (out + tail).trim() || (code != null ? `[exit code ${code}]` : st === "failed" ? "Команда не выполнена" : "");
    return { content: text, is_error: st === "failed" || (code != null && code !== 0) };
  }
  if (item?.type === "fileChange") {
    const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => c?.path).filter(Boolean).join(", ");
    if (st === "declined") return { content: `Правка отклонена (нет разрешения): ${paths}`, is_error: true };
    if (st === "failed") return { content: `Правка не применена: ${paths}`, is_error: true };
    return { content: `Изменено: ${paths}`, is_error: false };
  }
  if (item?.type === "webSearch") return { content: Array.isArray(item.results) ? JSON.stringify(item.results).slice(0, 4000) : String(item.query ?? ""), is_error: false };
  if (item?.type === "mcpToolCall") {
    if (item.error) return { content: typeof item.error?.message === "string" ? item.error.message : JSON.stringify(item.error), is_error: true };
    const blocks = Array.isArray(item.result?.content) ? item.result.content : [];
    return { content: blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") || JSON.stringify(item.result ?? null), is_error: st === "failed" };
  }
  if (item?.type === "dynamicToolCall") {
    const blocks = Array.isArray(item.contentItems) ? item.contentItems : [];
    return { content: blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n"), is_error: item.success === false || st === "failed" };
  }
  return { content: st === "failed" ? "Ошибка" : "", is_error: st === "failed" };
}

// Текст ошибки хода. Лимит подписки (codexErrorInfo или rateLimitReachedType)
// — с фразой «usage limit», чтобы shared/turn-error.js дал kind "limit"
// (плашка, авто-Relay FEAT-18.6).
export function errorText(err, { rateLimited = false } = {}) {
  const msg = typeof err?.message === "string" && err.message.trim() ? err.message.trim() : "ход Codex завершился ошибкой";
  const info = err?.codexErrorInfo;
  const code = typeof info === "string" ? info : isObj(info) ? Object.keys(info)[0] : null;
  if (rateLimited || (code && LIMIT_INFOS.has(code))) return `Codex usage limit reached: ${msg}`;
  if (code === "unauthorized") return `Codex: authentication failed (codex login): ${msg}`;
  const details = typeof err?.additionalDetails === "string" && err.additionalDetails.trim() ? ` (${err.additionalDetails.trim()})` : "";
  return `Codex: ${msg}${details}`;
}

// --- JSON-RPC клиент app-server ---------------------------------------------

class AppServer {
  #child;
  #seq = 0;
  #pending = new Map();
  #buf = "";
  #onNotify;
  #onRequest;
  #onExit;
  exited = false;
  constructor(cmd, { cwd, onNotify, onRequest, onExit, onStderr }) {
    this.#onNotify = onNotify;
    this.#onRequest = onRequest;
    this.#onExit = onExit;
    try {
      this.#child = spawn(cmd.cmd, [...cmd.args, "app-server"], { cwd, env: { ...process.env, ...(cmd.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      // spawn бросает синхронно на части ошибок (EINVAL на Windows) — как 'error'
      this.exited = true;
      this.spawnError = err;
      setImmediate(() => onExit?.(null, null, err));
      return;
    }
    this.#child.stdin.on("error", () => {});
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (c) => this.#data(c));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (c) => onStderr?.(c));
    this.#child.on("error", (err) => this.#fail(err));
    this.#child.on("close", (code, signal) => {
      this.exited = true;
      this.#fail(new Error(`codex app-server завершился (${signal ? `signal ${signal}` : `code ${code}`})`));
      this.#onExit?.(code, signal);
    });
  }
  #fail(err) {
    for (const w of this.#pending.values()) w.reject(err);
    this.#pending.clear();
    if (err && !this.exited && err.code) this.#onExit?.(null, null, err);
  }
  #data(chunk) {
    this.#buf += chunk;
    let nl;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(m)) continue;
      if (typeof m.method === "string" && m.id !== undefined && m.id !== null) this.#onRequest?.(m);
      else if (typeof m.method === "string") this.#onNotify?.(m);
      else if (m.id !== undefined && this.#pending.has(m.id)) {
        const w = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.error) {
          const e = new Error(typeof m.error.message === "string" ? m.error.message : "JSON-RPC error");
          e.rpc = m.error;
          w.reject(e);
        } else w.resolve(m.result ?? null);
      }
    }
  }
  #write(obj) {
    const s = this.#child?.stdin;
    if (!s || s.destroyed || s.writableEnded) return false;
    try {
      s.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }
  request(method, params, timeoutMs = 0) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.#pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`codex app-server не ответил на ${method} за ${Math.round(timeoutMs / 1000)} с`));
        }, timeoutMs);
      }
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(this.spawnError ?? new Error("codex app-server недоступен (stdin закрыт)"));
      }
    });
  }
  notify(method, params) {
    return this.#write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }
  respond(id, result) {
    return this.#write({ jsonrpc: "2.0", id, result });
  }
  respondError(id, code, message) {
    return this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }
  // Мягко: EOF на stdin (app-server дописывает сессию и выходит), затем дерево.
  async close(waitMs = CLOSE_WAIT_MS) {
    if (this.exited || !this.#child) return;
    try {
      this.#child.stdin.end();
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(r, waitMs);
      this.#child.once("close", () => {
        clearTimeout(t);
        r();
      });
    });
    if (!this.exited) killChildTree(this.#child);
  }
  kill() {
    if (!this.exited && this.#child) killChildTree(this.#child);
  }
}

// --- вывод ------------------------------------------------------------------

const out = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {}
};
const flushStdout = () => new Promise((r) => process.stdout.write("", () => r()));
const log = (msg) => {
  try {
    process.stderr.write(`[codex-shim] ${msg}\n`);
  } catch {}
};
const errMsg = (e) => String(e?.message ?? e ?? "ошибка");

async function finishProcess(code) {
  await flushStdout();
  process.exit(code);
}

// --- режим каталога (--teleharness-catalog) ----------------------------------------

export async function runCatalog({ env = process.env, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const cmd = codexCommand(env);
  if (!cmd) return { ok: false, error: "codex CLI не найден (npm i -g @openai/codex или TELEHARNESS_CODEX_BIN)" };
  let srv = null;
  const work = (async () => {
    srv = new AppServer(cmd, { cwd: process.cwd() });
    await srv.request("initialize", { clientInfo: CLIENT_INFO });
    srv.notify("initialized");
    const acc = await srv.request("account/read", { refreshToken: false });
    const account = isObj(acc?.account) ? acc.account : null;
    const models = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const r = await srv.request("model/list", cursor ? { cursor } : {});
      for (const m of Array.isArray(r?.data) ? r.data : []) {
        if (!isObj(m) || typeof m.id !== "string") continue;
        models.push({ id: m.id, model: m.model ?? m.id, displayName: m.displayName ?? m.id, hidden: m.hidden === true, isDefault: m.isDefault === true, inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : ["text"], defaultReasoningEffort: m.defaultReasoningEffort ?? null });
      }
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
      if (!cursor) break;
    }
    return { ok: true, loggedIn: Boolean(account), accountType: account?.type ?? null, plan: account?.planType ?? null, models };
  })();
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve({ ok: false, error: `таймаут ${Math.round(timeoutMs / 1000)} с` }), timeoutMs)));
  let res;
  try {
    res = await Promise.race([work, timeout]);
  } catch (e) {
    res = { ok: false, error: errMsg(e).slice(0, 300) };
  }
  clearTimeout(timer);
  if (srv) await srv.close(500);
  return res;
}

// FEAT-20.7: ход в рабочей копии git — каталог общего .git добавляется в
// writableRoots песочницы workspace-write (спайк 0.3: turn/start принимает
// sandboxPolicy {type:"workspaceWrite", writableRoots}); иначе политика треда.
export function turnSandbox(o, pol) {
  const roots = (o?.writableRoots ?? []).filter((d) => typeof d === "string" && path.isAbsolute(d));
  if (!roots.length || pol?.sandbox !== "workspace-write") return {};
  return { sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: false } };
}

// --- ход --------------------------------------------------------------------

export async function runTurn(argv, { env = process.env, stdin = process.stdin } = {}) {
  const o = parseArgs(argv);
  if (o.unknown.length) log(`неизвестные аргументы проигнорированы: ${o.unknown.join(" ")}`);
  if (o.addDirs.length) log(`--add-dir не передаётся Codex (песочница workspace-write = только cwd): ${o.addDirs.join(" ")}`);
  const pol = codexPolicy(o);
  const cwd = process.cwd();
  const started = Date.now();

  let sid = null; // threadId
  let model = o.model;
  let turnId = null;
  let srv = null;
  let ended = false;
  let resultWritten = false;
  let lastActivity = 0;
  let rateLimited = false;
  let lastError = null; // уведомление error без повтора
  let contextWindow = null;
  let turnUsage = {};
  let prevTotal = null;
  let lastUsage = null;
  let finalText = "";
  let lastText = "";
  // шаги: сообщение claude = вызов модели; новое — после результата инструмента
  let msgSeq = 0;
  let curMsg = null;
  let lastMsg = null;
  let blockIdx = 0;
  const openBlocks = new Map(); // itemId → {index, kind, text}
  const tools = new Map(); // itemId → {name, input}
  const asks = new Map(); // request_id → {rpcId, kind, input}
  const rpcToAsk = new Map(); // JSON-RPC id сервера → request_id
  let askSeq = 0;

  const ev = (event) => out({ type: "stream_event", event, session_id: sid, parent_tool_use_id: null });
  const ensureMsg = () => {
    if (curMsg) return curMsg;
    curMsg = `msg_codex_${++msgSeq}`;
    lastMsg = curMsg;
    blockIdx = 0;
    ev({ type: "message_start", message: { id: curMsg, type: "message", role: "assistant", model, content: [], usage: {} } });
    return curMsg;
  };
  const assistant = (content, msgId = ensureMsg()) => out({ type: "assistant", message: { id: msgId, type: "message", role: "assistant", model, content, ...(lastUsage ? { usage: lastUsage } : {}) }, session_id: sid, parent_tool_use_id: null });
  const activity = () => {
    if (!sid) return; // до init — только init первым (контракт claude CLI)
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_EVERY_MS) return;
    lastActivity = now;
    out({ type: "system", subtype: "codex_activity", session_id: sid });
  };

  const writeResult = ({ isError, text }) => {
    if (resultWritten) return;
    resultWritten = true;
    const res = { type: "result", subtype: isError ? "error_during_execution" : "success", is_error: Boolean(isError), duration_ms: Date.now() - started, num_turns: 1, result: text ?? "", session_id: sid };
    if (Object.keys(turnUsage).length) res.usage = claudeUsage(turnUsage);
    if (contextWindow) res.modelUsage = { [model ?? "codex"]: { contextWindow, inputTokens: num(turnUsage.inputTokens), outputTokens: num(turnUsage.outputTokens), cacheReadInputTokens: num(turnUsage.cachedInputTokens) } };
    // FEAT-20.6: прирост хода для журнала расхода — форма Claude CLI: вход без кэша, кэш, выход
    // (reasoning внутри него) и reasoning отдельно для показа; цены Codex не сообщает.
    if (Object.keys(turnUsage).length) res.model_usage_since_last_result = { [model ?? "codex"]: codexTurnModelUsage(turnUsage) };
    out(res);
  };

  const finish = async (code) => {
    if (ended) return;
    ended = true;
    for (const id of asks.keys()) out({ type: "control_cancel_request", request_id: id });
    asks.clear();
    if (srv) await srv.close();
    await finishProcess(code);
  };
  const fail = async (text) => {
    writeResult({ isError: true, text });
    await finish(1);
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    try {
      process.on(sig, () => {
        srv?.kill();
        process.exit(1);
      });
    } catch {}
  }

  // --- stdin: промпт и ответы раннера ---
  let resolvePrompt;
  const promptP = new Promise((r) => (resolvePrompt = r));
  const streamIn = o.inputFormat === "stream-json";
  let stdinClosed = false;
  const onStdinClose = async () => {
    stdinClosed = true;
    if (!streamIn) return;
    resolvePrompt(null);
    if (resultWritten || ended) return;
    // «Стоп» раннера (его #endInput) до конца хода: прервать ход Codex и выйти;
    // result не пишем — ход помечает сам раннер (abortedBy).
    for (const a of asks.values()) srv?.respond(a.rpcId, a.denyResult);
    asks.clear();
    if (srv && sid && turnId) {
      try {
        await Promise.race([srv.request("turn/interrupt", { threadId: sid, turnId }), new Promise((r) => setTimeout(r, INTERRUPT_WAIT_MS))]);
      } catch {}
    }
    await finish(1);
  };
  {
    let buf = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (c) => {
      buf += c;
      if (!streamIn) return;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onInputLine(line);
      }
    });
    stdin.on("end", () => {
      if (!streamIn) resolvePrompt(buf);
      else if (buf.trim()) onInputLine(buf.trim());
      onStdinClose();
    });
    stdin.on("error", () => onStdinClose());
  }
  function onInputLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m?.type === "user") {
      const c = m.message?.content;
      resolvePrompt(typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("") : "");
    } else if (m?.type === "control_response") {
      const r = m.response ?? {};
      const a = asks.get(r.request_id);
      if (!a) return;
      asks.delete(r.request_id);
      rpcToAsk.delete(a.rpcId);
      const allow = r.subtype === "success" && r.response?.behavior === "allow";
      srv?.respond(a.rpcId, allow ? a.allowResult : a.denyResult);
    }
  }

  // --- запросы сервера (разрешения) ---
  const onRequest = (m) => {
    const p = isObj(m.params) ? m.params : {};
    const ask = (toolName, input, description, toolUseId, allowResult, denyResult) => {
      if (!pol.canAsk || stdinClosed) {
        srv.respond(m.id, denyResult);
        return;
      }
      const id = `codex_ask_${++askSeq}`;
      asks.set(id, { rpcId: m.id, allowResult, denyResult });
      rpcToAsk.set(m.id, id);
      out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: toolName, input, description: description ?? undefined, permission_suggestions: [], tool_use_id: toolUseId ?? id } });
    };
    const known = tools.get(p.itemId);
    switch (m.method) {
      case "item/commandExecution/requestApproval": {
        const input = known?.input ?? { command: commandText(p) };
        return ask("Bash", input, p.reason ?? null, p.itemId, { decision: "accept" }, { decision: "decline" });
      }
      case "item/fileChange/requestApproval": {
        const input = known?.input ?? { file_path: p.grantRoot ?? "" };
        return ask(known?.name ?? "Edit", input, p.reason ?? null, p.itemId, { decision: "accept" }, { decision: "decline" });
      }
      case "item/permissions/requestApproval":
        return ask("Permissions", { reason: p.reason ?? null, permissions: p.permissions ?? null, cwd: p.cwd ?? null }, p.reason ?? "Codex просит дополнительные права", p.itemId, { permissions: isObj(p.permissions) ? p.permissions : {}, scope: "turn" }, { permissions: {} });
      case "execCommandApproval":
        return ask("Bash", { command: Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? "") }, p.reason ?? null, p.callId, { decision: "approved" }, { decision: "denied" });
      case "applyPatchApproval": {
        const files = Object.keys(isObj(p.fileChanges) ? p.fileChanges : {});
        return ask("Edit", { file_path: files[0] ?? "", ...(files.length > 1 ? { files } : {}) }, p.reason ?? null, p.callId, { decision: "approved" }, { decision: "denied" });
      }
      case "mcpServer/elicitation/request":
        // формы MCP посредник не показывает — отказ, ход идёт дальше
        return srv.respond(m.id, { action: "decline" });
      default:
        // requestUserInput, item/tool/call, auth refresh, attestation … — не
        // поддержано: ошибка JSON-RPC, сервер никогда не ждёт вечно
        log(`запрос сервера не поддержан: ${m.method}`);
        return srv.respondError(m.id, -32601, `not supported by teleharness codex-shim: ${m.method}`);
    }
  };

  // --- уведомления ---
  let turnDone;
  const turnDoneP = new Promise((r) => (turnDone = r));
  const ours = (p) => !sid || !p?.threadId || p.threadId === sid;
  const closeBlock = (itemId) => {
    const b = openBlocks.get(itemId);
    if (!b) return null;
    openBlocks.delete(itemId);
    ev({ type: "content_block_stop", index: b.index });
    return b;
  };
  const openBlock = (itemId, kind) => {
    let b = openBlocks.get(itemId);
    if (b) return b;
    ensureMsg();
    b = { index: blockIdx++, kind, text: "" };
    openBlocks.set(itemId, b);
    ev({ type: "content_block_start", index: b.index, content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" } });
    return b;
  };
  const toolStart = (item) => {
    const t = toolOf(item);
    if (!t) return;
    const prev = tools.get(item.id);
    if (prev && JSON.stringify(prev.input) === JSON.stringify(t.input)) return;
    const msg = prev?.msg ?? ensureMsg();
    if (!prev) {
      ev({ type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: item.id, name: t.name, input: {} } });
      ev({ type: "content_block_stop", index: blockIdx++ });
    }
    tools.set(item.id, { ...t, msg, done: false });
    assistant([{ type: "tool_use", id: item.id, name: t.name, input: t.input }], msg);
  };
  const onNotify = (m) => {
    const p = isObj(m.params) ? m.params : {};
    switch (m.method) {
      case "turn/started":
        if (ours(p) && !turnId && typeof p.turn?.id === "string") turnId = p.turn.id;
        return activity();
      case "item/started": {
        if (!ours(p)) return activity();
        const item = p.item ?? {};
        if (item.type === "agentMessage") openBlock(item.id, "text");
        else toolStart(item);
        return;
      }
      case "item/agentMessage/delta": {
        if (!ours(p) || typeof p.delta !== "string" || !p.delta) return;
        const b = openBlock(p.itemId, "text");
        b.text += p.delta;
        ev({ type: "content_block_delta", index: b.index, delta: { type: "text_delta", text: p.delta } });
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        if (!ours(p)) return;
        const b = openBlocks.get(p.itemId);
        if (b && b.text) {
          b.text += "\n\n";
          ev({ type: "content_block_delta", index: b.index, delta: { type: "thinking_delta", thinking: "\n\n" } });
        }
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        if (!ours(p) || typeof p.delta !== "string" || !p.delta) return;
        const b = openBlock(p.itemId, "thinking");
        b.text += p.delta;
        ev({ type: "content_block_delta", index: b.index, delta: { type: "thinking_delta", thinking: p.delta } });
        return;
      }
      case "item/completed": {
        if (!ours(p)) return activity();
        const item = p.item ?? {};
        if (item.type === "agentMessage") {
          const b = closeBlock(item.id);
          const text = typeof item.text === "string" ? item.text : (b?.text ?? "");
          if (text) {
            assistant([{ type: "text", text }]);
            lastText = text;
            if (item.phase === "final_answer") finalText = text;
          }
          return;
        }
        if (item.type === "reasoning") {
          const b = closeBlock(item.id);
          const summary = Array.isArray(item.summary) ? item.summary.filter((s) => typeof s === "string" && s).join("\n\n") : "";
          const text = summary || b?.text || "";
          if (text) assistant([{ type: "thinking", thinking: text, signature: "" }]);
          return;
        }
        const t = toolOf(item);
        if (!t) return activity();
        toolStart(item); // без item/started (или вход уточнился: запрос поиска)
        const rec = tools.get(item.id);
        if (rec?.done) return;
        if (rec) rec.done = true;
        const r = toolResultOf(item);
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: item.id, content: r.content, is_error: r.is_error }] }, session_id: sid, parent_tool_use_id: null });
        curMsg = null; // следующий вывод модели — новый шаг
        return;
      }
      case "thread/tokenUsage/updated": {
        if (!ours(p)) return;
        const tu = p.tokenUsage ?? {};
        if (num(tu.modelContextWindow)) contextWindow = tu.modelContextWindow;
        // usage хода = прирост total с начала хода (total — накопленный по треду)
        const base = prevTotal ?? diffBreakdown(tu.total, tu.last);
        turnUsage = sumUsage(turnUsage, diffBreakdown(tu.total, base));
        prevTotal = tu.total ?? prevTotal;
        lastUsage = claudeUsage(tu.last);
        // usage последнего вызова — раннеру (run.lastUsage → занятость окна);
        // пустое assistant того же шага не даёт транскрипту ни части, ни шага
        if (lastMsg && lastUsage) out({ type: "assistant", message: { id: lastMsg, type: "message", role: "assistant", model, content: [], usage: lastUsage }, session_id: sid, parent_tool_use_id: null });
        return;
      }
      case "account/rateLimits/updated":
        if (p.rateLimits?.rateLimitReachedType) rateLimited = true;
        return activity();
      case "error":
        if (ours(p) && p.willRetry !== true) lastError = p.error ?? lastError;
        return activity();
      case "serverRequest/resolved": {
        // запрос закрыт самим сервером (ход прерван) — диалог уходит из чата
        const id = rpcToAsk.get(p.requestId);
        if (id && asks.delete(id)) out({ type: "control_cancel_request", request_id: id });
        rpcToAsk.delete(p.requestId);
        return;
      }
      case "turn/completed":
        if (!ours(p)) return;
        if (turnId && p.turn?.id && p.turn.id !== turnId) return;
        turnDone(p.turn ?? {});
        return;
      default:
        return activity();
    }
  };

  // --- запуск ---
  const cmd = codexCommand(env);
  if (!cmd) {
    sid = null;
    await promptP; // stdin — как у claude: прочитан до конца
    return fail("Не удалось запустить codex: CLI не найден (npm i -g @openai/codex или TELEHARNESS_CODEX_BIN)");
  }
  let exitInfo = null;
  srv = new AppServer(cmd, {
    cwd,
    onNotify,
    onRequest,
    onStderr: () => activity(),
    onExit: (code, signal, err) => {
      exitInfo = err ? errMsg(err) : signal ? `signal ${signal}` : `code ${code}`;
      turnDone(null);
    },
  });
  try {
    await srv.request("initialize", { clientInfo: CLIENT_INFO }, INIT_TIMEOUT_MS);
    srv.notify("initialized");
  } catch (e) {
    return fail(`Не удалось запустить codex app-server: ${errMsg(e)}`);
  }
  try {
    const acc = await srv.request("account/read", { refreshToken: false }, INIT_TIMEOUT_MS);
    if (!isObj(acc?.account) && acc?.requiresOpenaiAuth !== false) return fail("Codex: not logged in — authentication required (выполните `codex login` на сервере)");
  } catch (e) {
    log(`account/read: ${errMsg(e)}`); // старый app-server без метода — не мешает ходу
  }

  let developerInstructions;
  try {
    developerInstructions = renderDeveloperInstructions(o, pol);
    if (o.instructionsHash !== undefined && (!/^[a-f0-9]{64}$/.test(o.instructionsHash) || createHash("sha256").update(developerInstructions).digest("hex") !== o.instructionsHash)) {
      return fail("Codex: инструкции изменились после проверки порталом; ход не запущен. Повторите запрос.");
    }
  } catch (e) {
    return fail(`Codex profile instructions: ${errMsg(e)}`);
  }
  // The runner starts a new native thread whenever these instructions change:
  // Codex 0.169 may retain the original model-visible baseline on resume.
  const threadParams = { cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, ...(model ? { model } : {}), developerInstructions };
  let thread = null;
  if (o.resume && !o.oneshot) {
    try {
      // --fork-session (FEAT-01.57 «Изменить»/«Отменить ход»): новая ветка
      // разговора — thread/fork; иначе продолжение того же треда
      thread = await srv.request(o.fork ? "thread/fork" : "thread/resume", { threadId: o.resume, ...threadParams }, INIT_TIMEOUT_MS);
    } catch (e) {
      // тред потерян (сессии codex очищены, другая машина) — новый разговор,
      // а не вечная ошибка на каждом ходу
      log(`thread/${o.fork ? "fork" : "resume"} ${o.resume} не удался (${errMsg(e)}) — новый тред`);
    }
  }
  if (!thread) {
    try {
      thread = await srv.request("thread/start", o.oneshot ? { ...threadParams, ephemeral: true } : threadParams, INIT_TIMEOUT_MS);
    } catch (e) {
      // FEAT-18.8: app-server без ephemeral — тот же разовый запрос обычным тредом
      if (o.oneshot) {
        log(`thread/start ephemeral не удался (${errMsg(e)}) — обычный тред`);
        try {
          thread = await srv.request("thread/start", threadParams, INIT_TIMEOUT_MS);
        } catch (e2) {
          return fail(`Codex: thread/start не удался: ${errMsg(e2)}`);
        }
      } else return fail(`Codex: thread/start не удался: ${errMsg(e)}`);
    }
  }
  sid = typeof thread?.thread?.id === "string" ? thread.thread.id : null;
  if (!sid) return fail("Codex: app-server не вернул id треда");
  if (typeof thread?.model === "string" && !model) model = thread.model;
  else if (!model && typeof thread?.thread?.model === "string") model = thread.thread.model;
  if (typeof model !== "string" || !model.trim()) return fail("Codex: app-server не вернул модель для инструкций текущего хода");
  out({ type: "system", subtype: "init", session_id: sid, cwd, model, tools: [], mcp_servers: [], permissionMode: pol.mode, apiKeySource: "none", engine: "codex", codex: { approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox } });

  const prompt = await promptP;
  if (prompt == null) return finish(0); // stdin закрыт до промпта
  try {
    const t = await srv.request("turn/start", { threadId: sid, input: [{ type: "text", text: prompt, text_elements: [] }], model, ...turnSandbox(o, pol) }, INIT_TIMEOUT_MS);
    if (!turnId && typeof t?.turn?.id === "string") turnId = t.turn.id;
  } catch (e) {
    const data = e?.rpc?.data;
    const info = isObj(data) ? (data.codexErrorInfo ?? null) : null;
    return fail(errorText({ message: errMsg(e), codexErrorInfo: info }, { rateLimited }));
  }

  const turn = await turnDoneP;
  if (ended) return;
  // «Стоп» раннера: stdin закрыт — итог хода ставит раннер, «ход прерван» от Codex не пишем
  // (на быстрой машине turn/completed успевает раньше, чем onStdinClose дойдёт до finish)
  if (streamIn && stdinClosed && turn?.status === "interrupted") return;
  for (const id of [...openBlocks.keys()]) closeBlock(id);
  if (turn === null) return fail(`codex app-server завершился до конца хода (${exitInfo ?? "?"})`);
  const status = turn.status;
  if (status === "completed") {
    writeResult({ isError: false, text: finalText || lastText });
    return finish(0);
  }
  if (status === "interrupted") return fail(turn.error ? errorText(turn.error, { rateLimited }) : "Codex: ход прерван");
  return fail(errorText(turn.error ?? lastError ?? { message: `ход завершился со статусом ${status ?? "?"}` }, { rateLimited }));
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--teleharness-catalog")) {
    const r = await runCatalog();
    out(r);
    return finishProcess(r.ok ? 0 : 1);
  }
  return runTurn(argv);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch(async (e) => {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: `codex-shim: ${errMsg(e)}`, session_id: null });
    await finishProcess(1);
  });
}
