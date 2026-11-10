// xlsx/docx preview parser (src/lib/office.js, FEAT-05.10/FV-02). Fixtures
// are built in-memory: a minimal ZIP writer (deflate via node:zlib + stored)
// wraps hand-written OOXML parts, so the test needs no binary files.
// Run: node --test tests/office.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { colIndex, decodeXml, OfficeError, parseDocx, parseDocxXml, parseSheetXml, parseXlsx, readZipIndex } from "../src/lib/office.js";

function zip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, "utf8");
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

test("parseSheetXml: row/column caps flag truncation", () => {
  const cells = Array.from({ length: 50 }, (_, i) => `<c r="${String.fromCharCode(65 + (i % 26))}${i >= 26 ? "" : ""}1"><v>${i}</v></c>`).join("");
  const wide = parseSheetXml(`<sheetData><row r="1"><c r="AZ1"><v>1</v></c><c r="A1"><v>2</v></c></row></sheetData>`);
  assert.equal(wide.truncatedCols, true);
  const rows = Array.from({ length: 400 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
  const tall = parseSheetXml(`<sheetData>${rows}</sheetData>`);
  assert.equal(tall.truncatedRows, true);
  assert.equal(tall.rows.length, 300);
  assert.ok(cells.length > 0);
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

test("parseDocxXml: no body → no blocks; broken zip → OfficeError", async () => {
  assert.deepEqual(parseDocxXml("<x/>").blocks, []);
  assert.throws(() => readZipIndex(new Uint8Array(40)), OfficeError);
  await assert.rejects(parseDocx(zip({ "other.xml": "<a/>" })), OfficeError);
});
