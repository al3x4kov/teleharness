// FEAT-20.3 (1.3): часовой обход подключений — предупреждение и push один раз.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectionService } from "../lib/github/connections.js";
import { createTokenWatchdog } from "../lib/github/watchdog.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "gh-watch-"));
const DAY = 86_400_000;

function setup({ connections }) {
  const notes = [];
  const calls = [];
  const wd = createTokenWatchdog({
    connections,
    check: async (token) => { calls.push(token); return { login: "octocat", expiresAt: 1_999_999_999_999, repos: [{ fullName: "octocat/new", private: false, permissions: null }] }; },
    secrets: { decrypt: (enc) => `plain-${enc}` },
    notify: async (owner, kind, info) => { notes.push({ owner, kind, info }); },
    intervalMs: DAY,
    now: () => 1_700_000_000_000,
  });
  return { wd, notes, calls };
}

test("FEAT-20.3: истечение ≤ 7 дней — предупреждение один раз", async () => {
  const dir = tmp();
  try {
    const store = connectionService(path.join(dir, "db.sqlite"));
    store.save("u1", { login: "octocat", tokenEnc: "enc", tokenLast4: "6789", expiresAt: 1_700_000_000_000 + 3 * DAY, permissions: {}, status: "ok", checkedAt: 0 });
    const { wd, notes } = setup({ connections: store });
    await wd.tick();
    assert.deepEqual(notes, [{ owner: "u1", kind: "expiring", info: { login: "octocat", tokenLast4: "6789", days: 3 } }]);
    await wd.tick();
    assert.equal(notes.length, 1, "второй обход не повторяет предупреждение");
    assert.equal(store.get("u1").warnedAt, 1_700_000_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: часовой предел — свежую проверку не повторяем, дозревшую выполняем", async () => {
  const dir = tmp();
  try {
    const store = connectionService(path.join(dir, "db.sqlite"));
    const t = 1_700_000_000_000;
    store.save("u1", { login: "octocat", tokenEnc: "enc", tokenLast4: "6789", expiresAt: null, permissions: {}, status: "ok", checkedAt: t });
    const { wd, calls } = setup({ connections: store });
    await wd.tick();
    assert.equal(calls.length, 0, "проверяли час назад — рано");
    store.update("u1", { checkedAt: t - 2 * DAY });
    await wd.tick();
    assert.deepEqual(calls, ["plain-enc"]);
    const row = store.get("u1");
    assert.equal(row.status, "ok");
    assert.deepEqual(row.permissions.repos[0].fullName, "octocat/new");
    assert.equal(row.expiresAt, 1_999_999_999_999, "срок обновлён из ответа GitHub");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: отозванный токен — статус expired и push один раз; сеть — unreachable без push", async () => {
  const dir = tmp();
  try {
    const store = connectionService(path.join(dir, "db.sqlite"));
    store.save("u1", { login: "octocat", tokenEnc: "enc", tokenLast4: "6789", expiresAt: null, permissions: {}, status: "ok", checkedAt: 0 });
    store.save("u2", { login: "hub", tokenEnc: "enc2", tokenLast4: "abcd", expiresAt: null, permissions: {}, status: "ok", checkedAt: 0 });
    const notes = [];
    const failures = { u1: Object.assign(new Error("GitHub 401: Bad credentials"), { kind: "auth", status: 401 }), u2: Object.assign(new Error("network"), { kind: "network", status: 0 }) };
    const wd = createTokenWatchdog({
      connections: store,
      check: async (plain) => { throw plain === "plain-enc" ? failures.u1 : failures.u2; },
      secrets: { decrypt: (enc) => `plain-${enc}` },
      notify: async (owner, kind, info) => { notes.push({ owner, kind, info }); },
      intervalMs: DAY,
      now: () => 1_700_000_000_000,
    });
    await wd.tick();
    assert.equal(store.get("u1").status, "expired");
    assert.equal(store.get("u2").status, "unreachable", "нет связи — не «истёк»");
    assert.deepEqual(notes.map((n) => n.owner), ["u1"], "push только по истёкшему");
    await wd.tick();
    assert.equal(notes.length, 1, "push об истечении — один раз");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
