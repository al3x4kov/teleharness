// Menu: общее для бокового меню (FEAT-09.20) — сигнал открытия, кнопка ☰
// в шапках экранов и знак zai. Отдельный модуль: экраны импортируют кнопку,
// а Drawer импортирует chatTitle из HomeView — без цикла импортов.
import { signal } from "@preact/signals";
import { t } from "../lib/i18n.js";

export const drawerOpen = signal(false);

export function openDrawer() {
  drawerOpen.value = true;
}

export function closeDrawer() {
  drawerOpen.value = false;
}

function Svg({ children, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

// Знак Teleharness (TASK-01.82, выбор владельца 2026-11-11 — форма А): «>» терминала
// и две дуги связи, цвет --brand (индиго). Прежняя «искра» повторяла знак Claude.
// Имя компонента и класс .zai-mark — внутренние, не переименованы.
export function ZaiMark({ size = 40 }) {
  return (
    <svg class="zai-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 10.5 L15.5 20 L6 29.5" stroke-width="4.2" />
      <path d="M21 14 a8.5 8.5 0 0 1 0 12" stroke-width="3.8" />
      <path d="M27 8.5 a16 16 0 0 1 0 23" stroke-width="3.8" opacity="0.55" />
    </svg>
  );
}

export function MenuButton() {
  return (
    <button class="icon-btn menu-btn float-btn" type="button" aria-label={t("menu.menu")} aria-haspopup="dialog"
      aria-expanded={drawerOpen.value ? "true" : "false"} onClick={openDrawer}>
      <Svg><path d="M4 7h16" /><path d="M4 12h12" /><path d="M4 17h8" /></Svg>
    </button>
  );
}


// Приветствие пустого чата (FEAT-09.20 д): по времени суток + имя.
// 5–11 утро, 12–17 день, 18–22 вечер, 23–4 ночь.
export function greetingText(hour, name) {
  const h = Number(hour);
  const hi = t(h >= 5 && h <= 11 ? "menu.greet.morning" : h >= 12 && h <= 17 ? "menu.greet.afternoon" : h >= 18 && h <= 22 ? "menu.greet.evening" : "menu.greet.night");
  const n = String(name ?? "").trim();
  return n ? `${hi}, ${n}` : hi;
}

// FEAT-01.69: булавка закреплённого чата (off — «Открепить»).
const PIN_PATH =
  "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";

export function PinIcon({ off = false, size = 18 }) {
  return (
    <svg class="pin-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d={PIN_PATH} />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
