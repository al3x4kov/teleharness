// FEAT-01.88: файлы в чат вставкой из буфера и перетаскиванием (BRIEF-16,
// макет design/mockups-v2/paste-drop.html). Чистые функции без DOM-состояния:
// что делать со вставкой, как назвать безымянный снимок, что сказать в зоне
// перетаскивания, какие из брошенных элементов — папки.

import { t } from "./i18n.js";

export const LONG_TEXT_LIMIT = 5000; // владелец 2026-11-19 U002 п.2: длинный текст — файлом

const pad = (n) => String(n).padStart(2, "0");
// «2026-11-19 21-30-12» — локальное время, без двоеточий (имя файла на любой ОС)
export function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

const isImage = (f) => typeof f?.type === "string" && f.type.startsWith("image/");

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/tiff": "tiff", "image/heic": "heic", "image/svg+xml": "svg" };

// Имена, которые браузеры дают картинке из буфера: Chrome/Edge — «image.png»,
// Safari — «image.png»/«Image.jpeg», Firefox — «image.png», иногда пусто/«blob».
const GENERIC = /^(?:image|blob|clipboard|pasted[ _-]?image|untitled)?(?:\.[a-z0-9]{1,5})?$/i;
export const isGenericName = (name) => typeof name !== "string" || GENERIC.test(name.trim());

// Уникальное имя в пределах сообщения: «X.png», «X (2).png», …
export function uniqueName(name, taken) {
  const set = taken instanceof Set ? taken : new Set(taken ?? []);
  if (!set.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i += 1) {
    const n = `${base} (${i})${ext}`;
    if (!set.has(n)) return n;
  }
}

// Имя вставленного файла: безымянная картинка → «Снимок <время>.<расш>»,
// остальные сохраняют своё имя (уникализируется при совпадении).
export function pastedFileName(file, date = new Date(), taken = []) {
  const name = typeof file?.name === "string" ? file.name.trim() : "";
  if (isImage(file) && isGenericName(name)) {
    const fromName = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
    const ext = EXT[file.type] ?? (fromName && fromName !== "blob" ? fromName : "png");
    return uniqueName(`${t("paste.shotName", { stamp: stamp(date) })}.${ext}`, taken);
  }
  return uniqueName(name || t("paste.fileName", { stamp: stamp(date) }), taken);
}

export const pastedTextName = (date = new Date(), taken = []) => uniqueName(`${t("paste.textName", { stamp: stamp(date) })}.txt`, taken);

// Файлы буфера: clipboardData.files, иначе items kind=file (старый Safari).
function clipboardFiles(cd) {
  const out = [];
  const list = cd?.files;
  if (list && list.length > 0) {
    for (let i = 0; i < list.length; i += 1) if (list[i]) out.push(list[i]);
    return out;
  }
  const items = cd?.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it?.kind === "file") {
        const f = it.getAsFile?.();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

// Что делать со вставкой:
//  { kind: "files", files }  — прикрепить файлы (снимок, файлы из проводника);
//  { kind: "longText", text } — текст длиннее порога → файл .txt;
//  { kind: "default" }       — обычная вставка браузера (текст в поле).
// Текст рядом с одними картинками — это копирование из Word/Excel (картинка —
// рендер выделения): вставляем текст, как пользователь и ждёт.
export function pasteAction(cd, { longText = LONG_TEXT_LIMIT } = {}) {
  if (!cd) return { kind: "default" };
  const files = clipboardFiles(cd);
  let text = "";
  try {
    text = typeof cd.getData === "function" ? cd.getData("text/plain") || "" : "";
  } catch {
    text = "";
  }
  const hasText = text.trim().length > 0;
  if (files.length > 0 && (!hasText || files.some((f) => !isImage(f)))) return { kind: "files", files };
  if (hasText && text.length > longText) return { kind: "longText", text };
  return { kind: "default" };
}

// Перетаскивание: тащат ли файлы и сколько (во время dragover браузер даёт
// только kind/type элементов; Safari может не дать ничего — count 0).
export function dragInfo(dt) {
  const types = dt?.types ? Array.from(dt.types) : [];
  const files = types.includes("Files");
  let count = 0;
  let images = 0;
  const items = dt?.items;
  if (files && items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind !== "file") continue;
      count += 1;
      if (typeof items[i].type === "string" && items[i].type.startsWith("image/")) images += 1;
    }
  }
  return { files, count, images: count > 0 && images === count };
}

// Пилюля зоны: «3 файла», «2 фото»; число неизвестно — пусто (пилюли нет).
export function countLabel({ count = 0, images = false } = {}) {
  if (!(count > 0)) return "";
  return t(images ? "drop.photos" : "drop.files", { count });
}

// Брошенные элементы → файлы и имена папок. getAsFile/webkitGetAsEntry
// работают только синхронно внутри обработчика drop.
export function droppedEntries(dt) {
  const files = [];
  const folders = [];
  const items = dt?.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it?.kind !== "file") continue;
      let entry = null;
      try {
        entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null;
      } catch {
        entry = null;
      }
      const f = it.getAsFile?.() ?? null;
      if (entry?.isDirectory) folders.push(entry.name || f?.name || t("drop.folderName"));
      else if (f) files.push(f);
    }
    if (files.length > 0 || folders.length > 0) return { files, folders };
  }
  const list = dt?.files;
  if (list) for (let i = 0; i < list.length; i += 1) if (list[i]) files.push(list[i]);
  return { files, folders };
}

export const folderError = (name) => t("drop.folder", { name });

// BUG-269: имя в чипе — начало и конец с расширением, середина в «…»
// («Снимок 20…21-30-12.png»); полное имя — в title чипа.
export function chipName(name, max = 16) {
  const s = String(name ?? "");
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) * 0.55);
  return `${s.slice(0, max - 1 - tail)}…${s.slice(-tail)}`;
}
