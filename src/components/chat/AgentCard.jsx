// FEAT-01.77: карточка одного запуска субагента (BRIEF-14, макет
// design/mockups-v2/subagents.html, кадры 1/2/3/6). Чисто презентационная:
// данные приходят готовым пропом `run` (модель design §2, строит
// src/lib/subagents.js), подписи — пропами stepLabel/fmtDuration; сторы
// не читаются. Шапка — одна кнопка (aria-expanded, тап-цель ≥ 56 px),
// у работающего свёрнутого — строка «сейчас», раскрытие — шаги, ответ
// и «Открыть чат агента» при childId.
// Совместимость (пока подключение не сделано): старый вызов { part, repeat }
// из ToolCard.jsx — минимальный run строится из части (opencode 1.x:
// subagent_type/run_in_background/metadata.sessionId сохраняются).
import { useEffect, useState } from "preact/hooks";
import { fmtElapsed, fmtNum } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";
// TASK-01.79 (BUG-227): чистые функции ответа/задачи — рендер ответа без
// служебных обёрток, задача без заглушек в мосте старого вызова
import { cleanAgentOutput, groupSteps, taskDescription } from "../../lib/subagents.js";
import Markdown from "./Markdown.jsx";
import "../agents.css";

// plural: 1 шаг / 2 шага / 5 шагов (11 шагов, 21 шаг)
const stepsWord = (n) => t("agent.steps", { count: n });

// Состояние всегда словом, не только цветом (кадры 1, 3); значения — ключи словаря
const STATE_KEY = { queued: "agent.state.queued", running: "agent.state.running", done: "agent.state.done", error: "agent.badge.error", stopped: "agent.state.stopped" };
const stateWord = (state) => t(STATE_KEY[state]);
const STATE_CLASS = { queued: "is-queued", running: "is-run", done: "is-ok", error: "is-err", stopped: "is-stop" };

const ClockIcon = () => (
  <svg class="sa-i-clock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5l3 1.8" stroke-linecap="round" />
  </svg>
);

const BotIcon = () => (
  <svg class="sa-i-bot" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <rect x="5" y="8" width="14" height="10" rx="3" />
    <path d="M12 4.5V8M9.5 12.5v1.5M14.5 12.5v1.5" stroke-linecap="round" />
  </svg>
);

const CheckIcon = () => (
  <svg class="sa-i-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

const XIcon = () => (
  <svg class="sa-i-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
);

const StopIcon = () => (
  <svg class="sa-i-stop" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </svg>
);

const ChevIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 10l5 5 5-5" />
  </svg>
);

const OpenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 6h9v9M18 6L7 17" />
  </svg>
);

const STATE_ICON = { queued: ClockIcon, running: BotIcon, done: CheckIcon, error: XIcon, stopped: StopIcon };

// Дефолт подписи шага, если stepLabel не передан: verb из tool/object.
const defaultStepLabel = (s) => ({
  verb: s?.verb ?? (s?.kind === "text" ? t("agent.now.text") : s?.tool ?? t("agent.step")),
  object: s?.object ?? "",
});

// Минимальный run из части инструмента — мост для старого вызова ToolCard
// (поля как в FEAT-01.9: имя, описание, «фоном», время, статус). Поля
// opencode 1.x (subagent_type/run_in_background/metadata.sessionId) и
// opencode 2.x (agent/background/metadata.sessionID) читаются оба.
const partToRun = (part) => {
  const st = part?.state ?? {};
  const status = st.status ?? "pending";
  const input = st.input ?? {};
  const meta = st.metadata ?? {};
  // description FIRST: имя без описания падает TDZ-чтением (жило 2026-11-01,
  // поймано QA-матрицей — порядок сохранён). TASK-01.79: без служебных заглушек
  const description = taskDescription(part);
  const start = Number(st.time?.start ?? part?.time?.ran ?? part?.time?.created);
  const end = Number(st.time?.end ?? part?.time?.completed);
  const output = st.output != null ? (typeof st.output === "string" ? st.output : JSON.stringify(st.output)) : null;
  const state = status === "error" ? "error" : status === "pending" ? "queued" : status === "running" ? "running" : "done";
  return {
    id: part?.callID ?? part?.id,
    agent: meta.agent ?? input.subagent_type ?? input.agent ?? null,
    description,
    background: input.background === true || input.run_in_background === true,
    state,
    startedAt: Number.isFinite(start) && start > 0 ? start : null,
    endedAt: Number.isFinite(end) && end > 0 ? end : null,
    childId: meta.sessionID ?? meta.sessionId ?? null,
    steps: [],
    now: null,
    output: output || null,
    tokens: null,
    depth: 0,
  };
};

// «Сейчас»: verb + объект моноширинным с многоточием (кадр 1)
const NowRow = ({ nowRow }) => (
  <div class="sa-now">
    <i class="sa-pulse" aria-hidden="true" />
    <span>
      {nowRow.verb}
      {nowRow.object ? (
        <>
          {" "}
          <code>{nowRow.object}</code>
        </>
      ) : null}
    </span>
  </div>
);

const StepMark = { done: "✓", running: "●", error: "✕" };

export default function AgentCard({
  run: runProp,
  now: nowProp,
  stepLabel,
  fmtDuration = fmtElapsed,
  expanded,
  onToggle,
  onOpenChild,
  part,
  legacyPart,
  repeat = 1,
}) {
  const run = runProp ?? partToRun(part ?? legacyPart);
  const state = STATE_CLASS[run.state] ? run.state : "done";
  const label = stepLabel ?? defaultStepLabel;

  // Тик времени: общий now от родителя; без него — свой раз в секунду,
  // пока агент работает (никаких таймеров у завершённых).
  const [tick, setTick] = useState(() => Date.now());
  const selfTick = nowProp == null && state === "running";
  useEffect(() => {
    if (!selfTick) return undefined;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [selfTick]);
  const now = nowProp ?? tick;

  // время: у работающего — fmtDuration(now - startedAt), у завершённого — длительность
  let dur = null;
  if (run.startedAt != null && Number(run.startedAt) > 0) {
    if (state === "running") dur = fmtDuration(Math.max(0, now - Number(run.startedAt)));
    else if (run.endedAt != null && Number(run.endedAt) > 0) dur = fmtDuration(Math.max(0, Number(run.endedAt) - Number(run.startedAt)));
  }
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const nSteps = steps.length;
  const tokensStr = state === "done" && Number.isFinite(Number(run.tokens)) && Number(run.tokens) > 0 ? fmtNum(Number(run.tokens)) : "";

  // Раскрытие: управляемое (expanded/onToggle) или собственное состояние
  const [openSelf, setOpenSelf] = useState(false);
  const controlled = expanded != null;
  const isOpen = controlled ? Boolean(expanded) : openSelf;
  const toggle = () => (controlled ? onToggle?.(run) : setOpenSelf((v) => !v));

  // «Показать все шаги» / «Показать полностью» — локальные, живут до размонтирования
  const [allSteps, setAllSteps] = useState(false);
  const [fullOutput, setFullOutput] = useState(false);
  // TASK-01.79: подряд однотипные завершённые шаги — одна строка (кадр 3);
  // лимит «8 строк + Показать все шаги» — по строкам после группировки
  const groups = groupSteps(steps);
  const shownSteps = allSteps ? groups : groups.slice(0, 8);
  // TASK-01.79 (BUG-227): ответ без служебных обёрток, рендерится как в ленте
  const output = typeof run.output === "string" && run.output ? cleanAgentOutput(run.output) : "";
  const outLines = output ? output.split("\n").length : 0;

  const name = run.agent || (run.description ? t("agent.fallbackName") : t("agent.backgroundTask"));
  const metaLine1 =
    state === "queued"
      ? stateWord("queued")
      : [dur, state === "done" && nSteps > 0 ? stepsWord(nSteps) : ""].filter(Boolean).join(" · ") || null;
  const metaLine2 =
    state === "running" && nSteps > 0
      ? stepsWord(nSteps)
      : state === "done" && tokensStr
        ? t("agent.tokens", { n: tokensStr })
        : state === "error" || state === "stopped"
          ? stateWord(state)
          : null;
  const ariaLabel = [t("agent.aria", { name }), stateWord(state), run.description || "", dur || ""].filter(Boolean).join(", ");

  const rootClass = ["sa", STATE_CLASS[state], run.depth > 0 ? "is-deep" : "", isOpen ? "is-open" : ""].filter(Boolean).join(" ");
  const StateIcon = STATE_ICON[state];

  return (
    <div class={rootClass} data-run-id={run.id}>
      <button type="button" class="sa-head" aria-expanded={isOpen ? "true" : "false"} aria-label={ariaLabel} onClick={toggle}>
        <span class="sa-st" aria-hidden="true">
          <StateIcon />
        </span>
        <span class="sa-main">
          <span class="sa-name">
            <span class="sa-name-t">{name}</span>
            {run.background && <em>{t("agent.badge.background")}</em>}
            {repeat > 1 && (
              <em class="is-warn" title={t("agent.repeat", { count: repeat })}>
                ×{repeat}
              </em>
            )}
          </span>
          {run.description ? <span class="sa-task">{run.description}</span> : null}
        </span>
        {(metaLine1 || metaLine2) && (
          <span class="sa-meta">
            {metaLine1 && <span class="sa-meta-line">{metaLine1}</span>}
            {metaLine2 && <span class="sa-meta-line">{metaLine2}</span>}
          </span>
        )}
        <span class="sa-chev" aria-hidden="true">
          <ChevIcon />
        </span>
      </button>

      {state === "running" && run.now && !isOpen && <NowRow nowRow={run.now} />}
      {state === "error" && run.error ? <div class="sa-err">{t("agent.failed", { error: run.error })}</div> : null}

      {isOpen && (
        <div class="sa-body">
          {nSteps > 0 && (
            <ul class="sa-steps">
              {shownSteps.map((s) => {
                // TASK-01.79: группа завершённых шагов — одна строка: глагол +
                // первые два объекта + «· ещё N» и note мелким (кадр 3)
                if (Array.isArray(s?.objects)) {
                  const { verb } = label({ kind: s.kind, tool: s.tool, status: "done", object: s.objects[0] ?? "" }) ?? {};
                  const objs = s.objects.slice(0, 2).filter(Boolean);
                  return (
                    <li key={s.id ?? `${s.tool}:${s.objects[0] ?? ""}`}>
                      <i aria-hidden="true">{StepMark.done}</i>
                      <span>
                        {verb}
                        {objs.map((o, i) => (
                          <span key={o}>
                            {i === 0 && verb ? " " : i > 0 ? ", " : ""}
                            <code>{o}</code>
                          </span>
                        ))}
                        {s.count > 2 && <small> · {t("agent.more", { n: s.count - 2 })}</small>}
                        {s.note ? <small> · {s.note}</small> : null}
                      </span>
                    </li>
                  );
                }
                const { verb, object } = label(s) ?? {};
                // как в макете: класс только у незавершённых (run/err)
                const st = s.status === "running" || s.status === "error" ? s.status : null;
                return (
                  <li key={s.id ?? `${s.tool}:${s.object}`} class={st}>
                    <i aria-hidden="true">{StepMark[st ?? "done"]}</i>
                    <span>
                      {verb}
                      {object ? (
                        <>
                          {" "}
                          <code>{object}</code>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {groups.length > 8 && !allSteps && (
            <button type="button" class="sa-more" onClick={() => setAllSteps(true)}>
              {t("agent.showAllSteps")}
            </button>
          )}
          {output && (
            <>
              <div class={"sa-out" + (outLines > 6 && !fullOutput ? " is-clamped" : "")}>
                <Markdown text={output} />
              </div>
              {outLines > 6 && !fullOutput && (
                <button type="button" class="sa-out-more" onClick={() => setFullOutput(true)}>
                  {t("agent.showFull")}
                </button>
              )}
            </>
          )}
          {run.childId && onOpenChild && (
            <button type="button" class="sa-link" onClick={() => onOpenChild(run)}>
              {t("agent.openChat")} <OpenIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
