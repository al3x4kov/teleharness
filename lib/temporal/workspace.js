// BUG-251 / FEAT-19.16 (U013 п.1): every pipe has its own folder in the
// project, every run its own subfolder — artifacts never mix between pipes.
//   <project>/pipelines/<slug>/runs/<YYYYMMDD-HHMM>-<id8>/
import { mkdirSync } from "node:fs";
import path from "node:path";

export const PIPELINES_DIR = "pipelines";
const BAD = /[\\/:*?"<>|\u0000-\u001f]+/g;

// Readable folder name from the pipe name (Cyrillic kept), safe on Linux/Windows.
export function slugify(name) {
  let s = String(name ?? "").normalize("NFC").replace(BAD, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  s = s.slice(0, 60).replace(/[-.]+$/g, "");
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = "pipe";
  return s.toLowerCase();
}
// A slug unique among the owner's pipes in the same project.
export function uniqueSlug(name, taken) {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
export function workspaceOf(directory, slug) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || !slug || slug !== slugify(slug)) throw new Error("bad workspace");
  return path.join(directory, PIPELINES_DIR, slug);
}
export function runFolderName(workflowId, startedAt = new Date()) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const id = String(workflowId).replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "run";
  return `${stamp}-${id}`;
}
export function runFolderOf(workspace, workflowId, startedAt) {
  return path.join(workspace, "runs", runFolderName(workflowId, startedAt));
}
export function ensureDir(dir) { mkdirSync(dir, { recursive: true }); return dir; }
// Pipe folders are not «projects»: the project picker hides them.
export function isPipelineFolder(dir) { return /[\\/]pipelines[\\/]/.test(String(dir ?? "")); }

// FEAT-19.16 (U013 п.4): in pipes Codex is open to every user (a tenant's Codex step
// runs text-only); other engines follow the user's chat permissions.
export const pipeEngineAllowed = (engineAllowed, user, engine) => engine === "codex" ? !!user : engineAllowed(user, engine);

// BUG-253: admin projects come from the chat history — drop pipe folders, tenant
// homes, temp and system folders and folders that no longer exist.
const SYS = /[\\/]Windows[\\/](System32|SysWOW64)([\\/]|$)|^\/(proc|sys|dev|etc|usr|bin|sbin|boot|var|run)([\\/]|$)/i;
const TEMP = /[\\/](tmp|temp)([\\/]|$)|[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i;
export function projectCandidate(dir, { tenantHome = null, problem = () => null, exists = () => true } = {}) {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || isPipelineFolder(dir) || TEMP.test(dir) || SYS.test(dir)) return false;
  if (tenantHome && (dir === tenantHome || dir.startsWith(tenantHome.replace(/[\\/]+$/, "") + path.sep))) return false;
  if (/[\\/]\.teleharness-tenants([\\/]|$)/.test(dir)) return false;
  if (problem(dir)) return false;
  return exists(dir);
}
