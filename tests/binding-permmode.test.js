// FEAT-18.4: the chat's permission mode in the binding (lib/binding.js) —
// PATCH validation, persistence, role defaults, opencode 2.x session rules.
// Run: node --test tests/binding-permmode.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BindingStore, cleanPermMode, effectivePermMode, makeBinding, ocPermRules, patchBinding, resolveBinding } from "../lib/binding.js";

const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };

test("cleanPermMode / makeBinding: only ask|edits|full; absent = no field (old records unchanged)", () => {
  assert.equal(cleanPermMode("ask"), "ask");
  assert.equal(cleanPermMode("bypassPermissions"), null);
  assert.deepEqual(makeBinding({ model: OPUS }), { engine: "claude", model: OPUS, agent: null, prompted: false });
  assert.equal(makeBinding({ model: OPUS, permMode: "ask" }).permMode, "ask");
  assert.equal("permMode" in makeBinding({ model: OPUS, permMode: "junk" }), false);
});

test("patchBinding: permMode alone, null resets, bad value 400, kept across model/agent patches", () => {
  const cur = makeBinding({ model: OPUS }, { prompted: true });
  const a = patchBinding(cur, { permMode: "ask" });
  assert.equal(a.binding.permMode, "ask");
  assert.equal(a.binding.prompted, true);
  assert.equal(patchBinding(a.binding, { model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } }).binding.permMode, "ask", "a model change keeps the mode");
  assert.equal("permMode" in patchBinding(a.binding, { permMode: null }).binding, false);
  assert.deepEqual(patchBinding(cur, { permMode: "root" }), { status: 400, error: "bad permission mode" });
  assert.equal(patchBinding(null, { permMode: "ask" }).status, 400, "an unbound chat names its model with the mode");
  assert.equal(patchBinding(null, { model: OPUS, permMode: "edits" }).binding.permMode, "edits");
});

test("effectivePermMode: role defaults; a tenant never runs «full»", () => {
  assert.equal(effectivePermMode(null, { admin: true }), "full");
  assert.equal(effectivePermMode(null, { admin: false }), "edits");
  assert.equal(effectivePermMode({ permMode: "ask" }, { admin: false }), "ask");
  assert.equal(effectivePermMode({ permMode: "full" }, { admin: false }), "edits");
  assert.equal(effectivePermMode({ permMode: "edits" }, { admin: true }), "edits");
});

test("ocPermRules: ask/edits rules, full = [] (server rules), none = no override", () => {
  assert.deepEqual(ocPermRules("ask"), [{ action: "edit", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }]);
  assert.deepEqual(ocPermRules("edits"), [{ action: "edit", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }]);
  assert.deepEqual(ocPermRules("full"), []);
  assert.equal(ocPermRules(null), null);
  assert.equal(GLM.providerID, "zai-coding-plan");
});

test("BindingStore: permMode persists and resolves", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "teleharness-permmode-store-"));
  try {
    const file = path.join(dir, "b.json");
    const s = new BindingStore({ storePath: file });
    s.set("x", makeBinding({ model: OPUS, permMode: "ask" }, { prompted: true }));
    s.set("y", makeBinding({ model: GLM }));
    const again = new BindingStore({ storePath: file });
    assert.equal(again.get("x").permMode, "ask");
    assert.equal("permMode" in again.get("y"), false);
    assert.equal(resolveBinding({ stored: again.get("x") }).permMode, "ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
