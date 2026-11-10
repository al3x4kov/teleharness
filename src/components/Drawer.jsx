// Drawer: боковое меню в стиле приложения Claude (FEAT-09.20) — заменяет
// нижний таббар и рейл. <900px: выезжает слева поверх экрана по кнопке ☰
// (MenuButton в шапке экрана), закрывается затемнением, Esc, выбором пункта
// и сменой роута. ≥900px: закреплённая левая панель, кнопка ☰ скрыта CSS.
// Содержимое: знак zai, разделы, «Недавние» (те же фильтры, что «Чаты»),
// «Показать все», инициалы → Настройки, тёмная пилюля «Новый чат».
import { useEffect, useRef, useState } from "preact/hooks";
import { agents, createAndOpen, explainApiError, me, pins, PINNED_FOLD, sessions, setNotice, splitPinned } from "../lib/store.js";
import { navigate } from "../lib/router.js";
import ChatMenu from "./ChatMenu.jsx";
import { isHiddenDir, isSubagentSession, parseTime } from "../lib/normalize.js";
import { chatTitle } from "./views/HomeView.jsx";
import { Glyph, restoreFocus } from "./Pickers.jsx";
import { closeDrawer, drawerOpen, PinIcon, ZaiMark } from "./Menu.jsx";
import { t } from "../lib/i18n.js";

export { closeDrawer, drawerOpen, openDrawer, MenuButton, ZaiMark } from "./Menu.jsx";

export const RECENT_LIMIT = 8;

function Svg({ children, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function initials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const s = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return s.toUpperCase();
}

// Последние чаты для «Недавних»: те же правила видимости, что у «Чатов»,
// по убыванию последней активности.
export function recentSessions(list, agentList, limit = RECENT_LIMIT) {
  const when = (s) => parseTime(s?.time?.updated ?? s?.time?.created) || 0;
  return (list ?? [])
    .filter((s) => !isHiddenDir(s.directory) && !isSubagentSession(s, agentList))
    .slice()
    .sort((a, b) => when(b) - when(a))
    .slice(0, limit);
}

const NAV = [
  { view: "home", href: "#/", labelKey: "common.chats", icon: <><path d="M20 11.5a7.5 7.5 0 0 1-11.2 6.5L4 19.5l1.5-4.3A7.5 7.5 0 1 1 20 11.5Z" /></> },
  { view: "projects", href: "#/projects", labelKey: "common.projects", icon: <><path d="M5 9h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" /><path d="M4 9h16" /><path d="M7 5.5h10" /></> },
  { view: "settings", href: "#/settings", labelKey: "common.settings", icon: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></> },
];

export default function Drawer({ view, chatId }) {
  const open = drawerOpen.value;
  const [creating, setCreating] = useState(false);
  const panelRef = useRef(null);

  // Смена экрана закрывает панель (выбор пункта = переход).
  useEffect(() => {
    closeDrawer();
  }, [view, chatId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") closeDrawer();
      // Открытое меню модально (BUG-097): Tab ходит по кругу внутри панели,
      // а не уходит в экран под затемнением.
      if (e.key === "Tab" && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll("a[href], button:not([disabled])")];
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const inside = panelRef.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // BUG-01.38: closing returns the focus to ☰ (or whatever opened the menu)
    // — it used to stay on the hidden panel. A link that navigated away
    // leaves its own new screen alone (the opener is gone or the hash moved).
    const opener = document.activeElement;
    const hash = location.hash;
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector("a, button")?.focus?.();
    return () => {
      document.removeEventListener("keydown", onKey);
      const a = document.activeElement;
      if (location.hash === hash && (!a || a === document.body || panelRef.current?.contains(a))) restoreFocus(opener);
    };
  }, [open]);

  async function newChat() {
    if (creating) return;
    setCreating(true);
    try {
      await createAndOpen();
    } catch (err) {
      setNotice(explainApiError(err, t("home.createFailed")), 10_000);
    } finally {
      setCreating(false);
      closeDrawer();
    }
  }

  const user = me.value || null;
  // FEAT-01.69: «Закреплённые» над «Недавними» (те же правила видимости);
  // в «Недавних» их уже нет.
  const all = recentSessions(sessions.value, agents.value, Infinity);
  const { pinned, rest } = splitPinned(all, pins.value);
  const [pinsOpen, setPinsOpen] = useState(false);
  const pinnedShown = pinsOpen || pinned.length <= PINNED_FOLD + 1 ? pinned : pinned.slice(0, PINNED_FOLD);
  const recent = rest.slice(0, RECENT_LIMIT);
  const row = (s, isPinned) => {
    const cur = view === "chat" && chatId === s.id;
    return (
      <li key={s.id} class="drawer-row">
        <a class={"drawer-item is-chat" + (cur ? " is-active" : "")}
          href={"#/chat/" + encodeURIComponent(s.id)}
          aria-current={cur ? "page" : null}>
          {isPinned ? (
            <span class="drawer-pin" role="img" aria-label={t("home.pinned")}><PinIcon size={18} /></span>
          ) : (
            <Svg size={20}><path d="M20 11.5a7.5 7.5 0 0 1-11.2 6.5L4 19.5l1.5-4.3A7.5 7.5 0 1 1 20 11.5Z" /></Svg>
          )}
          <span class="drawer-chat-title">{chatTitle(s)}</span>
        </a>
        {/* У3: в браузере «⋯» строки — при наведении/фокусе; то же меню. */}
        <ChatMenu sessionId={s.id} variant="row" onDeleted={(id) => {
          if (view === "chat" && chatId === id) navigate("/", { replace: true });
        }} />
      </li>
    );
  };

  return (
    <>
      <div class={"drawer-scrim" + (open ? " is-open" : "")} onClick={closeDrawer} aria-hidden="true" />
      <nav class={"drawer" + (open ? " is-open" : "")} ref={panelRef} aria-label={t("menu.menu")} data-req="FEAT-09.20"
        role={open ? "dialog" : undefined} aria-modal={open ? "true" : undefined}
        onClick={(e) => {
          // Тап по ссылке текущего экрана хэш не меняет — закрываем меню сами
          // (BUG-095), иначе оно остаётся висеть.
          if (e.target?.closest?.("a")) closeDrawer();
        }}>
        <div class="drawer-head">
          <a class="drawer-brand" href="#/" aria-label={t("drawer.brand")}>
            <ZaiMark size={26} />
            <span class="drawer-word">{t("common.app")}</span>
          </a>
          <button class="icon-btn float-btn drawer-close" type="button" aria-label={t("drawer.close")} onClick={closeDrawer}>
            <Glyph name="close" size={20} />
          </button>
        </div>
        <div class="drawer-scroll">
          <ul class="drawer-nav">
            {NAV.map((n) => (
              <li key={n.view}>
                <a class={"drawer-item" + (view === n.view ? " is-active" : "")} href={n.href}
                  aria-current={view === n.view ? "page" : null}>
                  <Svg>{n.icon}</Svg>
                  <span>{t(n.labelKey)}</span>
                </a>
              </li>
            ))}
          </ul>
          {pinned.length > 0 && (
            <section class="drawer-recent drawer-pinned" aria-label={t("home.pinnedGroup")} data-req="FEAT-01.69">
              <h2 class="drawer-label">{t("home.pinnedGroup")}</h2>
              <ul>{pinnedShown.map((s) => row(s, true))}</ul>
              {pinned.length > pinnedShown.length && (
                <button class="drawer-more" type="button" onClick={() => setPinsOpen(true)}>
                  {t("home.more", { count: pinned.length - pinnedShown.length })}
                </button>
              )}
            </section>
          )}
          {recent.length > 0 && (
            <section class="drawer-recent" aria-label={t("drawer.recent")}>
              <h2 class="drawer-label">{t("drawer.recent")}</h2>
              <ul>{recent.map((s) => row(s, false))}</ul>
              <a class="drawer-more" href="#/">{t("drawer.showAll")} <Glyph name="chevron" size={14} /></a>
            </section>
          )}
        </div>
        <div class="drawer-foot">
          <a class="drawer-avatar" href="#/settings" aria-label={t("drawer.account", { name: user?.name || t("drawer.profile") })} title={user?.name || ""}>
            {initials(user?.name)}
          </a>
          <button class="dark-pill" type="button" onClick={newChat} disabled={creating}>
            <Glyph name="plus" size={20} /> {creating ? t("home.creating") : t("home.newChat")}
          </button>
        </div>
      </nav>
    </>
  );
}
