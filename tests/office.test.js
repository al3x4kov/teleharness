// xlsx/docx preview parser (src/lib/office.js, FEAT-05.10/FV-02). Fixtures
// are built in-memory: a minimal ZIP writer (deflate via node:zlib + stored)
// wraps hand-written OOXML parts, so the test needs no binary files.
// Run: node --test tests/office.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import {
  colIndex,
  decodeXml,
  OfficeError,
  parseDocx,
  parseDocxXml,
  parsePptx,
  parseSheetXml,
  parseXlsx,
  readZipIndex,
} from "../src/lib/office.js";

function zip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(String(content), "utf8");
    const data = store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const b = Buffer.concat([...locals, cd, eocd]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function colLetters(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const XLSX = {
  "[Content_Types].xml": "<Types/>",
  "xl/workbook.xml":
    '<workbook xmlns:r="r"><sheets><sheet name="Трафик" sheetId="1" r:id="rId1"/><sheet name="Скрытый" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Итог &amp; выводы" sheetId="3" r:id="rId3"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="/xl/worksheets/sheet3.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><t>Час</t></si><si><r><t>Вход, </t></r><r><t>Мбит/с</t></r></si><si><t xml:space="preserve">a &lt; b</t></si></sst>',
  "xl/worksheets/sheet1.xml":
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>09:00</t></is></c><c r="B2"><v>12.5</v></c><c r="D2" t="b"><v>1</v></c></row>' +
    '<row r="4"><c r="A4" t="s"><v>2</v></c><c r="B4"><v>0.30000000000000004</v></c></row><row r="5"/></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
  "xl/worksheets/sheet3.xml": '<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(1,2)</f><v>3</v></c></row></sheetData></worksheet>',
};

test("parseXlsx: sheets, shared/inline strings, sparse cells, hidden sheets skipped", async () => {
  const { sheets } = await parseXlsx(zip(XLSX));
  assert.deepEqual(sheets.map((s) => s.name), ["Трафик", "Итог & выводы"]);
  assert.deepEqual(sheets[0].rows, [
    ["Час", "Вход, Мбит/с", "", ""],
    ["09:00", "12,5", "", "ИСТИНА"],
    ["", "", "", ""],
    ["a < b", "0,3", "", ""],
  ]);
  assert.deepEqual(sheets[1].rows, [["3"]], "formula: cached value only, never evaluated");
});

test("parseXlsx: stored (uncompressed) entries work too", async () => {
  const { sheets } = await parseXlsx(zip(XLSX, { store: true }));
  assert.equal(sheets[0].rows[0][0], "Час");
});

test("parseSheetXml: row/column caps flag truncation and cap output to 40 cols × 300 rows", () => {
  const cells = Array.from({ length: 50 }, (_, i) => `<c r="${colLetters(i)}1"><v>${i}</v></c>`).join("");
  const wide = parseSheetXml(`<sheetData><row r="1">${cells}</row></sheetData>`);
  assert.equal(wide.truncatedCols, true);
  assert.equal(wide.rows[0].length, 40, "capped at 40 columns");
  assert.equal(wide.rows[0][39], "39");

  const rows = Array.from({ length: 400 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
  const tall = parseSheetXml(`<sheetData>${rows}</sheetData>`);
  assert.equal(tall.truncatedRows, true);
  assert.equal(tall.rows.length, 300);
});

test("BUG-301: parseSheetXml handles sparse sheets starting at row >= 301 without returning empty", () => {
  const xml = '<sheetData><row r="305"><c r="A305"><v>42</v></c></row><row r="306"><c r="A306"><v>99</v></c></row></sheetData>';
  const out = parseSheetXml(xml);
  assert.deepEqual(out.rows, [["42"], ["99"]]);
  assert.equal(out.truncatedRows, false);
});

test("colIndex / decodeXml", () => {
  assert.equal(colIndex("A1"), 0);
  assert.equal(colIndex("Z9"), 25);
  assert.equal(colIndex("AB12"), 27);
  assert.equal(decodeXml("&lt;b&gt; &amp; &#1046; &#x416;"), "<b> & Ж Ж");
});

const DOC =
  '<w:document xmlns:w="w"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Отчёт по трафику</w:t></w:r></w:p>' +
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Итог:</w:t></w:r><w:r><w:t xml:space="preserve"> пик в 13:40</w:t></w:r><w:r><w:rPr><w:i/><w:bCs/></w:rPr><w:t>, вход</w:t></w:r></w:p>' +
  "<w:p/><w:p/><w:p/>" +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>пункт один</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>Час</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Мбит/с</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>09:00</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12,5</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
  '<w:p><w:r><w:t>после</w:t></w:r><w:r><w:tab/><w:t>таба</w:t><w:br/><w:t>строка</w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>!</w:t></w:r></w:p>' +
  "<w:sectPr/></w:body></w:document>";

test("parseDocx: headings, bold/italic runs, lists, tables, empty-paragraph collapse", async () => {
  const { blocks, truncated } = await parseDocx(zip({ "word/document.xml": DOC }));
  assert.equal(truncated, false);
  assert.deepEqual(blocks[0], { type: "h", level: 1, runs: [{ text: "Отчёт по трафику", bold: false, italic: false }] });
  assert.deepEqual(blocks[1].runs, [
    { text: "Итог:", bold: true, italic: false },
    { text: " пик в 13:40", bold: false, italic: false },
    { text: ", вход", bold: false, italic: true },
  ]);
  assert.equal(blocks[2].empty, true, "three empty paragraphs collapse to one");
  assert.equal(blocks[3].list, true);
  assert.deepEqual(blocks[4], { type: "table", rows: [["Час", "Мбит/с"], ["09:00", "12,5"]] });
  assert.equal(blocks[5].runs.map((r) => r.text).join(""), "после\tтаба\nстрока!");
  assert.equal(blocks[5].runs[2].bold, false, "w:val=0 is not bold");
  assert.equal(blocks.length, 6);
});

test("parseDocxXml: self-closing <w:numPr/> and List* styles are list items", () => {
  const xml = '<w:body><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>a</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t>b</w:t></w:r></w:p></w:body>';
  assert.deepEqual(parseDocxXml(xml).blocks.map((b) => b.list), [true, true]);
});

test("BUG-301: parseDocxXml handles <w:body> with attributes, paired <w:b></w:b>, and nested <w:p> inside textbox", () => {
  const xml =
    '<w:document><w:body w:attr="1">' +
    '<w:p><w:r><w:rPr><w:b></w:b><w:i></w:i></w:rPr><w:t>ЖирныйКурсив</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>До </w:t></w:r><w:r><mc:AlternateContent><w:txbxContent><w:p><w:r><w:t>Внутри</w:t></w:r></w:p></w:txbxContent></mc:AlternateContent></w:r><w:r><w:t> После</w:t></w:r></w:p>' +
    "</w:body></w:document>";
  const { blocks } = parseDocxXml(xml);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].runs[0], { text: "ЖирныйКурсив", bold: true, italic: true });
  assert.equal(blocks[1].runs.map((r) => r.text).join(""), "До Внутри После");
});

test("parseDocxXml: no body → no blocks; broken zip → OfficeError", async () => {
  assert.deepEqual(parseDocxXml("<x/>").blocks, []);
  assert.throws(() => readZipIndex(new Uint8Array(40)), OfficeError);
  await assert.rejects(parseDocx(zip({ "other.xml": "<a/>" })), OfficeError);
});

test("BUG-301: ZIP reader rejects tampered STORED size mismatch and out-of-bounds offsets", async () => {
  const raw = new Uint8Array(zip({ "word/document.xml": "<w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body>" }, { store: true }));
  // Corrupt central directory compSize != uncompSize on a STORED entry
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let cd = -1;
  for (let i = 0; i < raw.length - 4; i += 1) {
    if (dv.getUint32(i, true) === 0x02014b50) { cd = i; break; }
  }
  assert.ok(cd >= 0);
  const badStored = new Uint8Array(raw);
  new DataView(badStored.buffer).setUint32(cd + 24, 999999, true); // size != compSize
  await assert.rejects(parseDocx(badStored), OfficeError);

  const badOffset = new Uint8Array(raw);
  new DataView(badOffset.buffer).setUint32(cd + 42, raw.length + 50, true); // local header out of bounds
  await assert.rejects(parseDocx(badOffset), OfficeError);
});

// ---- pptx (BUG-301) -------------------------------------------------------

const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const PPTX = {
  "[Content_Types].xml": "<Types/>",
  // Slide order in presentation.xml puts rId2 (slide2.xml) FIRST, then rId1 (slide1.xml)
  "ppt/presentation.xml":
    '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>' +
    '<p:sldId id="257" r:id="rId2"/>' +
    '<p:sldId id="256" r:id="rId1"/>' +
    "</p:sldIdLst></p:presentation>",
  "ppt/_rels/presentation.xml.rels":
    '<Relationships>' +
    '<Relationship Id="rId1" Target="slides/slide1.xml"/>' +
    '<Relationship Id="rId2" Target="/ppt/slides/slide2.xml"/>' +
    "</Relationships>",
  "ppt/slides/slide2.xml":
    '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Титульный слайд</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody>' +
    '<a:p><a:r><a:rPr b="1"/><a:t>Ключевой </a:t></a:r><a:r><a:rPr i="1"/><a:t>тезис</a:t></a:r></a:p>' +
    '<a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>Подпункт</a:t></a:r></a:p>' +
    "</p:txBody></p:sp>" +
    '<p:pic><p:blipFill><a:blip r:embed="rImg1"/></p:blipFill></p:pic>' +
    "</p:spTree></p:cSld></p:sld>",
  "ppt/slides/_rels/slide2.xml.rels":
    '<Relationships>' +
    '<Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart.png"/>' +
    '<Relationship Id="rNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>' +
    "</Relationships>",
  "ppt/media/chart.png": TINY_PNG,
  "ppt/notesSlides/notesSlide1.xml":
    '<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Сказать про Q4</a:t></a:r></a:p></p:txBody></p:sp>' +
    "</p:spTree></p:cSld></p:notes>",
  "ppt/slides/slide1.xml":
    '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Таблица &amp; итоги</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>' +
    '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Показатель</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Значение</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
    '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Выручка</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>120</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
    "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>" +
    "</p:spTree></p:cSld></p:sld>",
};

test("BUG-301: parsePptx extracts slides in presentation.xml order with titles, formatted text, bullets, tables, raster images, and speaker notes", async () => {
  const out = await parsePptx(zip(PPTX));
  assert.equal(out.truncated, false);
  assert.equal(out.slides.length, 2);

  // Slide 1 is slide2.xml because presentation.xml lists rId2 before rId1
  const s1 = out.slides[0];
  assert.equal(s1.index, 1);
  assert.equal(s1.title, "Титульный слайд");
  assert.equal(s1.blocks.length, 2);
  assert.deepEqual(s1.blocks[0].runs, [
    { text: "Ключевой ", bold: true, italic: false },
    { text: "тезис", bold: false, italic: true },
  ]);
  assert.equal(s1.blocks[1].list, true);
  assert.equal(s1.blocks[1].level, 1);
  assert.equal(s1.blocks[1].runs[0].text, "Подпункт");
  assert.equal(s1.images.length, 1);
  assert.equal(s1.images[0].mime, "image/png");
  assert.deepEqual(s1.images[0].bytes, TINY_PNG);
  assert.equal(s1.notes, "Сказать про Q4");

  // Slide 2 is slide1.xml with title + table
  const s2 = out.slides[1];
  assert.equal(s2.index, 2);
  assert.equal(s2.title, "Таблица & итоги");
  const tbl = s2.blocks.find((b) => b.type === "table");
  assert.deepEqual(tbl, {
    type: "table",
    rows: [
      ["Показатель", "Значение"],
      ["Выручка", "120"],
    ],
  });
});

test("BUG-301: parsePptx rejects non-zip and zip without ppt/presentation.xml with OfficeError", async () => {
  await assert.rejects(parsePptx(new Uint8Array([1, 2, 3, 4])), OfficeError);
  await assert.rejects(parsePptx(zip({ "other.xml": "<x/>" })), OfficeError);
});

