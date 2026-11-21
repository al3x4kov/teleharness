// FEAT-18.5: заполнение контекста и стоимость в чате. Чистые функции — без
// сигналов и DOM; данные — записи ленты {info, parts} и каталог моделей
// (providerCfg: models[].contextLimit = limit.context провайдера).
//
// Откуда берутся цифры (по факту полей движков):
//   opencode — info каждого шага-ответа: tokens.input / tokens.output /
//     tokens.reasoning / tokens.cache.read / tokens.cache.write (токены ОДНОГО
//     вызова модели), cost — цена шага в $, её считает opencode по каталогу
//     модели (0 — цена модели неизвестна или бесплатна). Окно — limit.context
//     модели из /provider.
//   Claude (lib/claude.js claudeTurnUsage) — один info на раунд ответа:
//     tokens.input/output/cache — СУММА вызовов хода из `result.usage`,
//     tokens.context — занятость окна последним вызовом основного разговора
//     (input + cache_read + cache_creation), contextWindow — окно, которое
//     сообщает CLI (modelUsage.contextWindow), cost — total_cost_usd (для
//     подписки это условная цена API — не показываем). Окно без contextWindow —
//     каталог Claude (shared/engine.js, data/claude-models.json).
//
// Занятость контекста = последний ответ модели в чате с известными токенами:
// tokens.context, иначе input + cache.read + cache.write (то, что модель
// прочла на входе последнего вызова). Окно неизвестно — процента нет.
import { fmtNum } from "./normalize.js";
import { lang, t } from "./i18n.js";

export const CONTEXT_WARN = 0.8; // > 80 % — «почти заполнен»

// Подписки: токены без денег (критерий 2 FEAT-18.5). Claude — подписка
// владельца через claude CLI; z.ai Coding Plan — пакет по подписке
// (lib/subscriptions.js REGISTRY: badge «Coding Plan»).
export const SUBSCRIPTION_PROVIDERS = Object.freeze(["anthropic", "zai-coding-plan", "openai-codex", "acp-antigravity", "acp-github-copilot-cli", "acp-gemini"]); // FEAT-18.7 / BUG-280

export function isSubscription(providerID) {
  return SUBSCRIPTION_PROVIDERS.includes(providerID);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Токены, которые модель прочла на входе последнего вызова этого ответа; null — неизвестно.
export function contextUsedOf(info) {
  const t = info?.tokens;
  if (!t || typeof t !== "object") return null;
  if (num(t.context) > 0) return num(t.context);
  const used = num(t.input) + num(t.cache?.read) + num(t.cache?.write);
  return used > 0 ? used : null;
}

// Окно модели ответа: от движка (Claude CLI), иначе из каталога; null — неизвестно.
export function contextWindowOf(info, cfg) {
  if (num(info?.contextWindow) > 0) return num(info.contextWindow);
  const models = Array.isArray(cfg?.models) ? cfg.models : [];
  const hit = models.find((m) => m?.providerID === info?.providerID && m?.id === info?.modelID);
  return num(hit?.contextLimit) > 0 ? num(hit.contextLimit) : null;
}

// Занятость контекста чата: {used, window, pct, warn} или null (нет ответа с токенами).
// window/pct = null, если окно модели неизвестно.
export function chatContext(messages, cfg) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const info = list[i]?.info;
    if (info?.role !== "assistant") continue;
    const used = contextUsedOf(info);
    if (used == null) continue;
    const window = contextWindowOf(info, cfg);
    const ratio = window ? used / window : null;
    return {
      used,
      window,
      pct: ratio == null ? null : Math.min(100, Math.round(ratio * 100)),
      warn: ratio != null && ratio > CONTEXT_WARN,
    };
  }
  return null;
}

// «$1,23» / «$0,123» / «$0,0042» — 2–4 знака по величине; меньше $0,0001 — «<$0,0001».
export function fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 0.0001) return "<$0,0001";
  const digits = n >= 1 ? 2 : n >= 0.1 ? 3 : 4;
  // хвостовые нули сверх двух знаков не нужны: 0,0100 → 0,01
  return "$" + n.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, "$1").replace(".", lang.value === "ru" ? "," : ".");
}

// Расход хода или чата: {kind, text}
//   kind "subscription" — «подписка» (денег нет);
//   kind "money"        — «$0,0123»;
//   kind "unknown"      — «цена неизвестна» (cost 0 у модели с оплатой за токены — не «$0»).
// provider — providerID ответа; cost — сумма cost шагов.
export function costLabel({ providerID, cost }) {
  if (isSubscription(providerID)) return { kind: "subscription", text: t("ctx.subscription") };
  const c = num(cost);
  if (c > 0) return { kind: "money", text: fmtUsd(c) };
  return { kind: "unknown", text: t("ctx.unknown") };
}

// Итог чата по всем ответам: деньги — сумма cost ответов моделей с оплатой
// за токены; ответы подписок денег не добавляют. null — в чате нет ответов
// с токенами.
export function chatCost(messages) {
  let money = 0;
  let metered = 0;
  let unknown = 0;
  let subscription = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const info = m?.info;
    if (info?.role !== "assistant") continue;
    const t = info.tokens;
    const hasTokens = t && typeof t === "object" && (num(t.input) + num(t.output) + num(t.total) + num(t.context) > 0);
    if (isSubscription(info.providerID)) {
      if (hasTokens) subscription += 1;
      continue;
    }
    if (num(info.cost) > 0) {
      money += num(info.cost);
      metered += 1;
    } else if (hasTokens) unknown += 1;
  }
  if (metered > 0) return { kind: "money", text: fmtUsd(money), cost: money, partial: unknown > 0 };
  if (unknown > 0) return { kind: "unknown", text: t("ctx.unknown"), cost: 0, partial: false };
  if (subscription > 0) return { kind: "subscription", text: t("ctx.subscription"), cost: 0, partial: false };
  return null;
}

// Строка полоски: «Контекст 85 % · почти заполнен» / «Контекст 170k ток» (окно неизвестно).
export function contextText(ctx) {
  if (!ctx) return "";
  if (ctx.pct == null) return t("ctx.tokens", { n: fmtNum(ctx.used) });
  return t("ctx.pct", { pct: ctx.pct }) + (ctx.warn ? t("ctx.almostFull") : "");
}

// Подсказка (title / aria): «170k из 200k токенов».
export function contextHint(ctx) {
  if (!ctx) return "";
  return ctx.window ? t("ctx.hint", { used: fmtNum(ctx.used), window: fmtNum(ctx.window) }) : t("ctx.hintNoWindow", { used: fmtNum(ctx.used) });
}
