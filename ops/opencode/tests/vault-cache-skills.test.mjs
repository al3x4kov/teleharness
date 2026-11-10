// FEAT-04.10: tenant skills (only zai-*) and MCP marketplace in vault-cache.ts. Run:
//   node --test ops/opencode/tests/vault-cache-skills.test.mjs
// Uses a throwaway layout under %TEMP%; never touches the real vault or users.json.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-skills-"))
const P = (...x) => path.join(ROOT, ...x)
const ALICE = P("tenants", "home", "alice")
const ADMIN_DIR = P("admin-project")
const SKILLS = path.resolve(import.meta.dirname, "..", "skills")

let hook
const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_alice: { id: "ses_alice", directory: ALICE },
  ses_child: { id: "ses_child", directory: ALICE, parentID: "ses_alice" },
}

before(async () => {
  for (const d of [ALICE, ADMIN_DIR, P("tenants", "vault", "alice"), P("vault", "agents")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("users.json"), JSON.stringify({ users: [{ name: "admin", role: "admin", directories: [] }] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
    ZAI_JAIL_EXE: P("jail", "zai-jail.exe"),
    ZAI_SANDBOX_PY: P("py"),
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  const client = { session: { get: async ({ path: { id } }) => ({ data: sessions[id] }), messages: async () => ({ data: [] }) } }
  hook = (await mod.default({ client }))["tool.execute.before"]
})

after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const run = (sessionID, tool, args) => hook({ tool, sessionID, callID: "c" }, { args })
const ok = (s, t, a) => assert.doesNotReject(run(s, t, a), `${t} ${JSON.stringify(a)} should run`)
const no = (s, t, a, re) => assert.rejects(run(s, t, a), re, `${t} ${JSON.stringify(a)} should be blocked`)

test("tenant: every shipped zai-* skill can be loaded", async () => {
  const names = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, "SKILL.md")))
  assert.deepEqual(names.sort(), ["zai-docx", "zai-html", "zai-images", "zai-pdf", "zai-pptx", "zai-xlsx"])
  for (const name of names) {
    const fm = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8").match(/^---\r?\n[\s\S]*?^name: (.+)$/m)
    assert.equal(fm?.[1].trim(), name, `${name}: frontmatter name = directory name`)
    await ok("ses_alice", "skill", { name })
  }
  await ok("ses_alice", "skill", { name: "/zai-xlsx" }) // OmO strips a leading slash
  await ok("ses_alice", "skill", { name: "ZAI-PDF" }) // OmO matches case-insensitively
  await ok("ses_alice", "skill", { name: "zai-xlsx", user_message: "отчёт" })
  await ok("ses_child", "skill", { name: "zai-pptx" })
})

test("tenant: admin skills, OmO commands and odd names are refused with a clear error", async () => {
  for (const name of ["dogfood", "frontend-design", "git-master", "playwright", "dev-browser", "review-work", "publish", "/dogfood",
    "zai", "zai-", "zai_xlsx", "xzai-xlsx", "zai-xlsx/../dogfood", "zai-xlsx dogfood", "zai-x\u0000", "../zai-xlsx", "plugin/zai-xlsx", ""])
    await no("ses_alice", "skill", { name }, /Доступ запрещён: скилл .* недоступен в пользовательской сессии: можно загружать только скиллы zai-\*/)
  await no("ses_alice", "skill", {}, /только скиллы zai-\*/)
  await no("ses_alice", "skill", { name: 42 }, /только скиллы zai-\*/)
  await no("ses_child", "skill", { name: "dogfood" }, /только скиллы zai-\*/)
  await no("ses_alice", "skill_mcp", { mcp_name: "playwright", tool_name: "browser_navigate" }, /недоступен/)
})

test("tenant: marketplace MCP tools are allowed, browser snapshot is not", async () => {
  // ru-marketplace-mcp 2.7.0 tool list (MARKETPLACE_SOURCES=wildberries,ozon,yandex_market,compare), opencode prefixes the server name
  for (const t of ["marketplace_sources", "wb_card", "wb_root_info", "wb_reviews", "wb_questions", "wb_search", "wb_seller", "wb_categories",
    "wb_category_products", "ozon_card", "ozon_reviews", "ozon_search", "yandex_search", "yandex_card", "compare_prices", "compare_verify_offer", "compare_sources"])
    await ok("ses_alice", `marketplace_${t}`, { query: "чайник", limit: 5 })
  await ok("ses_alice", "marketplace_compare_verify_offer", { source: "wildberries", product_id_or_url: "https://www.wildberries.ru/catalog/12345/detail.aspx" })
  await no("ses_alice", "marketplace_compare_browser_snapshot", { handoff_id: "a".repeat(20) }, /недоступен/)
})

test("admin: skill and marketplace are not touched by the plugin", async () => {
  await ok("ses_admin", "skill", { name: "dogfood" })
  await ok("ses_admin", "marketplace_compare_browser_snapshot", { handoff_id: "a".repeat(20) })
})
