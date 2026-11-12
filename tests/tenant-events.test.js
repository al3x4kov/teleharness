// BUG-197: события opencode 2.x, которые портал не переводит в язык 1.x (shell.created,
// mcp.status.changed, session.inbox.enqueued, …), шли тенанту как есть — со строкой
// запуска jail, именами MCP admin и снапшотом базы знаний с серверными путями.
// Политика: тенанту — только типы, которые понимает фронт (белый список), tool/patch-части — редактированные.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantEvent } from "../lib/policy.js";

const ev = (type, properties = {}) => JSON.stringify({ type, properties });

test("BUG-197: незнакомые фронту типы v2 тенанту не уходят", () => {
  for (const t of ["shell.created", "shell.output", "mcp.status.changed", "session.inbox.enqueued", "session.tool.unknown", "lsp.updated", "file.watcher.updated"]) {
    assert.equal(tenantEvent(ev(t, { command: "zai-jail.exe --cafile D:\\x", text: "SNAP" })), null, t);
  }
});

test("BUG-197: типы, которые обрабатывает фронт, проходят", () => {
  for (const t of ["session.status", "session.idle", "session.error", "session.updated", "session.created", "session.deleted",
    "message.updated", "message.removed", "message.part.removed", "message.part.delta",
    "permission.asked", "permission.replied", "question.asked", "question.updated", "zai.resync", "zai.session.title", "zai.turn.incomplete"]) {
    const data = ev(t, { sessionID: "ses_1" });
    assert.equal(tenantEvent(data), data, t);
  }
});

test("BUG-197: tool-часть тенанта редактируется как раньше (FEAT-12.16)", () => {
  const data = ev("message.part.updated", { sessionID: "s", part: { id: "p", type: "tool", tool: "bash", state: { status: "completed", input: { command: "zai-jail.exe run" }, output: "x" } } });
  const out = tenantEvent(data);
  assert.ok(out, "кадр не выброшен");
  assert.notEqual(out, data, "tool-часть переписана redactPart");
  const text = ev("message.part.updated", { sessionID: "s", part: { id: "t", type: "text", text: "привет" } });
  assert.equal(tenantEvent(text), text, "текстовая часть — без изменений");
});

test("BUG-197: битый JSON и кадр без типа — не утекают", () => {
  assert.equal(tenantEvent("{oops"), null);
  assert.equal(tenantEvent(JSON.stringify({ properties: {} })), null);
});

// BUG-201: тенант может только ОТКЛОНИТЬ запрос shell/внешней папки/doom_loop. В 2.2.6
// запрос несёт `action` (и shell вместо bash) — правило по `permission` молча не срабатывало.
import { tenantMustReject } from "../lib/policy.js";
test("BUG-201: tenantMustReject — v1 `permission` и v2 `action` (shell = bash)", () => {
  assert.equal(tenantMustReject({ permission: "bash" }), true);
  assert.equal(tenantMustReject({ action: "shell" }), true);
  assert.equal(tenantMustReject({ action: "external_directory" }), true);
  assert.equal(tenantMustReject({ action: "doom_loop" }), true);
  assert.equal(tenantMustReject({ action: "edit" }), false);
  assert.equal(tenantMustReject({ permission: "webfetch" }), false);
  assert.equal(tenantMustReject(null), false);
});
