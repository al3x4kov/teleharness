// BUG-180 / BUG-11.16 of vault-cache.ts (2026-11-06): oh-my-openagent ≤ 5.1.62
// keeps a GLM-5.2-era registry (reasoningEfforts high|max, alias low → high), so
// every `low` on GLM-5.3 / GLM-5.3-Flash reached the API as `high` (stand tap:
// title, explore, librarian, multimodal-looker, quick, explicit variant low).
// GLM-5.3* accepts low|high|max (models.dev). vault-cache runs after OmO and
// restores the requested effort. Run:
//   node --test ops/opencode/tests/vault-cache-effort.test.mjs
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-effort-"))
const P = (...x) => path.join(ROOT, ...x)
let hooks

before(async () => {
  for (const d of [P("vault", "agents"), P("data")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("data", "users.json"), JSON.stringify({ users: [] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("data", "users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  hooks = await mod.default({ client: { session: { get: async () => ({ data: null }), messages: async () => ({ data: [] }) } } })
})
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

// what opencode passes to chat.params after OmO has run
const params = async ({ agent = "Sisyphus - ultraworker", providerID = "zai-coding-plan", modelID = "glm-5.3-flash", message = {}, effort = "high" } = {}) => {
  const output = { temperature: undefined, options: effort === null ? {} : { reasoningEffort: effort, thinking: { type: "enabled", clear_thinking: false } } }
  await hooks["chat.params"]({ sessionID: "ses_x", agent, model: { providerID, modelID, id: modelID }, provider: { id: providerID }, message }, output)
  return output
}

test("explicit low (user message model.variant) survives OmO's low → high", async () => {
  const o = await params({ message: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash", variant: "low" } } })
  assert.equal(o.options.reasoningEffort, "low")
  assert.deepEqual(o.options.thinking, { type: "enabled", clear_thinking: false }, "other options untouched")
})

test("OmO agent variant (message.variant low, e.g. explore / quick) → low; glm-5.3 too", async () => {
  assert.equal((await params({ agent: "explore", message: { variant: "low" } })).options.reasoningEffort, "low")
  assert.equal((await params({ modelID: "glm-5.3", message: { variant: "low" } })).options.reasoningEffort, "low")
})

test("the title agent always runs on low (opencode small options), whatever the turn variant", async () => {
  assert.equal((await params({ agent: "title", message: { model: { variant: "max" } } })).options.reasoningEffort, "low")
})

test("max and high stay; the user's model.variant wins over OmO's message.variant", async () => {
  assert.equal((await params({ message: { model: { variant: "max" } }, effort: "max" })).options.reasoningEffort, "max")
  assert.equal((await params({ message: { model: { variant: "max" }, variant: "high" }, effort: "high" })).options.reasoningEffort, "max")
})

test("negative: no requested variant → the effort opencode/OmO chose is left as is (also absent)", async () => {
  assert.equal((await params({ message: {} })).options.reasoningEffort, "high")
  assert.equal("reasoningEffort" in (await params({ message: {}, effort: null })).options, false)
})

test("negative: other providers, other GLM generations and unknown values are never touched", async () => {
  assert.equal((await params({ providerID: "zai", modelID: "glm-4.5", message: { variant: "low" } })).options.reasoningEffort, "high")
  assert.equal((await params({ modelID: "glm-5.2", message: { variant: "low" } })).options.reasoningEffort, "high")
  assert.equal((await params({ providerID: "anthropic", modelID: "claude-opus-5-5", agent: "title" })).options.reasoningEffort, "high")
  assert.equal((await params({ message: { variant: "medium" } })).options.reasoningEffort, "high")
  assert.equal((await params({ message: { variant: "xhigh" } })).options.reasoningEffort, "high")
})

test("a malformed input never throws", async () => {
  await hooks["chat.params"]({}, {})
  await hooks["chat.params"](null, null)
})
