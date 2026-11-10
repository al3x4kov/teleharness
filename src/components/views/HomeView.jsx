// Home: search + date-grouped session list from the store, swipe-to-actions
// rows (rename/delete) and the new-chat action. Agent/model defaults live in
// Settings (store.prefs); «Новый чат» creates a chat immediately with them —
// no picker sheet on every chat (user request 2026-10-31).
// Also wires store.setNavigate once so createAndOpen can route.
import { useEffect, useRef, useState } from "preact/hooks";
import "../../app.css"; // tokens first; component css second — esbuild keeps order
import "../views.css";
import {
  busyMap,
  createAndOpen,
  deleteSessionById,
  dialogs,
  explainApiError,
  firstTexts,
  init,
  agents,
  pins,
  PINNED_FOLD,
  splitPinned,
  refreshSessions,
  renameSession,
  sessions,
  setNotice,
} from "../../lib/store.js";
import { displayTitle, groupSessionsByDate, isHiddenDir, isSubagentSession, parseTime } from "../../lib/normalize.js";
import { Glyph, useModalFocus } from "../Pickers.jsx";
import { MenuButton, PinIcon } from "../Menu.jsx";
import { bindingOf } from "../../lib/engine.js";
import { locale, t } from "../../lib/i18n.js";

const SWIPE_W = 130; // keep in sync with --swipe-w in views.css

// ---- list loading with an honest failure state (BUG-01.40) ----------------
// An outage used to render as «Чем займёмся?» / «Проектов пока нет». The
// store's sessionsError signal tells a failed GET /session from an empty
// list: still empty after init() → one more refresh through the store; a
// failure shows «Не удалось загрузить · Повторить». A non-empty list is
// trusted as-is (a stale list beats an error wall).
export async function loadSessionList() {
  try {
    await init();
  } catch {}
  if (sessions.value.length > 0) return true;
  return refreshSessions();
}

// [state, retry]: state is "loading" | "ready" | "error". Shared by Home,
// Projects and the project screen — all three render the same session list.
export function useSessionList() {
  const [state, setState] = useState(sessions.value.length > 0 ? "ready" : "loading");
  const load = async () => {
    setState("loading");
    setState((await loadSessionList()) ? "ready" : "error");
  };
  useEffect(() => {
    if (sessions.value.length === 0) load();
  }, []);
  return [state, load];
}

// Error card shared by the list screens: what failed + one obvious action.
export function LoadError({ what, onRetry }) {
  return (
    <div class="load-error" role="alert">
      <p class="load-error-title">{t("home.loadFailed", { what })}</p>
      <p class="load-error-hint">{t("home.loadFailedHint")}</p>
      <button class="btn" type="button" onClick={onRetry}>{t("common.retry")}</button>
    </div>
  );
}

// «Назад» from a chat (BUG-02.6 / R-23) is decided by the router alone:
// chatBackTarget(lastSourceRoute()) in ChatView — the screen the chat was
// opened from (Home, Projects, a project, incl. «Новый чат» there).

// The name a chat row shows (BUG-01.27 / BUG-083): the server title; while
// there is none (a Claude chat before its auto-title, a fresh opencode chat)
// — the start of the first question if this tab saw it (firstTexts, the same
// displayTitle rule as the chat header), else «Без названия». A title retold
// from the vault snapshot is replaced the same way. Reads the signal, so a
// title arriving by SSE (session.updated / zai.session.title) re-renders.
export function chatTitle(s) {
  return displayTitle(s?.title, (s?.id && firstTexts.value[s.id]) || null);
}

// Human name of a chat for confirmations: «Без названия» alone tells nothing
// about WHICH chat goes away — add its date (H-1).
export function chatNameForConfirm(s) {
  const title = chatTitle(s);
  if (title !== t("common.untitled")) return t("home.quoted", { title });
  const ms = parseTime(s?.time?.created ?? s?.time?.updated);
  if (!Number.isFinite(ms)) return t("home.untitledChat");
  const when = new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return t("home.untitledChatFrom", { when });
}

export function fmtWhen(v) {
  const ms = parseTime(v);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  return ms >= today0.getTime()
    ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

export function metaText(s) {
  // Только дата: агент·модель повторялись в каждом ряду (дефолт один и тот
  // же) — это шум, а не данные (редизайн 2026-11-01). Конфигурация чата
  // видна в его шапке и в Настройках.
  return fmtWhen(s?.time?.updated);
}

// Workload of a session in tokens (input+output+reasoning; cache reads are
// noise). On a credit-based subscription the API-list price in $ is NOT money
// the user pays (2026-11-01 feedback) — tokens are the honest heaviness
// metric, they map to the credit windows shown in Настройки.
export function tokensTotal(s) {
  const t = s?.tokens;
  if (!t || typeof t !== "object") return 0;
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
}

// "2,6M" / "34,5k" / "812" — compact; ru decimal comma, trailing ,0 trimmed.
export function fmtTokensShort(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e6) return (Math.round(n / 1e5) / 10).toLocaleString(locale()).replace(/[,.]0$/, "") + "M";
  if (n >= 1000) return (Math.round(n / 100) / 10).toLocaleString(locale()).replace(/[,.]0$/, "") + "k";
  return String(n);
}

// Row run state (FEAT-01.31): an open dialog wins over «busy» — the turn is
// parked on the user, not working.
export function rowState(id) {
  if (dialogs.value.some((d) => d.sessionID === id)) return "waiting";
  if (busyMap.value[id]) return "busy";
  return null;
}

export function SessionBody({ session: s, pinned = false }) {
  const tokens = tokensTotal(s);
  const state = rowState(s.id);
  return (
    <>
      {pinned && (
        <span class="row-pin" title={t("home.pinned")} aria-label={t("home.pinned")} role="img">
          <PinIcon size={15} />
        </span>
      )}
      <div class="session-main">
        <div class="session-title">{chatTitle(s)}</div>
        <div class="session-meta-row">
          <span class="session-meta" title={t("home.tokensTitle")}>
            {metaText(s)}{tokens >= 1000 ? ` · ${fmtTokensShort(tokens)}` : ""}
          </span>
          {/* BUG-154: состояние — под заголовком, а не колонкой справа: на 402px
              «работает» + «Claude» съедали заголовок до «Проверка зад…». */}
          {state === "waiting" && (
            <span class="badge badge-warn" title={t("home.badge.waitingTitle")}>⏸ {t("home.badge.waiting")}</span>
          )}
          {state === "busy" && (
            <span class="badge badge-busy" title={t("home.badge.busyTitle")}>
              <span class="busy-dot" aria-hidden="true" />{t("home.badge.busy")}
            </span>
          )}
        </div>
      </div>
      {/* Only the non-default engine is marked: a z.ai badge on every row
          would be noise (the 2026-11-01 redesign removed per-row model). */}
      {bindingOf(s)?.engine === "claude" && (
        <span class="badge-engine" title={t("home.badge.claudeTitle")}>
          <span class="engine-dot is-claude" aria-hidden="true" />Claude
        </span>
      )}
    </>
  );
}

// Plain row link (no swipe) — shared with ProjectsView.
export function SessionLine({ session: s }) {
  return (
    <a class="session-row" href={"#/chat/" + s.id}>
      <SessionBody session={s} />
    </a>
  );
}

// Swipe-left row: the content translates to reveal rename/delete; on
// hover-capable pointers the action cluster simply fades in on the right.
// Touch listeners are attached natively: on desktop Chrome "ontouchmove" is
// not an element property, so preact would derive the event name "TouchMove"
// and the props would never fire there.
// origin: kept for call-site compatibility; «Назад» comes from the router.
export function SessionRow({ session: s, open, onOpen, onRename, onDelete, origin = "/", pinned = false }) {
  const contentRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const drag = useRef(null);
  const movedAt = useRef(0);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const restOffset = () => (openRef.current ? -SWIPE_W : 0);

    const onTouchStart = (e) => {
      const t = e.touches[0];
      drag.current = { x: t.clientX, y: t.clientY, dx: 0, intent: false, t: Date.now() };
    };

    const onTouchMove = (e) => {
      const d = drag.current;
      if (!d) return;
      const t = e.touches[0];
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;
      if (!d.intent) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) <= Math.abs(dy)) {
          drag.current = null; // vertical scroll wins
          return;
        }
        d.intent = true;
        el.style.transition = "none";
      }
      e.preventDefault();
      d.dx = dx;
      let off = restOffset() + dx;
      if (off > 0) off /= 3; // rubber-band past the rest position
      const min = -SWIPE_W - 24;
      if (off < min) off = min + (off - min) / 3;
      el.style.transform = `translateX(${off}px)`;
    };

    const onTouchEnd = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      el.style.transition = "";
      if (!d.intent) return;
      movedAt.current = Date.now();
      el.style.transform = ""; // class-driven transform + css transition take over
      const off = restOffset() + d.dx;
      const fast = Date.now() - d.t < 250;
      const nextOpen = off < -SWIPE_W / 2 || (fast && d.dx < -24);
      onOpenRef.current?.(nextOpen ? s.id : null);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  function onClick(e) {
    if (Date.now() - movedAt.current < 350) {
      e.preventDefault(); // the gesture just ended; this click is not a tap
      return;
    }
    if (open) {
      e.preventDefault();
      onOpen?.(null); // first tap on an open row closes it
      return;
    }
  }

  const name = chatTitle(s);
  return (
    <div class={"swipe" + (open ? " is-open" : "")}>
      <a class={"session-row swipe-content" + (pinned ? " is-pinned" : "")} href={"#/chat/" + s.id} ref={contentRef} onClick={onClick}>
        <SessionBody session={s} pinned={pinned} />
      </a>
      {/* ISSUE-014: the actions come AFTER the row link in DOM order — Tab
          forward from the row reaches ✎/🗑 (they used to precede it, so only
          Shift+Tab found them). Absolute positioning keeps the look. */}
      <div class="swipe-actions">
        <button class="swipe-action" type="button" aria-label={t("home.renameChatNamed", { name })} onClick={() => onRename?.(s)}>
          <Glyph name="pencil" />
        </button>
        <button class="swipe-action is-danger" type="button" aria-label={t("home.deleteChatNamed", { name })} onClick={() => onDelete?.(s)}>
          <Glyph name="trash" />
        </button>
      </div>
    </div>
  );
}

// Modal shell shared with ProjectsView (add-project, remove-project).
// Focuses the dialog on open: a keyboard user starts tabbing inside, and the
// trigger button under the backdrop can't be re-fired by Enter.
// BUG-01.38: Tab stays inside the dialog; closing returns focus to the
// control that opened it (✎/🗑 of the row, «Добавить проект»).
export function Modal({ title, onClose, children }) {
  const dlgRef = useRef(null);
  useModalFocus(dlgRef);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    addEventListener("keydown", onKey);
    dlgRef.current?.focus();
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dlgRef}>
        <h2 class="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// П31.Н7: a chat name longer than this is refused in the modal (counter).
export const TITLE_MAX = 200;

export function RenameModal({ session, onSave, onClose }) {
  // BUG-015: the upstream default «New session - <ISO>» is machine text — the
  // list shows it as «Без названия», so the field starts empty for it.
  const shown = chatTitle(session);
  const [title, setTitle] = useState(shown === t("common.untitled") ? "" : shown);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      alive.current = false;
    };
  }, []);
  // ISSUE-007: onSave resolves null on success (the caller closes the modal)
  // or an error text — then the modal stays open with the typed name and
  // shows the error inside, ready for another try.
  const tooLong = [...title.trim()].length > TITLE_MAX;
  const save = async () => {
    const name = title.trim();
    if (!name || saving || tooLong) return;
    // П31.Н7: the same name — nothing to send.
    if (name === shown) {
      onClose?.();
      return;
    }
    setSaving(true);
    setError(null);
    let res = null;
    try {
      res = await onSave(name);
    } catch (err) {
      res = err?.message || t("home.renameFailed");
    }
    if (!alive.current) return;
    setSaving(false);
    if (typeof res === "string" && res) {
      setError(res);
      inputRef.current?.focus();
    }
  };
  return (
    <Modal title={t("home.renameChat")} onClose={onClose}>
      <input
        ref={inputRef} class="modal-input" value={title}
        aria-label={t("home.chatName")} placeholder={t("home.chatNamePlaceholder")}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "rename-error" : undefined}
        onInput={(e) => {
          setTitle(e.currentTarget.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      {[...title].length > TITLE_MAX - 20 && (
        <p class={"modal-count" + (tooLong ? " is-over" : "")} aria-live="polite">
          {[...title.trim()].length} / {TITLE_MAX}{tooLong ? t("home.nameTooLong") : ""}
        </p>
      )}
      {error && <p class="modal-error" id="rename-error" role="alert">{error}</p>}
      <div class="modal-actions">
        <button class="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
        <button class="btn-primary" type="button" onClick={save} disabled={!title.trim() || saving || tooLong}>
          {saving ? t("home.saving") : t("common.save")}
        </button>
      </div>
    </Modal>
  );
}

// BUG-01.41 п.1: the raw upstream title («New session - <ISO>») never reaches
// the confirmation — displayTitle() + the date for untitled chats.
// FEAT-01.69: busy — the chat is answering right now (П31.Н5: the turn is
// stopped first, the dialog says so); pending — the delete is in flight
// (Н8: the button is inert, one request).
export function DeleteModal({ session, onConfirm, onClose, busy = false, pending = false }) {
  return (
    <Modal title={t("home.deleteChatQ")} onClose={onClose}>
      <p class="modal-text">{t("home.deleteChatText", { name: chatNameForConfirm(session) })}</p>
      {busy && <p class="modal-warn" role="status">{t("home.deleteBusy")}</p>}
      <div class="modal-actions">
        <button class="btn" type="button" onClick={onClose} disabled={pending}>{t("common.cancel")}</button>
        <button class="btn-danger" type="button" onClick={onConfirm} disabled={pending} aria-busy={pending ? "true" : undefined}>
          {pending ? t("home.deleting") : t("common.delete")}
        </button>
      </div>
    </Modal>
  );
}

export default function HomeView() {
  const [query, setQuery] = useState("");
  const [loadState, retry] = useSessionList();
  const ready = loadState === "ready";
  const [openId, setOpenId] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [creating, setCreating] = useState(false);

  async function newChat() {
    if (creating) return;
    setCreating(true);
    try {
      await createAndOpen(); // uses prefs (Settings); navigate happens inside
    } catch (err) {
      // A silent reset reads as a dead button — say what happened instead,
      // in the server's own words for a policy refusal (ISSUE-002).
      setCreating(false);
      setNotice(explainApiError(err, t("home.createFailed")), 10_000);
    }
  }

  const q = query.trim().toLowerCase();
  // System/harness junk never belongs in Чаты: hidden directories (System32,
  // Temp\oc_*) AND tool-spawned sessions («look_at: …» — subagent machinery
  // that leaked into the list, 2026-11-01 feedback).
  const visible = sessions.value.filter(
    (s) => !isHiddenDir(s.directory) && !isSubagentSession(s, agents.value),
  );
  const filtered = q
    ? visible.filter((s) => (s.title ?? "").toLowerCase().includes(q) || chatTitle(s).toLowerCase().includes(q))
    : visible;
  // FEAT-01.69: «Закреплённые» — над датами, в порядке закрепления; в датах
  // их уже нет. Н14: больше PINNED_FOLD — «Ещё N».
  const { pinned, rest } = splitPinned(filtered, pins.value);
  const [pinsOpen, setPinsOpen] = useState(false);
  const pinnedShown = pinsOpen || pinned.length <= PINNED_FOLD + 1 ? pinned : pinned.slice(0, PINNED_FOLD);
  const groups = groupSessionsByDate(rest);
  const isEmpty = ready && visible.length === 0;

  return (
    <div class="page">
      <header class="page-header">
        <MenuButton />
        <h1>{t("common.chats")}</h1>
        {!isEmpty && ready && (
          <button class="icon-btn page-action" type="button" aria-label={t("home.newChat")} onClick={newChat} disabled={creating}>
            <Glyph name="plus" size={22} />
          </button>
        )}
      </header>
      {loadState === "error" ? (
        <LoadError what={t("home.what.chats")} onRetry={retry} />
      ) : isEmpty ? (
        <div class="empty">
          <h2 class="hero">{t("home.emptyHero")}</h2>
          <p class="hint">{t("home.emptyHint")}</p>
          <button class="btn-primary empty-cta" type="button" onClick={newChat} disabled={creating}>
            <Glyph name="plus" /> {creating ? t("home.creating") : t("home.newChat")}
          </button>
        </div>
      ) : !ready ? (
        <div class="sk-list" role="status" aria-label={t("home.loadingChats")}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div class="sk-row" key={i}>
              <div class="sk sk-title" />
              <div class="sk sk-meta" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <input
            class="search home-search" type="search" placeholder={t("home.search")} value={query}
            aria-label={t("home.search")} autocomplete="off" spellcheck={false}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          {filtered.length === 0 ? (
            <p class="hint" role="status">
              {t("pickers.nothingFound", { query: query.trim() })}{" "}
              <button class="link-btn" type="button" onClick={() => setQuery("")}>{t("home.resetSearch")}</button>
            </p>
          ) : (
            <>
            {pinned.length > 0 && (
              <section class="group group-pinned" key="pinned" data-req="FEAT-01.69">
                <h2 class="group-label">{t("home.pinnedGroup")}</h2>
                {pinnedShown.map((s) => (
                  <SessionRow
                    key={s.id} session={s} open={openId === s.id} pinned
                    onOpen={(id) => setOpenId(id)}
                    onRename={setRenaming} onDelete={setDeleting}
                  />
                ))}
                {pinned.length > pinnedShown.length ? (
                  <button class="link-btn pins-more" type="button" onClick={() => setPinsOpen(true)}>
                    {t("home.more", { count: pinned.length - pinnedShown.length })}
                  </button>
                ) : pinsOpen && pinned.length > PINNED_FOLD + 1 ? (
                  <button class="link-btn pins-more" type="button" onClick={() => setPinsOpen(false)}>{t("home.collapse")}</button>
                ) : null}
              </section>
            )}
            {groups.map((g) => (
              <section class="group" key={g.key}>
                <h2 class="group-label">{g.label}</h2>
                {g.items.map((s) => (
                  <SessionRow
                    key={s.id} session={s} open={openId === s.id}
                    onOpen={(id) => setOpenId(id)}
                    onRename={setRenaming} onDelete={setDeleting}
                  />
                ))}
              </section>
            ))}
            </>
          )}
        </>
      )}
      {renaming && (
        <RenameModal
          session={renaming} onClose={() => setRenaming(null)}
          onSave={async (title) => {
            let error = null;
            const ok = await renameSession(renaming.id, title, { onError: (m) => (error = m) });
            if (!ok) return error ?? t("home.renameFailed");
            setRenaming(null);
            setOpenId(null);
            return null;
          }}
        />
      )}
      {deleting && (
        <DeleteModal
          session={deleting} onClose={() => setDeleting(null)}
          onConfirm={() => {
            deleteSessionById(deleting.id);
            setDeleting(null);
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}
