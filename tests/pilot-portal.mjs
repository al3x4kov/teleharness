// Pilot portal (not part of npm test): the REAL server.js in front of the pilot opencode (:4098,
// oh-my-opencode-slim). Data and tenant folders are the pilot's own (D:\teleharness-tmp-scripts\pilot\…), so the
// pilot opencode's vault-cache sees the same users.json and tenant homes. Writes its base URL and admin
// token to D:\teleharness-tmp-scripts\pilot\portal.json and stays alive until killed. Start detached:
//   Start-Process node tests/pilot-portal.mjs
import fs from "node:fs"
import { spawnPortal } from "./helpers/spawn-server.mjs"

const ADMIN = "p".repeat(24) + "-pilot-slim-" + "8".repeat(24)
const srv = await spawnPortal({
  upstream: "http://127.0.0.1:4098",
  env: {
    TELEHARNESS_ADMIN_TOKEN: ADMIN,
    TELEHARNESS_DATA_DIR: "D:/teleharness-tmp-scripts/pilot/portal-data",
    TELEHARNESS_TENANT_HOME: "D:/teleharness-tmp-scripts/pilot/tenants/home",
    TELEHARNESS_TENANT_VAULT: "D:/teleharness-tmp-scripts/pilot/tenants/vault",
    TELEHARNESS_TENANT_AGENT: "Sandbox",
  },
  readyTimeoutMs: 60_000,
})
fs.writeFileSync("D:/teleharness-tmp-scripts/pilot/portal.json", JSON.stringify({ base: srv.base, token: ADMIN, pid: process.pid }))
console.log(`pilot portal ${srv.base}`)
const stop = async () => { await srv.stop().catch(() => {}); process.exit(0) }
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
setInterval(() => {}, 1 << 30)
