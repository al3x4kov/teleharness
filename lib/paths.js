// Directory-shape guards shared by the server routes (zero-dep, pure).
//
// A chat directory must be ABSOLUTE: a relative one is resolved against the
// process cwd, which for the scheduled-task services is C:\WINDOWS\system32 —
// dogfood 2026-11-02 (BUG-013) created a session in
// C:\WINDOWS\system32\relative\folder from a project typed as «relative\folder».
// Accepted: drive paths (X:\… or X:/…) and UNC shares (\\host\share…).
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The portal checkout: never a tenant folder (default of dirProblem's portalRoot).
const PORTAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// TASK-17.1 (EPIC-17): every check takes `platform` (default — this process).
// win32 keeps the exact pre-Linux behavior; POSIX: «/»-paths, case-sensitive.
const isWin = (platform) => (platform ?? process.platform) === "win32";

// The platform may be given as an options object ({ platform }) or as a bare string ("win32").
const platformOf = (opt) => (typeof opt === "string" ? opt : opt?.platform);

export function isAbsoluteDir(dir, opt) {
  const platform = platformOf(opt);
  const s = String(dir ?? "").trim();
  if (!s) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return false; // no parent hops
  if (!isWin(platform)) return s.startsWith("/") && !s.startsWith("//");
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(s);
}

// Which rules a path is compared by when no platform is named: a Windows-shaped path (drive letter
// or \\host share) is compared as win32 wherever the code runs — such a path is never a real
// directory on POSIX (dirProblem refuses it), but it does appear in configs and test fixtures.
export function platformOfPath(p, platform) {
  if (platform) return platform;
  const s = String(p ?? "");
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") ? "win32" : process.platform;
}

// Comparison key of a path: Windows — case- and slash-insensitive (NTFS);
// POSIX — normalized, case-sensitive (ext4: /home/A ≠ /home/a, EPIC-17 риск №3).
export function pathKey(p, platform) {
  if (isWin(platform)) return path.win32.normalize(String(p)).replace(/[\\/]+$/, "").toLowerCase();
  const n = path.posix.normalize(String(p));
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

// Linux / macOS system trees a chat directory / tenant root may never be. /var as a whole is
// left alone (the macOS temp dir lives in /var/folders). Matched case-insensitively: macOS
// volumes are case-insensitive, and no real project lives in «/ETC» on Linux either.
const POSIX_SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/root", "/run", "/sbin", "/snap", "/sys", "/usr", "/var/lib", "/var/run", "/var/log", "/lost+found", "/system", "/library", "/private/etc", "/private/var/db"];

// BUG-12.11: the single path policy for chat directories and tenant roots.
// Returns null when the directory is acceptable, or a short reason code.
//
// Always refused (any role):
//   - relative paths and parent hops (BUG-013);
//   - device / long-path namespaces: \\?\ \\.\ \??\ (they bypass Win32
//     normalization — `\\?\C:\Windows` passed the old check);
//   - UNC shares (\\host\share): a chat would mkdir on a network share;
//   - NTFS stream / 8.3 / wildcard aliases (':' after the drive, '~', '*', '?');
//   - drive roots (C:\, D:\): a root as chat dir or file root opens the disk;
//   - the Windows system tree and Program Files.
// Additionally for tenants (`tenant: true`), the owner's zones:
//   - the portal tree (D:\Portal and below), the portal DATA_DIR;
//   - the owner's profile root itself (C:\Users\USER) — subfolders such as
//     C:\Users\USER\.zai-tenants\<name> stay allowed.
// Drive-independent (G7 finding 3): a system tree on any drive (D:\Windows
// of a second install, X:\$Recycle.Bin, X:\System Volume Information) is
// refused the same way as on C:.
const SYSTEM_DIRS = ["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "$windows.~bt", "$windows.~ws"];

function lowerNorm(p, platform) {
  return pathKey(p, platform);
}

function underOrEqual(p, base, platform) {
  const b = lowerNorm(base, platform);
  const sep = isWin(platform) ? "\\" : "/";
  return p === b || p.startsWith(b === sep ? b : b + sep);
}

function posixDirProblem(raw, { tenant, portalRoot, dataDir, profileRoot, platform }) {
  // raw is already an absolute «/…» path (dirProblem checked the shape)
  if (/[*?"<>|\\\x00-\x1f]/.test(raw)) return "alias";
  const n = lowerNorm(raw, platform);
  if (n === "/") return "drive-root";
  if (POSIX_SYSTEM_DIRS.some((d) => underOrEqual(n.toLowerCase(), d, platform))) return "system";
  if (tenant) {
    if (portalRoot && underOrEqual(n, portalRoot, platform)) return "portal";
    if (dataDir && underOrEqual(n, dataDir, platform)) return "portal-data";
    if (profileRoot && n === lowerNorm(profileRoot, platform)) return "profile-root";
  }
  return null;
}

export function dirProblem(dir, { tenant = false, portalRoot = PORTAL_ROOT, dataDir = null, profileRoot = null, platform } = {}) {
  const raw = String(dir ?? "").trim();
  if (!raw) return "empty";
  // The shape checks are the same on every platform: a Windows-style device path or UNC share is
  // named as such on POSIX too (not just «bad characters»), a relative path is «not-absolute».
  if (/^[\\/]{2}[?.][\\/]/.test(raw) || /^[\\/]\?\?[\\/]/.test(raw)) return "device-namespace";
  if (/^[\\/]{2}/.test(raw)) return "unc";
  if (!isAbsoluteDir(raw, { platform })) return "not-absolute";
  if (!isWin(platform)) return posixDirProblem(raw, { tenant, portalRoot, dataDir, profileRoot, platform });
  // Windows rules below are computed as win32 whatever OS runs this code (tests pin the platform).
  const W = "win32";
  if (/[*?"<>|~\x00-\x1f]/.test(raw) || raw.indexOf(":", 2) !== -1) return "alias";
  const n = lowerNorm(raw, W);
  if (/^[a-z]:$/.test(n)) return "drive-root";
  const drive = n.slice(0, 2);
  if (SYSTEM_DIRS.some((s) => underOrEqual(n, `${drive}\\${s}`, W))) return "system";
  if (tenant) {
    if (portalRoot && underOrEqual(n, portalRoot, W)) return "portal";
    if (dataDir && underOrEqual(n, dataDir, W)) return "portal-data";
    if (profileRoot && n === lowerNorm(profileRoot, W)) return "profile-root";
  }
  return null;
}

// ISSUE-006 (final review 2026-11-02): a shape-valid path on a drive that
// does not exist on the server (Z:\nope\dir) used to be accepted; the chat
// then died on its first turn with a raw PlatformError realPath stack.
// Returns "no-drive" when the drive root is missing, null otherwise (shape
// problems are dirProblem's job). `exists` is injectable for tests.
export function driveProblem(dir, { exists = existsSync, platform } = {}) {
  // Drive letters exist only on Windows. Skipped only when the platform is named explicitly:
  // a path that reaches this check on POSIX already failed dirProblem as «not-absolute».
  if (platform !== undefined && !isWin(platform)) return null;
  const m = /^([A-Za-z]):[\\/]/.exec(String(dir ?? "").trim());
  if (!m) return null;
  try {
    return exists(`${m[1].toUpperCase()}:\\`) ? null : "no-drive";
  } catch {
    return "no-drive";
  }
}

// BUG-01.28: true when dir is one of tempRoots or below it (case- and
// slash-insensitive, segment boundary required). Smoke/QA probes create
// their chats there; the session list hides them.
export function isUnderAny(dir, roots, { platform } = {}) {
  if (typeof dir !== "string" || !dir) return false;
  const pf = platformOfPath(dir, platform);
  const n = lowerNorm(dir, pf);
  return (roots ?? []).filter(Boolean).some((r) => underOrEqual(n, r, pf));
}

// Human-readable (Russian) text for API errors.
export function dirProblemText(code) {
  return (
    {
      empty: "каталог не указан",
      "device-namespace": "пути вида \\\\?\\ и \\\\.\\ запрещены",
      unc: "сетевые пути (UNC) запрещены",
      "not-absolute": "каталог должен быть абсолютным путём",
      alias: "недопустимые символы в пути",
      "drive-root": "корень диска запрещён",
      system: "системные каталоги запрещены",
      portal: "каталог портала недоступен",
      "portal-data": "каталог данных портала недоступен",
      "profile-root": "корень профиля владельца недоступен",
      "no-drive": "такого диска нет на сервере",
      unreachable: "папку не удалось создать на сервере — проверьте путь и права",
    }[code] ?? "недопустимый каталог"
  );
}

// ---- BUG-17.14 (BUG-220): одно место сравнения префиксов путей ----
// Раньше вложенность проверялась склейкой с литералом обратного слэша
// (auth.js, server.js): на POSIX такая проверка всегда ложна, и защита
// удаления папок тенанта не срабатывала.

// Ключ пути для Map/сравнения: нижний регистр — только на win32.
export function fsKey(p, platform) {
  return pathKey(p, platform);
}

// child строго внутри base (сам base — нет).
export function pathInside(child, base, platform) {
  const c = pathKey(child, platform);
  return c !== pathKey(base, platform) && underOrEqual(c, base, platform);
}

// Пути совпадают или один лежит внутри другого.
export function pathsOverlap(a, b, platform) {
  const ka = pathKey(a, platform);
  const kb = pathKey(b, platform);
  return ka === kb || underOrEqual(ka, b, platform) || underOrEqual(kb, a, platform);
}

// Каталоги и корни хоть одного пользователя (кроме exceptId) пересекаются с dir.
// Пустой/непригодный dir → true: удаление должно отказывать в закрытую.
// norm — нормализация пути (auth.js передаёт свой normDir с resolve).
export function scopeReferenced(users, dir, { exceptId = null, platform, norm = (d) => (d ? String(d) : null) } = {}) {
  const n = norm(dir);
  if (!n) return true;
  return (users ?? []).some(
    (o) =>
      o.id !== exceptId &&
      [...(o.directories ?? []), ...(o.extraRoots ?? []), o.obsidianRoot].filter(Boolean).some((d) => {
        const od = norm(d);
        return Boolean(od) && pathsOverlap(od, n, platform);
      }),
  );
}

// Значения по умолчанию путей к бинарникам — по платформе (на проде win32
// значения прежние; на POSIX — без .exe и букв дисков, переопределяются
// ZAI_CLAUDE_BIN / ZAI_JAIL_EXE / ZAI_SANDBOX_PY).
export function binDefaults({ platform, home, portalDir } = {}) {
  if (isWin(platform)) {
    return {
      claudeBin: path.win32.join(home ?? os.homedir(), ".local", "bin", "claude.exe"),
      jailExe: `${String(portalDir ?? PORTAL_ROOT).replace(/\\/g, "/")}/ops/sandbox/zai-jail.exe`,
      sandboxPy: "D:/zai-sandbox/python",
    };
  }
  return {
    claudeBin: path.posix.join(home ?? os.homedir(), ".local", "bin", "claude"),
    jailExe: path.posix.join(String(portalDir ?? PORTAL_ROOT).replace(/\\/g, "/"), "ops", "sandbox", "zai-jail"),
    sandboxPy: "/opt/zai-sandbox/python",
  };
}
