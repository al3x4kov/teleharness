// Clipboard paste and drag-and-drop file helpers: pure functions without DOM
// state (plus lightweight DOM predicates for overlays and editable inputs).

import { t } from "./i18n.js";

export const LONG_TEXT_LIMIT = 5000;

const EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const isImage = (f) => typeof f?.type === "string" && f.type.startsWith("image/");
const GENERIC = /^(?:image|blob|clipboard|pasted[ _-]?image|untitled)?(?:\.[a-z0-9]{1,5})?$/i;
export const isGenericName = (name) => typeof name !== "string" || GENERIC.test(name.trim());

// Blocking overlays above the chat (modals, sheets, FileViewer, VoiceMode,
// SkillModal, review scrim). While any is open, DropZone stays hidden and the
// global composer paste listener does not intercept paste.
export const BLOCKING_OVERLAY_SELECTOR =
  ".modal-backdrop, .sheet-backdrop, .file-backdrop, .vm-backdrop, .rp-modal-backdrop, .rv-scrim";

export function hasBlockingOverlay(doc = globalThis.document) {
  try {
    return Boolean(doc?.querySelector?.(BLOCKING_OVERLAY_SELECTOR));
  } catch {
    return false;
  }
}

export function isEditableTarget(el) {
  if (!el || typeof el !== "object") return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const ce = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null;
  if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  if (typeof el.closest === "function" && el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) {
    return true;
  }
  return false;
}

const p2 = (n) => String(n).padStart(2, "0");
export const stamp = (d) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;

export function uniqueName(name, taken = []) {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i += 1) {
    const n = `${base} (${i})${ext}`;
    if (!set.has(n)) return n;
  }
}

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

// Unified extractor for clipboardData and dataTransfer: detects directories
// via webkitGetAsEntry() and falls back to dt.files if items returned partial
// nulls or was empty.
function extractEntries(dt) {
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
  }
  const list = dt?.files;
  if (list && list.length > 0 && ((files.length === 0 && folders.length === 0) || (folders.length === 0 && list.length > files.length))) {
    const fromList = [];
    for (let i = 0; i < list.length; i += 1) if (list[i]) fromList.push(list[i]);
    if (fromList.length > files.length) return { files: fromList, folders };
  }
  return { files, folders };
}

function readData(cd, type) {
  try {
    return typeof cd?.getData === "function" ? cd.getData(type) || "" : "";
  } catch {
    return "";
  }
}

// Companion text/plain placed by file managers: filename (Finder), local path
// (/home/..., C:\..., \\server\...) or file:// URI.
function isFileRefText(text, files) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (lines.length === 0) return false;
  const names = new Set(files.map((f) => String(f?.name ?? "").trim().toLowerCase()).filter(Boolean));
  return lines.every((line) => {
    const low = line.toLowerCase();
    if (names.has(low)) return true;
    if (/^file:\/\//i.test(line)) return true;
    if (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(line)) return true;
    return false;
  });
}

// Browser "Copy image" puts a single <img> in text/html (possibly wrapped in
// <a>/<html>/<body>/<!--StartFragment-->) and the image URL in text/plain.
function isSingleImageHtml(html) {
  if (typeof html !== "string" || !html.trim()) return false;
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<\/?(?:html|body|meta|style|title|a|span|div|p|figure)\b[^>]*>/gi, "")
    .trim();
  return /^<img\b[^>]*\/?>$/i.test(cleaned);
}

// Decide paste behavior:
//  { kind: "files", files, folders? } — attach files (screenshots, Finder/Explorer,
//     browser "Copy image", folders -> error);
//  { kind: "longText", text }         — long text above threshold -> .txt file;
//  { kind: "default" }                — native browser paste into textarea.
// Narrow Word/Excel exception: a single generic-named image render paired with
// normal text (not a filename/path/URI and not a single <img> HTML fragment).
export function pasteAction(cd, { longText = LONG_TEXT_LIMIT } = {}) {
  if (!cd) return { kind: "default" };
  const { files, folders } = extractEntries(cd);
  const text = readData(cd, "text/plain");
  const html = readData(cd, "text/html");
  const hasText = text.trim().length > 0;
  if (folders.length > 0) return { kind: "files", files, folders };
  if (files.length > 0) {
    const officeRender =
      files.length === 1 &&
      isImage(files[0]) &&
      isGenericName(files[0].name) &&
      hasText &&
      !isFileRefText(text, files) &&
      !isSingleImageHtml(html);
    if (!officeRender) return { kind: "files", files };
  }
  if (hasText && text.length > longText) return { kind: "longText", text };
  return { kind: "default" };
}

// Drag-over probe: supports standard "Files", Firefox "application/x-moz-file",
// items with kind === "file", and dt.files fallback.
export function dragInfo(dt) {
  const types = dt?.types ? Array.from(dt.types) : [];
  const hasType = types.includes("Files") || types.includes("application/x-moz-file");
  let itemCount = 0;
  let itemImages = 0;
  const items = dt?.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind !== "file") continue;
      itemCount += 1;
      if (typeof items[i].type === "string" && items[i].type.startsWith("image/")) itemImages += 1;
    }
  }
  let fileCount = 0;
  let fileImages = 0;
  const list = dt?.files;
  if (list && list.length > 0) {
    for (let i = 0; i < list.length; i += 1) {
      if (!list[i]) continue;
      fileCount += 1;
      if (isImage(list[i])) fileImages += 1;
    }
  }
  const files = hasType || itemCount > 0 || fileCount > 0;
  if (!files) return { files: false, count: 0, images: false };
  const count = itemCount > 0 ? itemCount : fileCount;
  const images = count > 0 && (itemCount > 0 ? itemImages === itemCount : fileImages === fileCount);
  return { files: true, count, images };
}

export function countLabel({ count = 0, images = false } = {}) {
  if (!(count > 0)) return "";
  return t(images ? "drop.photos" : "drop.files", { count });
}

export function droppedEntries(dt) {
  return extractEntries(dt);
}

export const folderError = (name) => t("drop.folder", { name });

export function chipName(name, max = 16) {
  const s = String(name ?? "");
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) * 0.55);
  return `${s.slice(0, max - 1 - tail)}…${s.slice(-tail)}`;
}
