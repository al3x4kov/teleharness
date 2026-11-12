// FEAT-01.77: полоса фоновых агентов над полем ввода (BRIEF-14 «Полоса
// фоновых агентов», макет design/mockups-v2/subagents.html кадр 5):
// «Фоном работает агент <имя>» / «Фоном работают N агента/агентов», таймер
// от самого раннего startedAt, вся полоса — кнопка (onOpen с первым
// запуском). Чисто презентационная; не рендерится при пустом runs.
import { fmtElapsed } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";
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
  // Имя — жирным внутри фразы: порядок слов задаёт словарь («… агент {name}» / «Agent {name} is …»)
  const [before, after = ""] = t("agent.bg.one", { name: "\u0000" }).split("\u0000");

  return (
    <button type="button" class="bg-bar" role="status" onClick={() => onOpen?.(first)}>
      <i class="sa-pulse" aria-hidden="true" />
      <span class="bt">
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
      {dur && <time>{dur}</time>}
      <span class="sa-chev" aria-hidden="true">
        <ChevIcon />
      </span>
    </button>
  );
}
