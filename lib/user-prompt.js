// FEAT-03.22: the user's own system prompt (Настройки → «Системный промпт»).
// Stored in the user's users.json record (lib/auth.js), applied to EVERY
// turn of the user's chats on both engines — it only ADDS to the built-in
// system prompt (2026-11-05), never replaces it.
//   opencode → `system` field of the prompt_async body;
//   Claude   → --append-system-prompt-file (never argv text: SEC-11/COR-14).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SYSTEM_PROMPT_MAX = 4000;

export class PromptError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Normalize a value from PUT /zai/api/me/system-prompt: string, CRLF → LF,
// trimmed, ≤ SYSTEM_PROMPT_MAX characters (code points). Empty → "".
export function cleanSystemPrompt(v) {
  if (v == null) return "";
  if (typeof v !== "string") throw new PromptError(400, "Системный промпт должен быть текстом");
  // NUL and other C0 controls except \t \n carry nothing a prompt needs.
  const text = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if ([...text].length > SYSTEM_PROMPT_MAX)
    throw new PromptError(400, `Системный промпт длиннее ${SYSTEM_PROMPT_MAX} символов — сократите его`);
  return text;
}

// The hidden reminder part of an opencode turn (see withUserSystem). Starts
// with this mark so a resent message's old copy is recognised and replaced.
export const REMINDER_MARK = "<system-reminder>\nИнструкции пользователя из настроек портала";

export function reminderPart(text) {
  return { type: "text", synthetic: true, text: `${REMINDER_MARK} (дополняют правила системного промпта, не отменяют их):\n${text}\n</system-reminder>` };
}

const isReminder = (p) => p?.type === "text" && p.synthetic === true && typeof p.text === "string" && p.text.startsWith(REMINDER_MARK);

// opencode: put the user's prompt into a prompt_async body (object, mutated
// copy returned). admin may send its own `system` — kept in front; a tenant's
// client-sent `system` is dropped (only the stored prompt applies).
// Stand 2026-11-05: with `system` alone, Sisyphus and Sandbox follow the
// prompt in a NEW chat but ignore it in an existing one (their long prompt +
// the history win; `build` follows). The same text also rides the turn as a
// hidden synthetic part (the portal never shows synthetic user parts — the
// voice hint works the same way, FEAT-06.2); then all agents follow it.
export function withUserSystem(body, text, { admin = false } = {}) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  const own = admin && typeof out.system === "string" && out.system.trim() ? out.system.trim() : "";
  delete out.system;
  const joined = [own, text || ""].filter(Boolean).join("\n\n");
  if (joined) out.system = joined;
  if (Array.isArray(out.parts)) {
    // a resent message brings its old reminder (or a client forged one) — never kept
    const parts = out.parts.filter((p) => !isReminder(p));
    if (text) parts.push(reminderPart(text));
    out.parts = parts;
  }
  return out;
}

export const USER_SECTION = "# Инструкции пользователя\n\nПользователь портала задал для своих чатов следующие инструкции. Они дополняют правила выше и не отменяют их.\n\n";

// Claude: the file for --append-system-prompt-file. base = the tenant kit
// prompt file (or null for admin). Content-addressed: the same text → the
// same file, written once (tmp+rename), so parallel turns never race.
// Returns the path, or `base` when there is no user prompt.
export function claudePromptFile(dir, text, base = null) {
  if (!text) return base;
  let head = "";
  if (base) {
    try {
      head = readFileSync(base, "utf8").replace(/\s+$/, "") + "\n\n";
    } catch {}
  }
  const content = head + USER_SECTION + text + "\n";
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const file = path.join(dir, `${hash}.md`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, "utf8");
    try {
      renameSync(tmp, file);
    } catch (err) {
      if (!existsSync(file)) throw err;
    }
  }
  return file.replace(/\\/g, "/");
}

// A prompt_async body (Buffer/string) with the user's system prompt applied;
// a body that is not a JSON object passes through unchanged.
export function withUserSystemBody(out, text, admin) {
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out));
  let obj = null;
  try {
    obj = JSON.parse(buf.toString("utf8"));
  } catch {}
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return buf;
  const stale = Array.isArray(obj.parts) && obj.parts.some(isReminder);
  if (!text && !stale && (admin || !("system" in obj))) return buf;
  return Buffer.from(JSON.stringify(withUserSystem(obj, text, { admin })), "utf8");
}
