// BUG-183 (BUG-12.25): guard against poisoned opencode per-folder services.
//
// Root cause (reverse-engineered in opencode 1.19.5, reproduced on an isolated serve):
// InstanceState = an Effect ScopedCache. Its lookup runs in the fiber of the FIRST caller
// (interruptible) and the lookup's Exit — an interruption too — is stored with an infinite TTL.
// A request or a turn interrupted while a service of a folder initializes lazily leaves that
// service broken for the folder until its instance is disposed:
//   - MCP: the portal's 30 s upstream timeout == opencode's MCP connect timeout (30 s) → a slow
//     local MCP server makes the portal abort exactly during the lookup → /mcp 499 forever
//     (prod 2026-11-07, default instance C:\Windows\System32);
//   - Provider: a «Стоп» on the first turn of a new folder → /provider 503 and every turn of the
//     folder dies at once («Aborted», opencode log «All fibers interrupted without error»).
// warm(dir): initializes Provider and MCP of a folder with requests the portal never aborts early
// (once per folder). heal(dir): before a prompt, a poisoned folder (providers 503/499, MCP 499/503)
// gets its instance disposed — only when no turn runs there.

const MCP_CONNECT_TIMEOUT_MS = 30_000; // opencode 1.19.5 `Mp` (per MCP server, servers start in parallel)

export function createInstanceHealth({ upstream, fetchImpl = fetch, log = (m) => console.log(m), warmTimeoutMs = 120_000, checkTimeoutMs = 10_000, readyCapMs = 60_000 }) {
  if (warmTimeoutMs <= MCP_CONNECT_TIMEOUT_MS + 15_000) throw new Error("warm timeout must exceed opencode's MCP connect timeout");
  const warmed = new Map(); // normalized dir → Promise (in flight or settled)
  const norm = (d) => String(d ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const url = (p, dir) => `${upstream}${p}?directory=${encodeURIComponent(dir)}`;

  async function get(p, dir, ms) {
    try {
      const r = await fetchImpl(url(p, dir), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
      await r.text().catch(() => "");
      return r.status;
    } catch {
      return 0; // network error / our own timeout: not a poisoned service
    }
  }

  function warm(dir) {
    if (!dir) return Promise.resolve();
    const k = norm(dir);
    if (warmed.has(k)) return warmed.get(k);
    const p = (async () => {
      // the order a turn uses them: providers first, then MCP (tools)
      await get("/config/providers", dir, warmTimeoutMs);
      await get("/mcp", dir, warmTimeoutMs);
    })();
    warmed.set(k, p);
    return p;
  }

  async function ready(dir) {
    const p = dir ? warmed.get(norm(dir)) : null;
    if (!p) return;
    let t;
    await Promise.race([p, new Promise((r) => (t = setTimeout(r, readyCapMs)))]);
    clearTimeout(t);
  }

  async function busy(dir) {
    try {
      const r = await fetchImpl(url("/session/status", dir), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(checkTimeoutMs) });
      const st = await r.json();
      return Object.values(st ?? {}).some((s) => s && s.type && s.type !== "idle");
    } catch {
      return true; // unknown → do not touch the folder
    }
  }

  async function heal(dir) {
    if (!dir) return false;
    const prov = await get("/config/providers", dir, checkTimeoutMs);
    const mcp = prov === 200 ? await get("/mcp", dir, warmTimeoutMs) : 0;
    const poisoned = prov === 499 || prov === 503 || mcp === 499 || mcp === 503;
    if (!poisoned) return false;
    if (await busy(dir)) {
      log(`[zai-health] ${dir}: poisoned opencode services (providers ${prov}, mcp ${mcp}) but a turn is busy there — not disposed`);
      return false;
    }
    try {
      await fetchImpl(url("/instance/dispose", dir), { method: "POST", signal: AbortSignal.timeout(checkTimeoutMs) });
    } catch {}
    warmed.delete(norm(dir));
    log(`[zai-health] ${dir}: poisoned opencode services (providers ${prov}, mcp ${mcp}) — instance disposed (BUG-183)`);
    return true;
  }

  return { warm, ready, heal, warmTimeoutMs, forget: (dir) => warmed.delete(norm(dir)) };
}
