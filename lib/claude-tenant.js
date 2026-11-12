// FEAT-04.11: the tenant kit of Claude chats — the same abilities a tenant has in
// opencode (FEAT-04.9/04.10): cmd.exe + Python in its Windows AppContainer, the
// document skills zai-*, the read-only MCP marketplace.
//
//   Bash        — allowed only through lib/claude-jail-hook.mjs (PreToolUse,
//                 rewrites the command into zai-jail; fail-closed, not in --allowedTools);
//   skills      — ops/opencode/skills/zai-* copied into a session plugin
//                 (<data>/claude-tenant-plugin, --plugin-dir) → «zai:zai-xlsx», …;
//   marketplace — ops/claude/tenant-mcp.json (--mcp-config + --strict-mcp-config),
//                 compare_browser_snapshot denied (the owner's logged-in browser);
//   prompt      — ops/claude/tenant-prompt.md (--append-system-prompt-file).
// FEAT-04.12: WebFetch — public addresses only (the same hook); Task — subagents.
// Zero runtime dependencies.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binDefaults } from "./paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORTAL_DIR = path.resolve(HERE, "..");
const BIN_DEFAULTS = binDefaults({ portalDir: PORTAL_DIR.replace(/\\/g, "/") });
export const HOOK_PATH = path.join(HERE, "claude-jail-hook.mjs");
const fwd = (p) => String(p ?? "").replace(/\\/g, "/");

// FEAT-04.12: + WebFetch (approved only by the hook: public addresses) and Task
// (subagents — the PreToolUse hooks apply to their calls too, so their Bash is
// jailed and their WebFetch checked the same way).
export const TENANT_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "TodoWrite", "WebSearch", "WebFetch", "Task"];
export const TENANT_ALLOWED = ["mcp__marketplace", "Skill", "WebSearch", "TodoWrite", "Task"];
export const TENANT_DENIED = ["mcp__marketplace__compare_browser_snapshot"];
const JAIL_ID = /^[A-Za-z0-9_-]{1,40}$/;

// Same container name as ops/opencode/vault-cache.ts jailName(): one AppContainer per tenant.
export function jailName(tenant) {
  const t = String(tenant ?? "");
  return `zai-t-${JAIL_ID.test(t) ? t : "h" + createHash("sha1").update(t, "utf8").digest("hex").slice(0, 16)}`;
}

// The tenant's jail for a chat folder: {name, home} when `dir` is inside
// <tenantHome>/<tenant>, else null (no shell then).
export function tenantJailFor(dir, tenantHome) {
  if (typeof dir !== "string" || !dir || typeof tenantHome !== "string" || !tenantHome) return null;
  const rel = path.relative(path.resolve(tenantHome), path.resolve(dir));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const tenant = rel.split(/[\\/]/)[0];
  if (!tenant || tenant === "." || tenant === "..") return null;
  return { name: jailName(tenant), home: path.join(path.resolve(tenantHome), tenant) };
}

// Copy the zai-* skills into <outDir> as a Claude plugin «zai». → outDir, or null
// when there is nothing to copy (the kit then has no skills).
export function syncTenantPlugin(srcSkills, outDir) {
  let names = [];
  try {
    names = readdirSync(srcSkills, { withFileTypes: true }).filter((e) => e.isDirectory() && /^zai-[a-z0-9-]+$/i.test(e.name) && existsSync(path.join(srcSkills, e.name, "SKILL.md"))).map((e) => e.name);
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(outDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "zai", version: "1.0.0", description: "zai: документы (xlsx, docx, pptx, pdf, картинки, html) в песочнице пользователя" }, null, 2));
  for (const n of names) cpSync(path.join(srcSkills, n), path.join(outDir, "skills", n), { recursive: true });
  return outDir;
}

// The kit files; a missing part is just left out (null).
export function tenantKit({ dataDir, skillsDir = path.join(PORTAL_DIR, "ops", "opencode", "skills"), mcpConfig = path.join(PORTAL_DIR, "ops", "claude", "tenant-mcp.json"), promptFile = path.join(PORTAL_DIR, "ops", "claude", "tenant-prompt.md"), jailExe, sandboxPy, nodePath = process.execPath } = {}) {
  let pluginDir = null;
  try {
    pluginDir = dataDir ? syncTenantPlugin(skillsDir, path.join(dataDir, "claude-tenant-plugin")) : null;
  } catch {
    pluginDir = null;
  }
  let mcp = null;
  try {
    const doc = JSON.parse(readFileSync(mcpConfig, "utf8"));
    if (doc?.mcpServers && Object.keys(doc.mcpServers).length) mcp = mcpConfig;
  } catch {}
  return {
    pluginDir,
    mcpConfig: mcp,
    promptFile: existsSync(promptFile) ? promptFile : null,
    // BUG-17.14: значения по умолчанию — по платформе (lib/paths.js).
    // macOS / Linux: no sandbox — the jail hook denies every tenant command.
    jailExe: fwd(jailExe || BIN_DEFAULTS.jailExe),
    sandboxPy: fwd(sandboxPy || BIN_DEFAULTS.sandboxPy),
    nodePath: fwd(nodePath),
  };
}

// Extra CLI args of a tenant turn (after permissionArgs("tenant")).
// promptFile: override of kit.promptFile — FEAT-03.22 passes the kit prompt
// joined with the user's own system prompt (lib/user-prompt.js).
export function tenantKitArgs(kit, { promptFile = kit?.promptFile ?? null } = {}) {
  if (!kit) return [];
  const out = ["--tools", TENANT_TOOLS.join(","), "--allowedTools", TENANT_ALLOWED.join(","), "--disallowedTools", TENANT_DENIED.join(",")];
  if (kit.mcpConfig) out.push("--mcp-config", kit.mcpConfig);
  if (kit.pluginDir) out.push("--plugin-dir", kit.pluginDir);
  if (promptFile) out.push("--append-system-prompt-file", promptFile);
  return out;
}

// The PreToolUse Bash hook for a tenant turn, merged into the turn's hooks.
export function withJailHook(hooks, kit, jail) {
  if (!kit || !jail?.name || !jail?.home) return hooks;
  const q = (s) => `"${fwd(s)}"`;
  const command = [q(kit.nodePath), q(HOOK_PATH), "--name", jail.name, "--home", q(jail.home), "--jail", q(kit.jailExe), "--py", q(kit.sandboxPy)].join(" ");
  const entry = { matcher: "Bash|WebFetch", hooks: [{ type: "command", command }] };
  const base = hooks && typeof hooks === "object" ? hooks : {};
  return { ...base, PreToolUse: [...(Array.isArray(base.PreToolUse) ? base.PreToolUse : []), entry] };
}
