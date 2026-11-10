// FEAT-01.69: меню чата «⋯» — «Закрепить/Открепить · Переименовать ·
// Удалить» (макеты chat-menu-settings.html кадры 2–3, E1–E5;
// chat-menu-settings-wide.html D1). Одна и та же кнопка в шапке чата
// (variant="header") и у строки боковой панели в браузере (variant="row",
// видна при наведении/фокусе). Переименование и удаление — те же модалки,
// что в списке чатов (RenameModal / DeleteModal из HomeView).
//
// Ветки П31: Н1 (сбой закрепления — откат + «Повторить», store/pins.js),
// Н2 (чат удалён в другом месте — chatGone), Н4 (пустой чат — «Закрепить» и
// «Переименовать» неактивны), Н5 (удаление во время хода — предупреждение,
// сначала стоп), Н6 (сбой удаления — чат на месте, notice), Н7 (модалка
// переименования), Н8 (один запрос на действие), Н9 (без сети пункты
// неактивны с «Нет связи»), Н13 (поворот/ресайз закрывает меню).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import {
  busyMap, chatGone, connection, deleteChat, pinBusy, pins, renameSession, sessions, togglePin,
} from "../lib/store.js";
import { DeleteModal, RenameModal } from "./views/HomeView.jsx";
import { Glyph } from "./Pickers.jsx";
import { PinIcon } from "./Menu.jsx";
import { t } from "../lib/i18n.js";

export { PinIcon };

function Dots({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.5" cy="12" r="1.7" />
    </svg>
  );
}

export const isOffline = () =>
  connection.value?.state === "offline" || (typeof navigator !== "undefined" && navigator.onLine === false);

// Пункты меню для чата: что видно и что неактивно (чистая функция — тесты).
//   pinned — чат закреплён; empty — ни одного сообщения (Н4); offline (Н9);
//   pinning — закрепление этого чата в полёте (Н8).
export function menuItems({ pinned = false, empty = false, offline = false, pinning = false } = {}) {
  const off = offline ? t("chatMenu.offline") : null;
  return [
    {
      id: "pin",
      label: pinning ? "…" : pinned ? t("chatMenu.unpin") : t("chatMenu.pin"),
      note: off ?? (empty && !pinned ? t("chatMenu.sendFirst") : null),
      disabled: offline || pinning || (empty && !pinned),
    },
    { id: "rename", label: t("common.rename"), note: off, disabled: offline || empty },
    { id: "delete", label: t("common.delete"), note: off, disabled: offline, danger: true },
  ];
}

// Позиция выпадающего меню у кнопки: справа под ней, не за краем экрана
// (320 px — Н12/У1); не помещается вниз — над кнопкой.
export function menuPlacement(rect, { vw, vh, width = 248, height = 168, gap = 6, margin = 8 } = {}) {
  const w = Math.min(width, vw - margin * 2);
  let left = Math.min(rect.right - w, vw - margin - w);
  left = Math.max(margin, left);
  const below = rect.bottom + gap;
  const top = below + height <= vh - margin ? below : Math.max(margin, rect.top - gap - height);
  return { left, top, width: w };
}

export default function ChatMenu({ sessionId, busy = null, empty = false, variant = "header", onDeleted = null }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(null); // null | "ask" | "pending"
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const session = sessions.value.find((s) => s.id === sessionId) ?? { id: sessionId };
  const pinned = pins.value.includes(sessionId);
  const running = busy ?? !!busyMap.value[sessionId];
  const offline = isOffline();
  const items = menuItems({ pinned, empty, offline, pinning: pinBusy.value === sessionId });

  const close = (focusBtn = true) => {
    setOpen(false);
    if (focusBtn) btnRef.current?.focus?.({ preventScroll: true });
  };

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect?.();
    if (!r) return;
    const h = menuRef.current?.offsetHeight || 168;
    setPos(menuPlacement(r, { vw: window.innerWidth || 402, vh: window.innerHeight || 874, height: h }));
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // focus the first enabled item (keyboard: Enter on «⋯» → ↑↓ → Enter)
    const first = menuRef.current?.querySelector('[role="menuitem"]:not([disabled])');
    first?.focus?.({ preventScroll: true });
    const onDown = (e) => {
      const t = e.target;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close(false); // тап мимо
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "Tab") {
        close(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [])];
        if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement);
        const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next].focus();
      }
    };
    // Н13: поворот экрана / ресайз окна закрывает меню (позиция устарела)
    let w = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== w) close(false);
      w = window.innerWidth;
    };
    const onRotate = () => close(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onRotate);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onRotate);
    };
  }, [open]);

  const pick = (it) => {
    if (it.disabled) return;
    close(it.id === "pin");
    if (it.id === "pin") togglePin(sessionId);
    else if (it.id === "rename") setRenaming(true);
    else if (it.id === "delete") setDeleting("ask");
  };

  const confirmDelete = async () => {
    if (deleting === "pending") return; // Н8: один запрос
    setDeleting("pending");
    const ok = await deleteChat(sessionId, { stopFirst: running });
    setDeleting(null);
    if (ok) onDeleted?.(sessionId);
  };

  const dotsLabel = t("chatMenu.actions");
  return (
    <>
      <button
        ref={btnRef}
        class={"icon-btn chat-menu-btn" + (variant === "header" ? " float-btn" : " row-menu-btn") + (open ? " is-open" : "")}
        type="button"
        aria-label={dotsLabel}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v); // повторный «⋯» закрывает
        }}
      >
        <Dots size={variant === "row" ? 18 : 22} />
      </button>
      {open &&
        createPortal(
          <div
            class="chat-menu"
            role="menu"
            aria-label={t("chatMenu.actions")}
            ref={menuRef}
            data-req="FEAT-01.69"
            style={pos ? `left:${pos.left}px;top:${pos.top}px;width:${pos.width}px` : "visibility:hidden"}
          >
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                class={"chat-menu-item" + (it.danger ? " is-danger" : "")}
                disabled={it.disabled}
                aria-disabled={it.disabled ? "true" : undefined}
                data-act={it.id}
                onClick={() => pick(it)}
              >
                <span class="chat-menu-ico" aria-hidden="true">
                  {it.id === "pin" ? <PinIcon off={pinned} size={20} /> : <Glyph name={it.id === "rename" ? "pencil" : "trash"} size={20} />}
                </span>
                <span class="chat-menu-text">
                  <span class="chat-menu-label">{it.label}</span>
                  {it.note && <span class="chat-menu-note">{it.note}</span>}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
      {renaming &&
        createPortal(
          <RenameModal
            session={session}
            onClose={() => setRenaming(false)}
            onSave={async (title) => {
              let error = null;
              let status = 0;
              const ok = await renameSession(sessionId, title, {
                onError: (m, err) => {
                  error = m;
                  status = err?.status ?? 0;
                },
              });
              if (ok) {
                setRenaming(false);
                return null;
              }
              if (status === 404) {
                setRenaming(false);
                chatGone(sessionId); // Н2
                return null;
              }
              return error ?? t("home.renameFailed"); // Н7: имя в поле, ошибка в модалке
            }}
          />,
          document.body,
        )}
      {deleting &&
        createPortal(
          <DeleteModal
            session={session}
            busy={running}
            pending={deleting === "pending"}
            onClose={() => deleting !== "pending" && setDeleting(null)}
            onConfirm={confirmDelete}
          />,
          document.body,
        )}
    </>
  );
}
