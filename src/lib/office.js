// Lightweight xlsx/docx/pptx preview (FEAT-05.10/FV-02, BUG-301) without
// heavy office libraries: all three OOXML formats are ZIP containers of XML.
// A minimal ZIP reader (central directory + DecompressionStream "deflate-raw",
// available in every evergreen browser and node >= 21) pulls the XML/media
// parts we need; tolerant scanners turn them into plain data. Nothing is
// executed — macros, embedded objects, active scripts, and formulas are
// ignored (only cached values and raster images are shown).
// Pure (no DOM): runs in the browser and under `node --test`.
import { lang, t as tr } from "./i18n.js";

const MAX_ENTRY_BYTES = 40 * 1024 * 1024; // zip-bomb guard per entry
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // cumulative budget across one document
const SHEET_ROW_CAP = 300;
const SHEET_COL_CAP = 40;
const SHEET_CAP = 12;
const DOCX_BLOCK_CAP = 3000;
const PPTX_SLIDE_CAP = 100;
const PPTX_IMG_MAX_BYTES = 2 * 1024 * 1024;
const PPTX_IMG_TOTAL_BYTES = 12 * 1024 * 1024;

export class OfficeError extends Error {}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Central directory -> Map<name, {method, offset, compSize, size}>.
export function readZipIndex(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i -= 1) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new OfficeError("not a zip");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new OfficeError("broken zip directory");
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > b.length) throw new OfficeError("broken zip directory");
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method, offset, compSize, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes, limit = MAX_ENTRY_BYTES) {
  if (typeof DecompressionStream !== "function") throw new OfficeError("no DecompressionStream");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {}
      throw new OfficeError("entry too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function readZipBytes(buf, index, name, budget = null, maxBytes = MAX_ENTRY_BYTES) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const e = index.get(name);
  if (!e) return null;
  const cap = Math.min(maxBytes, MAX_ENTRY_BYTES);
  if (e.size > cap) throw new OfficeError("entry too large");
  if (e.method === 0 && e.compSize !== e.size) throw new OfficeError("broken stored entry");
  const lh = e.offset;
  if (lh + 30 > b.length || u32(b, lh) !== 0x04034b50) throw new OfficeError("broken local header");
  const start = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28);
  if (start > b.length || start + e.compSize > b.length) throw new OfficeError("broken local header");
  const raw = b.subarray(start, start + e.compSize);
  const remaining = budget ? Math.max(0, budget.max - budget.used) : MAX_TOTAL_BYTES;
  const effCap = Math.min(cap, remaining);
  let data;
  if (e.method === 0) {
    if (raw.length > effCap) throw new OfficeError("entry too large");
    data = raw.slice();
  } else if (e.method === 8) {
    data = await inflateRaw(raw, effCap);
  } else {
    throw new OfficeError("unsupported compression");
  }
  if (budget) {
    budget.used += data.byteLength;
    if (budget.used > budget.max) throw new OfficeError("archive too large");
  }
  return data;
}

export async function readZipText(buf, index, name, budget = null) {
  const data = await readZipBytes(buf, index, name, budget);
  return data == null ? null : new TextDecoder().decode(data);
}

// ---- XML helpers ----------------------------------------------------------

const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function decodeXml(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};

// Text of every <t>...</t> (or <x:t>) inside a fragment, in order.
function tTexts(xml, tag = "t") {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  let s = "";
  for (const m of xml.matchAll(re)) s += decodeXml(m[1]);
  return s;
}

// "AB12" -> 27 (0-based column index).
export function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(String(ref ?? ""))?.[0]?.toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Resolve an OOXML relationship Target against a base folder (e.g. "xl/",
// "ppt/", "ppt/slides/"), normalizing "./" and "../" segments safely inside
// the ZIP root.
function resolveZipTarget(baseDir, target) {
  const raw = String(target ?? "").trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const combined = raw.startsWith("/") ? raw.slice(1) : `${baseDir.replace(/\/+$/, "")}/${raw}`;
  const parts = [];
  for (const seg of combined.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

const resolveTarget = (target) => resolveZipTarget("xl", target) ?? "";

function parseRelsMap(relsXml, baseDir) {
  const out = new Map();
  for (const m of String(relsXml ?? "").matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    const type = attr(m[0], "Type") ?? "";
    const mode = attr(m[0], "TargetMode") ?? "";
    if (!id || !target || /^external$/i.test(mode)) continue;
    const resolved = resolveZipTarget(baseDir, target);
    if (resolved) out.set(id, { target: resolved, type });
  }
  return out;
}

// ---- xlsx -----------------------------------------------------------------
// -> {sheets:[{name, rows:[[string]], truncatedRows, truncatedCols}]}

export async function parseXlsx(buf) {
  const budget = { used: 0, max: MAX_TOTAL_BYTES };
  const index = readZipIndex(buf);
  const wb = await readZipText(buf, index, "xl/workbook.xml", budget);
  if (wb == null) throw new OfficeError("no workbook");
  const relsXml = (await readZipText(buf, index, "xl/_rels/workbook.xml.rels", budget)) ?? "";
  const rels = new Map();
  for (const m of relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) {
      const resolved = resolveTarget(target);
      if (resolved) rels.set(id, resolved);
    }
  }
  const ssXml = (await readZipText(buf, index, "xl/sharedStrings.xml", budget)) ?? "";
  const shared = [];
  for (const m of ssXml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    // Phonetic runs (<rPh>) are reading aids, not cell text.
    shared.push(tTexts(m[1].replace(/<(?:\w+:)?rPh[\s\S]*?<\/(?:\w+:)?rPh>/g, "")));
  }
  const sheets = [];
  let n = 0;
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/g)) {
    if (sheets.length >= SHEET_CAP) break;
    n += 1;
    const name = attr(m[0], "name") ?? tr("office.sheet", { n });
    const rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    const state = attr(m[0], "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${n}.xml`;
    const xml = await readZipText(buf, index, path, budget);
    if (xml == null) continue;
    sheets.push({ name, ...parseSheetXml(xml, shared) });
  }
  return { sheets };
}

export function parseSheetXml(xml, shared = []) {
  const rows = [];
  let truncatedRows = false;
  let truncatedCols = false;
  let maxCol = 0;
  let rowBase = 0;
  let seenAnyRow = false;
  const data = /<(?:\w+:)?sheetData[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(xml)?.[1] ?? "";
  for (const rm of data.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rAttr = /\sr="(\d+)"/.exec(rm[1])?.[1];
    let absIdx = rAttr ? Number(rAttr) - 1 : rowBase + rows.length;
    if (!seenAnyRow) {
      seenAnyRow = true;
      // Sparse sheets that begin at row >= 301 (e.g. templates with large top offsets)
      // rebase from the first present row instead of returning empty.
      if (absIdx >= SHEET_ROW_CAP) rowBase = absIdx;
    }
    const rowIdx = absIdx - rowBase;
    if (rowIdx < 0) continue;
    if (rowIdx >= SHEET_ROW_CAP) {
      truncatedRows = true;
      break;
    }
    const cells = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = /\sr="([A-Z]+)\d*"/i.exec(cm[1])?.[1];
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      if (ci >= SHEET_COL_CAP) {
        truncatedCols = true;
        continue;
      }
      const t = /\st="([^"]*)"/.exec(cm[1])?.[1] ?? "n";
      const inner = cm[2] ?? "";
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let text = "";
      if (t === "s") text = shared[Number(v)] ?? "";
      else if (t === "inlineStr") text = tTexts(inner);
      else if (t === "b") text = v === "1" ? tr("office.true") : v === "0" ? tr("office.false") : "";
      else if (t === "e") text = decodeXml(v ?? "");
      else if (t === "n" && v != null && v !== "" && Number.isFinite(Number(v))) {
        // Float noise (0.30000000000000004) trimmed; ru decimal comma.
        text = String(Number(Number(v).toPrecision(12)));
        if (lang.value === "ru") text = text.replace(".", ",");
      } else text = decodeXml(v ?? "");
      cells[ci] = text;
      if (ci + 1 > maxCol) maxCol = ci + 1;
    }
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = cells;
  }
  // Dense rectangle, trailing empty rows dropped.
  const dense = rows.map((r) => Array.from({ length: maxCol }, (_, i) => r?.[i] ?? ""));
  while (dense.length > 0 && dense[dense.length - 1].every((c) => c === "")) dense.pop();
  return { rows: dense, truncatedRows, truncatedCols };
}

// ---- docx -----------------------------------------------------------------
// -> {blocks:[{type:"h", level, runs} | {type:"p", runs, list} | {type:"table", rows:[[string]]}], truncated}
// runs: [{text, bold, italic}]

// Matching close tag for a nestable element starting at `from`.
function matchClose(xml, from, name) {
  const open = new RegExp(`<${name}(?=[\\s>/])`, "g");
  const close = `</${name}>`;
  let depth = 0;
  let i = from;
  for (;;) {
    open.lastIndex = i;
    const o = open.exec(xml);
    const c = xml.indexOf(close, i);
    if (c < 0) return xml.length;
    if (o && o.index < c) {
      // Self-closing tag <name .../> does not increment depth.
      const gt = xml.indexOf(">", o.index);
      if (gt > o.index && xml[gt - 1] === "/") {
        i = gt + 1;
      } else {
        depth += 1;
        i = o.index + name.length + 1;
      }
    } else {
      depth -= 1;
      i = c + close.length;
      if (depth === 0) return i;
    }
  }
}

function parseRuns(pXml) {
  const runs = [];
  const re = /<w:r(?=[\s>])/g;
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(pXml);
    if (!m) break;
    const gt = pXml.indexOf(">", m.index);
    if (gt < 0) break;
    if (pXml[gt - 1] === "/") {
      i = gt + 1;
      continue;
    }
    const end = matchClose(pXml, m.index, "w:r");
    const r = pXml.slice(gt + 1, end - 6);
    i = end;
    const rPr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(r)?.[1] ?? "";
    const on = (tag) =>
      new RegExp(`<w:${tag}(?:\\s+w:val="(?:true|1|on)")?\\s*(?:/>|>\\s*</w:${tag}>)`).test(rPr);
    let text = "";
    for (const tm of r.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:cr\s*\/>/g)) {
      if (tm[1] != null) text += decodeXml(tm[1]);
      else if (tm[0].startsWith("<w:tab")) text += "\t";
      else text += "\n";
    }
    if (text) runs.push({ text, bold: on("b"), italic: on("i") });
  }
  return runs;
}

function paragraphBlock(pXml) {
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(pXml)?.[1] ?? "";
  const runs = parseRuns(pXml);
  const hm = /^(?:heading|заголовок)\s*(\d)$/i.exec(style.replace(/[_-]/g, " ").trim()) ?? /^Heading(\d)$/i.exec(style);
  if (/^title$/i.test(style)) return { type: "h", level: 1, runs };
  if (hm) return { type: "h", level: Math.min(6, Math.max(1, Number(hm[1]))), runs };
  return { type: "p", runs, list: /<w:numPr\b/.test(pXml) || /^list/i.test(style) };
}

function tableRows(tblXml) {
  const rows = [];
  const trRe = /<w:tr(?=[\s>])/g;
  let ti = 0;
  for (;;) {
    trRe.lastIndex = ti;
    const tr = trRe.exec(tblXml);
    if (!tr) break;
    const trEnd = matchClose(tblXml, tr.index, "w:tr");
    const trSlice = tblXml.slice(tr.index, trEnd);
    ti = trEnd;
    const cells = [];
    const tcRe = /<w:tc(?=[\s>])/g;
    let ci = 0;
    for (;;) {
      tcRe.lastIndex = ci;
      const tc = tcRe.exec(trSlice);
      if (!tc) break;
      const tcEnd = matchClose(trSlice, tc.index, "w:tc");
      const tcSlice = trSlice.slice(tc.index, tcEnd);
      ci = tcEnd;
      const paras = [];
      const pRe = /<w:p(?=[\s>/])/g;
      let pi = 0;
      for (;;) {
        pRe.lastIndex = pi;
        const pm = pRe.exec(tcSlice);
        if (!pm) break;
        const gt = tcSlice.indexOf(">", pm.index);
        if (gt > 0 && tcSlice[gt - 1] === "/") {
          pi = gt + 1;
          continue;
        }
        const pEnd = matchClose(tcSlice, pm.index, "w:p");
        paras.push(parseRuns(tcSlice.slice(pm.index, pEnd)).map((r) => r.text).join(""));
        pi = pEnd;
      }
      cells.push(paras.join("\n"));
    }
    rows.push(cells);
  }
  return rows;
}

export function parseDocxXml(xml) {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? "";
  const blocks = [];
  let truncated = false;
  const re = /<w:(tbl|p)(?=[\s>/])/g;
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(body);
    if (!m) break;
    if (blocks.length >= DOCX_BLOCK_CAP) {
      truncated = true;
      break;
    }
    if (m[1] === "tbl") {
      const end = matchClose(body, m.index, "w:tbl");
      blocks.push({ type: "table", rows: tableRows(body.slice(m.index, end)) });
      i = end;
      continue;
    }
    // <w:p/> self-closing = empty paragraph.
    const gt = body.indexOf(">", m.index);
    if (gt > 0 && body[gt - 1] === "/") {
      blocks.push({ type: "p", runs: [], list: false });
      i = gt + 1;
      continue;
    }
    const end = matchClose(body, m.index, "w:p");
    blocks.push(paragraphBlock(body.slice(m.index, end)));
    i = end;
  }
  // Collapse runs of empty paragraphs (Word spacing) to one.
  const out = [];
  for (const b of blocks) {
    const empty = b.type === "p" && b.runs.every((r) => !r.text.trim());
    if (empty && (out.length === 0 || out[out.length - 1].empty)) continue;
    out.push(empty ? { ...b, empty: true } : b);
  }
  return { blocks: out, truncated };
}

export async function parseDocx(buf) {
  const budget = { used: 0, max: MAX_TOTAL_BYTES };
  const index = readZipIndex(buf);
  const xml = await readZipText(buf, index, "word/document.xml", budget);
  if (xml == null) throw new OfficeError("no document");
  return parseDocxXml(xml);
}

// ---- pptx (BUG-301) -------------------------------------------------------
// -> {slides:[{index, title, blocks:[{type:"p", runs, list, level}|{type:"table", rows}], images:[{mime, bytes, name}], notes}], truncated}

const RASTER_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function parseDrawingRuns(pXml) {
  const runs = [];
  for (const m of pXml.matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>|<a:br\b[^>]*\/?>|<a:fld\b[^>]*>([\s\S]*?)<\/a:fld>/g)) {
    if (m[0].startsWith("<a:br")) {
      runs.push({ text: "\n", bold: false, italic: false });
      continue;
    }
    const inner = m[1] ?? m[2] ?? "";
    const rPr = /<a:rPr\b([^>]*?)(?:\/>|>[\s\S]*?<\/a:rPr>)/.exec(inner)?.[1] ?? "";
    const bold = /\sb="(?:1|true)"/i.test(rPr);
    const italic = /\si="(?:1|true)"/i.test(rPr);
    const text = tTexts(inner, "t");
    if (text) runs.push({ text, bold, italic });
  }
  return runs;
}

function parseDrawingParagraphs(xml) {
  const out = [];
  for (const pm of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const pXml = pm[1];
    const runs = parseDrawingRuns(pXml);
    const plain = runs.map((r) => r.text).join("").trim();
    if (!plain) continue;
    const pPrMatch = /<a:pPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:pPr>)/.exec(pXml);
    const pPrAttrs = pPrMatch?.[1] ?? "";
    const pPrBody = pPrMatch?.[2] ?? "";
    const lvlNum = Number(/\slvl="(\d+)"/.exec(pPrAttrs)?.[1] ?? 0);
    const hasBuNone = /<a:buNone\b/.test(pPrBody);
    const hasBullet = !hasBuNone && (/<a:(?:buChar|buAutoNum|buBlip)\b/.test(pPrBody) || lvlNum > 0);
    out.push({ type: "p", runs, list: hasBullet, level: Number.isFinite(lvlNum) ? lvlNum : 0 });
  }
  return out;
}

function parseDrawingTable(tblXml) {
  const rows = [];
  for (const tr of tblXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
    const cells = [];
    for (const tc of tr[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)) {
      const paras = parseDrawingParagraphs(tc[1]).map((p) => p.runs.map((r) => r.text).join(""));
      cells.push(paras.join("\n"));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseNotesText(notesXml) {
  if (!notesXml) return "";
  const parts = [];
  const spRe = /<p:sp(?=[\s>])/g;
  let i = 0;
  for (;;) {
    spRe.lastIndex = i;
    const m = spRe.exec(notesXml);
    if (!m) break;
    const end = matchClose(notesXml, m.index, "p:sp");
    const sp = notesXml.slice(m.index, end);
    i = end;
    const phType = /<p:ph\b[^>]*\btype="([^"]*)"/.exec(sp)?.[1] ?? "";
    if (phType && phType !== "body") continue; // skip slideNum / sldImg placeholders
    const text = parseDrawingParagraphs(sp)
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join("\n")
      .trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

export async function parsePptx(buf) {
  const budget = { used: 0, max: MAX_TOTAL_BYTES };
  const index = readZipIndex(buf);
  const presXml = await readZipText(buf, index, "ppt/presentation.xml", budget);
  if (presXml == null) throw new OfficeError("no presentation");

  const presRelsXml = (await readZipText(buf, index, "ppt/_rels/presentation.xml.rels", budget)) ?? "";
  const presRels = parseRelsMap(presRelsXml, "ppt");

  // Slide order strictly follows <p:sldIdLst> in ppt/presentation.xml.
  const slidePaths = [];
  for (const m of presXml.matchAll(/<(?:\w+:)?sldId\b[^>]*\/?>/g)) {
    const rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    const rel = rid && presRels.get(rid);
    if (rel?.target) slidePaths.push(rel.target);
  }
  // Fallback only if sldIdLst had no rels entries (unusual hand-built archives).
  if (slidePaths.length === 0) {
    const fallback = [...index.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0));
    slidePaths.push(...fallback);
  }

  const truncated = slidePaths.length > PPTX_SLIDE_CAP;
  const shownPaths = slidePaths.slice(0, PPTX_SLIDE_CAP);
  const slides = [];
  let imgTotalBytes = 0;

  for (let sIdx = 0; sIdx < shownPaths.length; sIdx += 1) {
    const slidePath = shownPaths[sIdx];
    const slideXml = await readZipText(buf, index, slidePath, budget);
    if (slideXml == null) continue;

    const dir = slidePath.includes("/") ? slidePath.slice(0, slidePath.lastIndexOf("/")) : "";
    const base = slidePath.includes("/") ? slidePath.slice(slidePath.lastIndexOf("/") + 1) : slidePath;
    const relsPath = dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
    const slideRelsXml = (await readZipText(buf, index, relsPath, budget)) ?? "";
    const slideRels = parseRelsMap(slideRelsXml, dir || "ppt/slides");

    let title = "";
    const blocks = [];
    const embedIds = [];

    // Walk top-level shapes (<p:sp>), graphicFrames (<p:graphicFrame> tables), and pictures (<p:pic>) in document order.
    const itemRe = /<p:(sp|graphicFrame|pic)(?=[\s>])/g;
    let cursor = 0;
    for (;;) {
      itemRe.lastIndex = cursor;
      const m = itemRe.exec(slideXml);
      if (!m) break;
      const tag = `p:${m[1]}`;
      const end = matchClose(slideXml, m.index, tag);
      const frag = slideXml.slice(m.index, end);
      cursor = end;

      if (m[1] === "sp") {
        const phType = /<p:ph\b[^>]*\btype="([^"]*)"/.exec(frag)?.[1] ?? "";
        // Skip slide numbers / footers / dates placeholders so slides stay clean
        if (phType === "sldNum" || phType === "ftr" || phType === "dt") continue;
        const paras = parseDrawingParagraphs(frag);
        if (paras.length === 0) continue;
        if (!title && (phType === "title" || phType === "ctrTitle")) {
          title = paras.map((p) => p.runs.map((r) => r.text).join("")).join(" ").trim();
        } else {
          blocks.push(...paras);
        }
      } else if (m[1] === "graphicFrame") {
        for (const tm of frag.matchAll(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g)) {
          const rows = parseDrawingTable(tm[0]);
          if (rows.length > 0) blocks.push({ type: "table", rows });
        }
      } else if (m[1] === "pic") {
        for (const bm of frag.matchAll(/<a:blip\b[^>]*>/g)) {
          const rid = attr(bm[0], "r:embed");
          if (rid) embedIds.push(rid);
        }
      }
    }

    // Embedded raster images (capped per image and total; never SVG/EMF/WMF).
    const images = [];
    const seenImg = new Set();
    for (const rid of embedIds) {
      const rel = slideRels.get(rid);
      if (!rel?.target || seenImg.has(rel.target)) continue;
      seenImg.add(rel.target);
      const ext = rel.target.split(".").pop()?.toLowerCase() ?? "";
      const mime = RASTER_MIME[ext];
      if (!mime) continue;
      const entry = index.get(rel.target);
      if (!entry || entry.size > PPTX_IMG_MAX_BYTES) continue;
      if (imgTotalBytes + entry.size > PPTX_IMG_TOTAL_BYTES) continue;
      try {
        const imgBytes = await readZipBytes(buf, index, rel.target, budget, PPTX_IMG_MAX_BYTES);
        if (!imgBytes || imgBytes.byteLength === 0) continue;
        if (imgTotalBytes + imgBytes.byteLength > PPTX_IMG_TOTAL_BYTES) continue;
        imgTotalBytes += imgBytes.byteLength;
        images.push({ mime, bytes: imgBytes, name: rel.target.split("/").pop() ?? "image" });
      } catch {
        // Skip broken individual image rather than failing the whole slide deck.
      }
    }

    // Speaker notes (optional).
    let notes = "";
    for (const rel of slideRels.values()) {
      if (/\/notesSlide$/i.test(rel.type) || /notesSlides\//i.test(rel.target)) {
        const notesXml = await readZipText(buf, index, rel.target, budget);
        notes = parseNotesText(notesXml);
        if (notes) break;
      }
    }

    slides.push({
      index: slides.length + 1,
      title,
      blocks,
      images,
      notes,
    });
  }

  return { slides, truncated };
}
