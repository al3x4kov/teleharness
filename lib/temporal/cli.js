// разрешение пути к бинарю Temporal CLI и проверка длины Unix-сокета.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TEMPORAL_CLI = "/opt/temporal/temporal";

function isExecutableFile(filePath, { stat = fs.statSync, access = fs.accessSync } = {}) {
  try {
    if (!stat(filePath).isFile()) return false;
    access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandTilde(value, homedir = os.homedir()) {
  const s = String(value ?? "").trim();
  if (s === "~") return homedir;
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(homedir, s.slice(2));
  return s;
}

/**
 * Разрешает путь к бинарю `temporal`:
 * 1. Явно заданный `configured` (с раскрытием ведущего `~/`).
 * 2. Поиск исполняемого `temporal` (или `temporal.exe` на win32) в `env.PATH`.
 * 3. Fallback `/opt/temporal/temporal` (для совместимости со стендом/продом Linux).
 */
export function resolveTemporalCli(
  configured = "",
  {
    env = process.env,
    platform = process.platform,
    homedir = os.homedir(),
    stat = fs.statSync,
    access = fs.accessSync,
    fallback = DEFAULT_TEMPORAL_CLI,
  } = {},
) {
  const raw = String(configured ?? "").trim();
  if (raw) return expandTilde(raw, homedir);
  const pathEnv = String(env.PATH || env.Path || "");
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["temporal.exe", "temporal.cmd", "temporal"] : ["temporal"];
  for (const dir of pathEnv.split(sep).map((x) => x.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate, { stat, access })) return candidate;
    }
  }
  return fallback;
}

/**
 * Проверяет байтовую длину пути Unix-сокета (macOS: 103 байт, Linux/POSIX: 107 байт).
 * Возвращает человекочитаемое сообщение об ошибке или null.
 */
export function socketPathProblem(socketPath, platform = process.platform) {
  if (!socketPath || platform === "win32") return null;
  const limit = platform === "darwin" ? 103 : 107;
  const bytes = Buffer.byteLength(String(socketPath), "utf8");
  if (bytes <= limit) return null;
  const osLabel = platform === "darwin" ? "macOS" : "POSIX";
  return `Путь Unix-сокета исполнителя слишком длинный (${bytes} байт, лимит ${osLabel} — ${limit}). Укажите более короткий путь в TELEHARNESS_TEMPORAL_MODEL_SOCKET (например, /tmp/teleharness-temporal/worker.sock).`;
}
