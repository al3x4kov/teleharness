// z.ai Coding Plan usage for the Settings «Подписка z.ai» card: proxy the
// monitor quota endpoint with the owner's API key (read from opencode's
// auth.json; the key itself never reaches the client). Zero deps.
// Endpoint + shape verified live 2026-10-31 against api.z.ai:
//   GET https://api.z.ai/api/monitor/usage/quota/limit
//   authorization: <raw key, no Bearer>   (zai-org/ZCode docs; Bearer
//                                          retried once as a fallback)
//   → {code, msg, success, data:{level, limits:[{type, unit, number, usage,
//      currentValue, remaining, percentage, nextResetTime}]}}
// unit: 3=hours, 6=weeks, 5=months, 1=days; nextResetTime = epoch ms
// (absolute instant, timezone-free — the client renders Europe/Moscow),
// OPTIONAL on idle windows. TOKENS_LIMIT entries carry percentage only;
// CREDIT_LIMIT/TIME_LIMIT also carry usage/currentValue/remaining.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_MS = 60_000;
const QUOTA_BASE = process.env.ZAI_QUOTA_BASE || "https://api.z.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const cache = { at: 0, data: null, pending: null };

function authFilePath() {
  return process.env.ZAI_AUTH_FILE || path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function apiKey() {
  try {
    const raw = JSON.parse(readFileSync(authFilePath(), "utf8"));
    return raw["zai-coding-plan"]?.key ?? raw["zai"]?.key ?? null;
  } catch {
    return null;
  }
}

export function unitKind(unit) {
  if (unit === 3) return "hours";
  if (unit === 6) return "week";
  if (unit === 5) return "month";
  if (unit === 1) return "day";
  return `unit${unit}`;
}

// Stable display order: 5h window, weekly, monthly tools, the rest.
const KIND_RANK = { hours: 0, week: 1, month: 2, day: 3 };

// nextResetTime is epoch ms in the documented/live shape; tolerate epoch
// seconds (10 digits) and ISO/numeric strings for safety (cc-switch and
// CodexBar do the same — shapes drifted across API versions).
function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value >= 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return toEpochMs(n);
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// percentage is the USED share (0-100).
function clampPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Pure: upstream envelope → client payload. null when the account has no
// answerable plan (success:false / non-200 business code) — the route maps
// that to {ok:false} for the UI.
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object" || raw.success !== true || raw.code !== 200) return null;
  const limits = Array.isArray(raw.data?.limits) ? raw.data.limits : [];
  const windows = limits
    .map((l) => ({
      kind: unitKind(l?.unit),
      number: intOrNull(l?.number),
      // CREDIT_LIMIT (modern plans: quotas in credits) vs TOKENS_LIMIT
      // (legacy: tokens, percentage-only) — the client labels units by it.
      type: String(l?.type ?? ""),
      percent: clampPct(l?.percentage),
      used: intOrNull(l?.currentValue),
      total: intOrNull(l?.usage),
      remaining: intOrNull(l?.remaining),
      resetAt: toEpochMs(l?.nextResetTime),
    }))
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9));
  return {
    ok: true,
    plan: raw.data?.level ?? raw.data?.planName ?? null,
    fetchedAt: Date.now(),
    windows,
  };
}

async function fetchQuota(key) {
  const url = `${QUOTA_BASE}/api/monitor/usage/quota/limit`;
  const headers = (auth) => ({ authorization: auth, "accept-language": "en-US,en" });
  // Official contract: RAW key. Some deployments accept Bearer too — retry
  // once before giving up.
  let res = await fetch(url, { headers: headers(key), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: headers(`Bearer ${key}`), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`quota http ${res.status}`);
  return res.json();
}

// Cached (60s) — the counters move slowly and this is a single-user portal.
// Resolves to {ok:true, plan, windows:[...]} or {ok:false, error}; rejects
// only on network/auth trouble (route answers 503, cache stays clean).
export function usageStats() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return Promise.resolve(cache.data);
  if (!cache.pending) {
    const key = apiKey();
    if (!key) {
      cache.data = { ok: false, error: "no-key" };
      cache.at = now;
      return Promise.resolve(cache.data);
    }
    cache.pending = fetchQuota(key).then(normalizeUsage);
    cache.pending.then(
      (data) => {
        cache.at = Date.now();
        cache.data = data ?? { ok: false, error: "plan-unavailable" };
        cache.pending = null;
      },
      () => {
        cache.pending = null; // a failed sample must not poison future requests
      },
    );
  }
  return cache.pending;
}
