// Turn-error classifier — ONE place for the client (src/lib/turn.js: the error
// card of a turn) and the server (FEAT-18.6: auto-relay on a subscription
// limit, which must work with the phone closed). Pure, zero dependencies,
// node- and browser-importable.
//
// kind: "empty" | "workdir" | "auth" | "limit" | "length" | "provider" |
//       "spawn" | "unknown"; null = not an error («Стоп» is the user's choice).

// Texts the Claude runner leaves as the answer of a failed turn (the CLI's
// own error result, a spawn failure). Only such a text in a SHORT tail answer
// counts as an error — a normal answer that quotes one must not.
export const CLAUDE_ERROR_TEXT_RE =
  /^(Не удалось запустить (claude|codex|ACP-агент) CLI|(Claude|Codex|Агент ACP) вернул ошибку|Требуется вход в аккаунт агента)|Please run \/login|OAuth token (has )?expired|Invalid API key|authentication_error|usage limit reached|Claude AI usage limit|hit your (\w+ )?limit/i;
export const CLAUDE_ERROR_TEXT_MAX = 2000;

const WORKDIR_RE = /platformerror|filesystem\.realpath|enoent|no such file or directory/;
const AUTH_RE = /unauthori[sz]ed|invalid api key|oauth|authenticat|please run \/login|требуется вход в аккаунт|\b401\b|forbidden|\b403\b/;
const LIMIT_RE = /rate.?limit|quota|\b429\b|too many requests|usage limit|limit (exceeded|reached)|hit your (\w+ )?limit|insufficient (balance|quota)|余额|exceeded your/;
const LENGTH_RE = /output length|max.?tokens/;
const PROVIDER_RE = /overloaded|\b5\d\d\b|timeout|timed out|econn|network|fetch failed|socket|unavailable/;

export function errText(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const m = err.data?.message ?? err.message ?? err.data?.error ?? "";
  return typeof m === "string" ? m : "";
}

export function errName(err) {
  return err && typeof err === "object" ? String(err.name ?? "") : "";
}

// session.error / info.error / an error text → kind (order matters: a 401
// that mentions a quota is an auth problem).
export function turnErrorKind(err, { engine = "opencode" } = {}) {
  if (err == null || err === false) return null;
  const name = errName(err);
  if (name === "MessageAbortedError") return null;
  if (name === "EmptyTurnError") return "empty";
  const raw = errText(err);
  const low = `${name} ${raw}`.toLowerCase();
  if ((engine === "claude" || engine === "codex" || engine === "acp") && /^Не удалось запустить (claude|codex|ACP-агент) CLI/i.test(raw)) return "spawn"; // FEAT-18.7 / BUG-295: ENOENT запуска — не папка чата
  if (WORKDIR_RE.test(low)) return "workdir";
  if (name === "ProviderAuthError" || AUTH_RE.test(low)) return "auth";
  if (LIMIT_RE.test(low)) return "limit";
  if (name === "MessageOutputLengthError" || LENGTH_RE.test(low)) return "length";
  if (PROVIDER_RE.test(low)) return "provider";
  if ((engine === "claude" || engine === "codex" || engine === "acp") && /^Не удалось запустить (claude|codex|ACP-агент) CLI/i.test(raw)) return "spawn"; // FEAT-18.7 / BUG-295
  return "unknown";
}

// A Claude answer text that IS an error report (the runner writes failures
// as the answer). isError: the CLI said so itself (result.is_error) — then
// any text counts; otherwise only a short known error text.
export function claudeAnswerError(text, { isError = false } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (isError) return t;
  return t.length < CLAUDE_ERROR_TEXT_MAX && CLAUDE_ERROR_TEXT_RE.test(t) ? t : null;
}

export function isLimitError(err, opts) {
  return turnErrorKind(err, opts) === "limit";
}
