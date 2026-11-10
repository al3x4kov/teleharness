// AgentCard: opencode "task" tool = one subagent run, rendered Claude-CLI
// style (CoordinatorTaskPanel pattern): status glyph · agent name · «фоном»
// badge · description, with elapsed + tokens pinned right so they never clip
// (Paddock/CC convention: durations stay per-agent, tokens roll up from the
// child session). Live pieces:
//   • elapsed ticks every second while status is running;
//   • tokens/real duration come from the CHILD session record
//     (metadata.sessionId — it lives in the shared sessions signal, so SSE
//     session.updated refreshes the card for free);
//   • expandable: prompt excerpt, output tail, and a link into the agent's
//     own chat (the child session renders like any other chat).
import { useEffect, useState } from "preact/hooks";
import { sessions } from "../../lib/store.js";
import { fmtClock, fmtElapsed, fmtNum, parseTime } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";

// ru format via the shared helper: «2,3k», not «2.3k» (R-04).
const fmtCount = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return fmtNum(v);
};

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

export default function AgentCard({ part, repeat = 1 }) {
  const st = part.state ?? {};
  const status = st.status ?? "pending";
  const input = st.input ?? {};
  const meta = st.metadata ?? {};

  // description FIRST: the name fallback below reads it (TDZ otherwise —
  // this exact ordering bug shipped a minified "Cannot access 'description'
  // before initialization" crash on 2026-11-01, caught by the QA matrix).
  const description = st.title ?? input.description ?? "";
  // Nothing known about the runner (harness-spawned background task): say so
  // instead of the bare «агент» (live 2026-11-01: 2 of 11 cards were nameless).
  const name = meta.agent ?? input.subagent_type ?? input.agent ?? (description ? t("agent.fallbackName") : t("agent.backgroundTask"));
  const background = input.run_in_background === true;
  const start = Number(st.time?.start);
  const end = Number(st.time?.end);
  const child = meta.sessionId ? (sessions.value.find((s) => s.id === meta.sessionId) ?? null) : null;

  // Ticks only while the agent is actually running — no timers when idle.
  const [now, setNow] = useState(() => Date.now());
  const live = status === "running" || status === "pending";
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  // Duration stays per-agent (never sum parallel children):
  //   running → now-start (ticking);
  //   done with a known child session → child's last activity is the honest
  //   end (a background spawn returns to the parent in ~0.5s, so time.end is
  //   just spawn latency);
  //   done without a child (harness-spawned, invisible to opencode) → the
  //   tool interval for a FOREGROUND run is the real work time; for a
  //   background run that interval is only spawn latency — per the CC
  //   convention it is NOT estimated, the metric is simply omitted.
  let elapsedMs = null;
  if (Number.isFinite(start)) {
    if (live) elapsedMs = Math.max(0, now - start);
    else if (child?.time?.updated != null) elapsedMs = Math.max(0, parseTime(child.time.updated) - start);
    else if (Number.isFinite(end)) {
      elapsedMs = Math.max(0, end - start);
      if (background && elapsedMs < 5000) elapsedMs = null;
    }
  }

  const tokensIn = fmtCount(child?.tokens?.input);
  const tokensOut = fmtCount(child?.tokens?.output);
  // child.cost в $ не рисуем: на подписке это прайс-лик, не траты
  // (фидбек 2026-11-01). Токены остаются.
  const promptExcerpt = String(input.prompt ?? "").slice(0, 300);
  const output = st.output != null ? (typeof st.output === "string" ? st.output : JSON.stringify(st.output)) : "";

  return (
    <div class={"agent-card" + (status === "error" ? " st-error" : "") + (live ? " is-live" : "")}>
      <details>
        <summary class="agent-head">
          <span class={"agent-status " + (live ? "is-live" : "")} aria-hidden="true">
            {status === "error" ? <XIcon /> : live ? <span class="agent-live-dot" /> : <CheckIcon />}
          </span>
          <span class="agent-main">
            <span class="agent-title">
              <span class="agent-name">{name}</span>
              {background && <span class="agent-badge">{t("agent.badge.background")}</span>}
              {repeat > 1 && (
                <span class="agent-badge is-warn" title={t("agent.repeat", { count: repeat })}>×{repeat}</span>
              )}
              {status === "error" && <span class="agent-badge is-err">{t("agent.badge.error")}</span>}
            </span>
            {description && <span class="agent-desc">{description}</span>}
          </span>
          <span class="agent-metrics">
            {(elapsedMs != null || Number.isFinite(start)) && (
              <span class={"agent-elapsed" + (live ? " is-live" : "")}>{[fmtClock(start), elapsedMs != null ? fmtElapsed(elapsedMs) : ""].filter(Boolean).join(" · ")}</span>
            )}
            {(tokensIn || tokensOut) && (
              <span class="agent-tokens">
                {tokensIn ? `↑${tokensIn}` : ""} {tokensOut ? `↓${tokensOut}` : ""}
              </span>
            )}
          </span>
        </summary>
        <div class="agent-body">
          {promptExcerpt && (
            <div class="agent-block">
              <span class="agent-block-label">{t("agent.task")}</span>
              <p class="agent-prompt">{promptExcerpt}{String(input.prompt ?? "").length > 300 ? "…" : ""}</p>
            </div>
          )}
          {output && <pre class="agent-output">{output}</pre>}
          {child && (
            <a class="agent-link" href={"#/chat/" + child.id}>{t("agent.openSession")}</a>
          )}
        </div>
      </details>
    </div>
  );
}
