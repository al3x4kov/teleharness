// Живой тест рецептов скиллов teleharness-* (FEAT-04.10, критерий 3). Только Windows; нужен
// собранный teleharness-jail.exe (ops/sandbox/build.ps1) и окружение D:\teleharness-sandbox\python
// (ops/sandbox/setup-python.ps1).
//   node --test ops/sandbox/tests/skills-live.test.mjs
// Из каждого ops/opencode/skills/teleharness-*/SKILL.md берутся блоки ```python, которые
// начинаются строкой «# Рецепт: <id>» или «# Проверка: <id>». Блоки одного скилла
// выполняются по порядку внутри teleharness-jail в одной временной папке тенанта — так же,
// как их запустит агент (`python файл.py` в cmd.exe контейнера). Рецепт должен
// завершиться с кодом 0, его проверка — напечатать «ПРОВЕРКА OK». Затем тест сам
// перечитывает результаты (число слайдов, кириллица в PDF и т. д.).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HERE = import.meta.dirname
const SKILLS = path.resolve(HERE, "..", "..", "opencode", "skills")
const EXE = process.env.TELEHARNESS_JAIL_EXE || path.resolve(HERE, "..", "teleharness-jail.exe")
const PY = (process.env.TELEHARNESS_SANDBOX_PY || "D:/teleharness-sandbox/python").replace(/\\/g, "/")
const CAFILE = `${PY}/Lib/site-packages/certifi/cacert.pem`
const NAMES = ["teleharness-xlsx", "teleharness-docx", "teleharness-pptx", "teleharness-pdf", "teleharness-images", "teleharness-html"]
const skip =
  process.platform !== "win32" ? "не Windows" :
  !fs.existsSync(EXE) ? `нет ${EXE} (ops/sandbox/build.ps1)` :
  !fs.existsSync(`${PY}/Scripts/python.exe`) ? `нет ${PY} (ops/sandbox/setup-python.ps1)` : false

let ROOT
before(() => { if (!skip) ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "teleharness-skills-live-")) })
after(() => { if (ROOT && !process.env.TELEHARNESS_SKILLS_KEEP) fs.rmSync(ROOT, { recursive: true, force: true }) })

function jail(dir, command) {
  const b64 = Buffer.from(`cmd.exe /d /s /c "${command}"`, "utf8").toString("base64url")
  const r = spawnSync(EXE, ["--name", "teleharness-t-skillslive", "--dir", dir, "--net", "--cafile", CAFILE, "--path-prepend", `${PY}/Scripts`, "--b64", b64], { encoding: "utf8", timeout: 300000 })
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }
}
function py(dir, file, code) {
  fs.writeFileSync(path.join(dir, file), code)
  return jail(dir, `python ${file}`)
}

/** Runnable blocks of a SKILL.md: [{ kind: "Рецепт"|"Проверка", id, code }] in document order. */
export function blocks(md) {
  const out = []
  for (const m of md.matchAll(/```python\r?\n([\s\S]*?)```/g)) {
    const h = m[1].match(/^# (Рецепт|Проверка): ([a-z0-9-]+)/)
    if (h) out.push({ kind: h[1], id: h[2], code: m[1] })
  }
  return out
}

// Входные файлы, которые пользователь обычно прикладывает сам.
const SEED = {
  "teleharness-images": `
from PIL import Image, ImageDraw
for i, (name, color) in enumerate([("фото.jpg", (70, 130, 180)), ("фото2.jpg", (200, 120, 60)), ("фото3.png", (90, 160, 90))]):
    im = Image.new("RGB", (1600 - i * 200, 1200), color)
    d = ImageDraw.Draw(im)
    d.ellipse((300, 200, 900, 800), fill=(240, 240, 240))
    im.save(name)
print("seed ok")
`,
}

// Что тест проверяет сам после рецептов скилла (печатает RESULT ...).
const VERIFY = {
  "teleharness-xlsx": `
import openpyxl, pandas as pd
wb = openpyxl.load_workbook("отчёт_продажи.xlsx"); ws = wb["Продажи"]
print("RESULT charts", len(ws._charts), "cf", len(ws.conditional_formatting), "formula", ws["C9"].value)
print("RESULT rows", len(pd.read_excel("отчёт_продажи.xlsx", header=2)))
`,
  "teleharness-docx": `
import docx
d = docx.Document("отчёт.docx")
print("RESULT headings", sum(p.style.name.startswith("Heading") for p in d.paragraphs))
print("RESULT tables", len(d.tables), "pictures", len(d.inline_shapes))
print("RESULT bullets", sum(p.style.name == "List Bullet" for p in d.paragraphs))
print("RESULT header", d.sections[0].header.paragraphs[0].text)
`,
  "teleharness-pptx": `
from pptx import Presentation
p = Presentation("презентация.pptx")
print("RESULT slides", len(p.slides))
print("RESULT charts", sum(1 for s in p.slides for sh in s.shapes if sh.has_chart))
print("RESULT pictures", sum(1 for s in p.slides for sh in s.shapes if sh.shape_type == 13))
print("RESULT title", next(sh.text_frame.text for sh in p.slides[0].shapes if sh.name == "Title"))
`,
  "teleharness-pdf": `
import pdfplumber, pypdf
with pdfplumber.open("отчёт.pdf") as pdf:
    t = pdf.pages[0].extract_text()
    print("RESULT cyr", "Отчёт о продажах" in t, "tables", len(pdf.pages[0].extract_tables()))
print("RESULT merged", len(pypdf.PdfReader("объединённый.pdf").pages))
`,
  "teleharness-images": `
from PIL import Image
print("RESULT small", Image.open("фото_1200.jpg").size)
print("RESULT webp", Image.open("фото.webp").format)
print("RESULT wm", Image.open("фото_водяной_знак.jpg").size)
print("RESULT collage", Image.open("коллаж.jpg").size)
print("RESULT chart", Image.open("график.png").format)
`,
  "teleharness-html": `
from bs4 import BeautifulSoup
s = BeautifulSoup(open("отчёт.html", encoding="utf-8").read(), "html.parser")
ext = [t for t in s.find_all(["link", "script", "img"]) if (t.get("src") or t.get("href") or "").startswith("http")]
print("RESULT title", s.title.string, "rows", len(s.select("tbody tr")), "external", len(ext), "style", bool(s.style))
`,
}
const EXPECT = {
  "teleharness-xlsx": [/RESULT charts 1 cf [2-9]/, /formula =SUM\(C4:C8\)/, /RESULT rows 6/],
  "teleharness-docx": [/RESULT headings [3-9]/, /RESULT tables 1 pictures 1/, /RESULT bullets [3-9]/, /RESULT header .+/],
  "teleharness-pptx": [/RESULT slides 5/, /RESULT charts 1/, /RESULT pictures [1-9]/, /RESULT title .+/],
  "teleharness-pdf": [/RESULT cyr True tables [1-9]/, /RESULT merged [2-9]/],
  "teleharness-images": [/RESULT small \(1200, 900\)/, /RESULT webp WEBP/, /RESULT wm \(1600, 1200\)/, /RESULT collage/, /RESULT chart PNG/],
  "teleharness-html": [/RESULT title .+ rows [3-9] external 0 style True/],
}

test("у каждого скилла есть frontmatter name/description и рецепты с проверками", () => {
  for (const name of NAMES) {
    const md = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    assert.ok(fm, `${name}: нет frontmatter`)
    assert.match(fm[1], new RegExp(`^name: ${name}$`, "m"))
    assert.match(fm[1], /^description: .{40,}$/m)
    assert.match(md, /## Правила песочницы/, `${name}: нет правил песочницы`)
    assert.match(md, /python имя\.py/, `${name}: нет правила про .py файл`)
    const b = blocks(md)
    const recipes = b.filter((x) => x.kind === "Рецепт").map((x) => x.id)
    const checks = b.filter((x) => x.kind === "Проверка").map((x) => x.id)
    assert.ok(recipes.length >= 1, `${name}: нет рецептов`)
    for (const id of recipes) assert.ok(checks.includes(id), `${name}: у рецепта ${id} нет проверки`)
  }
})

for (const name of NAMES) {
  test(`${name}: рецепты работают внутри teleharness-jail`, { skip }, () => {
    const dir = path.join(ROOT, name.replace("teleharness-", ""))
    fs.mkdirSync(dir)
    if (SEED[name]) {
      const r = py(dir, "seed.py", SEED[name])
      assert.equal(r.code, 0, r.err + r.out)
    }
    const md = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8")
    for (const b of blocks(md)) {
      const file = `${b.kind === "Рецепт" ? "r" : "check"}-${b.id}.py`
      const r = py(dir, file, b.code)
      assert.equal(r.code, 0, `${name} ${b.kind} ${b.id}: код ${r.code}\n${r.err}\n${r.out}`)
      if (b.kind === "Проверка") assert.match(r.out, /ПРОВЕРКА OK/, `${name} ${b.id}: ${r.out}`)
    }
    const v = py(dir, "verify.py", VERIFY[name])
    assert.equal(v.code, 0, v.err + v.out)
    for (const re of EXPECT[name]) assert.match(v.out, re, `${name}: ${v.out}`)
  })
}
