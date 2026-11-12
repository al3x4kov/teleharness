// FEAT-11.18 (шаг В): Relay — чат продолжается на другом движке или модели. Тот же чат, та же
// папка; история прежнего движка новому недоступна напрямую — она в журнале чата
// (lib/chat-journal.js), о чём новому движку говорит строка системного промпта.
// Здесь: проверка запроса передачи (чистая), хранилище отметок передачи и тексты.
// Zero deps.
import { cleanModel, makeBinding } from "./binding.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

const MARKS_MAX = 50; // отметок на чат; старые вытесняются

// Чистая: можно ли передать чат и какой станет привязка.
//   current — нынешняя привязка чата (или null), target — {model, agent?},
//   busy — идёт ход, claudeAgentOk — проверка агента Claude.
// → {status, error} | {binding, changed: "engine" | "model"}
export function planRelay({ current, target, busy = false, claudeAgentOk = () => false } = {}) {
  if (busy) return { status: 409, error: "turn is running" };
  const model = cleanModel(target?.model);
  if (!model) return { status: 400, error: "bad model" };
  if (target?.agent != null && typeof target.agent !== "string") return { status: 400, error: "bad agent" };
  // Агент прежнего движка в новый не переносится; свой можно назвать явно.
  const binding = makeBinding({ model, agent: target?.agent ?? null }, { prompted: true, claudeAgentOk });
  if (!binding) return { status: 400, error: "bad model" };
  if (!current) return { status: 409, error: "chat has no turns yet" };
  const sameEngine = current.engine === binding.engine;
  const sameModel = sameEngine && current.model?.providerID === model.providerID && current.model?.modelID === model.modelID;
  if (sameModel) return { status: 400, error: "same engine and model" };
  // В пределах одного движка агент остаётся прежним, если новый не назван.
  if (sameEngine && target?.agent === undefined) binding.agent = current.agent ?? null;
  return { binding, changed: sameEngine ? "model" : "engine" };
}

const face = (b) => ({ engine: b?.engine ?? null, providerID: b?.model?.providerID ?? null, modelID: b?.model?.modelID ?? null });

// Отметка передачи для ленты и журнала.
export function relayMark(from, to, { at = Date.now(), reason = null } = {}) {
  return { at, from: face(from), to: face(to), ...(reason ? { reason: String(reason).slice(0, 40) } : {}) };
}

// Отметки в виде, понятном журналу (lib/chat-journal.js): model — читаемое имя.
export function marksForJournal(marks) {
  return (marks ?? []).map((m) => ({ at: m.at, from: { engine: m.from?.engine, model: m.from?.modelID }, to: { engine: m.to?.engine, model: m.to?.modelID } }));
}

// Строка системного промпта после передачи: новый движок не видит прежних ходов сам.
export function relayRule(marks, journalFile) {
  const last = (marks ?? []).at(-1);
  if (!last) return "";
  const where = journalFile ? ` Она записана в журнале чата: ${String(journalFile).replace(/\\/g, "/")}.` : "";
  return (
    `Этот чат передан тебе от другого движка или модели (${last.from?.modelID ?? last.from?.engine ?? "?"} → ${last.to?.modelID ?? last.to?.engine ?? "?"}): ` +
    `часть прежних ходов выполнял другой агент, и в твоей собственной истории их нет.${where} ` +
    "Прежде чем продолжать работу или отвечать на вопрос о сделанном ранее, прочитай журнал: последний запрос пользователя, что уже сделано, какие файлы изменены. " +
    "Не начинай задачу заново и не переспрашивай то, что есть в журнале." +
    returnNote(marks)
  );
}

// BUG-232: движок, который уже вёл этот чат и получил его обратно, видит свою историю и считает её полной.
// Называем промежуток, который вёл другой движок, — иначе он отвечает по памяти, не открывая журнал.
const mskTime = (at) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
function returnNote(marks) {
  const engine = marks.at(-1)?.to?.engine;
  if (!engine) return "";
  // последний вход в этот движок извне (смена модели внутри движка историю не рвёт)
  const i = marks.findLastIndex((m) => m?.to?.engine === engine && m?.from?.engine !== engine);
  const last = marks[i];
  const left = i > 0 ? marks.slice(0, i).findLast((m) => m?.from?.engine === engine && m?.to?.engine !== engine) : null;
  if (!last || !left) return "";
  return (
    ` Ты уже вёл этот чат раньше, но с ${mskTime(left.at)} до ${mskTime(last.at)} (МСК) его вёл другой движок: твоя история неполна — ` +
    "ходов за этот промежуток в ней нет, а номера и порядок сообщений в ней не совпадают с настоящими. Полная последовательность — только в журнале; сверяйся с ним, а не с памятью."
  );
}

// ── BUG-232: пропущенные ходы вкладываются в запрос ─────────────────────────
// Указание «прочитай журнал» модель соблюдает через раз (прод 1.19.1: 5 из 10 после возврата на
// прежний движок): своя связная история для неё убедительнее строки системного промпта. Поэтому
// ходы, которых у движка нет, портал сам вкладывает в первый запрос после передачи — скрытой
// (synthetic) частью, дословно, с потолком объёма; что не поместилось — названо явно и лежит в журнале.
export const RELAY_CATCHUP_MARK = "<system-reminder>\nПередача чата: ходы, сделанные в другом движке";
export const CATCHUP_LIMIT = 8000; // знаков на вложение; свежие ходы — целиком

const createdOf = (m) => Number(m?.info?.time?.created ?? 0);
const plainText = (m) => (m?.parts ?? []).filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim()).map((p) => p.text.trim()).join("\n");

// Чистая: сообщения другого движка, которых нынешний не видел, — новее его последнего сообщения.
// Своя история пуста → все. После первого же своего хода результат пуст: вложение разовое само собой.
export function missedTurns(own, other) {
  const last = Math.max(0, ...(Array.isArray(own) ? own : []).map(createdOf));
  return (Array.isArray(other) ? other : []).filter((m) => createdOf(m) > last).sort((a, b) => createdOf(a) - createdOf(b));
}

const FILE_TOOL = /write|edit|patch/i;
function changedFiles(messages) {
  const out = new Set();
  for (const m of messages) {
    for (const p of m?.parts ?? []) {
      if (p?.type !== "tool" || !FILE_TOOL.test(String(p.tool ?? ""))) continue;
      const f = p.state?.input?.filePath ?? p.state?.input?.file_path ?? p.state?.input?.path;
      if (typeof f === "string" && f.trim()) out.add(f.trim().replace(/\\/g, "/"));
    }
  }
  return [...out].slice(0, 20);
}

function squeeze(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[…сокращено ${text.length - max} знаков; полностью — в журнале…]\n${text.slice(-tail)}`;
}

// Чистая: скрытая часть запроса с пропущенными ходами (или null, если вкладывать нечего).
export function catchUpPart(missed, { journalFile = null, limit = CATCHUP_LIMIT } = {}) {
  const all = Array.isArray(missed) ? missed : [];
  const lines = [];
  for (const m of all) {
    const text = plainText(m);
    if (!text) continue;
    const who = m.info?.role === "user" ? "Пользователь" : `Агент (${m.info?.modelID ?? m.info?.model?.modelID ?? "другой движок"})`;
    lines.push(`[${mskTime(createdOf(m))} МСК] ${who}: ${squeeze(text, Math.max(400, Math.floor(limit / 2)))}`);
  }
  if (!lines.length) return null;
  const shown = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (shown.length && size + lines[i].length > limit) break;
    shown.unshift(lines[i]);
    size += lines[i].length;
  }
  const cut = lines.length - shown.length;
  const files = changedFiles(all);
  const journal = journalFile ? String(journalFile).replace(/\\/g, "/") : null;
  const text = [
    `${RELAY_CATCHUP_MARK}, пока этот чат вёл не ты. Этих ходов нет в твоей истории — считай их частью разговора: по времени они идут сразу перед текущим запросом пользователя.`,
    cut ? `Показаны последние ${shown.length} сообщений из ${lines.length}; более ранние ${cut} — только в журнале.` : "",
    "",
    ...shown,
    "",
    files.length ? `Изменённые файлы: ${files.join(", ")}` : "",
    journal ? `Полная история чата — в журнале: ${journal}` : "",
    "</system-reminder>",
  ].filter((x, i, a) => x !== "" || (i > 0 && a[i - 1] !== ""));
  return { type: "text", synthetic: true, text: text.join("\n") };
}

const isCatchUp = (p) => p?.type === "text" && p.synthetic === true && typeof p.text === "string" && p.text.startsWith(RELAY_CATCHUP_MARK);

// Тело запроса хода (копия) с вложением пропущенных ходов; прежняя или подделанная копия убирается.
export function withCatchUp(body, missed, opts = {}) {
  if (!body || typeof body !== "object" || !Array.isArray(body.parts)) return body;
  const parts = body.parts.filter((p) => !isCatchUp(p));
  const part = catchUpPart(missed, opts);
  if (part) parts.push(part);
  return { ...body, parts };
}

// Истории обоих движков одного чата → одна лента по времени (без повторов по id).
export function mergeFeeds(a, b) {
  const seen = new Set();
  const out = [];
  for (const m of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const id = m?.info?.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(m);
  }
  const created = (m) => Number(m?.info?.time?.created ?? 0);
  return out.sort((x, y) => created(x) - created(y));
}

// Хранилище отметок: data/relays.json — { "<sessionID>": [mark…] }.
export class RelayStore {
  #path;
  #map = new Map();
  constructor(file) {
    this.#path = file ?? null;
    if (!file) return;
    const raw = readJsonStore(file, { fallback: () => ({}) });
    for (const [id, list] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
      if (Array.isArray(list) && list.length) this.#map.set(id, list.filter((m) => m && Number(m.at) > 0));
    }
  }

  get(id) {
    return this.#map.get(id) ?? [];
  }

  has(id) {
    return this.get(id).length > 0;
  }

  add(id, mark) {
    const list = [...this.get(id), mark].slice(-MARKS_MAX);
    this.#map.set(id, list);
    this.#flush();
    return list;
  }

  forget(id) {
    if (this.#map.delete(id)) this.#flush();
  }

  #flush() {
    if (this.#path) writeJsonAtomic(this.#path, Object.fromEntries(this.#map));
  }
}
