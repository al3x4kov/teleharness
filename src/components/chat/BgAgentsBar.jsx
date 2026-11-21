// FEAT-01.77 / BUG-290 (BUG-01.91): полоса фоновых агентов над полем ввода
// (BRIEF-14, макет design/mockups-v2/subagents.html кадры 5 и 5б):
// первая строка — «Фоном работает агент <имя>» / «Фоном работают N агента/агентов»,
// вторая строка — текущее действие агента (bgActionText), справа таймер от
// самого раннего startedAt. Вся полоса — кнопка (onOpen с первым запуском).
import { fmtElapsed } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";
import { bgActionText } from "../../lib/subagents.js";
import "../agents.css";

const ChevIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 14l5-5 5 5" />
  </svg>
);

export default function BgAgentsBar({ runs, now, fmtDuration = fmtElapsed, onOpen }) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : [];
  if (list.length === 0) return null;

  const first = list[0];
  const starts = list.filter((r) => r.startedAt != null).map((r) => Number(r.startedAt)).filter((at) => Number.isFinite(at) && at > 0); // без известного старта таймер не показываем
  const started = starts.length ? Math.min(...starts) : null;
  const dur = now != null && started != null ? fmtDuration(Math.max(0, now - started)) : null;
  const name = first.agent || t("agent.fallbackName");
  const [before, after = ""] = t("agent.bg.one", { name: "\u0000" }).split("\u0000");
  const act = bgActionText(first);
  const actLine = act ? (list.length === 1 ? act : `${name}: ${act}`) : "";

  return (
    <button type="button" class="bg-bar" role="status" onClick={() => onOpen?.(first)}>
      <i class="sa-pulse" aria-hidden="true" />
      <span class="bt">
        <span class="bt-title">
          {list.length === 1 ? (
            <>
              {before}<b>{name}</b>{after}
            </>
          ) : (
            <>
              {t("agent.bg.many", { count: list.length })}
            </>
          )}
        </span>
        {actLine ? <span class="bt-act">{actLine}</span> : null}
      </span>
      {dur && <time>{dur}</time>}
      <span class="sa-chev" aria-hidden="true">
        <ChevIcon />
      </span>
    </button>
  );
}
