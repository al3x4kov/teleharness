// BUG-151: тап-цели ≥ 40–44px у мелких кнопок, найденных dogfood-обходом прода 1.10.1
// (zai-qa/explore.mjs): «Закрыть уведомление» 36×36, «Сбросить поиск» 21px, ссылка
// работающего чата в Настройках 20px. Вёрстку happy-dom не считает — проверяем правила CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = (f) => readFileSync(path.join(root, f), "utf8").split("\r\n").join("\n");

// Тела всех блоков «<sel> { … }», где селектор стоит в начале строки.
function block(src, sel) {
  const out = [];
  for (const chunk of src.split("\n" + sel + " {").slice(1)) out.push(chunk.slice(0, chunk.indexOf("}")));
  return out.join("\n");
}

test("BUG-151: .notice-close — хит-зона 44×44 (::after inset -4px поверх 36px)", () => {
  const d = css("src/components/dialogs.css");
  assert.match(block(d, ".notice-close::after"), /inset:\s*-4px/);
  assert.match(block(d, ".notice-close"), /position:\s*relative/);
});

test("BUG-151: .link-btn — хит-зона по высоте ≥ 44px (::after inset -12px)", () => {
  const v = css("src/components/views.css");
  assert.match(block(v, ".link-btn::after"), /inset:\s*-12px/);
  assert.match(block(v, ".link-btn"), /position:\s*relative/);
});

test("BUG-151: .busy-title — padding 10px по вертикали с компенсирующим margin", () => {
  const b = block(css("src/components/views.css"), ".busy-title");
  assert.match(b, /padding:\s*10px 0/);
  assert.match(b, /margin:\s*-10px 0/);
});

test("UI-ISSUE-03 (BUG-162): чип файла в сообщении (button.attach.is-link) — хит-зона ≥ 44px (::after inset -4px поверх 36px)", () => {
  const c = css("src/components/chat.css");
  assert.match(block(c, "button.attach.is-link::after"), /inset:\s*-4px/);
  assert.match(block(c, "button.attach.is-link"), /position:\s*relative/);
});
