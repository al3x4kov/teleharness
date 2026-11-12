// TASK-01.82 (openspec rebrand-teleharness): видимое название «Teleharness», свой знак
// (форма А: «>» и две дуги), цвет бренда индиго; метка движка Claude остаётся оранжевой.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let ui, t$;
before(async () => {
  ui = await loadUI({
    ZaiMark: "src/components/Menu.jsx#ZaiMark",
    LoginView: "src/components/views/LoginView.jsx",
    BRAND: "src/components/views/SettingsView.jsx#BRAND",
    aboutLine: "src/components/views/SettingsView.jsx#aboutLine",
  });
  t$ = createHarness(ui);
});
afterEach(() => t$.cleanup());

test("знак: «>» и две дуги, без лучей прежней «искры»", () => {
  const { root } = t$.mount(ui.ZaiMark, { size: 26 });
  const svg = $(root, "svg.zai-mark");
  assert.ok(svg, "знак отрисован");
  assert.equal($$(svg, "path").length, 3, "шеврон и две дуги");
  assert.equal($$(svg, "rect").length, 0, "лучей «искры» нет");
  assert.equal(svg.getAttribute("width"), "26");
});

test("слово на входе и строка «О приложении» — Teleharness", () => {
  const { root } = t$.mount(ui.LoginView, {});
  assert.equal($(root, ".login-word")?.textContent, "Teleharness");
  assert.equal(ui.BRAND, "Teleharness");
  assert.equal(ui.aboutLine("1.17.4", { version: "1.17.4", opencodeVersion: "1.19.5" }).startsWith("Teleharness 1.17.4 · opencode 1.19.5"), true);
  assert.match(ui.aboutLine("1.17.4", { version: "1.17.2" }), /^Teleharness 1\.17\.4 \(сервер 1\.17\.2\) · /, "отставание сервера не съедает название");
});

test("цвет бренда — индиго в обеих темах; метка движка Claude остаётся оранжевой", () => {
  const look = read("src/claude-look.css");
  const brands = [...look.matchAll(/--brand:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(brands, ["#7c83ff", "#5b62e6", "#5b62e6"], "тёмная, светлая, системная светлая");
  assert.equal(/d97757/i.test(look), false, "терракота из токенов бренда ушла");
  assert.match(read("src/components/views.css"), /\.engine-dot\.is-claude\s*\{\s*background:\s*#d97757/i, "метка Claude — цвет движка");
});

test("манифест, вкладка, push по умолчанию и иконка приложения", () => {
  const man = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(man.name, "Teleharness");
  assert.equal(man.short_name, "Teleharness");
  assert.equal(man.start_url, "/zai/", "адрес портала не меняется");
  assert.match(read("public/index.html"), /<title>Teleharness<\/title>/);
  const sw = read("public/sw.js");
  assert.equal(/title: "zai"|\|\| "zai"/.test(sw), false);
  assert.match(sw, /data\.title \|\| "Teleharness"/);
  const icon = read("public/icons/icon.svg");
  assert.match(icon, /#7c83ff/i);
  assert.equal(/d97757/i.test(icon), false, "иконка не в цвете Claude");
});

test("длинное слово не распирает панель: обрезка многоточием", () => {
  const look = read("src/claude-look.css");
  const m = look.match(/\.drawer-word\s*\{([^}]*)\}/);
  assert.ok(m);
  assert.match(m[1], /text-overflow:\s*ellipsis/);
  assert.match(m[1], /white-space:\s*nowrap/);
});
