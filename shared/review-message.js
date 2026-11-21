// FEAT-20.1: сообщение «Вернуть агенту» — обычный текст пользователя (Markdown),
// одинаково понятный Claude, Codex, opencode и после Relay (design «C»).
// Чистые функции, без зависимостей.
//
// buildReviewMessage({id, revision, comments, general, files, lang}) →
//   {text, count, fileCount, quoteLines, shortened, tooLong}
//   - comments: черновики [{file, oldPath?, side: new|old|file|general, from?, to?, quote:[...], text}];
//   - цитата до 20 строк; если сообщение > 30 000 символов — до 5 строк
//     (shortened), затем без цитат; тексты комментариев не режутся никогда —
//     если и без цитат не помещается, tooLong (сервер отвечает 413);
//   - в конце служебный маркер <!-- teleharness-review:<id>:r<rev> --> (лента рисует
//     пузырь свёрнутым «Ревью · N комментариев к M файлам»).
export const REVIEW_LIMITS = Object.freeze({ message: 30_000, quote: 20, quoteShort: 5, comment: 4000, select: 200, comments: 300 });
export const MARKER_RE = /<!-- teleharness-review:([A-Za-z0-9_-]{1,40}):r(\d{1,4}) -->\s*$/;

export function pluralRu(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const T = {
  ru: {
    head: (n, m) => `Ревью · ${n} ${pluralRu(n, "комментарий", "комментария", "комментариев")}${m ? ` к ${m} ${pluralRu(m, "файлу", "файлам", "файлам")}` : ""}`,
    rev: (r) => `ревизия ${r}`,
    general: "Общий комментарий",
    renamed: (o) => `переименован из ${o}`,
    deleted: "удалён",
    added: "новый",
    line: (a, b) => (a === b ? `Строка ${a}` : `Строки ${a}–${b}`),
    oldLine: (a, b) => (a === b ? `Удалённая строка ${a}` : `Удалённые строки ${a}–${b}`),
    near: "Около строки (номер неизвестен)",
    file: "Файл целиком",
    cut: (n) => `… ещё ${n} ${pluralRu(n, "строка", "строки", "строк")} цитаты`,
    ask: "Исправь по этим комментариям и коротко ответь, что изменил. Если с комментарием не согласен — объясни почему.",
  },
  en: {
    head: (n, m) => `Review · ${n} ${n === 1 ? "comment" : "comments"}${m ? ` on ${m} ${m === 1 ? "file" : "files"}` : ""}`,
    rev: (r) => `revision ${r}`,
    general: "Overall comment",
    renamed: (o) => `renamed from ${o}`,
    deleted: "deleted",
    added: "new",
    line: (a, b) => (a === b ? `Line ${a}` : `Lines ${a}–${b}`),
    oldLine: (a, b) => (a === b ? `Deleted line ${a}` : `Deleted lines ${a}–${b}`),
    near: "Near line (number unknown)",
    file: "Whole file",
    cut: (n) => `… ${n} more quoted ${n === 1 ? "line" : "lines"}`,
    ask: "Fix the code according to these comments and briefly reply what you changed. If you disagree with a comment, explain why.",
  },
};

export const langOf = (l) => (String(l ?? "").toLowerCase().startsWith("en") ? "en" : "ru");

// Подпись строк комментария на языке сообщения.
export function rangeLabel(c, lang = "ru") {
  const t = T[langOf(lang)];
  if (c.side === "file") return t.file;
  const a = Number.isInteger(c.from) ? c.from : null;
  const b = Number.isInteger(c.to) ? c.to : a;
  if (a == null) return t.near;
  return c.side === "old" ? t.oldLine(a, b) : t.line(a, b);
}

function fence(lines) {
  const body = lines.join("\n");
  let f = "```";
  while (body.includes(f)) f += "`";
  return `${f}\n${body}\n${f}`;
}

function render({ id, revision, comments, general, files, lang, quoteMax }) {
  const t = T[lang];
  const lineComments = comments.filter((c) => c.side !== "general" && c.file);
  const byFile = new Map();
  for (const c of lineComments) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  const generals = [general, ...comments.filter((c) => c.side === "general").map((c) => c.text)].map((s) => String(s ?? "").trim()).filter(Boolean);
  const count = lineComments.length + generals.length;
  const out = [`## ${t.head(count, byFile.size)} (${t.rev(revision)})`];
  if (generals.length) out.push("", `**${t.general}:**`, ...generals.map((g) => g));
  const meta = new Map((files ?? []).map((f) => [f.path, f]));
  for (const [file, list] of byFile) {
    const f = meta.get(file) ?? {};
    const oldPath = f.oldPath ?? list.find((c) => c.oldPath)?.oldPath ?? null;
    const note = oldPath && oldPath !== file ? ` (${t.renamed(oldPath)})` : f.status === "D" ? ` (${t.deleted})` : f.status === "A" ? ` (${t.added})` : "";
    out.push("", `### ${file}${note}`);
    const ordered = [...list].sort((a, b) => (a.side === "file" ? -1 : b.side === "file" ? 1 : (a.from ?? 0) - (b.from ?? 0)));
    for (const c of ordered) {
      out.push("", `**${rangeLabel(c, lang)}:**`);
      const q = Array.isArray(c.quote) ? c.quote.map((s) => String(s)) : [];
      if (c.side !== "file" && q.length && quoteMax > 0) {
        const shown = q.slice(0, quoteMax);
        out.push(fence(shown));
        if (q.length > shown.length) out.push(`_${t.cut(q.length - shown.length)}_`);
      }
      out.push(String(c.text ?? "").trim());
    }
  }
  out.push("", t.ask, "", `<!-- teleharness-review:${id}:r${revision} -->`);
  return { text: out.join("\n"), count, fileCount: byFile.size };
}

export function buildReviewMessage({ id, revision, comments = [], general = "", files = [], lang = "ru", maxChars = REVIEW_LIMITS.message } = {}) {
  const l = langOf(lang);
  const base = { id, revision, comments: Array.isArray(comments) ? comments : [], general, files, lang: l };
  for (const [quoteMax, shortened] of [[REVIEW_LIMITS.quote, false], [REVIEW_LIMITS.quoteShort, true], [0, true]]) {
    const r = render({ ...base, quoteMax });
    if (r.text.length <= maxChars) return { ...r, quoteLines: quoteMax, shortened, tooLong: false };
  }
  const r = render({ ...base, quoteMax: 0 });
  return { ...r, quoteLines: 0, shortened: true, tooLong: true };
}

// Маркер сообщения ревью в тексте пользователя → {id, revision} | null.
export function reviewMarker(text) {
  const m = MARKER_RE.exec(String(text ?? ""));
  return m ? { id: m[1], revision: Number(m[2]) } : null;
}

// Текст выполнения одобренного плана (ход «Выполни одобренный план»).
export function planExecText(plan, { lang = "ru", edited = false } = {}) {
  const en = langOf(lang) === "en";
  const head = en
    ? `The plan below is approved${edited ? " with my edits" : ""}. Implement it now, step by step. Do not re-plan.`
    : `План ниже одобрен${edited ? " с моими правками" : ""}. Выполни его сейчас, по шагам. Не составляй план заново.`;
  return `${head}\n\n${String(plan ?? "").trim()}`;
}

// Текст просьбы переделать план.
export function planReviseText(comment, { lang = "ru" } = {}) {
  const c = String(comment ?? "").trim();
  return langOf(lang) === "en" ? `Please redo the plan.${c ? ` My comments: ${c}` : ""}` : `Переделай план.${c ? ` Мои замечания: ${c}` : ""}`;
}
