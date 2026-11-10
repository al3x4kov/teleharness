// C7 FileViewer (L2, TASK-14.7): открытие (портал в body, role=dialog,
// заголовок, фокус на «Закрыть», оболочка inert), загрузка по пути через
// /zai/api/file (скелетон → содержимое: текст, markdown без frontmatter, CSV
// таблицей), HTML в песочнице (iframe sandbox без allow-same-origin), SVG —
// только через <img> (скрипты внутри SVG не исполняются), ошибки с причиной и
// «Повторить», закрытие (✕, Escape, клик по фону) и возврат фокуса.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ FileViewer: "src/components/chat/FileViewer.jsx" });
  t$ = createHarness(ui);
  // Песочница iframe — атрибут; саму страницу happy-dom грузить не должен
  // (никаких сетевых запросов из тестов).
  try {
    window.happyDOM.settings.disableIframePageLoading = true;
  } catch {}
});

const SID = "ses_fv";
const DIR = "D:\\Chats\\fv";
let realFetch = null;
afterEach(() => {
  t$.cleanup();
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  ui.store.sessions.value = [];
  ui.store.setActiveId(null);
  document.querySelector(".shell")?.remove();
  installFetch();
});

function openChat() {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
}

// Фейковый fetch из helpers отдаёт только JSON; для /zai/api/file нужны сырые
// тела и заголовки (content-length). files: { "<имя>": {status, body, length} }.
const fileCalls = [];
function serveFiles(files) {
  fileCalls.length = 0;
  realFetch = globalThis.fetch;
  const base = realFetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input), "https://zai.test");
    if (u.pathname !== "/zai/api/file") return base(input, init);
    const method = (init.method ?? "GET").toUpperCase();
    const p = u.searchParams.get("path") ?? "";
    fileCalls.push({ method, path: p, directory: u.searchParams.get("directory") });
    const name = p.split(/[\\/]/).pop();
    const f = typeof files === "function" ? files(name, method) : files[name];
    if (!f) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const body = method === "HEAD" ? null : f.body ?? "";
    const len = f.length ?? (typeof f.body === "string" ? Buffer.byteLength(f.body) : 0);
    return new Response(body, { status: f.status ?? 200, headers: { "content-length": String(len) } });
  };
}

const panel = () => document.querySelector(".file-panel");
const sub = () => (panel()?.querySelector(".file-sub")?.textContent ?? "").replace(/\u00a0/g, " ");

// ---- открытие ----------------------------------------------------------------------

test("открытие: портал в body, role=dialog «Файл <имя>», фокус на «Закрыть», оболочка за ним inert", async () => {
  openChat();
  serveFiles({ "notes.txt": { body: "привет" } });
  const shell = document.createElement("div");
  shell.className = "shell";
  const chip = document.createElement("button");
  shell.appendChild(chip);
  document.body.appendChild(shell);
  chip.focus();
  const h = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\notes.txt`, name: "notes.txt" }, onClose() {} });
  const dlg = panel();
  assert.ok(dlg);
  assert.equal(h.root.contains(dlg), false, "порталом в body");
  assert.equal(dlg.getAttribute("role"), "dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  assert.equal(dlg.getAttribute("aria-label"), "Файл notes.txt");
  assert.equal($(dlg, ".file-title").textContent, "notes.txt");
  assert.equal(document.activeElement, $(dlg, 'button[aria-label="Закрыть"]'));
  assert.equal(shell.hasAttribute("inert"), true);
  assert.equal(shell.getAttribute("aria-hidden"), "true");
  assert.equal(document.body.style.overflow, "hidden");
  const dl = $(dlg, 'a[aria-label="Скачать notes.txt"]');
  const dlUrl = new URL(dl.getAttribute("href"), "https://zai.test");
  assert.equal(dlUrl.pathname, "/zai/api/file");
  assert.equal(dlUrl.searchParams.get("download"), "1");
  assert.equal(dlUrl.searchParams.get("directory"), DIR);

  h.unmount();
  assert.equal(shell.hasAttribute("inert"), false, "inert снят");
  assert.equal(shell.hasAttribute("aria-hidden"), false);
  assert.equal(document.body.style.overflow, "");
  assert.equal(document.activeElement, chip, "фокус вернулся на чип, открывший просмотр");
});

test("текст по пути: скелетон «Загрузка файла», затем <pre> с содержимым; шапка — тип и вес", async () => {
  openChat();
  serveFiles({ "run.log": { body: "line 1\nline 2" } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\run.log`, name: "run.log" }, onClose() {} });
  assert.ok($(panel(), '[role="status"][aria-label="Загрузка файла"]'), "сначала скелетон");
  await t$.waitFor(() => $(panel(), "pre.file-pre"));
  assert.equal($(panel(), "pre.file-pre").textContent, "line 1\nline 2");
  assert.deepEqual(fileCalls.map((c) => [c.method, c.path, c.directory]), [["GET", `${DIR}\\run.log`, DIR]]);
  assert.match(sub(), /13 Б$/);
});

test("markdown: frontmatter не рендерится, текст — разметкой", async () => {
  openChat();
  serveFiles({ "doc.md": { body: "---\ntitle: x\ntags: a\n---\n# Заголовок\n\nАбзац **жирный**." } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\doc.md`, name: "doc.md" }, onClose() {} });
  const md = await t$.waitFor(() => $(panel(), ".file-md"));
  await t$.waitFor(() => md.textContent.includes("Абзац"));
  assert.equal(md.textContent.includes("title: x"), false, "frontmatter скрыт");
  assert.ok($(md, "strong"));
});

test("BUG-153: frontmatter с вложенными ключами и списком (memory/Obsidian) тоже скрыт, а не становится заголовком", async () => {
  openChat();
  const body = '---\nname: zai-closure\ndescription: "run"\nmetadata:\n  node_type: memory\n  type: project\ntags:\n  - a\n  - b\n---\n\nТекст заметки.';
  serveFiles({ "note.md": { body } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\note.md`, name: "note.md" }, onClose() {} });
  const md = await t$.waitFor(() => $(panel(), ".file-md"));
  await t$.waitFor(() => md.textContent.includes("Текст заметки"));
  assert.equal(md.textContent.includes("node_type"), false, "frontmatter скрыт");
  assert.equal($$(md, "h1, h2").length, 0, "нет заголовка из метаданных");
});

test("CSV с «;» → таблица с заголовком, числа помечены", async () => {
  openChat();
  serveFiles({ "sales.csv": { body: "Месяц;Сумма\nЯнварь;100\nФевраль;250\n" } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\sales.csv`, name: "sales.csv" }, onClose() {} });
  const table = await t$.waitFor(() => $(panel(), "table.file-csv"));
  assert.deepEqual($$(table, "th").map((x) => x.textContent), ["Месяц", "Сумма"]);
  assert.equal($$(table, "tbody tr").length, 2);
  assert.equal($$(table, "td.num").length, 2);
  assert.ok(panel().classList.contains("is-wide"));
});

// ---- песочница -------------------------------------------------------------------

test("HTML: HEAD-проверка, затем iframe с sandbox без allow-same-origin и пояснение про песочницу", async () => {
  openChat();
  serveFiles({ "report.html": { body: "<script>parent.document.title='x'</script>", length: 120 } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\report.html`, name: "report.html" }, onClose() {} });
  const frame = await t$.waitFor(() => $(panel(), "iframe.file-frame--html"));
  assert.deepEqual(fileCalls.map((c) => c.method), ["HEAD"], "тело страницы в портал не читается — только HEAD");
  const sandbox = frame.getAttribute("sandbox");
  assert.ok(sandbox != null, "iframe в песочнице");
  const tokens = sandbox.split(/\s+/);
  assert.equal(tokens.includes("allow-same-origin"), false, "страница не видит origin портала (куки, API)");
  assert.equal(tokens.includes("allow-top-navigation"), false, "не уводит вкладку портала");
  assert.equal(frame.getAttribute("title"), "report.html");
  assert.equal(new URL(frame.getAttribute("src"), "https://zai.test").pathname, "/zai/api/file");
  assert.match(panel().textContent, /Страница открыта в песочнице: скрипты работают, но не видят портал/);
});

test("SVG: показывается через <img> (скрипты внутри SVG не исполняются), не iframe и не встраивается в DOM", async () => {
  openChat();
  serveFiles({ "logo.svg": { body: "", length: 512 } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\logo.svg`, name: "logo.svg" }, onClose() {} });
  const img = await t$.waitFor(() => $(panel(), "img.file-img"));
  assert.equal($(panel(), "iframe"), null);
  assert.equal($(panel(), ".file-body svg"), null, "разметка SVG не вставляется в страницу");
  assert.equal(img.getAttribute("alt"), "logo.svg");
  assert.equal(new URL(img.getAttribute("src"), "https://zai.test").searchParams.get("path"), `${DIR}\\logo.svg`);
  Object.defineProperty(img, "naturalWidth", { value: 64, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 32, configurable: true });
  t$.fire(img, "load");
  await t$.waitFor(() => sub() === "SVG · 64×32 · 512 Б");
});

test("SVG из data:URL (вложение) — тоже <img>, без запроса к серверу", () => {
  const svg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  serveFiles({});
  t$.mount(ui.FileViewer, { file: { dataUrl: svg, name: "evil.svg" }, onClose() {} });
  assert.ok($(panel(), "img.file-img"));
  assert.equal(document.querySelector(".file-body script"), null);
  assert.equal(fileCalls.length, 0);
});

// ---- ошибки ------------------------------------------------------------------------

test("404 → «Файл не найден» с «Повторить»; повтор после появления файла показывает содержимое", async () => {
  openChat();
  let exists = false;
  serveFiles((name) => (exists && name === "late.txt" ? { body: "готово" } : null));
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\late.txt`, name: "late.txt" }, onClose() {} });
  const alert = await t$.waitFor(() => $(panel(), '.file-bin[role="alert"]'));
  assert.match(alert.textContent, /Файл не найден/);
  assert.equal(panel().textContent.includes("not found"), false, "сырой JSON ответа не показывается");
  exists = true;
  t$.click(byText(panel(), "button", "Повторить"));
  await t$.waitFor(() => $(panel(), "pre.file-pre")?.textContent === "готово");
  assert.equal(fileCalls.length, 2);
});

test("403 → «Нет доступа к файлу» без «Повторить»; неизвестный формат → карточка «Скачать»", async () => {
  openChat();
  serveFiles({ "secret.txt": { status: 403, body: "{}" }, "data.bin": { body: "", length: 2048 } });
  const a = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\secret.txt`, name: "secret.txt" }, onClose() {} });
  await t$.waitFor(() => /Нет доступа к файлу/.test(panel()?.textContent ?? ""));
  assert.equal(byText(panel(), "button", "Повторить"), null);
  a.unmount();
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\data.bin`, name: "data.bin" }, onClose() {} });
  await t$.waitFor(() => /Предпросмотр этого формата недоступен · 2 КБ/.test((panel()?.textContent ?? "").replace(/\u00a0/g, " ")));
  assert.ok($(panel(), "a.file-bin-dl[download]"));
});

test("пустой текстовый файл → «Файл пустой · 0 Б» и «Скачать»", async () => {
  openChat();
  serveFiles({ "empty.txt": { body: "   " } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\empty.txt`, name: "empty.txt" }, onClose() {} });
  await t$.waitFor(() => /Файл пустой/.test(panel()?.textContent ?? ""));
  assert.ok($(panel(), "a.file-bin-dl"));
});

// ---- закрытие ----------------------------------------------------------------------

test("закрытие: ✕, Escape и клик по фону вызывают onClose; клик внутри панели — нет", async () => {
  openChat();
  serveFiles({ "a.txt": { body: "a" } });
  let closed = 0;
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\a.txt`, name: "a.txt" }, onClose: () => (closed += 1) });
  await t$.waitFor(() => $(panel(), "pre.file-pre"));
  t$.click($(panel(), 'button[aria-label="Закрыть"]'));
  assert.equal(closed, 1);
  t$.key(document, "Escape");
  assert.equal(closed, 2);
  t$.fire(document.querySelector(".file-backdrop"), "mousedown", {}, MouseEvent);
  assert.equal(closed, 3);
  t$.fire(panel(), "mousedown", {}, MouseEvent);
  assert.equal(closed, 3);
});

test("фокус: Tab из-за пределов панели возвращается внутрь; Tab с последнего элемента — на первый", async () => {
  openChat();
  serveFiles({ "a.txt": { body: "a" } });
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\a.txt`, name: "a.txt" }, onClose() {} });
  await t$.waitFor(() => $(panel(), "pre.file-pre"));
  const close = $(panel(), 'button[aria-label="Закрыть"]');
  assert.equal(document.activeElement, close);
  // Tab с последнего (✕) — по кругу внутрь панели, не на кнопку снаружи.
  const notPrevented = t$.key(document, "Tab");
  assert.equal(notPrevented, false, "Tab с последнего элемента перехвачен");
  assert.ok(panel().contains(document.activeElement), "фокус остался в панели");
  outside.focus();
  t$.key(document, "Tab");
  assert.ok(panel().contains(document.activeElement), "фокус снаружи → внутрь панели");
});
