// FEAT-01.88: зона «Отпустите, чтобы прикрепить» (BRIEF-16, макет
// design/mockups-v2/paste-drop.html, кадры 1, 6, 8).
// Слушатели — на window со счётчиком входов: оверлей не перехватывает
// события (pointer-events: none) и не даёт мигания dragleave. Зона активна,
// когда тащат файлы и курсор внутри области чата (targetRef). Оверлей —
// порталом в body (урок: fixed-оверлеи не рендерить внутри скроллера).
// Любой drop файлов в окне гасится preventDefault — браузер не открывает
// файл вместо портала; прикрепление — только внутри области и не при остановке.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { countLabel, dragInfo, droppedEntries, hasBlockingOverlay } from "../../lib/paste-drop.js";
import { t } from "../../lib/i18n.js";

const DropIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
    <path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
  </svg>
);

const BanIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="M6.5 6.5l11 11" />
  </svg>
);

// Область чата — весь вид (main.view): на широком экране колонка .chat уже
// окна, а зона по макету — вся область справа от списка чатов (кадр 1).
const rectOf = (el) => {
  const r = (el?.closest?.(".view") ?? el)?.getBoundingClientRect?.();
  return r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
};
const inside = (r, e) => Boolean(r) && r.width > 0 && r.height > 0 && e.clientX >= r.left && e.clientX <= r.left + r.width && e.clientY >= r.top && e.clientY <= r.top + r.height;
const sameDrag = (a, b) => a === b || (a && b && a.count === b.count && a.images === b.images && a.blocked === b.blocked && a.rect.top === b.rect.top && a.rect.left === b.rect.left && a.rect.width === b.rect.width && a.rect.height === b.rect.height);

export default function DropZone({ targetRef, filesApi }) {
  const [drag, setDrag] = useState(null); // { count, images, blocked, rect } | null
  const cur = useRef(null);
  const set = (next) => {
    if (sameDrag(cur.current, next)) return;
    cur.current = next;
    setDrag(next);
  };

  useEffect(() => {
    let depth = 0;
    const clear = () => {
      depth = 0;
      set(null);
    };
    const files = (e) => dragInfo(e.dataTransfer).files;
    const track = (e) => {
      if (hasBlockingOverlay()) {
        set(null);
        return false;
      }
      const api = filesApi?.current;
      const rect = rectOf(targetRef?.current);
      if (!api || !inside(rect, e)) {
        set(null);
        return false;
      }
      const info = dragInfo(e.dataTransfer);
      set({ count: info.count, images: info.images, blocked: Boolean(api.blocked), rect });
      return !api.blocked;
    };
    const onEnter = (e) => {
      if (!files(e)) return;
      depth += 1;
      e.preventDefault();
      track(e);
    };
    const onOver = (e) => {
      if (!files(e)) return;
      e.preventDefault(); // иначе drop не придёт, а браузер откроет файл
      const ok = track(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? "copy" : "none";
    };
    const onLeave = (e) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      const outOfWindow =
        e.relatedTarget == null &&
        (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight);
      if (depth === 0 || outOfWindow) clear();
    };
    const onDrop = (e) => {
      if (!files(e)) return;
      e.preventDefault();
      clear();
      if (hasBlockingOverlay()) return;
      const api = filesApi?.current;
      if (!api || api.blocked || !inside(rectOf(targetRef?.current), e)) return;
      const { files: list, folders } = droppedEntries(e.dataTransfer);
      if (list.length > 0 || folders.length > 0) api.add(list, folders);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && cur.current) clear();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!drag || typeof document === "undefined") return null;
  const label = countLabel(drag);
  const { top, left, width, height } = drag.rect;
  return createPortal(
    <div class={"dz" + (drag.blocked ? " is-no" : "")} style={{ top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` }} role="status" aria-live="polite">
      <div class="dz-in">
        <span class="dz-ring">{drag.blocked ? <BanIcon /> : <DropIcon />}</span>
        <b class="dz-title">{drag.blocked ? t("drop.blocked") : t("drop.title")}</b>
        {!drag.blocked && label ? <span class="dz-count">{label}</span> : null}
        <span class="dz-hint">{drag.blocked ? t("drop.blockedHint") : t("drop.hint")}</span>
      </div>
    </div>,
    document.body,
  );
}
