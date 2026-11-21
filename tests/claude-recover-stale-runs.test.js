// BUG-229: восстановление после рестарта гасит «running» в сохранённых teleharnessRun —
// после рестарта ни один субагент работать не может (осиротевшие CLI убиты),
// вечная работа в истории — фантом. Run:
//   node --test --test-timeout=60000 tests/claude-recover-stale-runs.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../lib/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-claude-recover-"));
after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); // уборка по возможности: на Windows папку может держать дочерний процесс (EBUSY)
  } catch {}
});

test("BUG-229: при старте teleharnessRun running в сохранённой части становится stopped, времена сохраняются", async () => {
  const dir = path.join(TMP, "data");
  mkdirSync(dir, { recursive: true });
  const storePath = path.join(dir, "claude-sessions.json");
  const T0 = Date.now() - 60_000;
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      sessions: {
        ses_rec: {
          id: "ses_rec",
          directory: "D:\\Chats\\rec",
          claudeSid: "cls-1",
          updatedAt: T0,
          title: "Т",
          titleSource: "auto",
          messages: [
            { info: { id: "u1", role: "user", time: { created: T0 } }, parts: [{ id: "t1", type: "text", text: "запусти агента" }] },
            {
              info: { id: "a1", role: "assistant", time: { created: T0 + 1000, completed: T0 + 2000 } },
              parts: [
                { id: "p1", type: "tool", callID: "toolu_r", tool: "task", state: { status: "completed", input: { subagent_type: "explorer", description: "d", run_in_background: true }, time: { start: T0 + 1000, end: T0 + 1100 }, metadata: { teleharnessRun: { status: "running", startedAt: T0 + 1000, steps: [], output: null } } } },
                { id: "p2", type: "text", text: "запустил фоном" },
              ],
            },
          ],
        },
      },
    }),
    "utf8",
  );

  const runner = new ClaudeRunner({ hub: { markManaged() {}, emit: () => {} }, storePath, binPath: FIXTURE, keepaliveMs: 1000, log: () => {} });
  await runner.flushNow();

  const stored = JSON.parse(readFileSync(storePath, "utf8"));
  const z = stored.sessions.ses_rec.messages[1].parts.find((p) => p.id === "p1").state.metadata.teleharnessRun;
  assert.equal(z.status, "stopped", "запуск погашен восстановлением");
  assert.equal(z.startedAt, T0 + 1000, "начало работы сохранено");
  assert.ok(Number.isFinite(z.endedAt), "конец работы проставлен");

  // соседние части не тронуты, ответов «[Прервано рестартом портала]» не добавлено:
  // вопрос уже имеет ответ
  const parts = stored.sessions.ses_rec.messages[1].parts;
  assert.equal(parts.filter((p) => p.type === "text").length, 1);
});

// FEAT-20.2: ход, прерванный перезапуском, сообщается доске внимания
// (onInterrupted) — в «Упало или остановлено» со словами «Остановлен перезапуском».
test("FEAT-20.2: onInterrupted gets every chat whose question was cut by the restart, once per chat", async () => {
  const dir = path.join(TMP, "data-attn");
  mkdirSync(dir, { recursive: true });
  const storePath = path.join(dir, "claude-sessions.json");
  const T0 = Date.now() - 60_000;
  const q = (id, t) => ({ info: { id, role: "user", time: { created: t } }, parts: [{ id: "t" + id, type: "text", text: "вопрос" }] });
  writeFileSync(storePath, JSON.stringify({ version: 1, sessions: {
    ses_cut: { id: "ses_cut", directory: "/p/teleharness", claudeSid: "c1", updatedAt: T0, messages: [q("u1", T0), q("u2", T0 + 1)] },
    ses_ok: { id: "ses_ok", directory: "/p/teleharness", claudeSid: "c2", updatedAt: T0, messages: [q("u3", T0), { info: { id: "a3", role: "assistant", time: { created: T0 + 5 } }, parts: [{ id: "x", type: "text", text: "ok" }] }] },
  } }), "utf8");
  const got = [];
  const runner = new ClaudeRunner({ hub: { markManaged() {}, emit: () => {} }, storePath, binPath: FIXTURE, keepaliveMs: 1000, log: () => {}, onInterrupted: (list) => got.push(...list) });
  await runner.flushNow();
  assert.equal(got.length, 1, "one entry per chat");
  assert.equal(got[0].sid, "ses_cut");
  assert.equal(got[0].dir, "/p/teleharness");
  assert.ok(Number.isFinite(got[0].at));
});
