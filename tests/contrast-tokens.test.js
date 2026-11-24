// BUG-264 п.4: контраст текста ниже WCAG AA (4.5:1) в светлой теме — dogfood 2.0.1
// (dogfood-output/2026-11-19-full/D/report.md, Н-1): «Недавние»/«Показать все» в меню 4.31,
// пилюля «Без вопросов» 4.19, текст плашки квоты 4.29, «⚠ Исполнение Temporal … не подключено» 4.29,
// статус «Новый пайп» 4.29, подсказка тенанта «Модель и агент закрепятся…» 3.03.
// Цвета берём из токенов src/claude-look.css (действующая тема), фон — как в вёрстке.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(root, f), "utf8").split("\r\n").join("\n");
const look = read("src/claude-look.css");

// Тело первого блока, начинающегося с заголовка head (точное совпадение строки).
function blockAfter(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, "нет блока " + head);
  const open = src.indexOf("{", at + head.length - 1);
  return src.slice(open + 1, src.indexOf("}", open));
}
function vars(body) {
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const THEMES = {
  dark: vars(blockAfter(look, ":root,\n:root[data-theme=\"dark\"] {")),
  light: vars(blockAfter(look, ":root[data-theme=\"light\"] {")),
  "light (системная)": vars(blockAfter(look, "  :root:not([data-theme]) {")),
};

// Цвет → [r, g, b, a]; поддерживаются #rrggbb, rgba(), color-mix(in srgb, A p%, B|transparent) и var().
function color(v, t) {
  v = v.trim();
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  if (ref) return color(t[ref[1]], t);
  if (v === "transparent") return [0, 0, 0, 0];
  if (v.startsWith("#")) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1);
  const rgba = v.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) { const n = rgba[1].split(",").map(Number); return [n[0], n[1], n[2], n[3] ?? 1]; }
  const mix = v.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/);
  if (mix) {
    const p = Number(mix[2]) / 100, a = color(mix[1], t), b = color(mix[3], t);
    const alpha = a[3] * p + b[3] * (1 - p);
    if (!alpha) return [0, 0, 0, 0];
    const ch = [0, 1, 2].map((i) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha);
    return [...ch, alpha];
  }
  throw new Error("не разобрал цвет " + v);
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
function contrast(fgExpr, bgExprs, t) {
  // фон — стопка слоёв снизу вверх (полупрозрачные смешиваются с нижним)
  let bg = [255, 255, 255, 1];
  for (const e of bgExprs) bg = over(color(e, t), bg);
  const fg = over(color(fgExpr, t), bg);
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// [где, цвет текста, слои фона]
const PAIRS = [
  ["меню: «Недавние», «Показать все» (.drawer-label/.drawer-more)", "var(--text-2)", ["var(--drawer-bg)"]],
  ["пилюля «Без вопросов» (.perm-pill на --input)", "var(--text-2)", ["var(--bg)", "var(--input)"]],
  ["текст плашки квоты (.stall-text на .stall-bar)", "var(--text-2)", ["var(--bg)", "color-mix(in srgb, var(--error) 10%, var(--surface))"]],
  ["статус «Новый пайп» (.t-muted на .t-savebar)", "var(--text-2)", ["var(--bg)", "color-mix(in srgb, var(--bg) 92%, transparent)"]],
  ["вторичный текст на карточке", "var(--text-2)", ["var(--surface)"]],
  ["«⚠ Исполнение Temporal … не подключено» (.t-warn-text на карточке)", "var(--warning)", ["var(--surface)"]],
  ["предупреждение на грунте", "var(--warning)", ["var(--bg)"]],
  ["предупреждение в баннере (.t-banner-warn)", "var(--warning)", ["var(--bg)", "color-mix(in srgb, var(--warning) 8%, var(--surface))"]],
  ["подсказка «Модель и агент закрепятся…» (.model-bar-note на грунте)", "NOTE", ["var(--bg)"]],
  // R-1 (повторный dogfood 2.0.2): красный ошибки — заголовок/кнопки плашки квоты, «⚠ Исчерпан лимит» в ленте
  ["заголовок плашки квоты (--error на .stall-bar)", "var(--error)", ["var(--bg)", "color-mix(in srgb, var(--error) 10%, var(--surface))"]],
  ["«⚠ Исчерпан лимит …» в ленте (--error на грунте)", "var(--error)", ["var(--bg)"]],
  ["ошибка на карточке (--error на --surface)", "var(--error)", ["var(--surface)"]],
];

const noteColor = (() => {
  const views = read("src/components/views.css");
  const own = blockAfter(views, "\n.model-bar-note {").match(/color:\s*([^;]+);/);
  return own[1];
})();

// BUG-310: контраст подписей правой панели и модалки скилла (src/components/right-panel.css)
const rpCss = read("src/components/right-panel.css");
const rpColor = (selector) => {
  const own = blockAfter(rpCss, `\n${selector} {`).match(/color:\s*([^;]+);/);
  assert.ok(own, `нет color у ${selector} в right-panel.css`);
  return own[1];
};
const RP_PAIRS = [
  ["правая панель: пустое состояние (.rp-empty на --bg)", rpColor(".rp-empty"), ["var(--bg)"]],
  ["правая панель: подсказка плана (.rp-plan-hint на --bg)", rpColor(".rp-plan-hint"), ["var(--bg)"]],
  ["правая панель: путь скилла в модалке (.rp-modal-path на --bg)", rpColor(".rp-modal-path"), ["var(--bg)"]],
];

for (const [theme, t] of Object.entries(THEMES)) {
  test(`BUG-264 п.4 + BUG-310: контраст обычного текста ≥ 4.5:1 — тема ${theme}`, () => {
    const bad = [];
    for (const [where, fg, bg] of [...PAIRS, ...RP_PAIRS]) {
      const cr = contrast(fg === "NOTE" ? noteColor : fg, bg, t);
      if (cr < 4.5) bad.push(`${where}: ${cr.toFixed(2)}`);
    }
    assert.deepEqual(bad, []);
  });
}

test("BUG-264 п.4: светлые токены одинаковы для data-theme=light и системной светлой темы", () => {
  for (const k of ["text-2", "warning", "error", "bg", "surface", "input", "drawer-bg"]) assert.equal(THEMES["light (системная)"][k], THEMES.light[k], k);
});

