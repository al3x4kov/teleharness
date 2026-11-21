// FEAT-20.6: выгрузка CSV журнала расхода (кр. 13): строка на ход, UTF-8 с BOM, «;» для RU и «,» для
// EN, суммы — 6 знаков из целых микродолларов (без плавающей точки), формулы в тексте обезврежены,
// поток пачками по 1 000 строк с ожиданием drain — память сервера не растёт с размером выгрузки.
import { dayMonth } from "./ledger.js";

export const CSV_COLUMNS = ["completed_at", "user", "project", "chat", "chat_id", "kind", "run", "step", "attempt", "engine", "provider", "model", "status", "tokens_in", "tokens_out", "tokens_reasoning", "cache_read", "cache_write_5m", "cache_write_1h", "usd_api_equivalent", "price_source", "no_data_reason"];

// 1234567 → "1.234567"; null → "" (нет данных — пустая ячейка, не 0).
export function microToUsd(micro, sep = ".") {
  if (micro == null) return "";
  const neg = micro < 0;
  const a = Math.abs(Math.round(micro));
  const s = `${Math.floor(a / 1e6)}${sep}${String(a % 1e6).padStart(6, "0")}`;
  return neg ? "-" + s : s;
}

// Защита от формул (= + - @, табуляция, CR) и экранирование разделителя/кавычек.
export function csvCell(v, delim) {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(delim) || /["\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const timeOf = (ms, tz) => {
  const d = dayMonth(ms, tz).day;
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return `${d} ${t}`;
};

const SOURCE = (r) => (r.cost_micro == null ? "no-data" : r.price_source === "table" ? `price-v${r.price_version}${r.priced_late ? "-late" : ""}` : r.price_source === "engine" ? "claude-code-estimate" : r.price_source === "provider" ? "provider-api" : r.billing === "free" ? "free" : r.price_source ?? "");

export function csvRow(r, { delim, tz, userName = (id) => id }) {
  const dec = delim === ";" ? "," : ".";
  const vals = [timeOf(r.completed_at, tz), userName(r.user_id) ?? r.user_name ?? r.user_id, r.project, r.title, r.parent_sid ?? r.sid, r.kind, r.run_id, r.step_id, r.attempt, r.engine, r.provider_id, r.model_id, r.status, r.t_in, r.t_out, r.t_reason, r.t_cache_read, r.t_cache_w5m, r.t_cache_w1h, microToUsd(r.cost_micro, dec), SOURCE(r), r.no_data_reason];
  return vals.map((v) => csvCell(v, delim)).join(delim) + "\r\n";
}

// Поток в res: rows — итератор строк журнала. Отмена (закрытие соединения) прерывает цикл.
export async function streamCsv(res, rows, { lang = "ru", tz, userName, includeNoData = true, filename }) {
  const delim = lang === "en" ? "," : ";";
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.write("﻿" + CSV_COLUMNS.join(delim) + "\r\n");
  let buf = "";
  let n = 0;
  let total = 0;
  for (const r of rows) {
    if (closed) break;
    if (!includeNoData && r.cost_micro == null) continue;
    buf += csvRow(r, { delim, tz, userName });
    total += r.cost_micro ?? 0;
    if (++n % 1000 === 0) {
      const ok = res.write(buf);
      buf = "";
      if (!ok) await new Promise((resolve) => (closed ? resolve() : res.once("drain", resolve), res.once("close", resolve)));
      else await new Promise((resolve) => setImmediate(resolve)); // ходы сервера не ждут выгрузку
    }
  }
  if (!closed) res.end(buf);
  return { rows: n, totalMicro: total, cancelled: closed };
}
