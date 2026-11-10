// BUG-180 (BUG-11.16): an opencode turn on zai-coding-plan/glm-5.3* without
// `variant` gets ZAI_GLM_VARIANT (default max) — the effort no longer depends
// on the provider's default; an explicit variant and other models are untouched.
// Run: node --test tests/glm-variant.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { withGlmVariant, withGlmVariantBody, GLM_VARIANTS } from "../lib/glm-variant.js";
import { loadConfig } from "../lib/config.js";

const GLM = (modelID) => ({ providerID: "zai-coding-plan", modelID });

test("glm-5.3-flash and glm-5.3 without variant → the configured variant", () => {
  assert.equal(withGlmVariant({ model: GLM("glm-5.3-flash"), parts: [] }, "max").variant, "max");
  assert.equal(withGlmVariant({ model: GLM("glm-5.3") }, "high").variant, "high");
  assert.equal(withGlmVariant({ model: GLM("glm-5.3-flashx") }, "low").variant, "low");
});

test("an explicit variant is kept, even an unknown one (opencode decides)", () => {
  assert.equal(withGlmVariant({ model: GLM("glm-5.3-flash"), variant: "low" }, "max").variant, "low");
  assert.equal(withGlmVariant({ model: GLM("glm-5.3-flash"), variant: "xhigh" }, "max").variant, "xhigh");
});

test("other providers/models, no model, off or invalid setting → body unchanged (same object)", () => {
  const cases = [
    { model: { providerID: "zai", modelID: "glm-4.5" } },
    { model: { providerID: "anthropic", modelID: "claude-opus-5-5" } },
    { model: GLM("glm-4.7-flash") },
    { parts: [] },
    null,
  ];
  for (const b of cases) assert.equal(withGlmVariant(b, "max"), b);
  const flash = { model: GLM("glm-5.3-flash") };
  for (const v of ["off", "", "bogus", undefined]) assert.equal(withGlmVariant(flash, v), flash, `setting ${v}`);
  assert.equal("variant" in flash, false, "the input is never mutated");
});

test("Buffer body: rewritten only when needed; non-JSON passes through", () => {
  const buf = Buffer.from(JSON.stringify({ model: GLM("glm-5.3-flash"), parts: [{ type: "text", text: "hi" }] }));
  const out = JSON.parse(withGlmVariantBody(buf, "max").toString("utf8"));
  assert.equal(out.variant, "max");
  assert.deepEqual(out.parts, [{ type: "text", text: "hi" }]);
  const same = Buffer.from(JSON.stringify({ model: GLM("glm-5.3-flash"), variant: "low" }));
  assert.equal(withGlmVariantBody(same, "max"), same);
  const junk = Buffer.from("not json");
  assert.equal(withGlmVariantBody(junk, "max"), junk);
});

test("config: ZAI_GLM_VARIANT defaults to max, accepts low|high|max|off, rejects others", () => {
  assert.deepEqual(GLM_VARIANTS, ["off", "low", "high", "max"]);
  assert.equal(loadConfig({}).config.ZAI_GLM_VARIANT, "max");
  for (const v of ["low", "high", "max", "off"]) assert.equal(loadConfig({ ZAI_GLM_VARIANT: v }).config.ZAI_GLM_VARIANT, v);
  const bad = loadConfig({ ZAI_GLM_VARIANT: "medium" });
  assert.ok(bad.errors.some((e) => /ZAI_GLM_VARIANT/.test(e)), JSON.stringify(bad.errors));
  assert.equal(bad.config.ZAI_GLM_VARIANT, "max", "falls back to the default");
});
