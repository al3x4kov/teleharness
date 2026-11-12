// FEAT-01.77: строка сводки по агентам одного хода (BRIEF-14 «Сводка»,
// макет design/mockups-v2/subagents.html кадры 1/3/6): «Агенты: N работают ·
// M в очереди» / «N готовы · K с ошибкой», 13,5 px --text-2, числа работающих
// выделены. Чисто презентационная: summary — готовый итог summarize(runs)
// (design §2); при total < 2 сводки нет (один агент). Обновления не чаще
// раза в 5 с — забота родителя, здесь role="status".
import { t } from "../../lib/i18n.js";

const BotIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <rect x="5" y="8" width="14" height="10" rx="3" />
    <path d="M12 4.5V8M9.5 12.5v1.5M14.5 12.5v1.5" stroke-linecap="round" />
  </svg>
);

export default function AgentSummary({ summary }) {
  const s = summary ?? {};
  const counts = [s.running, s.queued, s.done, s.error, s.stopped].every((v) => typeof v === "number");
  const total = typeof s.total === "number" ? s.total : counts ? s.running + s.queued + s.done + s.error + s.stopped : null;
  if (total == null || total < 2) return null;

  // Части строки через « · », как в макете; активные впереди готовых.
  const parts = [];
  if (counts) {
    const active = s.running + s.queued > 0;
    if (active) {
      if (s.running > 0) parts.push(<b key="run">{t("agent.sum.running", { count: s.running })}</b>);
      if (s.queued > 0) parts.push(t("agent.sum.queued", { count: s.queued }));
    } else {
      if (s.done > 0) parts.push(t("agent.sum.done", { count: s.done }));
      if (s.error > 0) parts.push(t("agent.sum.error", { count: s.error }));
    }
    if (parts.length === 0) return null;
  }

  return (
    <div class="sa-sum" role="status">
      <BotIcon />
      <span>
        {t("agent.sum.prefix")}{" "}
        {counts
          ? parts.map((p, i) => (
              <span key={i}>
                {i > 0 ? " · " : ""}
                {p}
              </span>
            ))
          : s.text}
      </span>
    </div>
  );
}
