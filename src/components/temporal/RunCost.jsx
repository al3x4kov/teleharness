// FEAT-20.6: карточка «Расход запуска» — сумма по ценам API по шагам и по каждой попытке шага
// (повтор после ошибки — отдельной строкой «попытка N»; кр. 7, P-4, N-7). Шагов-решений человека
// в журнале нет — у них нет модели.
import { useEffect, useState } from "preact/hooks";
import "../costs.css";
import { costApi, costTick, fmtCost, turnsWord } from "../../lib/costs.js";
import { t } from "../../lib/i18n.js";

const statusLabel = (s) => (s && s !== "ok" ? t(`costs.run.status.${s}`) : "");

export function RunCost({ workflowId, steps = [] }) {
  const [data, setData] = useState(null);
  const tick = costTick.value;
  useEffect(() => {
    costApi.run(workflowId).then(setData, () => setData(null));
  }, [workflowId, tick]);
  if (!data || data.turns === 0) return null;
  const name = (id) => steps.find((s) => s.id === id)?.name ?? id;
  return (
    <section class="t-card" aria-labelledby="t-cost-h" data-req="FEAT-20.6">
      <h2 id="t-cost-h">{t("costs.run.title")}</h2>
      <p class="cost-big">{fmtCost(data.totalMicro, { approx: true })}</p>
      <p class="cost-muted cost-small">{t("costs.run.meta", { turns: turnsWord(data.turns) })}{data.retries ? ` · ${t("costs.retries", { count: data.retries })}` : ""}{data.noData ? t("costs.chat.noDataCount", { n: data.noData }) : ""}</p>
      <ul class="cost-rows">
        {data.steps.map((s) => (
          <li key={s.stepId + "#" + s.attempt} class="cost-row">
            <span class="cost-row-main">
              <span class="cost-row-title">{name(s.stepId)}{s.retried ? t("costs.run.attempt", { n: s.attempt }) : ""}</span>
              <span class="cost-muted cost-small">{s.title}{statusLabel(s.status) ? ` · ${statusLabel(s.status)}` : ""}</span>
            </span>
            <span class="cost-num">{s.noData === s.turns ? <span class="cost-tag is-nodata"><span aria-hidden="true">? </span>{t("costs.noDataShort")}</span> : fmtCost(s.micro)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
