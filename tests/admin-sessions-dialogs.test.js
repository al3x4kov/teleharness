// BUG-264 п.3 (dogfood 2026-11-19, N3): Claude-чат, ждущий разрешения, в «Активных
// ходах» показан «работает» — отчёт хаба знает только вопросы opencode, запросы моста
// разрешений Claude (claude.dialogs()) в нём не учитывались.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withBridgeDialogs } from "../routes/admin.js";

test("BUG-264 п.3: запрос разрешения Claude делает строку «dialog» с числом и возрастом", () => {
  const now = 10_000;
  const report = [
    { sessionID: "ses_c", state: "busy", managed: true, since: 1_000, ageMs: 9_000, silentMs: 500, dialogs: 0, oldestDialogAt: null, stalled: false },
    { sessionID: "ses_o", state: "busy", managed: false, since: 2_000, ageMs: 8_000, silentMs: 100, dialogs: 0, oldestDialogAt: null, stalled: false },
  ];
  const out = withBridgeDialogs(report, [{ kind: "permission", sessionID: "ses_c", askedAt: 4_000 }, { kind: "permission", sessionID: "ses_c", askedAt: 3_000 }], now);
  const c = out.find((r) => r.sessionID === "ses_c");
  assert.equal(c.state, "dialog");
  assert.equal(c.dialogs, 2);
  assert.equal(c.oldestDialogAt, 3_000);
  assert.equal(c.stalled, false);
  assert.deepEqual(out.find((r) => r.sessionID === "ses_o"), report[1], "чужая строка не тронута");
});

test("BUG-264 п.3: запрос моста без строки в отчёте — новая строка «dialog»", () => {
  const out = withBridgeDialogs([], [{ kind: "permission", sessionID: "ses_x", askedAt: 5_000, directory: "/w" }], 6_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].state, "dialog");
  assert.equal(out[0].dialogs, 1);
  assert.equal(out[0].dir, "/w");
  assert.equal(out[0].ageMs, 1_000);
});
