// C7 FileViewer (L2, TASK-14.7): открытие (портал в body, role=dialog,
// заголовок, фокус на «Закрыть», оболочка inert), загрузка по пути через
// /teleharness/api/file (скелетон → содержимое: текст, markdown без frontmatter, CSV
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

// Фейковый fetch из helpers отдаёт только JSON; для /teleharness/api/file нужны сырые
// тела и заголовки (content-length). files: { "<имя>": {status, body, length} }.
const fileCalls = [];
function serveFiles(files) {
  fileCalls.length = 0;
  realFetch = globalThis.fetch;
  const base = realFetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input), "https://teleharness.test");
    if (u.pathname !== "/teleharness/api/file") return base(input, init);
    const method = (init.method ?? "GET").toUpperCase();
    const p = u.searchParams.get("path") ?? "";
    fileCalls.push({ method, path: p, directory: u.searchParams.get("directory") });
    const name = p.split(/[\\/]/).pop();
    const f = typeof files === "function" ? files(name, method) : files[name];
    if (!f) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const body = method === "HEAD" ? null : f.body ?? "";
    const headers = {};
    if (f.headers) Object.assign(headers, f.headers);
    if (!f.omitLength) {
      const len = f.length ?? (typeof f.body === "string" ? Buffer.byteLength(f.body) : f.body instanceof Uint8Array ? f.body.byteLength : 0);
      headers["content-length"] = String(len);
    }
    return new Response(body, { status: f.status ?? 200, headers });
  };
}

const panel = () => document.querySelector(".file-panel");
const sub = () => (panel()?.querySelector(".file-sub")?.textContent ?? "").replace(/\u00a0/g, " ");

// Минимальный STORED ZIP-конструктор для тестов xlsx/docx/pptx (без зависимостей).
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    const local = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    dataBuf.copy(local, 30 + nameBuf.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function makeSamplePptx() {
  const png1x1 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");
  return buildZip({
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide2.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Титульный слайд</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:pPr lvl="0"/><a:r><a:rPr b="1"/><a:t>Главный тезис</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rImg1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg1" Target="../media/chart.png"/><Relationship Id="rNotes1" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/media/chart.png": png1x1,
    "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Заметка спикера 1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    "ppt/slides/slide2.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Показатель</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Значение</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Выручка</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>420</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
  });
}

function makeSampleXlsx() {
  return buildZip({
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Итоги" sheetId="1" r:id="rId1"/><sheet name="Детали" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Статья</t></is></c><c r="B1" t="inlineStr"><is><t>Сумма</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Облако</t></is></c><c r="B2"><v>500</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Узел</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>node-1</t></is></c></row></sheetData></worksheet>`,
  });
}

function makeSampleDocx() {
  return buildZip({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Отчёт</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Пункт списка</w:t></w:r></w:p></w:body></w:document>`,
  });
}

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
  const dlUrl = new URL(dl.getAttribute("href"), "https://teleharness.test");
  assert.equal(dlUrl.pathname, "/teleharness/api/file");
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

test("markdown: frontmatter (в т.ч. кириллические ключи) не рендерится, текст — разметкой", async () => {
  openChat();
  serveFiles({ "doc.md": { body: "---\nназвание: x\ntags: a\n---\n# Заголовок\n\nАбзац **жирный**." } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\doc.md`, name: "doc.md" }, onClose() {} });
  const md = await t$.waitFor(() => $(panel(), ".file-md"));
  await t$.waitFor(() => md.textContent.includes("Абзац"));
  assert.equal(md.textContent.includes("название: x"), false, "frontmatter с кириллическим ключом скрыт");
  assert.ok($(md, "strong"));
});

test("BUG-153: frontmatter с вложенными ключами и списком (memory/Obsidian) тоже скрыт, а не становится заголовком", async () => {
  openChat();
  const body = '---\nname: teleharness-closure\ndescription: "run"\nmetadata:\n  node_type: memory\n  type: project\ntags:\n  - a\n  - b\n---\n\nТекст заметки.';
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

// ---- офисные форматы (BUG-301) -----------------------------------------------------

test("BUG-301: PPTX предпросмотр — слайды по порядку, заголовки, текст, таблица, картинка (blob+revoke), заметки спикера", async () => {
  openChat();
  const pptx = makeSamplePptx();
  serveFiles({ "deck.pptx": { body: pptx } });
  const created = [];
  const revoked = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    const u = `blob:test/${created.length}`;
    created.push({ u, type: blob.type, size: blob.size });
    return u;
  };
  URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    const h = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\deck.pptx`, name: "deck.pptx" }, onClose() {} });
    const wrap = await t$.waitFor(() => $(panel(), ".file-pptx"));
    const slides = $$(wrap, ".file-slide");
    assert.equal(slides.length, 2, "оба слайда отрисованы");
    assert.match(slides[0].textContent, /Слайд 1/);
    assert.match(slides[0].textContent, /Титульный слайд/);
    assert.match(slides[0].textContent, /Главный тезис/);
    assert.ok($(slides[0], "strong"), "жирный текст сохранён");
    const img = $(slides[0], "img.file-slide-img");
    assert.ok(img, "встроенное изображение отрисовано");
    assert.equal(img.getAttribute("src"), "blob:test/0");
    const notes = $(slides[0], "details.file-pptx-notes");
    assert.ok(notes && /Заметка спикера 1/.test(notes.textContent), "заметки спикера в сворачиваемом блоке");
    assert.match(slides[1].textContent, /Слайд 2/);
    assert.ok($(slides[1], "table.file-csv"), "таблица на 2-м слайде");
    assert.match(slides[1].textContent, /Выручка/);
    assert.ok(panel().classList.contains("is-wide"));
    assert.match(sub(), /^Презентация PowerPoint/);
    h.unmount();
    assert.deepEqual(revoked, ["blob:test/0"], "objectURL освобождён при закрытии");
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test("BUG-301: XLSX и XLSM предпросмотр с переключением листов", async () => {
  openChat();
  const book = makeSampleXlsx();
  serveFiles({ "budget.xlsm": { body: book } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\budget.xlsm`, name: "budget.xlsm" }, onClose() {} });
  const tabs = await t$.waitFor(() => {
    const items = $$(panel(), 'button[role="tab"]');
    return items.length > 0 ? items : null;
  });
  assert.deepEqual(tabs.map((x) => x.textContent), ["Итоги", "Детали"]);
  assert.match(panel().textContent, /Облако/);
  t$.click(tabs[1]);
  await t$.waitFor(() => /node-1/.test(panel().textContent));
});

test("BUG-301: DOCX предпросмотр — заголовок и список", async () => {
  openChat();
  serveFiles({ "spec.docx": { body: makeSampleDocx() } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\spec.docx`, name: "spec.docx" }, onClose() {} });
  const docx = await t$.waitFor(() => $(panel(), ".file-docx"));
  assert.equal($(docx, "h2").textContent, "Отчёт");
  assert.equal($(docx, "ul li").textContent, "Пункт списка");
});

test("BUG-301: битый PPTX → «Не удалось разобрать содержимое» и рабочая кнопка «Скачать»", async () => {
  openChat();
  serveFiles({ "broken.pptx": { body: "not-a-zip-at-all" } });
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\broken.pptx`, name: "broken.pptx" }, onClose() {} });
  await t$.waitFor(() => /Не удалось разобрать содержимое/.test(panel()?.textContent ?? ""));
  assert.ok($(panel(), "a.file-bin-dl"));
});

// ---- PDF / видео / аудио -----------------------------------------------------------

test("PDF, видео и аудио: HEAD-проверка и корректные элементы просмотра", async () => {
  openChat();
  serveFiles({
    "manual.pdf": { body: "", length: 4096 },
    "clip.mp4": { body: "", length: 8192 },
    "voice.mp3": { body: "", length: 1024 },
  });
  const p = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\manual.pdf`, name: "manual.pdf" }, onClose() {} });
  await t$.waitFor(() => $(panel(), "iframe.file-frame"));
  assert.ok($(panel(), "a.file-head-link"), "для PDF есть «Открыть целиком»");
  p.unmount();

  const v = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\clip.mp4`, name: "clip.mp4" }, onClose() {} });
  await t$.waitFor(() => $(panel(), "video.file-media"));
  v.unmount();

  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\voice.mp3`, name: "voice.mp3" }, onClose() {} });
  await t$.waitFor(() => $(panel(), "audio.file-audio"));
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
  assert.equal(new URL(frame.getAttribute("src"), "https://teleharness.test").pathname, "/teleharness/api/file");
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
  assert.equal(new URL(img.getAttribute("src"), "https://teleharness.test").searchParams.get("path"), `${DIR}\\logo.svg`);
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

test("BUG-301: не-картинка data:URL (text/csv) открывается как текст/таблица, а не битый <img>", async () => {
  const csvDataUrl = "data:text/csv;base64," + Buffer.from("A,B\n1,2\n").toString("base64");
  serveFiles({});
  t$.mount(ui.FileViewer, { file: { dataUrl: csvDataUrl, name: "table.csv" }, onClose() {} });
  const table = await t$.waitFor(() => $(panel(), "table.file-csv"));
  assert.equal($(panel(), "img.file-img"), null);
  assert.deepEqual($$(table, "th").map((x) => x.textContent), ["A", "B"]);
});

// ---- лимиты и ошибки ---------------------------------------------------------------

test("BUG-301: слишком большой текст по Content-Length И по chunked-потоку без Content-Length → карточка too-big", async () => {
  openChat();
  serveFiles({
    "huge-len.txt": { body: "x", length: 2 * 1024 * 1024 },
    "huge-chunked.txt": {
      omitLength: true,
      body: new ReadableStream({
        start(ctrl) {
          const chunk = new Uint8Array(300 * 1024).fill(65);
          for (let i = 0; i < 5; i += 1) ctrl.enqueue(chunk);
          ctrl.close();
        },
      }),
    },
  });
  const a = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\huge-len.txt`, name: "huge-len.txt" }, onClose() {} });
  await t$.waitFor(() => /Файл слишком большой для предпросмотра/.test(panel()?.textContent ?? ""));
  a.unmount();

  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\huge-chunked.txt`, name: "huge-chunked.txt" }, onClose() {} });
  await t$.waitFor(() => /Файл слишком большой для предпросмотра/.test(panel()?.textContent ?? ""));
  assert.ok($(panel(), "a.file-bin-dl"));
});

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

test("403, 401, 500, сетевой сбой (status=0) и ошибка декодирования <img> после HEAD 200", async () => {
  openChat();
  serveFiles({
    "secret.txt": { status: 403, body: "{}" },
    "unauth.txt": { status: 401, body: "{}" },
    "boom.txt": { status: 500, body: "{}" },
    "bad.png": { body: "", length: 512 },
    "data.bin": { body: "", length: 2048 },
  });

  const a = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\secret.txt`, name: "secret.txt" }, onClose() {} });
  await t$.waitFor(() => /Нет доступа к файлу/.test(panel()?.textContent ?? ""));
  assert.equal(byText(panel(), "button", "Повторить"), null);
  a.unmount();

  const b = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\unauth.txt`, name: "unauth.txt" }, onClose() {} });
  await t$.waitFor(() => panel()?.querySelector('.file-bin[role="alert"]'));
  b.unmount();

  const c = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\boom.txt`, name: "boom.txt" }, onClose() {} });
  await t$.waitFor(() => panel()?.querySelector('.file-bin[role="alert"]'));
  assert.ok(byText(panel(), "button", "Повторить"), "при 500 есть «Повторить»");
  c.unmount();

  // Битая картинка после HEAD 200 → понятное сообщение + кнопка «Скачать» (не ложный 404).
  const imgMount = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\bad.png`, name: "bad.png" }, onClose() {} });
  const img = await t$.waitFor(() => $(panel(), "img.file-img"));
  t$.fire(img, "error");
  await t$.waitFor(() => /Браузер не может показать этот файл/.test(panel()?.textContent ?? ""));
  assert.ok($(panel(), "a.file-bin-dl"), "при битом изображении доступна кнопка «Скачать»");
  imgMount.unmount();

  // Неизвестный формат → карточка «Скачать»
  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\data.bin`, name: "data.bin" }, onClose() {} });
  await t$.waitFor(() => /Предпросмотр этого формата недоступен · 2 КБ/.test((panel()?.textContent ?? "").replace(/\u00a0/g, " ")));
  assert.ok($(panel(), "a.file-bin-dl[download]"));
});

test("пустой текстовый файл (0 Б) и пустой PDF (HEAD content-length: 0) → «Файл пустой · 0 Б» и «Скачать»", async () => {
  openChat();
  serveFiles({ "empty.txt": { body: "" }, "empty.pdf": { body: "", length: 0 } });
  const a = t$.mount(ui.FileViewer, { file: { path: `${DIR}\\empty.txt`, name: "empty.txt" }, onClose() {} });
  await t$.waitFor(() => /Файл пустой · 0 Б/.test((panel()?.textContent ?? "").replace(/\u00a0/g, " ")));
  assert.ok($(panel(), "a.file-bin-dl"));
  a.unmount();

  t$.mount(ui.FileViewer, { file: { path: `${DIR}\\empty.pdf`, name: "empty.pdf" }, onClose() {} });
  await t$.waitFor(() => /Файл пустой · 0 Б/.test((panel()?.textContent ?? "").replace(/\u00a0/g, " ")));
  assert.ok($(panel(), "a.file-bin-dl"));
});

// ---- скачивание в мобильной / PWA версии (BUG-301) ---------------------------------

test("BUG-301: мобильный PWA — клик «Скачать» в шапке и карточке загружает Blob через fetch → navigator.share / ObjectURL fallback", async () => {
  openChat();
  serveFiles({ "archive.bin": { body: "BINARY_DATA", length: 11 } });
  const prevStandalone = Object.getOwnPropertyDescriptor(navigator, "standalone");
  const prevShare = Object.getOwnPropertyDescriptor(navigator, "share");
  const prevCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare");
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  const shared = [];
  const createdUrls = [];
  Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  Object.defineProperty(navigator, "share", { value: async (data) => { shared.push(data); }, configurable: true });
  URL.createObjectURL = (blob) => {
    const u = `blob:dl/${createdUrls.length}`;
    createdUrls.push({ u, size: blob.size });
    return u;
  };
  URL.revokeObjectURL = () => {};

  try {
    t$.mount(ui.FileViewer, { file: { path: `${DIR}\\archive.bin`, name: "archive.bin" }, onClose() {} });
    const cardBtn = await t$.waitFor(() => $(panel(), "a.file-bin-dl"));
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    cardBtn.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, "в standalone PWA клик перехватывается JS-обработчиком");
    await t$.waitFor(() => shared.length === 1);
    assert.equal(shared[0].files.length, 1);
    assert.equal(shared[0].files[0].name, "archive.bin");

    // Теперь без canShare — fallback на Blob + ObjectURL через кнопку в шапке
    Object.defineProperty(navigator, "canShare", { value: () => false, configurable: true });
    const headBtn = $(panel(), 'a.file-head-btn[aria-label="Скачать archive.bin"]');
    const ev2 = new MouseEvent("click", { bubbles: true, cancelable: true });
    headBtn.dispatchEvent(ev2);
    assert.equal(ev2.defaultPrevented, true, "кнопка в шапке тоже использует надёжное скачивание");
    await t$.waitFor(() => createdUrls.length === 1);
    assert.equal(createdUrls[0].size, 11);
  } finally {
    if (prevStandalone) Object.defineProperty(navigator, "standalone", prevStandalone);
    else delete navigator.standalone;
    if (prevShare) Object.defineProperty(navigator, "share", prevShare);
    else delete navigator.share;
    if (prevCanShare) Object.defineProperty(navigator, "canShare", prevCanShare);
    else delete navigator.canShare;
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
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

