// Live check (not part of npm test): the REAL server.js (temp data, spawnPortal) in front of the isolated
// opencode :4098 (slow MCP server → deterministic poisoning). A folder is poisoned exactly like on prod
// (first /mcp aborted by the client during the MCP init) → through the portal: /zai/api/mcp heals → 200,
// and a chat turn in that folder answers.
//   node tests/live-heal-check.mjs
import fs from "node:fs"
import { spawnPortal } from "./helpers/spawn-server.mjs"

const OC = "http://127.0.0.1:4098"
const ADMIN = "a".repeat(24) + "-live-heal-" + "7".repeat(24)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (dir) => `?directory=${encodeURIComponent(dir)}`
let pass = 0, fail = 0
const check = (n, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${info ? " — " + String(info).slice(0, 200) : ""}`) }
const srv = await spawnPortal({ upstream: OC, env: { ZAI_ADMIN_TOKEN: ADMIN } })
const api = (p, { method = "GET", body } = {}) => fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
const dir = `D:\\zai-tmp-scripts\\oc-repro\\heal-${Date.now().toString(36)}`
fs.mkdirSync(dir, { recursive: true })
try {
  await fetch(`${OC}/agent${q(dir)}`)
  try { await fetch(`${OC}/mcp${q(dir)}`, { signal: AbortSignal.timeout(5000) }) } catch {}
  await sleep(800)
  const before = (await fetch(`${OC}/mcp${q(dir)}`)).status
  check("папка отравлена как на проде (opencode /mcp напрямую)", before === 499, before)
  const t0 = Date.now()
  const r = await api(`/zai/api/mcp${q(dir)}`)
  const body = await r.text()
  check("портал /zai/api/mcp в отравленной папке → 200 (лечение)", r.status === 200 && body.includes("connected"), `${r.status} за ${Math.round((Date.now() - t0) / 1000)} с: ${body.slice(0, 80)}`)
  check("после лечения opencode /mcp напрямую → 200", (await fetch(`${OC}/mcp${q(dir)}`)).status === 200)
  // poison again, then a chat turn through the portal
  await fetch(`${OC}/instance/dispose${q(dir)}`, { method: "POST" })
  await fetch(`${OC}/agent${q(dir)}`)
  try { await fetch(`${OC}/mcp${q(dir)}`, { signal: AbortSignal.timeout(5000) }) } catch {}
  await sleep(800)
  check("папка снова отравлена", (await fetch(`${OC}/mcp${q(dir)}`)).status === 499)
  const s = (await (await fetch(`${OC}/session${q(dir)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).id
  const pr = await api(`/zai/api/session/${s}/prompt`, { method: "POST", body: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "build", parts: [{ type: "text", text: "Ответь одним словом: да" }] } })
  check("портал принял ход", pr.status === 204, pr.status)
  let a = null
  for (let i = 0; i < 80 && !a; i++) {
    await sleep(2500)
    const ms = await (await fetch(`${OC}/session/${s}/message${q(dir)}`)).json()
    const x = ms.filter((m) => m.info.role === "assistant").at(-1)
    if (x && (x.info.time?.completed || x.info.error)) a = x
  }
  const text = a?.parts?.filter((p) => p.type === "text").map((p) => p.text).join(" ") ?? ""
  check("ход в отравленной папке через портал — модель ответила", a && !a.info.error && /да/i.test(text), JSON.stringify({ err: a?.info?.error?.name, text: text.slice(0, 40) }))
} finally {
  await fetch(`${OC}/instance/dispose${q(dir)}`, { method: "POST" }).catch(() => {})
  await srv.stop()
  console.log(`\nИТОГ: ${pass} PASS / ${fail} FAIL`)
}
