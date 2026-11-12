// FEAT-16.3 (tasks 5.1): native-конфиг opencode 2.x (opencode.v2.json) валиден
// по форме v2 (config-map.md) и Sandbox изолирован по правилам, которые v2
// отдаст в GET /api/agent (форма {name, mode, permissions:[{action,resource,effect}]}
// — lib/policy.js v2Ruleset нормализует её в словарь v1, задачи 3.9).
// Запуск: node --test ops/opencode/tests/opencode-v2-config.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { agentCan, agentIsSandboxed, tenantAgents, setTenantVaultRoots } from "../../../lib/policy.js"

const DIR = path.resolve(import.meta.dirname, "..")
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8")

// opencode.v2.json is written for this tenant knowledge-base root (the portal default is ~/.zai/tenants-vault)
setTenantVaultRoots(["D:\\Obsidian\\tenants"])

const cfg = JSON.parse(read("opencode.v2.json")) // строго JSON: .json, не .jsonc
const v1 = JSON.parse(read("opencode.json")) // источник значений 1.x для сверки

// Форма агента, которую v2 отдаёт в GET /api/agent (config-map, живая проверка
// :4099): кастомные агенты конфига + встроенные. mode у конфиг-агентов, у
// встроенных (build/general/…) — тоже primary, permissions нет.
function agentListView() {
  const custom = Object.entries(cfg.agents).map(([name, a]) => ({
    name,
    mode: a.mode ?? "subagent",
    hidden: a.hidden,
    permissions: a.permissions,
  }))
  return [...custom, { name: "build", mode: "primary" }, { name: "general", mode: "primary" }]
}

// Живой доп-формы «permissions-алиасов» не проверяем: у built-ins поля нет.
const V2_ACTIONS = new Set([
  "*", "read", "glob", "grep", "edit", "question", "webfetch", "websearch",
  "codesearch", "shell", "subagent", "skill", "external_directory",
  "context7_*", "grep_app_*", "marketplace_*",
])

test("форма v2: native-ключи, ни одного V1-ключа, JSON парсится строго", () => {
  for (const k of ["plugin", "provider", "agent", "permission", "autoupdate", "snapshot", "small_model", "enabled_providers", "command"]) {
    assert.equal(k in cfg, false, `V1-ключ ${k} не должен попасть в native-конфиг`)
  }
  assert.equal(cfg.$schema, "https://opencode.ai/config.json")
  assert.equal(cfg.model, v1.model, "корневая модель та же, что в 1.x")
  assert.equal(cfg.update, "disable") // autoupdate:false
  assert.equal(cfg.share, "disabled")
  assert.equal(cfg.snapshots, false) // snapshot:false
  assert.deepEqual(cfg.compaction, { auto: true }) // prune выброшен: v2 игнорирует с warning
  for (const k of ["agents", "providers", "policies", "permissions", "mcp", "instructions", "watcher"]) {
    assert.ok(cfg[k] !== undefined, `нет ключа ${k}`)
  }
})

test("default_agent = orchestrator, и агент объявлен явно (без V1-плагинов он ниоткуда не придёт)", () => {
  assert.equal(cfg.default_agent, "orchestrator")
  const o = cfg.agents.orchestrator
  assert.ok(o, "orchestrator объявлен в agents")
  assert.equal(o.mode, "primary")
  assert.equal(o.disabled, undefined)
})

test("small_model → agents.title.model = Flash; лимит Flash 262K перенесён", () => {
  assert.equal(cfg.agents.title?.model, v1.small_model)
  const p = cfg.providers["zai-coding-plan"]
  assert.equal(p.settings?.timeout, v1.provider["zai-coding-plan"].options.timeout)
  assert.deepEqual(p.models["glm-5.3-flash"].limit, v1.provider["zai-coding-plan"].models["glm-5.3-flash"].limit)
  assert.equal("whitelist" in p, false, "whitelist в v2 нет аналога — его заменяют policies")
})

test("policies = whitelist-эквивалент: deny всем провайдерам, allow zai-coding-plan (последний выигрывает)", () => {
  assert.deepEqual(cfg.policies, [
    { action: "provider.use", resource: "*", effect: "deny" },
    { action: "provider.use", resource: "zai-coding-plan", effect: "allow" },
  ])
})

test("whitelist 1.x на уровне моделей: glm-5.3-highspeed скрыт нативным disabled, включённые модели — только из whitelist", () => {
  // V1 whitelist ["glm-5.3","glm-5.3-flash"] (BUG-180: glm-5.3-highspeed зависала у
  // провайдера и в 1.x исключена). В v2 policies действия уровня модели НЕТ
  // (@opencode/schema@2.2.6, Config.Info: action ∈ provider.use|tool.use|
  // integration.connect|integration.use|mcp.use|skill.use|plugin.use|websearch.use),
  // а карта providers.<id>.models для авторизованного провайдера МЕРЖИТСЯ с
  // каталогом (на стенде v2 glm-5.3 виден без объявления в карте). Нативное
  // ограничение одной модели — disabled: true
  // (https://opencode.ai/docs/providers: «Removes the model from selection when
  // true»; https://opencode.ai/docs/models: «Add disabled: true to hide a model
  // from the available catalog»; поле есть в схеме 2.2.6 — ConfigProvider.ModelConfig).
  const whitelist = v1.provider["zai-coding-plan"].whitelist
  assert.deepEqual(whitelist, ["glm-5.3", "glm-5.3-flash"])
  const models = cfg.providers["zai-coding-plan"].models
  assert.equal(
    models["glm-5.3-highspeed"]?.disabled,
    true,
    "glm-5.3-highspeed исключён каталога нативным disabled:true (аналог отсутствия в whitelist 1.x)",
  )
  for (const [id, m] of Object.entries(models)) {
    if (whitelist.includes(id)) {
      assert.notEqual(m.disabled, true, `${id} из whitelist не должен выключаться`)
    } else {
      assert.equal(m.disabled, true, `${id} вне whitelist должен быть disabled:true`)
    }
  }
  // glm-5.3 из whitelist в карте не объявлен — и не должен: в 1.x у него не было
  // лимитов, он включён из каталога по умолчанию (корневой model).
  assert.equal(models["glm-5.3"]?.disabled ?? undefined, undefined, "glm-5.3 остаётся включённым из каталога")
})

test("permissions (общие): broad allow первыми, 21 ask-паттерн после, имена v2 (shell)", () => {
  const perms = cfg.permissions
  const asks = perms.filter((r) => r.effect === "ask")
  const v1Asks = Object.entries(v1.permission.bash).filter(([, a]) => a === "ask").map(([r]) => r)
  assert.equal(asks.length, v1Asks.length)
  assert.deepEqual(asks.map((r) => r.resource), v1Asks, "набор ask-паттернов совпадает с 1.x бит в бит")
  const firstAsk = perms.findIndex((r) => r.effect === "ask")
  const broad = perms.slice(0, firstAsk)
  for (const a of ["edit", "webfetch", "shell"]) {
    assert.ok(broad.some((r) => r.action === a && r.resource === "*" && r.effect === "allow"), `broad ${a} allow до ask-паттернов`)
  }
  for (const r of perms) {
    assert.ok(V2_ACTIONS.has(r.action), `действие ${r.action} не из словаря v2`)
    assert.equal(["bash", "task", "doom_loop", "list", "todowrite", "todoread"].includes(r.action), false, `V1-имя ${r.action} в общих правилах`)
  }
})

test("Sandbox: правила v2 эквивалентны 1.x; агент изолирован по форме /api/agent v2", () => {
  const s = cfg.agents.Sandbox
  assert.equal(s.mode, "primary")
  assert.equal(s.model, "zai-coding-plan/glm-5.3#high")
  assert.equal(s.system, v1.agent.Sandbox.prompt, "{file:./prompts/sandbox.md} перенесён в system")
  const perms = s.permissions
  assert.deepEqual(perms[0], { action: "*", resource: "*", effect: "deny" }, "deny * первым — default-closed")
  const find = (action, resource) => perms.findIndex((r) => r.action === action && r.resource === resource)
  // порядок: allow-набор после deny *, внешние папки — deny * до allow зоны (last-match-wins)
  for (const a of ["read", "glob", "grep", "edit", "question", "webfetch", "websearch", "codesearch"]) {
    assert.ok(find(a, "*") > 0, `allow ${a} есть`)
  }
  assert.ok(find("context7_*", "*") > 0 && find("grep_app_*", "*") > 0 && find("marketplace_*", "*") > 0)
  assert.ok(find("skill", "*") < find("skill", "zai-*"), "skill: deny * до allow zai-*")
  assert.ok(find("external_directory", "*") < find("external_directory", "D:\\Obsidian\\tenants\\*"), "внешние папки: deny * до allow зоны тенантов")
  assert.ok(find("shell", "*") > 0, "bash → shell allow (jail подменяет в плагине)")
  assert.ok(find("subagent", "*") > 0, "task → subagent deny")
  assert.equal(find("task", "*"), -1, "V1-имён нет")
  // форма, которую v2 отдаст в /api/agent, оценивается lib/policy.js как изолированная
  const live = { name: "Sandbox", mode: "primary", permissions: perms }
  assert.equal(agentCan(live, "task"), false, "task закрыт")
  assert.equal(agentCan(live, "bash"), true, "shell (jailed) открыт")
  assert.equal(agentCan(live, "external_directory"), false, "внешние папки закрыты (allow только зона тенантов — BUG-171 исключение)")
  assert.equal(agentIsSandboxed(live), true)
  assert.ok(tenantAgents(agentListView()).some((a) => a.name === "Sandbox"), "Sandbox виден тенантам")
})

test("Sandbox изолирован и на стенде v2 (своя зона тенантов после патча скрипта)", () => {
  const standVault = "D:\\zai-stage\\oc2\\tenants\\vault"
  const prev = read("opencode.v2.json")
  setTenantVaultRoots([standVault])
  try {
    const patched = JSON.parse(prev.replace("D:\\\\Obsidian\\\\tenants\\\\*", `${standVault.replace(/\\/g, "\\\\")}\\\\*`))
    const live = { name: "Sandbox", mode: "primary", permissions: patched.agents.Sandbox.permissions }
    assert.equal(agentCan(live, "external_directory"), false)
    assert.equal(agentIsSandboxed(live), true)
    assert.ok(tenantAgents([{ name: "Sandbox", mode: "primary", permissions: patched.agents.Sandbox.permissions }]).length === 1)
  } finally {
    setTenantVaultRoots(["D:\\Obsidian\\tenants"])
  }
})

test("Hephaestus и orchestrator не видны тенантам (admin-only); их агентные поля перенесены", () => {
  const h = cfg.agents["Hephaestus - deep worker"]
  assert.equal(h.mode, "primary")
  assert.equal(h.model, `${v1.agent["Hephaestus - deep worker"].model}#${v1.agent["Hephaestus - deep worker"].variant}`)
  assert.equal(h.system, v1.agent["Hephaestus - deep worker"].prompt)
  assert.ok(fs.existsSync(path.join(DIR, "prompts", "hephaestus.md")))
  assert.ok(fs.existsSync(path.join(DIR, "prompts", "sandbox.md")))
  const tenant = tenantAgents(agentListView()).map((a) => a.name)
  assert.deepEqual(tenant, ["Sandbox"], `из конфига тенантам виден только Sandbox (получили: ${tenant})`)
})

test("плагины: slim пиннут точной версией, наш плагин директорией, порядок «slim, потом наш»", () => {
  assert.deepEqual(cfg.plugins, ["oh-my-opencode-slim@3.0.7", "./plugin-v2"])
  assert.ok(fs.existsSync(path.join(DIR, "plugin-v2", "index.ts")), "локальный плагин — директория с index.ts")
})

test("mcp.servers: playwright и marketplace как в 1.x (enabled → disabled:false, environment сохранён)", () => {
  const servers = cfg.mcp.servers
  assert.equal(servers.playwright.type, "local")
  assert.deepEqual(servers.playwright.command, v1.mcp.playwright.command)
  assert.equal(servers.playwright.disabled, false)
  assert.deepEqual(servers.marketplace.command, v1.mcp.marketplace.command)
  assert.deepEqual(servers.marketplace.environment, v1.mcp.marketplace.environment)
})

test("instructions и watcher перенесены; файл правил существует рядом с конфигом", () => {
  assert.equal(cfg.instructions.length, v1.instructions.length)
  assert.equal(cfg.watcher.ignore.length, v1.watcher.ignore.length)
  assert.ok(cfg.instructions.some((p) => /prompts[\\/]glm-rules\.md$/.test(p)))
  assert.ok(fs.existsSync(path.join(DIR, "prompts", "glm-rules.md")))
})
