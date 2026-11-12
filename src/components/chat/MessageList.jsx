// Scrollable message list: last-50 window, «Загрузить ещё» widens the window
// from the store, sticks to the bottom while streaming unless the
// user scrolled up, floating jump-to-latest pill otherwise. While the model
// is busy but hasn't produced its first part yet, a typing indicator shows —
// otherwise the gap reads as silence (user feedback 2026-10-31).
//
// live ({since, lastAction, lastActivityAt} | null, from ChatView): while a
// turn runs, a slim line under the feed says how long it has been working
// and what it did last — «is it alive?» from a phone (BUG-13.3 / R-21).
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import MessageBubble from "./MessageBubble.jsx";
import { RelayMark } from "./Relay.jsx";
import { placeRelayMarks } from "../../lib/relay.js";
import { RevertedRow } from "./TurnActions.jsx";
import { livenessLine } from "../../lib/turn.js";
import { loadTurnFiles } from "../../lib/turn-files.js";
import { activeSessionDir, execDetailOn, prefs, sessions } from "../../lib/store.js";
import { compactFeed, revealTarget } from "../../lib/exec-detail.js";
// FEAT-01.77: прелоадер компактной ленты переехал в связку AgentRuns — там
// подписки на агентов, чтобы лента не читала их сама.
import { TurnAgentsPreloader } from "./AgentRuns.jsx";
import { t } from "../../lib/i18n.js";

// FEAT-03.19: with «Детализация выполнения» off (the default) the running turn
// is hidden behind the TurnPreloader (no typing dots, no liveness line) and
// every finished turn shows only its full answer (lib/exec-detail.js).

const PAGE = 50;
const TOP_EDGE = 120; // px from the top that counts as «reached the start»

// Re-render once a second while the turn runs (elapsed counters).
function useTicker(on) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

// Feed announcements for screen readers (BUG-01.38): the feed itself is NOT
// a live region — streamed deltas would be read token by token. A persistent
// polite status line says when the agent starts and when the answer is in.
// FEAT-03.19 (2026-11-04: the view jumped to the end of a long answer and
// the user had to scroll back up): while an answer is being revealed
// the pinned feed follows the growing text only until the START of that answer
// reaches the top of the view (under the header); then it stops, the text keeps
// growing below and the user reads from the beginning. Otherwise — the bottom.
export function followTop(el, revealId) {
  const bottom = el.scrollHeight;
  if (!revealId) return bottom;
  const ans = el.querySelector(`[data-mid="${String(revealId).replace(/"/g, "")}"]`);
  if (!ans) return bottom;
  const head = parseFloat(getComputedStyle(el).getPropertyValue("--chat-head-h")) || 57;
  const start = el.scrollTop + (ans.getBoundingClientRect().top - el.getBoundingClientRect().top) - head - 8;
  return Math.max(0, Math.min(bottom - el.clientHeight, start));
}

export function feedAnnouncement(wasBusy, busy, tail) {
  if (!wasBusy && busy) return t("chat.feed.working");
  if (wasBusy && !busy) return tail?.info?.role === "assistant" ? (tail.info.error ? t("chat.feed.failed") : t("chat.feed.answered")) : t("chat.feed.done");
  return null;
}

// older ({has, loading, error, paged}, BUG-08.8): what is left on the server
// above the oldest loaded message; onLoadOlder() asks the store for the next
// page. Scrolling to the top loads it by itself; the button stays for
// keyboards and as «Повторить» after a failure.
const NO_OLDER = { has: false, loading: false, error: false, paged: false };

export default function MessageList({ sessionId, messages, streamingId, busy = false, live = null, older = NO_OLDER, onLoadOlder, reverted = false }) {
  useTicker(Boolean(live));
  const [announce, setAnnounce] = useState("");
  const wasBusy = useRef(busy);
  // FEAT-03.19: gradual reveal of the answer that has just finished (see render).
  const renderBusy = useRef(busy);
  const renderSid = useRef(sessionId);
  const revealRef = useRef(null);
  const [, setRevealTick] = useState(0);
  // Pinned feed: to the bottom, or — while an answer is revealed — no further
  // than its start. Reaching that cap un-pins explicitly: scrollTop stops
  // changing there, so no scroll event would ever do it, and the end of the
  // reveal would then snap the feed to the bottom (stand dogfood 2026-11-05).
  const follow = (el) => {
    const top = followTop(el, revealRef.current);
    el.scrollTop = top;
    if (revealRef.current && top < el.scrollHeight - el.clientHeight - 80) {
      pinnedRef.current = false;
      setPinned(false);
    }
  };
  const onRevealed = () => {
    revealRef.current = null;
    setRevealTick((n) => n + 1);
  };
  const [windowSize, setWindowSize] = useState(PAGE);
  const [exhausted, setExhausted] = useState(false);
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);
  // A server page asked for (BUG-08.8): {firstId, h0, top} — the first
  // message on screen and the scroll geometry before the prepend.
  const anchorRef = useRef(null);

  useEffect(() => {
    // new session: drop local history window, snap to bottom
    setWindowSize(PAGE);
    revealRef.current = null;
    setExhausted(false);
    anchorRef.current = null;
    pinnedRef.current = true;
    setPinned(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [sessionId]);

  // BUG-092: files the agent made per closed turn (script-made ones too) —
  // re-asked only when a turn closes (the key inside skips repeats).
  useEffect(() => {
    loadTurnFiles(sessionId, activeSessionDir(), messages);
  }, [sessionId, messages]);

  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      follow(scrollRef.current);
    }
  }, [messages]);

  // BUG-08.8: an older page landed in front — widen the window by exactly the
  // prepended count (they would sit outside the last-N window otherwise)…
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a || a.grown) return;
    const at = messages.findIndex((m) => m.info?.id === a.firstId);
    if (at > 0) {
      a.grown = true;
      setWindowSize((w) => w + at);
    } else if (!older.loading) {
      anchorRef.current = null; // failed or empty page: nothing to keep in place
    }
  }, [messages, older.loading]);

  // …and keep the message the user was reading where it was (no jump).
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = scrollRef.current;
    if (!a?.grown || !el) return;
    anchorRef.current = null;
    el.scrollTop = a.top + (el.scrollHeight - a.h0);
  }, [windowSize]);

  // The bottom overlay (stall banner, dialog card, composer growth) changes
  // the scroller's reserved padding without touching `messages`: a feed that
  // was pinned to the bottom must stay there, or its last bubble — including
  // the «Не отправлено» mark — ends up under the banner (BUG-011/BUG-017).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) follow(el);
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const said = feedAnnouncement(wasBusy.current, busy, messages[messages.length - 1]);
    wasBusy.current = busy;
    if (said) setAnnounce(said);
  }, [busy]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = pin;
    setPinned((prev) => (prev === pin ? prev : pin));
    // BUG-08.8: reaching the top reveals / fetches the older messages by itself.
    if (el.scrollTop < TOP_EDGE && hasMore && !older.loading && !older.error && !anchorRef.current) loadOlder();
  };

  const jumpLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTop = el.scrollHeight; // instant: smooth scrolls get cancelled by pill remounts mid-flight
  };

  const detail = execDetailOn(prefs.value);
  const compact = detail ? null : compactFeed(messages, { busy });
  // FEAT-03.19 (уточнение владельца 2026-11-04 ~23:00): the turn that has just
  // finished in front of the user is revealed gradually from its start, like a
  // live stream. Decided during render — on the very render where busy flips
  // off — so the full answer never flashes for a frame and the feed does not
  // jump to its end. History (a chat opened idle) is shown at once.
  if (renderSid.current !== sessionId) {
    // another chat opened: its finished answers are history, never revealed
    renderSid.current = sessionId;
    renderBusy.current = busy;
    revealRef.current = null;
  }
  if (renderBusy.current && !busy && compact) revealRef.current = revealTarget(compact.messages);
  if (busy || detail) revealRef.current = null;
  renderBusy.current = busy;
  const revealId = revealRef.current;
  const all = compact ? compact.messages : messages;
  const visible = all.length > windowSize ? all.slice(all.length - windowSize) : all;
  // FEAT-11.18: отметки передачи чата между движками — из записи чата, по времени
  const relayMarks = placeRelayMarks(visible, sessions.value.find((s) => s.id === sessionId)?.zai?.relays ?? null);
  const hasMore = all.length > visible.length || (older.has && !exhausted);
  // The top of a long paged history is reached: say so instead of a button.
  const historyStart = !hasMore && older.paged;

  // Typing indicator: busy, but the tail of the list is still the user's
  // (or nothing at all) — the assistant hasn't emitted its first part yet.
  const tail = all[all.length - 1];
  const typing = detail && busy && (!tail || tail.info?.role === "user");

  // tokens/cost meta goes under the last completed assistant message
  let lastAssistantId = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].info?.role === "assistant") {
      lastAssistantId = all[i].info.id;
      break;
    }
  }

  // Prepending grows the content above the viewport: compensate scrollTop so
  // the message the user is looking at stays in place.
  function anchorTop(apply) {
    const el = scrollRef.current;
    const h0 = el?.scrollHeight ?? 0;
    apply();
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - h0;
    });
  }

  function loadOlder() {
    if (all.length > visible.length) {
      // store already holds older messages (openSession loads full history):
      // widen the local window, no network round-trip needed.
      anchorTop(() => setWindowSize((w) => Math.min(all.length, w + PAGE)));
      return;
    }
    if (older.has && typeof onLoadOlder === "function") {
      // BUG-08.8: the next page from the server (`before` cursor).
      const el = scrollRef.current;
      anchorRef.current = { firstId: all[0]?.info?.id ?? null, h0: el?.scrollHeight ?? 0, top: el?.scrollTop ?? 0 };
      onLoadOlder();
      return;
    }
    // Nothing older anywhere: retire the button.
    setExhausted(true);
  }

  return (
    <div class="chat-scroll-wrap">
      <div class="chat-messages" ref={scrollRef} onScroll={onScroll}>
        <div class="chat-inner">
          {older.loading ? (
            <div class="load-more" role="status" aria-label={t("chat.older.loadingLabel")}>
              <span class="spin" aria-hidden="true" /> {t("chat.older.loading")}
            </div>
          ) : older.error && all.length === visible.length ? (
            <button class="load-more" type="button" onClick={loadOlder}>{t("chat.older.error")}</button>
          ) : hasMore ? (
            <button class="load-more" type="button" onClick={loadOlder}>{t("chat.older.more")}</button>
          ) : historyStart ? (
            <div class="history-start">{t("chat.older.start")}</div>
          ) : null}
          {visible.map((m, i) => {
            const id = m.info?.id ?? String(i);
            const streaming = id === streamingId;
            const prev = visible[i - 1];
            const marks = relayMarks.before.get(id);
            return (
              <Fragment key={id}>
              {marks ? marks.map((mk) => <RelayMark key={"relay-" + mk.at} mark={mk} />) : null}
              <MessageBubble
                msg={m}
                streaming={streaming}
                showRole={i === 0 || prev?.info?.role !== "assistant"}
                showMeta={!streaming && id === lastAssistantId && m.info?.time?.completed != null}
                reveal={id === revealId}
                onRevealed={onRevealed}
              />
              </Fragment>
            );
          })}
          {relayMarks.tail.map((mk) => <RelayMark key={"relay-" + mk.at} mark={mk} />)}
          {reverted && <RevertedRow sid={sessionId} />}
          {typing && (
            <div class="msg msg-assistant msg-typing" role="status" aria-label={t("chat.typing")}>
              <div class="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
          {/* FEAT-01.77: компактная лента — прелоадер держится, пока busy или
              работают агенты; подпись с именами — у работающих агентов */}
          {compact && <TurnAgentsPreloader busy={busy} />}
          {live && detail && <div class="turn-live">{livenessLine(live)}</div>}
        </div>
      </div>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      {!pinned && (
        <button class="jump-latest" onClick={jumpLatest} aria-label={t("chat.jumpLatest")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  );
}
