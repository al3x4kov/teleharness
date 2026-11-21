// FEAT-20.2: «Доска» — вся текущая агентная работа пользователя в четырёх
// секциях: «Ждёт вас», «Работает», «Готово — не просмотрено», «Упало или
// остановлено» (+ «Неизвестно» при недоступном источнике, свёрнутые «Отложено»
// и «Старше 7 дней»). Сверху — сводка «Пока вас не было». Состояние считает
// сервер (GET /teleharness/api/attention); здесь — только показ и действия.
// Макет: design/mockups-v2/epic20-attention-board.html; бриф BRIEF-20.2.
import { useEffect, useRef, useState } from "preact/hooks";
import "../../app.css";
import "../views.css";
import "../board.css";
import { api } from "../../lib/api.js";
import {
  ackAway, ago, board, boardStatus, hhmm, itemMeta, markSeen, markSectionSeen, matches, plural, projectLabel, reasonText,
  refreshBoard, scheduleBoardRefresh, SECTION, serverNow, snooze, startBoard, timeShort, timeText,
} from "../../lib/attention.js";
import { connection, createAndOpen, explainApiError, init, pins, saveDraft, setNotice, togglePin } from "../../lib/store.js";
import { navigate } from "../../lib/router.js";
import { t } from "../../lib/i18n.js";
import { MenuButton, PinIcon } from "../Menu.jsx";
import { useModalFocus } from "../Pickers.jsx";
import ReviewQueue from "./ReviewQueue.jsx"; // FEAT-20.1: вкладка «Ждёт ревью»

const MAIN = ["needs", "working", "done", "failed"];
const PHONE_LIMIT = 5;
export const CONTINUE_TEXT = "Продолжай с места остановки";

// Значок состояния (вместе со словом — цвет не единственный носитель смысла).
export function StateIcon({ state, size = 20 }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
  if (state === "needs") return <svg {...p}><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-7a1.5 1.5 0 0 1 3 0V12M14 12V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.3 15.6a1.5 1.5 0 0 1 2.4-1.8L8 16" /></svg>;
  if (state === "working") return <svg {...p}><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 7v5l3 2" /></svg>;
  if (state === "done") return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16 9.5" /></svg>;
  if (state === "failed") return <svg {...p}><path d="M12 3.5 2.8 19.5h18.4Z" /><path d="M12 10v4.5M12 17.2v.3" /></svg>;
  if (state === "snoozed") return <svg {...p}><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 1.5M4.5 4.5 7 2.5M19.5 4.5 17 2.5" /></svg>;
  if (state === "older") return <svg {...p}><path d="M4 7h16M6 7v12h12V7M10 11h4" /></svg>;
  return <svg {...p}><circle cx="12" cy="12" r="9" stroke-dasharray="3 3" /><path d="M9.8 9.5a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.7M12 16.5v.3" /></svg>;
}

const keySid = (key) => (key.startsWith("chat:") ? key.slice(5) : null);

function Confirm({ title, children, ok, okClass = "", onOk, onCancel }) {
  const ref = useRef(null);
  useModalFocus(ref);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  return (
    <div class="bd-scrim" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div class="bd-dialog" role="dialog" aria-modal="true" aria-labelledby="bd-dialog-title" ref={ref}>
        <h2 id="bd-dialog-title">{title}</h2>
        <div class="bd-dialog-text">{children}</div>
        <div class="bd-dialog-actions">
          <button type="button" class="bd-btn" onClick={onCancel}>{t("board.cancel")}</button>
          <button type="button" class={"bd-btn bd-primary " + okClass} onClick={onOk}>{ok}</button>
        </div>
      </div>
    </div>
  );
}

// Меню «⋯» элемента.
function ItemMenu({ it, offline, onClose, onStop }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && onClose();
    const k = (e) => e.key === "Escape" && onClose();
    setTimeout(() => document.addEventListener("click", away), 0);
    document.addEventListener("keydown", k);
    ref.current?.querySelector("button, a")?.focus();
    return () => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", k);
    };
  }, []);
  const sid = keySid(it.key);
  const pinned = sid ? pins.value.includes(sid) : false;
  const tomorrow9 = () => {
    const d = new Date(serverNow());
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const run = (fn) => async () => {
    onClose();
    try {
      await fn();
    } catch (err) {
      setNotice(explainApiError(err, t("board.err.network")), 8000);
    }
  };
  const canSeen = ["done", "failed", "older"].includes(it.state);
  return (
    <div class="bd-menu" role="menu" ref={ref} aria-label={t("board.menu.label", { title: it.title })}>
      <a role="menuitem" href={it.href}>{t("board.menu.open")}</a>
      {canSeen && <button role="menuitem" type="button" disabled={offline} onClick={run(() => markSeen([it.key]))}>{t("board.menu.markSeen")}</button>}
      {it.state === "snoozed" ? (
        <button role="menuitem" type="button" disabled={offline} onClick={run(() => snooze(it.key, null))}>{t("board.menu.unsnooze")}</button>
      ) : it.state !== "unknown" && (
        <>
          <button role="menuitem" type="button" disabled={offline} onClick={run(() => snooze(it.key, serverNow() + 3600_000))}>{t("board.menu.snooze1h")}</button>
          <button role="menuitem" type="button" disabled={offline} onClick={run(() => snooze(it.key, tomorrow9()))}>{t("board.menu.snoozeTomorrow")}</button>
        </>
      )}
      {sid && <button role="menuitem" type="button" disabled={offline} onClick={run(() => togglePin(sid))}>{pinned ? t("board.menu.unpin") : t("board.menu.pin")}</button>}
      {it.state === "working" && sid && <button role="menuitem" type="button" class="is-danger" disabled={offline} onClick={() => { onClose(); onStop(it); }}>{t("board.menu.stopTurn")}</button>}
      {it.state === "working" && it.kind === "run" && <a role="menuitem" href={it.href}>{t("board.menu.stopRun")}</a>}
    </div>
  );
}

function Item({ it, now, offline, admin, busyKey, onAnswer, onStop }) {
  const [menu, setMenu] = useState(false);
  const meta = itemMeta(it); // BUG-277: человеческое имя модели, без домашней папки
  const label = `${SECTION[it.state]?.word ?? ""}, ${reasonText(it, now)}, ${it.kind === "run" ? t("board.kind.run") : it.kind === "review" ? t("board.kind.review") : t("board.kind.chat")} ${it.title}, ${timeText(it, now)}`;
  const perm = it.state === "needs" && it.reason === "permission" && it.permission;
  const sending = busyKey === it.key;
  const sid = keySid(it.key);
  return (
    <li class={"bd-item is-" + it.state + (it.reason === "quiet" ? " is-quiet" : "")} data-key={it.key}>
      <a class="bd-main" href={it.href} aria-label={label}>
        <span class="bd-icon"><StateIcon state={it.reason === "quiet" ? "failed" : it.state} /></span>
        <span class="bd-body">
          <span class="bd-title">{it.pinned && <span class="bd-pin" role="img" aria-label={t("board.pinned")}><PinIcon size={14} /> </span>}{it.title}</span>
          <span class="bd-state"><b>{reasonText(it, now)}</b>{meta && <span class="bd-meta" title={meta}>{meta}</span>}</span>
          {it.snippet && !perm && <span class="bd-snippet">{it.snippet}</span>}
          {it.returned && <span class="bd-note">{t("board.note.returned")}</span>}
          {it.pipeDeleted && <span class="bd-note">{t("board.note.pipeDeleted")}</span>}
        </span>
        <span class="bd-time" aria-hidden="true">{timeShort(it, now)}</span>
      </a>
      <button class="bd-more" type="button" aria-label={t("board.moreActions", { title: it.title })} aria-haspopup="menu" aria-expanded={menu ? "true" : "false"} onClick={() => setMenu(!menu)}>⋯</button>
      {menu && <ItemMenu it={it} offline={offline} onClose={() => setMenu(false)} onStop={onStop} />}
      {perm && (
        <div class="bd-actions" title={offline ? t("board.offlineNoReply") : undefined}>
          {it.permission.summary && <code class="bd-cmd">{it.permission.summary}</code>}
          <button type="button" class="bd-btn bd-primary" aria-disabled={offline || sending ? "true" : null} onClick={() => !offline && !sending && onAnswer(it, "once")}>
            {sending ? t("board.perm.sending") : t("board.perm.allowOnce")}
          </button>
          <button type="button" class="bd-btn" aria-disabled={offline || sending ? "true" : null} onClick={() => !offline && !sending && onAnswer(it, "reject")}>{t("board.perm.reject")}</button>
        </div>
      )}
      {it.state === "needs" && it.reason === "question" && (
        <div class="bd-actions"><a class="bd-btn" href={it.href}>{t("board.replyInChat")}</a></div>
      )}
      {it.state === "failed" && it.reason === "restart" && sid && (
        <div class="bd-actions">
          <button type="button" class="bd-btn bd-primary" onClick={() => { saveDraft(sid, t("board.continueDraft")); navigate("/chat/" + encodeURIComponent(sid)); }}>{t("board.continueBtn")}</button>
        </div>
      )}
      {it.state === "failed" && it.reason === "auth" && admin && (
        <div class="bd-actions"><a class="bd-btn" href="#/settings">{t("board.howToSignIn")}</a></div>
      )}
    </li>
  );
}

function Section({ id, items, total, now, offline, admin, phone, busyKey, onAnswer, onStop, onMarkAll, collapsed = false }) {
  const [open, setOpen] = useState(!collapsed);
  const [all, setAll] = useState(false);
  const shown = phone && !all ? items.slice(0, PHONE_LIMIT) : items;
  const s = SECTION[id];
  const count = total ?? items.length;
  return (
    <section class={"bd-section is-" + id} aria-labelledby={"bd-h-" + id}>
      <div class="bd-section-head">
        <h2 id={"bd-h-" + id} aria-label={`${s.title}: ${count}`}>
          {collapsed ? (
            <button type="button" class="bd-fold" aria-expanded={open ? "true" : "false"} onClick={() => setOpen(!open)}>{s.title} ({count})</button>
          ) : (
            <><span class="bd-full">{s.title}</span><span class="bd-short" aria-hidden="true">{s.short}</span> <span class={"bd-num" + (count ? " is-on" : "")}>{count}</span></>
          )}
        </h2>
        {(id === "done" || id === "failed") && items.length > 0 && (
          <button type="button" class="bd-btn bd-markall" disabled={offline} onClick={() => onMarkAll(id, items.length)}>{t("board.markAll")}</button>
        )}
      </div>
      {open && (items.length === 0 ? (
        <p class="bd-none">{id === "needs" ? t("board.empty.needs") : id === "working" ? t("board.empty.working") : id === "done" ? t("board.empty.done") : t("board.empty.failed")}</p>
      ) : (
        <ul class="bd-list">
          {shown.map((it) => <Item key={it.key} it={it} now={now} offline={offline} admin={admin} busyKey={busyKey} onAnswer={onAnswer} onStop={onStop} />)}
        </ul>
      ))}
      {open && shown.length < items.length && (
        <button type="button" class="bd-btn bd-moreitems" onClick={() => setAll(true)}>{t("board.moreItems", { count: items.length - shown.length })}</button>
      )}
    </section>
  );
}

function Away({ away, offline }) {
  const [more, setMore] = useState(false);
  const c = away.counts;
  const pills = [
    c.done && ["done", t("board.away.done", { count: c.done })],
    c.failed && ["failed", t("board.away.failed", { count: c.failed })],
    c.needs && ["needs", t("board.away.needs", { count: c.needs })],
    c.runs && ["working", t("board.away.runs", { count: c.runs })],
  ].filter(Boolean);
  // BUG-277: пустой ряд чисел не занимает места; длительность не переносится;
  // «Подробнее» и «Понятно» — одним рядом (макет T-1), пояснение — под ними.
  return (
    <section class="bd-away" aria-label={t("board.away.label")}>
      <h2>{t("board.away.label")} · <span class="bd-nowrap">{ago(away.durationMs)}</span></h2>
      {pills.length > 0 && <div class="bd-pills">{pills.map(([st, t]) => <span class={"bd-pill is-" + st} key={t}><StateIcon state={st} size={16} />{t}</span>)}</div>}
      {more && away.events.length > 0 && (
        <ul class="bd-events">{away.events.map((e, i) => <li key={i}>{!String(e.text).includes(hhmm(e.at)) && <span class="bd-ev-time">{hhmm(e.at)}</span>}{e.text}</li>)}</ul>
      )}
      <div class="bd-away-foot">
        {!more && away.events.length > 0 && <button type="button" class="bd-btn" aria-expanded="false" onClick={() => setMore(true)}>{t("board.away.details", { count: away.events.length })}</button>}
        <button type="button" class="bd-btn bd-primary" disabled={offline} onClick={() => ackAway(away.until).catch(() => setNotice(t("board.err.network"), 6000))}>{t("board.away.ack")}</button>
      </div>
      <p class="bd-hint bd-away-hint">{t("board.away.hint")}</p>
    </section>
  );
}

// BUG-277: «Доска показывает только ваше…» висела всегда — шум. Показываем один
// раз с «Понятно»; закрытие помнит устройство (localStorage).
export const ADMIN_NOTE_KEY = "teleharness.board.adminNote";
function AdminNote() {
  const read = () => {
    try {
      return globalThis.localStorage?.getItem(ADMIN_NOTE_KEY) === "1";
    } catch {
      return false;
    }
  };
  const [hidden, setHidden] = useState(read);
  if (hidden) return null;
  const close = () => {
    try {
      globalThis.localStorage?.setItem(ADMIN_NOTE_KEY, "1");
    } catch {}
    setHidden(true);
  };
  return (
    <div class="bd-note-admin" role="note">
      <span>{t("board.adminNote")}</span>
      <button type="button" class="bd-btn bd-note-close" onClick={close}>{t("board.away.ack")}</button>
    </div>
  );
}

function usePhone() {
  const q = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
  const [phone, setPhone] = useState(q);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const m = matchMedia("(max-width: 767px)");
    const on = () => setPhone(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return phone;
}

// Новые «Ждёт вас» объявляются вежливо, не чаще раза в 10 с.
function useAnnounce(needsKeys) {
  const [msg, setMsg] = useState("");
  const prev = useRef(null);
  const last = useRef(0);
  useEffect(() => {
    const cur = new Set(needsKeys);
    if (prev.current) {
      const fresh = [...cur].filter((k) => !prev.current.has(k)).length;
      if (fresh > 0 && Date.now() - last.current >= 10_000) {
        last.current = Date.now();
        setMsg(t("board.announceNew", { count: fresh }));
      }
    }
    prev.current = cur;
  }, [needsKeys.join("|")]);
  return msg;
}

export default function BoardView({ section = null }) {
  const b = board.value;
  const st = boardStatus.value;
  const phone = usePhone();
  const [project, setProject] = useState("");
  const [q, setQ] = useState("");
  const [busyKey, setBusyKey] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [creating, setCreating] = useState(false);
  const [, tick] = useState(0);
  const sending = useRef(new Set());
  useEffect(() => {
    // доска как первый экран: поток событий (SSE) и списки поднимает init() —
    // без него отметка с другого устройства доходила бы только опросом 30 с
    init().catch(() => {});
    startBoard();
    refreshBoard();
    const t = setInterval(() => tick((n) => n + 1), 30_000); // «ждёт N мин» идёт
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const prev = document.title;
    document.title = t("board.docTitle");
    return () => { document.title = prev; };
  }, []);

  const item = typeof location !== "undefined" ? new URLSearchParams(location.hash.split("?")[1] ?? "").get("item") : null;
  const offline = connection.value.state === "offline" || st.error === "network";
  const now = serverNow();
  const items = (b?.items ?? []).filter((it) => matches(it, { project, q }));
  const by = (s) => items.filter((it) => it.state === s);
  const needsKeys = by("needs").map((it) => it.key);
  const announce = useAnnounce(needsKeys);

  // Старая ссылка #/board?item=<key>: есть — переход на место, нет — «удалён или недоступен».
  useEffect(() => {
    if (!item || !b) return;
    const hit = b.items.find((x) => x.key === item);
    if (hit) navigate(hit.href.replace(/^#/, ""), { replace: true });
  }, [item, b]);

  async function answer(it, reply) {
    if (sending.current.has(it.key)) return; // двойное нажатие — один ответ
    sending.current.add(it.key);
    setBusyKey(it.key);
    try {
      await api.replyPermission(it.permission.id, { reply }, { directory: it.project?.dir ?? undefined });
      scheduleBoardRefresh(300);
    } catch (err) {
      if ([404, 409, 410].includes(err?.status)) {
        setNotice(t("board.err.alreadyAnswered", { title: it.title }), 8000);
        refreshBoard();
      } else setNotice(explainApiError(err, t("board.err.replyFailed")), 8000);
    } finally {
      sending.current.delete(it.key);
      setBusyKey(null);
    }
  }

  function stop(it) {
    const mins = Math.max(1, Math.round((now - it.since) / 60_000));
    setConfirm({
      title: t("board.stop.title"),
      text: t("board.stop.text", { title: it.title, mins, bg: it.bgAgents ? t("board.stop.bgExtra", { count: it.bgAgents }) : "" }),
      ok: t("board.stop.ok"), okClass: "is-danger",
      run: async () => {
        await api.abort(keySid(it.key), { directory: it.project?.dir ?? undefined });
        scheduleBoardRefresh(300);
      },
    });
  }

  function markAll(section, n) {
    const upTo = b?.now ?? serverNow(); // версия на момент открытия подтверждения
    const go = () => markSectionSeen(section, upTo, { project: project || null, q });
    if (n <= 5) return go().catch((err) => setNotice(explainApiError(err, t("board.err.markFailed")), 6000));
    setConfirm({
      title: t("board.markAll.title", { count: n }),
      text: t("board.markAll.text", { scope: project ? t("board.markAll.scopeProject", { project: project.split(/[\\/]/).pop() }) : t("board.markAll.scopeAll") }),
      ok: t("board.markAll.ok", { count: n }), run: go,
    });
  }

  async function newChat() {
    if (creating) return;
    setCreating(true);
    try {
      await createAndOpen();
    } catch (err) {
      setNotice(explainApiError(err, t("board.err.createChat")), 10_000);
    } finally {
      setCreating(false);
    }
  }

  const tabs = b?.reviews != null; // FEAT-20.1: вкладка «Ждёт ревью» — только при источнике ревью
  // BUG-275: вкладки — своей строкой ПОД шапкой: внутри .page-header последний ребёнок
  // попадал в колонку кнопки (48 px, claude-look.css) и вкладки вставали столбиком
  const head = (
    <>
      <header class="page-header bd-header">
        <MenuButton />
        <h1>{t("board.title")}</h1>
      </header>
      {tabs && (
        <nav class="bd-tabs" aria-label={t("board.title")}>
          <a href="#/board" aria-current={section !== "review" ? "page" : undefined}>{t("board.tabs.all")}</a>
          <a href="#/board/review" aria-current={section === "review" ? "page" : undefined}>{t("board.tabs.review")} <span class="bd-num">{b.counts.review}</span></a>
        </nav>
      )}
    </>
  );

  if (item && b && !b.items.some((x) => x.key === item)) {
    return (
      <div class="page board-view">{head}
        <div class="bd-gone" role="status">
          <h2>{t("board.gone.title")}</h2>
          <p>{t("board.gone.text")}</p>
          <a class="bd-btn bd-primary" href="#/board">{t("board.gone.back")}</a>
        </div>
      </div>
    );
  }

  if (section === "review") {
    return (
      <div class="page board-view">{head}
        {b?.sources?.reviews === "ok" ? <ReviewQueue reviews={b.reviews ?? []} offline={offline} at={st.at ?? b.now} now={now} /> : !b ? (
          <div class="bd-skeleton" role="status" aria-label={t("board.loading")}><div class="sk bd-sk-row" /><div class="sk bd-sk-row" /></div>
        ) : (
          <div class="bd-gone" role="status" data-req="FEAT-20.2 кр. 21">
            <h2>{t("board.reviewOff.title")}</h2>
            <p>{t("board.reviewOff.text")}</p>
            <a class="bd-btn bd-primary" href="#/board">{t("board.gone.back")}</a>
          </div>
        )}
      </div>
    );
  }

  if (!b) {
    return (
      <div class="page board-view">{head}
        {st.error ? (
          <div class="bd-gone" role="alert">
            <h2>{t("board.offline.title")}</h2>
            <p>{t("board.offline.loadFail")}</p>
            <button type="button" class="bd-btn bd-primary" onClick={() => refreshBoard()}>{t("board.retry")}</button>
          </div>
        ) : (
          <div class="bd-skeleton" role="status" aria-label={t("board.loading")}>
            {MAIN.map((s) => <div key={s} class="bd-sk-section"><div class="sk bd-sk-h" /><div class="sk bd-sk-row" /><div class="sk bd-sk-row" /></div>)}
          </div>
        )}
      </div>
    );
  }

  const counts = { needs: by("needs").length, working: by("working").length, done: by("done").length, failed: by("failed").length };
  const filtered = Boolean(project || q.trim());
  const total = (s) => (filtered ? undefined : b.counts[s]);
  const empty = MAIN.every((s) => counts[s] === 0) && by("unknown").length === 0;
  return (
    <div class={"page board-view" + (offline ? " is-offline" : "")} data-req="FEAT-20.2">
      {head}
      <div class="sr-only" aria-live="polite">{announce}</div>
      {offline && (
        <div class="bd-banner is-offline" role="status">
          <b>{t("board.offline.title")}</b> · {t("board.offline.banner", { hhmm: hhmm(st.at ?? b.now) })}
          <button type="button" class="bd-btn" onClick={() => refreshBoard()}>{t("board.retry")}</button>
        </div>
      )}
      {b.sources?.opencode === "down" && <div class="bd-banner" role="status">{t("board.source.opencodeDown")}</div>}
      {b.sources?.temporal === "down" && <div class="bd-banner" role="status">{t("board.source.temporalDown", { hhmm: hhmm(b.now) })}</div>}
      {b.away && <Away away={b.away} offline={offline} />}
      {b.admin && <AdminNote />}
      {(b.items.length > 0 || filtered) && (
        <div class="bd-filters">
          {b.projects?.length > 1 && (
            <select class="bd-select" aria-label={t("board.filter.project")} value={project} onChange={(e) => setProject(e.currentTarget.value)}>
              <option value="">{t("board.filter.allProjects")}</option>
              {b.projects.map((p) => <option key={p.dir} value={p.dir}>{projectLabel(p) || t("board.filter.homeDir")}</option>)}
            </select>
          )}
          <input class="search bd-search" type="search" placeholder={t("board.filter.search")} aria-label={t("board.filter.search")} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
      )}
      {b.truncated && <p class="bd-hint" role="status">{t("board.truncated", { shown: b.truncated.shown, total: b.truncated.total })}</p>}
      {empty && !filtered ? (
        <div class="bd-empty">
          <span class="bd-empty-icon"><StateIcon state="done" size={40} /></span>
          <h2>{t("board.allCalm.title")}</h2>
          <p>{t("board.allCalm.text")}</p>
          <div class="bd-empty-actions">
            <button type="button" class="bd-btn bd-primary" onClick={newChat} disabled={creating}>{creating ? t("board.allCalm.creating") : t("board.allCalm.newChat")}</button>
            <a class="bd-btn" href="#/">{t("board.allCalm.allChats")}</a>
          </div>
        </div>
      ) : (
        <div class="bd-columns">
          {MAIN.map((s) => (
            <Section key={s} id={s} items={by(s)} total={total(s)} now={now} offline={offline} admin={b.admin} phone={phone}
              busyKey={busyKey} onAnswer={answer} onStop={stop} onMarkAll={markAll} />
          ))}
        </div>
      )}
      {by("unknown").length > 0 && <Section id="unknown" items={by("unknown")} now={now} offline={offline} admin={b.admin} phone={phone} busyKey={busyKey} onAnswer={answer} onStop={stop} onMarkAll={markAll} />}
      {by("snoozed").length > 0 && <Section id="snoozed" collapsed items={by("snoozed")} now={now} offline={offline} admin={b.admin} phone={phone} busyKey={busyKey} onAnswer={answer} onStop={stop} onMarkAll={markAll} />}
      {by("older").length > 0 && <Section id="older" collapsed items={by("older")} now={now} offline={offline} admin={b.admin} phone={phone} busyKey={busyKey} onAnswer={answer} onStop={stop} onMarkAll={markAll} />}
      {confirm && (
        <Confirm title={confirm.title} ok={confirm.ok} okClass={confirm.okClass} onCancel={() => setConfirm(null)}
          onOk={async () => {
            const c = confirm;
            setConfirm(null);
            try {
              await c.run();
            } catch (err) {
              setNotice(explainApiError(err, t("board.err.network")), 8000);
            }
          }}>
          {confirm.text}
        </Confirm>
      )}
    </div>
  );
}
