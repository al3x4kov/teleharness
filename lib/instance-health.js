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

import { fsKey } from "./paths.js";

const MCP_CONNECT_TIMEOUT_MS = 30_000; // opencode 1.19.5 `Mp` (per MCP server, servers start in parallel)

// FEAT-16.3 (tasks 3.6): с клиентом oc (lib/oc-client.js) все обращения идут
// через адаптер — v2 прогрев = warmup (GET /api/mcp, retry) + провайдер/модели,
// лечение = dispose через DELETE /api/debug/location (design §6); v1 — те же
// вызовы, что и raw-веткой ниже (адресация и таймауты сохранены). Без oc —
// прежний код бит в бит (тесты lib/instance-health.test.js без изменений).
export function createInstanceHealth({ upstream, oc = null, fetchImpl = fetch, log = (m) => console.log(m), warmTimeoutMs = 120_000, checkTimeoutMs = 10_000, readyCapMs = 60_000 }) {
  if (warmTimeoutMs <= MCP_CONNECT_TIMEOUT_MS + 15_000) throw new Error("warm timeout must exceed opencode's MCP connect timeout");
  const warmed = new Map(); // normalized dir → Promise (in flight or settled)
  const norm = (d) => (d ? fsKey(String(d)) : ""); // BUG-17.14: регистр значим на POSIX
  const url = (p, dir) => `${upstream}${p}?directory=${encodeURIComponent(dir)}`;

  if (oc) {
    // ---- ветка адаптера ----
    async function warm(dir) {
      if (!dir) return;
      const k = norm(dir);
      if (warmed.has(k)) return warmed.get(k);
      const p = (async () => {
        // Порядок как у хода: сначала «дорогой» init (v1 — провайдеры,
        // v2 — MCP с retry), затем второй ресурс хода.
        try {
          if (oc.api === "v2") {
            await oc.warmup({ directory: dir }, { attempts: 3, delayMs: 1000 });
            await oc.listProviders({ directory: dir, timeoutMs: warmTimeoutMs }); // /api/provider + /api/model (design §6)
          } else {
            await oc.warmup({ directory: dir }, { attempts: 1, timeoutMs: warmTimeoutMs }); // GET /config/providers
            await oc.mcpStatus({ directory: dir, timeoutMs: warmTimeoutMs });
          }
        } catch {} // warm is best-effort; heal()/turn handle failures
      })();
      warmed.set(k, p);
      return p;
    }

    async function busy(dir) {
      try {
        if (oc.api === "v2") {
          // Карта занятости v2 глобальна: пересекаем с индексом сессий,
          // чтобы ответить «занята ли ИМЕННО эта папка».
          const [active, sessions] = await Promise.all([oc.busyMap({ timeoutMs: checkTimeoutMs }), oc.listSessions({ timeoutMs: checkTimeoutMs })]);
          const inDir = new Set((Array.isArray(sessions) ? sessions : []).filter((s) => norm(s?.directory) === norm(dir)).map((s) => s.id));
          return Object.entries(active ?? {}).some(([sid, s]) => s && s.type && s.type !== "idle" && inDir.has(sid));
        }
        const st = await oc.busyMap({ directory: dir, timeoutMs: checkTimeoutMs });
        return Object.values(st ?? {}).some((s) => s && s.type && s.type !== "idle");
      } catch {
        return true; // unknown → do not touch the folder
      }
    }

    async function heal(dir) {
      if (!dir) return false;
      let prov = 0;
      let mcp = 0;
      try {
        // v1: статус провайдеров = GET /config/providers (warmup одной попыткой).
        prov = (await oc.warmup({ directory: dir }, { attempts: 1, timeoutMs: checkTimeoutMs })).status;
      } catch {}
      if (prov === 200 || oc.api === "v2") {
        try {
          await oc.mcpStatus({ directory: dir, timeoutMs: warmTimeoutMs });
          mcp = 200;
        } catch (err) {
          mcp = err?.status ?? 0;
        }
      }
      const poisoned = prov === 499 || prov === 503 || mcp === 499 || mcp === 503;
      if (!poisoned) return false;
      if (await busy(dir)) {
        log(`[zai-health] ${dir}: poisoned opencode services (providers ${prov}, mcp ${mcp}) but a turn is busy there — not disposed`);
        return false;
      }
      try {
        await oc.disposeInstance({ directory: dir, timeoutMs: checkTimeoutMs }); // v1 POST /instance/dispose; v2 DELETE /api/debug/location
      } catch {}
      warmed.delete(norm(dir));
      // BUG-218 (SRV-14, design §3): начатый dispose не отменить — busy,
      // появившийся за его время, фиксируем как гонку (сигнал в healthz/лог)
      if (await busy(dir)) log(`[zai-health] ${dir}: dispose raced a starting turn`);
      log(`[zai-health] ${dir}: poisoned opencode services (providers ${prov}, mcp ${mcp}) — instance disposed (BUG-183)`);
      return true;
    }

    return { warm, ready, heal, busy, warmTimeoutMs, forget: (dir) => warmed.delete(norm(dir)) };
  }

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
    // BUG-218 (SRV-14, design §3): начатый dispose не отменить — busy,
    // появившийся за его время, фиксируем как гонку
    if (await busy(dir)) log(`[zai-health] ${dir}: dispose raced a starting turn`);
    log(`[zai-health] ${dir}: poisoned opencode services (providers ${prov}, mcp ${mcp}) — instance disposed (BUG-183)`);
    return true;
  }

  return { warm, ready, heal, busy, warmTimeoutMs, forget: (dir) => warmed.delete(norm(dir)) };
}
