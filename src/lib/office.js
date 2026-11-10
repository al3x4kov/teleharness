// Lightweight xlsx/docx preview (FEAT-05.10/FV-02) without a spreadsheet or
// word library: both formats are ZIP containers of XML. A minimal ZIP reader
// (central directory + DecompressionStream "deflate-raw", available in every
// evergreen browser and node ≥ 21) pulls the few XML parts we need; tolerant
// regex scanners turn them into plain data. Nothing is executed — macros,
// embedded objects and formulas are ignored (only cached values are shown).
// Pure (no DOM): runs in the browser and under `node --test`.
import { lang, t as tr } from "./i18n.js";

const MAX_ENTRY_BYTES = 40 * 1024 * 1024; // zip-bomb guard per XML part
const SHEET_ROW_CAP = 300;
const SHEET_COL_CAP = 40;
const SHEET_CAP = 12;
const DOCX_BLOCK_CAP = 3000;

export class OfficeError extends Error {}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Central directory → Map<name, {method, offset, compSize, size}>.
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
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method, offset, compSize, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw new OfficeError("no DecompressionStream");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) {
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

export async function readZipText(buf, index, name) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const e = index.get(name);
  if (!e) return null;
  if (e.size > MAX_ENTRY_BYTES) throw new OfficeError("entry too large");
  const lh = e.offset;
  if (u32(b, lh) !== 0x04034b50) throw new OfficeError("broken local header");
  const start = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28);
  const raw = b.subarray(start, start + e.compSize);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = await inflateRaw(raw);
  else throw new OfficeError("unsupported compression");
  return new TextDecoder().decode(data);
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

// Text of every <t>…</t> (or <x:t>) inside a fragment, in order.
function tTexts(xml, tag = "t") {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  let s = "";
  for (const m of xml.matchAll(re)) s += decodeXml(m[1]);
  return s;
}

// "AB12" → 27 (0-based column index).
export function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(String(ref ?? ""))?.[0]?.toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const resolveTarget = (target) => {
  const t = String(target ?? "").replace(/^\/+/, "");
  return t.startsWith("xl/") ? t : "xl/" + t.replace(/^\.\//, "");
};

// ---- xlsx -----------------------------------------------------------------
// → {sheets:[{name, rows:[[string]], truncatedRows, truncatedCols}]}

export async function parseXlsx(buf) {
  const index = readZipIndex(buf);
  const wb = await readZipText(buf, index, "xl/workbook.xml");
  if (wb == null) throw new OfficeError("no workbook");
  const relsXml = (await readZipText(buf, index, "xl/_rels/workbook.xml.rels")) ?? "";
  const rels = new Map();
  for (const m of relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, resolveTarget(target));
  }
  const ssXml = (await readZipText(buf, index, "xl/sharedStrings.xml")) ?? "";
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
    const xml = await readZipText(buf, index, path);
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
  const data = /<(?:\w+:)?sheetData[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(xml)?.[1] ?? "";
  for (const rm of data.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rAttr = /\sr="(\d+)"/.exec(rm[1])?.[1];
    const rowIdx = rAttr ? Number(rAttr) - 1 : rows.length;
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
// → {blocks:[{type:"h", level, runs} | {type:"p", runs, list} | {type:"table", rows:[[string]]}], truncated}
// runs: [{text, bold, italic}]

function parseRuns(pXml) {
  const runs = [];
  for (const rm of pXml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
    const r = rm[1];
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r)?.[1] ?? "";
    const on = (tag) => new RegExp(`<w:${tag}(?:\\s+w:val="(?:true|1|on)")?\\s*/>`).test(rPr);
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
      depth += 1;
      i = o.index + name.length + 1;
    } else {
      depth -= 1;
      i = c + close.length;
      if (depth === 0) return i;
    }
  }
}

function tableRows(tblXml) {
  const rows = [];
  for (const tr of tblXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
    const cells = [];
    for (const tc of tr[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
      const paras = [...tc[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((p) => parseRuns(p[1]).map((r) => r.text).join(""));
      cells.push(paras.join("\n"));
    }
    rows.push(cells);
  }
  return rows;
}

export function parseDocxXml(xml) {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? "";
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
    const end = body.indexOf("</w:p>", m.index);
    const stop = end < 0 ? body.length : end + 6;
    blocks.push(paragraphBlock(body.slice(m.index, stop)));
    i = stop;
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
  const index = readZipIndex(buf);
  const xml = await readZipText(buf, index, "word/document.xml");
  if (xml == null) throw new OfficeError("no document");
  return parseDocxXml(xml);
}
