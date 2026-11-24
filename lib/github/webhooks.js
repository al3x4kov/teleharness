// FEAT-20.3 (1.6): webhook на стороне GitHub — создание, ping, проверка, удаление.
// Право «Webhooks: write» проверяется пробным GET /repos/{r}/hooks
// (403 → нет права; design §2). Токен ходит только в заголовке ghFetch.
import { ghFetch, GhError, GITHUB_API } from "./client.js";

// Виды событий триггера → имена webhook-событий GitHub.
const EVENT_OF = {
  issue_labeled: "issues", issue_opened: "issues", comment_command: "issue_comment",
  pr_opened: "pull_request", ci_failed: "workflow_run", push: "push",
};
export function githubEvents(kinds) {
  const list = (kinds ?? []).map((k) => EVENT_OF[k]).filter(Boolean);
  // BUG-316: для «Починить CI» нужен push на webhook, чтобы коммит человека сбрасывал ci_attempts.
  if ((kinds ?? []).includes("ci_failed")) list.push("push");
  return [...new Set(list)];
}

export async function canManageHooks(token, repo, opts = {}) {
  try {
    await ghFetch(token, `/repos/${repo}/hooks?per_page=1`, opts);
    return true;
  } catch (e) {
    // 403/401 — нет права; 404 — репозиторий токену не виден: управлять хуком нельзя.
    if (e instanceof GhError && ["forbidden", "auth", "not_found"].includes(e.kind)) return false;
    throw e;
  }
}

export async function createRepoWebhook(token, repo, { url, secret, events }, opts = {}) {
  const r = await ghFetch(token, `/repos/${repo}/hooks`, {
    ...opts, method: "POST",
    body: {
      name: "web", active: true,
      events: events.length ? events : ["issues"],
      config: { url, content_type: "json", secret, insecure_ssl: "0" },
    },
  });
  return r.data; // { id, ping_url, active, ... }
}

// GitHub шлёт ping асинхронно: ошибка ping не срывает создание хука.
export async function pingRepoWebhook(token, repo, id, opts = {}) {
  return (await ghFetch(token, `/repos/${repo}/hooks/${id}/pings`, { ...opts, method: "POST" })).kind;
}

export async function getRepoWebhook(token, repo, id, opts = {}) {
  return (await ghFetch(token, `/repos/${repo}/hooks/${id}`, opts)).data;
}

// После локальной ротации секрета GitHub должен подписывать новым.
export async function updateRepoWebhookSecret(token, repo, id, secret, opts = {}) {
  return (await ghFetch(token, `/repos/${repo}/hooks/${id}`, { ...opts, method: "PATCH", body: { config: { secret } } })).data;
}

export async function deleteRepoWebhook(token, repo, id, opts = {}) {
  return (await ghFetch(token, `/repos/${repo}/hooks/${id}`, { ...opts, method: "DELETE" })).kind;
}
