// BUG-229: восстановление после рестарта гасит «running» в сохранённых zaiRun —
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
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-recover-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("BUG-229: при старте zaiRun running в сохранённой части становится stopped, времена сохраняются", async () => {
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
                { id: "p1", type: "tool", callID: "toolu_r", tool: "task", state: { status: "completed", input: { subagent_type: "explorer", description: "d", run_in_background: true }, time: { start: T0 + 1000, end: T0 + 1100 }, metadata: { zaiRun: { status: "running", startedAt: T0 + 1000, steps: [], output: null } } } },
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
  const z = stored.sessions.ses_rec.messages[1].parts.find((p) => p.id === "p1").state.metadata.zaiRun;
  assert.equal(z.status, "stopped", "запуск погашен восстановлением");
  assert.equal(z.startedAt, T0 + 1000, "начало работы сохранено");
  assert.ok(Number.isFinite(z.endedAt), "конец работы проставлен");

  // соседние части не тронуты, ответов «[Прервано рестартом портала]» не добавлено:
  // вопрос уже имеет ответ
  const parts = stored.sessions.ses_rec.messages[1].parts;
  assert.equal(parts.filter((p) => p.type === "text").length, 1);
});
