// Tool part row: human label + step description + status glyph + mono
// elapsed, collapsible. Header = «what the tool does · what the agent said
// the step is» («Команда · Построить график», R-14) or the file basename.
// Raw command, full file path, output and exit code live INSIDE the
// expansion only (leak audit 2026-11-01). The harness env prefix
// (`$env:CI='true'; …`) is cut from the command and shown as a separate
// «окружение» line — names only for members, values for admin (BUG-01.33).
// A call parked on a permission request reads «ждёт разрешения» (R-15).
// ×N (collapsed identical calls) is an amber loop signal, not an error (R-16).
// Subagent runs (tool:"task"/"subagent") delegate to AgentRuns — the wiring
// that resolves the run against the store's chatRuns (FEAT-01.77).
import { useEffect, useRef } from "preact/hooks";
import {
  fmtClock,
  fmtElapsed,
  isAgentTool,
  isAwaitingPermission,
  splitEnvPrefix,
  toolStepDesc,
} from "../../lib/normalize.js";
import { dialogs, me } from "../../lib/store.js";
import AgentRuns from "./AgentRuns.jsx";
import { t } from "../../lib/i18n.js";

const basename = (p) => String(p ?? "").split(/[\\/]/).pop() || p;

// Человечьи ярлыки инструментов: что ДЕЛАЕТ инструмент, а не его имя.
// websearch = Claude CLI WebSearch (FEAT-13.19).
const TOOL_LABEL_KEYS = new Set(["bash", "read", "write", "edit", "glob", "grep", "list", "webfetch", "websearch", "todowrite", "todoread", "question"]);
const toolLabel = (tool) => (TOOL_LABEL_KEYS.has(tool) ? t("tool.label." + tool) : null);

// ISSUE-013: the question tool's own title is English («Asked 1 question») —
// show the first question itself, else a Russian count.
function questionDesc(st) {
  const qs = Array.isArray(st?.input?.questions) ? st.input.questions : [];
  const first = qs.map((q) => (typeof q?.question === "string" ? q.question.trim() : "")).find(Boolean);
  if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const n = qs.length || Number(/(\d+)/.exec(String(st?.title ?? ""))?.[1]) || 0;
  if (!n) return "";
  return t("tool.questions", { count: n });
}

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4.5 12.5l5 5L19.5 6.5" />
  </svg>
);

const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </svg>
);

const CircleIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
  </svg>
);

const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

// repeat > 1: identical consecutive calls collapsed by collapseToolRuns —
// the count badge is the visible loop alarm.
// summary (FEAT-01.77): callIDs of the turn's top-level agent runs, passed by
// MessageBubble only for the FIRST agent card of the turn — AgentRuns shows
// the turn summary above it.
export default function ToolCard({ part, repeat = 1, summary = null }) {
  if (isAgentTool(part)) return <AgentRuns part={part} repeat={repeat} summary={summary} />;
  const tool = part.tool ?? "tool";
  const st = part.state ?? {};
  const outRef = useRef(null);
  const waiting = isAwaitingPermission(part, dialogs.value, part.sessionID ?? globalThis.__zaiActiveId ?? null);
  const status = waiting ? "waiting" : (st.status ?? "pending");
  const admin = me.value?.role === "admin";

  let output = "";
  if (st.output != null) output = typeof st.output === "string" ? st.output : JSON.stringify(st.output, null, 2);

  const isBash = tool === "bash";
  const rawCommand = isBash ? (st.input?.command ?? st.title ?? "") : null;
  const { command, env } = isBash ? splitEnvPrefix(rawCommand) : { command: null, env: [] };
  const filePath = st.input?.filePath ?? st.input?.file_path ?? st.input?.path ?? null;

  const kindLabel = toolLabel(tool) ?? (typeof tool === "string" && tool ? tool : t("tool.label.generic"));
  const desc = tool === "question" ? questionDesc(st) : filePath ? basename(filePath) : toolStepDesc(part);

  const start = Number(st.time?.start);
  const end = Number(st.time?.end);
  const elapsed =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? fmtElapsed(end - start, true) : "";
  // «14:32 · 4,2с» — когда началось и сколько длилось.
  const clock = fmtClock(st.time?.start);
  const exit = st.metadata?.exit;

  useEffect(() => {
    if (status === "running" && outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output, status]);

  return (
    <div class={"tool-card st-" + status}>
      <details open={status === "error" || null}>
        <summary class="tool-head">
          <span class={"tool-status s-" + status} aria-hidden="true">
            {status === "completed" ? <CheckIcon /> : status === "error" ? <XIcon /> : status === "running" ? <span class="tool-spin" /> : <CircleIcon />}
          </span>
          <span class="tool-name">
            {kindLabel}
            {desc && <span class="tool-desc"> · {desc}</span>}
          </span>
          {waiting && <span class="tool-wait">{t("tool.waiting")}</span>}
          {repeat > 1 && (
            <span class="tool-repeat" title={t("tool.repeat", { count: repeat })}>×{repeat}</span>
          )}
          {!waiting && (clock || elapsed) && (
            <span class="tool-elapsed">{[clock, elapsed].filter(Boolean).join(" · ")}</span>
          )}
          <span class="tool-chevron" aria-hidden="true"><ChevronIcon /></span>
        </summary>
        <div class="tool-body">
          {command != null && command !== "" && <pre class="tool-cmdline">{command}</pre>}
          {env.length > 0 && (
            <span class="tool-env">
              {t("tool.env")} {admin ? env.map((e) => `${e.name}=${e.value}`).join(", ") : env.map((e) => e.name).join(", ")}
            </span>
          )}
          {filePath && !isBash && <pre class="tool-cmdline">{filePath}</pre>}
          {output ? <pre class="tool-output" ref={outRef}>{output}</pre> : null}
          {exit != null && (status === "completed" || status === "error") && (
            <div class={"tool-exit" + (exit !== 0 ? " is-bad" : "")}>
              {t("tool.exitCode", { code: exit })}{repeat > 1 ? ` · ${t("tool.lastOf", { count: repeat })}` : ""}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
