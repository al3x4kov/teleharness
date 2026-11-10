// FEAT-16.2 (EPIC-16, 2026-11-07): z.ai chats run on oh-my-opencode-slim instead of OmO.
// The framework is pinned, OmO is gone from the plugin list, every agent has the
// model + effort of its OmO role (TASK-16.1 pilot), every model is one opencode serves,
// and the primary agent falls back Flash → glm-5.3. Run:
//   node --test ops/opencode/tests/slim-config.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const DIR = path.resolve(import.meta.dirname, "..")
const oc = JSON.parse(fs.readFileSync(path.join(DIR, "opencode.json"), "utf8"))
const slim = JSON.parse(fs.readFileSync(path.join(DIR, "oh-my-opencode-slim.json"), "utf8"))
const SERVED = new Set(oc.provider["zai-coding-plan"].whitelist.map((id) => `zai-coding-plan/${id}`))
const EFFORTS = new Set(["low", "high", "max"])

/** Problems of a slim config: unpinned/mixed frameworks, unknown models, bad effort, primary without fallback. */
export function slimProblems(oc, slim, served = SERVED) {
  const bad = []
  const fw = oc.plugin.filter((p) => /^oh-my-opencode-slim(@|$)/.test(p))
  if (fw.length !== 1 || !/^oh-my-opencode-slim@\d+\.\d+\.\d+$/.test(fw[0] ?? "")) bad.push(`slim not pinned: ${JSON.stringify(fw)}`)
  if (oc.plugin.some((p) => /^oh-my-openagent|^oh-my-opencode(@|$)/.test(p))) bad.push("OmO still in plugin list")
  if (!oc.plugin.includes("./vault-cache.ts")) bad.push("vault-cache.ts missing")
  if (oc.default_agent !== "orchestrator") bad.push(`default_agent ${oc.default_agent}`)
  if (slim.autoUpdate !== false) bad.push("slim autoUpdate not false")
  if (slim.fallback?.enabled !== true) bad.push("fallback disabled")
  for (const [name, a] of Object.entries(slim.agents ?? {})) {
    const chain = Array.isArray(a.model) ? a.model : [{ id: a.model, variant: a.variant }]
    for (const [i, m] of chain.entries()) {
      if (!served.has(m.id)) bad.push(`${name}[${i}]: ${m.id} is not served`)
      if (!EFFORTS.has(m.variant)) bad.push(`${name}[${i}]: effort ${m.variant}`)
    }
  }
  const orch = slim.agents?.orchestrator?.model ?? []
  if (orch[0]?.id !== "zai-coding-plan/glm-5.3-flash" || orch[1]?.id !== "zai-coding-plan/glm-5.3") bad.push("orchestrator chain is not Flash → glm-5.3")
  return bad
}

test("the repo config is clean: slim pinned, OmO gone, vault-cache kept, orchestrator default", () => {
  assert.deepEqual(slimProblems(oc, slim), [])
})

test("each agent sends the model + effort of its OmO role (pilot TASK-16.1)", () => {
  const first = (a) => `${slim.agents[a].model[0].id.split("/")[1]}/${slim.agents[a].model[0].variant}`
  assert.deepEqual(
    Object.fromEntries(["orchestrator", "explorer", "oracle", "designer", "fixer", "observer"].map((a) => [a, first(a)])),
    { orchestrator: "glm-5.3-flash/max", explorer: "glm-5.3-flash/low", oracle: "glm-5.3/max", designer: "glm-5.3-flash/max", fixer: "glm-5.3-flash/high", observer: "glm-5.3-flash/low" },
  )
})

test("negative: the validator catches OmO left in, a range version, a dead model, a bad effort, a lost fallback", () => {
  const badOc = { ...oc, plugin: ["oh-my-openagent@5.1.62", "oh-my-opencode-slim@^3.0.0"], default_agent: "Sisyphus - ultraworker" }
  const badSlim = structuredClone(slim)
  badSlim.agents.explorer.model[0] = { id: "zai-coding-plan/glm-5.2", variant: "medium" }
  badSlim.agents.orchestrator.model = [{ id: "zai-coding-plan/glm-5.3-flash", variant: "max" }]
  const bad = slimProblems(badOc, badSlim)
  for (const re of [/slim not pinned/, /OmO still/, /vault-cache/, /default_agent/, /explorer\[0\]: .*glm-5\.2 is not served/, /explorer\[0\]: effort medium/, /orchestrator chain/])
    assert.ok(bad.some((b) => re.test(b)), `${re} in ${bad.join("; ")}`)
})

test("Hephaestus - deep worker (our agent, not OmO) and Sandbox stay in opencode.json", () => {
  assert.ok(oc.agent["Hephaestus - deep worker"])
  assert.ok(oc.agent.Sandbox)
})
