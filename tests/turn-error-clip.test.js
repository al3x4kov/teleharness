// BUG-264 п.9 (dogfood 2026-11-19, группа A): clip() в src/lib/turn.js схлопывал
// буквы «s» вместо пробелов (/s+/g вместо /\s+/g): «Requests» → «Reque t » в
// подробностях карточки ошибки хода.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTurnError } from "../src/lib/turn.js";

test("BUG-264 п.9: подробности ошибки хода не теряют букву «s», пробелы схлопываются", () => {
  const d = describeTurnError({ name: "APIError", data: { message: "Too many   Requests\n\nfrom z.ai, status 429" } });
  const text = JSON.stringify(d);
  assert.ok(text.includes("Too many Requests from z.ai, status 429"), text);
  assert.ok(!/Reque t/.test(text), text);
});
