// FEAT-20.3 (1.7): опрос-страховка и сверка — issues, комментарии, красный CI.
// Доставки пишутся в тот же inbox и нормализуются как webhook: event_key
// совпадает, дедупликация журнала делает повторную эмиссию безопасной (кр. 7).
// Режимы: poll — каждые pollSeconds; auto с хуком — сверка раз в 15 мин;
// auto без хука — как poll (design §2). ETag/304 лимит не тратят; бюджет
// ≤ 1000 запросов/ч на подключение; rate_limited от GitHub → пауза ×2.
import { randomUUID } from "node:crypto";
import { ghFetch, GhError, GITHUB_API } from "./client.js";
import { COMMAND_RE } from "./events.js";

export const BUDGET_PER_HOUR = 1000;
const PAGES = 2; // ≤ 2 страницы × 50 — бюджет триггера за цикл
const PER_PAGE = 50;

export function createGithubPoller({
  store, dispatcher, connectionToken, apiBase = GITHUB_API,
  log = () => {}, now = () => Date.now(), tickMs = 30_000, fetchImpl,
} = {}) {
  const lastPoll = new Map();     // triggerId → ts последнего цикла
  const spent = new Map();        // owner → [ts запросов за час]
  const pausedUntil = new Map();  // owner → ts (GitHub сообщил rate_limited)
  let timer = null;
  let running = false;

  function budgetOk(owner) {
    if ((pausedUntil.get(owner) ?? 0) > now()) return false;
    const arr = (spent.get(owner) ?? []).filter((t) => now() - t < 3600_000);
    spent.set(owner, arr);
    return arr.length < BUDGET_PER_HOUR;
  }
  function spend(owner) {
    const arr = spent.get(owner) ?? [];
    arr.push(now());
    spent.set(owner, arr);
  }
  // Пауза на двойной интервал триггера при исчерпании лимита (design §2).
  function pause(owner, trigger) {
    pausedUntil.set(owner, now() + 2 * trigger.pollSeconds * 1000);
    log(`github-poll: ${trigger.repo} — лимит GitHub, пауза до ${new Date(pausedUntil.get(owner)).toISOString()}`);
  }

  // Режим опроса триггера → интервал мс или null (опрос не нужен).
  function modeOf(trigger) {
    if (!trigger.enabled) return null;
    if (trigger.delivery === "poll") return trigger.pollSeconds * 1000;
    if (trigger.delivery === "auto") return trigger.hookId ? 900_000 : trigger.pollSeconds * 1000;
    return null; // webhook — доставляет GitHub
  }

  function gh(owner, pathname, opts = {}) {
    const token = connectionToken(owner);
    if (!token) return Promise.reject(new GhError(0, "no_connection", "Нет подключения GitHub"));
    spend(owner);
    return ghFetch(token, pathname, { apiBase, ...(fetchImpl ? { fetchImpl } : {}), ...opts });
  }

  // Страница с ETag-курсором: 304 → {items: [], etag прежний}. actions/runs
  // отдаёт объект {total_count, workflow_runs} — разворачиваем в массив.
  async function fetchResource(owner, pathname, etag) {
    const r = await gh(owner, pathname, { etag });
    if (r.kind === "not_modified") return { items: [], etag: etag ?? null };
    const data = r.data;
    const items = Array.isArray(data) ? data : Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    return { items, etag: r.etag ?? null };
  }

  // Доставка псевдо-webhook: тот же путь нормализации и журнала, via = poll.
  async function deliver(trigger, event, body) {
    const id = randomUUID();
    const payload = JSON.stringify(body);
    if (!store.insertDelivery(id, trigger.id, event, payload)) return "duplicate";
    return dispatcher.processDelivery({ deliveryId: id, triggerId: trigger.id, event, body: payload, via: "poll" });
  }

  const slim = (issue) => ({
    number: issue.number, title: issue.title ?? "", body: issue.body ?? "",
    html_url: issue.html_url ?? "", user: { login: issue.user?.login ?? "" },
    labels: (issue.labels ?? []).map((l) => ({ name: typeof l === "string" ? l : l?.name })),
    created_at: issue.created_at, updated_at: issue.updated_at,
  });
  const startedCount = async (promise) => ((await promise) === "started" ? 1 : 0);
  const maxSeen = (current, items, field) => items.reduce((m, it) => (String(it?.[field] ?? "") > m ? String(it[field]) : m), current);

  async function pollTrigger(trigger) {
    const owner = trigger.owner;
    if (!budgetOk(owner)) return 0;
    let processed = 0;
    const first = new Date(trigger.createdAt - trigger.pollSeconds * 1000).toISOString();

    const issuesByNumber = new Map();
    // 1) Задачи: новые и с метками. Записи PR (pull_request) пропускаются.
    try {
      const cur = store.cursorGet(trigger.id, "issues") ?? {};
      const since = cur.since ?? first;
      let items = [];
      let etag = cur.etag ?? null;
      for (let page = 1; page <= PAGES; page++) {
        const suffix = page === 1 ? `&since=${encodeURIComponent(since)}` : "";
        const r = await fetchResource(owner, `/repos/${trigger.repo}/issues?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}${suffix}`, etag);
        items.push(...r.items.filter((it) => !it.pull_request));
        etag = r.etag;
        if (r.items.length < PER_PAGE) break;
      }
      for (const issue of items) {
        issuesByNumber.set(issue.number, issue);
        const base = { action: "opened", repository: { full_name: trigger.repo }, sender: { login: issue.user?.login ?? "" }, issue: slim(issue) };
        if (issue.created_at >= since) processed += await startedCount(deliver(trigger, "issues", base));
        const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
        const wanted = trigger.filters?.label ? labels.find((l) => l === trigger.filters.label) : labels[0];
        if (wanted) processed += await startedCount(deliver(trigger, "issues", { ...base, action: "labeled", label: { name: wanted } }));
      }
      store.cursorSet(trigger.id, "issues", { etag, since: maxSeen(since, items, "updated_at") });
    } catch (e) {
      if (e instanceof GhError && e.kind === "rate_limited") pause(owner, trigger);
      else if (e.kind !== "no_connection") log(`github-poll: ${trigger.repo} (${trigger.id}) issues: ${e?.message ?? e}`);
    }

    // 2) Команды в комментариях. В списке нет меток/заголовка задачи —
    //    недостающее честно отсечёт фильтр триггера (filtered_*).
    try {
      const cur = store.cursorGet(trigger.id, "comments") ?? {};
      const since = cur.since ?? first;
      const r = await fetchResource(owner, `/repos/${trigger.repo}/issues/comments?sort=created&direction=desc&per_page=${PER_PAGE}&since=${encodeURIComponent(since)}`, cur.etag ?? null);
      for (const c of r.items) {
        const command = COMMAND_RE.exec(String(c.body ?? ""));
        if (!command) continue;
        const number = Number((c.issue_url ?? "").split("/").pop()) || null;
        let issueObj = number != null ? issuesByNumber.get(number) : null;
        if (!issueObj && number != null && budgetOk(owner)) {
          try {
            const ir = await gh(owner, `/repos/${trigger.repo}/issues/${number}`);
            if (ir?.data && typeof ir.data === "object") {
              issueObj = ir.data;
              issuesByNumber.set(number, issueObj);
            }
          } catch {}
        }
        processed += await startedCount(deliver(trigger, "issue_comment", {
          action: "created", repository: { full_name: trigger.repo }, sender: { login: c.user?.login ?? "" },
          issue: issueObj ? slim(issueObj) : { number, title: "", body: "", html_url: c.issue_url ?? "", labels: [] },
          comment: { id: c.id, body: c.body ?? "", user: { login: c.user?.login ?? "" }, html_url: c.html_url ?? "" },
        }));
      }
      store.cursorSet(trigger.id, "comments", { etag: r.etag, since: maxSeen(since, r.items, "created_at") });
    } catch (e) {
      if (e instanceof GhError && e.kind === "rate_limited") pause(owner, trigger);
      else if (e.kind !== "no_connection") log(`github-poll: ${trigger.repo} (${trigger.id}) comments: ${e?.message ?? e}`);
    }

    // 3) Красный CI за окно (created > since).
    try {
      const cur = store.cursorGet(trigger.id, "runs") ?? {};
      const since = cur.since ?? first;
      const r = await fetchResource(owner, `/repos/${trigger.repo}/actions/runs?status=failure&per_page=${PER_PAGE}&created=${encodeURIComponent(`>${since}`)}`, cur.etag ?? null);
      for (const run of r.items) {
        processed += await startedCount(deliver(trigger, "workflow_run", {
          action: "completed", repository: { full_name: trigger.repo }, sender: { login: run.actor?.login ?? "" },
          workflow_run: { name: run.name ?? "", id: run.id, conclusion: "failure", head_sha: run.head_sha ?? "",
            head_branch: run.head_branch ?? "", html_url: run.html_url ?? "", actor: { login: run.actor?.login ?? "" } },
        }));
      }
      store.cursorSet(trigger.id, "runs", { etag: r.etag, since: maxSeen(since, r.items, "created_at") });
    } catch (e) {
      if (e instanceof GhError && e.kind === "rate_limited") pause(owner, trigger);
      else if (e.kind !== "no_connection") log(`github-poll: ${trigger.repo} (${trigger.id}) runs: ${e?.message ?? e}`);
    }

    return processed;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const row of store.listAll()) {
        const trigger = store.getById(row.id);
        const mode = modeOf(trigger);
        if (!mode) continue;
        const last = lastPoll.get(trigger.id) ?? -Infinity;
        if (now() - last < mode) continue;
        lastPoll.set(trigger.id, now());
        try {
          await pollTrigger(trigger);
        } catch (error) {
          log(`github-poll: цикл ${trigger.repo}: ${error?.message ?? error}`);
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, pollTrigger, modeOf, budgetOk, spend };
}
