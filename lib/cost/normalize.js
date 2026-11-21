// FEAT-20.6: токены движков → единый вид записи журнала расхода (чистые функции).
//
// Запись: {status, tokens:{in, out, reason, cacheRead, w5m, w1h, context}, byModel:[{model, in, out,
// reason, cacheRead, w5m, w1h, engineCostMicro, speed}], engineCostMicro, engineCostBasis, partial,
// speed}. out — платный выход (reasoning у Claude/Codex уже внутри output, у opencode — добавляется);
// reason — только для показа.
//
// Claude CLI (проверено на tests/fixtures/claude-stream-subagent-2.1.322.jsonl):
//   result.modelUsage и total_cost_usd — НАКОПИТЕЛЬНЫЕ за процесс/сессию CLI (второй `result` того же
//   процесса несёт тот же total_cost_usd; в data/claude-sessions.json cost ходов растёт 81 → 157 $),
//   поэтому для хода годится только model_usage_since_last_result — прирост с прошлого `result`,
//   с субагентами, делением кэша 5m/1h и costUSD. Нет этого поля → result.usage (только основной
//   разговор) с partial = «без субагентов»; цена движка тогда неизвестна.
// Codex (lib/codex-shim.mjs): посредник пишет прирост хода в model_usage_since_last_result той же
//   формы (inputTokens уже без кэша, reasoningOutputTokens — часть output).

const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const usdToMicro = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e6) : null);

// result (сигнал translateEvent: usage, modelUsage, sinceLast, speed) → {byModel, basis} | null.
export function claudeUsageByModel(result) {
  const since = isObj(result?.sinceLast) ? result.sinceLast : null;
  const speed = result?.usage?.speed === "fast" ? "fast" : null;
  if (since) {
    const byModel = [];
    for (const [model, u] of Object.entries(since)) {
      if (!isObj(u)) continue;
      const write = n(u.cacheCreationInputTokens);
      const has5 = typeof u.cacheCreationEphemeral5mInputTokens === "number";
      const has1 = typeof u.cacheCreationEphemeral1hInputTokens === "number";
      const w1h = has1 ? n(u.cacheCreationEphemeral1hInputTokens) : 0;
      const w5m = has5 ? n(u.cacheCreationEphemeral5mInputTokens) : Math.max(0, write - w1h); // без деления — вся запись как 5 мин
      byModel.push({
        model: typeof u.canonicalModel === "string" && u.canonicalModel ? u.canonicalModel : model,
        in: n(u.inputTokens),
        out: n(u.outputTokens),
        reason: n(u.thinkingTokens ?? u.reasoningOutputTokens),
        cacheRead: n(u.cacheReadInputTokens),
        w5m,
        w1h,
        engineCostMicro: usdToMicro(u.costUSD),
        ...(typeof u.costBasis === "string" ? { costBasis: u.costBasis } : {}),
        ...(speed ? { speed } : {}),
      });
    }
    return { byModel, basis: "per-result" };
  }
  return null;
}

// Статус хода по info ответа.
export function statusOf(info) {
  const why = info?.teleharness?.interrupted;
  if (why === "restart" || why === "crash") return "crash";
  if (why) return "interrupted";
  if (info?.error || info?.turnError || info?.teleharness?.turnError) return "error";
  return "ok";
}

const sumTokens = (byModel, context = 0) => {
  const t = { in: 0, out: 0, reason: 0, cacheRead: 0, w5m: 0, w1h: 0, context: n(context) };
  for (const e of byModel) for (const k of ["in", "out", "reason", "cacheRead", "w5m", "w1h"]) t[k] += n(e[k]);
  return t;
};

// info ответа (как в ленте/истории) → нормализованная запись. engine: claude | codex | opencode | <другое>.
export function normalizeAnswer(engine, info) {
  const status = statusOf(info);
  const model = String(info?.modelID ?? "");
  const t = isObj(info?.tokens) ? info.tokens : null;
  const context = n(t?.context);
  let byModel = [];
  let partial = false;
  let engineCostMicro = null;
  let engineCostBasis = null;
  let speed = null;
  if (engine === "opencode" || (engine !== "claude" && engine !== "codex")) {
    if (t) {
      const out = n(t.output) + n(t.reasoning); // opencode: reasoning отдельно и оплачивается как выход
      const e = { model, in: n(t.input), out, reason: n(t.reasoning), cacheRead: n(t.cache?.read), w5m: n(t.cache?.write), w1h: 0 };
      if (e.in + e.out + e.cacheRead + e.w5m > 0) byModel = [e];
    }
    if (typeof info?.cost === "number" && info.cost > 0) {
      engineCostMicro = usdToMicro(info.cost);
      engineCostBasis = "provider";
    }
  } else if (Array.isArray(info?.usageByModel)) {
    byModel = info.usageByModel.filter(isObj).map((e) => ({ ...e, model: String(e.model ?? model) }));
    speed = byModel.find((e) => e.speed)?.speed ?? null;
    const costs = byModel.map((e) => e.engineCostMicro).filter((v) => typeof v === "number");
    if (engine === "claude" && costs.length === byModel.length && costs.length) {
      engineCostMicro = costs.reduce((a, b) => a + b, 0);
      engineCostBasis = byModel.find((e) => e.costBasis)?.costBasis ?? "list";
    }
  } else if (t) {
    // История до FEAT-20.6 / CLI без прироста: только основной разговор, запись кэша без деления → 5 мин.
    const e = { model, in: n(t.input), out: n(t.output), reason: n(t.reasoning), cacheRead: n(t.cache?.read), w5m: n(t.cache?.write), w1h: 0 };
    if (e.in + e.out + e.cacheRead + e.w5m > 0) {
      byModel = [e];
      partial = engine === "claude";
    }
  }
  // Основная модель хода — первой (порог длинного контекста — по ней).
  byModel.sort((a, b) => (a.model === model ? -1 : b.model === model ? 1 : 0));
  return { status, tokens: sumTokens(byModel, context), byModel, partial, engineCostMicro, engineCostBasis, speed };
}
