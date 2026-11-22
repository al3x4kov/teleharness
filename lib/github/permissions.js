// FEAT-20.3 (1.9): доверенные авторы через permission API с кэшем 10 мин.
// Доверенный = владелец токена ИЛИ permission ∈ {write, maintain, admin}
// (design §4). Любой исход кэшируется: GitHub-лимит не тратится зря.
import { ghFetch } from "./client.js";

const TRUSTED_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export function createPermissionCache({
  apiBase, fetchImpl, ttlMs = 600_000, now = () => Date.now(), log = () => {},
} = {}) {
  const cache = new Map(); // `${repo}:${login}` → { ok, until }
  async function has(login, repo, token) {
    if (!login || !repo || !token) return false;
    const k = `${repo}:${login}`;
    const hit = cache.get(k);
    if (hit && hit.until > now()) return hit.ok;
    let ok = false;
    try {
      const r = await ghFetch(token, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { apiBase, ...(fetchImpl ? { fetchImpl } : {}) });
      ok = TRUSTED_PERMISSIONS.has(String(r.data?.permission ?? ""));
    } catch (e) {
      ok = false; // 403/404 — прав нет; сеть/лимит — безопасный «нет»
      log?.(`github-perm: ${repo}/${login}: ${e?.message ?? e}`);
    }
    cache.set(k, { ok, until: now() + ttlMs });
    return ok;
  }
  return { has };
}
