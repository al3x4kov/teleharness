// FEAT-13.11: portal-side knowledge-base snapshot for Claude chats
// (lib/kb-cache.js — twin of ops/opencode/vault-cache.ts buildSnapshot) and
// FEAT-01.32 / BUG-01.27: the snapshot kept apart from the user's text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot, withSnapshot, zoneForUser } from "../lib/kb-cache.js";
import { firstUserContext, partKbContext, snapshotDerivedTitle } from "../shared/title.js";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-kb-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const ADMIN = path.join(TMP, "agents");
const TV = path.join(TMP, "tenants");
const note = (f, s) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, s);
};
note(path.join(ADMIN, "projects", "zai.md"), "---\nx: 1\n---\n# Портал zai\nстрока проекта\n");
note(path.join(ADMIN, "tasks", "t1.md"), "---\nstatus: active\n---\n# Задача администратора\n");
note(path.join(ADMIN, "lessons", "l1.md"), "---\nstatus: active\narea: ops\n---\n# Урок про рестарты\n");
note(path.join(ADMIN, "sessions", "2026-11-03-ses_prev.md"), `---\ndirectory: D:\\Portal\\zai\n---\n# Прошлый дайджест\n`);
note(path.join(TV, "alice", "tasks", "a1.md"), "---\nstatus: active\n---\n# Задача Алисы\n");

test("zoneForUser: admin → admin root; tenant → own obsidianRoot or tenant vault; unsafe name → none", () => {
  assert.equal(zoneForUser({ name: "admin" }, { admin: true, adminRoot: ADMIN, tenantVault: TV }).tenant, null);
  assert.equal(zoneForUser({ name: "admin" }, { admin: true, adminRoot: "", tenantVault: TV }).root, null, "ZAI_KB_ROOT empty = off");
  const a = zoneForUser({ name: "alice", directories: ["C:\\t\\alice"] }, { admin: false, adminRoot: ADMIN, tenantVault: TV });
  assert.equal(a.tenant, "alice");
  assert.equal(a.root.toLowerCase(), path.join(TV, "alice").replace(/\\/g, "/").toLowerCase());
  const own = zoneForUser({ name: "bob", obsidianRoot: "D:\\Obsidian\\tenants\\b" }, { admin: false, adminRoot: ADMIN, tenantVault: TV });
  assert.match(own.root, /tenants\/b$/);
  assert.equal(zoneForUser({ name: "..\\x" }, { admin: false, adminRoot: ADMIN, tenantVault: TV }).root, null);
});

test("buildSnapshot admin: marker, project note, tasks, lessons, digest pointers, admin rules", () => {
  const zone = zoneForUser({}, { admin: true, adminRoot: ADMIN, tenantVault: TV, home: "C:\\Users\\USER" });
  const s = buildSnapshot({ dir: "D:\\Portal\\zai", sid: "ses_now", zone, now: new Date(2026, 10, 4, 9, 5) });
  assert.match(s, /^\[obsidian-cache\] Активный кэш проекта «zai» \(D:\\Portal\\zai\), собран 2026-11-04 09:05\./);
  for (const re of [/Портал zai/, /Задача администратора/, /Урок про рестарты \(area: ops\)/, /sessions\/2026-11-03-ses_prev\.md/, /Правила кэша: .*agents[\\/]_index\.md/]) assert.match(s, re);
  // BUG-169: a question about the user → search the admin vault first
  assert.match(s, /Вопрос о самом пользователе .*сначала поищи в базе знаний .*agents/)
  // the catch-all home folder gets no digest pointers (BUG-12.14)
  assert.doesNotMatch(buildSnapshot({ dir: "C:\\Users\\USER", zone }), /Прошлые дайджесты/);
});

test("buildSnapshot tenant: own zone only, admin rules and admin vault never named", () => {
  const zone = zoneForUser({ name: "alice" }, { admin: false, adminRoot: ADMIN, tenantVault: TV });
  const s = buildSnapshot({ dir: "C:\\t\\alice", zone });
  assert.match(s, /пользователя «alice»/);
  assert.match(s, /Задача Алисы/);
  assert.doesNotMatch(s, /Задача администратора|Правила кэша|_index\.md|Урок про рестарты/);
  // BUG-169: the same rule, own zone only
  assert.match(s, /Вопрос о самом пользователе .*сначала поищи в базе знаний [^ ]*alice/);
  assert.doesNotMatch(s.slice(s.indexOf("Вопрос о самом пользователе")), /Obsidian[\\/]agents/);
  assert.equal(buildSnapshot({ dir: "C:\\x", zone: { tenant: "z", root: null } }), null);
});

test("withSnapshot: snapshot --- prompt, nothing without a snapshot", () => {
  assert.equal(withSnapshot("[obsidian-cache] a", "b"), "[obsidian-cache] a\n\n---\n\nb");
  assert.equal(withSnapshot(null, "b"), "b");
});

test("BUG-01.27: metadata context — partKbContext / firstUserContext; a snapshot-retelling title is caught with a clean text", () => {
  const msgs = [
    { info: { role: "user" }, parts: [{ type: "text", text: "Ответь одним словом: столица Италии?", metadata: { kbContext: "[obsidian-cache] zai.home.example.net HTTPS IPv6" } }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "Рим" }] },
  ];
  assert.equal(partKbContext(msgs[0].parts[0]), "[obsidian-cache] zai.home.example.net HTTPS IPv6");
  assert.equal(partKbContext({ type: "text", text: "x" }), null);
  assert.equal(firstUserContext(msgs), "[obsidian-cache] zai.home.example.net HTTPS IPv6");
  const raw = msgs[0].parts[0].text;
  assert.equal(snapshotDerivedTitle("HTTPS IPv6 для zaichat", raw, firstUserContext(msgs)), true);
  assert.equal(snapshotDerivedTitle("Столица Италии", raw, firstUserContext(msgs)), false);
  assert.equal(snapshotDerivedTitle("HTTPS IPv6 для zaichat", raw), false, "no context known → upstream title kept");
});
