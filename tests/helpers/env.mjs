// Общие правила изоляции тестов (TASK-14.4, tests.md §3.1-5/6, §3.6-25).
//
// Тестовый сервер НИКОГДА не наследует переменные шелла (ZAI_MOCK, ZAI_UPSTREAM,
// ZAI_COOKIE_NAME, ZAI_TENANT_*, ZAI_CLAUDE_BIN …): env собирается из белого
// списка системных переменных + явно переданных значений. Прод-порты
// (opencode :4096, портал :4170, edge :80/:443) и стенд (:4172, его opencode
// :4097) запрещены как цели — assertSafeUrl() бросает до спавна.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Только то, без чего node.exe на Windows не стартует / не резолвит сеть.
export const ENV_WHITELIST = [
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC",
  "PATH", "Path", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "TZ",
  // macOS / Linux: os.tmpdir() / os.homedir() of the child match the parent's.
  "TMPDIR", "HOME",
];

// Порты, в которые тест/харнесс не имеет права ходить.
export const FORBIDDEN_PORTS = new Set([80, 443, 4096, 4097, 4170, 4172]);

export function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ENV_WHITELIST) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

// Бросает, если URL указывает на прод/стенд. Хост не важен: любой адрес этой
// машины (127.0.0.1, localhost, 192.168.x) на запрещённом порту — это прод.
export function assertSafeUrl(url, what = "url") {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what}: не URL: ${url}`);
  }
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(`${what} = ${url}: порт ${port} — прод/стенд, тестам запрещён (TASK-14.4)`);
  }
  return url;
}

// Свежий tmp-корень с подпапками DATA/HOME/TENANT_HOME/TENANT_VAULT/LOGS.
// cleanup() удаляет всё дерево.
export function makeTmpRoot(prefix = "zai-test-") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dirs = {
    root,
    data: path.join(root, "data"),
    home: path.join(root, "home"),
    tenants: path.join(root, "tenants"),
    vault: path.join(root, "vault"),
    logs: path.join(root, "logs"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  dirs.cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows может держать хэндл лога секунду — не валим тест */
    }
  };
  return dirs;
}

// Env изолированного портала: все пути данных — в tmp, upstream обязателен.
export function isolatedServerEnv({ tmp, upstream, mock = false, extra = {} }) {
  if (!mock) {
    if (!upstream) throw new Error("upstream обязателен для не-мок сервера (иначе дефолт = прод :4096)");
    assertSafeUrl(upstream, "ZAI_UPSTREAM");
  }
  return cleanEnv({
    PORT: "0",
    ZAI_MOCK: mock ? "1" : "0",
    // даже для мока: дефолт ZAI_UPSTREAM — прод :4096, хаб мока не должен туда стучаться
    ZAI_UPSTREAM: upstream ?? "http://127.0.0.1:9",
    ZAI_DATA_DIR: tmp.data,
    ZAI_LOG_DIR: tmp.logs,
    ZAI_HOME: tmp.home,
    ZAI_CHAT_DIR: tmp.home,
    ZAI_TENANT_HOME: tmp.tenants,
    ZAI_TENANT_VAULT: tmp.vault,
    ZAI_FILE_ROOTS: tmp.root,
    // FEAT-13.11: never the real D:\Obsidian\agents; tests opt in via extra
    ZAI_KB_ROOT: "off",
    // FEAT-06.2: never the real voice worker (D:\Voice); tests opt in via extra
    ZAI_VOICE: "0",
    ZAI_ACCESS_LOG: "0",
    ZAI_QUOTA_BASE: "http://127.0.0.1:9", // квота-upstream недоступен мгновенно
    ZAI_AUTH_FILE: path.join(tmp.root, "no-auth.json"),
    ZAI_CLAUDE_BIN: path.join(tmp.root, "no-claude.exe"),
    ZAI_ENV: "test",
    // every test chat lives under %TEMP%: the BUG-01.28 temp-dir filter off
    ZAI_HIDE_TEMP_SESSIONS: "0",
    // the empty-chat gc (BUG-01.48) would delete fixture sessions; tests opt in
    ZAI_GC_EMPTY_MIN: "0",
    // auto titles: heuristic only unless a test opts into the fake CLI
    ZAI_TITLE_LLM: "0",
    ...extra,
  });
}
