// FEAT-11.18 (шаг А): расход подписок и балансы провайдеров моделей для раздела
// «Подписки». Одна карточка на подключённого провайдера. Адреса и формы ответов —
// ТОЛЬКО из официальной документации (docs/research/2026-11-12-subscription-usage-apis.md);
// неофициальные адреса (подписка Claude, подписка ChatGPT, Copilot, Gemini CLI) не
// вызываются — решение владельца 2026-11-12. Ключи читаются из auth.json opencode и из
// окружения и НИКОГДА не попадают в ответ клиенту. Zero deps.
//
// Карточка: { id, title, badge, state, fetchedAt?, reason?, plan?, windows?, money?,
//             balances?, available?, spend?, freeTier? }
//   state: ok | error (reason: http-код | "network" | "shape") | no-key |
//          need-admin-key | no-api
//   windows  — окна подписки (z.ai): [{kind, number, type, percent, used, total, remaining, resetAt}]
//   money    — лимит ключа: {currency, limit, remaining, resetInterval, spent:{day,week,month,total}}
//   balances — денежный баланс: [{currency, total, granted, toppedUp}]
//   spend    — только траты: {currency, amount, days}
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SUBS_CACHE_MS = 60_000;
const TIMEOUT_MS = 15_000;
const SPEND_DAYS = 7;

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// ---- нормализаторы (чистые) -----------------------------------------------------

// https://openrouter.ai/docs/api-reference/limits — GET /api/v1/key
export function normalizeOpenRouter(raw) {
  const d = raw?.data;
  if (!d || typeof d !== "object" || !("usage" in d)) return null;
  return {
    state: "ok",
    freeTier: d.is_free_tier === true,
    money: {
      currency: "USD",
      limit: num(d.limit),
      remaining: num(d.limit_remaining),
      resetInterval: typeof d.limit_reset === "string" ? d.limit_reset : null,
      spent: { day: num(d.usage_daily), week: num(d.usage_weekly), month: num(d.usage_monthly), total: num(d.usage) },
    },
  };
}

// https://api-docs.deepseek.com/api/get-user-balance — GET /user/balance
export function normalizeDeepSeek(raw) {
  if (!raw || !Array.isArray(raw.balance_infos)) return null;
  return {
    state: "ok",
    available: raw.is_available === true,
    balances: raw.balance_infos.map((b) => ({ currency: String(b?.currency ?? ""), total: num(b?.total_balance), granted: num(b?.granted_balance), toppedUp: num(b?.topped_up_balance) })),
  };
}

// https://platform.kimi.ai/docs/api/balance — GET /v1/users/me/balance (USD)
export function normalizeMoonshot(raw) {
  const d = raw?.data;
  if (!raw || raw.code !== 0 || !d || typeof d !== "object") return null;
  const total = num(d.available_balance);
  return { state: "ok", available: total != null && total > 0, balances: [{ currency: "USD", total, granted: num(d.voucher_balance), toppedUp: num(d.cash_balance) }] };
}

// https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info — GET /v1/user/info
export function normalizeSiliconFlow(raw) {
  const d = raw?.data;
  if (!raw || raw.status !== true || !d || typeof d !== "object") return null;
  const total = num(d.totalBalance);
  return { state: "ok", available: total != null && total > 0, balances: [{ currency: "USD", total, granted: num(d.balance), toppedUp: num(d.chargeBalance) }] };
}

// OpenAI Costs API — GET /v1/organization/costs (ключ администратора). Остатка нет.
export function normalizeOpenAICosts(raw, days = SPEND_DAYS) {
  if (!raw || !Array.isArray(raw.data)) return null;
  let amount = 0;
  for (const b of raw.data) for (const r of b?.results ?? []) amount += num(r?.amount?.value) ?? 0;
  return { state: "ok", spend: { currency: "USD", amount, days } };
}

// Anthropic Usage & Cost API — GET /v1/organizations/cost_report. amount — центы строкой.
export function normalizeAnthropicCosts(raw, days = SPEND_DAYS) {
  if (!raw || !Array.isArray(raw.data)) return null;
  let cents = 0;
  for (const b of raw.data) for (const r of b?.results ?? []) cents += num(r?.amount) ?? 0;
  return { state: "ok", spend: { currency: "USD", amount: cents / 100, days } };
}

// ---- реестр провайдеров -----------------------------------------------------------

async function getJson(fetchImpl, url, headers) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { error: "network" };
  }
  if (!res.ok) return { error: String(res.status) };
  try {
    return { body: await res.json() };
  } catch {
    return { error: "shape" };
  }
}

const bearer = (key) => ({ authorization: `Bearer ${key}` });
const keyed = (url, normalize) => async ({ key, fetchImpl }) => {
  const r = await getJson(fetchImpl, url, bearer(key));
  if (r.error) return { state: "error", reason: r.error };
  return normalize(r.body) ?? { state: "error", reason: "shape" };
};

// id провайдера в opencode → описание карточки. needs: "key" (ключ из auth.json),
// "admin:<ENV>" (ключ администратора из окружения), "zai", "none" (расход по API недоступен).
const NO_API = (id, title, badge, hint) => ({ id, title, badge, needs: "none", hint });
const REGISTRY = {
  "zai-coding-plan": { id: "zai", title: "z.ai", badge: "Coding Plan", needs: "zai" },
  zai: { id: "zai", title: "z.ai", badge: "Coding Plan", needs: "zai" },
  anthropic: NO_API("claude", "Claude", "подписка", "claude-subscription"),
  openrouter: { id: "openrouter", title: "OpenRouter", badge: "ключ API", needs: "key", load: keyed("https://openrouter.ai/api/v1/key", normalizeOpenRouter) },
  deepseek: { id: "deepseek", title: "DeepSeek", badge: "баланс", needs: "key", load: keyed("https://api.deepseek.com/user/balance", normalizeDeepSeek) },
  moonshotai: { id: "moonshot", title: "Moonshot (Kimi)", badge: "баланс", needs: "key", load: keyed("https://api.moonshot.ai/v1/users/me/balance", normalizeMoonshot) },
  siliconflow: { id: "siliconflow", title: "SiliconFlow", badge: "баланс", needs: "key", load: keyed("https://api.siliconflow.com/v1/user/info", normalizeSiliconFlow) },
  openai: {
    id: "openai", title: "OpenAI", badge: "API", needs: "admin:ZAI_OPENAI_ADMIN_KEY",
    load: async ({ key, fetchImpl, now }) => {
      const start = Math.floor(now() / 1000) - SPEND_DAYS * 86400;
      const r = await getJson(fetchImpl, `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=${SPEND_DAYS + 1}`, bearer(key));
      if (r.error) return { state: "error", reason: r.error };
      return normalizeOpenAICosts(r.body, SPEND_DAYS) ?? { state: "error", reason: "shape" };
    },
  },
  xai: NO_API("xai", "xAI", "API", "management-key"),
  "github-copilot": NO_API("github-copilot", "GitHub Copilot", "подписка", "no-official-api"),
  google: NO_API("google", "Google Gemini", "API", "no-official-api"),
  opencode: NO_API("opencode", "OpenCode Zen", "баланс", "console-only"),
  alibaba: NO_API("alibaba", "Alibaba Qwen", "Coding Plan", "console-only"),
  "alibaba-cn": NO_API("alibaba", "Alibaba Qwen", "Coding Plan", "console-only"),
};
// Anthropic API (счёт за API, не подписка) — отдельная карточка, только при ключе администратора.
const ANTHROPIC_API = {
  id: "anthropic-api", title: "Anthropic API", badge: "API",
  load: async ({ key, fetchImpl, now }) => {
    const start = new Date(now() - SPEND_DAYS * 86400_000).toISOString();
    const r = await getJson(fetchImpl, `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(start)}&limit=${SPEND_DAYS + 1}`, { "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" });
    if (r.error) return { state: "error", reason: r.error };
    return normalizeAnthropicCosts(r.body, SPEND_DAYS) ?? { state: "error", reason: "shape" };
  },
};

// Ключи подключённых провайдеров из auth.json opencode: {providerId: key}. Только type "api".
export function providerKeys(file = process.env.ZAI_AUTH_FILE || path.join(os.homedir(), ".local", "share", "opencode", "auth.json")) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const out = {};
    for (const [id, v] of Object.entries(raw ?? {})) if (v && typeof v.key === "string" && v.key) out[id] = v.key;
    return out;
  } catch {
    return {};
  }
}

const defaultCache = new Map(); // id карточки → {at, card, pending}

async function cached(cache, id, now, load) {
  const hit = cache.get(id);
  if (hit?.card && now() - hit.at < SUBS_CACHE_MS) return hit.card;
  if (hit?.pending) return hit.pending;
  const pending = (async () => {
    const card = await load();
    cache.set(id, { at: now(), card, pending: null });
    return card;
  })().catch((err) => {
    cache.delete(id);
    throw err;
  });
  cache.set(id, { at: hit?.at ?? 0, card: hit?.card ?? null, pending });
  return pending;
}

// connected — id подключённых провайдеров (в порядке каталога). zai() → payload lib/usage.js
// ({ok, plan, windows} | {ok:false} | null). → массив карточек, по одной на провайдера.
export async function subscriptionCards({ connected = [], keys = providerKeys(), env = process.env, zai = async () => null, fetchImpl = fetch, now = Date.now, cache = defaultCache } = {}) {
  const jobs = [];
  const seen = new Set();
  const push = (id, job) => {
    if (seen.has(id)) return;
    seen.add(id);
    jobs.push(job);
  };
  for (const pid of connected) {
    const def = REGISTRY[pid] ?? NO_API(pid, pid, "провайдер", "no-official-api");
    const base = { id: def.id, title: def.title, badge: def.badge };
    if (def.needs === "none") {
      push(def.id, async () => ({ ...base, state: "no-api", hint: def.hint }));
    } else if (def.needs === "zai") {
      push(def.id, async () => {
        let u = null;
        try {
          u = await zai();
        } catch {
          return { ...base, state: "error", reason: "network" };
        }
        if (!u) return { ...base, state: "error", reason: "network" };
        if (!u.ok) return { ...base, state: u.error === "no-key" ? "no-key" : "error", reason: u.error ?? "shape" };
        return { ...base, state: "ok", plan: u.plan ?? null, fetchedAt: u.fetchedAt ?? now(), windows: u.windows ?? [] };
      });
    } else {
      const adminEnv = def.needs.startsWith("admin:") ? def.needs.slice(6) : null;
      const key = adminEnv ? env[adminEnv] : keys[pid];
      if (!key) push(def.id, async () => ({ ...base, state: adminEnv ? "need-admin-key" : "no-key" }));
      else push(def.id, () => cached(cache, def.id, now, async () => ({ ...base, ...(await def.load({ key, fetchImpl, now })), fetchedAt: now() })));
    }
    if (pid === "anthropic" && env.ZAI_ANTHROPIC_ADMIN_KEY) {
      const key = env.ZAI_ANTHROPIC_ADMIN_KEY;
      push(ANTHROPIC_API.id, () => cached(cache, ANTHROPIC_API.id, now, async () => ({ id: ANTHROPIC_API.id, title: ANTHROPIC_API.title, badge: ANTHROPIC_API.badge, ...(await ANTHROPIC_API.load({ key, fetchImpl, now })), fetchedAt: now() })));
    }
  }
  return Promise.all(jobs.map((j) => j().catch(() => null))).then((list) => list.filter(Boolean));
}
