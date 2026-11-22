// FEAT-20.3 (1.2): тонкий клиент GitHub REST — таймаут, ETag, бюджет запросов.
// Классификатор исходов: auth(401) / forbidden(403) / rate_limited(403 при
// исчерпании лимита) / not_found(404) / validation(422) / server(5xx) /
// network(нет связи или таймаут) / not_modified(304 по ETag).
// Токен в сообщениях ошибок не участвует: он живёт только в заголовке запроса.
import { redact } from "./secrets.js";

export const GITHUB_API = "https://api.github.com";

export class GhError extends Error {
  constructor(status, kind, message) {
    super(message);
    this.name = "GhError";
    this.status = status;
    this.kind = kind;
  }
}

export function classify(status, { rateRemaining = null } = {}) {
  if (status === 304) return "not_modified";
  if (status === 401) return "auth";
  if (status === 403) return rateRemaining === 0 ? "rate_limited" : "forbidden";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (status >= 500) return "server";
  if (status >= 200 && status < 300) return "ok";
  return "other";
}

// GitHub отдаёт срок fine-grained токена строкой «2027-01-01 12:00:00 UTC».
export function parseExpiry(header) {
  const s = String(header ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}

export async function ghFetch(token, pathname, {
  method = "GET", body = null, etag = null, apiBase = GITHUB_API, timeoutMs = 10_000,
  fetchImpl = fetch, accept = "application/vnd.github+json",
} = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(apiBase + pathname, {
      method,
      signal: ac.signal,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "teleharness-portal",
        ...(body !== null ? { "content-type": "application/json" } : {}),
        ...(etag ? { "if-none-match": etag } : {}),
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new GhError(0, "network", error?.name === "AbortError" ? "GitHub не ответил за отведённое время" : "Нет связи с github.com");
  } finally {
    clearTimeout(timer);
  }
  const header = (name) => res.headers.get(name);
  const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const rate = {
    limit: num(header("x-ratelimit-limit")),
    remaining: num(header("x-ratelimit-remaining")),
    reset: num(header("x-ratelimit-reset")),
  };
  const kind = classify(res.status, { rateRemaining: rate.remaining });
  const out = {
    status: res.status,
    kind,
    data: null,
    etag: res.headers.get("etag"),
    rate,
    retryAfter: Number(res.headers.get("retry-after")) || null,
    expiresAt: parseExpiry(res.headers.get("github-authentication-token-expiration")),
  };
  if (kind === "ok") {
    out.data = await res.json().catch(() => null);
    return out;
  }
  if (kind !== "not_modified") {
    // Текст GitHub полезен для человека и безопасен: токен в нём не появляется.
    const detail = await res.json().then((j) => (typeof j?.message === "string" ? j.message : null)).catch(() => null);
    const safe = detail ? redact(detail, [token]) : null;
    throw new GhError(res.status, kind, safe ? `GitHub ${res.status}: ${safe}` : `GitHub ответил ${res.status}`);
  }
  return out;
}

// Текстовый GET (логи job'ов CI — text/plain, ответ 302→200): в отличие от
// ghFetch не парсит JSON. Не-2xx → GhError с классификацией.
export async function ghText(token, pathname, {
  apiBase = GITHUB_API, timeoutMs = 20_000, fetchImpl = fetch,
} = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(apiBase + pathname, {
      method: "GET", signal: ac.signal, redirect: "follow",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "teleharness-portal" },
    });
  } catch (error) {
    throw new GhError(0, "network", error?.name === "AbortError" ? "GitHub не ответил за отведённое время" : "Нет связи с github.com");
  } finally {
    clearTimeout(timer);
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = await res.json().then((j) => (typeof j?.message === "string" ? j.message : null)).catch(() => null);
    const safe = detail ? redact(detail, [token]) : null;
    throw new GhError(res.status, classify(res.status), safe ? `GitHub ${res.status}: ${safe}` : `GitHub ответил ${res.status}`);
  }
  return { status: res.status, text: await res.text() };
}

// Кр. 1: /user (логин + срок токена) и /user/repos — до 10 страниц по 100.
export async function checkConnection(token, opts = {}) {
  const me = await ghFetch(token, "/user", opts);
  if (me.kind !== "ok" || !me.data?.login) throw new GhError(me.status, me.kind === "ok" ? "other" : me.kind, "GitHub не вернул логин пользователя");
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const r = await ghFetch(token, `/user/repos?per_page=100&sort=full_name&page=${page}`, opts);
    if (r.kind !== "ok") break; // обрыв на второй странице не отменяет первую
    for (const repo of r.data ?? []) {
      if (repo?.full_name) repos.push({ fullName: String(repo.full_name), private: !!repo.private, permissions: repo.permissions ?? null });
    }
    if ((r.data ?? []).length < 100) break;
  }
  return { login: me.data.login, expiresAt: me.expiresAt, etag: me.etag, repos };
}

// Права на конкретный репозиторий (fine-grained токены отдают .permissions здесь).
// 404 — «нет доступа / не видно» без ошибки: триггер на него не создать.
export async function repoPermissions(token, fullName, opts = {}) {
  let r;
  try {
    r = await ghFetch(token, `/repos/${fullName}`, opts);
  } catch (e) {
    if (e instanceof GhError && e.kind === "not_found") return { status: 404, kind: e.kind, permissions: null, private: null };
    throw e;
  }
  if (r.kind !== "ok") throw new GhError(r.status, r.kind, `GitHub не отдал репозиторий ${fullName}`);
  return { status: r.status, kind: r.kind, permissions: r.data?.permissions ?? null, private: !!r.data?.private };
}

// Лицо прав для человека (кр. 1): что важно для фоновых агентов.
export function repoRights(perms) {
  if (!perms) return null;
  return { read: !!perms.pull, write: !!perms.push, admin: !!perms.admin };
}
