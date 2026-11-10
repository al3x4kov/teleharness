// Pure turn-state helpers for the chat store (node-importable, no signals):
// turn-error classification (BUG-07.14), optimistic-bubble bookkeeping
// (BUG-01.36, FEAT-01.29), «last action» labels for the liveness line
// (BUG-13.3 / BUG-07.8 UI) and the clean «send again» payload.
import { fmtSpan as fmtSec, splitDirective, splitInjected } from "./normalize.js";
import { t } from "./i18n.js";

// ---- optimistic user bubbles ------------------------------------------------
// tmp-<n> entries live only in this tab. info.delivery walks
//   "sending" (POST in flight) → "delivered" (2xx) → "accepted" (an assistant
//   message answers it) | "failed" (never reached the server).
// info.queued marks a prompt sent while a turn was running (the «В очереди»
// face of the bubble — rendered by MessageBubble).
// "held" (ISSUE-002): an opencode follow-up typed before the running turn
// answered its question. opencode answers only the LATEST unanswered user
// message, so two prompts in that window merged into one answer; the store
// keeps such a prompt in this tab and sends it once the answer has started
// (or the turn ended): held → sending → delivered → accepted.

export function isTmp(m) {
  return String(m?.info?.id ?? "").startsWith("tmp-");
}

// Local entries the server does not know about yet and that a history refresh
// or a turn end must never wipe: failed sends (the user's text, BUG-017) and
// sends whose POST is still in flight.
export function isLocalOnly(m) {
  return isTmp(m) && (m.info.failed === true || m.info.delivery === "sending" || m.info.delivery === "held");
}

export function isHeld(m) {
  return isTmp(m) && m.info.delivery === "held" && !m.info.failed;
}

// ISSUE-002: is the newest SENT user message still without any assistant
// message after it? (failed and held bubbles never reached the server.)
// Answers sit right after their question (events.answerSlot), an answer with
// an unknown parent lands at the tail — both count as «after».
export function awaitingAnswer(messages) {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const info = list[i]?.info ?? {};
    if (info.role === "assistant") {
      // An answer exists below the newest sent question only if we meet it
      // BEFORE that question while walking up.
      return false;
    }
    if (info.role === "user" && !info.failed && info.delivery !== "held") return true;
  }
  return false;
}

// Turn end: the server is idle, so every delivered tmp has a real twin (or
// will after a refresh) — drop those, keep the local-only ones.
export function finalizeMessages(messages) {
  return (messages ?? []).filter((m) => !isTmp(m) || isLocalOnly(m));
}

function plainUserText(m) {
  return (m?.parts ?? [])
    .filter((p) => p?.type === "text" && !p.synthetic)
    .map((p) => splitDirective(splitInjected(p.text ?? "").text).text)
    .join("\n")
    .trim();
}

// History refresh replaces the list wholesale; local-only bubbles ride along
// at the tail so a failed «Повторить» bubble survives resync/stop/idle. A
// DELIVERED bubble is kept too until the fetched history shows its real twin
// (history fetched a moment before the server stored the prompt must not
// make the message vanish — BUG-01.35 «typed while loading»).
export function mergeHistory(serverList, current) {
  const server = serverList ?? [];
  const users = server.filter((m) => m?.info?.role === "user").map((m) => ({ text: plainUserText(m), used: false }));
  const keep = [];
  for (const m of current ?? []) {
    if (!isTmp(m)) continue;
    if (isLocalOnly(m)) {
      keep.push(m);
      continue;
    }
    if (m.info.delivery !== "delivered") continue;
    const t = plainUserText(m);
    // Newest-first: the twin of a just-sent prompt sits at the tail.
    const twin = [...users].reverse().find((u) => !u.used && (t ? u.text && (u.text.startsWith(t) || t.startsWith(u.text)) : true));
    if (twin) twin.used = true;
    else keep.push(m);
  }
  return [...server, ...keep];
}

// ---- «send again»: the parts of a user message, as the user typed them -------
// Raw history text carries the vault-cache snapshot (first message) and
// orchestration directives — resending that verbatim leaked the snapshot as
// the user's words (CC-19). File parts (images) ride along; upload refs are
// plain text parts and survive the cleaning untouched.
export function resendParts(message) {
  const out = [];
  for (const p of message?.parts ?? []) {
    if (p?.type === "text") {
      if (p.synthetic) continue;
      const text = splitDirective(splitInjected(p.text ?? "").text).text.trim();
      if (text) out.push({ type: "text", text });
    } else if (p?.type === "file" && p.url) {
      out.push({ type: "file", mime: p.mime, filename: p.filename, url: p.url });
    }
  }
  return out;
}

// ---- turn errors (session.error / info.error / Claude error text) ------------

const CLAUDE_ERROR_TEXT_RE =
  /^(Не удалось запустить claude CLI|Claude вернул ошибку)|Please run \/login|OAuth token (has )?expired|Invalid API key|authentication_error|usage limit reached|Claude AI usage limit/i;

function errText(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const m = err.data?.message ?? err.message ?? err.data?.error ?? "";
  return typeof m === "string" ? m : "";
}

function clip(s, n = 280) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// → {kind, title, text, detail, actions[]} | null (user abort = not an error).
// actions: "retry" (resend the last user message), "settings" (limits live in
// Настройки → Подписка), "continue" (the answer was cut off).
export function describeTurnError(err, { engine = "opencode" } = {}) {
  if (err == null || err === false) return null;
  const name = typeof err === "object" ? String(err.name ?? "") : "";
  if (name === "MessageAbortedError") return null; // «Стоп» — the user's own choice
  // BUG-11.13 / BUG-082: the hub marks a turn that finished with no content
  // and no error (live session.error + info.error in history). Its own face:
  // nothing broke on the provider side, a resend usually helps.
  if (name === "EmptyTurnError") {
    return {
      kind: "empty",
      title: t("turn.err.empty.title"),
      text: t("turn.err.empty.text"),
      detail: null,
      actions: ["retry"],
    };
  }
  const raw = errText(err);
  const low = `${name} ${raw}`.toLowerCase();
  const claude = engine === "claude";
  const detail = clip(raw) || null;
  // ISSUE-006: the chat's folder is gone / on a missing drive — upstream
  // answers a raw PlatformError realPath stack. A retry cannot help.
  if (/platformerror|filesystem\.realpath|enoent|no such file or directory/.test(low)) {
    return {
      kind: "workdir",
      title: t("turn.err.workdir.title"),
      text: t("turn.err.workdir.text"),
      detail,
      actions: [],
    };
  }
  if (
    name === "ProviderAuthError" ||
    /unauthori[sz]ed|invalid api key|oauth|authenticat|please run \/login|\b401\b|forbidden|\b403\b/.test(low)
  ) {
    return {
      kind: "auth",
      title: t(claude ? "turn.err.auth.claude.title" : "turn.err.auth.title"),
      text: t(claude ? "turn.err.auth.claude.text" : "turn.err.auth.text"),
      detail,
      actions: ["retry"],
    };
  }
  if (/rate.?limit|quota|\b429\b|too many requests|usage limit|limit (exceeded|reached)|insufficient (balance|quota)|余额|exceeded your/.test(low)) {
    return {
      kind: "limit",
      title: t(claude ? "turn.err.limit.claude.title" : "turn.err.limit.title"),
      text: t(claude ? "turn.err.limit.claude.text" : "turn.err.limit.text"),
      detail,
      actions: claude ? ["retry"] : ["retry", "settings"],
    };
  }
  if (name === "MessageOutputLengthError" || /output length|max.?tokens/.test(low)) {
    return {
      kind: "length",
      title: t("turn.err.length.title"),
      text: t("turn.err.length.text"),
      detail,
      actions: ["continue"],
    };
  }
  if (/overloaded|\b5\d\d\b|timeout|timed out|econn|network|fetch failed|socket|unavailable/.test(low)) {
    return {
      kind: "provider",
      title: t("turn.err.provider.title"),
      text: t("turn.err.provider.text"),
      detail,
      actions: ["retry"],
    };
  }
  if (claude && /^Не удалось запустить claude CLI/i.test(raw)) {
    return { kind: "spawn", title: t("turn.err.spawn.title"), text: t("turn.err.spawn.text"), detail, actions: ["retry"] };
  }
  return {
    kind: "unknown",
    title: t("turn.err.unknown.title"),
    text: t(raw ? "turn.err.unknown.text" : "turn.err.unknown.textBare"),
    detail,
    actions: ["retry"],
  };
}

// The error that ended the LAST turn, derived from history (a reload must not
// hide it): the tail assistant message's info.error, or — for Claude chats,
// whose runner reports failures as the assistant text — a known error text.
export function turnErrorFromMessages(messages, { engine = "opencode" } = {}) {
  const list = messages ?? [];
  const tail = list[list.length - 1];
  if (!tail || tail.info?.role !== "assistant") return null;
  if (tail.info.error) return describeTurnError(tail.info.error, { engine });
  if (engine === "claude") {
    const text = (tail.parts ?? [])
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    if (text && text.length < 2000 && CLAUDE_ERROR_TEXT_RE.test(text)) return describeTurnError(text, { engine });
  }
  return null;
}

// ---- dialog answers (BUG-07.13) ---------------------------------------------
// The question reply payload from per-question picks + custom texts:
// string[][] (one label array PER question), or null while any question is
// still unanswered.
export function collectAnswers(questions, picks, customs) {
  const out = [];
  for (let i = 0; i < (questions ?? []).length; i += 1) {
    const a = [...(picks?.[i] ?? [])];
    const c = String(customs?.[i] ?? "").trim();
    if (c && !a.includes(c)) a.push(c);
    if (a.length === 0) return null;
    out.push(a);
  }
  return out.length > 0 ? out : null;
}

// ---- liveness: «последнее действие» -----------------------------------------

// «Работает 3м 05с · последнее действие: команда · 12с назад» — the line under
// the feed while a turn runs (BUG-13.3 / R-21). Any piece may be missing.
export function livenessLine({ since = null, lastAction = null, lastActivityAt = null } = {}, now = Date.now()) {
  const bits = [];
  if (typeof since === "number" && since > 0 && now >= since) bits.push(t("turn.live.workingFor", { span: fmtSpan(now - since) }));
  else bits.push(t("turn.live.working"));
  if (lastAction?.label) bits.push(t("turn.live.lastAction", { label: lastAction.label }));
  const at = typeof lastActivityAt === "number" ? lastActivityAt : lastAction?.at;
  if (typeof at === "number" && at > 0 && now >= at) {
    const ago = now - at;
    bits.push(ago < 5000 ? t("turn.live.justNow") : t("turn.live.ago", { span: fmtSpan(ago) }));
  }
  return bits.join(" · ");
}

function fmtSpan(ms) {
  return fmtSec(ms / 1000);
}

// tool → i18n key suffix (turn.action.*); resolved at call time.
const TOOL_LABEL = {
  bash: "command",
  shell: "command",
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  patch: "edit",
  grep: "grep",
  glob: "glob",
  list: "list",
  ls: "list",
  webfetch: "webfetch",
  websearch: "websearch",
  task: "task",
  todowrite: "todo",
  todoread: "todo",
};

// Short human label for the part that just moved; null = not an «action».
// Tool names only — never the raw command (non-admin screens must not leak it).
export function actionOf(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "tool") {
    const tool = String(part.tool ?? "").toLowerCase();
    if (!tool) return t("turn.action.tool");
    const base = tool.includes("_") && !TOOL_LABEL[tool] ? tool.split("_").slice(-1)[0] : tool;
    return TOOL_LABEL[base]
      ? t(`turn.action.${TOOL_LABEL[base]}`)
      : t("turn.action.toolNamed", { tool: tool.length > 32 ? `${tool.slice(0, 31)}…` : tool });
  }
  if (part.type === "text") return t("turn.action.text");
  if (part.type === "reasoning") return t("turn.action.reasoning");
  return null;
}
