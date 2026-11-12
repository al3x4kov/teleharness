// FEAT-16.3 (tasks 6.2, крит. 5): скрипт выката ключа провайдера
// ops/deploy/oc2-credential.mjs ставит ключ через POST /api/credential (при 409 —
// обновление DELETE+POST, design §9) и НИКОГДА не печатает и не логирует ключ:
// живой v2 эхом возвращает его в теле ответа (api-map §10), а фейк ниже делает
// то же — плюс возвращает его же в тексте ошибки. Проверяется stdout и stderr
// дочернего процесса. Запуск: node --test tests/oc2-credential.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs"

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", "ops", "deploy", "oc2-credential.mjs")
const KEY = "sk-zai-SECRET-e2f1a9c47b8d3660fa52"
const PW = "opencode-stand-password"
const ID = "zai-coding-plan"

function tmpAuth(extra = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-cred-")), "auth.json")
  fs.writeFileSync(file, JSON.stringify({ zai: { type: "api", key: "sk-other-provider-key" }, [ID]: { type: "api", key: KEY }, ...extra }))
  return file
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ZAI_OC_PASSWORD: PW, OPENCODE_SERVER_PASSWORD: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

const noLeak = (out) => {
  assert.ok(!out.stdout.includes(KEY), "ключ в stdout")
  assert.ok(!out.stderr.includes(KEY), "ключ в stderr")
  assert.ok(!out.stdout.includes(PW) && !out.stderr.includes(PW), "пароль Basic в выводе")
}

test("создание: POST /api/credential, тело по api-map §10, ключ не в stdout/stderr", async () => {
  const up = await startFakeOpencodeV2({ password: PW })
  try {
    const auth = tmpAuth()
    const out = await runCli([`--url=${up.url}`, `--auth=${auth}`])
    assert.equal(out.code, 0, `stdout=${out.stdout} stderr=${out.stderr}`)
    noLeak(out)
    assert.match(out.stdout + out.stderr, /credential.*(ок|200)/i, `статус напечатан: ${out.stdout}${out.stderr}`)
    const posts = up.requests.filter((r) => r.path === "/api/credential" && r.method === "POST")
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body, { id: ID, integrationID: ID, value: { type: "key", key: KEY }, activate: true })
    assert.equal(posts[0].authorization, `Basic ${Buffer.from(`opencode:${PW}`).toString("base64")}`, "Basic-авторизация")
    assert.equal(up.state.credentials[0].value.key, KEY, "ключ сохранён на сервере")
    fs.rmSync(path.dirname(auth), { recursive: true, force: true })
  } finally {
    await up.close()
  }
})

test("409 → обновление DELETE+POST, ключ не в stdout/stderr", async () => {
  const up = await startFakeOpencodeV2({ password: PW, credentials: [{ id: ID, integrationID: ID, value: { type: "key", key: "sk-stale" } }] })
  try {
    const auth = tmpAuth()
    const out = await runCli([`--url=${up.url}`, `--auth=${auth}`])
    assert.equal(out.code, 0, `stdout=${out.stdout} stderr=${out.stderr}`)
    noLeak(out)
    assert.match(out.stdout + out.stderr, /409|обновл/i, "в выводе видно, что был 409 и обновление")
    const seq = up.requests.filter((r) => r.path.startsWith("/api/credential")).map((r) => `${r.method} ${r.path}`)
    assert.deepEqual(seq, ["POST /api/credential", `DELETE /api/credential/${ID}`, "POST /api/credential"])
    assert.equal(up.state.credentials[0].value.key, KEY, "после обновления хранится новый ключ")
    fs.rmSync(path.dirname(auth), { recursive: true, force: true })
  } finally {
    await up.close()
  }
})

test("ошибка сервера, эхо ключа в тексте ошибки: код 1, статус виден, ключ и message не печатаются", async () => {
  const up = await startFakeOpencodeV2({ password: PW })
  up.route("POST", "/api/credential", () => ({ status: 500, json: { _tag: "BoomError", message: `kaboom ${KEY}` } }))
  try {
    const auth = tmpAuth()
    const out = await runCli([`--url=${up.url}`, `--auth=${auth}`])
    assert.equal(out.code, 1)
    noLeak(out)
    assert.ok(!out.stdout.includes("kaboom") && !out.stderr.includes("kaboom"), "тело ошибки не печатается")
    assert.match(out.stdout + out.stderr, /500/, "HTTP-статус виден")
    fs.rmSync(path.dirname(auth), { recursive: true, force: true })
  } finally {
    await up.close()
  }
})

test("неверный пароль → 401, код 1, ключ не печатается; нет пароля в env → код 2", async () => {
  const up = await startFakeOpencodeV2({ password: PW })
  try {
    const auth = tmpAuth()
    const bad = await runCli([`--url=${up.url}`, `--auth=${auth}`], { ZAI_OC_PASSWORD: "wrong" })
    assert.equal(bad.code, 1)
    noLeak(bad)
    assert.match(bad.stdout + bad.stderr, /401/)
    const nopw = await runCli([`--url=${up.url}`, `--auth=${auth}`], { ZAI_OC_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "" })
    assert.equal(nopw.code, 2, "нет пароля — ошибка использования")
    noLeak(nopw)
    fs.rmSync(path.dirname(auth), { recursive: true, force: true })
  } finally {
    await up.close()
  }
})

test("нет ключа для провайдера в auth.json → код 2, имя провайдера видно, ключ другого провайдера не утекает", async () => {
  const up = await startFakeOpencodeV2({ password: PW })
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-cred-")), "auth.json")
    fs.writeFileSync(file, JSON.stringify({ zai: { type: "api", key: "sk-other-provider-key" } }))
    const out = await runCli([`--url=${up.url}`, `--auth=${file}`, `--id=${ID}`])
    assert.equal(out.code, 2)
    noLeak(out)
    assert.ok(!out.stdout.includes("sk-other-provider-key") && !out.stderr.includes("sk-other-provider-key"), "чужой ключ не утекает")
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  } finally {
    await up.close()
  }
})
