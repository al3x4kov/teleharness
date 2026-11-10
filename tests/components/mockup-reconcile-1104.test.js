// Сверка «макет ↔ прод 1.8.6» (2026-11-04, design/mockups-v2/RECONCILIATION-2026-11-04.md):
// пять UI-дефектов. jsdom не считает вёрстку, поэтому вид проверяем по
// разметке (классы, атрибуты) и по правилам CSS, которые его задают.
//   BUG-101 — «Чат не найден»: без композера и пилюль, в шапке нет «Без названия» и «…»
//   BUG-102 — пилюли модели/агента: тап-цель ≥ 40 px и на коротком экране, хит-зона 44
//   BUG-103 — короткий Markdown в просмотре файла: колонка на всю ширину, текст слева
//   BUG-104 — экран входа: терракотовый знак zai + «zai» антиквой, без синего моно-тайла
//   BUG-105 — пилюли на 402 px в одну строку, длинное имя режется многоточием
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    ModelBar: "src/components/chat/ModelBar.jsx",
    LoginView: "src/components/views/LoginView.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.providerCfg.value = null;
  installFetch();
});

const css = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Все правила (в том числе внутри @media), у которых в списке селекторов есть
// селектор, оканчивающийся на `sel` (без псевдоклассов после него).
function rulesFor(text, sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (sels.some((s) => s === sel || s.endsWith(` ${sel}`) || s.endsWith(`>${sel}`) || s.endsWith(`> ${sel}`))) out.push({ sel: m[1].trim(), body: m[2] });
  }
  return out;
}
const decl = (body, prop) => new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`).exec(body)?.[1].trim() ?? null;
const LAYERS = ["src/components/views.css", "src/components/chat.css", "src/claude-look.css"];

// ---- BUG-101 ----------------------------------------------------------------------

test("BUG-101: «Чат не найден» — нет композера, поля ввода и пилюль; в шапке нет «Без названия» и «…»", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [] },
    { method: "GET", path: /\/zai\/api\/session\/[^/]+\/message$/, reply: () => ({ status: 404, body: { error: "not found" } }) },
  ]);
  const { root } = t$.mount(ui.ChatView, { id: "ses_nonexistent000000000000" });
  await t$.waitFor(() => byText(root, "h2.hero", "Чат не найден"));
  await t$.flush(3);
  assert.equal(!!$(root, "footer.composer"), false, "композера нет — писать некуда");
  assert.equal(!!$(root, "textarea"), false, "поля ввода нет");
  assert.equal($$(root, ".model-pill").length, 0, "пилюль модели/агента нет");
  assert.equal(!!byText(root, "button.empty-cta", "К чатам"), true, "единственное действие — «К чатам»");
  const head = $(root, ".chat-header");
  assert.equal(/Без названия/.test(head.textContent), false, "в шапке нет «Без названия»");
  assert.equal(/…/.test(head.textContent), false, "в шапке нет «…» загрузки");
});

// ---- BUG-102 ----------------------------------------------------------------------

test("BUG-102: ни одно правило (и в @media компактного стека) не опускает пилюлю ниже 40 px; хит-зона добрана до 44", () => {
  for (const file of LAYERS) {
    for (const r of rulesFor(css(file), ".model-pill")) {
      const mh = decl(r.body, "min-height");
      if (mh == null) continue;
      assert.ok(Number.parseFloat(mh) >= 40, `${file}: «${r.sel} { min-height: ${mh} }» — тап-цель < 40 px`);
    }
  }
  const look = css("src/claude-look.css");
  const base = rulesFor(look, ".model-pill").find((r) => decl(r.body, "min-height"));
  const h = Number.parseFloat(decl(base.body, "min-height"));
  assert.match(decl(base.body, "position") ?? "", /relative/, "пилюля — опора для хит-зоны");
  const hit = rulesFor(look, ".model-pill::after")[0];
  assert.ok(hit, "у пилюли есть псевдоэлемент хит-зоны");
  assert.match(decl(hit.body, "position"), /absolute/);
  const inset = decl(hit.body, "inset").split(/\s+/).map(Number.parseFloat);
  const grow = -inset[0] + -(inset[2] ?? inset[0]);
  assert.ok(h + grow >= 44, `хит-зона по высоте ${h + grow} px ≥ 44`);
});

// ---- BUG-103 ----------------------------------------------------------------------

test("BUG-103: колонка чтения (.file-md/.file-docx) с auto-полями растянута на всю ширину (width: 100%), не сжимается по тексту", () => {
  const chat = css("src/components/chat.css");
  for (const sel of [".file-md", ".file-docx"]) {
    const r = rulesFor(chat, sel).find((x) => decl(x.body, "max-width"));
    assert.ok(r, `есть правило ${sel}`);
    assert.equal(decl(r.body, "max-width"), "720px");
    assert.equal(decl(r.body, "width"), "100%", `${sel}: width 100% — иначе margin auto во flex-колонке сжимает блок по тексту и ставит по центру`);
  }
  // .file-pre и .file-office тянутся align-self: stretch без auto-полей.
  for (const sel of [".file-pre", ".file-office"]) {
    const r = rulesFor(chat, sel).find((x) => decl(x.body, "align-self"));
    assert.equal(decl(r.body, "align-self"), "stretch");
    assert.equal(decl(r.body, "margin")?.includes("auto") ?? false, false, `${sel}: без auto-полей`);
  }
});

// ---- BUG-104 ----------------------------------------------------------------------

test("BUG-104: экран входа — знак zai (svg.zai-mark) + «zai» антиквой, без синего моно-тайла и пунктирного кольца", () => {
  ui.store.me.value = false;
  const { root } = t$.mount(ui.LoginView);
  const mark = $(root, ".login-mark");
  assert.equal(mark.getAttribute("aria-hidden"), "true");
  assert.ok(!!$(mark, "svg.zai-mark"), "тот же знак, что в меню и приветствии");
  assert.equal($(mark, ".login-word")?.textContent, "Teleharness"); // rebrand
  assert.equal(!!$(root, ".login-tile"), false, "моно-тайла нет");
  assert.equal(!!$(root, ".login-ring"), false, "пунктирного кольца нет");
  const views = css("src/components/views.css");
  const look = css("src/claude-look.css");
  assert.equal(rulesFor(views, ".login-tile").length, 0, "правило синего тайла удалено");
  const word = [...rulesFor(views, ".login-word"), ...rulesFor(look, ".login-word")].map((r) => r.body).join(";");
  assert.match(word, /font-family:\s*var\(--font-serif\)/, "«zai» антиквой");
  const zm = rulesFor(look, ".zai-mark")[0];
  assert.match(decl(zm.body, "color"), /var\(--brand\)/, "знак — терракота --brand");
});

// ---- BUG-105 ----------------------------------------------------------------------

test("BUG-105: пилюли — отдельная строка без переноса, пилюля сжимается, имя режется многоточием; подсказка ниже", () => {
  ui.store.providerCfg.value = { models: [{ id: "glm-5.3-flash", providerID: "zai-coding-plan", label: "GLM-5.3 Flash (zai-coding-plan)" }] };
  ui.store.setPrefs?.({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "Sisyphus - ultraworker" });
  ui.store.sessions.value = [{ id: "ses_p", title: "", directory: "C:\\Home", time: { created: 1, updated: 1 } }];
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_p", hasMessages: false });
  const row = $(root, ".model-bar > .model-pills");
  assert.ok(!!row, "пилюли в своей строке .model-pills");
  assert.equal($$(row, ".model-pill").length, 2, "обе пилюли в одной строке");
  assert.equal(!!row.querySelector(".model-bar-note"), false, "подсказка — не в строке пилюль");
  assert.ok($(root, ".model-bar > .model-bar-note"));
  for (const p of $$(row, ".model-pill")) assert.ok($(p, ".pill-label"), "имя в .pill-label");

  const views = css("src/components/views.css");
  const pills = rulesFor(views, ".model-pills")[0];
  assert.ok(pills, "есть правило .model-pills");
  assert.equal(decl(pills.body, "flex-wrap"), "nowrap");
  assert.equal(decl(pills.body, "min-width"), "0");
  const pill = rulesFor(views, ".model-pill").find((r) => decl(r.body, "display"));
  assert.equal(decl(pill.body, "min-width"), "0", "пилюля может сжаться");
  assert.match(decl(pill.body, "flex") ?? "", /^0 1 auto$/, "пилюля сжимается (flex-shrink 1)");
  const label = rulesFor(views, ".pill-label")[0];
  assert.equal(decl(label.body, "text-overflow"), "ellipsis");
  assert.equal(decl(label.body, "white-space"), "nowrap");
  assert.equal(decl(label.body, "min-width"), "0");
});
