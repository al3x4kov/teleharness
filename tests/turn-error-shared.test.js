// FEAT-18.6: один классификатор ошибки хода для клиента (карточка ошибки) и сервера
// (авто-передача при лимите) — shared/turn-error.js.
// Run: node --test tests/turn-error-shared.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAnswerError, isLimitError, turnErrorKind } from "../shared/turn-error.js";
import { describeTurnError, turnErrorFromMessages } from "../src/lib/turn.js";

const LIMITS = [
  "Claude AI usage limit reached|1731000000",
  "You've hit your limit · resets 3pm (Europe/Moscow)",
  { name: "APIError", data: { message: "429 Too Many Requests" } },
  { name: "APIError", data: { message: "Rate limit exceeded for GLM Coding Plan" } },
  { name: "UnknownError", data: { message: "Insufficient balance or no resource package" } },
  { name: "APIError", data: { message: "余额不足" } },
];
const NOT_LIMITS = [
  { name: "MessageAbortedError" },
  { name: "ProviderAuthError", data: { message: "quota key invalid" } },
  "OAuth token has expired",
  { name: "APIError", data: { message: "503 overloaded" } },
  { name: "MessageOutputLengthError" },
  "boom",
];

test("FEAT-18.6: признаки лимита — Claude CLI и z.ai/opencode", () => {
  for (const e of LIMITS) assert.equal(turnErrorKind(e), "limit", JSON.stringify(e));
  for (const e of LIMITS) assert.equal(isLimitError(e, { engine: "claude" }), true, JSON.stringify(e));
  for (const e of NOT_LIMITS) assert.notEqual(turnErrorKind(e), "limit", JSON.stringify(e));
  assert.equal(turnErrorKind({ name: "MessageAbortedError" }), null, "«Стоп» — не ошибка");
  assert.equal(turnErrorKind(null), null);
});

test("FEAT-18.6: клиентская карточка берёт вид у общего классификатора", () => {
  for (const e of [...LIMITS, ...NOT_LIMITS, { name: "EmptyTurnError" }, "ENOENT: no such file or directory"]) {
    assert.equal(describeTurnError(e)?.kind ?? null, turnErrorKind(e), JSON.stringify(e));
  }
  assert.equal(describeTurnError("Claude AI usage limit reached", { engine: "claude" }).title, "Исчерпан лимит подписки Claude");
});

test("FEAT-18.6: ответ Claude как отчёт об ошибке — короткий известный текст или is_error", () => {
  assert.equal(claudeAnswerError("Claude AI usage limit reached|1731000000"), "Claude AI usage limit reached|1731000000");
  assert.equal(claudeAnswerError("Обычный ответ про rate limit в nginx"), null, "обычный ответ — не ошибка");
  assert.equal(claudeAnswerError("x".repeat(2100) + " usage limit reached"), null, "длинный ответ — не ошибка");
  assert.equal(claudeAnswerError("boom", { isError: true }), "boom", "is_error — любой текст");
  assert.equal(claudeAnswerError(""), null);
  // клиент по истории видит то же самое
  const msgs = [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Claude AI usage limit reached|1" }] }];
  assert.equal(turnErrorFromMessages(msgs, { engine: "claude" })?.kind, "limit");
});
