// FEAT-18.2: unit — shared/qr.js, the dependency-free QR generator (byte mode,
// level M, versions 1–10).
//
// Reference: matrices produced by the Python package `qrcode` 8.2
// (lincolnloop/python-qrcode), forced to byte mode, ERROR_CORRECT_M,
// border=0, version=None (fit), mask_pattern=0..7. For every text and EVERY
// mask the sha256 of the «#/.» rendering (rows joined by \n) is pinned below,
// plus one full matrix ("teleharness", mask 2) for readability. Reproduce:
//   q = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, mask_pattern=m, border=0)
//   q.add_data(QRData(text.encode("utf8"), mode=MODE_8BIT_BYTE)); q.make(fit=True)
// Mask selection itself (penalty N1–N4) is implementation-specific in detail,
// so the auto-picked mask is checked against our own penalty, and the result
// equals the reference for that mask.
// Run: node --test tests/qr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  QR_MAX_VERSION,
  alignmentPositions,
  byteCapacity,
  formatBits,
  penalty,
  qrEncode,
  qrSvgPath,
  versionBits,
} from "../shared/qr.js";

const render = (modules) => modules.map((r) => r.map((c) => (c ? "#" : ".")).join("")).join("\n");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const REF = [
  { text: "teleharness", version: 1, masks: ["ba41e120c0fbcc0cf4d8d2564e2398b43bc99a2c7053f29fedaa9d264553deb5", "3c7827a6eb66216b5c785c0b793dc581096301395e9281e76b26d37126e38092", "b4bd9ce226a90691b0eb7a7d02a2edf2061d44ca7bd69c5072c2295fe7ca41b4", "8ba191cfc11aa083fd96ee255ddd4cf37495c11b28443dd2b6a88bbc926c1136", "559b38bf956fb239e8ea3d70f2f2d6382c28b49a86c0bde0a96931f4dba89310", "e59f2d662d586535bcc5699daa98b2264ea2788d64d8dbeb31b034e8af8efab0", "2039c467d18675e2f1e60e9d1dd3c26a079d4e511d73101a9a3c96e8d4c28722", "b75aa22d0adfdefc317c08d67c2beee699968a050b34bd2cf2e198de7c5f4aa8"] },
  { text: "https://example.com/teleharness/", version: 3, masks: ["5b336c6ed14ec3db7225c127a7fe2cbaefd7faaa9e950dbb20361dc91e8b42b8", "1e459ee0fb021765583d633c7f194cfbd066077124e16e710f378d1ff3183579", "73dcc871e8a8315b402071c333be5ae0064af2d4ca5e8d81873984fe088d66bc", "68d301134cd75b9e618994a76127c7d7967115e74df095b81f1e3021bee67bae", "a3b4a0eade5e2c989956b67d465288741acfd713b1249919b8c0318a7b910ec7", "660ce17a430bd56422e5ec586d420ba55e83b20d44a6dcac9046b687a32b5895", "2864ce7c891ffe5b828a4ac3d2974e86d75f3e2bbecde9a122e66261441275a9", "d65973825ec692a37ae094e383a41222c91f400522e55cd3a18e1b569f3ebd9e"] },
  { text: "https://portal.example.test/teleharness/#/pair/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE", version: 6, masks: ["1e13683b595cb07ad608e3c918fe7ad7c9ee9f3eb1b77b7f3efc449edfa7b10a", "973c4c60eb8c5c2be182cc295a04b6c9c7e223991c786657c7bbccbf6b6349b5", "c6a6447007df515d32a821337e4d43e762580138302375726538ba6596bfb168", "e08f1106403180b91dba145a3c508ec1f7e9d0ad6b6d5e14ed409ce38fe39c1e", "08c8da1b0c92437c26e26c147a99082b1d33af36bf185152194a3a31792b7292", "a8649cc467cc6f5928bcc363af992fb7252d3c870931387b0d1a2581cd39ee06", "c54ec18cf9d907a7b39706dc43bf7bef29b53124607cbaa8b93f24e466c776af", "5531e914a8fba970cdd7d917051870f7975c209581da8b7c9e7b0584f4e43605"] },
  { text: "Привет, мир! Подключить телефон", version: 4, masks: ["6acc9becc21eb982b68ea82675b7b0eab46016f551eefb9b3ef0d9b5759526c8", "31ed0efa73d57d3f2185f71d366c6d8009a09dadcc370095439e99f288333cf8", "4855fb887a0be7ae82d69e4f3f325947dbd74cd6af8588a569d4bac644c09096", "619d02349e1f489bdf6dfda8a0138755088b8cd4c9c9cb204158c74edefcbd2e", "09e047bdc310665d7a47fc1c7e512d91af90061c119e3efda718d3112deee68a", "eee72c7fa58f816770f6199b36565b77788cdedd0b61ac1e0ab2f8593bfe52ac", "ee1e027d0e1d08fe4df4bd689309dbb231981ea32bc9b1e2dfa68501cf27f1a5", "d95d346a3660d4944055ebf1adfc7a0efac5161add552ae04f4f08183925d0b6"] },
  { text: "https://teleharness.example.org/some/deeper/path/teleharness/#/pair/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE?x=1&y=2&z=3&w=4", version: 8, masks: ["c85e9cb7d819244ba28ef92f41480ecf8c19f5465d652b7cbe283548df7c384f", "085645204dc80a8a126e8beaa91e04523b19acde83f65819605fb73470968555", "68d81b6bd01285b7f662927784fd8f922ed1244ec8abd4393f874a1493843d9a", "51156292fa44cbd2465383df75951a808143313ec86633c2054af8abc6e5dad4", "b0c0c8b689633dfb1d6af24cdf2723a8f87eb341e0bf70e4a1eaf5ed85de6649", "040eba660dbfc4dd5c41771a00ea3893ff49f1702d9c12f634a1d7e4808a12de", "fdfaa463a05cc693a15cc02726c4f485e1b6963c09fb4092b8a33f3e4c5fbba5", "ae16b8efd04fc0f1e9a9e2891fd198192b738d72810c40951acfe9b71a157799"] },
  { text: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE".repeat(4) + "AbCdEfGhIjKlMnOpQrStUvWxYz01234567", version: 10, masks: ["f42490b5763f21262ccd646838292670dddb55d6fa3639a9f372f1bdbd1e9302", "d7c2fb362a0b81f078a5503c420b6a4133aed19d0b1cf3258b472c0d05fbfc55", "aed00066aa2e9ac9cdfe0a20ed4beb6416d6342bf9230b69b7b25f0945a3803f", "460247313c2858b8ac9e720f37d1a72786e08ceaac1109fa2fda9c8655375ac0", "e0118334a07d761d90756295330ce9a745e6a541d9036b8254f03a684ac9d99e", "1f1037dfd8e5700eee81c9df6ba3dd621a8af2853f7ab1f169967696684b541f", "06f4c4d71c3647f9c25a63fa9df15116a1b10432258977526ea9c605da897779", "e0ef74eb632b737cfd36a7c19df845c8542269349499c3c87b8f109e136360fc"] },
];

// "teleharness", mask 2 — the full reference matrix.
const TELEHARNESS_MASK2 = [
  "#######....#..#######",
  "#.....#..#..#.#.....#",
  "#.###.#.##....#.###.#",
  "#.###.#.#..#..#.###.#",
  "#.###.#.##..#.#.###.#",
  "#.....#.#.##..#.....#",
  "#######.#.#.#.#######",
  "........#.#..........",
  "#.#####...##..#####..",
  "...###..#..########.#",
  ".#..####..#.#.#..###.",
  "#.#..#...#.###.####..",
  "#.....#.#.#.#.##...#.",
  "........##..##..##.##",
  "#######....#.#....##.",
  "#.....#.#.#..#...####",
  "#.###.#.#.##.###....#",
  "#.###.#.##..#..####..",
  "#.###.#.###.###..##..",
  "#.....#..#.#.#.#.##..",
  "#######.##..#####..#.",
].join("\n");

test("эталон: «teleharness», маска 2 — матрица совпадает модуль в модуль", () => {
  const q = qrEncode("teleharness", { mask: 2 });
  assert.equal(q.version, 1);
  assert.equal(q.size, 21);
  assert.equal(render(q.modules), TELEHARNESS_MASK2);
});

test("эталон: 6 строк (версии 1, 2, 4, 5, 7, 10; ASCII и UTF-8) × 8 масок совпадают с python-qrcode", () => {
  for (const r of REF) {
    for (let m = 0; m < 8; m++) {
      const q = qrEncode(r.text, { mask: m });
      assert.equal(q.version, r.version, `${r.text.slice(0, 24)}: version`);
      assert.equal(sha(render(q.modules)), r.masks[m], `${r.text.slice(0, 24)}: mask ${m}`);
    }
  }
});

test("автовыбор маски: минимальный штраф среди 8, матрица равна эталону этой маски", () => {
  for (const r of REF) {
    const q = qrEncode(r.text);
    const scores = Array.from({ length: 8 }, (_, m) => penalty(qrEncode(r.text, { mask: m }).modules));
    assert.equal(scores[q.mask], Math.min(...scores), `${r.text.slice(0, 24)}: picked mask has the lowest penalty`);
    assert.equal(sha(render(q.modules)), r.masks[q.mask]);
  }
});

test("структура по ISO/IEC 18004: finder-паттерны, timing, тёмный модуль, обе копии формата, информация о версии", () => {
  const q = qrEncode("https://teleharness.example.org/some/deeper/path/teleharness/#/pair/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE?x=1&y=2&z=3&w=4");
  const { size, modules: M, version, mask } = q;
  assert.equal(version, 8);
  const finder = ["#######", "#.....#", "#.###.#", "#.###.#", "#.###.#", "#.....#", "#######"];
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      const row = M[oy + y].slice(ox, ox + 7).map((c) => (c ? "#" : ".")).join("");
      assert.equal(row, finder[y], `finder at ${ox},${oy} row ${y}`);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(M[6][i], i % 2 === 0, `horizontal timing ${i}`);
    assert.equal(M[i][6], i % 2 === 0, `vertical timing ${i}`);
  }
  assert.equal(M[size - 8][8], true, "dark module");
  // format info: read both copies back (bit i as placed), compare with BCH
  const f = formatBits(mask);
  const read1 = [];
  for (let i = 0; i <= 5; i++) read1[i] = M[i][8];
  read1[6] = M[7][8];
  read1[7] = M[8][8];
  read1[8] = M[8][7];
  for (let i = 9; i < 15; i++) read1[i] = M[8][14 - i];
  const read2 = [];
  for (let i = 0; i < 8; i++) read2[i] = M[8][size - 1 - i];
  for (let i = 8; i < 15; i++) read2[i] = M[size - 15 + i][8];
  const asInt = (bits) => bits.reduce((acc, b, i) => acc | ((b ? 1 : 0) << i), 0);
  assert.equal(asInt(read1), f, "format copy 1");
  assert.equal(asInt(read2), f, "format copy 2");
  // version info (≥7): both 6×3 blocks
  const v = versionBits(8);
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    const want = ((v >>> i) & 1) === 1;
    assert.equal(M[b][a], want, `version block top-right ${i}`);
    assert.equal(M[a][b], want, `version block bottom-left ${i}`);
  }
});

test("BCH-коды формата и версии — значения из таблиц стандарта", () => {
  // Table C.1 (level M = 00): mask 0..7
  const M_FORMATS = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  for (let m = 0; m < 8; m++) assert.equal(formatBits(m), M_FORMATS[m], `format M/${m}`);
  // Table D.1: versions 7..10
  assert.deepEqual([7, 8, 9, 10].map(versionBits), [0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
});

test("ёмкость и выравнивание: таблицы уровня M версий 1–10", () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => byteCapacity(i + 1)), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(6), [6, 34]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(10), [6, 28, 50]);
  assert.equal(qrEncode("x".repeat(213)).version, 10);
  assert.throws(() => qrEncode("x".repeat(214)), RangeError);
  assert.equal(QR_MAX_VERSION, 10);
  assert.equal(qrEncode("x".repeat(14)).version, 1);
  assert.equal(qrEncode("x".repeat(15)).version, 2);
});

test("ссылка входа (≈100 байт) помещается; SVG-путь рисует все тёмные модули", () => {
  const url = "https://teleharness.example.org/teleharness/#/pair/" + "A".repeat(43);
  const q = qrEncode(url);
  assert.ok(q.version <= 6);
  const d = qrSvgPath(q.modules, 4);
  let area = 0;
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) area += Number(m[3]);
  const dark = q.modules.flat().filter(Boolean).length;
  assert.equal(area, dark);
  assert.match(d, /^M4 4h7v1h-7z/, "starts at the top-left finder, offset by the quiet zone");
});
