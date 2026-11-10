// Directory-shape guards shared by the server routes (zero-dep, pure).
//
// A chat directory must be ABSOLUTE: a relative one is resolved against the
// process cwd, which for the scheduled-task services is C:\WINDOWS\system32 —
// dogfood 2026-11-02 (BUG-013) created a session in
// C:\WINDOWS\system32\relative\folder from a project typed as «relative\folder».
// Accepted: drive paths (X:\… or X:/…) and UNC shares (\\host\share…);
// on macOS / Linux an absolute «/…» path (see posixDirProblem).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The portal checkout: never a tenant folder (default of dirProblem's portalRoot).
const PORTAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// macOS / Linux: an absolute dir is «/…» (no drive letters, no UNC).
// `platform` is injectable so the Windows policy is testable on any OS.
export function isAbsoluteDir(dir, platform = process.platform) {
  const s = String(dir ?? "").trim();
  if (!s) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return false; // no parent hops
  if (platform !== "win32") return s.startsWith("/") && !s.startsWith("//");
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(s);
}

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

function lowerNorm(p) {
  return path.win32.normalize(String(p)).replace(/[\\/]+$/, "").toLowerCase();
}

function underOrEqual(p, base) {
  const b = lowerNorm(base);
  return p === b || p.startsWith(b + "\\");
}

// macOS / Linux system trees (top level only; /var is left alone — the macOS
// temp dir lives in /var/folders).
const POSIX_SYSTEM_DIRS = ["/bin", "/sbin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/sys", "/usr", "/run", "/system", "/library", "/private/etc"];

function lowerPosix(p) {
  return path.posix.normalize(String(p)).replace(/\/+$/, "").toLowerCase();
}

function underOrEqualPosix(p, base) {
  const b = lowerPosix(base);
  return p === b || p.startsWith(b + "/");
}

// The POSIX half of dirProblem (raw is already an absolute «/…» path).
// Deny-list matching is case-insensitive on purpose (macOS volumes are).
function posixDirProblem(raw, { tenant, portalRoot, dataDir, profileRoot }) {
  if (/[*?"<>|\\\x00-\x1f]/.test(raw)) return "alias";
  const n = lowerPosix(raw);
  if (n === "") return "drive-root";
  if (POSIX_SYSTEM_DIRS.some((s) => underOrEqualPosix(n, s))) return "system";
  if (tenant) {
    if (portalRoot && underOrEqualPosix(n, portalRoot)) return "portal";
    if (dataDir && underOrEqualPosix(n, dataDir)) return "portal-data";
    if (profileRoot && n === lowerPosix(profileRoot)) return "profile-root";
  }
  return null;
}

export function dirProblem(dir, { tenant = false, portalRoot = PORTAL_ROOT, dataDir = null, profileRoot = null, platform = process.platform } = {}) {
  const raw = String(dir ?? "").trim();
  if (!raw) return "empty";
  if (/^[\\/]{2}[?.][\\/]/.test(raw) || /^[\\/]\?\?[\\/]/.test(raw)) return "device-namespace";
  if (/^[\\/]{2}/.test(raw)) return "unc";
  if (!isAbsoluteDir(raw, platform)) return "not-absolute";
  if (platform !== "win32") return posixDirProblem(raw, { tenant, portalRoot, dataDir, profileRoot });
  if (/[*?"<>|~\x00-\x1f]/.test(raw) || raw.indexOf(":", 2) !== -1) return "alias";
  const n = lowerNorm(raw);
  if (/^[a-z]:$/.test(n)) return "drive-root";
  const drive = n.slice(0, 2);
  if (SYSTEM_DIRS.some((s) => underOrEqual(n, `${drive}\\${s}`))) return "system";
  if (tenant) {
    if (portalRoot && underOrEqual(n, portalRoot)) return "portal";
    if (dataDir && underOrEqual(n, dataDir)) return "portal-data";
    if (profileRoot && n === lowerNorm(profileRoot)) return "profile-root";
  }
  return null;
}

// ISSUE-006 (final review 2026-11-02): a shape-valid path on a drive that
// does not exist on the server (Z:\nope\dir) used to be accepted; the chat
// then died on its first turn with a raw PlatformError realPath stack.
// Returns "no-drive" when the drive root is missing, null otherwise (shape
// problems are dirProblem's job). `exists` is injectable for tests.
export function driveProblem(dir, { exists = existsSync } = {}) {
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
export function isUnderAny(dir, roots) {
  if (typeof dir !== "string" || !dir) return false;
  const n = lowerNorm(dir);
  return (roots ?? []).filter(Boolean).some((r) => underOrEqual(n, r));
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
