// FEAT-01.77: связка компонентов агентов с данными стора (design §5
// subagents-in-chat). Три места подключения:
//   AgentRuns (default) — карточка в ленте: запускается из ToolCard, находит
//     в chatRuns запуск по callID части, за ним вложенные (depth больше),
//     над первой карточкой хода — сводка (summary — callID запусков хода от
//     MessageBubble). Запуска нет в chatRuns (часть вне активной ленты,
//     например чат агента открыт отдельно) → прежний вызов AgentCard.
//   TurnAgentsPreloader — прелоадер компактной ленты (MessageList): держится,
//     пока busy или agentsBusy, с подписью preloaderCaption.
//   BgAgentsGate — полоса фоновых агентов над композером (ChatView).
// Агентные сигналы читаются только здесь: пузыри и MessageList остаются
// чистыми (design §6 — событие ленты ребёнка не перерисовывает чужие пузыри).
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { navigate } from "../../lib/router.js";
import { agentNow } from "../../lib/agent-tick.js";
import { active, activeAgentRuns, chatRuns, childFeedOf, ensureChildFeed, execDetailOn, prefs } from "../../lib/store.js";
import { fmtDuration, needsTokenRefresh, preloaderCaption, showBgBar, stepLabel, summarize } from "../../lib/subagents.js";
import AgentCard from "./AgentCard.jsx";
import AgentSummary from "./AgentSummary.jsx";
import BgAgentsBar from "./BgAgentsBar.jsx";
import TurnPreloader from "./TurnPreloader.jsx";

// «Открыть чат агента» / тап по полосе (детализация выключена): в чат
// дочерней сессии тем же адресом, каким приложение открывает чат из списка.
const openChildChat = (run) => {
  if (run?.childId) navigate(`#/chat/${encodeURIComponent(run.childId)}`);
};

// TASK-01.79: итог завершённой карточки (шаги, токены) виден сразу, в том
// числе после перезагрузки — лента ребёнка без загруженной ленты грузится
// при появлении карточки. Повторы и ретраи упавших отсекает ensureChildFeed
// (лимит 3 одновременных — внутри него).
function FeedAutoLoad({ run }) {
  useEffect(() => {
    const terminal = run.state === "done" || run.state === "error" || run.state === "stopped";
    if (!run.childId || !terminal) return;
    if (childFeedOf(run.childId) !== null) {
      // TASK-01.81: токены есть только в сохранённой истории — перечитать один раз
      if (needsTokenRefresh(run)) ensureChildFeed(run.childId, { force: true });
      return;
    }
    ensureChildFeed(run.childId);
    // по run.id и состоянию: карточка не перезапрашивает ленту на перерисовках
  }, [run.id, run.state]);
  return null;
}

// Прокрутка к карточке запуска (тап по полосе, детализация включена).
const scrollToRun = (run) => {
  const el = document.querySelector(`[data-run-id="${String(run?.id ?? "").replace(/"/g, "")}"]`);
  if (!el) return;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
};

export default function AgentRuns({ part, repeat = 1, summary = null }) {
  const runs = chatRuns.value;
  const now = agentNow.value;
  const callId = part?.callID ?? part?.id ?? null;
  const idx = callId != null ? runs.findIndex((r) => r.id === callId) : -1;
  const sid = active.value?.id ?? null;

  // Раскрытие хранит связка по run.id — переживает перерисовку ленты,
  // сбрасывается при смене чата.
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => {
    setOpen(new Set());
  }, [sid]);

  if (idx < 0 || !runs[idx]) return <AgentCard part={part} repeat={repeat} />;
  const run = runs[idx];
  // вложенные запуски — следующие элементы chatRuns с depth больше этого,
  // до первого с depth не больше
  const nested = [];
  for (let k = idx + 1; k < runs.length; k += 1) {
    if (runs[k].depth <= run.depth) break;
    nested.push(runs[k]);
  }
  // сводка хода: только запуски верхнего уровня, показывается при ≥ 2
  const summaryRuns =
    Array.isArray(summary) && summary.length >= 2
      ? runs.filter((r) => r.depth === 0 && summary.includes(r.id))
      : null;

  const toggle = (r) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(r.id)) next.delete(r.id);
      else {
        next.add(r.id);
        // раскрытие запуска с ребёнком без ленты — лента грузится по требованию
        if (r.childId && childFeedOf(r.childId) === null) ensureChildFeed(r.childId);
      }
      return next;
    });
  };

  const card = (r) => (
    <Fragment key={r.id}>
      <FeedAutoLoad run={r} />
      <AgentCard
        run={r}
        now={now}
        stepLabel={stepLabel}
        fmtDuration={fmtDuration}
        expanded={open.has(r.id)}
        onToggle={toggle}
        onOpenChild={openChildChat}
      />
    </Fragment>
  );

  return (
    <>
      {summaryRuns && <AgentSummary summary={summarize(summaryRuns)} />}
      {card(run)}
      {nested.map((r) => card(r))}
    </>
  );
}

// Прелоадер компактной ленты (детализация выключена): показан, пока идёт ход
// основного агента ИЛИ работают агенты; у работающих агентов — подпись
// preloaderCaption, у одиночного основного хода — прежний вид без подписи.
export function TurnAgentsPreloader({ busy = false }) {
  const act = activeAgentRuns.value;
  if (!busy && act.length === 0) return null;
  return <TurnPreloader caption={preloaderCaption(act, agentNow.value)} />;
}

// Полоса фоновых агентов над композером (кадр 5 макета): видна, когда ход
// основного агента НЕ идёт, а активные запуски есть — в обоих режимах
// детализации. Тап: прокрутка к карточке (детализация включена) или переход
// в чат агента (выключена, есть childId).
export function BgAgentsGate({ hidden = false }) {
  const runs = hidden ? [] : activeAgentRuns.value;
  const detail = execDetailOn(prefs.value);
  // TASK-01.81: при выключенной детализации полосы нет — работу агентов показывает индикатор (кадр 4)
  if (!showBgBar({ mainBusy: false, dialogOpen: hidden, detailOn: detail, activeCount: runs?.length ?? 0 })) return null;
  return <BgAgentsBar runs={runs} now={agentNow.value} fmtDuration={fmtDuration} onOpen={(r) => (detail ? scrollToRun(r) : openChildChat(r))} />;
}
