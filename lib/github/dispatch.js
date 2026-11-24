// FEAT-20.3 (1.5/1.8/1.10): обработка принятой доставки — решение, журнал, запуск.
// Асинхронный обходчик inbox: приёмник отвечает ≤ 1 с (202), обработка идёт
// после ответа; необработанные доставки доигрываются после рестарта (кр. 22).
import { createHash } from "node:crypto";
import { normalizeEvent, eventKey, subjectKey, passesFilters, AGENT_MARKER } from "./events.js";
import { decideEvent, DEFAULT_LIMITS, REPLAYABLE, CI_ATTEMPTS_MAX } from "./triggers.js";
import { prepareCiLog } from "./ci-logs.js";

// UUID v5 по RFC 4122 (SHA-1 от namespace + имени): node:crypto не имеет
// встроенного uuidv5, а внешние пакеты не нужны.
function uuidBytes(namespace) {
  const hex = String(namespace).replace(/-/g, "");
  return Buffer.from(hex, "hex");
}
export function uuidv5(namespace, name) {
  const hash = createHash("sha1").update(uuidBytes(namespace)).update(String(name)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // версия 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// Пространство имён uuidv5 для requestId запусков по событиям:
// requestId = uuidv5(EVENT_NAMESPACE, event_key) → повтор события даёт тот же
// workflow (starts UNIQUE(owner, request_id), design §7).
export const EVENT_NAMESPACE = "7b3c1e6a-52d4-4a8f-9c1b-6e0d2f8a4c73";

// Терминальные статусы workflow: subject освобождается, очередь может идти (1.11).
export const FINAL_STATES = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELED", "TERMINATED", "CONTINUED_AS_NEW"]);

// Входы события (design §7): полный словарь до фильтра по версии.
// ci_log заполняет dispatcher для ci_failed (1.14) — хвост логов упавших job'ов.
export function eventInputs(ev) {
  return {
    repo: ev.repo, number: ev.number ?? null, title: ev.title ?? "",
    body: ev.body ?? "", comment: ev.comment ?? "", branch: ev.branch ?? "",
    sha: ev.sha ?? "", url: ev.url ?? "", actor: ev.actor ?? "",
    kind: ev.kind, label: ev.label ?? "", command: ev.command ?? "",
    ci_log: ev.ciLog ?? "",
  };
}

// cleanInputs (design §7): в запуск попадают только входы, объявленные версией пайпа.
// definitionInputs — массив объявлений {name, ...} версии.
export function cleanInputs(ev, definitionInputs = []) {
  const raw = eventInputs(ev);
  const names = new Set(definitionInputs.map((i) => i?.name).filter(Boolean));
  return Object.fromEntries(Object.entries(raw).filter(([k]) => names.has(k)));
}

// FEAT-20.3 (2.5, кр. 19): источник запуска словами и ссылка на событие —
// «owner/repo#142 · метка agent», «owner/repo#139 · /agent»,
// «owner/repo · PR #320 · feature/upload · CI «test»». Чистая функция.
export function eventFace(ev) {
  if (!ev) return { ref: "событие", url: null };
  if (ev.kind === "ci_failed") {
    const onPr = ev.prNumber != null && /^https:\/\/github\.com\//.test(String(ev.url ?? ""));
    return {
      ref: `${ev.repo} · ${ev.prNumber != null ? `PR #${ev.prNumber} · ` : ""}${ev.branch ? `${ev.branch} · ` : ""}CI «${ev.workflow || "workflow"}»`,
      url: onPr ? `https://github.com/${ev.repo}/pull/${ev.prNumber}` : ev.url || null,
    };
  }
  const cause = ev.kind === "issue_labeled" && ev.label ? ` · метка ${ev.label}`
    : ev.kind === "comment_command" ? ` · /${ev.command || "agent"}`
      : ev.kind === "pr_opened" ? " · новый PR" : ev.kind === "issue_opened" ? " · новая задача" : "";
  return { ref: ev.number != null ? `${ev.repo}#${ev.number}${cause}` : ev.repo, url: ev.url || null };
}

// «Лицо» красного CI без текста — для строк журнала, которым полное тело не нужно
// (не повторяемые): PR, ветка, workflow и ссылка. По нему журнал называет строку
// («PR #320 · ветка feature/upload») и ведёт на GitHub; текста события в нём нет.
export function ciFace(ev) {
  return Object.fromEntries(["kind", "repo", "prNumber", "branch", "workflow", "url"]
    .filter((k) => ev?.[k] != null && ev[k] !== "").map((k) => [k, String(ev[k]).slice(0, 200)]));
}

// Подсчёт фоновых запусков Claude за сутки: если передан usesClaude(trigger),
// считаем только триггеры, пайпы которых реально используют движок claude.
export async function countClaudeUsedToday(store, usesClaude = null) {
  if (!usesClaude || typeof store.startedPerDayByTrigger !== "function") {
    return store.startedPerDayAll?.() ?? 0;
  }
  let total = 0;
  for (const row of store.startedPerDayByTrigger()) {
    const tr = store.getById?.(row.triggerId);
    if (tr && await usesClaude(tr)) total += row.n;
  }
  return total;
}

export function createDispatcher({
  store, connections, launch, permissionCheck = null, describeRun = null, ciLogFetch = null, usesClaude = null, log = () => {}, now = () => Date.now(),
} = {}) {
  // Команда с текстом (не только «/agent») может ждать в очереди за идущим
  // запуском — не более одной на предмет (кр. 8).
  const queueable = (ev) => ev.kind === "comment_command" && ev.body && ev.body.trim().split(/\s+/).length > 1;
  const isClaudeTrigger = async (trigger) => (usesClaude ? Boolean(await usesClaude(trigger)) : true);

  // Доверенный (design §4): владелец токена или явный список — локально;
  // остальные — через permission API (кэш 10 мин). Проверяются все, чей текст
  // попадает агенту (автор) и кто инициировал (actor).
  async function trusted(trigger, ev, connection) {
    const allowed = [connection?.login, ...(trigger.filters?.trustedAuthors ?? [])].filter(Boolean);
    const people = [...new Set([ev.author, ev.actor].filter(Boolean))];
    if (!people.length) return false;
    for (const person of people) {
      if (allowed.includes(person)) continue;
      if (permissionCheck && await permissionCheck(person, ev.repo, trigger)) continue;
      return false;
    }
    return true;
  }

  // Одна доставка из inbox. Возвращает решение (для тестов и журнала сервера).
  async function processDelivery({ deliveryId, triggerId, event, body, via: viaIn }) {
    const trigger = store.getById(triggerId);
    if (!trigger) return "trigger_gone";
    const parsed = typeof body === "string" ? safeJson(body) : body;
    const ev = normalizeEvent({ event }, parsed);
    if (!ev) return "unsupported";
    const via = viaIn === "poll" ? "poll" : "webhook"; // опрос (1.7) пишет доставки с via='poll'
    const tKey = subjectKey(triggerId, ev);
    const eKey = eventKey(triggerId, ev);
    const connection = connections?.get?.(trigger.owner) ?? null;
    const connectionOk = !!connection && ["ok"].includes(connection.status);

    // Человеческий push в ту же ветку — сброс попыток «Починить CI» (design §4).
    // BUG-316: собственный push агента (refs/heads/teleharness/, трейлер Co-Authored-By или lastAgentSha)
    // не сбрасывает счётчик попыток и отличается от человеческого в журнале.
    if (ev.kind === "push") {
      if (trigger.repo && ev.repo && String(ev.repo).toLowerCase() !== String(trigger.repo).toLowerCase()) {
        store.markProcessed(deliveryId);
        return "filtered_repo";
      }
      const subject = store.subjectOf(triggerId, tKey)
        ?? (trigger.repo !== ev.repo ? store.subjectOf(triggerId, `${triggerId}:${trigger.repo}:branch:${ev.branch}`) : null);
      const isAgent = Boolean(ev.agentPush) || Boolean(ev.sha && subject?.lastAgentSha && ev.sha.toLowerCase() === subject.lastAgentSha.toLowerCase());
      if (isAgent) {
        store.record({
          triggerId, eventKey: null, kind: ev.kind, repo: ev.repo, number: null,
          actor: ev.actor, decision: "agent_loop", reason: REASONS.agent_loop, workflowId: null, via, eventJson: null,
        });
        store.markProcessed(deliveryId);
        return "agent_loop";
      }
      store.humanCommit(triggerId, tKey, ev.sha || "");
      store.record({
        triggerId, eventKey: null, kind: ev.kind, repo: ev.repo, number: null,
        actor: ev.actor, decision: "push_reset", reason: REASONS.push_reset, workflowId: null, via, eventJson: null,
      });
      store.markProcessed(deliveryId);
      return "push_reset";
    }

    // Петля: действие портала (комментарий с маркером) не запускает работу (design §4).
    if (ev.kind === "comment_command" && AGENT_MARKER.test(ev.body)) {
      store.markProcessed(deliveryId);
      return "agent_loop";
    }

    const first = store.firstByEventKey(eKey);
    const subject = store.subjectOf(triggerId, tKey);
    const usesClaudePipe = await isClaudeTrigger(trigger);
    const claudeLimit = store.setting("claude_background_per_day", 10) ?? 10;
    const claudePerDay = usesClaudePipe ? await countClaudeUsedToday(store, usesClaude) : 0;
    const userPerDayLimit = store.setting("default_user_per_day", trigger.limits?.userPerDay ?? DEFAULT_LIMITS.userPerDay);
    const effectiveLimits = { ...trigger.limits, userPerDay: userPerDayLimit };
    const state = {
      ev, trigger,
      duplicate: !!first,
      activeWorkflowId: subject?.activeWorkflowId || null,
      queuedEventKey: subject?.queuedEventKey || null,
      queueable: queueable(ev),
      queueLen: store.queuedCount(triggerId),
      perHour: store.startedPerHour(triggerId),
      userPerDay: store.startedPerDayForOwner(trigger.owner),
      claudePerDay,
      serverLimits: { claudePerDay: usesClaudePipe ? claudeLimit : Number.POSITIVE_INFINITY },
      adminStopped: store.setting("adminStopped", false) === true,
      connectionOk,
      trusted: await trusted(trigger, ev, connection),
      ciAttempts: subject?.ciAttempts ?? 0,
      limits: effectiveLimits,
    };
    const verdict = passesFilters(ev, trigger);
    let decision;
    let workflowId = null;
    if (!verdict.ok) {
      decision = verdict.reason;
    } else {
      decision = decideEvent(state).decision;
    }
    const reasonText = REASONS[decision] ?? null;

    if (decision === "duplicate") workflowId = first?.workflowId ?? null;
    if (decision === "started") {
      // «Починить CI» (1.14): логи упавших job'ов — во вход ci_log; недоступны —
      // запуск не состоялся (кр. 15), агент без логов CI не нужен.
      if (ev.kind === "ci_failed" && ciLogFetch) {
        try {
          ev.ciLog = ev.workflowRunId ? await ciLogFetch(trigger.owner, ev.repo, ev.workflowRunId) ?? "" : "";
        } catch (error) {
          decision = "ci_logs_unavailable";
          log(`github-dispatch: логи CI недоступны: ${error?.message ?? error}`);
        }
      }
    }
    // Попытки исчерпаны (T-17): лист события показывает хвост лога — по возможности;
    // недоступные логи решению «Нужен человек» не мешают. Короткий хвост и маскирование
    // секретов — здесь же: журнал читается списком, в отличие от входа запуска.
    if (decision === "ci_attempts_exhausted" && ev.kind === "ci_failed" && ciLogFetch && ev.workflowRunId) {
      try { ev.ciLog = prepareCiLog(String(await ciLogFetch(trigger.owner, ev.repo, ev.workflowRunId) ?? ""), 8192); } catch { ev.ciLog = ""; }
    }
    if (decision === "started") {
      try {
        // requestId детерминирован событием: повтор события даёт тот же workflow.
        // «Починить CI»: номер попытки — в запуск (экран показывает «попытка N из 2»).
        const run = await launch(trigger, ev, uuidv5(EVENT_NAMESPACE, eKey), { attempt: ev.kind === "ci_failed" ? state.ciAttempts + 1 : null });
        workflowId = run?.workflowId ?? null;
      } catch (error) {
        log(`github-dispatch: запуск не состоялся: ${error?.message ?? error}`);
        store.record({ triggerId, eventKey: null, kind: ev.kind, repo: ev.repo, number: ev.number ?? null, actor: ev.actor, decision: "error", reason: String(error?.message ?? error).slice(0, 200), via, eventJson: JSON.stringify(ev) });
        store.markProcessed(deliveryId);
        return "error";
      }
      if (workflowId) {
        store.setActive(triggerId, tKey, workflowId);
        // Коммит агента = попытка «Починить CI» (design §4); человеческий push сбрасывает.
        if (ev.kind === "ci_failed") store.bumpCi(triggerId, tKey);
      }
    }
    if (decision === "queued") store.setQueued(triggerId, tKey, eKey);

    // Дубликат: запись без event_key (UNIQUE занят первой записью), со ссылкой.
    // Шторм: > 20 событий за 10 мин на триггер — флаг для баннера (кр. 10).
    // Тело события: у повторяемых (для повтора) и у «Нужен человек» (хвост лога, T-17);
    // у остальных решений красного CI — «лицо» без текста (ciFace), иначе ничего.
    store.record({
      triggerId, eventKey: decision === "duplicate" ? null : eKey, kind: ev.kind, repo: ev.repo,
      number: ev.number ?? null, actor: ev.actor, decision, reason: reasonText, workflowId, via,
      eventJson: REPLAYABLE.has(decision) || decision === "ci_attempts_exhausted" ? JSON.stringify(ev)
        : ev.kind === "ci_failed" ? JSON.stringify(ciFace(ev)) : null,
    });
    if (store.eventsPerWindow(triggerId, 600_000) > 20) store.setSetting(`storm:${triggerId}`, { at: now() });
    store.markProcessed(deliveryId);
    return decision;
  }

  // Доигрывание необработанных доставок после рестарта (кр. 22).
  async function resume(limit = 100) {
    let n = 0;
    for (const delivery of store.pendingDeliveries(limit)) {
      try {
        await processDelivery(delivery);
        n += 1;
      } catch (error) {
        log(`github-dispatch: доставка ${delivery.deliveryId}: ${error?.message ?? error}`);
      }
    }
    return n;
  }

  // Обходчик очереди (1.11): завершённые запуски освобождают subject, отложенное
  // событие запускается тем же requestId (uuidv5(event_key)) с записью «Из очереди».
  // При недоступном Temporal subject не трогается — попытка в следующем проходе.
  async function sweep() {
    for (const row of store.activeSubjects()) {
      try {
        if (row.activeWorkflowId) {
          let finished = false;
          if (describeRun) {
            try {
              finished = FINAL_STATES.has((await describeRun(row.activeWorkflowId))?.status);
            } catch (error) {
              log(`github-dispatch: describeRun ${row.activeWorkflowId}: ${error?.message ?? error}`);
              continue;
            }
          } else finished = true; // в тестах без Temporal: запуск без активного WorkflowId освобождается
          if (!finished) continue;
          store.clearActive(row.triggerId, row.subjectKey);
        }
        const eKey = row.queuedEventKey;
        if (!eKey) continue;
        const trigger = store.getById(row.triggerId);
        const entry = store.firstByEventKey(eKey);
        const ev = typeof entry?.eventJson === "string" ? safeJson(entry.eventJson) : entry?.eventJson ?? null;
        if (!trigger || !ev) {
          log(`github-dispatch: очередь ${eKey}: событие или триггер не найдены, освобождаю`);
          store.releaseQueued(row.triggerId, row.subjectKey);
          continue;
        }
        const connection = connections?.get?.(trigger.owner) ?? null;
        const connectionOk = !!connection && ["ok"].includes(connection.status);
        const usesClaudePipe = await isClaudeTrigger(trigger);
        const claudeLimit = store.setting("claude_background_per_day", 10) ?? 10;
        const claudePerDay = usesClaudePipe ? await countClaudeUsedToday(store, usesClaude) : 0;
        const userPerDayLimit = store.setting("default_user_per_day", trigger.limits?.userPerDay ?? DEFAULT_LIMITS.userPerDay);
        const gate = decideEvent({
          ev,
          trigger,
          duplicate: false,
          activeWorkflowId: null,
          queuedEventKey: null,
          queueable: false,
          queueLen: 0,
          perHour: store.startedPerHour(trigger.id),
          userPerDay: store.startedPerDayForOwner(trigger.owner),
          claudePerDay,
          serverLimits: { claudePerDay: usesClaudePipe ? claudeLimit : Number.POSITIVE_INFINITY },
          adminStopped: store.setting("adminStopped", false) === true,
          connectionOk,
          trusted: true,
          ciAttempts: 0,
          limits: { ...trigger.limits, userPerDay: userPerDayLimit },
        });
        store.releaseQueued(row.triggerId, row.subjectKey);
        if (gate.decision !== "started") {
          store.record({
            triggerId: row.triggerId, eventKey: null, kind: ev.kind, repo: ev.repo, number: ev.number ?? null,
            actor: ev.actor, decision: gate.decision, reason: REASONS[gate.decision] ?? gate.reason ?? null,
            workflowId: null, via: entry.via ?? "webhook",
            eventJson: REPLAYABLE.has(gate.decision) ? JSON.stringify(ev) : null,
          });
          continue;
        }
        let workflowId = null;
        try {
          const run = await launch(trigger, ev, uuidv5(EVENT_NAMESPACE, eKey));
          workflowId = run?.workflowId ?? null;
          if (workflowId) store.setActive(row.triggerId, row.subjectKey, workflowId);
          store.record({ triggerId: row.triggerId, eventKey: null, kind: ev.kind, repo: ev.repo, number: ev.number ?? null,
            actor: ev.actor, decision: "started", reason: "Из очереди", workflowId, via: entry.via ?? "webhook", eventJson: null });
        } catch (error) {
          log(`github-dispatch: выпуск из очереди не состоялся: ${error?.message ?? error}`);
          store.record({ triggerId: row.triggerId, eventKey: null, kind: ev.kind, repo: ev.repo, number: ev.number ?? null,
            actor: ev.actor, decision: "error", reason: `Из очереди: ${String(error?.message ?? error).slice(0, 180)}`, via: entry.via ?? "webhook", eventJson: null });
        }
      } catch (error) {
        log(`github-dispatch: sweep ${row.subjectKey}: ${error?.message ?? error}`);
      }
    }
  }

  return { processDelivery, resume, sweep, queueable };
}

const REASONS = {
  started: null,
  duplicate: "Дубликат события",
  already_running: "Уже идёт запуск",
  queued: "В очередь за идущим запуском",
  queue_full: "Очередь полна",
  queue_cleared: "Очередь очищена",
  rate_limited: "Лимит частоты",
  claude_limit: "Лимит Claude в фоне",
  untrusted_author: "Пропущено: автор не доверен",
  fork_pr: "Событие из форка",
  filtered_repo: "Репозиторий не совпал",
  filtered_label: "Метка не совпала",
  filtered_branch: "Ветка не совпала",
  filtered_command: "Команда не совпала",
  filtered_kind: "Вид события не включён в триггер",
  ci_not_failed: "CI не красный",
  ci_logs_unavailable: "Логи CI недоступны",
  ci_attempts_exhausted: `Нужен человек: ${CI_ATTEMPTS_MAX} из ${CI_ATTEMPTS_MAX} попыток`,
  agent_loop: "Коммит агента (счётчик CI не сброшен)",
  push_reset: "Сброс: коммит человека",
  trigger_disabled: "Триггер выключен",
  admin_stopped: "Остановлено администратором",
  no_connection: "Нет подключения GitHub",
  bad_signature: "Подпись неверна",
  too_large: "Тело больше 1 МБ",
  error: "Ошибка обработки",
};

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
