// FEAT-20.6: строка расхода проекта за текущий месяц — «Ноябрь: ≈ $412 по ценам API · 118 ходов ·
// 6 запусков» → «Подробнее» открывает «Расходы» с фильтром проекта (кр. 7; P-17). Тенант — свои ходы.
import { useEffect, useState } from "preact/hooks";
import "../costs.css";
import { costApi, costFilterHint, fmtCost, monthTitle, plural, turnsWord } from "../../lib/costs.js";
import { navigate } from "../../lib/router.js";
import { t } from "../../lib/i18n.js";

export function ProjectCost({ dir }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let off = false;
    costApi.project(dir).then((x) => { if (!off) setD(x); }, () => { if (!off) setD(null); });
    return () => { off = true; };
  }, [dir]);
  if (!d || d.turns === 0) return null;
  const open = () => {
    costFilterHint.value = { project: dir };
    navigate("/settings/costs");
  };
  return (
    <p class="cost-project" data-req="FEAT-20.6">
      {t("costs.project.line", { month: monthTitle(d.month), cost: fmtCost(d.micro, { total: true, approx: true }), turns: turnsWord(d.turns) })}{d.runs ? ` · ${t("costs.runs", { count: d.runs })}` : ""}{d.noData ? t("costs.chat.noDataCount", { n: d.noData }) : ""}
      {" "}<button type="button" class="cost-link" onClick={open}>{t("costs.project.more")}</button>
    </p>
  );
}
