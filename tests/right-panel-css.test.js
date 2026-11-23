// @suite: unit
// FEAT-20.37: раскладка правой панели по брифу — парсинг right-panel.css
// текстом (образец: tests/tap-targets-css.test.js): media-порог 1024px,
// место под панель у .shell, скрытие ниже порога, тап-цели >= 40px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = () => readFileSync(path.join(root, "src/components/right-panel.css"), "utf8").split("\r\n").join("\n");

// Тела всех блоков «sel { … }», где селектор стоит в начале строки.
function block(src, sel) {
  const out = [];
  for (const chunk of src.split("\n" + sel + " {").slice(1)) out.push(chunk.slice(0, chunk.indexOf("}")));
  return out.join("\n");
}

// Тело media-блока по его заголовку (со вложенными правилами, скобки считаем).
function mediaBlock(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `нет блока ${header}`);
  let depth = 0;
  let body = "";
  for (let i = at + header.length; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") {
      depth += 1;
      body += ch;
      continue;
    }
    if (ch === "}") {
      if (depth === 1) return body; // закрывающая скобка media в тело не входит
      depth -= 1;
      body += ch;
      continue;
    }
    if (depth >= 1) body += ch;
  }
  return body;
}

test("FEAT-20.37: media-порог 1024px, внутри — .shell.has-right-panel с padding-right: var(--right-panel-w)", () => {
  const m = mediaBlock(css(), "@media (min-width: 1024px)");
  assert.match(m, /\.shell\.has-right-panel\s*\{[^}]*padding-right:\s*var\(--right-panel-w\)/, ".shell.has-right-panel освобождает место под панель только в открытом чате");
  assert.doesNotMatch(m, /(?:^|\n)\s*\.shell\s*\{[^}]*padding-right:/, "голый .shell не получает 300px отступа на Home/Settings/Projects/Board");
  assert.match(m, /\.right-panel\s*\{[^}]*display:\s*flex/, "внутри media панель видима");
});

test("FEAT-20.37: ниже 1024px панели нет — display: none в базовом правиле .right-panel", () => {
  const base = block(css(), ".right-panel");
  assert.match(base, /display:\s*none/, "база = скрыта (панели нет вовсе)");
});

test("FEAT-20.37: ширина панели 300px (--right-panel-w: 300px + width: var)", () => {
  const src = css();
  assert.match(src, /--right-panel-w:\s*300px/);
  assert.match(block(src, ".right-panel"), /width:\s*var\(--right-panel-w\)/);
});

test("FEAT-20.37: панель сама прокручивается, линия слева как у Drawer (color-mix с --border)", () => {
  const base = block(css(), ".right-panel");
  assert.match(base, /overflow-y:\s*auto/);
  assert.match(base, /border-left:\s*1px solid color-mix\(in srgb,\s*var\(--border\)/);
});

test("FEAT-20.37: тап-цели >= 40px у «Показать все» и «Повторить»", () => {
  const src = css();
  assert.match(block(src, ".rp-more"), /min-height:\s*40px/);
  assert.match(block(src, ".rp-retry"), /min-height:\s*40px/);
});

test("FEAT-20.38: тап-цели >= 40px у поиска, очистки, строк Skills и кнопки закрытия модалки", () => {
  const src = css();
  assert.match(block(src, ".rp-search-input"), /min-height:\s*40px/);
  assert.match(block(src, ".rp-search-clear"), /min-height:\s*40px/);
  assert.match(block(src, ".rp-search-clear"), /min-width:\s*40px/);
  assert.match(block(src, ".rp-skill"), /min-height:\s*40px/);
  assert.match(block(src, ".rp-modal-close"), /min-height:\s*40px/);
  assert.match(block(src, ".rp-modal-close"), /min-width:\s*40px/);
});

test("FEAT-20.38: модалка Skill фиксирована поверх экрана и имеет внутренний скролл тела", () => {
  const src = css();
  assert.match(block(src, ".rp-modal-backdrop"), /position:\s*fixed/);
  assert.match(block(src, ".rp-modal-body"), /overflow-y:\s*auto/);
});

test("FEAT-20.38: строки Skills в grid не растягивают правую панель по горизонтали (min-width: 0 + minmax(0, 1fr))", () => {
  const src = css();
  assert.match(block(src, ".rp-rows"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(block(src, ".rp-skill"), /min-width:\s*0/);
  assert.match(block(src, ".rp-skill"), /overflow:\s*hidden/);
  assert.match(block(src, ".rp-section"), /min-width:\s*0/);
});

test("FEAT-20.38: нативный крестик search-input скрыт, чтобы не дублировать .rp-search-clear", () => {
  const src = css();
  assert.match(block(src, ".rp-search-input::-webkit-search-cancel-button"), /appearance:\s*none/);
});
