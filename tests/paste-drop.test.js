// FEAT-01.88: чистая логика вставки из буфера и перетаскивания
// (src/lib/paste-drop.js; BRIEF-16, openspec paste-drop-agent-steps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { countLabel, dragInfo, droppedEntries, folderError, isGenericName, pasteAction, pastedFileName, pastedTextName, stamp, uniqueName } from "../src/lib/paste-drop.js";

const D = new Date(2026, 10, 19, 21, 30, 12); // локальное время
const file = (name, type = "application/pdf", size = 10) => ({ name, type, size });
const cd = ({ files = [], text = "", items = null } = {}) => ({
  files,
  items,
  getData: (t) => (t === "text/plain" ? text : ""),
});

test("stamp: «ГГГГ-ММ-ДД ЧЧ-ММ-СС» без двоеточий", () => {
  assert.equal(stamp(D), "2026-11-19 21-30-12");
});

test("имя вставленной картинки: безымянная → «Снимок <время>.png»; своя — сохраняется", () => {
  assert.equal(pastedFileName(file("image.png", "image/png"), D), "Снимок 2026-11-19 21-30-12.png");
  assert.equal(pastedFileName(file("Image.jpeg", "image/jpeg"), D), "Снимок 2026-11-19 21-30-12.jpg");
  assert.equal(pastedFileName(file("", "image/webp"), D), "Снимок 2026-11-19 21-30-12.webp");
  assert.equal(pastedFileName(file("blob", "image/png"), D), "Снимок 2026-11-19 21-30-12.png");
  assert.equal(pastedFileName(file("макет.png", "image/png"), D), "макет.png", "у картинки-файла имя своё");
  assert.equal(pastedFileName(file("отчёт.pdf"), D), "отчёт.pdf");
  assert.equal(isGenericName("image.png"), true);
  assert.equal(isGenericName("IMG_2306.png"), false);
});

test("несколько вставок в одну секунду — разные имена", () => {
  const taken = new Set();
  const a = pastedFileName(file("image.png", "image/png"), D, taken);
  taken.add(a);
  const b = pastedFileName(file("image.png", "image/png"), D, taken);
  taken.add(b);
  const c = pastedFileName(file("image.png", "image/png"), D, taken);
  assert.deepEqual([a, b, c], ["Снимок 2026-11-19 21-30-12.png", "Снимок 2026-11-19 21-30-12 (2).png", "Снимок 2026-11-19 21-30-12 (3).png"]);
  assert.equal(uniqueName("a", ["a"]), "a (2)", "без расширения");
  assert.equal(pastedTextName(D), "Вставка 2026-11-19 21-30-12.txt");
});

test("pasteAction: снимок → files; файлы из проводника → files", () => {
  const shot = file("image.png", "image/png");
  assert.deepEqual(pasteAction(cd({ files: [shot] })), { kind: "files", files: [shot] });
  const docs = [file("a.pdf"), file("b.xlsx", "application/vnd.ms-excel")];
  assert.equal(pasteAction(cd({ files: docs })).files.length, 2);
  // текст рядом с не-картинкой (имя файла в text/plain) — всё равно файлы
  assert.equal(pasteAction(cd({ files: [file("a.pdf")], text: "a.pdf" })).kind, "files");
});

test("pasteAction: короткий текст → обычная вставка; текст + картинка-рендер (Word/Excel) → текст", () => {
  assert.equal(pasteAction(cd({ text: "привет" })).kind, "default");
  assert.equal(pasteAction(cd({ text: "A1\tB1", files: [file("image.png", "image/png")] })).kind, "default");
  assert.equal(pasteAction(null).kind, "default");
  assert.equal(pasteAction(cd()).kind, "default", "пустой буфер — поведение браузера");
});

test("pasteAction: текст длиннее 5000 → longText; ровно 5000 — обычная вставка", () => {
  assert.equal(pasteAction(cd({ text: "x".repeat(5000) })).kind, "default");
  const r = pasteAction(cd({ text: "y".repeat(12000) }));
  assert.equal(r.kind, "longText");
  assert.equal(r.text.length, 12000);
  assert.equal(pasteAction(cd({ text: "z".repeat(10) }), { longText: 5 }).kind, "longText");
});

test("pasteAction: файлы только в items (старый Safari)", () => {
  const f = file("image.png", "image/png");
  const r = pasteAction(cd({ items: [{ kind: "string", type: "text/html" }, { kind: "file", type: "image/png", getAsFile: () => f }] }));
  assert.deepEqual(r, { kind: "files", files: [f] });
});

test("dragInfo: зона только для файлов; число и «фото»", () => {
  assert.deepEqual(dragInfo({ types: ["text/plain", "text/uri-list"] }), { files: false, count: 0, images: false });
  const three = { types: ["Files"], items: [{ kind: "file", type: "application/pdf" }, { kind: "file", type: "image/png" }, { kind: "file", type: "" }] };
  assert.deepEqual(dragInfo(three), { files: true, count: 3, images: false });
  const two = { types: ["Files"], items: [{ kind: "file", type: "image/jpeg" }, { kind: "file", type: "image/heic" }] };
  assert.deepEqual(dragInfo(two), { files: true, count: 2, images: true });
  assert.deepEqual(dragInfo({ types: ["Files"], items: [] }), { files: true, count: 0, images: false }, "Safari: число неизвестно");
});

test("countLabel: «3 файла», «1 файл», «5 файлов», «2 фото», неизвестно — пусто", () => {
  assert.equal(countLabel({ count: 3 }), "3 файла");
  assert.equal(countLabel({ count: 1 }), "1 файл");
  assert.equal(countLabel({ count: 5 }), "5 файлов");
  assert.equal(countLabel({ count: 21 }), "21 файл");
  assert.equal(countLabel({ count: 2, images: true }), "2 фото");
  assert.equal(countLabel({ count: 0 }), "");
});

test("droppedEntries: папки отдельно от файлов; без items — dataTransfer.files", () => {
  const xl = file("июль.xlsx");
  const dt = {
    items: [
      { kind: "file", getAsFile: () => file("Выгрузки", ""), webkitGetAsEntry: () => ({ isDirectory: true, name: "Выгрузки" }) },
      { kind: "file", getAsFile: () => xl, webkitGetAsEntry: () => ({ isDirectory: false, name: "июль.xlsx" }) },
      { kind: "string", type: "text/plain" },
    ],
  };
  assert.deepEqual(droppedEntries(dt), { files: [xl], folders: ["Выгрузки"] });
  assert.deepEqual(droppedEntries({ files: [xl] }), { files: [xl], folders: [] });
  assert.equal(folderError("Выгрузки"), "Выгрузки: папки не прикрепляются — перетащите файлы из неё");
});

// Teleharness: тексты вставки/перетаскивания — из словарей en/ru (src/lib/i18n).
import { setLang, DICTIONARIES } from "../src/lib/i18n.js";

test("en: file names, drop counter and folder reason come from the English dictionary", () => {
  setLang("en");
  try {
    assert.equal(pastedFileName(file("image.png", "image/png"), D), "Screenshot 2026-11-19 21-30-12.png");
    assert.equal(pastedTextName(D), "Pasted text 2026-11-19 21-30-12.txt");
    assert.equal(countLabel({ count: 3 }), "3 files");
    assert.equal(countLabel({ count: 1 }), "1 file");
    assert.equal(countLabel({ count: 2, images: true }), "2 photos");
    assert.equal(folderError("Exports"), "Exports: folders can't be attached — drag the files inside it");
  } finally {
    setLang("ru");
  }
});

test("new paste/drop and agent-steps keys exist in both dictionaries", () => {
  for (const k of ["agent.showAllStepsN", "agent.stepsShown", "drop.title", "drop.hint", "drop.files", "drop.photos", "drop.blocked", "drop.blockedHint", "drop.folder", "drop.folderName", "paste.shotName", "paste.textName", "paste.fileName"]) {
    assert.ok(DICTIONARIES.en[k], `en: ${k}`);
    assert.ok(DICTIONARIES.ru[k], `ru: ${k}`);
  }
});
// BUG-269 п.2: длинное имя чипа сокращается посередине — видны начало, конец и расширение
import { chipName } from "../src/lib/paste-drop.js";
import { readFileSync as readCss } from "node:fs";
test("BUG-269 п.2: chipName — середина в «…», конец имени и расширение на месте; короткие — как есть", () => {
  assert.equal(chipName("Снимок 2026-11-19 21-30-12.png"), "Снимок…30-12.png", "время и расширение видны");
  assert.equal(chipName("июль.xlsx"), "июль.xlsx");
  assert.equal(chipName("a".repeat(16)), "a".repeat(16), "до 16 символов не трогаем");
  const long = chipName("очень-длинное-название-отчёта-за-квартал.pdf");
  assert.ok(long.length <= 16 && long.endsWith("ртал.pdf") && long.includes("…"), long);
  assert.equal(chipName(""), "");
});
test("BUG-269 п.2: чипы вложений — одна строка с прокруткой вбок (следующий чип выглядывает)", () => {
  const css = readCss(new URL("../src/components/chat.css", import.meta.url), "utf8");
  const rule = /\.composer-chips \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /flex-wrap:\s*nowrap/);
  assert.match(rule, /overflow-x:\s*auto/);
  assert.match(css, /\.composer-chips > \.attach \{\s*max-width: 212px;/, "чип в поле ввода — не шире 212 px: следующий выглядывает");
  assert.match(css, /\.composer-chips \.attach-thumb \{\s*width: 28px;/, "миниатюра в поле ввода 28 px — имя помещается");
});
