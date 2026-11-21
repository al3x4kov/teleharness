// FEAT-20.6: клиент «Расходы» — API /teleharness/api/costs/*, формат денег и подписи (чистые помощники
// проверяют node-тесты), счётчик событий teleharness.cost.updated / teleharness.cost.budget для перечитывания.
// Деньги приходят целыми микродолларами; округляет только показ (кр. 17).
import { signal } from "@preact/signals";
import { lang as i18nLang, t } from "./i18n.js";

const BASE = "/teleharness/api/costs";
async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
const enc = encodeURIComponent;
export function periodQuery(p = {}) {
  const q = new URLSearchParams();
  if (p.period) q.set("period", p.period);
  if (p.period === "custom") {
    if (p.from) q.set("from", p.from);
    if (p.to) q.set("to", p.to);
  }
  if (p.user) q.set("user", p.user);
  if (p.project) q.set("project", p.project);
  const s = q.toString();
  return s ? "?" + s : "";
}
export const costApi = {
  summary: (p) => call("GET", "/summary" + periodQuery(p)),
  chat: (sid) => call("GET", `/chat/${enc(sid)}`),
  bannerSeen: (sid) => call("POST", `/chat/${enc(sid)}/banner-seen`, {}),
  run: (id) => call("GET", `/run/${enc(id)}`),
  project: (dir) => call("GET", `/project?project=${enc(dir)}`),
  users: (p) => call("GET", "/users" + periodQuery(p)),
  prices: () => call("GET", "/prices"),
  savePrices: (models, version, { confirmHigh = false, note = null } = {}) => call("PUT", "/prices", { models, confirmHigh, note }, { "if-match": String(version) }),
  importPrices: (text, { version, dryRun, filename, confirmHigh = false }) => call("POST", `/prices/import${dryRun ? "?dryRun=1" : ""}`, { text, filename, confirmHigh, version }),
  recalc: (from, to, dryRun) => call("POST", "/recalc", { from, to, dryRun }),
  subscriptions: () => call("GET", "/subscriptions"),
  saveSubscriptions: (items, version) => call("PUT", "/subscriptions", { items, version }),
  budgets: () => call("GET", "/budgets"),
  saveBudget: (userId, usdMonth, version) => call("PUT", `/budgets/${enc(userId)}`, { usdMonth, version }),
  settings: () => call("GET", "/settings"),
  saveSettings: (patch, version) => call("PUT", "/settings", { ...patch, version }),
  backfill: () => call("POST", "/backfill", {}),
  exportUrl: (p, { lang = i18nLang.value, noData = true } = {}) => `${BASE}/export.csv${periodQuery(p) || "?"}${periodQuery(p) ? "&" : ""}lang=${lang}${noData ? "" : "&nodata=0"}`,
};

// «Подробнее» со страницы проекта → «Расходы» с фильтром проекта (P-17).
export const costFilterHint = signal(null);

// События сервера → перечитать открытые экраны расхода.
export const costTick = signal(0);
export const costBudgetEvent = signal(null);
export function onCostEvent(evt) {
  if (evt?.type === "teleharness.cost.updated") costTick.value += 1;
  else if (evt?.type === "teleharness.cost.budget") {
    costBudgetEvent.value = { ...evt.properties, at: Date.now() };
    costTick.value += 1;
  }
}

// ---- формат --------------------------------------------------------------------------
const NB = " ";
function group(intStr, sep) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
// Деньги по ценам API: total — итог (≥ $100 без центов); < $0,01 — «< $0,01»; null — «нет данных».
export function fmtCost(micro, { lang = i18nLang.value, total = false, approx = false, noData = null } = {}) {
  if (micro == null || !Number.isFinite(Number(micro))) return noData ?? (lang === "en" ? "no data" : t("costs.noDataShort"));
  const m = Math.round(Number(micro));
  const pre = approx ? "≈" + (lang === "en" ? "" : NB) : "";
  if (m === 0) return pre + "$0";
  if (Math.abs(m) < 10_000) return (lang === "en" ? "< $0.01" : `<${NB}$0,01`);
  const neg = m < 0 ? "−" : "";
  const a = Math.abs(m);
  const [gs, ds] = lang === "en" ? [",", "."] : [NB, ","];
  if (total && a >= 100_000_000) return pre + neg + "$" + group(String(Math.round(a / 1e6)), gs);
  const cents = Math.round(a / 10_000);
  return pre + neg + "$" + group(String(Math.floor(cents / 100)), gs) + ds + String(cents % 100).padStart(2, "0");
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) {
    const s = (Math.round(v / 1e5) / 10).toString();
    return t("costs.tokensM", { n: i18nLang.value === "ru" ? s.replace(".", ",") : s });
  }
  if (v >= 1e3) return t("costs.tokensK", { n: Math.round(v / 1e3) });
  return String(v);
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const turnsWord = (n) => t("costs.turns", { count: n });

export const NO_DATA_TEXT = Object.defineProperties({}, {
  legacy: { enumerable: true, get: () => t("costs.noData.legacy") },
  "no-price": { enumerable: true, get: () => t("costs.noData.no-price") },
  "engine-silent": { enumerable: true, get: () => t("costs.noData.engine-silent") },
  interrupted: { enumerable: true, get: () => t("costs.noData.interrupted") },
});

const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthTitle = (ym) => {
  const idx = Number(String(ym).slice(5, 7)) - 1;
  if (i18nLang.value === "en") return MONTHS_EN[idx] ?? String(ym);
  const m = MONTHS_RU[idx] ?? "";
  return m ? m[0].toUpperCase() + m.slice(1) : String(ym);
};
export function dayTitle(day) {
  const [, m, d] = String(day).split("-").map(Number);
  if (i18nLang.value === "en") return `${MONTHS_SHORT_EN[m - 1] ?? ""}${NB}${d}`;
  return `${d}${NB}${MONTHS_GEN_RU[m - 1] ?? ""}`;
}
// «1–20 ноября» / «12 октября – 10 ноября».
export function rangeTitle(from, to) {
  if (!from || !to) return "";
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (fy === ty && fm === tm) {
    if (i18nLang.value === "en") return `${MONTHS_SHORT_EN[tm - 1]}${NB}${fd}–${td}`;
    return `${fd}–${td}${NB}${MONTHS_GEN_RU[tm - 1]}`;
  }
  return `${dayTitle(from)} – ${dayTitle(to)}${fy !== ty ? ` ${ty}` : ""}`;
}

// Окупаемость: «окупилась в 5,0 раза» / «не окупилась (0,4×)».
export function paybackText(x) {
  if (x == null) return "";
  const v = i18nLang.value === "ru" ? x.toFixed(1).replace(".", ",") : x.toFixed(1);
  return t(x >= 1 ? "costs.payback.yes" : "costs.payback.no", { v });
}

// Длинное имя модели/чата — режется с конца, полное — в подсказке.
export function clip(s, max = 40) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// BUG-277: домашняя папка («C:\\Users\\USER», «/home/user») — «Домашняя папка», а не имя пользователя ОС.
export const projectName = (dir) => {
  if (!dir) return t("costs.project.none");
  if (/[\\/](?:users|home)[\\/]+[^\\/]+[\\/]*$/i.test(String(dir))) return t("costs.project.home");
  return String(dir).split(/[\\/]/).filter(Boolean).pop() ?? dir;
};
