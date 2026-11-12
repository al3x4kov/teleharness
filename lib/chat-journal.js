// FEAT-11.18 (шаг Б): журнал чата в базе знаний (Obsidian) — «живая» полная история одного
// чата независимо от движка. Владелец 2026-11-12: «должен жить продуманный флоу сессий мб даже в
// Obsidian в качестве Live RAG и тогда токенов будет улетать не так много, но зато любой агент
// получит максимум инфы при необходимости». Журнал пишет ПОРТАЛ (он видит истории обоих
// движков), по концу каждого хода; агенту в системный промпт идёт одна строка с путём —
// читает он журнал сам и только когда нужно.
//
// Файл: <зона базы знаний>/journal/<дата первого сообщения>-<id чата>.md, рядом с дайджестами
// sessions/ (они короткие и остаются). Формат — обычный markdown: запрос, действия одной
// строкой каждое (без вывода инструментов), ответ, изменённые файлы, отметки передачи.
// Zero deps.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const JOURNAL_DIR = "journal";
const TOOL_LINES_MAX = 40; // действий на ход в журнале; остальное — «и ещё N»
const OBJ_MAX = 160;

const pad = (n) => String(n).padStart(2, "0");
const ms = (v) => {
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
function stamp(t) {
  if (t == null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const dayOf = (t) => stamp(t).slice(0, 10);
const oneLine = (s, n = OBJ_MAX) => {
  const v = String(s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};

const textsOf = (m) => (m?.parts ?? []).filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim()).map((p) => p.text.trim());

function toolLine(p) {
  const i = p?.state?.input ?? {};
  const obj = i.filePath ?? i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? "";
  const st = p?.state?.status === "error" ? " — ошибка" : "";
  return `- ${String(p?.tool ?? "инструмент")}${obj ? ` \`${oneLine(obj).replace(/`/g, "'")}\`` : ""}${st}`;
}
const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|patch|apply_patch)$/i;
function changedFiles(msgs) {
  const out = [];
  const seen = new Set();
  for (const m of msgs) {
    for (const p of m?.parts ?? []) {
      if (p?.type !== "tool" || !WRITE_TOOLS.test(String(p.tool ?? "")) || p.state?.status !== "completed") continue;
      const f = p.state.input?.filePath ?? p.state.input?.file_path ?? p.state.input?.path;
      if (typeof f !== "string" || !f) continue;
      const k = f.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(f);
      }
    }
  }
  return out;
}
const modelOf = (m) => m?.info?.modelID ?? m?.info?.model?.modelID ?? null;

// Чистая: история чата → текст журнала. messages — как отдаёт портал (info + parts),
// в хронологическом порядке; relays — [{at, from:{engine,model}, to:{engine,model}}].
export function renderJournal({ id, title = "", dir = "", messages = [], relays = [], now = Date.now() } = {}) {
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => (ms(a?.info?.time?.created) ?? 0) - (ms(b?.info?.time?.created) ?? 0));
  const turns = [];
  for (const m of list) {
    const role = m?.info?.role;
    if (role === "user") {
      const texts = textsOf(m);
      if (texts.length === 0) continue; // служебные сообщения (скрытые подсказки) — не ход
      turns.push({ at: ms(m.info?.time?.created), ask: texts.join("\n\n"), steps: [] });
    } else if (role === "assistant") {
      if (turns.length === 0) turns.push({ at: ms(m.info?.time?.created), ask: "", steps: [] });
      turns[turns.length - 1].steps.push(m);
    }
  }
  const models = [...new Set(list.map(modelOf).filter(Boolean))];
  const out = [
    "---",
    `chat: ${id ?? ""}`,
    `title: ${JSON.stringify(oneLine(title, 200))}`,
    `folder: ${JSON.stringify(String(dir ?? ""))}`,
    `models: ${JSON.stringify(models)}`,
    `turns: ${turns.length}`,
    `updated: ${stamp(now)}`,
    "---",
    "",
    `# Журнал чата: ${oneLine(title, 200) || id || ""}`,
    "",
    "Полная история чата: запросы, действия агента и ответы по порядку. Ведётся порталом автоматически после каждого хода; вручную не править.",
    "",
  ];
  const marks = (Array.isArray(relays) ? relays : []).map((r) => ({ ...r, at: ms(r?.at) })).filter((r) => r.at != null).sort((a, b) => a.at - b.at);
  let mi = 0;
  const flushMarks = (until) => {
    while (mi < marks.length && marks[mi].at <= until) {
      const r = marks[mi++];
      out.push(`> **Передача** · ${stamp(r.at)} · ${r.from?.model ?? r.from?.engine ?? "?"} → ${r.to?.model ?? r.to?.engine ?? "?"}`, "");
    }
  };
  turns.forEach((t, k) => {
    flushMarks(t.at ?? 0);
    const model = [...new Set(t.steps.map(modelOf).filter(Boolean))].join(", ");
    out.push(`## Ход ${k + 1}${t.at ? ` · ${stamp(t.at)}` : ""}${model ? ` · ${model}` : ""}`, "");
    if (t.ask) out.push("**Запрос**", "", t.ask, "");
    const tools = t.steps.flatMap((m) => (m.parts ?? []).filter((p) => p?.type === "tool"));
    if (tools.length > 0) {
      out.push("**Действия**", "", ...tools.slice(0, TOOL_LINES_MAX).map(toolLine));
      if (tools.length > TOOL_LINES_MAX) out.push(`- …и ещё ${tools.length - TOOL_LINES_MAX}`);
      out.push("");
    }
    const answer = t.steps.flatMap(textsOf);
    if (answer.length > 0) out.push("**Ответ**", "", answer.join("\n\n"), "");
    const err = t.steps.map((m) => m?.info?.error).find(Boolean);
    if (err) out.push(`**Ход оборвался:** ${oneLine(err?.data?.message ?? err?.message ?? err?.name ?? "ошибка", 300)}`, "");
    const files = changedFiles(t.steps);
    if (files.length > 0) out.push("**Изменённые файлы**", "", ...files.map((f) => `- \`${f}\``), "");
  });
  flushMarks(Infinity);
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n"), turns: turns.length, firstAt: turns[0]?.at ?? ms(list[0]?.info?.time?.created) ?? null };
}

// Существующий журнал чата в зоне (по суффиксу -<id>.md) или null.
export function findJournal(zoneRoot, id) {
  if (!zoneRoot || !id) return null;
  const dir = path.join(zoneRoot, JOURNAL_DIR);
  try {
    const hit = readdirSync(dir).find((n) => n.endsWith(`-${id}.md`));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

export function journalFile(zoneRoot, id, firstAt) {
  return findJournal(zoneRoot, id) ?? path.join(zoneRoot, JOURNAL_DIR, `${dayOf(firstAt ?? Date.now())}-${id}.md`);
}

// Атомарная запись (tmp + rename). → путь файла.
export function writeJournal(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
  return file;
}

// Запрос движка на доступ к папке вне чата (external_directory) касается ТОЛЬКО папки журналов
// зоны этого чата? Тогда портал разрешает его сам: иначе пользователь нажимал бы «Разрешить»
// каждый раз, когда агент открывает журнал. Любой другой путь — обычный диалог.
export function isJournalAccess(props, zoneRoot, platform = process.platform) {
  if (!zoneRoot || props?.permission !== "external_directory") return false;
  const patterns = Array.isArray(props.patterns) ? props.patterns.filter((x) => typeof x === "string" && x) : [];
  if (patterns.length === 0) return false;
  const norm = (p) => {
    const v = String(p).replace(/\\/g, "/").replace(/\/\*+$/, "").replace(/\/+$/, "");
    return platform === "win32" ? v.toLowerCase() : v;
  };
  const base = norm(`${String(zoneRoot).replace(/[\\/]+$/, "")}/${JOURNAL_DIR}`);
  return patterns.every((p) => {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return false;
    const n = norm(p);
    return n === base || n.startsWith(base + "/");
  });
}

// Строка системного промпта: агент узнаёт, где журнал, и читает его сам по необходимости.
export function journalRule(file) {
  if (!file) return "";
  return `Журнал этого чата — полная история всех ходов, включая сделанное другим движком или моделью: ${String(file).replace(/\\/g, "/")}. Когда нужен контекст прошлых ходов, которого нет перед тобой, прочитай журнал (можно частями или поиском по нему). Сам журнал не редактируй и целиком не пересказывай.`;
}

// Писатель: по концу хода (session.idle из потока событий хаба) — пересборка журнала чата
// с задержкой debounceMs. resolve(sid) → {zoneRoot, title, dir, messages, relays} | null.
export class JournalWriter {
  #resolve;
  #debounce;
  #log;
  #timers = new Map();
  #tries = new Map(); // sid → число повторов (чат ещё не виден порталу)
  #files = new Map(); // sid → путь журнала (для строки системного промпта)
  constructor({ resolve, debounceMs = 3000, log = () => {} }) {
    this.#resolve = resolve;
    this.#debounce = debounceMs;
    this.#log = log;
  }

  // Событие хаба (строка JSON): интересен только конец хода.
  note(data) {
    if (process.env.ZAI_JOURNAL_DEBUG && typeof data !== "string") this.#log(`[zai/journal] событие не строкой: ${typeof data}`);
    if (typeof data !== "string" || !data.includes('"session.idle"')) return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const sid = evt?.type === "session.idle" ? evt.properties?.sessionID : null;
    if (typeof sid === "string" && sid) {
      if (process.env.ZAI_JOURNAL_DEBUG) this.#log(`[zai/journal] ${sid}: конец хода — запись через ${this.#debounce} мс`);
      this.schedule(sid);
    }
  }

  schedule(sid) {
    clearTimeout(this.#timers.get(sid));
    const t = setTimeout(() => {
      this.#timers.delete(sid);
      this.flush(sid).catch((err) => this.#log(`[zai/journal] ${sid}: ${err?.message ?? err}`));
    }, this.#debounce);
    t.unref?.();
    this.#timers.set(sid, t);
  }

  // Пересобрать журнал сейчас. → путь файла или null (нет зоны, дочерняя сессия, пусто).
  async flush(sid) {
    const src = await this.#resolve(sid);
    const dbg = process.env.ZAI_JOURNAL_DEBUG ? (m) => this.#log(`[zai/journal] ${sid}: ${m}`) : () => {};
    // Только что созданный чат портал может ещё не знать (индекс сессий обновляется не сразу):
    // до трёх повторов с растущей паузой, иначе журнал первого хода терялся молча.
    if (src?.retry) {
      const n = (this.#tries.get(sid) ?? 0) + 1;
      if (n <= 3) {
        this.#tries.set(sid, n);
        dbg(`чат ещё не виден — повтор ${n}`);
        const t = setTimeout(() => {
          this.#timers.delete(sid);
          this.flush(sid).catch((err) => this.#log(`[zai/journal] ${sid}: ${err?.message ?? err}`));
        }, this.#debounce * (n + 1));
        t.unref?.();
        this.#timers.set(sid, t);
      } else this.#tries.delete(sid);
      return null;
    }
    this.#tries.delete(sid);
    if (!src?.zoneRoot) { dbg(`пропуск: ${src ? "нет зоны" : "resolve=null"}`); return null; }
    const r = renderJournal({ id: sid, title: src.title, dir: src.dir, messages: src.messages, relays: src.relays });
    if (r.turns === 0) { dbg(`пропуск: 0 ходов из ${src.messages?.length ?? 0} сообщений`); return null; }
    const file = journalFile(src.zoneRoot, sid, r.firstAt);
    writeJournal(file, r.text);
    dbg(`записан: ходов ${r.turns}, сообщений ${src.messages?.length ?? 0}, символов ${r.text.length}`);
    this.#files.set(sid, file);
    return file;
  }

  // Путь журнала чата, если он уже есть (для строки системного промпта). zoneRoot — чтобы
  // найти журнал, написанный до рестарта портала.
  fileOf(sid, zoneRoot = null) {
    const known = this.#files.get(sid);
    if (known && existsSync(known)) return known;
    const found = zoneRoot ? findJournal(zoneRoot, sid) : null;
    if (found) this.#files.set(sid, found);
    return found;
  }

  forget(sid) {
    clearTimeout(this.#timers.get(sid));
    this.#timers.delete(sid);
    this.#files.delete(sid);
    this.#tries.delete(sid);
  }
}
