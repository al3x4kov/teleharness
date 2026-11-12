// FEAT-11.18 (шаг В): Relay на клиенте — чистые помощники: куда предложить передать чат,
// где в ленте стоят отметки передачи, когда остаток подписки на исходе.
// Макет: design/mockups-v2/relay.html.
import { t } from "./i18n.js";
import { fmtClock } from "./normalize.js";

const same = (a, b) => a && b && a.providerID === b.providerID && (a.modelID ?? a.id) === (b.modelID ?? b.id);

// groups — [{engine, title, models:[{providerID, id, name}]}] из выбора модели (Pickers.modelGroups);
// binding — нынешняя привязка чата. → {engine, providerID, modelID, name} или null.
// Сначала — другой движок (в этом смысл передачи при лимите), иначе другая модель того же.
// preferred — модель по умолчанию пользователя: берётся, если она на другом движке.
export function suggestRelay(groups, binding, preferred = null) {
  const list = Array.isArray(groups) ? groups : [];
  const cur = binding?.model ?? null;
  const pick = (g, m) => ({ engine: g.engine, providerID: m.providerID, modelID: m.id, name: m.name ?? m.id });
  const other = list.filter((g) => g.engine !== binding?.engine && (g.models ?? []).length > 0);
  for (const g of other) {
    const pref = preferred ? g.models.find((m) => same(preferred, m)) : null;
    if (pref) return pick(g, pref);
  }
  if (other.length > 0) return pick(other[0], other[0].models[0]);
  for (const g of list) {
    const m = (g.models ?? []).find((x) => !same(cur, x));
    if (m) return pick(g, m);
  }
  return null;
}

const created = (m) => {
  const at = m?.info?.time?.created;
  const n = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(n) ? n : 0;
};

// Где рисовать отметки: Map(id сообщения → отметки ПЕРЕД ним) и tail — после последнего.
// Отметка встаёт перед первым сообщением, созданным позже неё.
export function placeRelayMarks(messages, relays) {
  const before = new Map();
  const tail = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const mark of [...(Array.isArray(relays) ? relays : [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    const next = list.find((m) => created(m) > (mark.at ?? 0) && m.info?.id);
    if (next) before.set(next.info.id, [...(before.get(next.info.id) ?? []), mark]);
    else tail.push(mark);
  }
  return { before, tail };
}

// «14:32» — время отметки: местный часовой пояс браузера, локаль языка интерфейса.
export function relayTime(at) {
  if (!at) return "";
  return fmtClock(at);
}

export const QUOTA_LOW_PCT = 85; // использовано ≥ 85 % → осталось меньше 15 %

// Остаток подписки на исходе для ЭТОГО чата: чат на модели z.ai, а у карточки z.ai есть окно,
// использованное на 85 % и больше. → {left, kind, number, resetAt} по самому занятому окну или null.
export function lowQuota(cards, binding) {
  if (!binding || binding.engine !== "opencode" || !/^zai/.test(String(binding.model?.providerID ?? ""))) return null;
  const card = (Array.isArray(cards) ? cards : []).find((c) => c.id === "zai" && c.state === "ok");
  const worst = (card?.windows ?? []).filter((w) => typeof w.percent === "number").sort((a, b) => b.percent - a.percent)[0];
  if (!worst || worst.percent < QUOTA_LOW_PCT) return null;
  return { left: Math.max(0, 100 - worst.percent), kind: worst.kind, number: worst.number ?? null, resetAt: worst.resetAt ?? null };
}

export function windowWords(kind, number) {
  if (kind === "hours") return t("relay.window.hours", { n: number ?? 5 });
  if (kind === "week") return t("relay.window.week");
  if (kind === "month") return t("relay.window.month");
  if (kind === "day") return t("relay.window.day");
  return "";
}
