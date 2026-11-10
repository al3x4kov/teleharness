// Живой тест zai-jail.exe (FEAT-04.9, критерий 3). Только Windows; нужен собранный exe
// (ops/sandbox/build.ps1) и окружение D:\zai-sandbox\python (setup-python.ps1).
//   node --test ops/sandbox/tests/jail-live.test.mjs
// Создаёт временные папки двух тенантов в %TEMP% и удаляет их. Содержимое секретов
// не печатается: проверки выводят только READ/DENIED.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HERE = import.meta.dirname
const EXE = process.env.ZAI_JAIL_EXE || path.resolve(HERE, "..", "zai-jail.exe")
const PY = (process.env.ZAI_SANDBOX_PY || "D:/zai-sandbox/python").replace(/\\/g, "/")
const CAFILE = `${PY}/Lib/site-packages/certifi/cacert.pem`
const PORTAL = process.env.ZAI_PORTAL_DIR || "D:\\Portal\\zai"
const skip =
  process.platform !== "win32" ? "не Windows" :
  !fs.existsSync(EXE) ? `нет ${EXE} (ops/sandbox/build.ps1)` :
  !fs.existsSync(`${PY}/Scripts/python.exe`) ? `нет ${PY} (ops/sandbox/setup-python.ps1)` : false

let ROOT, A, B
const stamp = `${process.pid}-${Date.now()}`

function jail(dir, name, command, extra = []) {
  const b64 = Buffer.from(`cmd.exe /d /s /c "${command}"`, "utf8").toString("base64url")
  const r = spawnSync(EXE, ["--name", name, "--dir", dir, "--net", "--cafile", CAFILE, "--path-prepend", `${PY}/Scripts`, ...extra, "--b64", b64], { encoding: "utf8", timeout: 120000 })
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }
}
// Python-проба в контейнере тенанта A: печатает только итог, без содержимого файлов.
function probe(code, dir = A, name = "zai-t-livea") {
  fs.writeFileSync(path.join(dir, "probe.py"), code)
  return jail(dir, name, "python probe.py")
}
const READ = (p) => `
p = r"""${p}"""
try:
    with open(p, "rb") as f: f.read(1)
    print("READ")
except OSError as e:
    print("DENIED", type(e).__name__)
`
const WRITE = (p) => `
import os
p = r"""${p}"""
try:
    with open(p, "w") as f: f.write("x")
    print("WROTE")
except OSError as e:
    print("DENIED", type(e).__name__)
`
const LIST = (p) => `
import os
try:
    os.listdir(r"""${p}"""); print("LISTED")
except OSError as e:
    print("DENIED", type(e).__name__)
`

before(() => {
  if (skip) return
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "zai-jail-live-"))
  A = path.join(ROOT, "livea")
  B = path.join(ROOT, "liveb")
  fs.mkdirSync(A); fs.mkdirSync(B)
  // tenant B owns a file (its container gets Modify on its folder on first run)
  const r = jail(B, "zai-t-liveb", "echo secret-b> b.txt")
  assert.equal(r.code, 0, r.err)
})

after(() => {
  if (!ROOT) return
  for (const p of [path.join(PORTAL, `jail-live-${stamp}.txt`), `C:\\Windows\\jail-live-${stamp}.txt`]) assert.equal(fs.existsSync(p), false, `появился ${p}`)
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test("своя папка: запись и чтение", { skip }, () => {
  const r = jail(A, "zai-t-livea", "echo hello> own.txt && type own.txt")
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /hello/)
  assert.ok(fs.existsSync(path.join(A, "own.txt")))
})

test("кавычки и спецсимволы остаются внутри cmd.exe контейнера", { skip }, () => {
  const r = jail(A, "zai-t-livea", `python -c "print('a&b|c' + chr(34))" & echo "x & y" | findstr y`)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /a&b\|c"/)
  assert.match(r.out, /"x & y"/)
})

test("запись в код портала и в C:\\Windows — отказ", { skip }, () => {
  assert.match(probe(WRITE(path.join(PORTAL, `jail-live-${stamp}.txt`))).out, /DENIED PermissionError/)
  assert.match(probe(WRITE(`C:\\Windows\\jail-live-${stamp}.txt`)).out, /DENIED PermissionError/)
  assert.match(probe(WRITE(path.join(PORTAL, "server.js"))).out, /DENIED PermissionError/)
  const r = jail(A, "zai-t-livea", `echo x> ${PORTAL}\\jail-live-${stamp}.txt`)
  assert.notEqual(r.code, 0)
})

test("секреты портала и файлы владельца — отказ", { skip }, () => {
  assert.match(probe(READ(path.join(PORTAL, "data", "users.json"))).out, /DENIED PermissionError/)
  assert.match(probe(READ(path.join(PORTAL, "data", "admin-token.txt"))).out, /DENIED PermissionError/)
  assert.match(probe(LIST(path.join(PORTAL, "data"))).out, /DENIED PermissionError/)
  assert.match(probe(LIST("C:\\Users\\USER\\Documents")).out, /DENIED PermissionError/)
  assert.match(probe(LIST(path.join(os.homedir(), ".config", "opencode"))).out, /DENIED PermissionError/)
  assert.match(probe(LIST("D:\\Obsidian\\agents")).out, /DENIED PermissionError/)
})

test("чужая папка тенанта — ни чтения, ни записи", { skip }, () => {
  assert.match(probe(READ(path.join(B, "b.txt"))).out, /DENIED PermissionError/)
  assert.match(probe(WRITE(path.join(B, "from-a.txt"))).out, /DENIED PermissionError/)
  assert.equal(fs.existsSync(path.join(B, "from-a.txt")), false)
})

test("127.0.0.1 (opencode :4096, портал :4170) — недоступен", { skip }, () => {
  const r = probe(`
import socket
for port in (4096, 4170):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=4).close(); print("OPEN", port)
    except OSError as e:
        print("CLOSED", port, type(e).__name__)
`)
  assert.doesNotMatch(r.out, /OPEN/, r.out)
  assert.match(r.out, /CLOSED 4096/)
  assert.match(r.out, /CLOSED 4170/)
})

test("pandas читает xlsx в своей папке", { skip }, () => {
  const r = probe(`
import pandas as pd
df = pd.DataFrame({"ФИО": ["Иванов", "Петров", "Иванов", "Сидоров", "Иванов"], "Статус": ["Победитель", "Призёр", "Победитель", "Победитель", "Участник"]})
df.to_excel("t.xlsx", index=False)
d = pd.read_excel("t.xlsx")
print("TOP", d[d["Статус"] == "Победитель"]["ФИО"].value_counts().idxmax())
`)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /TOP Иванов/)
})

test("https наружу работает (certifi)", { skip: skip || (process.env.ZAI_JAIL_NO_NET ? "ZAI_JAIL_NO_NET" : false) }, () => {
  const r = probe(`
import requests
print("HTTP", requests.get("https://example.com", timeout=20).status_code)
`)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /HTTP 200/)
})

test("запускатель: проверка аргументов", { skip }, () => {
  let r = jail(A, "tenant-a", "echo x")
  assert.equal(r.code, 2)
  assert.match(r.err, /имя контейнера/)
  r = jail(A, "zai-t-livea", "echo x", ["--cwd", ROOT])
  assert.equal(r.code, 2)
  assert.match(r.err, /--cwd вне папки тенанта/)
  r = jail(A, "zai-t-livea", "cd", ["--cwd", A])
  assert.equal(r.code, 0, r.err)
})
