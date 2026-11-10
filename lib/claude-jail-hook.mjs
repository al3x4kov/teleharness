#!/usr/bin/env node
// FEAT-04.11: PreToolUse hook of TENANT Claude chats (matcher Bash). The command
// the model wrote never runs on the host: the hook answers "allow" with the tool
// input rewritten into a zai-jail call (the tenant's Windows AppContainer, cmd.exe,
// sandbox Python) — the same launcher line ops/opencode/vault-cache.ts builds for
// opencode tenants. Anything wrong → "deny" with a reason.
//
// Fail-closed: the tenant profile does NOT list Bash in --allowedTools, so a Bash
// call is approved ONLY by this hook's "allow". A crashed or missing hook leaves
// the call unapproved and --permission-prompts none denies it (spike CLI 2.1.316,
// 2026-11-05).
//
// argv: --name zai-t-<id> --home <tenant home> [--jail <exe>] [--py <sandbox python dir>]
// stdin: the hook event JSON {tool_name, tool_input:{command,…}, cwd, …}.
// Zero dependencies.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHELL_SAFE_PATH = /^[A-Za-z]:\/[A-Za-z0-9_.\/-]*$/;
export const JAIL_NAME = /^zai-t-[A-Za-z0-9_-]{1,40}$/;
const fwd = (p) => String(p ?? "").replace(/\\/g, "/");

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// realpath of the deepest existing ancestor + the not-yet-existing tail
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      return fwd(path.join(realpathSync.native(cur), ...tail));
    } catch {
      const up = path.dirname(cur);
      if (up === cur) break;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
  return fwd(path.resolve(p));
}

function inside(p, root) {
  const a = fwd(p).replace(/\/+$/, "").toLowerCase();
  const r = fwd(root).replace(/\/+$/, "").toLowerCase();
  return a === r || a.startsWith(r + "/");
}

// → {command} (the jailed launcher line) or {error}.
export function jailLine(command, { name, home, cwd, jail, py, exists = existsSync, real = realish }) {
  if (typeof command !== "string" || !command.trim()) return { error: "пустая команда" };
  if (command.includes("\0")) return { error: "недопустимый символ в команде" };
  if (!JAIL_NAME.test(String(name ?? ""))) return { error: "нет имени песочницы пользователя" };
  if (!home) return { error: "у чата нет папки пользователя" };
  const root = fwd(path.resolve(home));
  const wd = fwd(path.resolve(cwd || home));
  if (!inside(wd, root) || !inside(real(wd), real(root))) return { error: `рабочая папка команды вне вашей папки: ${cwd}` };
  const pyDir = fwd(py).replace(/\/+$/, "");
  const cafile = `${pyDir}/Lib/site-packages/certifi/cacert.pem`;
  if (!exists(jail)) return { error: "командная строка недоступна: нет запускателя песочницы" };
  if (!exists(`${pyDir}/Scripts/python.exe`) || !exists(cafile)) return { error: "командная строка недоступна: нет окружения Python песочницы" };
  for (const p of [fwd(jail), root, wd, cafile, pyDir]) if (!SHELL_SAFE_PATH.test(p)) return { error: `путь с недопустимыми символами для песочницы: ${p}` };
  const b64 = Buffer.from(`cmd.exe /d /s /c "${command}"`, "utf8").toString("base64url");
  return { command: [fwd(jail), "--name", name, "--dir", root, "--cwd", wd, "--net", "--cafile", cafile, "--path-prepend", `${pyDir}/Scripts`, "--b64", b64].join(" ") };
}

// FEAT-04.12: «cd /d <folder> && rest» — the container cannot walk C:\Users\USER,
// so cmd's own cd died with «Access is denied». The folder becomes the jail's
// --cwd instead (still checked to be inside the user's folder) and only the
// rest runs. → {cwd, command}; anything else is returned unchanged.
export function splitCd(command, cwd) {
  const m = /^\s*cd(?:\s+\/d)?\s+(?:"([^"]+)"|([^\s&|<>"]+))\s*&&\s*([\s\S]+)$/i.exec(String(command ?? ""));
  if (!m) return { cwd, command };
  const target = m[1] ?? m[2];
  return { cwd: path.resolve(cwd || ".", target), command: m[3] };
}

export const NO_SANDBOX = "командная строка недоступна: песочница пользователей (Windows AppContainer) есть только на Windows-сервере, на этом сервере команды пользователей отключены";

const deny = (why) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[песочница] ${why}` } });

// FEAT-04.12: «zai-render <file> [--pages …]» as a WHOLE command (no &&, |, >)
// runs the host renderer ops/render/zai_render.py (LibreOffice/Edge/pdfium
// cannot run in the container); it confines the file to the user's folder and
// renders a sanitized copy. Inside a chain it stays a jailed command, where
// the sandbox stub only explains how to call it.
export const RENDER_CMD = /^\s*zai-render(?:\s+([^&|<>^\r\n]*))?\s*$/i;
export const RENDER_SCRIPT = fwd(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops", "render", "zai_render.py"));

export function renderLine(args, { home, cwd, py, render = RENDER_SCRIPT, exists = existsSync, real = realish }) {
  if (!home) return { error: "у чата нет папки пользователя" };
  const root = fwd(path.resolve(home));
  const wd = fwd(path.resolve(cwd || home));
  if (!inside(wd, root) || !inside(real(wd), real(root))) return { error: `рабочая папка команды вне вашей папки: ${cwd}` };
  const pyExe = `${fwd(py).replace(/\/+$/, "")}/Scripts/python.exe`;
  const script = fwd(path.resolve(render));
  if (!exists(pyExe) || !exists(script)) return { error: "просмотр документов (zai-render) недоступен на сервере" };
  for (const p of [pyExe, script, root, wd]) if (!SHELL_SAFE_PATH.test(p)) return { error: `путь с недопустимыми символами: ${p}` };
  const b64 = Buffer.from(String(args ?? ""), "utf8").toString("base64url") || "-";
  return { command: [pyExe, "-I", script, "--root", root, "--cwd", wd, "--b64", b64].join(" ") };
}

// The hook's answer object for one Bash event.
export function decide(ev, opts) {
  if (ev?.tool_name !== "Bash") return deny(`инструмент ${ev?.tool_name ?? "?"} не проходит через песочницу`);
  // macOS / Linux: there is no tenant sandbox (zai-jail is a Windows
  // AppContainer). Fail closed — a tenant command never runs unsandboxed.
  if ((opts?.platform ?? process.platform) !== "win32") return deny(NO_SANDBOX);
  const input = ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {};
  const sc = splitCd(input.command, ev.cwd || opts.home);
  const rm = RENDER_CMD.exec(String(sc.command ?? ""));
  if (rm) {
    const rr = renderLine(rm[1] ?? "", { ...opts, cwd: sc.cwd });
    if (rr.error) return deny(rr.error);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "просмотр документа (zai-render)", updatedInput: { ...input, command: rr.command } } };
  }
  const r = jailLine(sc.command, { ...opts, cwd: sc.cwd });
  if (r.error) return deny(r.error);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "команда выполняется в песочнице пользователя", updatedInput: { ...input, command: r.command } } };
}

// FEAT-04.12: WebFetch of a tenant runs on the host, so only public addresses:
// loopback (opencode :4096 has no password), LAN, link-local, CGNAT, multicast
// and reserved ranges are refused — the same rule as the opencode plugin.
export function privateAddress(ip) {
  const a = String(ip ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (isIP(a) === 6) {
    if (a === "::" || a === "::1") return true;
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (v4) return privateAddress(v4[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a) || a.startsWith("64:ff9b:");
  }
  return true; // not an address at all → refuse
}

export async function decideWebFetch(ev, { lookup = (h) => dnsLookup(h, { all: true, verbatim: true }) } = {}) {
  const input = ev?.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {};
  let u;
  try {
    u = new URL(String(input.url ?? ""));
  } catch {
    return deny("адрес страницы не распознан");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return deny(`загрузка только по http(s), не ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try {
    addrs = isIP(host) ? [{ address: host }] : await lookup(host);
  } catch {
    return deny(`адрес ${host} не найден`);
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return deny(`адрес ${host} не найден`);
  if (addrs.some((x) => privateAddress(x?.address))) return deny(`локальные и внутренние адреса недоступны (${host})`);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "публичный адрес" } };
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  let out;
  try {
    const ev = JSON.parse(readFileSync(0, "utf8") || "{}");
    out = ev?.tool_name === "WebFetch" ? await decideWebFetch(ev) : decide(ev, {
      name: argOf(argv, "--name"),
      home: argOf(argv, "--home"),
      jail: argOf(argv, "--jail") || fwd(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops", "sandbox", "zai-jail.exe")),
      py: argOf(argv, "--py") || "D:/zai-sandbox/python",
    });
  } catch (e) {
    out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[песочница] ошибка проверки команды: ${e?.message ?? e}` } };
  }
  process.stdout.write(JSON.stringify(out));
}
