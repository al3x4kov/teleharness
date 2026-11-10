// Chat binding (lib/binding.js): resolution order, body coercion, PATCH
// rules and persistence. BUG-11.1 / BUG-11.2 / FEAT-11.3…11.5 (2026-11-02).
// Run: node --test tests/binding.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BindingStore, applyBinding, cleanModel, engineOf, makeBinding, patchBinding, resolveBinding } from "../lib/binding.js";

const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };

test("engineOf: anthropic is the claude CLI, everything else opencode", () => {
  assert.equal(engineOf("anthropic"), "claude");
  assert.equal(engineOf("zai-coding-plan"), "opencode");
  assert.equal(engineOf(undefined), "opencode");
});

test("cleanModel accepts portal and upstream shapes, rejects partial", () => {
  assert.deepEqual(cleanModel({ providerID: "zai", id: "glm-4.7" }), { providerID: "zai", modelID: "glm-4.7" });
  assert.deepEqual(cleanModel(GLM), GLM);
  assert.equal(cleanModel({ providerID: "zai" }), null);
  assert.equal(cleanModel(null), null);
});

test("makeBinding drops the agent for claude (BUG-11.2)", () => {
  assert.equal(makeBinding({ model: OPUS, agent: "Sisyphus - ultraworker" }).agent, null);
  assert.equal(makeBinding({ model: GLM, agent: "Sisyphus - ultraworker" }).agent, "Sisyphus - ultraworker");
  assert.equal(makeBinding({ model: null }), null);
});

test("resolveBinding: stored > upstream > claude history > null", () => {
  const stored = { engine: "claude", model: OPUS, agent: null, prompted: false };
  const upstream = { model: { id: "glm-5.3", providerID: "zai-coding-plan" }, agent: "Sisyphus - ultraworker" };
  assert.equal(resolveBinding({ stored, session: upstream }).source, "stored");
  const u = resolveBinding({ session: upstream, claudeKnown: true, claudeModelID: "claude-opus-5-5" });
  assert.equal(u.source, "upstream", "polluted chats return to their z.ai model");
  assert.equal(u.engine, "opencode");
  assert.equal(u.agent, "Sisyphus - ultraworker");
  assert.equal(u.prompted, true);
  const c = resolveBinding({ session: { id: "x" }, claudeKnown: true, claudeModelID: "claude-sonnet-5-5" });
  assert.equal(c.engine, "claude");
  assert.equal(c.model.modelID, "claude-sonnet-5-5");
  assert.equal(c.agent, null);
  assert.equal(resolveBinding({ session: { id: "x" } }), null);
});

test("applyBinding forces the chat's model; claude bodies lose the agent", () => {
  const body = { model: OPUS, agent: "Sisyphus - ultraworker", parts: [{ type: "text", text: "hi" }] };
  const toGlm = applyBinding(body, makeBinding({ model: GLM, agent: "build" }));
  assert.deepEqual(toGlm.model, GLM);
  assert.equal(toGlm.agent, "build");
  assert.deepEqual(toGlm.parts, body.parts);
  const toClaude = applyBinding({ model: GLM, agent: "Sisyphus - ultraworker" }, makeBinding({ model: OPUS }));
  assert.deepEqual(toClaude.model, OPUS);
  assert.equal("agent" in toClaude, false);
  // opencode binding without agent keeps the body's agent
  assert.equal(applyBinding({ agent: "plan" }, makeBinding({ model: GLM })).agent, "plan");
  assert.equal(body.model, OPUS, "input not mutated");
});

test("patchBinding: engine locked after the first prompt, free before", () => {
  const fresh = makeBinding({ model: GLM, agent: "Sisyphus - ultraworker" });
  const toClaude = patchBinding(fresh, { model: OPUS });
  assert.equal(toClaude.binding.engine, "claude");
  assert.equal(toClaude.binding.agent, null);
  const prompted = { ...fresh, prompted: true };
  assert.equal(patchBinding(prompted, { model: OPUS }).status, 409);
  const same = patchBinding(prompted, { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } });
  assert.equal(same.binding.model.modelID, "glm-5.3");
  assert.equal(same.binding.agent, "Sisyphus - ultraworker", "agent kept within the engine");
  assert.equal(same.binding.prompted, true);
  assert.equal(patchBinding(prompted, { agent: "plan" }).binding.agent, "plan");
  assert.equal(patchBinding(prompted, {}).status, 400);
  assert.equal(patchBinding(null, { agent: "plan" }).status, 400, "no model to attach the agent to");
  assert.equal(patchBinding(fresh, { model: { providerID: "x" } }).status, 400);
  // back from claude to opencode in an empty chat: agent comes from the patch
  const back = patchBinding(toClaude.binding, { model: GLM, agent: "Sisyphus - ultraworker" });
  assert.equal(back.binding.agent, "Sisyphus - ultraworker");
});

test("BindingStore persists atomically and forgets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zai-binding-"));
  try {
    const file = path.join(dir, "session-bindings.json");
    const a = new BindingStore({ storePath: file });
    a.set("ses_1", { ...makeBinding({ model: GLM, agent: "Sisyphus - ultraworker" }), prompted: true, source: "upstream" });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.sessions.ses_1.engine, "opencode");
    assert.equal("source" in raw.sessions.ses_1, false, "derived fields are not persisted");
    const b = new BindingStore({ storePath: file });
    assert.equal(b.get("ses_1").agent, "Sisyphus - ultraworker");
    assert.equal(b.get("ses_1").prompted, true);
    b.forget("ses_1");
    assert.equal(new BindingStore({ storePath: file }).get("ses_1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// BUG-13.6: a corrupt bindings file is moved aside, never overwritten by the
// next write (the routing of every chat depends on it).
test("BindingStore: corrupt file is quarantined as .corrupt-<ts>, not wiped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zai-binding-"));
  try {
    const file = path.join(dir, "session-bindings.json");
    writeFileSync(file, '{"version":1,"sessions":{"ses_1":', "utf8");
    const s = new BindingStore({ storePath: file });
    assert.equal(s.size(), 0);
    const aside = readdirSync(dir).filter((n) => n.startsWith("session-bindings.json.corrupt-"));
    assert.equal(aside.length, 1, "the broken file is kept aside");
    assert.equal(readFileSync(path.join(dir, aside[0]), "utf8"), '{"version":1,"sessions":{"ses_1":');
    s.set("ses_2", makeBinding({ model: GLM }));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions.ses_2.engine, "opencode");
    assert.equal(readdirSync(dir).some((n) => n.endsWith(".tmp")), false, "no tmp leftovers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared/engine.js is the single source of engine knowledge", async () => {
  const shared = await import("../shared/engine.js");
  const binding = await import("../lib/binding.js");
  assert.equal(binding.DEFAULT_CLAUDE_MODEL, shared.DEFAULT_CLAUDE_MODEL);
  assert.equal(binding.engineOf, shared.engineOf);
  assert.equal(shared.DEFAULT_CLAUDE_MODEL, shared.CLAUDE_MODELS[0].id);
  assert.match(shared.DEFAULT_CLAUDE_MODEL, /^claude-opus-/, "the freshest Opus tops the catalog (FEAT-11.10)");
  assert.equal(shared.isClaudeModel("claude-haiku-4-5"), true);
  assert.equal(shared.isClaudeModel("--version"), false);
  assert.deepEqual(shared.normalizeCatalog([{ id: "claude-x-1", name: "X" }, { id: "--evil" }, { id: "claude-x-1" }]), [{ id: "claude-x-1", name: "X", context: 200_000 }]);
  assert.equal(shared.normalizeCatalog([{ id: "nope" }]), null);
});