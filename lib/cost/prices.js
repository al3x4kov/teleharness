// FEAT-20.6: прайс моделей по ценам API (чистые функции, без БД).
//
// Таблица — {currency:"USD", models:[{id, title, provider, aliases?, usdPerMTok:{input, output,
// cacheRead, cacheWrite5m, cacheWrite1h}, longContext?:{aboveInputTokens, usdPerMTok}, fast?:{input,
// output}, free?, source, checkedAt}]}. Встроенная — shared/model-prices.json (цены с официальных
// страниц, дата у каждой модели); правки admin — новые версии в журнале (lib/cost/ledger.js).
//
// Деньги — целые микродоллары: токены × $ за 1 млн токенов = микродоллары (одно округление на ход).
import { readFileSync } from "node:fs";

export const PRICE_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"]);
export const PRICE_MAX = 10_000; // $ за 1 млн — больше не принимается
export const PRICE_CONFIRM = 500; // больше — «Похоже на опечатку», нужен confirmHigh

// Подписочные провайдеры портала (как src/lib/context-cost.js SUBSCRIPTION_PROVIDERS).
export const SUBSCRIPTION_PROVIDERS = Object.freeze(["anthropic", "zai-coding-plan", "openai-codex", "acp-antigravity", "acp-github-copilot-cli", "acp-gemini"]);
export const isSubscriptionProvider = (p) => SUBSCRIPTION_PROVIDERS.includes(String(p ?? ""));

export function builtinTable(file = new URL("../../shared/model-prices.json", import.meta.url)) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  return { currency: doc.currency, revision: doc.revision ?? 1, models: doc.models };
}

// «anthropic/claude-opus-5-5[1m]» → «claude-opus-5-5»; регистр не важен.
export function normModelId(id) {
  let s = String(id ?? "").trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/\[[^\]]*\]$/, "");
  return s;
}

export function findPrice(table, modelID) {
  const want = normModelId(modelID);
  if (!want) return null;
  for (const m of table?.models ?? []) {
    if (normModelId(m.id) === want) return m;
    if (Array.isArray(m.aliases) && m.aliases.some((a) => normModelId(a) === want)) return m;
  }
  return null;
}

const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// Сумма одной модели хода: {micro (дробные микродоллары), longCtx}.
// entry: {in, out, cacheRead, w5m, w1h}; context — вход последнего вызова хода (оценка длинного контекста).
export function modelCost(price, entry, { context = 0, speed = null } = {}) {
  if (price.free) return { micro: 0, longCtx: false, free: true };
  let p = price.usdPerMTok;
  let longCtx = false;
  const lc = price.longContext;
  if (lc && n(lc.aboveInputTokens) > 0 && n(context) > lc.aboveInputTokens && lc.usdPerMTok) {
    p = { ...p, ...lc.usdPerMTok };
    longCtx = true;
  }
  if (speed === "fast" && price.fast) p = { ...p, ...price.fast };
  const micro = n(entry.in) * n(p.input) + n(entry.out) * n(p.output) + n(entry.cacheRead) * n(p.cacheRead) + n(entry.w5m) * n(p.cacheWrite5m) + n(entry.w1h) * n(p.cacheWrite1h);
  return { micro, longCtx, free: false };
}

// Ход целиком по прайсу: {costMicro|null, noPrice:[модели], longCtx, free}.
// Модель без цены → вся сумма хода неизвестна (не $0, кр. 4).
export function priceTurn(table, byModel, { context = 0, speed = null } = {}) {
  const noPrice = [];
  let micro = 0;
  let longCtx = false;
  let allFree = byModel.length > 0;
  for (const e of byModel) {
    const price = findPrice(table, e.model);
    if (!price) {
      noPrice.push(e.model);
      continue;
    }
    // Порог длинного контекста — по входу последнего вызова: у основной модели хода
    // (первая строка разбивки) это context движка, у остальных — неизвестно.
    const r = modelCost(price, e, { context: e === byModel[0] ? context : 0, speed: e.speed ?? speed });
    micro += r.micro;
    longCtx ||= r.longCtx;
    allFree &&= r.free;
  }
  if (noPrice.length) return { costMicro: null, noPrice, longCtx: false, free: false };
  return { costMicro: Math.round(micro), noPrice, longCtx, free: allFree };
}

// --- проверка и импорт -------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\-[\]/]{0,119}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkPrice(v, field, errs, where, confirmHigh, allowEmpty = false) {
  if (v === undefined || v === null || v === "") {
    if (!allowEmpty) errs.push({ ...where, field, code: "required", message: "Заполните поле" });
    return;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return void errs.push({ ...where, field, code: "nan", message: "Нужно число" });
  if (v < 0) return void errs.push({ ...where, field, code: "negative", message: "Не меньше 0" });
  if (v > PRICE_MAX) return void errs.push({ ...where, field, code: "too-high", message: `Не больше ${PRICE_MAX}` });
  if (v > PRICE_CONFIRM && !confirmHigh) errs.push({ ...where, field, code: "confirm-high", message: "Похоже на опечатку: больше $500 за 1 млн токенов. Сохранить?" });
}

// Проверка таблицы: [] — всё верно; ошибки с индексом модели и полем.
export function validateTable(table, { confirmHigh = false } = {}) {
  const errs = [];
  if (!table || typeof table !== "object") return [{ index: null, field: null, code: "schema", message: "Неверный формат прайса" }];
  if (table.currency !== undefined && table.currency !== "USD")
    errs.push({ index: null, field: "currency", code: "currency", message: `«${String(table.currency).slice(0, 10)}». Поддерживается только USD` });
  if (!Array.isArray(table.models)) return [...errs, { index: null, field: "models", code: "schema", message: "Нет списка моделей" }];
  if (table.models.length > 500) errs.push({ index: null, field: "models", code: "too-many", message: "Больше 500 моделей" });
  const seen = new Set();
  table.models.forEach((m, index) => {
    const where = { index, id: typeof m?.id === "string" ? m.id : null };
    if (!m || typeof m !== "object") return void errs.push({ ...where, field: null, code: "schema", message: "Модель — объект" });
    if (typeof m.id !== "string" || !ID_RE.test(m.id)) errs.push({ ...where, field: "id", code: "id", message: "Неверный id модели" });
    else if (seen.has(normModelId(m.id))) errs.push({ ...where, field: "id", code: "duplicate", message: "Модель уже есть в прайсе" });
    else seen.add(normModelId(m.id));
    if (m.free === true) return;
    const p = m.usdPerMTok;
    if (!p || typeof p !== "object") return void errs.push({ ...where, field: "usdPerMTok", code: "required", message: "Заполните поле" });
    for (const f of PRICE_FIELDS) checkPrice(p[f], f, errs, where, confirmHigh, f !== "input" && f !== "output");
    if (m.longContext) {
      const lc = m.longContext;
      if (!(Number.isInteger(lc.aboveInputTokens) && lc.aboveInputTokens > 0)) errs.push({ ...where, field: "longContext.aboveInputTokens", code: "nan", message: "Порог — целое число токенов" });
      for (const f of PRICE_FIELDS) checkPrice(lc.usdPerMTok?.[f], "longContext." + f, errs, where, confirmHigh, f !== "input" && f !== "output");
    }
    if (m.fast) for (const f of ["input", "output"]) checkPrice(m.fast[f], "fast." + f, errs, where, confirmHigh);
    if (m.source != null && (typeof m.source !== "string" || m.source.length > 500)) errs.push({ ...where, field: "source", code: "source", message: "Источник — ссылка до 500 знаков" });
    if (m.checkedAt != null && !(typeof m.checkedAt === "string" && DATE_RE.test(m.checkedAt))) errs.push({ ...where, field: "checkedAt", code: "date", message: "Дата — ГГГГ-ММ-ДД" });
  });
  return errs;
}

// Только поля прайса (без лишнего из импорта).
export function cleanModel(m) {
  const out = { id: String(m.id), title: typeof m.title === "string" ? m.title.slice(0, 120) : String(m.id), provider: typeof m.provider === "string" ? m.provider.slice(0, 40) : null };
  if (Array.isArray(m.aliases)) out.aliases = m.aliases.filter((a) => typeof a === "string").slice(0, 10);
  if (m.free === true) out.free = true;
  const pick = (p) => Object.fromEntries(PRICE_FIELDS.filter((f) => typeof p?.[f] === "number").map((f) => [f, p[f]]));
  out.usdPerMTok = pick(m.usdPerMTok ?? {});
  if (m.longContext) out.longContext = { aboveInputTokens: m.longContext.aboveInputTokens, usdPerMTok: pick(m.longContext.usdPerMTok ?? {}) };
  if (m.fast) out.fast = { input: m.fast.input, output: m.fast.output };
  out.source = typeof m.source === "string" ? m.source : null;
  out.checkedAt = typeof m.checkedAt === "string" ? m.checkedAt : null;
  return out;
}

const priceKey = (m) => JSON.stringify({ f: m.free === true, p: m.usdPerMTok ?? {}, l: m.longContext ?? null, x: m.fast ?? null });

// Предпросмотр импорта: {changed, added, same, rows:[{id, kind, before, after}]}.
export function diffTables(oldTable, newTable) {
  const out = { changed: 0, added: 0, same: 0, rows: [] };
  for (const m of newTable.models ?? []) {
    const before = findPrice(oldTable, m.id);
    if (!before) {
      out.added += 1;
      out.rows.push({ id: m.id, kind: "added", before: null, after: m });
    } else if (priceKey(before) !== priceKey(m)) {
      out.changed += 1;
      out.rows.push({ id: m.id, kind: "changed", before, after: m });
    } else out.same += 1;
  }
  return out;
}

// Строка (с 1) позиции в тексте.
const lineAt = (text, pos) => (pos < 0 ? null : text.slice(0, pos).split("\n").length);

// Разбор файла импорта: {table} | {error:{line, field, message}}.
export function parseImport(text, { confirmHigh = false } = {}) {
  if (typeof text !== "string" || !text.trim()) return { error: { line: null, field: null, message: "Пустой файл" } };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    const m = /position (\d+)/.exec(String(err?.message));
    const lm = /line (\d+)/.exec(String(err?.message));
    return { error: { line: lm ? Number(lm[1]) : m ? lineAt(text, Number(m[1])) : null, field: null, message: "Битый JSON" } };
  }
  if (Array.isArray(doc)) doc = { currency: "USD", models: doc };
  const errs = validateTable(doc, { confirmHigh });
  if (errs.length) {
    const e = errs[0];
    let pos = -1;
    if (e.id) pos = text.indexOf(JSON.stringify(e.id));
    if (e.field) {
      const leaf = e.field.split(".").pop();
      const fpos = text.indexOf(`"${leaf}"`, Math.max(0, pos));
      if (fpos >= 0) pos = fpos;
    }
    const value = e.field === "currency" ? ` — «${String(doc.currency).slice(0, 10)}»` : "";
    return { error: { line: lineAt(text, pos), field: e.field, code: e.code, message: e.code === "currency" ? `поле currency${value}. Поддерживается только USD` : e.message }, errors: errs.slice(0, 20) };
  }
  return { table: { currency: "USD", models: doc.models.map(cleanModel) } };
}
