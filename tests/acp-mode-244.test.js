// BUG-289: lib/claude.js передаёт в acp-shim.mjs явно вычисленный mode (не null).
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAcpMode } from "../lib/claude.js";

test("BUG-289: resolveAcpMode возвращает явный режим прав без null и без edits", () => {
  assert.equal(resolveAcpMode(null, true), "full");
  assert.equal(resolveAcpMode(undefined, true), "full");
  assert.equal(resolveAcpMode(null, false), "ask");
  assert.equal(resolveAcpMode("edits", true), "ask");
  assert.equal(resolveAcpMode("edits", false), "ask");
  assert.equal(resolveAcpMode("ask", true), "ask");
  assert.equal(resolveAcpMode("plan", true), "plan");
  assert.equal(resolveAcpMode("full", false), "ask");
});
