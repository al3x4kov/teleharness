// FEAT-20.3 (1.4/1.17): CRUD триггеров Temporal по событиям GitHub.
// Только свои триггеры: чужой → 404, не 403 (кр. 21). Ревизия: PATCH/DELETE
// с устаревшей ревизией → 409. Создание требует включённых Temporal-пайпов
// (как расписания). Ключ и секрет webhook-адреса показываются один раз (кр. 21).
import { TriggerError, REPLAYABLE, DEFAULT_LIMITS } from "../lib/github/triggers.js";
import { KINDS, subjectKey, eventKey } from "../lib/github/events.js";
import { EVENT_NAMESPACE, uuidv5, ciFace, countClaudeUsedToday } from "../lib/github/dispatch.js";
import { githubEvents, canManageHooks, createRepoWebhook, pingRepoWebhook, getRepoWebhook, updateRepoWebhookSecret, deleteRepoWebhook } from "../lib/github/webhooks.js";
import { GhError } from "../lib/github/client.js";
import { runGit } from "../lib/git.js";
import { TEMPLATES, templateFace, templateById } from "../shared/temporal-templates.js";

const REPO_RE = /^[^/\s\\]+\/[^/\s\\]+$/;

// BUG-317: разбор URL git remote origin (HTTPS/SSH) в вид owner/repo.
export function parseGithubOrigin(rawUrl) {
  const s = String(rawUrl ?? "").trim();
  if (!s) return null;
  // git@github.com:owner/repo(.git)?
  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (scp) return scp[1];
  try {
    const u = new URL(s);
    if (!/^github\.com$/i.test(u.hostname)) return null;
    const p = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    const parts = p.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

// BUG-317: сверка git remote origin выбранной папки с репозиторием триггера.
export async function checkGitOrigin(dir, expectedRepo, { untrusted = false, runGitImpl = runGit } = {}) {
  try {
    const res = await runGitImpl(["remote", "get-url", "origin"], { cwd: dir, untrusted: Boolean(untrusted), timeoutMs: 5000 });
    if (!res || res.code !== 0 || !String(res.stdout ?? "").trim()) {
      return { ok: false, reason: "no_origin", message: "В выбранной папке нет git-репозитория с remote origin" };
    }
    const actual = parseGithubOrigin(res.stdout);
    if (!actual) {
      return { ok: false, reason: "not_github", message: "Remote origin выбранной папки не указывает на GitHub" };
    }
    if (actual.toLowerCase() !== String(expectedRepo ?? "").trim().toLowerCase()) {
      return { ok: false, reason: "origin_mismatch", actual, message: `Папка указывает на ${actual}, а выбран репозиторий ${expectedRepo}` };
    }
    return { ok: true, actual };
  } catch {
    return { ok: false, reason: "no_origin", message: "Не удалось проверить remote origin выбранной папки" };
  }
}

export function face(row) {
  return {
    id: row.id,
    repo: row.repo,
    definitionId: row.definitionId,
    version: row.version,
    kinds: row.kinds,
    filters: row.filters,
    delivery: row.delivery,
    pollSeconds: row.pollSeconds,
    enabled: row.enabled,
    limits: row.limits,
    hookConfigured: row.hookId != null,
    revision: row.revision,
    createdAt: row.createdAt,
  };
}

export function validateSpec(spec = {}) {
  if (typeof spec.definitionId !== "string" || !/^[a-f0-9-]{36}$/.test(spec.definitionId)) throw new TriggerError(422, "Укажите пайп");
  if (spec.version != null && (!Number.isInteger(spec.version) || spec.version < 1)) throw new TriggerError(422, "Версия пайпа — целое число или пусто (последняя опубликованная)");
  if (typeof spec.repo !== "string" || !REPO_RE.test(spec.repo)) throw new TriggerError(422, "Репозиторий — в виде owner/name");
  if (spec.kinds != null) {
    if (!Array.isArray(spec.kinds) || spec.kinds.some((k) => !KINDS.includes(k))) throw new TriggerError(422, `Виды событий: ${KINDS.join(", ")}`);
  }
  const filters = spec.filters ?? {};
  if (typeof filters !== "object" || Array.isArray(filters)) throw new TriggerError(422, "Фильтры — объект");
  for (const key of ["label", "branch", "command"]) {
    if (filters[key] != null && (typeof filters[key] !== "string" || filters[key].length > 100)) throw new TriggerError(422, `Фильтр «${key}» — строка до 100 символов`);
  }
  if (filters.trustedAuthors != null && (!Array.isArray(filters.trustedAuthors) || filters.trustedAuthors.some((a) => typeof a !== "string" || !/^[\w-]{1,64}$/.test(a)))) {
    throw new TriggerError(422, "Доверенные авторы — список логинов");
  }
  if (spec.delivery != null && !["auto", "webhook", "poll"].includes(spec.delivery)) throw new TriggerError(422, "Доставка: auto, webhook или poll");
  if (spec.pollSeconds != null && (!Number.isInteger(spec.pollSeconds) || spec.pollSeconds < 60 || spec.pollSeconds > 900)) throw new TriggerError(422, "Опрос — 60–900 секунд");
  if (spec.limits != null) {
    const l = spec.limits;
    for (const [k, min, max] of [["perHour", 1, 60], ["queue", 1, 100]]) {
      if (l[k] != null && (!Number.isInteger(l[k]) || l[k] < min || l[k] > max)) throw new TriggerError(422, `Лимит ${k}: ${min}–${max}`);
    }
  }
}

export function triggerRoutes(deps) {
  const base = "/teleharness/api/temporal/triggers";
  const { sendJson, readJsonBody, errLog, store, pipelinesEnabled, pipeOf, resolveVersion, launch, cancelRun, publicUrl, log, connectionToken, apiBase } = deps;

  function fail(status, message, extra) {
    const e = new TriggerError(status, message, extra);
    return e;
  }
  function mapGhError(error) {
    const status = error.kind === "auth" ? 401
      : error.kind === "forbidden" ? 403
        : error.kind === "not_found" ? 404
          : error.kind === "validation" ? 422
            : error.kind === "rate_limited" ? 429
              : 502;
    return { status, message: error.message || "Ошибка обращения к GitHub" };
  }
  function route(method, path, handler, scope = "user") {
    return {
      method, path, scope,
      handler: async (ctx) => {
        try {
          if (!ctx.user?.id) throw fail(403, "Требуется авторизация");
          if (scope === "admin" && ctx.user.role !== "admin") throw fail(403, "Доступно только администратору");
          await handler(ctx);
        } catch (error) {
          if (error instanceof TriggerError) {
            sendJson(ctx.res, error.status, { error: error.message, ...error.extra });
            return;
          }
          if (error instanceof GhError) {
            const m = mapGhError(error);
            sendJson(ctx.res, m.status, { error: m.message });
            return;
          }
          throw error;
        }
      },
    };
  }
  const own = (user, id) => {
    const row = store.get(user.id, id);
    if (!row) throw fail(404, "Триггер не найден");
    return row;
  };
  const hookUrl = (key) => (publicUrl ? `${publicUrl}/hooks/github/${key}` : null);

  return [
    // FEAT-20.3 (1.15): шаблоны фоновых агентов и «Готовность» (кр. 4, 16).
    route("GET", "/teleharness/api/temporal/templates", async ({ res, user }) => {
      const c = deps.connections?.get?.(user.id) ?? null;
      const models = deps.engineModels?.() ?? {};
      const githubOk = Boolean(c) && c.status === "ok";
      const engineOk = (engine, model) => Array.isArray(models[engine]) && (!model || models[engine].includes(model));
      const templates = TEMPLATES.map((t) => {
        const missing = [];
        if (t.needs.includes("github") && !githubOk) missing.push("github");
        for (const step of t.pipe.steps.filter((s) => s.type === "model")) {
          if (!engineOk(step.engine, step.model)) missing.push(`${step.engine}:${step.model}`);
        }
        return { ...templateFace(t), ready: { ok: missing.length === 0, missing } };
      });
      sendJson(res, 200, { templates, readiness: { github: { ok: githubOk, login: c?.login ?? null }, engines: { claude: models.claude ?? [], codex: models.codex ?? [], acp: models.acp ?? [], opencode: models.opencode ?? [] } } });
    }),

    // FEAT-20.3 1.15/1.18: «Готовность» мастера — что блокирует запуск шаблона.
    route("POST", /^\/teleharness\/api\/temporal\/templates\/([a-z0-9-]+)\/readiness$/, async ({ req, res, user, match }) => {
      const t = templateById(match[1]);
      if (!t) throw fail(404, "Шаблон не найден");
      let body = {};
      try { body = await readJsonBody(req, 4096); } catch { /* пустое тело допустимо */ }
      const problems = [];
      const c = deps.connections?.get?.(user.id) ?? null;
      if (t.needs.includes("github") && (!c || c.status !== "ok"))
        problems.push({ field: "github", message: "Подключите GitHub в Настройках — токен с правами на репозиторий и webhooks", blocking: true });
      const engine = body.engine ?? t.pipe.steps.find((s) => s.type === "model")?.engine ?? "claude";
      const model = body.model ?? t.pipe.steps.find((s) => s.type === "model")?.model ?? null;
      const models = deps.engineModels?.() ?? {};
      if (!Array.isArray(models[engine]) || (model && !models[engine].includes(model)))
        problems.push({ field: "model", message: `Модель «${model ?? engine}» недоступна на подписке — выберите другую в мастере`, blocking: true });
      // BUG-322: решение владельца Q1-а — Claude в фоне только для администратора; Codex у тенанта текстовый.
      if (user.role !== "admin" && engine === "claude")
        problems.push({ field: "model", message: "Claude в фоновых запусках доступен только администратору — выберите opencode", blocking: true });
      if (user.role !== "admin" && engine === "codex")
        problems.push({ field: "model", message: "Тенанту доступен только текстовый Codex, а PR-шаг правит файлы — выберите opencode", blocking: true });
      const dirOk = typeof body.directory === "string" && Boolean(body.directory) && (!deps.dirAllowed || deps.dirAllowed(user, body.directory));
      if (typeof body.directory !== "string" || !body.directory)
        problems.push({ field: "directory", message: "Выберите папку проекта", blocking: true });
      else if (deps.dirAllowed && !deps.dirAllowed(user, body.directory))
        problems.push({ field: "directory", message: "Папка недоступна этому пользователю", blocking: true });
      const repoOk = REPO_RE.test(String(body.repo ?? ""));
      if (!repoOk)
        problems.push({ field: "repo", message: "Укажите репозиторий в виде owner/name", blocking: true });
      // BUG-317: сверка git remote origin выбранной папки с репозиторием.
      if (dirOk && repoOk && deps.checkOrigin) {
        const originRes = await deps.checkOrigin(body.directory, body.repo, user);
        if (originRes && !originRes.ok) {
          problems.push({ field: "directory", message: originRes.message || "Папка не совпадает с выбранным репозиторием", blocking: true });
        }
      }
      sendJson(res, 200, { ready: problems.length === 0, problems });
    }),
    // Создание: пайп владельца, версия закреплена или «последняя опубликованная».
    route("POST", base, async ({ req, res, user }) => {
      if (!pipelinesEnabled()) throw fail(503, "Temporal-пайпы не подключены — триггеры недоступны");
      const spec = await readJsonBody(req, 16384);
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw fail(400, "Ожидается JSON-объект");
      validateSpec(spec);
      const pipe = await pipeOf(user, spec.definitionId);
      if (!pipe) throw fail(404, "Пайп не найден");
      // BUG-322: решение владельца Q1-а — фоновый триггер на пайп с Claude только для администратора.
      const pipeUsesClaude = pipe.usesClaude !== undefined
        ? Boolean(pipe.usesClaude)
        : (deps.usesClaude ? Boolean(await deps.usesClaude({ owner: user.id, definitionId: spec.definitionId, version: spec.version ?? null })) : false);
      if (user.role !== "admin" && pipeUsesClaude) {
        throw fail(403, "Claude в фоновых запусках доступен только администратору — выберите opencode");
      }
      // BUG-317: сверка git remote origin папки пайпа с выбранным репозиторием.
      if (pipe.directory && deps.checkOrigin) {
        const originRes = await deps.checkOrigin(pipe.directory, spec.repo, user);
        if (originRes && !originRes.ok) {
          throw fail(422, originRes.message || "Папка пайпа не совпадает с выбранным репозиторием");
        }
      }
      const defaultPerHour = store.setting?.("default_per_hour", DEFAULT_LIMITS.perHour) ?? DEFAULT_LIMITS.perHour;
      const defaultQueue = store.setting?.("default_queue", DEFAULT_LIMITS.queue) ?? DEFAULT_LIMITS.queue;
      // version NULL = всегда последняя опубликованная (design); число — закрепить.
      const created = store.create(user.id, {
        definitionId: spec.definitionId,
        version: spec.version ?? null,
        repo: spec.repo,
        kinds: spec.kinds ?? [],
        filters: spec.filters ?? {},
        delivery: spec.delivery ?? "auto",
        pollSeconds: spec.pollSeconds ?? 120,
        limits: { perHour: spec.limits?.perHour ?? defaultPerHour, queue: spec.limits?.queue ?? defaultQueue },
      });
      log?.(`github: триггер ${created.id} создан (${user.id} → ${created.repo})`);
      sendJson(res, 201, { ...face(created), key: created.key, secret: created.secret, hookUrl: hookUrl(created.key) });
    }),

    route("GET", base, async ({ res, user }) => {
      // Сводка для списка UI (2.2): последнее срабатывание, ошибки, шторм, очередь.
      const summary = store.summaries(user.id);
      sendJson(res, 200, store.list(user.id).map((row) => ({ ...face(row), ...(summary.get(row.id) ?? {}) })));
    }),

    route("GET", new RegExp(`^${base}/([a-f0-9-]{36})$`), async ({ res, user, match }) => {
      const row = own(user, match[1]);
      const storm = store.setting?.(`storm:${row.id}`, null);
      sendJson(res, 200, {
        ...face(row),
        activeCount: activeWorkflows(store, row.id).length,
        queuedCount: store.queuedCount?.(row.id) ?? 0,
        stormAt: Number.isFinite(storm?.at) ? storm.at : null,
      });
    }),

    route("PATCH", new RegExp(`^${base}/([a-f0-9-]{36})$`), async ({ req, res, user, match }) => {
      const body = await readJsonBody(req, 16384);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "Ожидается JSON-объект");
      const row = own(user, match[1]);
      const patch = {};
      for (const k of ["kinds", "filters", "delivery", "pollSeconds", "limits", "enabled"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      validateSpec({
        definitionId: row.definitionId, version: row.version, repo: row.repo,
        kinds: patch.kinds ?? row.kinds, filters: patch.filters ?? row.filters,
        delivery: patch.delivery ?? row.delivery, pollSeconds: patch.pollSeconds ?? row.pollSeconds,
        limits: patch.limits ?? row.limits,
      });
      const updated = store.update(user.id, match[1], patch, body.revision);
      sendJson(res, 200, face(updated));
    }),

    route("DELETE", new RegExp(`^${base}/([a-f0-9-]{36})$`), async ({ req, res, user, match, url }) => {
      let revision = null;
      try {
        const body = await readJsonBody(req, 1024);
        revision = body?.revision;
      } catch { /* тела может не быть */ }
      if (revision == null) revision = Number(url.searchParams.get("revision")) || null;
      const row = own(user, match[1]);
      store.remove(user.id, match[1], revision);
      // BUG-323 п.4: best-effort удаление webhook на стороне GitHub, чтобы не копить осиротевшие хуки.
      let hookDeleted = null;
      if (row.hookId) {
        const token = connectionToken?.(user.id);
        if (token) {
          try {
            await deleteRepoWebhook(token, row.repo, row.hookId, { apiBase });
            hookDeleted = true;
          } catch (e) {
            if (e instanceof GhError && e.kind === "not_found") hookDeleted = true;
            else { hookDeleted = false; errLog?.("github", e); }
          }
        }
      }
      sendJson(res, 200, { ok: true, ...(hookDeleted !== null ? { hookDeleted } : {}) });
    }),

    // BUG-319: очистка очереди триггера при шторме без отмены идущих запусков.
    route("POST", new RegExp(`^${base}/([a-f0-9-]{36})/queue/clear$`), async ({ res, user, match }) => {
      const row = own(user, match[1]);
      const cleared = store.clearQueue(row.id);
      store.record({
        triggerId: row.id, eventKey: null, kind: "queue", repo: row.repo, number: null,
        actor: user.id, decision: "queue_cleared", reason: cleared ? `Очередь очищена (${cleared})` : "Очередь очищена",
        workflowId: null, via: "manual", eventJson: null,
      });
      log?.(`github: очередь триггера ${row.id} очищена (${cleared})`);
      sendJson(res, 200, { ok: true, cleared });
    }),

    // Выключение ≤ 1 с: новые события пишутся «Триггер выключен»; идущие —
    // «пусть доработают» (по умолчанию) или отменяются (кр. 18).
    route("POST", new RegExp(`^${base}/([a-f0-9-]{36})/(enable|disable)$`), async ({ req, res, user, match }) => {
      const enable = match[2] === "enable";
      let body = {};
      try { body = await readJsonBody(req, 2048); } catch { /* пустое тело допустимо */ }
      const row = own(user, match[1]);
      if (!enable) {
        store.update(user.id, match[1], { enabled: false });
        if (body.running === "cancel" && cancelRun) {
          for (const wf of activeWorkflows(store, row.id)) {
            try { await cancelRun(row, wf); } catch (error) { errLog?.("github", error); }
          }
        }
        if (body.running === "cancel") clearActiveAll(store, row.id);
      } else {
        store.update(user.id, match[1], { enabled: true });
      }
      const cur = store.get(user.id, match[1]); sendJson(res, 200, { ...face(cur), activeCount: activeWorkflows(store, cur.id).length });
    }),

    route("GET", new RegExp(`^${base}/([a-f0-9-]{36})/journal$`), async ({ res, user, match, url }) => {
      const filter = url.searchParams.get("filter");
      const cursor = Number(url.searchParams.get("cursor")) || null;
      const rows = store.journal(user.id, match[1], { filter: ["started", "skipped", "errors"].includes(filter) ? filter : null, cursor });
      sendJson(res, 200, rows);
    }),

    // Повтор пропущенного по лимиту/выключению события (кр. 17): автор снова
    // проверяется, ключ запуска детерминирован записью — двойной повтор безопасен.
    route("POST", new RegExp(`^${base}/([a-f0-9-]{36})/journal/(\\d+)/replay$`), async ({ req, res, user, match }) => {
      if (!pipelinesEnabled()) throw fail(503, "Temporal-пайпы не подключены — триггеры недоступны");
      const entry = store.journalEntry(user.id, Number(match[2]));
      if (entry.triggerId !== match[1]) throw fail(404, "Запись журнала не найдена");
      if (!REPLAYABLE.has(entry.decision)) throw fail(422, "Повтор доступен только для пропущенных по лимиту или выключению");
      if (!entry.eventJson) throw fail(422, "У записи нет тела события");
      const row = own(user, match[1]);
      if (store.setting("adminStopped", false) === true) throw fail(409, "Все триггеры остановлены администратором");
      const ev = entry.eventJson;
      const connection = deps.connections?.get?.(user.id) ?? null;
      if (!connection || connection.status !== "ok") throw fail(422, "Нет подключения GitHub");
      const trusted = [connection.login, ...(row.filters?.trustedAuthors ?? [])].filter(Boolean);
      const people = [...new Set([ev.author, ev.actor].filter(Boolean))];
      if (!people.length) throw fail(422, "Автор события не доверен — повтор отклонён");
      for (const person of people) {
        if (trusted.includes(person)) continue;
        if (deps.permissionCheck && await deps.permissionCheck(person, ev.repo, row)) continue;
        throw fail(422, "Автор события не доверен — повтор отклонён");
      }
      const isClaude = deps.usesClaude ? Boolean(await deps.usesClaude(row)) : true;
      if (isClaude) {
        const claudeLimit = store.setting("claude_background_per_day", 10) ?? 10;
        const claudeUsed = await countClaudeUsedToday(store, deps.usesClaude);
        if (claudeUsed >= claudeLimit) throw fail(429, "Лимит Claude в фоне исчерпан на сегодня");
      }
      if (store.subjectOf(row.id, subjectKey(row.id, ev))?.activeWorkflowId) throw fail(409, "Уже идёт запуск по этому предмету");
      const eKey = `${eventKey(row.id, ev)}:replay:${entry.id}`;
      const run = await launch(row, ev, uuidv5(EVENT_NAMESPACE, eKey));
      if (run?.workflowId) store.setActive(row.id, subjectKey(row.id, ev), run.workflowId);
      // Как у обычного запуска: красный CI — строка журнала с «лицом» события (PR, ветка), без текста.
      store.record({ triggerId: row.id, eventKey: null, kind: ev.kind, repo: ev.repo, number: ev.number ?? null, actor: ev.actor, decision: "started", reason: "Повтор по событию", workflowId: run?.workflowId ?? null, via: "replay",
        eventJson: ev.kind === "ci_failed" ? JSON.stringify(ciFace(ev)) : null });
      sendJson(res, 200, { ok: true, workflowId: run?.workflowId ?? null });
    }),

    // Создание webhook на GitHub (1.6). Ключ из ответа при создании (хранится
    // только хэшем) пользователь передаёт здесь — по нему собирается URL.
    // Право Webhooks: write проверяется пробным GET; ping шлётся GitHub-ом сразу.
    route("POST", new RegExp(`^${base}/([a-f0-9-]{36})/webhook$`), async ({ req, res, user, match }) => {
      const row = own(user, match[1]); // чужой — 404, не раскрываем существование
      const body = await readJsonBody(req, 4096);
      if (!store.verifyKey(user.id, match[1], body?.key)) throw fail(422, "Ключ webhook неверен — он показывается один раз при создании триггера");
      const token = connectionToken?.(user.id);
      if (!token) throw fail(422, "Нет подключения GitHub — подключите токен в Настройки → GitHub");
      const url = hookUrl(body.key);
      if (!url) throw fail(422, "TELEHARNESS_PUBLIC_URL не задан — портал недоступен снаружи, webhook не создать");
      if (!(await canManageHooks(token, row.repo, { apiBase }))) throw fail(403, "Токену нужны права на управление webhook репозитория (Webhooks: write)");
      const hook = await createRepoWebhook(token, row.repo, { url, secret: store.secretFor(row), events: githubEvents(row.kinds) }, { apiBase });
      store.setHookId(user.id, row.id, hook.id);
      let pinged = true;
      try { await pingRepoWebhook(token, row.repo, hook.id, { apiBase }); } catch { pinged = false; }
      log?.(`github: webhook ${hook.id} создан для ${row.repo} (триггер ${row.id}, ping ${pinged ? "принят" : "не подтверждён"})`);
      sendJson(res, 200, { ...face(store.get(user.id, row.id)), hookId: hook.id, pinged, hookUrl: url });
    }),

    // Проверка webhook (design §routes): активен ли; исчез → сброс hook_id.
    route("POST", new RegExp(`^${base}/([a-f0-9-]{36})/webhook/recheck$`), async ({ res, user, match }) => {
      const row = own(user, match[1]);
      if (!row.hookId) throw fail(422, "Webhook не создан");
      const token = connectionToken?.(user.id);
      if (!token) throw fail(422, "Нет подключения GitHub");
      try {
        const hook = await getRepoWebhook(token, row.repo, row.hookId, { apiBase });
        sendJson(res, 200, { ...face(store.get(user.id, row.id)), active: !!hook?.active, url: hook?.config?.url ?? null });
      } catch (e) {
        if (e instanceof GhError && e.kind === "not_found") {
          store.setHookId(user.id, row.id, null);
          sendJson(res, 200, { ...face(store.get(user.id, row.id)), active: false, note: "Webhook удалён на стороне GitHub — создайте заново" });
          return;
        }
        throw e;
      }
    }),

    // Удаление webhook: 404 от GitHub не ошибка — хука уже нет.
    route("DELETE", new RegExp(`^${base}/([a-f0-9-]{36})/webhook$`), async ({ res, user, match }) => {
      const row = own(user, match[1]);
      if (!row.hookId) throw fail(422, "Webhook не создан");
      const token = connectionToken?.(user.id);
      if (token) {
        try { await deleteRepoWebhook(token, row.repo, row.hookId, { apiBase }); }
        catch (e) { if (!(e instanceof GhError && e.kind === "not_found")) throw e; }
      }
      store.setHookId(user.id, row.id, null);
      sendJson(res, 200, face(store.get(user.id, row.id)));
    }),

    // Ротация секрета webhook: старые доставки перестают приниматься сразу;
    // если хук создан на GitHub — секрет там обновляем тем же вызовом.
    route("POST", new RegExp(`^${base}/([a-f0-9-]{36})/webhook/rotate$`), async ({ res, user, match }) => {
      const { row, secret } = store.rotateSecret(user.id, match[1]);
      const token = connectionToken?.(user.id);
      let githubUpdated = null;
      if (row.hookId && token) {
        try { await updateRepoWebhookSecret(token, row.repo, row.hookId, secret, { apiBase }); githubUpdated = true; }
        catch (e) { githubUpdated = false; errLog?.("github", e); }
      }
      sendJson(res, 200, { ...face(store.get(user.id, match[1])), secret, githubUpdated, note: "Секрет заменён" + (githubUpdated === false ? " локально — обновите его в настройках webhook GitHub" : "") });
    }),
    // FEAT-20.3 (2.6, D-6, кр. 20; BUG-319): общий выключатель, лимиты и подключения пользователей без токенов.
    route("GET", "/teleharness/api/admin/background", async ({ res }) => {
      sendJson(res, 200, await adminBackgroundFace(store, deps.connections, deps.usesClaude));
    }, "admin"),

    route("PUT", "/teleharness/api/admin/background", async ({ req, res, user }) => {
      const body = await readJsonBody(req, 4096);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "Ожидается JSON-объект");
      if (body.adminStopped !== undefined) {
        if (typeof body.adminStopped !== "boolean") throw fail(422, "adminStopped должен быть логическим значением");
        store.setSetting("adminStopped", body.adminStopped);
        log?.(`github: admin ${user.id} ${body.adminStopped ? "остановил все триггеры" : "возобновил триггеры"}`);
      }
      if (body.claudePerDay !== undefined) {
        if (!Number.isInteger(body.claudePerDay) || body.claudePerDay < 0 || body.claudePerDay > 500) {
          throw fail(422, "Суточный лимит Claude — целое число от 0 до 500");
        }
        store.setSetting("claude_background_per_day", body.claudePerDay);
        log?.(`github: admin ${user.id} задал суточный лимит Claude в фоне = ${body.claudePerDay}`);
      }
      if (body.userPerDay !== undefined) {
        if (!Number.isInteger(body.userPerDay) || body.userPerDay < 1 || body.userPerDay > 500) {
          throw fail(422, "Лимит запусков пользователя в сутки — целое число от 1 до 500");
        }
        store.setSetting("default_user_per_day", body.userPerDay);
        log?.(`github: admin ${user.id} задал суточный лимит пользователя = ${body.userPerDay}`);
      }
      if (body.defaultPerHour !== undefined) {
        if (!Number.isInteger(body.defaultPerHour) || body.defaultPerHour < 1 || body.defaultPerHour > 60) {
          throw fail(422, "Дефолтный лимит запусков в час — целое число от 1 до 60");
        }
        store.setSetting("default_per_hour", body.defaultPerHour);
        log?.(`github: admin ${user.id} задал дефолтный лимит в час = ${body.defaultPerHour}`);
      }
      if (body.defaultQueue !== undefined) {
        if (!Number.isInteger(body.defaultQueue) || body.defaultQueue < 1 || body.defaultQueue > 100) {
          throw fail(422, "Дефолтная длина очереди — целое число от 1 до 100");
        }
        store.setSetting("default_queue", body.defaultQueue);
        log?.(`github: admin ${user.id} задал дефолтную очередь = ${body.defaultQueue}`);
      }
      sendJson(res, 200, await adminBackgroundFace(store, deps.connections, deps.usesClaude));
    }, "admin"),
  ];
}

function activeWorkflows(store, triggerId) {
  const out = [];
  for (const s of store.listWithSubjects?.(triggerId) ?? []) if (s.activeWorkflowId) out.push(s.activeWorkflowId);
  return out;
}
function clearActiveAll(store, triggerId) {
  for (const s of store.listWithSubjects?.(triggerId) ?? []) if (s.activeWorkflowId) store.clearActive(triggerId, s.subjectKey);
}

async function adminBackgroundFace(store, connections, usesClaude = null) {
  const adminStopped = store.setting("adminStopped", false) === true;
  const claudePerDay = store.setting("claude_background_per_day", 10) ?? 10;
  const userPerDay = store.setting("default_user_per_day", DEFAULT_LIMITS.userPerDay) ?? DEFAULT_LIMITS.userPerDay;
  const defaultPerHour = store.setting("default_per_hour", DEFAULT_LIMITS.perHour) ?? DEFAULT_LIMITS.perHour;
  const defaultQueue = store.setting("default_queue", DEFAULT_LIMITS.queue) ?? DEFAULT_LIMITS.queue;
  const claudeUsedToday = await countClaudeUsedToday(store, usesClaude);
  const all = store.listAll?.() ?? [];
  const activeRuns = (store.activeSubjects?.() ?? []).filter((s) => s.activeWorkflowId).length;
  const conns = (connections?.list?.() ?? []).map((c) => ({
    owner: c.owner,
    login: c.login,
    tokenLast4: c.tokenLast4,
    status: c.status,
    expiresAt: c.expiresAt ?? null,
    checkedAt: c.checkedAt ?? null,
  }));
  return {
    adminStopped,
    claudePerDay,
    claudeUsedToday,
    claudeLeftToday: Math.max(0, claudePerDay - claudeUsedToday),
    userPerDay,
    defaultPerHour,
    defaultQueue,
    triggersTotal: all.length,
    triggersEnabled: all.filter((r) => r.enabled).length,
    activeRuns,
    connections: conns,
  };
}
