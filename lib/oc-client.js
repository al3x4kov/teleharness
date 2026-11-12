// FEAT-16.3, шаг 1: единый адаптер доступа к opencode — lib/oc-client.js.
// Один интерфейс «язык 1.x» для маршрутов портала, два транспорта: v1
// (существующие вызовы opencode 1.19.5, тонкая обёртка БЕЗ изменения формы)
// и v2 (opencode 2.2.6: конверт {location, data}, location[directory]
// deepObject, Basic-авторизация, {_tag}-ошибки, 204-мутации — api-map §0).
// Выбор — createOcClient({ api: "v1"|"v2", base, password?, fetchImpl? });
// в server.js/hub подключается задачей 3.2+ (по design.md §1).
//
// Пароль живёт ТОЛЬКО в заголовке Authorization — он не попадает в сообщения
// ошибок, тела и логи (тест: tests/oc-client.test.js).
//
// Шаг 2 (FEAT-16.3, tasks 2.3–2.5): таймауты {timeoutMs, signal} с таблицей
// DEFAULT_TIMEOUTS (длинные prompt/revert/история обрывать нельзя — CC-28,
// BUG-183; MCP-инициализация ≥120 с; SSE — без таймаута), SSE-переписыватель
// events() (v2 → язык 1.x, gap zai.resync при реконнекте — hub.js RESYNC),
// конвертер истории listMessages (плоские сообщения v2 → {info, parts} +
// пагинация по правилам paginateMessages) и вопросы↔формы v2 (Э5).
// Слэш-команды (BUG-188, №27): listCommands/runCommand у обоих транспортов
// (v2 — api-map «Команды», живьём :4100); тело 1.x {command, arguments}
// адаптер переводит в v2 {name, text}.
// Осталось из заявленного: привязка model/agent в prompt (POST /model, /agent
// и per-session очередь — tasks 3.5) и system (metadata.system + плагин-мост — 4.4).
// Zero runtime dependencies — node stdlib, стиль lib/instance-health.js.
// Run: node --test tests/oc-client.test.js
import { pathToFileURL } from "node:url";

// Единая ошибка адаптера: и 4xx/5xx, и сеть, и неверное использование.
// status 0 = сеть не ответила; body — разобранный JSON (v2: {_tag, message}) или текст;
// code — причина транспортного сбоя: "timeout" | "aborted" | "network".
export class OcError extends Error {
  constructor(message, { status = 0, body = null, cause = null, code = null } = {}) {
    super(message);
    this.name = "OcError";
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
    if (code) this.code = code;
  }
}

// Таймауты методов (мс). Длинные обрывать нельзя: prompt/реверты/история —
// «пусть висит, чем оборвём полуход» (CC-28) и MCP-инициализация до 2 мин
// (BUG-183); SSE живёт на signal/close(). Короткие — быстрые опросы и
// диалоги, чтобы очередь портала не копилась на мёртвом upstream.
export const DEFAULT_TIMEOUTS = {
  prompt: 600_000, revert: 600_000, unrevert: 600_000, listMessages: 600_000,
  // Ход слэш-команды — полный ход агента: v1 держит запрос весь ход (BUG-183),
  // v2 отвечает сразу и execution идёт в фоне; 600 с — backstop на оба режима.
  runCommand: 600_000,
  mcpStatus: 120_000, warmup: 120_000,
  events: 0, // SSE: без таймаута — управляется signal/close()
  busyMap: 15_000,   listPermissions: 15_000, listQuestions: 15_000,
  replyPermission: 15_000, replyQuestion: 15_000, rejectQuestion: 15_000,
  pluginList: 10_000,
  disposeInstance: 30_000, healthInfo: 10_000,
  listSessions: 30_000, createSession: 30_000, getSession: 30_000, patchSession: 30_000,
  deleteSession: 30_000, abort: 30_000, sessionDiff: 30_000,
  listAgents: 30_000, listProviders: 30_000, configGet: 30_000, listProjects: 30_000,
  listCommands: 15_000, setSessionModel: 30_000, setSessionAgent: 30_000,
};

  const notImplemented = (what, where) =>
  new OcError(`${what}: not implemented in step 1 (FEAT-16.3, ${where})`, { status: 0, body: { _tag: "NotImplemented" } });

const v2Only = (name) =>
  new OcError(`${name}: v2-only (на v1 привязка модели едет в теле хода)`, { status: 0, body: { _tag: "V2Only" } });

const enc = encodeURIComponent;

// v2 Session.Info → язык 1.x: location.directory → directory; модель в форме
// портала {providerID, id} (+ variant — «в модель портала», design №1.3).
const toPortalSession = (s) => {
  if (!s || typeof s !== "object") return s;
  const { location, model, ...rest } = s;
  const m = model && typeof model === "object"
    ? { providerID: model.providerID, id: model.id ?? model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
    : model;
  return { ...rest, ...(m ? { model: m } : {}), ...(location ? { directory: location.directory ?? null } : {}) };
};

// Плоское сообщение v2 → запись 1.x {info, parts} (api-map §4). Неизвестные
// типы (idle, *-switched, compaction, …) → null: в 1.x это были события хода,
// а не записи истории, и рендер портала их не знает.
const obj = (v) => v && typeof v === "object";
//
// Поля info, которые читают потребители (воркер v2fix1, 2026-11-08):
//   finish  — пробы песочницы/jail (условие завершения хода, «не tool-calls»);
//   tokens  — фронт (buildTurns: input/output/reasoning/total);
//   cost/rawFinish/mode — лицо 1.x (фикстуры 1.x их несут); rawFinish/cost
//   сервером не читаются, но едут насквозь как у 1.x.
// Токены: у v2 нет total — синтезируем как в 1.x (input+output+reasoning+cache).
const toPortalTokens = (t) => {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cache = obj(t.cache) ? t.cache : {};
  const total = typeof t.total === "number" ? t.total : num(t.input) + num(t.output) + num(t.reasoning) + num(cache.read) + num(cache.write);
  return { ...t, total };
};

// Часть v2 → лицо 1.x. Tool-часть (Э4): v2 даёт {id, name, state:{content:[]}},
// портал (policy.redactPart, server.js turnToolFiles) и пробы ждут 1.x —
// {callID, tool, state.output строкой}. input/metadata/time проезжают как есть
// (пробы jail разбирают state.input.command); исходные поля сохраняются.
const toPortalPart = (p) => {
  if (p.type !== "tool") return { ...p };
  const st = obj(p.state) ? p.state : {};
  const outText = Array.isArray(st.content)
    ? st.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
    : "";
  return {
    ...p,
    ...(!p.callID && p.id ? { callID: p.id } : {}),
    ...(!p.tool && p.name ? { tool: p.name } : {}),
    state: { ...st, ...(typeof st.output === "string" || !outText ? {} : { output: outText }) },
  };
};

// BUG-193: ключ metadata для скрытых (synthetic) частей хода; его же читает плагин v2 (hooks.HIDDEN_KEY)
const HIDDEN_KEY = "zaiHidden";

// TASK-16.7 волна 2: формы 2.2.6 → язык 1.x (клиент и сервер портала не меняются).
// BUG-202: ошибка v2 {type, message} → 1.x {name, data:{message}}; прерывание —
// MessageAbortedError (клиент прощает только его: src/lib/turn.js).
const isAborted = (err) => obj(err) && (err.type === "aborted" || err.name === "MessageAbortedError");
const toPortalError = (err) => {
  if (!obj(err) || err.name) return err;
  if (err.type === "aborted") return { name: "MessageAbortedError", data: { message: err.message ?? "Aborted" } };
  return { ...err, name: err.type ?? "UnknownError", data: { message: err.message ?? String(err.type ?? "error") } };
};
// BUG-205: Permission.Request 2.2.6 {action, resources, save, source} → поля 1.x
// {permission, patterns, always, metadata.command, tool}; исходные поля остаются.
const toPortalPermission = (p) => {
  if (!obj(p) || typeof p.permission === "string" || typeof p.action !== "string") return p;
  const patterns = Array.isArray(p.resources) ? p.resources.filter((x) => typeof x === "string") : [];
  return {
    ...p,
    permission: p.action === "shell" ? "bash" : p.action,
    patterns,
    always: Array.isArray(p.save) ? p.save : [],
    metadata: { ...(obj(p.metadata) ? p.metadata : {}), command: p.metadata?.command ?? patterns[0] ?? null },
    ...(obj(p.source) && p.source.id ? { tool: { messageID: p.source.messageID ?? null, callID: p.source.id } } : {}),
  };
};
// BUG-203: Form.Info 2.2.6 (или {form}) → вопрос 1.x {id, sessionID, questions[]};
// key поля едет в вопросе — по нему ответ клиента раскладывается обратно (BUG-204).
const toPortalQuestion = (x) => {
  if (!obj(x)) return x;
  const f = { ...x, ...(obj(x.form) ? x.form : {}), id: x.form?.id ?? x.id, sessionID: x.form?.sessionID ?? x.sessionID };
  if (!f.id || !Array.isArray(f.fields)) return x;
  return {
    id: f.id,
    sessionID: f.sessionID ?? null,
    ...(obj(f.metadata?.tool) ? { tool: { messageID: f.metadata.tool.messageID ?? null, callID: f.metadata.tool.id ?? null } } : {}),
    questions: f.fields.filter(obj).map((fl) => ({
      key: fl.key ?? fl.id,
      header: fl.title ?? fl.label ?? "",
      question: fl.description ?? fl.title ?? fl.label ?? "",
      options: (Array.isArray(fl.options) ? fl.options : []).filter(obj).map((o) => ({ label: o.label ?? String(o.value ?? ""), ...(o.description ? { description: o.description } : {}) })),
      multiple: fl.type === "string[]",
      custom: Boolean(fl.custom),
    })),
    fields: f.fields,
  };
};
// BUG-207: файл user-сообщения v2 {data(base64)+mime | uri, name} → file-часть 1.x
const toPortalFile = (f) => {
  if (!obj(f)) return null;
  const url = typeof f.uri === "string" && f.uri ? f.uri : typeof f.url === "string" && f.url ? f.url : typeof f.data === "string" && f.data ? `data:${f.mime ?? "application/octet-stream"};base64,${f.data}` : null;
  if (!url) return null;
  return { type: "file", ...(f.mime ? { mime: f.mime } : {}), ...(f.name ? { filename: f.name } : {}), url };
};
// BUG-208: v2 хранит текст хода одной строкой; ссылки на вложения композер шлёт
// отдельными частями (MessageBubble ищет их с начала части) — делим обратно.
const REF_SPLIT = /\n\n(?=\[Пользователь приложил файл: )/;
const toPortalMessage = (m, sessionID) => {
  if (!m || typeof m !== "object") return null;
  const { id, type, time, metadata, error } = m;
  if (type === "user") {
    // BUG-193: скрытая подсказка хода (metadata.zaiHidden) — synthetic-часть, как в 1.x
    const hidden = obj(metadata) && typeof metadata[HIDDEN_KEY] === "string" && metadata[HIDDEN_KEY] ? metadata[HIDDEN_KEY] : null;
    const texts = (typeof m.text === "string" ? m.text : "").split(REF_SPLIT);
    const files = (Array.isArray(m.files) ? m.files : []).map(toPortalFile).filter(Boolean);
    return {
      info: { id, sessionID, role: "user", ...(obj(time) ? { time } : {}), ...(obj(metadata) ? { metadata } : {}) },
      parts: [...texts.map((text) => ({ type: "text", text })), ...files, ...(hidden ? [{ type: "text", text: hidden, synthetic: true }] : [])],
    };
  }
  if (type === "assistant") {
    const model = obj(m.model) ? m.model : {};
    const content = Array.isArray(m.content) ? m.content.filter((p) => p && typeof p === "object").map(toPortalPart) : [];
    return {
      info: {
        id, sessionID, role: "assistant",
        ...(model.providerID ? { providerID: model.providerID } : {}),
        ...(model.id ?? model.modelID ? { modelID: model.id ?? model.modelID } : {}),
        ...(model.variant ? { variant: model.variant } : {}),
        ...(typeof m.mode === "string" && m.mode ? { mode: m.mode } : {}),
        ...(m.agent ? { agent: m.agent } : {}),
        ...(obj(time) ? { time } : {}),
        ...(typeof m.finish === "string" && m.finish ? { finish: m.finish } : {}),
        ...(typeof m.rawFinish === "string" && m.rawFinish ? { rawFinish: m.rawFinish } : {}),
        ...(obj(m.tokens) ? { tokens: toPortalTokens(m.tokens) } : {}),
        ...(typeof m.cost === "number" ? { cost: m.cost } : {}),
        ...(error ? { error: toPortalError(error) } : {}), // BUG-202
        ...(obj(metadata) ? { metadata } : {}),
      },
      parts: content,
    };
  }
  return null; // idle, model-switched, agent-switched, location-switched, …
};

// --- SSE (tasks 2.3) -----------------------------------------------------------
// Общий цикл подписки (v1 и v2): fetch-поток → кадры «data: …» → rewrite →
// onEvent. Обрыв/конец потока → пауза backoffMs[попытка] → новый коннект;
// перед кадрами реконнекта emitится gap zai.resync (у v2 нет Last-Event-ID —
// хаб пересинхронизируется; hub.js RESYNC, {type, properties:{}}). close()
// останавливает цикл и снимает отложенные задачи.
const HUB_BACKOFF = [1000, 2000, 5000, 10000, 30000]; // как в lib/hub.js
// BUG-189: страница списка сессий v2 и предохранитель от бесконечного курсора
// (200 × 100 = 20 000 сессий; живой 2.2.6 принимает limit ≥ 500).
const LIST_PAGE = 200;
const LIST_MAX_PAGES = 100;
// BUG-191: потолок ?limit= истории сообщений в opencode 2.2.6.
const MSG_PAGE_MAX = 200;
// BUG-214: потолок буфера кадра SSE — кадр без «\n\n» больше лимита копить
// нельзя (мусорный поток зажал бы всю память), рвём соединение и реконнект.
const SSE_BUF_MAX = 8 * 1024 * 1024;
function sseLoop({ url, headers = {}, fetchImpl = fetch, onEvent, signal, backoffMs = HUB_BACKOFF, rewrite, stableMs = 30_000 }) {
  const ctrl = new AbortController();
  let closed = false;
  let connects = 0; // zai.resync: каждый реконнект, кроме первого — не сбрасывается
  let stalls = 0; // BUG-214: попытки для паузы; устойчивое соединение сбрасывает счётчик
  let timer = null;
  let wake = null;
  const stop = () => {
    if (closed) return;
    closed = true;
    ctrl.abort();
    if (timer) clearTimeout(timer);
    if (wake) { const w = wake; wake = null; w(); }
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }
  (async () => {
    while (!closed) {
      if (connects > 0) {
        const gap = { type: "zai.resync", properties: {} };
        const out = rewrite ? rewrite(gap) : gap;
        if (out) onEvent(out);
      }
      connects++;
      let openedAt = 0;
      try {
        const res = await fetchImpl(url, { headers: { accept: "text/event-stream", ...headers }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        openedAt = Date.now();
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
            if (!data) continue;
            let evt;
            try { evt = JSON.parse(data); } catch { continue; } // не-JSON кадр — игнор
            const out = rewrite ? rewrite(evt) : evt;
            if (out) onEvent(out); // null = переписыватель отбросил (рукопожатие, дельта ждёт троттлинга)
          }
          if (buf.length > SSE_BUF_MAX) {
            // BUG-214: кадр без разделителя превысил потолок — не копим, рвём
            console.log(`[oc-sse] frame buffer over ${SSE_BUF_MAX} bytes without a delimiter (BUG-214) — reconnecting`);
            throw new Error("sse frame buffer overflow");
          }
        }
      } catch { /* коннект не открылся или поток оборвался — пауза и снова */ }
      // BUG-214: соединение прожило порог — сеть здорова, следующая пауза
      // снова с минимума (иначе после нескольких обрывов пауза навсегда max)
      if (openedAt && Date.now() - openedAt >= stableMs) stalls = 0;
      if (closed || ctrl.signal.aborted) return;
      const ms = backoffMs[Math.min(stalls, backoffMs.length - 1)] ?? 1000;
      stalls++;
      await new Promise((r) => {
        wake = r;
        timer = setTimeout(() => { wake = null; r(); }, ms);
        timer.unref?.();
      });
    }
  })();
  return { close: stop };
}

// Переписыватель v2 → язык портала (design §2). Дельты текста/размышления
// копятся и выдаются ПОЛНЫМИ частями message.part.updated с троттлингом
// (~100 мс) — хаб и рендер дельт не понимают; .ended финализирует полным
// текстом (data.text). Tool-события идут сразу, без троттлинга — их немного,
// а статус (pending/running/completed/error) для очередей важен.
// server.connected — рукопожатие SSE, хабу не нужно. Неизвестные типы —
// passthrough с конвертом (живой v2 шлёт типов больше api-map §2, Э10).
// Каждому событию приклеивается directory = location.directory ?? null —
// один глобальный поток, фильтр по папкам делает хаб.
// BUG-214: накопленное (text/tool/pending) чистится по терминальному событию
// хода (execution.succeeded/interrupted/failed) и по session.deleted;
// knownDir — по session.deleted и потолком KNOWN_DIR_MAX (экспорт — для
// unit-тестов чистки, вызывающих не ломает: основное значение — функция).
const KNOWN_DIR_MAX = 5000;
export function createV2Rewriter({ emit, throttleMs = 100, dirOf = null } = {}) {
  const knownDir = new Map(); // BUG-196: sessionID → папка (из событий с location)
  const knownParent = new Map(); // BUG-223: sessionID дочерней сессии → родитель (из session.created)
  const text = new Map(); // id части → накопленный текст
  const partSess = new Map(); // BUG-214: id текстовой части → sessionID (для чистки text)
  const pending = new Map(); // id части → {sessionID, part, directory}
  const timers = new Map();
  const tool = new Map(); // callID → {sessionID, messageID, tool, input, directory}
  const flush = (id) => {
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    emit({ type: "message.part.updated", properties: { sessionID: p.sessionID, part: p.part }, directory: p.directory });
  };
  const schedule = (sessionID, part, directory, now = false) => {
    pending.set(part.id, { sessionID, part, directory });
    if (now) { flush(part.id); return; }
    if (timers.has(part.id)) return;
    const t = setTimeout(() => flush(part.id), throttleMs);
    t.unref?.();
    timers.set(part.id, t);
  };
  const streamPart = (evt, kind, dir) => {
    const d = evt.data ?? {};
    const amid = d.assistantMessageID;
    const id = `${amid}:${d.ordinal ?? 0}:${kind}`;
    const acc = evt.type.endsWith(".started") ? "" : (text.get(id) ?? "");
    const full = evt.type.endsWith(".ended")
      ? (typeof d.text === "string" ? d.text : acc)
      : acc + (d.delta ?? "");
    text.set(id, full);
    partSess.set(id, d.sessionID); // BUG-214: кто владеет частью
    schedule(d.sessionID, { id, messageID: amid, type: kind, text: full, time: {} }, dir, evt.type.endsWith(".ended"));
    return null;
  };
  // BUG-214: ход кончился — сначала сброс отложенных частей этой сессии
  // (flush), потом чистка накопленного; чужие сессии не трогаем.
  const endRun = (sid) => {
    for (const [id, p] of [...pending]) if (p.sessionID === sid) flush(id);
    for (const [id, s] of [...partSess]) if (s === sid) { text.delete(id); partSess.delete(id); }
    for (const [callID, t] of [...tool]) if (t.sessionID === sid) tool.delete(callID);
  };
  const noteDir = (sid, dir) => {
    // BUG-214: потолок карты папок — при переполнении вытесняется самая
    // старая запись (порядок вставки Map)
    if (!knownDir.has(sid) && knownDir.size >= KNOWN_DIR_MAX) knownDir.delete(knownDir.keys().next().value);
    knownDir.set(sid, dir);
  };
  // TASK-16.31: 2.2.6 не шлёт message.updated (запись живого потока —
  // tests/fixtures/v2-turn-events.json), а хаб взводит и снимает ожидание
  // ответа («ход принят, но не запущен» → replay) именно по нему. Переписыватель
  // порождает служебные message.updated сам: сообщение пользователя — по
  // inbox.enqueued, ответ с parentID — по step.started, «отвечено ошибкой» — по
  // прерванному/упавшему ходу (как errored-сообщение 1.x: Стоп не должен
  // привести к повтору промпта). zaiInternal: хаб учитывает, клиентам не шлёт.
  const turnUser = new Map(); // sessionID → inboxID сообщения, на которое идёт ход
  const internalMsg = (sid, info, dir) =>
    emit({ type: "message.updated", properties: { sessionID: sid, info: { sessionID: sid, ...info }, zaiInternal: true }, directory: dir });
  const noteTurnUser = (sid, id) => {
    if (!turnUser.has(sid) && turnUser.size >= KNOWN_DIR_MAX) turnUser.delete(turnUser.keys().next().value);
    turnUser.set(sid, id);
  };
  const endTurn = (sid, dir, error) => {
    const uid = turnUser.get(sid);
    if (uid) internalMsg(sid, { id: `zai-end:${uid}`, role: "assistant", parentID: uid, time: { completed: Date.now() }, error }, dir);
  };
  const ABORTED = { name: "MessageAbortedError", data: { message: "interrupted" } };
  const rewrite = (evt) => {
    const d = evt?.data && typeof evt.data === "object" ? evt.data : {};
    const sid = d.sessionID ?? (typeof evt?.type === "string" && evt.type.startsWith("session.") ? d.id : undefined);
    // BUG-196: 2.2.6 шлёт session.execution.* и session.renamed БЕЗ location —
    // с dir null фильтр тенанта (hub visible) выбрасывал их: тенант не видел
    // «готово»/ошибку/переименование своего хода. Папка сессии — из прошлых
    // событий с location, иначе из индекса сессий хаба (dirOf).
    let dir = evt?.location?.directory ?? d.location?.directory ?? null;
    if (dir && sid) noteDir(sid, dir);
    if (!dir && sid) dir = knownDir.get(sid) ?? (typeof dirOf === "function" ? dirOf(sid) ?? null : null);
    switch (evt?.type) {
      case "server.connected":
        return null; // рукопожатие SSE
      case "session.created": case "session.renamed": case "session.moved":
      case "session.forked": case "session.model.selected": case "session.agent.selected":
      {
        // BUG-223: 2.2.6 шлёт эти события с data.sessionID БЕЗ data.id — клиент (upsertSession)
        // запись без id выбрасывал, и открытый список «Чаты» не узнавал о чате, созданном или
        // переименованном в другой вкладке. id, папка и (у создания/переименования) время — здесь.
        // parentID приходит только в session.created — запоминаем, иначе переименованная
        // дочерняя сессия субагента встала бы в список как обычный чат
        if (sid && d.parentID) knownParent.set(sid, d.parentID);
        const parent = sid ? knownParent.get(sid) : null;
        const info = { ...d, ...(sid ? { id: sid } : {}), ...(dir && !d.directory ? { directory: dir } : {}), ...(parent && !d.parentID ? { parentID: parent } : {}) };
        if ((evt.type === "session.created" || evt.type === "session.renamed") && !info.time) {
          const at = Number(evt.created) > 0 ? Number(evt.created) : Date.now();
          info.time = { updated: at };
        }
        return { type: "session.updated", properties: { info }, directory: dir };
      }
      case "session.deleted": // форма 1.x — synthetic-запись с info (server.js:1613, BUG-186)
        endRun(sid); // BUG-214: сессии больше нет — части и отложенное не нужны
        knownDir.delete(sid);
        knownParent.delete(sid);
        turnUser.delete(sid);
        return { type: "session.deleted", properties: { sessionID: sid, info: { id: sid, directory: dir } }, directory: dir };
      case "session.inbox.enqueued": // TASK-16.31: новое сообщение пользователя — взвод ожидания в хабе
        if (sid && d.item?.type === "user" && typeof d.inboxID === "string") {
          if (!turnUser.has(sid)) noteTurnUser(sid, d.inboxID); // идущий ход отвечает на прежнее сообщение до delivered
          internalMsg(sid, { id: d.inboxID, role: "user", time: { created: Date.now() } }, dir);
        }
        break; // само событие — passthrough, как раньше
      case "session.inbox.delivered":
        if (sid && typeof d.inboxID === "string") noteTurnUser(sid, d.inboxID);
        break;
      case "session.step.started": // TASK-16.31: ответ привязан к сообщению (parentID) — части шага снимают ожидание
        if (sid && typeof d.assistantMessageID === "string") {
          internalMsg(sid, { id: d.assistantMessageID, role: "assistant", parentID: turnUser.get(sid) ?? null, time: { created: Date.now() } }, dir);
        }
        break;
      case "session.execution.started":
        return { type: "session.status", properties: { sessionID: sid, status: "busy" }, directory: dir };
      case "session.execution.succeeded": case "session.execution.interrupted":
        endRun(sid); // BUG-214: терминальное событие хода
        if (evt.type === "session.execution.interrupted") endTurn(sid, dir, ABORTED); // TASK-16.31
        return { type: "session.idle", properties: { sessionID: sid }, directory: dir };
      case "session.execution.failed":
        endRun(sid); // BUG-214: терминальное событие хода
        // BUG-202: «Стоп» / отклонённый ход — {type:"aborted"}: конец хода, не ошибка
        if (isAborted(d.error)) {
          endTurn(sid, dir, ABORTED); // TASK-16.31
          return { type: "session.idle", properties: { sessionID: sid }, directory: dir };
        }
        endTurn(sid, dir, toPortalError(d.error ?? { type: "UnknownError", message: "execution failed" })); // TASK-16.31
        return { type: "session.error", properties: { sessionID: sid, error: toPortalError(d.error ?? { type: "UnknownError", message: "execution failed" }) }, directory: dir };
      case "session.step.failed":
        // прерывание пользователем — не ошибка хода (api-map §3: step.failed
        // с reason:"user" идёт перед execution.interrupted)
        if (d.reason === "user" || isAborted(d.error)) return { type: "session.idle", properties: { sessionID: sid }, directory: dir };
        return { type: "session.error", properties: { sessionID: sid, error: toPortalError(d.error ?? { type: "UnknownError", message: d.reason ?? "step failed" }) }, directory: dir };
      case "session.retry.scheduled":
        return { type: "session.status", properties: { sessionID: sid, status: "retry" }, directory: dir };
      case "session.status": case "session.idle":
        return { type: evt.type, properties: d, directory: dir };
      case "permission.asked": case "permission.replied": case "permission.updated":
        return { type: evt.type, properties: toPortalPermission(d), directory: dir }; // BUG-205
      case "form.created": // Э5: вопросы стали формами; BUG-203 — в форме вопроса 1.x
        return { type: "question.asked", properties: toPortalQuestion(d), directory: dir };
      case "form.replied": case "form.cancelled": {
        const fid = d.id ?? d.formID ?? d.form?.id ?? d.requestID;
        return { type: evt.type === "form.replied" ? "question.replied" : "question.updated", properties: { ...d, ...(fid ? { id: fid, requestID: fid } : {}) }, directory: dir };
      }
      case "session.text.started": case "session.text.delta": case "session.text.ended":
        return streamPart(evt, "text", dir);
      case "session.reasoning.started": case "session.reasoning.delta": case "session.reasoning.ended":
        return streamPart(evt, "reasoning", dir);
      default:
        break;
    }
    if (typeof evt?.type === "string" && evt.type.startsWith("session.tool.")) {
      const callID = d.id;
      const prev = tool.get(callID) ?? { sessionID: sid, messageID: d.assistantMessageID ?? null, tool: d.name ?? d.tool ?? null, input: {}, directory: dir };
      // FEAT-01.77: metadata вызова накапливается по ключам (у субагента
      // sessionID дочерней сессии приходит в progress) и не теряется на
      // следующих обновлениях части; на success свои metadata поверх копленных
      if (d.metadata && typeof d.metadata === "object") prev.metadata = { ...prev.metadata, ...d.metadata };
      const meta = () => (prev.metadata ? { metadata: { ...prev.metadata } } : {});
      // FEAT-01.77: ввод инструмента виден клиенту, пока инструмент работает (раньше — только по завершении)
      const withInput = () => (prev.input && Object.keys(prev.input).length ? { input: prev.input } : {});
      // FEAT-01.77: время части вживую — как в истории (time.created/ran/completed): карточке агента и шагу нужно «сколько идёт»
      prev.time = prev.time ?? { created: Date.now() };
      if (evt.type === "session.tool.called" && !prev.time.ran) prev.time.ran = Date.now();
      if ((evt.type === "session.tool.success" || evt.type === "session.tool.failed") && !prev.time.completed) prev.time.completed = Date.now();
      if (evt.type === "session.tool.input.started") {
        prev.state = { status: "pending", ...meta() };
      } else if (evt.type === "session.tool.input.ended") {
        if (d.input && typeof d.input === "object") prev.input = d.input;
        // FEAT-01.77: 2.2.6 отдаёт собранный ввод JSON-строкой в text — без него карточка
        // агента в очереди не знает ни имени, ни задачи, а шаг — что именно он делает
        else if (typeof d.text === "string" && d.text) { try { const parsed = JSON.parse(d.text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prev.input = parsed; } catch {} }
        prev.state = { ...(prev.state ?? { status: "pending" }), ...withInput(), ...meta() };
      } else if (evt.type === "session.tool.called") {
        if (d.input && typeof d.input === "object") prev.input = d.input;
        prev.state = { status: "running", ...withInput(), ...meta() };
      } else if (evt.type === "session.tool.progress") {
        prev.state = { status: "running", ...withInput(), ...(d.message ? { message: d.message } : {}), ...meta() };
      } else if (evt.type === "session.tool.success") {
        prev.state = { status: "completed", input: prev.input, content: Array.isArray(d.content) ? d.content : [], ...meta() };
      } else if (evt.type === "session.tool.failed") {
        prev.state = { status: "error", input: prev.input, ...(d.error ? { error: d.error } : {}), ...meta() };
      } else {
        return { type: evt.type, properties: d, directory: dir }; // незнакомое tool.* — passthrough
      }
      tool.set(callID, prev);
      return { type: "message.part.updated", properties: { sessionID: prev.sessionID, part: { id: callID, messageID: prev.messageID, type: "tool", tool: prev.tool, state: prev.state, time: { ...prev.time } } }, directory: prev.directory };
    }
    // неизвестный тип — passthrough, не падаем
    return { type: evt.type, properties: d, directory: dir };
  };
  // BUG-214: только для тестов — размеры внутренних карт (рост = утечка)
  rewrite._sizes = () => ({ text: text.size, tool: tool.size, knownDir: knownDir.size, pending: pending.size, turnUser: turnUser.size });
  return rewrite;
}

export function createOcClient({ api = "v1", base, password, fetchImpl = fetch } = {}) {
  if (api !== "v1" && api !== "v2") throw new Error(`createOcClient: api должен быть "v1"|"v2", получено ${JSON.stringify(api)}`);
  if (!base) throw new Error("createOcClient: base обязателен");
  const root = String(base).replace(/\/+$/, "");
  const v2 = api === "v2";
  const authHeader = v2 && password !== undefined ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : null;

  const qs = (params = {}) => {
    const u = new URLSearchParams();
    for (const [k, val] of Object.entries(params)) if (val !== undefined && val !== null) u.set(k, String(val));
    return u.toString();
  };
  // 1.x: папка — обычный query-параметр `?directory=`
  const dirQ = (dir, extra = {}) => qs({ ...extra, ...(dir !== undefined && dir !== null ? { directory: dir } : {}) });
  // v2 instance-маршруты: `?location[directory]=` (deepObject; простой ?directory= там игнорируется)
  const locQ = (dir) => (dir !== undefined && dir !== null ? qs({ "location[directory]": dir }) : "");

  async function req(method, path, { query = "", body, timeoutMs = 0, signal } = {}) {
    const headers = { accept: "application/json" };
    if (authHeader) headers.authorization = authHeader; // пароль только здесь
    if (body !== undefined) headers["content-type"] = "application/json";
    // {timeoutMs, signal} → AbortSignal: таймаут метода и внешний сигнал вместе
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    const merged = timeoutSignal && signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal ?? signal ?? null;
    let res;
    try {
      res = await fetchImpl(`${root}${path}${query ? `?${query}` : ""}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(merged ? { signal: merged } : {}),
      });
    } catch (err) {
      const cause = err?.message ?? null;
      if (signal?.aborted) throw new OcError(`oc ${api} ${method} ${path}: прервано вызывающим`, { status: 0, code: "aborted", cause });
      if (timeoutSignal?.aborted) throw new OcError(`oc ${api} ${method} ${path}: таймаут ${timeoutMs} мс`, { status: 0, code: "timeout", cause });
      throw new OcError(`oc ${api} ${method} ${path}: сеть недоступна (${cause ?? "ошибка"})`, { status: 0, code: "network", cause });
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не-JSON тело */ }
    if (!res.ok) {
      const tag = json?._tag ?? (typeof json?.error === "string" ? json.error : null) ?? (typeof json?.message === "string" ? json.message : null);
      throw new OcError(`oc ${api} ${method} ${path} → ${res.status}${tag ? ` ${String(tag).slice(0, 200)}` : ""}`, { status: res.status, body: json ?? (text || null) });
    }
    return { status: res.status, json, text };
  }

  const unwrapData = (out) => out.json?.data;
  // BUG-206: откат в v2 только стейджится (revert) — перед следующим ходом его
  // фиксируем, как 1.x делал необратимым откат при новом сообщении. Session.Info
  // несёт revert, пока откат не зафиксирован/не снят. Ошибка проверки не мешает ходу.
  async function commitStagedRevert(sessionID, { timeoutMs, signal } = {}) {
    try {
      const s = unwrapData(await req("GET", `/api/session/${enc(sessionID)}`, { timeoutMs, signal }));
      if (s && s.revert) await req("POST", `/api/session/${enc(sessionID)}/revert/commit`, { timeoutMs, signal });
    } catch {}
  } // конверт {location, data} / {data, cursor} → голое значение
  // v1-мутации отвечают объектом (204-заглушек в 1.x нет): json, иначе текст, иначе true
  const body1 = (out) => (out.json !== null && out.json !== undefined ? out.json : out.text || true);
  // runCommand (BUG-188, №27): ответ upstream возвращается КАК ЕСТЬ и на
  // 4xx/5xx — портал различает 400 (неизвестная команда) и 404 (сессия) по
  // out.status (server.js fireCommandTurn). Бросается только транспортный
  // сбой (сеть/таймаут/прерывание, status 0).
  const reqStatus = async (method, path, opts) => {
    try {
      return await req(method, path, opts);
    } catch (err) {
      if (err instanceof OcError && err.status > 0) {
        return { status: err.status, json: err.body, text: typeof err.body === "string" ? err.body : (err.body?._tag ?? "") };
      }
      throw err;
    }
  };

  // warmup (№24): health-check с retry (Э2: холодный ход работает и без прогрева).
  // v1 — GET /config/providers; v2 — GET /api/mcp (любой «дорогой» instance-запрос).
  // Таймаут — на КАЖДУЮ попытку (дефолт таблицы добавит обёртка сборки).
  const makeWarmup = (pathFor, queryFor) => async ({ directory, timeoutMs, signal } = {}, { attempts = 3, delayMs = 1000 } = {}) => {
    let status = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const out = await req("GET", pathFor(), { query: queryFor(directory), timeoutMs, signal });
        if (out.status < 400) return { ok: true, status: out.status, attempts: attempt };
        status = out.status;
      } catch (err) {
        if (!(err instanceof OcError)) throw err;
        status = err.status;
      }
      if (attempt < attempts && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    return { ok: false, status, attempts };
  };

  // Обёртка сборки: каждому методу — дефолтный таймаут из таблицы, если
  // вызывающий не передал свой {timeoutMs, signal}. Дефолт кладётся в
  // последний аргумент-объект (или добавляется, если метод вызвали без
  // опций: busyMap(), getSession("sid")). events не трогаем — SSE живёт
  // на signal/close().
  const withDefaultTimeouts = (methods) => {
    const out = {};
    for (const [name, fn] of Object.entries(methods)) {
      const def = DEFAULT_TIMEOUTS[name] ?? 30_000;
      out[name] = name === "events" || def <= 0
        ? fn
        : async (...args) => {
            let injected = false;
            for (let i = args.length - 1; i >= 0; i--) {
              const a = args[i];
              if (a !== null && typeof a === "object" && !Array.isArray(a)) {
                if (a.timeoutMs === undefined && a.signal === undefined) args[i] = { ...a, timeoutMs: def };
                injected = true;
                break;
              }
            }
            return injected ? fn(...args) : fn(...args, { timeoutMs: def });
          };
    }
    return out;
  };

  // ---- транспорт v1: РОВНО то, что портал сейчас получает от opencode 1.19.5 ----
  // Каждый метод принимает {timeoutMs, signal} (дефолт из таблицы добавит
  // обёртка сборки) и пробрасывает их в req; поля вырезаны из rest-спредов,
  // чтобы не утекли в query/тела.
  const v1t = {
    listSessions: async ({ directory, timeoutMs, signal, ...rest } = {}) =>
      (await req("GET", "/session", { query: dirQ(directory, rest), timeoutMs, signal })).json,
    createSession: async ({ directory, title, model, agent, timeoutMs, signal, ...rest } = {}) =>
      (
        await req("POST", "/session", {
          query: dirQ(directory),
          body: { ...rest, ...(title !== undefined ? { title } : {}), ...(model ? { model } : {}), ...(agent ? { agent } : {}) },
          timeoutMs,
          signal,
        })
      ).json,
    getSession: async (sessionID, { directory, timeoutMs, signal } = {}) =>
      (await req("GET", `/session/${enc(sessionID)}`, { query: dirQ(directory), timeoutMs, signal })).json,
    patchSession: async (sessionID, { directory, title, timeoutMs, signal, ...rest } = {}) =>
      (
        await req("PATCH", `/session/${enc(sessionID)}`, {
          query: dirQ(directory),
          body: { ...rest, ...(title !== undefined ? { title } : {}) },
          timeoutMs,
          signal,
        })
      ).json,
    deleteSession: async (sessionID, { directory, timeoutMs, signal } = {}) =>
      body1(await req("DELETE", `/session/${enc(sessionID)}`, { query: dirQ(directory), timeoutMs, signal })),
    // История 1.x: upstream отвечает {info, parts} целиком (старые раньше) и
    // 400 на любой ?before (proxy.js:81) — нарезку делает портал; тут та же
    // математика paginateMessages (lib/proxy.js:96–108) локально.
    listMessages: async (sessionID, { directory, before, limit, all, timeoutMs, signal } = {}) => {
      const raw = (await req("GET", `/session/${enc(sessionID)}/message`, { query: dirQ(directory), timeoutMs, signal })).json;
      if (!Array.isArray(raw)) throw new OcError(`listMessages: upstream вернул не список (${api})`, { status: 0 });
      if (all) return { messages: raw, hasMore: false, nextBefore: null }; // весь список, как отдаёт 1.x
      const n = Math.min(Math.max(Number(limit) || 50, 1), 500); // PAGE_DEFAULT/PAGE_MAX
      let end = raw.length;
      if (before !== undefined && before !== null) {
        end = raw.findIndex((m) => (m?.info?.id ?? m?.id) === before);
        if (end < 0) throw new OcError("listMessages: unknown before cursor", { status: 400, body: { error: "unknown before cursor" } });
      }
      const start = Math.max(0, end - n);
      const messages = raw.slice(start, end);
      const hasMore = start > 0;
      return { messages, hasMore, nextBefore: hasMore && messages.length ? messages[0]?.info?.id ?? messages[0]?.id ?? null : null };
    },
    prompt: async ({ directory, sessionID, parts, model, agent, variant, system, timeoutMs, signal, ...rest } = {}) =>
      (
        await req("POST", `/session/${enc(sessionID)}/prompt_async`, {
          query: dirQ(directory),
          body: { ...rest, ...(parts ? { parts } : {}), ...(model ? { model } : {}), ...(agent ? { agent } : {}), ...(variant ? { variant } : {}), ...(system ? { system } : {}) },
          timeoutMs,
          signal,
        })
      ).json,
    abort: async (sessionID, { directory, timeoutMs, signal } = {}) =>
      body1(await req("POST", `/session/${enc(sessionID)}/abort`, { query: dirQ(directory), timeoutMs, signal })),
    busyMap: async ({ directory, timeoutMs, signal } = {}) =>
      // v1: /session/status directory-scoped — ?directory= обязателен; v2
      // игнорирует directory (глобальная карта /api/session/active, №9).
      (await req("GET", "/session/status", { query: dirQ(directory), timeoutMs, signal })).json ?? {},
    sessionDiff: async (sessionID, { directory, messageID, timeoutMs, signal } = {}) =>
      (await req("GET", `/session/${enc(sessionID)}/diff`, { query: dirQ(directory, { messageID }), timeoutMs, signal })).json,
    revert: async (sessionID, { directory, messageID, timeoutMs, signal } = {}) =>
      (await req("POST", `/session/${enc(sessionID)}/revert`, { query: dirQ(directory), body: { messageID }, timeoutMs, signal })).json,
    unrevert: async (sessionID, { directory, timeoutMs, signal } = {}) =>
      body1(await req("POST", `/session/${enc(sessionID)}/unrevert`, { query: dirQ(directory), timeoutMs, signal })),
    // SSE 1.x: per-directory /event?directory=, события уже в языке портала —
    // пересылаем как есть, приклеивая directory для фильтра хаба.
    events: ({ directory, onEvent, signal, backoffMs, stableMs } = {}) =>
      sseLoop({
        url: `${root}/event${directory !== undefined && directory !== null ? `?${dirQ(directory)}` : ""}`,
        fetchImpl,
        onEvent,
        signal,
        backoffMs,
        stableMs, // BUG-214
        rewrite: (evt) => ({ ...evt, directory: directory ?? null }),
      }),
    listPermissions: async ({ directory, timeoutMs, signal } = {}) =>
      (await req("GET", "/permission", { query: dirQ(directory), timeoutMs, signal })).json,
    replyPermission: async ({ directory, sessionID, requestID, reply, message, timeoutMs, signal } = {}) =>
      (
        await req("POST", `/permission/${enc(requestID)}/reply`, {
          query: dirQ(directory),
          body: { ...(reply !== undefined ? { reply } : {}), ...(message ? { message } : {}) },
          timeoutMs,
          signal,
        })
      ).json,
    listQuestions: async ({ directory, timeoutMs, signal } = {}) =>
      (await req("GET", "/question", { query: dirQ(directory), timeoutMs, signal })).json ?? [],
    replyQuestion: async ({ directory, requestID, answers, timeoutMs, signal } = {}) =>
      body1(await req("POST", `/question/${enc(requestID)}/reply`, { query: dirQ(directory), body: { answers }, timeoutMs, signal })),
    rejectQuestion: async ({ directory, requestID, formID, message, timeoutMs, signal } = {}) =>
      body1(await req("POST", `/question/${enc(requestID ?? formID)}/reject`, { query: dirQ(directory, message ? { message } : {}), timeoutMs, signal })),
    disposeInstance: async ({ directory, timeoutMs, signal } = {}) =>
      body1(await req("POST", "/instance/dispose", { query: dirQ(directory), timeoutMs, signal })),
    mcpStatus: async ({ directory, timeoutMs, signal } = {}) => (await req("GET", "/mcp", { query: dirQ(directory), timeoutMs, signal })).json ?? {},
    listAgents: async ({ timeoutMs, signal } = {}) => (await req("GET", "/agent", { timeoutMs, signal })).json ?? [],
    listProviders: async ({ directory, timeoutMs, signal } = {}) =>
      (await req("GET", "/provider", { query: dirQ(directory), timeoutMs, signal })).json,
    configGet: async ({ directory, timeoutMs, signal } = {}) =>
      (await req("GET", "/config", { query: dirQ(directory), timeoutMs, signal })).json,
    warmup: makeWarmup(() => "/config/providers", dirQ),
    listProjects: async ({ timeoutMs, signal } = {}) => (await req("GET", "/project", { timeoutMs, signal })).json ?? [],
    healthInfo: async ({ timeoutMs, signal } = {}) => (await req("GET", "/global/health", { timeoutMs, signal })).json,
    setSessionModel: async () => { throw v2Only("setSessionModel"); },
    setSessionAgent: async () => { throw v2Only("setSessionAgent"); },
  };

  // Слэш-команды (BUG-188, №27) — вне 28 методов design §1.2 (не enumerable,
  // см. сборку ниже). v1: GET /command?directory= (голый массив) и
  // синхронный POST /session/:id/command — запрос держит весь ход.
  const v1x = {
    listCommands: async ({ directory, timeoutMs, signal } = {}) => (await req("GET", "/command", { query: dirQ(directory), timeoutMs, signal })).json ?? [],
    runCommand: async (sessionID, { directory, body, timeoutMs, signal } = {}) =>
      reqStatus("POST", `/session/${enc(sessionID)}/command`, { query: dirQ(directory), body, timeoutMs, signal }),
  };
  // pluginList на v1 не существует — читаемый отказ вместо TypeError (гейт
  // сервера v2-only, вызов на v1 — ошибка использования).
  const v1p = {
    pluginList: async () => { throw v2Only("pluginList"); },
  };

  // ---- транспорт v2: конверт → язык 1.x (api-map §0–§11, design §1.3) ----
  // {timeoutMs, signal} — как в v1: дефолт добавит обёртка, из rest-спредов
  // поля вырезаны.
  const v2t = {
    // BUG-189: /api/session постраничный — без ?limit= живой 2.2.6 отдаёт 50
    // записей и cursor.next (у любой непустой страницы, конец — пустая
    // страница). 1.x отдавал весь список, портал (список, индекс, хаб,
    // фильтр тенанта) ждёт весь — проходим курсор до конца.
    listSessions: async ({ directory, timeoutMs, signal, ...rest } = {}) => {
      const all = [];
      const seen = new Set();
      let cursor = null;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const out = await req("GET", "/api/session", {
          query: dirQ(directory, { ...rest, limit: String(LIST_PAGE), ...(cursor ? { cursor } : {}) }), // обычный query-фильтр (№1)
          timeoutMs,
          signal,
        });
        const data = unwrapData(out) ?? [];
        if (!Array.isArray(data)) return data;
        for (const s of data) {
          if (s?.id && seen.has(s.id)) continue;
          if (s?.id) seen.add(s.id);
          all.push(toPortalSession(s));
        }
        cursor = out.json?.cursor?.next ?? null;
        if (!data.length || !cursor) break;
      }
      return all;
    },
    createSession: async ({ directory, title, model, agent, timeoutMs, signal, ...rest } = {}) => {
      // папка — в теле location:{directory} (№2); model/agent можно задать сразу
      const out = await req("POST", "/api/session", {
        body: { ...rest, ...(title !== undefined ? { title } : {}), ...(model ? { model } : {}), ...(agent ? { agent } : {}), location: { directory } },
        timeoutMs,
        signal,
      });
      return toPortalSession(unwrapData(out));
    },
    getSession: async (sessionID, { directory, timeoutMs, signal } = {}) =>
      toPortalSession(unwrapData(await req("GET", `/api/session/${enc(sessionID)}`, { timeoutMs, signal }))),
    patchSession: async (sessionID, { directory, title, timeoutMs, signal, ...rest } = {}) => {
      // ответ 204 → подтверждение повторным GET (api-map №4)
      await req("PATCH", `/api/session/${enc(sessionID)}`, { body: { ...rest, ...(title !== undefined ? { title } : {}) }, timeoutMs, signal });
      return toPortalSession(unwrapData(await req("GET", `/api/session/${enc(sessionID)}`, { timeoutMs, signal })));
    },
    deleteSession: async (sessionID, { directory, timeoutMs, signal } = {}) => {
      await req("DELETE", `/api/session/${enc(sessionID)}`, { timeoutMs, signal }); // 204; дочерние удаляются вместе (№5)
      return true;
    },
    // История v2 (tasks 2.4, api-map §4): upstream отдаёт ПЛОСКИЕ сообщения
    // новыми раньше с курсором; портал ждёт {info, parts} старыми раньше и
    // пагинацию limit/before (paginateMessages). ?before ходим по курсорным
    // страницам, пока не соберём before + n записей старше; маркеры (idle,
    // *-switched, …) фильтруются конвертером — в 1.x они были событиями.
    // Неизвестный before — та же ошибка, что у портала (proxy.js:101).
    // v2fix3 (FEAT-16.3, находка Claude на стенде :4174): upstream-страница
    // ?limit=N режется по СЫРЫМ записям, поэтому limit портала обязан считать
    // только ВИДИМЫЕ сообщения — ходим курсором, пока не наберём n видимых
    // (для before — n видимых строго старше), иначе до конца истории. Пустая
    // страница отдаётся порталу только когда видимых сообщений не осталось,
    // и тогда has-more = 0.
    listMessages: async (sessionID, { directory, before, limit, all, timeoutMs, signal } = {}) => {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 500); // PAGE_DEFAULT/PAGE_MAX
      const wantBefore = typeof before === "string" && before.length > 0;
      const whole = Boolean(all) && !wantBefore; // весь список: курсорные страницы до конца
      const recs = []; // новыми раньше, уже в языке 1.x
      let cursor = null;
      for (let pageIx = 0; pageIx < 1000; pageIx++) { // страховка от кривого курсора
        // BUG-191: upstream 2.2.6 принимает limit ≤ 200 (иначе 400 InvalidRequestError),
        // контракт портала — до 500: страница upstream ≤ 200, остальное добираем курсором.
        const out = await req("GET", `/api/session/${enc(sessionID)}/message`, {
          query: qs({ limit: String(Math.min(n, MSG_PAGE_MAX)), ...(cursor ? { cursor } : {}) }),
          timeoutMs,
          signal,
        });
        const data = unwrapData(out);
        if (!Array.isArray(data)) throw new OcError(`listMessages: upstream вернул не список (${api})`, { status: 0 });
        for (const m of data) {
          const rec = toPortalMessage(m, sessionID);
          if (rec) recs.push(rec);
        }
        cursor = out.json?.cursor?.next ?? null;
        if (whole) {
          if (!cursor) break; // прошли до конца
          continue;
        }
        const idx = wantBefore ? recs.findIndex((m) => m.info.id === before) : -1;
        const enough = wantBefore ? idx >= 0 && recs.length - idx - 1 >= n : recs.length >= n;
        if (enough || !cursor) break;
      }
      const oldestFirst = recs.slice().reverse();
      if (whole) return { messages: oldestFirst, hasMore: false, nextBefore: null }; // прошли до конца — весь список
      let end = oldestFirst.length;
      if (wantBefore) {
        end = oldestFirst.findIndex((m) => m.info.id === before);
        if (end < 0) throw new OcError("listMessages: unknown before cursor", { status: 400, body: { error: "unknown before cursor" } });
      }
      const start = Math.max(0, end - n);
      const messages = oldestFirst.slice(start, end);
      // «есть ещё старшие»: страница не дошла до начала собранного ИЛИ upstream
      // обещает продолжение курсором (консервативно; пустая следующая страница
      // вернёт hasMore:false и nextBefore:null — цикл клиента завершится).
      const hasMore = start > 0 || cursor !== null;
      return { messages, hasMore, nextBefore: hasMore && messages.length ? messages[0].info.id : null };
    },
    prompt: async ({ directory, sessionID, parts, metadata, delivery, model, agent, variant, system, resume, id, timeoutMs, signal, ...rest } = {}) => {
      // №7: тело {text, files, metadata}; model/agent/variant — отдельными вызовами (§5),
      // system — prompt.metadata + плагин-мост (§5.3). metadata — только объект (null → 400, Э1).
      if (model || agent || variant) throw notImplemented("prompt: привязка model/agent/variant — POST /model, /agent и per-session очередь", "tasks 3.5");
      if (system) throw notImplemented("prompt: system — metadata.system + плагин-мост (вариант A Э9)", "tasks 4.4");
      const list = Array.isArray(parts) ? parts : [];
      // BUG-193: synthetic-части (голосовая подсказка FEAT-06.2) — НЕ в видимом тексте
      // хода: в v2 текст хода и есть сообщение пользователя. Они уходят в
      // metadata.zaiHidden; модель их видит через плагин (hooks.hiddenSplice),
      // история возвращает их скрытой synthetic-частью (toPortalMessage).
      const isText = (p) => p?.type === "text" && typeof p.text === "string";
      const text = list.filter((p) => isText(p) && !p.synthetic).map((p) => p.text).join("\n\n");
      const hidden = list.filter((p) => isText(p) && p.synthetic && p.text).map((p) => p.text).join("\n\n");
      const meta = hidden ? { ...(metadata && typeof metadata === "object" ? metadata : {}), [HIDDEN_KEY]: hidden } : metadata;
      // v2fix3 (vision 0/2 на стенде :4174): форма вложений 2.2.6 —
      // PromptInput.FileAttachment {uri (обязателен), name?, description?, source?}
      // (schema/prompt-input.ts; приложение opencode шлёт {uri: data:URL, name}).
      // mime в теле НЕТ — upstream синтезирует его из data: URL. Часть 1.x несёт
      // url+filename+mime: url→uri (data:/file:/http(s) — как есть), голый
      // абсолютный путь → file:// URI (вложения .zai-uploads, BUG-140/163),
      // filename→name. Часть без источника uri не шлётся вовсе: upstream
      // отвечает 400 "Missing key at files[i].uri" на неполное вложение.
      const fileUri = (p) => {
        const raw = typeof p.url === "string" && p.url ? p.url : typeof p.uri === "string" && p.uri ? p.uri : "";
        if (!raw) return null;
        if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) return pathToFileURL(raw).href; // Windows-путь (в т.ч. UNC)
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw; // готовый URI: data:, file:, http(s):
        if (raw.startsWith("/")) return pathToFileURL(raw).href; // POSIX-абсолютный путь
        return null; // относительный путь: upstream cwd не наш — не выдумываем
      };
      const files = list
        .filter((p) => p?.type === "file" && p && typeof p === "object")
        .map((p) => {
          const uri = fileUri(p);
          if (!uri) return null;
          const name = typeof p.filename === "string" && p.filename ? p.filename : typeof p.name === "string" && p.name ? p.name : undefined;
          return { uri, ...(name !== undefined ? { name } : {}) };
        })
        .filter(Boolean);
      const body = {
        text,
        ...(files.length ? { files } : {}),
        ...(meta && typeof meta === "object" ? { metadata: meta } : {}),
        ...(delivery ? { delivery } : {}),
        ...(resume !== undefined ? { resume } : {}),
        ...(id ? { id } : {}),
        ...rest,
      };
      await commitStagedRevert(sessionID, { timeoutMs, signal }); // BUG-206
      return unwrapData(await req("POST", `/api/session/${enc(sessionID)}/prompt`, { body, timeoutMs, signal }));
    },
    abort: async (sessionID, { directory, resume, timeoutMs, signal } = {}) => {
      // №8: имя другое — interrupt; ответ {interrupted:true}
      return (await req("POST", `/api/session/${enc(sessionID)}/interrupt`, { query: resume ? qs({ resume }) : "", timeoutMs, signal })).json;
    },
    // №9: глобальная карта без location. TASK-16.7: тип v2 «running» → «busy» языка 1.x —
    // иначе /zai/api/status отдавал «running», и проверка тихого окна в скриптах выката
    // (RealBusy: type === "busy") не видела идущий ход.
    busyMap: async ({ timeoutMs, signal } = {}) => {
      const map = unwrapData(await req("GET", "/api/session/active", { timeoutMs, signal })) ?? {};
      const out = {};
      for (const [sid, s] of Object.entries(map)) out[sid] = obj(s) && s.type === "running" ? { ...s, type: "busy" } : s;
      return out;
    },
    sessionDiff: async (sessionID, { directory, messageID, to, context, timeoutMs, signal } = {}) => {
      // №10: messageID → ?from= (живьём не проверялся — фиксируется тестом)
      return (unwrapData(await req("GET", `/api/session/${enc(sessionID)}/diff`, { query: qs({ from: messageID, to, context }), timeoutMs, signal }))) ?? [];
    },
    revert: async (sessionID, { directory, messageID, files, timeoutMs, signal } = {}) => {
      // №11: двухфазный. BUG-206: только stage — как revert 1.x, откат можно
      // «Вернуть» (DELETE /revert) до следующего хода; commit делает prompt/команда
      // перед отправкой (commitStagedRevert). Раньше commit шёл сразу → «Вернуть» 409.
      return unwrapData(await req("POST", `/api/session/${enc(sessionID)}/revert/stage`, { body: { messageID, ...(files !== undefined ? { files } : {}) }, timeoutMs, signal }));
    },
    unrevert: async (sessionID, { directory, timeoutMs, signal } = {}) => {
      await req("DELETE", `/api/session/${enc(sessionID)}/revert`, { timeoutMs, signal }); // №12: DELETE вместо POST
      return true;
    },
    // SSE v2: ОДНО глобальное соединение /api/event (все папки сразу, фильтр
    // по directory делает хаб), переписыватель v2 → язык 1.x (design §2).
    // Обрыв → реконнект с паузой backoffMs и gap zai.resync (Last-Event-ID
    // у v2 нет). Управление — signal/close(), таймаута нет.
    events: ({ onEvent, signal, backoffMs, throttleMs, dirOf, stableMs } = {}) =>
      sseLoop({
        url: `${root}/api/event`,
        headers: authHeader ? { authorization: authHeader } : {},
        fetchImpl,
        onEvent,
        signal,
        backoffMs,
        stableMs, // BUG-214
        rewrite: createV2Rewriter({ emit: onEvent, throttleMs, dirOf }),
      }),
    listPermissions: async ({ directory, timeoutMs, signal } = {}) =>
      ((unwrapData(await req("GET", "/api/permission/request", { query: locQ(directory), timeoutMs, signal }))) ?? []).map(toPortalPermission), // BUG-205
    replyPermission: async ({ directory, sessionID, requestID, reply, message, timeoutMs, signal } = {}) => {
      // №16: в пути нужен sessionID, тело {decision}
      await req("POST", `/api/session/${enc(sessionID)}/permission/${enc(requestID)}/reply`, { body: { decision: reply, ...(message ? { message } : {}) }, timeoutMs, signal });
      return true;
    },
    // Вопросы v2 — формы (Э5). Список Form.Info как есть — kind/directory
    // добавит хаб. Ответ — строго {answer:{поле: значение}}: плоская строка
    // даёт 400 на живом v2, отказываем ДО похода. Reject — DELETE ?message=
    // (дефолт-автоответ хаба).
    listQuestions: async ({ directory, timeoutMs, signal } = {}) =>
      ((unwrapData(await req("GET", "/api/form", { query: locQ(directory), timeoutMs, signal }))) ?? []).map(toPortalQuestion), // BUG-203
    replyQuestion: async ({ directory, sessionID, formID, requestID, answer, answers, message, timeoutMs, signal } = {}) => {
      const fid = formID ?? requestID; // hub передаёт requestID — та же форма вопроса
      // BUG-204: клиент 1.x шлёт answers: string[][] (по вопросу — выбранные
      // варианты). v2 ждёт {answer:{ключ поля: значение}} — раскладываем по полям
      // формы (string[] — массив, иначе первая строка); формы нет — q0..qN.
      const arr = Array.isArray(answers) ? answers : Array.isArray(answer) ? answer : null;
      if (arr) {
        let fields = [];
        try {
          const forms = (unwrapData(await req("GET", "/api/form", { query: locQ(directory), timeoutMs, signal }))) ?? [];
          fields = (forms.find((f) => f?.id === fid)?.fields ?? []).filter(obj);
        } catch (err) {
          // TASK-16.31 (SRV-35): форму прочитать не удалось — не отвечаем с
          // выдуманными ключами q0..qN (движок принял бы мусор или отверг ответ
          // молча); ошибка наружу, вопрос остаётся открытым для повтора.
          throw new OcError(`replyQuestion: форма вопроса недоступна (${err?.message ?? err})`, { status: 502, body: { error: "question form unavailable" } });
        }
        answer = {};
        arr.forEach((a, i) => {
          const fl = fields[i];
          const vals = (Array.isArray(a) ? a : [a]).filter((v) => v !== undefined && v !== null).map(String);
          answer[fl?.key ?? fl?.id ?? `q${i}`] = fl?.type === "string[]" ? vals : (vals[0] ?? "");
        });
      }
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
        throw new OcError("replyQuestion: answer должен быть объектом {поле: значение} (Э5: плоская строка даёт 400 на v2)", { status: 400, body: { error: "answer must be an object" } });
      }
      await req("POST", `/api/session/${enc(sessionID)}/form/${enc(fid)}/reply`, { body: { answer, ...(message ? { message } : {}) }, timeoutMs, signal });
      return true;
    },
    rejectQuestion: async ({ directory, sessionID, formID, requestID, message, timeoutMs, signal } = {}) => {
      const fid = formID ?? requestID; // как в replyQuestion — hub кладёт requestID
      await req("DELETE", `/api/session/${enc(sessionID)}/form/${enc(fid)}`, { query: message ? qs({ message }) : "", timeoutMs, signal });
      return true;
    },
    disposeInstance: async ({ directory, timeoutMs, signal } = {}) => {
      // №19: DELETE /api/debug/location — путь под /debug, пинн версии (§6).
      // BUG-195: ключ экземпляра 2.2.6 — точная строка пути (живьём: «C:\…» не
      // освобождал экземпляр, поднятый по «C:/…» из истории). Шлём обе формы.
      const forms = directory == null ? [directory] : [...new Set([String(directory), String(directory).replace(/\\/g, "/"), String(directory).replace(/\//g, "\\")])];
      let lastErr = null;
      let ok = 0;
      for (const d of forms) {
        try {
          await req("DELETE", "/api/debug/location", { query: locQ(d), timeoutMs, signal });
          ok++;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!ok && lastErr) throw lastErr;
      return true;
    },
    mcpStatus: async ({ directory, timeoutMs, signal } = {}) => {
      // №20: массив v2 → карта 1.x {name: {status}} (вложенный объект, не строка)
      const list = (unwrapData(await req("GET", "/api/mcp", { query: locQ(directory), timeoutMs, signal }))) ?? [];
      const map = {};
      for (const s of list) {
        if (!s?.name) continue;
        // BUG-192: живой 2.2.6 — status: {status: "connected" | "failed" | …, error?};
        // портал (mcpView, политика тенанта) ждёт строку статуса и error рядом, как в 1.x
        const st = s.status && typeof s.status === "object" ? s.status : { status: s.status };
        const error = s.error ?? st.error;
        map[s.name] = { status: st.status, ...(error ? { error } : {}), ...(s.title ? { title: s.title } : {}) };
      }
      return map;
    },
    listAgents: async ({ timeoutMs, signal } = {}) => (unwrapData(await req("GET", "/api/agent", { timeoutMs, signal }))) ?? [], // №21: mode/hidden/permissions для policy-фильтров
    listProviders: async ({ directory, timeoutMs, signal } = {}) => {
      // №22: синтез {all, default, connected}; подключённость — через activation (credentials)
      const prov = await req("GET", "/api/provider", { query: locQ(directory), timeoutMs, signal });
      const modelsOut = await req("GET", "/api/model", { query: locQ(directory), timeoutMs, signal }); // пара провайдера (api-map №22/№24)
      const all = unwrapData(prov) ?? [];
      // v2fix2: Provider.Info v2 моделей не несёт (OpenAPI 2.2.6, additionalProperties:false),
      // они плоским списком /api/model с providerID. Тело и так читается (пара
      // держит instance) — раскладываем его в карты models элементов all без
      // models: форма ближе к 1.x для потребителей портала (normalizeProviders,
      // modelInCatalog, modelAcceptsImages). Элементы с картой не трогаем.
      const flat = unwrapData(modelsOut) ?? (Array.isArray(modelsOut?.json) ? modelsOut.json : null);
      if (Array.isArray(flat)) {
        const byProvider = new Map();
        for (const m of flat) {
          if (!m || typeof m.id !== "string" || typeof m.providerID !== "string") continue;
          if (!byProvider.has(m.providerID)) byProvider.set(m.providerID, {});
          byProvider.get(m.providerID)[m.id] = m;
        }
        for (let i = 0; i < all.length; i++) {
          const p = all[i];
          if (p && typeof p === "object" && !p.models && byProvider.has(p.id)) all[i] = { ...p, models: byProvider.get(p.id) };
        }
      }
      return { all, default: null, connected: all.filter((p) => p?.activation !== "disabled").map((p) => p.id) };
    },
    configGet: async ({ directory, timeoutMs, signal } = {}) => {
      // №23: слоёный конфиг + /api/model/default (Э1, Э3) → {default_agent, model, snapshot}
      const [docs, def] = await Promise.all([
        req("GET", "/api/config", { query: locQ(directory), timeoutMs, signal }),
        req("GET", "/api/model/default", { query: locQ(directory), timeoutMs, signal }),
      ]);
      const out = {};
      let snapshots;
      for (const doc of Array.isArray(docs.json) ? docs.json : []) {
        const info = doc?.info;
        if (!info || typeof info !== "object") continue;
        if (typeof info.default_agent === "string" && info.default_agent) out.default_agent = info.default_agent;
        if (info.snapshots !== undefined) snapshots = info.snapshots;
      }
      if (snapshots !== undefined) out.snapshot = snapshots !== false;
      const m = unwrapData(def);
      if (m && typeof m === "object") out.model = { providerID: m.providerID, id: m.id ?? m.modelID, ...(m.variant ? { variant: m.variant } : {}) };
      return out;
    },
    warmup: makeWarmup(() => "/api/mcp", locQ),
    listProjects: async ({ timeoutMs, signal } = {}) => (await req("GET", "/api/project", { timeoutMs, signal })).json ?? [], // №25: голый массив; фильтр по canonical — портал
    healthInfo: async ({ timeoutMs, signal } = {}) => (await req("GET", "/api/info", { timeoutMs, signal })).json, // №26
    setSessionModel: async (sessionID, { model, timeoutMs, signal } = {}) => {
      // v2-only (§5): {model: {providerID, id, variant}} → 204; per-session очередь — tasks 3.5
      const m = model && typeof model === "object"
        ? { providerID: model.providerID, id: model.id ?? model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
        : model;
      await req("POST", `/api/session/${enc(sessionID)}/model`, { body: { model: m }, timeoutMs, signal });
      return true;
    },
    setSessionAgent: async (sessionID, { agent, timeoutMs, signal } = {}) => {
      await req("POST", `/api/session/${enc(sessionID)}/agent`, { body: { agent }, timeoutMs, signal }); // v2-only, живьём не проверено — тест
      return true;
    },
  };

  // Слэш-команды v2 (№27, живьём :4100 — api-map «Команды»). Список —
  // обычный instance-маршрут с deepObject-location, конверт {location, data}
  // → голый массив записей {name, description} (форма 1.x). Выполнение —
  // POST /api/session/:id/command {name, text} → 204 СРАЗУ (16–31 мс),
  // execution в фоне: НЕ синхронный ход v1. Тело 1.x {command, arguments}
  // переводится в {name, text}; agent/model/variant из тела v2 НЕ принимает —
  // привязку хода задаёт сама команда (frontmatter/commands-map) или модель
  // сессии (POST /model — живьём даёт model-switched и модель в ходе).
  const v2x = {
    listCommands: async ({ directory, timeoutMs, signal } = {}) =>
      (unwrapData(await req("GET", "/api/command", { query: locQ(directory), timeoutMs, signal }))) ?? [],
    runCommand: async (sessionID, { directory, body, timeoutMs, signal } = {}) => {
      const b = body && typeof body === "object" ? body : {};
      const name = typeof b.name === "string" && b.name ? b.name : b.command;
      if (typeof name !== "string" || !name) {
        throw new OcError("runCommand: body.command (имя команды) обязателен", { status: 400, body: { error: "missing command" } });
      }
      const text = typeof b.text === "string" ? b.text : typeof b.arguments === "string" ? b.arguments : "";
      const v2body = {
        name,
        text,
        ...(Array.isArray(b.files) ? { files: b.files } : {}),
        ...(Array.isArray(b.agents) ? { agents: b.agents } : {}),
        ...(Array.isArray(b.skills) ? { skills: b.skills } : {}),
        ...(b.delivery ? { delivery: b.delivery } : {}),
      };
      await commitStagedRevert(sessionID, { timeoutMs, signal }); // BUG-206
      return reqStatus("POST", `/api/session/${enc(sessionID)}/command`, { body: v2body, timeoutMs, signal });
    },
  };

  // plugin.list (GET /api/plugin; OpenAPI 2.2.6: «Retrieve enabled server
  // plugins and their current status») — вне интерфейса design §1.2, как
  // команды. НЕEnumerable. Ответ возвращается СЫРЫМ ({status, json, text}):
  // гейт сервера (server.js, защита «закрыто при отказе») ищет id плагина
  // в тексте тела — форму ответа не нормализуем. У 1.x метода нет (v2Only).
  const v2p = {
    pluginList: async ({ directory, timeoutMs, signal } = {}) =>
      req("GET", "/api/plugin", { query: locQ(directory), timeoutMs, signal }),
  };

  const client = withDefaultTimeouts({ ...(v2 ? v2t : v1t) });
  // Слэш-команды (BUG-188, №27): есть у ОБЕИХ транспортов (v2 — api-map
  // «Команды», живьём :4100), но вне интерфейса design §1.2 — не enumerable,
  // счёт методов остаётся 28. Дефолтные таймауты — из той же таблицы.
  const x = withDefaultTimeouts(v2 ? v2x : v1x);
  for (const [name, fn] of Object.entries(x)) {
    Object.defineProperty(client, name, { enumerable: false, value: fn });
  }
  // pluginList: v2 — сырое тело /api/plugin, v1 — читаемый v2Only-отказ.
  const px = withDefaultTimeouts(v2 ? v2p : v1p);
  for (const [name, fn] of Object.entries(px)) {
    Object.defineProperty(client, name, { enumerable: false, value: fn });
  }
  // Маркер режима для интеграций (hub 3.3: один глобальный SSE-поток и
  // глобальный busyMap — только в v2). Не enumerable: интерфейс клиента
  // остаётся ровно 28 методов.
  Object.defineProperty(client, "api", { value: api, enumerable: false });
  // Per-session очередь «модель → ход» (design §5, tasks 3.5): смена модели
  // (POST /model) обязана ЗАВЕРШИТЬСЯ до старта хода той же сессии, иначе
  // параллельный ход/replay уедет на чужой модели. enqueueTurn(sid, fn)
  // сериализует такие последовательности: fn вызывается строго после
  // завершения предыдущей (ошибка предыдущей очередь не ломает). Не
  // enumerable — интерфейс остаётся 28 методов.
  const turnQueues = new Map(); // sessionID → Promise (хвост очереди)
  Object.defineProperty(
    client,
    "enqueueTurn",
    {
      enumerable: false,
      value: (sessionID, fn) => {
        const prev = turnQueues.get(sessionID) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        turnQueues.set(sessionID, next);
        const settle = () => {
          if (turnQueues.get(sessionID) === next) turnQueues.delete(sessionID);
        };
        next.then(settle, settle);
        return next;
      },
    },
  );
  return client;
}
