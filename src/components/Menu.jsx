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

// Знак zai: восьмилучевая «искра» — роль и цвет знака Claude, но своя форма
// (товарный знак Anthropic не копируется, FEAT-09.20 «Решения» п.1).
export function ZaiMark({ size = 40 }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg class="zai-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      {rays.map((a, i) => (
        <rect key={a} x="18.6" y={i % 2 ? 5 : 2} width="2.8" height={i % 2 ? 13 : 16} rx="1.4"
          transform={`rotate(${a} 20 20)`} fill="currentColor" />
      ))}
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
