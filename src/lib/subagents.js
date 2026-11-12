// FEAT-01.77: единая модель «запуск агента» (design §2 subagents-in-chat).
// Чистый модуль: без сети и сторов — всё нужное приходит в ctx:
//   ctx = { childFeed(childId) → messages[] | null, busy(sessionId) → boolean,
//           tokensOf(sessionId) → number | null, now() → ms,
//           engine: "opencode" | "claude" }
// opencode: состояние по части инструмента, ленте дочерней сессии и занятости;
// Claude: всё в part.state.metadata.zaiRun (наполняет сервер, design §4).
import { isAgentTool } from "./normalize.js";
import { t } from "./i18n.js";

const OBJ_MAX = 60; // объект шага — одна короткая строка с многоточием
const OUTPUT_MAX = 2000; // итоговый текст агента (design §2)

const firstStr = (...vals) => vals.find((v) => typeof v === "string" && v.trim()) ?? "";
const short = (s) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > OBJ_MAX ? `${one.slice(0, OBJ_MAX - 1)}…` : one;
};
const inputOf = (part) => part?.state?.input ?? {};
const metaOf = (part) => (part?.state?.metadata && typeof part.state.metadata === "object" ? part.state.metadata : {});

// id дочерней сессии: opencode 2.x metadata.sessionID, 1.x metadata.sessionId
export function childIdOf(part) {
  const m = metaOf(part);
  return m.sessionID ?? m.sessionId ?? null;
}

// TASK-01.79: задача без служебных заглушек — «Задача агенту», «task» и
// подобные title части вместо задачи не показываются; база — input.description
const SERVICE_TITLES = new Set(["задача агенту", "task", "agent", "subagent"]);
export function taskDescription(part) {
  const desc = firstStr(inputOf(part).description);
  const title = String(part?.state?.title ?? "").trim();
  return SERVICE_TITLES.has(title.toLowerCase()) ? desc : firstStr(title, desc);
}

// Причина одной строкой (state.error, zaiRun.error, info.error — формы разные)
function errLine(e) {
  if (!e) return null;
  if (typeof e === "string") return short(e) || null;
  const one = firstStr(e?.data?.message, e?.message, e?.title, e?.text, e?.type, e?.name);
  return one ? short(one) : null;
}

// FEAT-01.77: у пути важен хвост — в одну строку с многоточием имя файла иначе не видно
export function pathTail(p) {
  const str = String(p);
  const sep = str.includes("\\") ? "\\" : "/";
  const parts = str.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return str;
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

const lastSegment = (p) => {
  const parts = String(p ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(p ?? "");
};

function stepObject(tool, input) {
  const i = input ?? {};
  const file = firstStr(i.filePath, i.file_path, i.path);
  if (file) return pathTail(file);
  return short(firstStr(i.pattern, i.command, i.url, i.query, i.agent, i.subagent_type, i.description));
}

// TASK-01.79 (BUG-227): объект-путь у шага Claude — хвост, чтобы имя файла было видно
const looksLikePath = (o) => /[\\/]/.test(o) && !/\s/.test(o);
const claudeObject = (o) => (looksLikePath(o) ? pathTail(o) : o);

// TASK-01.79: note шага — короткий итог из метаданных инструмента дочерней
// ленты: у списка файлов и поиска число из metadata.count/matches
const LIST_TOOLS = new Set(["glob", "list", "ls"]);
const SEARCH_TOOLS = new Set(["grep"]);
function stepNote(tool, state) {
  const m = state?.metadata;
  const n = Number(m && typeof m === "object" ? m.count ?? m.matches : NaN);
  if (!Number.isFinite(n) || n < 0) return null;
  const key = String(tool ?? "").toLowerCase();
  if (LIST_TOOLS.has(key)) return t("agent.note.files", { count: n });
  if (SEARCH_TOOLS.has(key)) return t("agent.note.matches", { count: n });
  return null;
}

// TASK-01.81: инструмент read, которому дали папку: движок отвечает листингом
// (<type>directory</type> + <entries>) либо метаданными type:"directory".
// → { note } (число записей, если его видно) или null.
function dirRead(part) {
  if (String(part?.tool ?? "").toLowerCase() !== "read") return null;
  const st = part?.state ?? {};
  const meta = st.metadata && typeof st.metadata === "object" ? st.metadata : {};
  const out = typeof st.output === "string" ? st.output : "";
  // opencode 2.2.6 вживую (стенд 2026-11-11): «Read directory <путь>, entries 1-2\na.txt\nb.txt»
  const v2 = /^Read directory .*?, entries (\d+)-(\d+)/.exec(out.slice(0, 600));
  const isDir = Boolean(v2) || meta.type === "directory" || meta.isDirectory === true || Array.isArray(meta.entries) || /<type>\s*directory\s*<\/type>/i.test(out.slice(0, 600));
  if (!isDir) return null;
  let n = Array.isArray(meta.entries) ? meta.entries.length : Number(meta.count);
  // число записей по строкам вывода; у обрезанного листинга точного числа нет — итог не показываем
  if (!Number.isFinite(n) && v2) n = meta.truncated === true ? NaN : out.split("\n").slice(1).filter((l) => l.trim()).length;
  if (!Number.isFinite(n) && !v2) {
    const m = out.match(/<entries>\s*([\s\S]*?)\s*<\/entries>/i);
    n = m ? m[1].split("\n").filter((l) => l.trim()).length : NaN;
  }
  return { note: Number.isFinite(n) && n >= 0 ? t("agent.note.files", { count: n }) : null };
}

const stepStatusOf = (part) => (part?.state?.status === "completed" ? "done" : part?.state?.status === "error" ? "error" : "running");

const lastAssistant = (feed) => {
  const list = Array.isArray(feed) ? feed : [];
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.info?.role === "assistant") return list[i];
  return null;
};

// Чем кончился ход дочерней сессии: "done" (есть текст ответа), "stopped"
// (прерван), "error", либо null — ответа ещё нет. Опирается только на ленту.
function feedOutcome(feed) {
  const last = lastAssistant(feed);
  if (!last) return null;
  const err = last.info?.error;
  if (err) return err?.name === "MessageAbortedError" || last.info?.zai?.interrupted ? "stopped" : "error";
  if (last.info?.zai?.interrupted) return "stopped";
  const hasText = (last.parts ?? []).some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim());
  return hasText ? "done" : null;
}

// Шаги opencode-запуска из ленты дочерней сессии: инструмент → шаг (вызов
// subagent внутри дочерней → kind:"agent"); итоговый текст ленты — output.
function feedSteps(feed) {
  const steps = [];
  let output = null;
  const list = Array.isArray(feed) ? feed : [];
  for (const m of list) {
    if (m?.info?.role !== "assistant") continue;
    for (const p of m?.parts ?? []) {
      if (p?.type !== "tool") continue;
      const agent = isAgentTool(p);
      // TASK-01.81 (кадр 2): read по папке — это «Список файлов», а не «Прочитал»
      const dir = !agent && dirRead(p);
      steps.push({
        id: p.callID ?? p.id,
        kind: agent ? "agent" : "tool",
        tool: dir ? "list" : (p.tool ?? ""),
        // у папки — только её имя: рядом должен поместиться итог «· N файлов»
        object: dir ? lastSegment(firstStr(p.state?.input?.filePath, p.state?.input?.file_path, p.state?.input?.path)) : stepObject(p.tool, p.state?.input),
        status: stepStatusOf(p),
        note: dir ? dir.note : stepNote(p.tool, p.state),
      });
    }
    for (const p of m?.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) output = p.text.slice(0, OUTPUT_MAX);
    }
  }
  return { steps, output };
}

// Состояние opencode-запуска (design §2): ошибка части → лента/занятость.
// Фоновая часть навсегда carries metadata.status:"running" (design §1) —
// готовым без завершённого ответа ленты её не считаем.
function ocState(part, childId, ctx, feed) {
  if (part?.state?.status === "error") {
    // «Стоп» хода: движок завершает вызов ошибкой «Subagent cancelled…» — это остановка, не сбой
    const e = part.state.error;
    const text = typeof e === "string" ? e : `${e?.name ?? ""} ${e?.message ?? ""} ${e?.data?.message ?? ""}`;
    return /cancel|abort|interrupt/i.test(text) ? "stopped" : "error";
  }
  // без дочерней сессии (запуск, невидимый движку) судить можно только по самой части:
  // завершённая часть — «готов», иначе карточка висела бы «работает» вечно
  if (!childId) return part?.state?.status === "pending" ? "queued" : part?.state?.status === "completed" ? "done" : "running";
  if (ctx.busy?.(childId)) return "running";
  const outcome = feedOutcome(feed);
  if (outcome) return outcome; // stopped | error | done
  if (part?.state?.status !== "completed") return "running";
  if (metaOf(part).status === "running") return "running";
  return "done";
}

function assemble(part, ctx, id, patch = {}) {
  const run = {
    id,
    agent: null,
    description: "",
    background: false,
    state: "queued",
    startedAt: null,
    endedAt: null,
    childId: null,
    steps: [],
    now: null,
    output: null,
    error: null,
    tokens: null,
    depth: 0,
    ...patch,
  };
  run.now = nowLine(run);
  return run;
}

function ocRun(part, ctx, id) {
  const input = inputOf(part);
  const meta = metaOf(part);
  const childId = childIdOf(part) ?? null;
  const feed = childId && typeof ctx.childFeed === "function" ? ctx.childFeed(childId) : null;
  const state = ocState(part, childId, ctx, feed);
  const { steps, output } = feedSteps(feed);
  let error = null;
  if (state === "error") {
    const fe = lastAssistant(feed)?.info?.error;
    error = errLine(part?.state?.error) ?? errLine(fe) ?? t("agent.badge.error");
  }
  const tokens = typeof ctx.tokensOf === "function" ? ctx.tokensOf(childId) : null;
  const terminal = state === "done" || state === "error" || state === "stopped";
  const background = input.background === true || input.run_in_background === true;
  // Конец работы: у фонового запуска часть инструмента завершается сразу при запуске
  // (design §1) — её time.completed это «запущен», а не «закончил». Берём время последнего
  // ответа дочерней сессии; время части годится только для обычного (блокирующего) запуска.
  let feedEnd = lastAssistant(feed)?.info?.time?.completed;
  if (typeof feedEnd !== "number") {
    // живая лента 2.x не несёт времени завершения ответа — берём время последней части агента
    let last = 0;
    for (const m of Array.isArray(feed) ? feed : []) for (const p of m?.parts ?? []) last = Math.max(last, Number(p?.time?.completed) || 0, Number(p?.time?.ran) || 0, Number(p?.time?.created) || 0);
    if (last > 0) feedEnd = last;
  }
  // лента не загружена (завершённый запуск после перезагрузки): последняя активность дочерней сессии
  if (typeof feedEnd !== "number" && childId && typeof ctx.updatedOf === "function") { const u = ctx.updatedOf(childId); if (typeof u === "number") feedEnd = u; }
  // формат 1.x несёт время в state.time.{start,end}
  const partEnd = typeof part?.time?.completed === "number" ? part.time.completed : Number(part?.state?.time?.end) > 0 ? Number(part.state.time.end) : undefined;
  // обычный запуск: часть инструмента завершается вместе с агентом — её время точнее всего
  const endedAt = !terminal ? null : !background && typeof partEnd === "number" ? partEnd : typeof feedEnd === "number" ? feedEnd : null;
  return assemble(part, ctx, id, {
    agent: firstStr(meta.agent, input.agent, input.subagent_type) || null,
    description: taskDescription(part),
    background,
    state,
    startedAt: typeof part?.time?.created === "number" ? part.time.created : Number(part?.state?.time?.start) > 0 ? Number(part.state.time.start) : null,
    endedAt,
    childId,
    steps,
    output,
    error,
    tokens: typeof tokens === "number" ? tokens : null,
  });
}

// Claude (design §2/§4): всё в самой части — zaiRun. Запуск всегда асинхронный.
function claudeRun(part, ctx, id) {
  const input = inputOf(part);
  const meta = metaOf(part);
  const z = meta.zaiRun && typeof meta.zaiRun === "object" ? meta.zaiRun : null;
  const st = part?.state?.status;
  // BUG-229: без статуса задачи запуск считается работающим только в живом
  // хвосте хода (запуск принят, task_started ещё не доехал). В завершённом
  // ходе уведомление не придёт никогда (история до FEAT-01.77, потерянный
  // процесс CLI): есть результат части — «готов», вызов без результата —
  // «остановлен».
  const live = typeof ctx.liveMessage === "function" && ctx.liveMessage(part?.messageID) === true;
  let state;
  if (z?.status === "running") state = "running";
  else if (z?.status === "completed") state = "done";
  else if (z?.status === "failed") state = "error";
  else if (z?.status === "stopped") state = "stopped";
  else if (st === "pending") state = live ? "queued" : "stopped";
  else if (st === "error") state = "error";
  else state = live ? "running" : "done";
  const steps = (Array.isArray(z?.steps) ? z.steps : []).map((s, i) => ({
    id: s?.id ?? `s${i}`,
    kind: s?.kind === "agent" || s?.kind === "text" || s?.kind === "reasoning" ? s.kind : "tool",
    tool: typeof s?.tool === "string" ? s.tool : "",
    // TASK-01.79 (BUG-227): объект-путь — хвост, имя файла видно в одну строку
    object: typeof s?.object === "string" ? claudeObject(s.object) : "",
    status: s?.status === "done" ? "done" : s?.status === "error" ? "error" : "running",
  }));
  const terminal = state === "done" || state === "error" || state === "stopped";
  return assemble(part, ctx, id, {
    agent: firstStr(meta.agent, input.agent, input.subagent_type) || null,
    description: taskDescription(part),
    // TASK-01.81: CLI исполняет Agent асинхронно всегда — пилюля «фоном» только у явного фонового запуска
    background: input.run_in_background === true || input.background === true,
    tokens: Number(z?.tokens) > 0 ? Number(z.tokens) : null,
    state,
    startedAt: typeof z?.startedAt === "number" ? z.startedAt : typeof part?.time?.created === "number" ? part.time.created : Number(part?.state?.time?.start) > 0 ? Number(part.state.time.start) : null,
    endedAt: terminal
      ? typeof z?.endedAt === "number"
        ? z.endedAt
        : typeof part?.time?.completed === "number"
          ? part.time.completed
          : Number(part?.state?.time?.end) > 0
            ? Number(part.state.time.end)
            : null
      : null,
    steps,
    output: typeof z?.output === "string" && z.output ? z.output.slice(0, OUTPUT_MAX) : null,
    error: state === "error" ? errLine(z?.error) ?? errLine(part?.state?.error) ?? t("agent.badge.error") : null,
  });
}

// Запуск агента из части инструмента (design §2). Не агент-часть → null.
export function agentRun(part, ctx = {}) {
  if (!isAgentTool(part)) return null;
  const id = part?.callID ?? part?.id ?? null;
  return ctx.engine === "claude" ? claudeRun(part, ctx, id) : ocRun(part, ctx, id);
}

// Все запуски ленты в порядке появления; запуски дочерних лент идут сразу
// после родителя с depth+1 (циклы и глубина > 5 не разворачиваются).
export function runsOfMessages(messages, ctx, { depth = 0, seen = new Set() } = {}) {
  const out = [];
  for (const m of messages ?? []) {
    for (const part of m?.parts ?? []) {
      if (!isAgentTool(part)) continue;
      const run = agentRun(part, ctx);
      if (!run) continue;
      run.depth = depth;
      out.push(run);
      const cid = run.childId;
      if (!cid || depth >= 5 || seen.has(cid)) continue;
      seen.add(cid);
      const feed = typeof ctx.childFeed === "function" ? ctx.childFeed(cid) : null;
      if (Array.isArray(feed) && feed.length > 0) out.push(...runsOfMessages(feed, ctx, { depth: depth + 1, seen }));
    }
  }
  return out;
}

// Сводка по брифу: «Агенты: 2 работают · 1 в очереди» / «2 готовы · 1 с ошибкой»
export function summarize(runs) {
  const c = { running: 0, queued: 0, done: 0, error: 0, stopped: 0 };
  for (const r of runs ?? []) if (r?.state && r.state in c) c[r.state] += 1;
  const total = (runs ?? []).length;
  const parts = [];
  if (c.running) parts.push(t("agent.sum.running", { count: c.running }));
  if (c.queued) parts.push(t("agent.sum.queued", { count: c.queued }));
  if (c.done) parts.push(t("agent.sum.done", { count: c.done }));
  if (c.error) parts.push(t("agent.sum.error", { count: c.error }));
  if (c.stopped) parts.push(t("agent.sum.stopped", { count: c.stopped }));
  return { ...c, total, text: parts.length > 0 ? t("agent.sum.text", { list: parts.join(" · ") }) : "" };
}

// Запуски в работе: running и queued
export function activeRuns(runs) {
  return (runs ?? []).filter((r) => r?.state === "running" || r?.state === "queued");
}

// Глаголы строки «сейчас» — таблица брифа (BRIEF-14, TASK-01.79).
// Значения — ключи словаря (язык переключается на лету): «Читает», «Смотрит файлы»…
const VERBS_NOW = {
  read: "agent.now.read",
  glob: "agent.now.files",
  grep: "agent.now.search",
  list: "agent.now.files",
  ls: "agent.now.files",
  websearch: "agent.now.web",
  webfetch: "agent.now.web",
  bash: "agent.now.command",
  shell: "agent.now.command",
  edit: "agent.now.edit",
  write: "agent.now.write",
  reasoning: "agent.now.thinking",
  text: "agent.now.text",
};
// «Прочитал», «Список файлов», «Поиск»…
const VERBS_DONE = {
  read: "agent.did.read",
  glob: "agent.did.files",
  grep: "agent.did.search",
  list: "agent.did.files",
  ls: "agent.did.files",
  bash: "agent.did.command",
  shell: "agent.did.command",
  edit: "agent.did.edit",
  write: "agent.did.write",
  websearch: "agent.did.web",
  webfetch: "agent.did.web",
};

export function stepLabel(step) {
  const key = String(step?.tool ?? step?.kind ?? "").toLowerCase();
  const object = typeof step?.object === "string" ? step.object : "";
  if (step?.kind === "agent" || key === "agent" || key === "subagent" || key === "task") return { verb: t("agent.did.agent"), object };
  const done = step?.status === "done";
  const verbKey = (done ? VERBS_DONE[key] : null) ?? VERBS_NOW[key];
  const verb = verbKey ? t(verbKey) : String(step?.tool ?? step?.kind ?? "");
  return { verb, object };
}

// Строка «сейчас»: последний незавершённый шаг; шагов нет и агент работает — «Думает»
export function nowLine(run) {
  if (run?.state !== "running") return null;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i]?.status === "running") return stepLabel(steps[i]);
  return { verb: t("agent.now.thinking"), object: "" };
}

// TASK-01.79 (кадр 3): подряд завершённые шаги одного инструмента — группа
// { id, kind, tool, status, objects, count, note }; работающий шаг и шаг
// с ошибкой всегда отдельной строкой. В группе с несколькими шагами объекты —
// только имена файлов (компактность), полный хвост остаётся у одиночной строки.
const fileName = (o) => {
  const str = String(o ?? "");
  const parts = str.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : str;
};

export function groupSteps(steps) {
  const out = [];
  for (const s of steps ?? []) {
    const prev = out[out.length - 1];
    const object = typeof s?.object === "string" ? s.object : "";
    if (s?.status === "done" && prev && Array.isArray(prev.objects) && prev.status === "done" && prev.kind === s?.kind && prev.tool === s?.tool) {
      prev.objects.push(object);
      prev.count += 1;
      prev.note = prev.note ?? s?.note ?? null;
      continue;
    }
    if (s?.status === "done") {
      out.push({ id: s?.id ?? null, kind: s?.kind ?? "tool", tool: s?.tool ?? "", status: "done", objects: [object], count: 1, note: s?.note ?? null });
      continue;
    }
    out.push(s);
  }
  for (const g of out) if (Array.isArray(g.objects) && g.count > 1) g.objects = g.objects.map(fileName);
  return out;
}

// TASK-01.79 (BUG-227): ответ агента без служебных обёрток. Есть
// <answer>…</answer> — берётся его содержимое; иначе со строк срезаются
// одиночные теги-обёртки (<results>, </files> и подобные), содержимое
// и markdown остаются. Ведущие/замыкающие пустые строки срезаются.
const WRAP_LINE = /^[ \t]*<\/?[A-Za-z][\w.-]*>[ \t]*$/;
export function cleanAgentOutput(text) {
  const str = String(text ?? "");
  const m = str.match(/<answer>([\s\S]*?)<\/answer>/);
  const body = (m ? m[1] : str).split("\n").filter((line) => !WRAP_LINE.test(line)).join("\n");
  return body.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

// TASK-01.81 (кадры 4, 5): полоса фоновых агентов над полем ввода — когда основной
// ход не идёт, диалога нет и детализация ВКЛЮЧЕНА. При выключенной детализации работу
// агентов показывает индикатор «Работают агенты» (кадр 4) — полоса его не дублирует.
export function showBgBar({ mainBusy = false, dialogOpen = false, detailOn = true, activeCount = 0 } = {}) {
  return !mainBusy && !dialogOpen && detailOn && activeCount > 0;
}

// TASK-01.81 (кадр 3): живая лента ребёнка не несёт расхода токенов — он есть в
// сохранённой истории. Завершённому запуску без токенов ленту стоит перечитать.
export function needsTokenRefresh(run) {
  return Boolean(run?.childId) && run?.state === "done" && !(Number(run?.tokens) > 0);
}

// «0:42» · «1:08» · «1:02:03»
export function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// Подпись прелоадера (бриф): «explorer, librarian · 1 из 3 готов · 1:12»;
// имён больше двух — «explorer, librarian и ещё 2»; без активных — "".
export function preloaderCaption(runs, now = Date.now()) {
  const act = activeRuns(runs);
  if (act.length === 0) return "";
  // одинаковые имена не повторяются: «explorer ×2», а не «explorer, explorer»
  const counts = new Map();
  for (const r of act) { const n = r.agent || t("agent.fallbackName"); counts.set(n, (counts.get(n) ?? 0) + 1); }
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  let label = names.slice(0, 2).join(", ");
  if (names.length > 2) label = t("agent.pre.andMore", { names: label, n: names.length - 2 });
  const segs = [label];
  const s = summarize(runs);
  if (s.total > 1) segs.push(t("agent.pre.doneOf", { count: s.done, total: s.total }));
  const starts = act.map((r) => r.startedAt).filter((at) => typeof at === "number");
  if (starts.length > 0 && typeof now === "number") segs.push(fmtDuration(Math.max(0, now - Math.min(...starts))));
  return segs.join(" · ");
}
