// Регрессия BUG-298 (BUG-20.36): повторное зависание session/prompt у Antigravity ACP
// из-за переиспользования отравленной SQLite-БД сессии (нетерминальный шаг в steps).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as acpChat from "../lib/acp-chat.js";
import { acpProfileDir } from "../lib/acp-login-launch.js";
import { agentEntry } from "../lib/acp-registry.js";
import { ClaudeRunner } from "../lib/claude.js";

const ACP_FAKE_298 = `
import readline from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\\n");
let sidSeq = 0;
let loadedSid = null;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        authMethods: [{ id: "oauth-personal" }],
      },
    });
  } else if (method === "session/new") {
    loadedSid = null;
    send({
      id,
      result: {
        sessionId: "s-clean-" + (++sidSeq) + "-" + process.pid,
        models: {
          currentModelId: "gemini-4-neon-medium",
          availableModels: [{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
        },
      },
    });
  } else if (method === "session/load") {
    loadedSid = params.sessionId;
    send({ id, result: {} });
  } else if (method === "session/set_model") {
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    const textBlock = blocks.find((b) => b.type === "text")?.text ?? "";
    const upd = (u) => send({ method: "session/update", params: { sessionId: params.sessionId, update: u } });

    if (textBlock.trimEnd().endsWith("STAY_BUSY_FOR_ABORT")) {
      upd({
        sessionUpdate: "tool_call",
        toolCallId: "busy-1",
        title: "sleep 60",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "sleep 60" },
      });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Работаю в фоне..." } });
      continue;
    }

    if (textBlock.trimEnd().endsWith("CRASH_MID_TURN")) {
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Часть ответа до падения" } });
      setTimeout(() => process.exit(1), 50);
      continue;
    }

    const hasHistory = textBlock.includes("[История чата]");
    const reply = "OK loaded=" + (loadedSid ? loadedSid : "no") + " history=" + (hasHistory ? "yes" : "no");
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
    send({ id, result: { stopReason: "end_turn" } });
  }
}
`;

const acpKey = (owner, agent) => createHash("sha256").update(JSON.stringify([owner, agent])).digest("hex");

function createAgyDb(profileDir, sessionId, statuses, { wal = true } = {}) {
  const convDir = path.join(profileDir, ".gemini", "antigravity-acp", "conversations");
  return mkdir(convDir, { recursive: true }).then(() => {
    const dbPath = path.join(convDir, sessionId + ".db");
    const db = new DatabaseSync(dbPath);
    try {
      if (wal) db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0)");
      const ins = db.prepare("INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)");
      statuses.forEach((st, i) => ins.run(i + 1, 21, st));
    } finally {
      db.close();
    }
    return dbPath;
  });
}

async function setupFakeAcpEnv(prefix, { withAntigravity = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const fakeGemini = agentEntry(dir, "gemini");
  await mkdir(path.dirname(fakeGemini), { recursive: true });
  await writeFile(fakeGemini, ACP_FAKE_298, "utf8");
  if (withAntigravity) {
    const fakeAgy = agentEntry(dir, "antigravity");
    const fakeAgyMjs = path.join(path.dirname(fakeAgy), "fake-agy.mjs");
    await mkdir(path.dirname(fakeAgy), { recursive: true });
    await writeFile(fakeAgyMjs, ACP_FAKE_298, "utf8");
    await writeFile(fakeAgy, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(fakeAgyMjs) + ' "$@"\n', "utf8");
    await chmod(fakeAgy, 0o755);
  }
  return dir;
}

function makeRunner(dir, events, opts = {}) {
  return new ClaudeRunner({
    hub: { emit: (evt) => events.push(evt), markManaged: () => {} },
    storePath: path.join(dir, "claude-sessions.json"),
    runsPath: path.join(dir, "claude-runs.json"),
    keepaliveMs: 80,
    acpPostAnswerIdleMs: 0,
    log: () => {},
    ...opts,
  });
}

async function sendAcp(runner, dir, sid, text, providerID = "acp-gemini", modelID = providerID) {
  const fakeRes = { writeHead() {}, end() {} };
  await runner.dispatch({
    res: fakeRes,
    sid,
    dir,
    access: "admin",
    acpOwner: "admin",
    permMode: "full",
    body: Buffer.from(JSON.stringify({
      model: { providerID, modelID },
      parts: [{ type: "text", text }],
    })),
  });
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timeout");
}

test("BUG-298 unit: antigravitySessionHasStaleSteps различает чистые, отравленные (1,2,8,9,11) и небезопасные БД", async () => {
  assert.equal(typeof acpChat.antigravitySessionHasStaleSteps, "function");
  const profile = await mkdtemp(path.join(tmpdir(), "teleharness-bug298-db-"));
  try {
    // Чистая БД со всеми терминальными статусами CortexStepStatus (DONE=3, INVALID=4, CLEARED=5, CANCELED=6, ERROR=7, INTERRUPTED=12)
    await createAgyDb(profile, "clean-sess-1", [3, 4, 5, 6, 7, 12], { wal: true });
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, "clean-sess-1"), false);

    // Каждый активный нетерминальный статус должен детектироваться (PENDING=1, RUNNING=2, GENERATING=8, WAITING=9, QUEUED=11)
    for (const activeStatus of [1, 2, 8, 9, 11]) {
      const sid = "stale-status-" + activeStatus;
      await createAgyDb(profile, sid, [3, 5, activeStatus, 3], { wal: true });
      assert.equal(
        acpChat.antigravitySessionHasStaleSteps(profile, sid),
        true,
        `статус ${activeStatus} должен распознаваться как застрявший активный шаг`,
      );
    }

    // Повреждённая БД с непустым WAL -> true (fail-safe); без WAL -> false (fail-open)
    const convDir = path.join(profile, ".gemini", "antigravity-acp", "conversations");
    await writeFile(path.join(convDir, "corrupt-wal.db"), "not-a-sqlite-db", "utf8");
    await writeFile(path.join(convDir, "corrupt-wal.db-wal"), "uncheckpointed-wal-bytes", "utf8");
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, "corrupt-wal"), true);
    await writeFile(path.join(convDir, "corrupt-nowal.db"), "not-a-sqlite-db", "utf8");
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, "corrupt-nowal"), false);

    // Отсутствующий файл и небезопасные id → false без исключений
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, "does-not-exist"), false);
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, "../escape"), false);
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, "a/b"), false);
    assert.equal(acpChat.antigravitySessionHasStaleSteps(profile, ""), false);
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

test("BUG-298 e2e: abort (user) и crash сбрасывают acpSessions — следующий ход стартует чистую ACP-сессию с историей", async () => {
  const dir = await setupFakeAcpEnv("teleharness-bug298-abort-");
  const events = [];
  const runner = makeRunner(dir, events);
  try {
    const sid = "ses_bug298_abort";
    // 1. Успешный ход сохраняет acpSessions
    await sendAcp(runner, dir, sid, "FIRST_CLEAN");
    await waitFor(() => events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length === 1);

    // 2. Второй успешный ход переиспользует чистую сессию (loaded != no)
    await sendAcp(runner, dir, sid, "SECOND_CLEAN");
    await waitFor(() => events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length === 2);
    const secondText = runner.messages(sid).filter((m) => m.info.role === "assistant")[1].parts.map((p) => p.text ?? "").join("");
    assert.ok(secondText.includes("loaded=s-clean-"), `чистая сессия должна переиспользоваться: ${secondText}`);
    assert.ok(secondText.includes("history=no"), `при session/load история не дублируется: ${secondText}`);

    // 3. Третий ход прерывается пользователем (abort)
    await sendAcp(runner, dir, sid, "STAY_BUSY_FOR_ABORT");
    await waitFor(() => runner.liveness()[sid]?.hasAnswerText === true);
    assert.equal(runner.abort(sid), true);
    await waitFor(() => events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length === 3);

    // 4. Четвёртый ход НЕ должен переиспользовать прерванную ACP-сессию
    await sendAcp(runner, dir, sid, "AFTER_ABORT");
    await waitFor(() => events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length === 4);
    const fourthText = runner.messages(sid).filter((m) => m.info.role === "assistant")[3].parts.map((p) => p.text ?? "").join("");
    assert.ok(fourthText.includes("loaded=no"), `после abort нельзя делать session/load: ${fourthText}`);
    assert.ok(fourthText.includes("history=yes"), `новая ACP-сессия должна получить историю: ${fourthText}`);

    // 5. Падение процесса (crash) также сбрасывает acpSessions
    await sendAcp(runner, dir, sid, "CRASH_MID_TURN");
    await waitFor(() => events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length === 5);
    await sendAcp(runner, dir, sid, "AFTER_CRASH");
    await waitFor(() => events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length === 6);
    const sixthText = runner.messages(sid).filter((m) => m.info.role === "assistant")[5].parts.map((p) => p.text ?? "").join("");
    assert.ok(sixthText.includes("loaded=no"), `после crash нельзя делать session/load: ${sixthText}`);
    assert.ok(sixthText.includes("history=yes"), `после crash новая сессия должна получить историю: ${sixthText}`);
  } finally {
    runner.shutdown();
    await runner.flushNow();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

test("BUG-298 e2e: #recover() после рестарта портала сбрасывает acpSessions прерванного ACP-хода", async () => {
  const dir = await setupFakeAcpEnv("teleharness-bug298-recover-");
  try {
    const sid = "ses_bug298_restart";
    const storePath = path.join(dir, "claude-sessions.json");
    const runsPath = path.join(dir, "claude-runs.json");
    // Эмулируем состояние на диске в момент внезапного рестарта teleharness-web:
    // прошлый успешный ход записал acpSessions, а текущий ACP-ход остался в claude-runs.json без ответа.
    await writeFile(storePath, JSON.stringify({
      version: 1,
      sessions: {
        [sid]: {
          directory: dir,
          claudeSid: null,
          acpSessions: { [acpKey("admin", "gemini")]: "poisoned-before-restart", [acpKey("admin", "copilot")]: "dropped-in-legacy-format" },
          updatedAt: Date.now() - 1000,
          messages: [
            { info: { id: "msgc_u_1", sessionID: sid, role: "user", time: { created: Date.now() - 5000 } }, parts: [{ id: "prt_1", type: "text", text: "Старый вопрос" }] },
            { info: { id: "msgc_a_1", sessionID: sid, role: "assistant", parentID: "msgc_u_1", providerID: "acp-gemini", modelID: "acp-gemini", time: { created: Date.now() - 5000, completed: Date.now() - 4000 } }, parts: [{ id: "prt_2", type: "text", text: "Старый ответ" }] },
            { info: { id: "msgc_u_2", sessionID: sid, role: "user", time: { created: Date.now() - 2000 } }, parts: [{ id: "prt_3", type: "text", text: "Ход прерванный рестартом" }] },
          ],
        },
        ses_bug298_restart_keyed: {
          directory: dir,
          claudeSid: null,
          acpSessions: { [acpKey("admin", "gemini")]: "poisoned-keyed", [acpKey("admin", "copilot")]: "clean-other-agent" },
          updatedAt: Date.now() - 1000,
          messages: [
            { info: { id: "msgc_u_k1", sessionID: "ses_bug298_restart_keyed", role: "user", time: { created: Date.now() - 2000 } }, parts: [{ id: "prt_k1", type: "text", text: "Ход с acpSessionKey" }] },
          ],
        },
      },
    }), "utf8");
    await writeFile(runsPath, JSON.stringify({
      version: 1,
      runs: {
        [sid]: {
          pid: 999999,
          image: "node",
          spawnedAt: Date.now() - 2000,
          claudeSid: null,
          userMsgId: "msgc_u_2",
          modelID: "acp-gemini",
          engine: "acp",
          providerID: "acp-gemini",
        },
        ses_bug298_restart_keyed: {
          pid: 999998,
          image: "node",
          spawnedAt: Date.now() - 2000,
          claudeSid: null,
          userMsgId: "msgc_u_k1",
          modelID: "acp-gemini",
          engine: "acp",
          providerID: "acp-gemini",
          acpSessionKey: acpKey("admin", "gemini"),
        },
      },
    }), "utf8");

    const events = [];
    const runner = makeRunner(dir, events, { procInspect: () => null, procKill: () => false });
    try {
      await runner.flushNow();
      const rawStore = JSON.parse(await readFile(storePath, "utf8"));
      assert.equal(
        rawStore.sessions[sid].acpSessions,
        undefined,
        "legacy-запись runs без acpSessionKey должна целиком сбрасывать acpSessions",
      );
      assert.equal(
        rawStore.sessions.ses_bug298_restart_keyed.acpSessions?.[acpKey("admin", "gemini")],
        undefined,
        "запись runs с acpSessionKey должна удалять только ключ прерванного агента",
      );
      assert.equal(
        rawStore.sessions.ses_bug298_restart_keyed.acpSessions?.[acpKey("admin", "copilot")],
        "clean-other-agent",
        "запись runs с acpSessionKey не должна задевать чистую сессию другого агента",
      );

      // Следующий ход после рестарта должен стартовать чистую сессию с историей
      await sendAcp(runner, dir, sid, "CONTINUE_AFTER_RESTART");
      await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sid));
      const assts = runner.messages(sid).filter((m) => m.info.role === "assistant");
      const lastText = assts[assts.length - 1].parts.map((p) => p.text ?? "").join("");
      assert.ok(lastText.includes("loaded=no"), `после рестарта нельзя грузить poisoned-before-restart: ${lastText}`);
      assert.ok(lastText.includes("history=yes"), `после рестарта новая сессия должна получить историю: ${lastText}`);
    } finally {
      runner.shutdown();
      await runner.flushNow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

test("BUG-298 e2e (POSIX): acp-shim.mjs пропускает session/load для отравленной Antigravity SQLite-БД и грузит чистую", { skip: process.platform === "win32" }, async () => {
  const dir = await setupFakeAcpEnv("teleharness-bug298-shim-", { withAntigravity: true });
  try {
    const profile = acpProfileDir(dir, "admin", "antigravity");
    await createAgyDb(profile, "agy-poisoned-3176", [3, 3, 2, 3], { wal: true });
    await createAgyDb(profile, "agy-clean-9999", [3, 5, 6, 7], { wal: true });

    const sidPoisoned = "ses_bug298_poisoned_db";
    const sidClean = "ses_bug298_clean_db";
    await writeFile(path.join(dir, "claude-sessions.json"), JSON.stringify({
      version: 1,
      sessions: {
        [sidPoisoned]: {
          directory: dir,
          claudeSid: null,
          acpSessions: { [acpKey("admin", "antigravity")]: "agy-poisoned-3176" },
          updatedAt: Date.now() - 1000,
          messages: [
            { info: { id: "msgc_u_p1", sessionID: sidPoisoned, role: "user", time: { created: Date.now() - 5000 } }, parts: [{ id: "prt_p1", type: "text", text: "Контекст до зависания" }] },
            { info: { id: "msgc_a_p1", sessionID: sidPoisoned, role: "assistant", parentID: "msgc_u_p1", providerID: "acp-antigravity", modelID: "gemini-4-neon-medium", time: { created: Date.now() - 5000, completed: Date.now() - 4000 } }, parts: [{ id: "prt_p2", type: "text", text: "Прошлый ответ" }] },
          ],
        },
        [sidClean]: {
          directory: dir,
          claudeSid: null,
          acpSessions: { [acpKey("admin", "antigravity")]: "agy-clean-9999" },
          updatedAt: Date.now() - 1000,
          messages: [
            { info: { id: "msgc_u_c1", sessionID: sidClean, role: "user", time: { created: Date.now() - 5000 } }, parts: [{ id: "prt_c1", type: "text", text: "Чистый контекст" }] },
            { info: { id: "msgc_a_c1", sessionID: sidClean, role: "assistant", parentID: "msgc_u_c1", providerID: "acp-antigravity", modelID: "gemini-4-neon-medium", time: { created: Date.now() - 5000, completed: Date.now() - 4000 } }, parts: [{ id: "prt_c2", type: "text", text: "Чистый ответ" }] },
          ],
        },
      },
    }), "utf8");

    const events = [];
    const runner = makeRunner(dir, events);
    try {
      await sendAcp(runner, dir, sidPoisoned, "PING_POISONED", "acp-antigravity", "gemini-4-neon-medium");
      await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sidPoisoned));
      const pText = runner.messages(sidPoisoned).filter((m) => m.info.role === "assistant").at(-1).parts.map((p) => p.text ?? "").join("");
      assert.ok(pText.includes("loaded=no"), `отравленная БД agy-poisoned-3176 должна быть пропущена: ${pText}`);
      assert.ok(pText.includes("history=yes"), `при пропуске отравленной БД передаётся история чата: ${pText}`);

      await sendAcp(runner, dir, sidClean, "PING_CLEAN", "acp-antigravity", "gemini-4-neon-medium");
      await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sidClean));
      const cText = runner.messages(sidClean).filter((m) => m.info.role === "assistant").at(-1).parts.map((p) => p.text ?? "").join("");
      assert.ok(cText.includes("loaded=agy-clean-9999"), `чистая БД должна штатно загружаться через session/load: ${cText}`);
      assert.ok(cText.includes("history=no"), `при чистом session/load история не дублируется: ${cText}`);
    } finally {
      runner.shutdown();
      await runner.flushNow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});
