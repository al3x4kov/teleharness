// Chat: pushed screen wired to the store — header (back / title /
// agent · model / stop), streaming message list, pinned composer.
import { useEffect, useRef, useState } from "preact/hooks";
import { chatBackTarget, lastSourceRoute, navigate } from "../../lib/router.js";
import {
  active,
  busyMap,
  claudeAgents,
  closeSession,
  continueTurn,
  dialogs,
  dismissTurnError,
  firstTexts,
  init,
  loadOlder,
  me,
  openSession,
  pendingMap,
  providerCfg,
  refreshVoice,
  resendLast,
  send,
  sessions,
  sessionsError,
  setActiveId,
  stop,
  userProjects,
  voiceInfo,
} from "../../lib/store.js";
import { displayTitle, firstUserText, revertCut } from "../../lib/normalize.js";
import { lang, t } from "../../lib/i18n.js";
import { bindingLine, bindingOf } from "../../lib/engine.js";
import MessageList from "../chat/MessageList.jsx";
import Composer from "../chat/Composer.jsx";
import ModelBar from "../chat/ModelBar.jsx";
import DialogBar from "../chat/DialogBar.jsx";
import VoiceModeView from "../chat/VoiceModeView.jsx";
import ChatMenu from "../ChatMenu.jsx";
import { micSupported, unlockAudio } from "../../lib/voice-audio.js";
import { greetingText, MenuButton, ZaiMark } from "../Menu.jsx";
import "../chat.css";
import "../dialogs.css";
import "../voice.css";

const SVG = (props) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...props} />
);

// Turn-error banner (BUG-07.14 / R-07): what broke, in Russian, plus the
// way out. Never a silent end of the turn.
function TurnErrorBar({ err, id }) {
  const act = (a) => {
    if (a === "retry") return <button key={a} class="stall-btn" type="button" onClick={() => resendLast(id)}>{t("common.retry")}</button>;
    if (a === "continue") return <button key={a} class="stall-btn" type="button" onClick={() => continueTurn(id)}>{t("chat.continue")}</button>;
    if (a === "settings") return <button key={a} class="stall-btn" type="button" onClick={() => navigate(me.value?.role === "admin" ? "/settings/subscription" : "/settings")}>{t("chat.limits")}</button>;
    return null;
  };
  return (
    <div class="stall-bar turn-error" role="alert">
      <span class="stall-text">
        <b class="turn-error-title">{err.title}.</b> {err.text}
        {/* ISSUE-006: the raw provider text (stack traces) stays folded. */}
        {err.detail && (
          <details class="turn-error-more">
            <summary>{t("chat.details")}</summary>
            <span class="turn-error-detail">{err.detail}</span>
          </details>
        )}
      </span>
      <span class="turn-error-actions">
        {(err.actions ?? []).map(act)}
        <button class="turn-error-close" type="button" aria-label={t("chat.dismiss")} onClick={() => dismissTurnError(id)}>×</button>
      </span>
    </div>
  );
}

// Screen-reader line for a new permission/question card (BUG-01.38).
export function dialogAnnouncement(d) {
  if (!d) return "";
  if (d.kind === "permission") return d.command ? t("chat.announce.permissionCmd", { command: String(d.command).slice(0, 120) }) : t("chat.announce.permission");
  const q = (d.questions ?? []).map((x) => (typeof x?.question === "string" ? x.question.trim() : "")).find(Boolean);
  return q ? t("chat.announce.questionText", { question: q.slice(0, 160) }) : t("chat.announce.question");
}

export default function ChatView({ id }) {
  const known = sessions.value.find((s) => s.id === id) ?? null;
  // Glass-overlay geometry (CHALLENGE M3): the header and the bottom stack
  // (stall / DialogBar / composer) are absolute overlays; the
  // scroller reserves their live heights through these vars — real
  // measurement, never the mock's fixed constants.
  const headRef = useRef(null);
  const bottomRef = useRef(null);
  // FEAT-06.2: the open voice mode ({ctx} — the AudioContext unlocked by the tap).
  const [voiceMode, setVoiceMode] = useState(null);
  useEffect(() => {
    refreshVoice(); // once per page: does the server have the voice mode?
  }, []);
  useEffect(() => setVoiceMode(null), [id]);

  useEffect(() => {
    const chat = headRef.current?.parentElement;
    if (!chat) return undefined;
    const apply = () => {
      chat.style.setProperty("--chat-head-h", `${headRef.current?.offsetHeight ?? 0}px`);
      chat.style.setProperty("--chat-bottom-h", `${bottomRef.current?.offsetHeight ?? 0}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    if (headRef.current) ro.observe(headRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    init(); // bootstraps sessions/providers/SSE; safe to call repeatedly
    // Uploads and file chips resolve the open chat's folder through the
    // store's activeId (TASK-01.42 — no more globalThis stamp).
    setActiveId(id);
    if (active.value?.id !== id) openSession(id);
    return () => {
      closeSession(id);
      setActiveId(null);
    };
  }, [id]);

  const act = active.value;
  // Gate on ownership: between sessions active briefly holds the OLD chat (or
  // null). Rendering the empty hero in that window flashed «Чем займёмся?» on
  // every chat-to-chat transition — treat «not mine» as loading instead.
  const mine = act?.id === id ? act : null;
  // FEAT-01.57/01.58: a hidden last turn (session revert) is cut from the
  // feed; «Ход отменён · Вернуть» stands in its place.
  const revert = known?.revert?.messageID ? known.revert : null;
  const { shown: messages, hidden: hiddenCount } = revertCut(mine?.messages ?? [], revert);
  const reverted = Boolean(revert) && (hiddenCount > 0 || !mine?.loading);
  const status = mine?.status ?? "idle";
  const busy = status === "busy" || status === "stopping";

  const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
  const streaming = busy && lastAssistant != null && lastAssistant.info.time?.completed == null;

  // Approval cards render HERE, above the composer — only this chat's dialogs.
  // Dialogs of other sessions wait in the store and surface as the
  // «⏸ разрешение» badge on their chat card in the home list.
  const [activeDialog, ...queuedDialogs] = dialogs.value.filter((d) => d.sessionID === id || !d.sessionID);

  // The chat's OWN binding (server `zai` record) — never the Settings
  // defaults: those only seed new chats (BUG-11.1). Claude chats show their
  // portal agent or «Claude Code» (FEAT-13.17), never an opencode one
  // (BUG-11.2). History is the fallback for a not-yet-listed chat.
  const binding = bindingOf(known);
  const subline =
    bindingLine(binding, providerCfg.value, claudeAgents.value ?? []) ||
    [lastAssistant?.info.agent, lastAssistant?.info.modelID].filter(Boolean).join(" · ");
  // displayTitle maps the upstream default «New session - <ISO>» to «Без
  // названия» — same face as the chat list; raw machine text in the header
  // (live 2026-11-01) looked like a bug.
  // BUG-01.27: with the first user text (snapshot included) a title retold
  // from the vault snapshot is replaced by the start of the typed question.
  // A new title (server auto-title: session.updated / zai.session.title)
  // re-renders through the sessions/active signals — no reload (BUG-083).
  // BUG-08.8: a paged history (older pages left) does not start with the
  // first question — the list's remembered one stands in.
  const title = displayTitle(known?.title || mine?.title || "", mine?.hasOlder ? firstTexts.value[id] : firstUserText(messages));
  // BUG-099: on a reload the chat list arrives after the history — the header
  // used to flash «Без названия» → the first question + raw model id → the
  // real title. Until the chat is known (or the list/history settled without
  // it) the header stays blank.
  const titleReady = !!known || !!mine?.title || !!mine?.loadError || sessions.value.length > 0 || sessionsError.value;
  // BUG-101: ссылка на удалённый чат — писать некуда: ни композера с
  // пилюлями, ни «Без названия / …» в шапке; единственное действие — «К чатам».
  const notFound = messages.length === 0 && !!mine && !mine.loading && !!mine.loadError && !known;

  // Tab title follows the open chat (desktop convenience; mobile ignores it).
  useEffect(() => {
    const prev = document.title;
    document.title = title && title !== t("common.untitled") ? `${title} · ${t("common.app")}` : `${t("common.chat")} · ${t("common.app")}`;
    return () => {
      document.title = prev;
    };
  }, [id, title, lang.value]);

  // «Назад» returns to the source (R-23): the project the chat was opened
  // from, or — on a deep link — the chat's own user project; else «Чаты».
  const backTarget = chatBackTarget({ from: lastSourceRoute(), directory: known?.directory ?? null, projects: userProjects.value });
  const goBack = () => navigate(backTarget);
  // FEAT-09.20: чат из «Чатов» — кнопка ☰ бокового меню (как в приложении
  // Claude); чат из проекта — «Назад» в проект (R-23, скрин 2188).
  const fromProject = backTarget.startsWith("/project/");

  // Idle-poisoned chat: the server tracked an unanswered prompt and the
  // session is not running (no spinner anywhere) — this banner is the only
  // honest face of that state. Once replays are exhausted, the user gets the
  // manual exit: resend the last user message (clean text + files).
  const pending = pendingMap.value[id];
  const turnError = mine?.turnError ?? null;
  const incomplete = !busy && !turnError ? mine?.incomplete ?? null : null;
  // Failed (never sent) bubbles do not lock the engine pills (CC-23).
  const hasMessages = messages.some((m) => !m.info?.failed);

  // FEAT-01.69: the composer hides its stop while a follow-up is typed
  // during a turn (send = queue) — then the header carries «Стоп».
  const [composerStopHidden, setComposerStopHidden] = useState(false);
  const headStop = busy && (composerStopHidden || notFound);

  // Liveness line (BUG-13.3 / R-21): how long the turn runs and what it did last.
  const live = busy && mine
    ? { since: busyMap.value[id] ?? null, lastAction: mine.lastAction ?? null, lastActivityAt: mine.lastActivityAt ?? null }
    : null;

  return (
    <div class="chat">
      <header class="chat-header" ref={headRef}>
        {fromProject ? (
          <button class="icon-btn float-btn" onClick={goBack} aria-label={t("common.back")}>
            <SVG><path d="M15 18l-6-6 6-6" /></SVG>
          </button>
        ) : (
          <MenuButton />
        )}
        <div class="chat-heading">
          <h1 class="chat-title">{titleReady && !notFound ? title : " "}</h1>
          {notFound ? null : <div class="chat-sub">{(titleReady && subline) || "…"}</div>}
        </div>
        {/* FEAT-01.69: справа только «⋯» (по требованию — только меню).
            «Стоп» хода живёт в композере; когда там вместо него «Отправить»
            (во время хода набран текст — встанет в очередь), шапка
            показывает «Стоп» слева от «⋯», чтобы остановка не пропадала. */}
        <div class={"chat-head-actions" + (headStop ? " has-stop" : "")}>
          {headStop && (
            <button class="icon-btn float-btn stop-btn" onClick={stop} disabled={status === "stopping"}
              aria-label={status === "stopping" ? t("chat.stopping") : t("chat.stop")}>
              {status === "stopping" ? (
                <span class="spin" aria-hidden="true" />
              ) : (
                <SVG><rect x="7.5" y="7.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" /></SVG>
              )}
            </button>
          )}
          {/* Н12: у «не найденного» чата управлять нечем — «⋯» нет. */}
          {!notFound && (titleReady || known) ? (
            <ChatMenu
              sessionId={id}
              busy={busy}
              empty={!hasMessages && !reverted && !(mine?.loading)}
              onDeleted={() => navigate(backTarget, { replace: true })}
            />
          ) : null}
        </div>
      </header>
      {messages.length === 0 && !reverted ? (
        <div class="chat-scroll-wrap">
          <div class="chat-empty">
            {!mine || mine.loading ? (
              <div class="chat-skeleton" role="status" aria-label={t("chat.loadingHistory")}>
                <span class="sk sk-user" />
                <span class="sk sk-assistant" />
                <span class="sk sk-user sk-short" />
                <span class="sk sk-assistant sk-long" />
              </div>
            ) : mine.loadError && !known ? (
              <>
                <h2 class="hero">{t("chat.notFound.title")}</h2>
                <p class="hint">{t("chat.notFound.text")}</p>
                <button class="btn-primary empty-cta" type="button" onClick={() => navigate("/")}>
                  {t("chat.notFound.back")}
                </button>
              </>
            ) : mine.loadError ? (
              // History fetch died but the chat IS in the list (edge 404, network):
              // the empty hero here once masked a full portal outage (2026-11-02).
              <>
                <h2 class="hero">{t("chat.historyError.title")}</h2>
                <p class="hint">{t("chat.historyError.text")}</p>
                <button class="btn-primary empty-cta" type="button" onClick={() => openSession(id)}>
                  {t("common.retry")}
                </button>
              </>
            ) : (
              <div class="chat-greeting" data-req="FEAT-09.20">
                <ZaiMark size={44} />
                <h2 class="hero greeting">{greetingText(new Date().getHours(), me.value?.name)}</h2>
              </div>
            )}
          </div>
        </div>
      ) : (
        <MessageList
          sessionId={id}
          messages={messages}
          streamingId={streaming ? lastAssistant.info.id : null}
          busy={status === "busy"}
          live={live}
          older={{ has: !!mine?.hasOlder, loading: !!mine?.loadingOlder, error: !!mine?.olderError, paged: !!mine?.olderLoaded }}
          onLoadOlder={() => loadOlder(id)}
          reverted={reverted}
        />
      )}
      {/* BUG-01.38: the DialogBar mounts fresh per request, so it cannot be
          its own live region — this persistent line announces it. */}
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{dialogAnnouncement(activeDialog)}</div>
      <div class="chat-bottom" ref={bottomRef}>
        {/* FEAT-07.22: no client «Ответа долго нет» banner — the «Работает ·
            последнее действие · N назад» line shows silence, ■ stops the turn. */}
        {turnError && !busy && !activeDialog ? <TurnErrorBar err={turnError} id={id} /> : null}
        {incomplete && !activeDialog ? (
          <div class="stall-bar" role="status">
            <span class="stall-text">
              {incomplete.reason === "open-todos"
                ? (incomplete.todosOpen
                  ? (incomplete.todosTotal
                    ? t("chat.incomplete.todosOf", { open: incomplete.todosOpen, total: incomplete.todosTotal })
                    : t("chat.incomplete.todos", { open: incomplete.todosOpen }))
                  : t("chat.incomplete.agent"))
                : t("chat.incomplete.turn")}
            </span>
            <button class="stall-btn" type="button" onClick={() => continueTurn(id)}>{t("chat.continue")}</button>
          </div>
        ) : null}
        {pending && !busy && !turnError && !activeDialog ? (
          pending.replays >= pending.max ? (
            <div class="stall-bar" role="alert">
              <span class="stall-text">{t("chat.stall.noReply")}</span>
              <button class="stall-btn" onClick={() => resendLast(id)}>{t("chat.stall.resend")}</button>
            </div>
          ) : (
            <div class="stall-bar" role="status">
              <span class="stall-text">
                {t("chat.stall.replaying", { attempt: pending.replays + 1, max: pending.max })}
              </span>
            </div>
          )
        ) : null}
        {activeDialog && (
          <DialogBar key={activeDialog.id} dialog={activeDialog} queue={queuedDialogs.length} />
        )}
        {notFound ? null : (
          <footer class="composer">
            <ModelBar sessionId={id} hasMessages={hasMessages} />
            <Composer
              key={id}
              sessionId={id}
              status={status}
              onStop={stop}
              onStopHidden={setComposerStopHidden}
              model={binding?.model ?? null}
              onSend={(text, attachments) => send({ text, attachments, sessionId: id })}
              onVoiceMode={voiceInfo.value?.enabled && micSupported() ? () => setVoiceMode({ ctx: unlockAudio() }) : null}
            />
          </footer>
        )}
      </div>
      {voiceMode && <VoiceModeView sessionId={id} ctx={voiceMode.ctx} onClose={() => setVoiceMode(null)} />}
    </div>
  );
}
