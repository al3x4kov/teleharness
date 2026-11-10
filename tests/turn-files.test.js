// BUG-092 (BUG-05.18): lib/turn-files.js — files changed in the chat folder
// per turn window (cards for script-made files, both engines).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LIMITS, _clearCache, parseWindows, turnFiles } from "../lib/turn-files.js";

const T0 = Date.UTC(2026, 10, 3, 16, 34, 0);
let dir;
const put = (rel, atMs) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "x");
  utimesSync(p, new Date(atMs), new Date(atMs));
  return p;
};

beforeEach(() => {
  _clearCache();
  dir = mkdtempSync(path.join(tmpdir(), "zai-turnfiles-"));
});

test("parseWindows: пары start-end, мусор → null, лимит окон", () => {
  assert.deepEqual(parseWindows(`${T0}-${T0 + 1000},abc,${T0 + 5}-${T0}`), [[T0, T0 + 1000], null, null]);
  assert.deepEqual(parseWindows(""), [null]);
  const many = Array.from({ length: LIMITS.windows + 50 }, () => `${T0}-${T0}`).join(",");
  assert.equal(parseWindows(many).length, LIMITS.windows);
});

test("файлы, созданные скриптом в подпапке за время хода, попадают в этот ход (сценарий BUG-092)", () => {
  const names = ["random.md", "random.csv", "random.html", "random.docx", "random.png", "random.svg", "random.jpeg"];
  for (const [i, n] of names.entries()) put(path.join("random_files", n), T0 + 10_000 + i);
  put("old-notes.md", T0 - 3_600_000);
  const [files] = turnFiles(dir, [[T0, T0 + 32_000]]);
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), [...names].sort());
  assert.ok(files.every((f) => f.startsWith(path.join(dir, "random_files"))), "абсолютные пути внутри папки чата");
});

test("каждый файл — ровно в одном ходе; запас по краям не дублирует соседний ход", () => {
  put("a.txt", T0 + 500); // внутри хода 1
  put("b.txt", T0 + 61_000); // внутри хода 2 (и в запасе хода 1)
  put("c.txt", T0 + 30_003); // сразу после конца хода 1 — запас
  const [one, two] = turnFiles(dir, [[T0, T0 + 30_000], [T0 + 60_000, T0 + 90_000]]);
  assert.deepEqual(one.map((f) => path.basename(f)), ["a.txt", "c.txt"]);
  assert.deepEqual(two.map((f) => path.basename(f)), ["b.txt"]);
});

test("скрытое, служебное и временное не показывается", () => {
  const at = T0 + 1000;
  put(".zai-uploads/upload.pdf", at);
  put(".zai-tenants/alice/secret.md", at);
  put(".git/index", at);
  put("node_modules/x/index.js", at);
  put("AppData/Local/cache.bin", at);
  put("__pycache__/m.pyc", at);
  put("~$report.docx", at);
  put("work.tmp", at);
  put("desktop.ini", at);
  put("NTUSER.DAT", at);
  put("report.xlsx", at);
  const [files] = turnFiles(dir, [[T0, T0 + 5000]]);
  assert.deepEqual(files.map((f) => path.basename(f)), ["report.xlsx"]);
});

test("глубина и лимит списка ограничены; ссылки/junction не обходятся", () => {
  const at = T0 + 1000;
  put("1/2/3/4/shallow.md", at + 100); // глубина 4 — видно (BUG-181: при лимите поздние раньше)
  put("1/2/3/4/5/deep.md", at); // глубже лимита
  for (let i = 0; i < LIMITS.perWindow + 5; i += 1) put(`many/f${String(i).padStart(2, "0")}.txt`, at + i);
  const outside = mkdtempSync(path.join(tmpdir(), "zai-turnfiles-out-"));
  writeFileSync(path.join(outside, "leak.md"), "x");
  utimesSync(path.join(outside, "leak.md"), new Date(at), new Date(at));
  let linked = true;
  try {
    symlinkSync(outside, path.join(dir, "link"), "junction");
  } catch {
    linked = false;
  }
  const [files] = turnFiles(dir, [[T0, T0 + 5000]]);
  const names = files.map((f) => path.basename(f));
  assert.equal(files.length, LIMITS.perWindow);
  assert.ok(names.includes("shallow.md"), "глубина 4 видна");
  assert.ok(!names.includes("deep.md"), "глубже лимита — нет");
  if (linked) assert.ok(!names.includes("leak.md"), "junction наружу не обходится");
});

test("невалидное окно → пустой список; нет папки → пусто, без исключения", () => {
  put("a.txt", T0);
  assert.deepEqual(turnFiles(dir, [null]), [[]]);
  assert.deepEqual(turnFiles(path.join(dir, "nope"), [[T0, T0 + 1]]), [[]]);
});

test("BUG-181: 84 промежуточных файла за ход — итоговый .pptx (записан последним) в списке", () => {
  const at = T0 + 1000;
  put("read_pm.py", at);
  put("extract_pm.py", at + 1);
  for (let i = 0; i < 40; i += 1) put(`pm_imgs/s${String(i).padStart(2, "0")}.jpg`, at + 10 + i);
  for (let i = 0; i < 40; i += 1) put(`pm_preview/${String(i).padStart(2, "0")}.png`, at + 100 + i);
  put("build_pm.py", at + 200);
  put("preview_pm.py", at + 201);
  const deck = put("Педагогическая мастерская — новый дизайн.pptx", at + 300);
  const [files] = turnFiles(dir, [[T0, T0 + 5000]]);
  assert.ok(files.includes(deck), "итоговая презентация не отброшена лимитом");
  assert.ok(files.length <= LIMITS.perWindow);
});

test("BUG-181: при лимите приоритет — документы в корне, затем в подпапках, скрипты последними; внутри группы поздние", () => {
  const at = T0 + 1000;
  const scripts = Array.from({ length: LIMITS.perWindow }, (_, i) => put(`s${String(i).padStart(3, "0")}.py`, at + i));
  const deep = Array.from({ length: LIMITS.perWindow }, (_, i) => put(`work/p${String(i).padStart(3, "0")}.png`, at + 500 + i));
  const top = put("report.docx", at + 2);
  const [files] = turnFiles(dir, [[T0, T0 + 5000]]);
  assert.equal(files.length, LIMITS.perWindow);
  assert.ok(files.includes(top), "документ в корне");
  assert.ok(!files.some((f) => scripts.includes(f)), "скрипты вытеснены документами и медиа");
  assert.ok(files.includes(deep[deep.length - 1]), "из подпапки берутся поздние");
  // порядок ответа — по времени изменения
  const order = [...files].sort((a, b) => files.indexOf(a) - files.indexOf(b));
  assert.deepEqual(files, order);
});
