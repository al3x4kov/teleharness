// BUG-180 / BUG-11.16 (2026-11-06): the opencode/OmO config of the GLM profile
// must reference only models opencode really serves. glm-5.2 became
// `deprecated` in models.dev and opencode 1.19.5 dropped it from the catalog,
// so every OmO fallback to it was dead (ProviderModelNotFoundError). Run:
//   node --test ops/opencode/tests/glm-config.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DIR = path.resolve(import.meta.dirname, "..")
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8")

/** JSONC → JSON: drops // and /* *\/ comments outside strings, trailing commas. */
function parseJsonc(src) {
  let out = ""
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1
      out += src.slice(i, j + 1)
      i = j
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

/** Every "provider/model" an OmO config names, with where it is used. */
function omoModels(omo) {
  const out = []
  for (const kind of ["agents", "categories"])
    for (const [name, v] of Object.entries(omo[kind] ?? {})) {
      if (typeof v?.model === "string") out.push({ where: `${kind}.${name}`, model: v.model })
      for (const [i, m] of (v?.models ?? []).entries()) out.push({ where: `${kind}.${name}[${i}]`, model: m.model, reasoning: m.reasoning })
    }
  return out
}

/** Models opencode would expose: catalog minus deprecated, filtered by whitelist/blacklist. */
function served(catalogProvider, cfgProvider = {}) {
  return Object.entries(catalogProvider.models)
    .filter(([id, m]) => m.status !== "deprecated")
    .filter(([id]) => !cfgProvider.whitelist || cfgProvider.whitelist.includes(id))
    .filter(([id]) => !cfgProvider.blacklist?.includes(id))
    .map(([id]) => `zai-coding-plan/${id}`)
}

/** Problems of a GLM profile: unknown models, wrong effort, vision categories on text models, dupes. */
function problems(omo, servedSet, catalog) {
  const bad = []
  for (const { where, model, reasoning } of omoModels(omo)) {
    if (!servedSet.has(model)) bad.push(`${where}: ${model} is not served`)
    const id = model.split("/")[1]
    const effort = catalog.models[id]?.reasoning_options?.find((o) => o.type === "effort")?.values
    if (reasoning && effort && !effort.includes(reasoning)) bad.push(`${where}: reasoning ${reasoning} not in ${effort}`)
  }
  for (const kind of ["agents", "categories"])
    for (const [name, v] of Object.entries(omo[kind] ?? {})) {
      const ids = (v.models ?? []).map((m) => m.model)
      // the same model twice IN A ROW is a mistake; A, B, A is the deliberate runtime-fallback pattern (BUG-180)
      if (ids.some((x, i) => i > 0 && ids[i - 1] === x)) bad.push(`${kind}.${name}: duplicate models`)
    }
  for (const name of ["visual-engineering"]) {
    const first = omo.categories?.[name]?.models?.[0]?.model?.split("/")[1]
    if (first && catalog.models[first]?.attachment !== true) bad.push(`categories.${name}: first model ${first} has no vision`)
  }
  for (const name of ["multimodal-looker"]) {
    for (const m of omo.agents?.[name]?.models ?? [])
      if (catalog.models[m.model.split("/")[1]]?.attachment !== true) bad.push(`agents.${name}: ${m.model} has no vision`)
  }
  return bad
}

// The models.dev entry opencode 1.19.5 cached on this host; a pinned fallback
// copy of the relevant fields keeps the test meaningful on a clean machine.
const CACHE = path.join(os.homedir(), ".cache", "opencode", "models.json")
const FALLBACK = {
  models: {
    "glm-5.3": { attachment: false, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
    "glm-5.3-flash": { attachment: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
    "glm-5.3-highspeed": { attachment: false, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
    "glm-5.2": { status: "deprecated", attachment: false, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }] },
  },
}
const catalog = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8"))["zai-coding-plan"] : FALLBACK
const omo = parseJsonc(read("omo.jsonc"))
const oc = JSON.parse(read("opencode.json"))
const provider = oc.provider["zai-coding-plan"]
const servedSet = new Set(served(catalog, provider))

test("served set: whitelist leaves exactly glm-5.3 and glm-5.3-flash; deprecated glm-5.2 is gone", () => {
  assert.deepEqual([...servedSet].sort(), ["zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash"])
  assert.equal(served(catalog).includes("zai-coding-plan/glm-5.2"), false, "opencode drops deprecated models even without a whitelist")
})

test("omo.jsonc: every chain names served models with valid effort; vision roles start with a vision model", () => {
  assert.deepEqual(problems(omo, servedSet, catalog), [])
  assert.equal(omo.categories["visual-engineering"].models[0].model, "zai-coding-plan/glm-5.3-flash")
  // the main roles keep a fallback (runtime_fallback has somewhere to go)
  for (const a of ["sisyphus", "oracle", "prometheus", "metis", "momus", "atlas", "sisyphus-junior"])
    assert.ok(omo.agents[a].models.length >= 2, `${a} has a fallback`)
})

test("negative: the validator catches the old dead fallback, a bad effort, a text-only vision category, a dupe", () => {
  const old = {
    agents: { sisyphus: { models: [{ model: "zai-coding-plan/glm-5.3", reasoning: "high" }, { model: "zai-coding-plan/glm-5.2", reasoning: "high" }] }, explore: { models: [{ model: "zai-coding-plan/glm-5.3-flash", reasoning: "medium" }] } },
    categories: { "visual-engineering": { models: [{ model: "zai-coding-plan/glm-5.3", reasoning: "high" }, { model: "zai-coding-plan/glm-5.3", reasoning: "low" }] } },
  }
  const bad = problems(old, servedSet, catalog)
  assert.ok(bad.some((b) => /sisyphus\[1\].*glm-5\.2 is not served/.test(b)), bad.join("\n"))
  assert.ok(bad.some((b) => /explore.*reasoning medium/.test(b)), bad.join("\n"))
  assert.ok(bad.some((b) => /visual-engineering: first model glm-5\.3 has no vision/.test(b)), bad.join("\n"))
  assert.ok(bad.some((b) => /visual-engineering: duplicate/.test(b)), bad.join("\n"))
  assert.ok(problems({ agents: { x: { models: [{ model: "zai-coding-plan/glm-5.3-highspeed" }] } } }, servedSet, catalog).length === 1, "highspeed is hidden by the whitelist")
})

test("opencode.json: Flash compacts by ~262K, pruning on, rules file in instructions, models still the plan's", () => {
  assert.deepEqual(provider.models["glm-5.3-flash"].limit, { context: 262144, output: 131072 })
  assert.deepEqual(oc.compaction, { auto: true, prune: true })
  assert.ok(oc.instructions.some((p) => /prompts[\\/]glm-rules\.md$/.test(p)))
  assert.ok(fs.existsSync(path.join(DIR, "prompts", "glm-rules.md")))
  assert.equal(oc.model, "zai-coding-plan/glm-5.3")
  assert.equal(oc.small_model, "zai-coding-plan/glm-5.3-flash")
  for (const [name, a] of Object.entries(oc.agent)) if (a.model) assert.ok(servedSet.has(a.model), `agent ${name}: ${a.model}`)
})

// OmO runtime_fallback (5.1.62 dist: getRawFallbackModelsForSession / findNextAvailableFallback /
// prepareFallback): the session's current model is DERIVED from the agent config (models[0]), not
// from the model the portal sent; fallbacks = models.slice(1); a candidate equivalent to the current
// one is skipped; the model failed "from" goes to cooldown; at most max_fallback_attempts switches.
// Returns the model the turn finally runs on, or null (OmO aborts opencode's own retry → empty turn).
function simulateFallback(chain, failing, { cooldown, maxAttempts }) {
  const fallbacks = chain.slice(1)
  let current = chain[0], index = -1, attempts = 0
  const failed = new Map()
  let now = 0
  for (;;) {
    if (attempts >= maxAttempts) return null
    let next = null
    for (let i = index + 1; i < fallbacks.length; i++) {
      if (fallbacks[i] === current) continue
      if (failed.has(fallbacks[i]) && now - failed.get(fallbacks[i]) < cooldown * 1000) continue
      next = fallbacks[i]
      index = i
      break
    }
    if (!next) return null
    failed.set(current, now)
    attempts++
    current = next
    now += 1 // retries happen within a second
    if (current !== failing) return current
  }
}
const PRIMARY = ["sisyphus", "prometheus", "atlas"] // agents the portal starts with ITS model (Flash by default)
const chainOf = (a) => omo.agents[a].models.map((m) => m.model.split("/")[1])
const rf = () => omo["[opencode]"].runtime_fallback

test("fallback: a portal Flash chat whose Flash is rate-limited ends on glm-5.3 (and vice versa) for every primary agent", () => {
  for (const a of PRIMARY)
    for (const [failing, other] of [["glm-5.3-flash", "glm-5.3"], ["glm-5.3", "glm-5.3-flash"]])
      assert.equal(simulateFallback(chainOf(a), failing, { cooldown: rf().cooldown_seconds, maxAttempts: rf().max_fallback_attempts }), other, `${a}: ${failing} 429`)
})

test("negative: the 2026-11-06 config (2-model chain, cooldown 60) left a Flash chat with no answer — the simulator reproduces it", () => {
  assert.equal(simulateFallback(["glm-5.3", "glm-5.3-flash"], "glm-5.3-flash", { cooldown: 60, maxAttempts: 2 }), null)
  assert.equal(simulateFallback(["glm-5.3", "glm-5.3-flash", "glm-5.3"], "glm-5.3-flash", { cooldown: 60, maxAttempts: 2 }), null, "the 3-model chain alone is not enough: glm-5.3 sits in cooldown")
  assert.equal(simulateFallback(["glm-5.3", "glm-5.3-flash"], "glm-5.3", { cooldown: 60, maxAttempts: 2 }), "glm-5.3-flash", "a glm-5.3 chat always worked")
})

// FEAT-16.2: the working framework is oh-my-opencode-slim (tests/slim-config.test.mjs);
// omo.jsonc stays in ops only as the rollback source and must stay a valid pinned OmO config.
test("rollback source omo.jsonc keeps OmO auto-update off; opencode autoupdate off", () => {
  assert.equal(oc.autoupdate, false)
  assert.equal(omo["[opencode]"].auto_update, false)
})

test("serve.cmd raises the opencode output cap to 65536", () => {
  assert.match(read("serve.cmd"), /^set OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536\r?$/m)
})
