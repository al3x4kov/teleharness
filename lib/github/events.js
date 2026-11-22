// FEAT-20.3 (1.5/1.8): события GitHub — нормализация, ключи, подпись, фильтры.
// Чистые функции без БД и сети: webhook и опрос приводят к одному виду,
// event_key/subject_key совпадают для обеих доставок (кр. 7).
import { createHmac, timingSafeEqual } from "node:crypto";

// Виды событий, на которые реагируют триггеры (design §4).
export const KINDS = ["issue_labeled", "issue_opened", "comment_command", "ci_failed", "pr_opened"];

// Команда в комментарии: «/agent …» (триггер хранит своё слово, по умолчанию agent).
export const COMMAND_RE = /^\/([a-z0-9_-]{1,64})\b/i;
// Маркер «это действие портала» — не запускает «Задача → PR» (design §4, петли).
export const AGENT_MARKER = /<!--\s*teleharness:agent\s*-->/;

const fullName = (r) => String(r?.repository?.full_name ?? "");
const labelsOf = (issue) => (Array.isArray(issue?.labels) ? issue.labels.map((l) => String(l?.name ?? "")).filter(Boolean) : []);

// Заголовки: {event, delivery}. Тело — уже прочитанная строка/объект.
// Возвращает null для событий, на которые триггеры не реагируют.
export function normalizeEvent(headers, body) {
  const type = String(headers.event ?? "");
  const b = typeof body === "string" ? safeJson(body) : body;
  if (!b || typeof b !== "object") return null;
  const repo = fullName(b);
  const actor = String(b.sender?.login ?? "");
  const base = { repo, actor, action: String(b.action ?? "") };
  switch (type) {
    case "issues": {
      const it = b.issue;
      if (!it || !repo) return null;
      const common = { number: it.number, author: String(it.user?.login ?? ""), title: String(it.title ?? ""), body: String(it.body ?? ""), url: String(it.html_url ?? ""), labels: labelsOf(it) };
      if (b.action === "opened") return { ...base, ...common, kind: "issue_opened", label: null };
      if (b.action === "labeled" && b.label?.name) return { ...base, ...common, kind: "issue_labeled", label: String(b.label.name) };
      return null;
    }
    case "issue_comment": {
      const c = b.comment;
      const it = b.issue;
      if (!c || !it || b.action !== "created" || !repo) return null;
      const command = COMMAND_RE.exec(String(c.body ?? ""));
      if (!command) return null;
      return {
        ...base, kind: "comment_command", number: it.number, author: String(c.user?.login ?? ""),
        title: String(it.title ?? ""), body: String(c.body ?? ""), url: String(c.html_url ?? it.html_url ?? ""),
        labels: labelsOf(it), command: command[1].toLowerCase(), commentId: c.id ?? null,
      };
    }
    case "pull_request": {
      const pr = b.pull_request;
      if (!pr || b.action !== "opened" || !repo) return null;
      return {
        ...base, kind: "pr_opened", number: pr.number, author: String(pr.user?.login ?? ""),
        title: String(pr.title ?? ""), body: String(pr.body ?? ""), url: String(pr.html_url ?? ""),
        branch: String(pr.head?.ref ?? ""), sha: String(pr.head?.sha ?? ""), labels: labelsOf(pr),
      };
    }
    case "workflow_run": {
      const wr = b.workflow_run;
      if (!wr || b.action !== "completed" || !repo) return null;
      if (wr.conclusion !== "failure") return { ...base, kind: "ci_not_failed", workflow: String(wr.name ?? "") };
      // FEAT-20.3 (2.5, кр. 19): PR, из ветки которого пришёл запуск, — для ссылки
      // на него на экране запуска. Отдельное поле: number менял бы event_key
      // (идемпотентность «одно событие — один запуск» для CI построена на sha+workflow).
      const pr = (Array.isArray(wr.pull_requests) ? wr.pull_requests : []).find((p) => p?.head?.ref === wr.head_branch && p?.number);
      return {
        ...base, kind: "ci_failed", workflow: String(wr.name ?? ""), workflowRunId: wr.id ?? null, prNumber: pr?.number ?? null,
        sha: String(wr.head_sha ?? ""), branch: String(wr.head_branch ?? ""),
        author: String(wr.actor?.login ?? wr.head_commit?.author?.username ?? ""), title: String(wr.display_title ?? ""),
        body: "", url: String(wr.html_url ?? ""), fork: !!wr.head_repository?.fork,
      };
    }
    case "push": {
      // Человеческий коммит сбрасывает счётчик попыток «Починить CI» (design §4).
      if (!repo || b.deleted) return null;
      return {
        ...base, kind: "push", branch: String(b.ref ?? "").replace(/^refs\/heads\//, ""),
        sha: String(b.after ?? b.head_commit?.id ?? ""), author: String(b.head_commit?.author?.username ?? b.pusher?.name ?? ""),
        agentPush: String(b.ref ?? "").includes("refs/heads/teleharness/"),
      };
    }
    default:
      return null;
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// event_key = triggerId:kind:repo:(number|sha+workflow|commentId|branch+label):action —
// одинаков для webhook и опроса; UNIQUE в журнале даёт «одно событие — один запуск»
// (кр. 7). Разные комментарии одной задачи — разные события (subject общий, кр. 8).
export function eventKey(triggerId, ev) {
  let subject;
  if (ev.kind === "comment_command") subject = `c${ev.commentId ?? "x"}`;
  else if (ev.number != null) subject = `n${ev.number}`;
  else if (ev.sha) subject = `${ev.sha}${ev.workflow ? `+${ev.workflow}` : ""}`;
  else subject = `${ev.branch ?? ""}${ev.label ?? ""}`;
  return `${triggerId}:${ev.kind}:${ev.repo}:${subject}:${ev.action || "default"}`;
}

// subject_key = triggerId:repo:(issue#N | pr#N | branch:name) — «один запуск
// на задачу/PR/ветку» (кр. 8).
export function subjectKey(triggerId, ev) {
  if (ev.kind === "ci_failed" || ev.kind === "push") return `${triggerId}:${ev.repo}:branch:${ev.branch}`;
  if (ev.kind === "pr_opened") return `${triggerId}:${ev.repo}:pr#${ev.number}`;
  return `${triggerId}:${ev.repo}:issue#${ev.number}`;
}

// Подпись X-Hub-Signature-256: HMAC-SHA256 секретом триггера, постоянное время.
export function verifySignature(secret, body, header) {
  const got = String(header ?? "");
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Фильтры триггера: {label, branch, command, trustedAuthors:[login]} + kinds.
// Возвращает {ok:true} либо {ok:false, reason:"filtered_label"|"filtered_branch"|...}.
export function passesFilters(ev, trigger) {
  const kinds = readList(trigger.kinds);
  if (kinds.length && !kinds.includes(ev.kind)) return { ok: false, reason: "filtered_kind" };
  const filters = trigger.filters ?? {};
  if (filters.label && (ev.kind === "issue_labeled" || ev.kind === "issue_opened") && !ev.labels?.includes(filters.label)) return { ok: false, reason: "filtered_label" };
  if (filters.branch && ev.branch && ev.branch !== filters.branch) return { ok: false, reason: "filtered_branch" };
  if (ev.kind === "comment_command" && filters.command && ev.command !== String(filters.command).toLowerCase()) {
    return { ok: false, reason: "filtered_command" };
  }
  if (ev.kind === "ci_failed" && ev.fork) return { ok: false, reason: "fork_pr" };
  return { ok: true };
}

function readList(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v) ?? []; } catch { return []; }
}
