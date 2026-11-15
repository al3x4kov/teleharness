// FEAT-18.5: строка над полем ввода (под пилюлями модели) — сколько контекста
// модели занято последним ответом и итог расхода чата:
//   «▮▮▮▯ Контекст 42 % · чат $0,123»
//   «▮▮▮▮ ⚠ Контекст 85 % · почти заполнен · подписка» (> 80 %: текст, не только цвет)
//   «Контекст 170k ток · цена неизвестна» (окно модели неизвестно — без процента и полоски).
// Расчёт — src/lib/context-cost.js. Нет ответа с токенами — строки нет.
import { providerCfg } from "../../lib/store.js";
import { chatContext, chatCost, contextHint, contextText } from "../../lib/context-cost.js";
import { t } from "../../lib/i18n.js";
import "../context-meter.css";

export default function ContextMeter({ messages }) {
  const ctx = chatContext(messages, providerCfg.value);
  if (!ctx) return null;
  const cost = chatCost(messages);
  const costText = cost ? (cost.kind === "money" ? t("ctx.chatCost", { cost: cost.text }) + (cost.partial ? t("ctx.plusUnknown") : "") : cost.text) : "";
  return (
    <div class={"ctx-meter" + (ctx.warn ? " is-warn" : "")} data-req="FEAT-18.5" title={contextHint(ctx)}>
      {ctx.pct != null && (
        <span class="ctx-bar" aria-hidden="true">
          <span class="ctx-fill" style={`width:${Math.max(2, ctx.pct)}%`} />
        </span>
      )}
      {ctx.warn && <span class="ctx-warn-ico" aria-hidden="true">⚠</span>}
      <span class="ctx-text">{contextText(ctx)}</span>
      {costText && <span class={"ctx-cost is-" + cost.kind}>· {costText}</span>}
      <span class="sr-only">{`, ${contextHint(ctx)}`}</span>
    </div>
  );
}
