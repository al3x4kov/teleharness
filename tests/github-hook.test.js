// BUG-303 / TASK-14.21: юнит-тесты приёмника lib/github/hook.js —
// битый URL (%zz → 404), анонимное тело > 1 МБ без записи в БД,
// валидный ключ с телом > 1 МБ (413 + журнал триггера), ping, неверная подпись HMAC,
// дедупликация delivery_id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { triggerService } from "../lib/github/triggers.js";
import { createGithubHookHandler, BODY_LIMIT } from "../lib/github/hook.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "gh-hook-"));
const sign = (secret, body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function fakeReq(bodyStr, headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" };
  req.resume = () => {};
  setImmediate(() => {
    const buf = Buffer.from(bodyStr, "utf8");
    const step = 256 * 1024;
    for (let i = 0; i < buf.length; i += step) {
      req.emit("data", buf.subarray(i, Math.min(i + step, buf.length)));
    }
    req.emit("end");
  });
  return req;
}

function harness() {
  const dir = tmp();
  const dbPath = path.join(dir, "db.sqlite");
  const store = triggerService(dbPath, {
    secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") },
    now: () => 1_700_000_000_000,
  });
  const processed = [];
  const dispatcher = {
    processDelivery: async (d) => {
      processed.push(d);
      return "started";
    },
  };
  let last = null;
  const sendJson = (_res, status, body) => { last = { status, body }; };
  const handle = createGithubHookHandler({ store, dispatcher, sendJson, log: () => {}, now: () => 1_700_000_000_000 });
  const trigger = store.create("u1", {
    definitionId: "00000000-0000-4000-8000-000000000001",
    repo: "octo/hello",
    kinds: ["issue_labeled"],
  });
  async function invoke(pathname, bodyStr, headers = {}) {
    last = null;
    await handle(fakeReq(bodyStr, headers), {}, new URL(`http://127.0.0.1${pathname}`));
    return last;
  }
  return { dir, dbPath, store, trigger, processed, invoke, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("BUG-303: некорректное %-кодирование (%zz) в URL хука даёт 404 без исключения 500", async () => {
  const h = harness();
  try {
    const res = await h.invoke("/teleharness/hooks/github/%zz", "{}");
    assert.equal(res.status, 404);
  } finally {
    h.cleanup();
  }
});

test("BUG-303: неизвестный ключ триггера с телом > 1 МБ не раздувает таблицу journal строкой triggerId='unknown'", async () => {
  const h = harness();
  try {
    const huge = "x".repeat(BODY_LIMIT + 1024);
    const res = await h.invoke(`/teleharness/hooks/github/${"a".repeat(43)}`, huge);
    assert.ok(res.status === 404 || res.status === 413, `ожидался 404 или 413, получено ${res.status}`);
    // Проверяем напрямую в SQLite: записей с trigger_id='unknown' быть не должно
    const { createRequire } = await import("node:module");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(h.dbPath);
    try {
      const n = db.prepare("SELECT COUNT(*) AS n FROM journal WHERE trigger_id='unknown'").get().n;
      assert.equal(n, 0, "анонимный запрос >1 МБ не должен писать в БД trigger_id='unknown'");
    } finally {
      db.close();
    }
  } finally {
    h.cleanup();
  }
});

test("валидный ключ с телом > 1 МБ даёт 413 и пишет too_large в журнал своего триггера", async () => {
  const h = harness();
  try {
    const huge = "x".repeat(BODY_LIMIT + 1024);
    const res = await h.invoke(`/teleharness/hooks/github/${h.trigger.key}`, huge);
    assert.equal(res.status, 413);
    const rows = h.store.journal("u1", h.trigger.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "too_large");
  } finally {
    h.cleanup();
  }
});

test("ping → 200, неверная подпись HMAC → 401 + bad_signature, дедупликация delivery_id → 202 duplicate", async () => {
  const h = harness();
  try {
    const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const ping = await h.invoke(`/teleharness/hooks/github/${h.trigger.key}`, pingBody, {
      "x-github-event": "ping",
      "x-hub-signature-256": sign(h.trigger.secret, pingBody),
    });
    assert.equal(ping.status, 200);
    assert.equal(ping.body.pong, true);
    assert.equal(ping.body.trigger, h.trigger.id);

    const payload = JSON.stringify({ action: "labeled", issue: { number: 1 } });
    const badSig = await h.invoke(`/teleharness/hooks/github/${h.trigger.key}`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "del-bad",
      "x-hub-signature-256": "sha256=" + "0".repeat(64),
    });
    assert.equal(badSig.status, 401);
    assert.ok(h.store.journal("u1", h.trigger.id).some((r) => r.decision === "bad_signature"));

    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "del-1",
      "x-hub-signature-256": sign(h.trigger.secret, payload),
    };
    const first = await h.invoke(`/teleharness/hooks/github/${h.trigger.key}`, payload, headers);
    assert.equal(first.status, 202);
    assert.equal(first.body.queued, true);

    const dup = await h.invoke(`/teleharness/hooks/github/${h.trigger.key}`, payload, headers);
    assert.equal(dup.status, 202);
    assert.equal(dup.body.duplicate, true);

    await new Promise((r) => setImmediate(r));
    assert.equal(h.processed.length, 1, "дубликат delivery_id не передаётся в dispatcher повторно");
  } finally {
    h.cleanup();
  }
});
