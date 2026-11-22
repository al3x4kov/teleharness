// FEAT-20.3 (1.9): permission API с кэшем 10 мин; рамка данных; логи CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPermissionCache } from "../lib/github/permissions.js";
import { AGENT_DATA_FRAME, frameAgentText, maskSecrets, tailLog, prepareCiLog, CI_LOG_TAIL } from "../lib/github/ci-logs.js";

function jsonResponse(status, data = null, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => data, text: async () => JSON.stringify(data) };
}

test("FEAT-20.3: permission — write/maintain/admin доверены, read нет, кэш 10 мин", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes("/collaborators/writer/")) return jsonResponse(200, { permission: "write" });
    if (url.includes("/collaborators/reader/")) return jsonResponse(200, { permission: "read" });
    if (url.includes("/collaborators/ghost/")) return jsonResponse(404, { message: "not found" });
    return jsonResponse(403, { message: "no" });
  };
  let now = 1_000_000;
  const has = createPermissionCache({ apiBase: "http://gh.local", fetchImpl, now: () => now }).has;
  assert.equal(await has("writer", "o/r", "t"), true);
  assert.equal(await has("reader", "o/r", "t"), false);
  assert.equal(await has("ghost", "o/r", "t"), false, "404 — не доверен");
  assert.equal(calls, 3);
  assert.equal(await has("writer", "o/r", "t"), true, "кэш: повтор без запроса");
  assert.equal(await has("reader", "o/r", "t"), false);
  assert.equal(await has("ghost", "o/r", "t"), false);
  assert.equal(calls, 3, "все исходы кэшируются");
  now += 600_001; // TTL истёк
  await has("writer", "o/r", "t");
  assert.equal(calls, 4, "после TTL — снова запрос");
  assert.equal(await has("anyone", "o/r", null), false, "без токена — нет, без запроса");
});

test("FEAT-20.3: рамка данных — оборачивает и обрезает 20 000 с пометкой", () => {
  const framed = frameAgentText("/agent сделай отчёт");
  assert.ok(framed.startsWith(AGENT_DATA_FRAME));
  assert.ok(framed.includes("/agent сделай отчёт"));
  assert.ok(frameAgentText("").startsWith(AGENT_DATA_FRAME), "пустой текст тоже в рамке");
  const big = "x".repeat(25_000);
  const cut = frameAgentText(big);
  assert.ok(cut.length < 25_000 + AGENT_DATA_FRAME.length + 200);
  assert.ok(cut.includes("обрезано"), "обрезка помечена");
  assert.ok(frameAgentText("abcdef", 5).includes("(обрезано до 5"));
});

test("FEAT-20.3: маскирование секретов — токены и «секрет=…»", () => {
  const log = [
    "token " + "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 in log",
    "github_pat_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
    "AKIA" + "IOSFODNN7EXAMPLE and " + "xoxb-" + "123456789-abcdefghijklmnop",
    "sk-proj-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    "Authorization: Bearer abc123",
    "password = hunter2",
    "обычный текст без секретов",
  ].join("\n");
  const masked = maskSecrets(log);
  assert.ok(!masked.includes("ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "ghp_ замаскирован");
  assert.ok(!masked.includes("github_pat_"), "github_pat_ замаскирован");
  assert.ok(!masked.includes("AKIA" + "IOSFODNN7EXAMPLE"), "AWS key замаскирован");
  assert.ok(!masked.includes("xoxb-" + "123456789"), "Slack токен замаскирован");
  assert.ok(!masked.includes("sk-proj-"), "OpenAI-подобный ключ замаскирован");
  assert.ok(!masked.includes("hunter2"), "password= замаскирован");
  assert.ok(masked.includes("***"));
  assert.ok(masked.includes("обычный текст без секретов"), "обычный текст не тронут");
});

test("FEAT-20.3: хвост лога CI — последние 64 КБ, строка не рвётся, маскируется", () => {
  const lines = Array.from({ length: 6000 }, (_, i) => `line ${String(i).padStart(5, "0")} abcdefghij\n`).join(""); // ~78 КБ
  const tail = tailLog(lines);
  assert.ok(tail.length <= CI_LOG_TAIL + 200, "хвост в пределах лимита");
  assert.ok(tail.startsWith("…(начало обрезано)"));
  assert.ok(tail.includes("line 05999"), "конец лога сохранён");
  const content = tail.slice(tail.indexOf("\n") + 1);
  assert.ok(content.startsWith("line "), "начало после среза — граница строки");
  const masked = prepareCiLog("start " + "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n" + "z".repeat(200));
  assert.ok(masked.includes("***"), "хвост маскируется");
  assert.ok(!masked.includes("ghp_"));
});

test("FEAT-20.3 1.14: fetchCiLog — упавшие job'ы с логами, общий хвост и маскирование; без упавших — null", async () => {
  const { fetchCiLog } = await import("../lib/github/ci-logs.js");
  const paths = [];
  const ghText = async (userId, pathname) => {
    paths.push({ userId, pathname });
    if (pathname.endsWith("/jobs?per_page=100")) return { status: 200, text: JSON.stringify({ jobs: [
      { id: 1, name: "build", conclusion: "success" },
      { id: 2, name: "test", conclusion: "failure" },
      { id: 3, name: "lint", conclusion: "failure" },
    ] }) };
    const id = Number(pathname.match(/\/actions\/jobs\/(\d+)\/logs$/)?.[1]);
    return { status: 200, text: id === 2 ? "AssertionError: expected 2\n" : "npm ERR! lint\n" };
  };
  const log = await fetchCiLog({ ghText, userId: "u1" }, "octo/hello", 55);
  assert.ok(log.includes("job test") && log.includes("AssertionError"), "лог упавшего test");
  assert.ok(log.includes("job lint"), "оба упавших job'а");
  assert.ok(!log.includes("job build"), "успешный job не нужен");
  assert.deepEqual(paths.filter((p) => !p.pathname.endsWith("/jobs?per_page=100")).map((p) => p.pathname.split("/").pop()).sort(), ["logs", "logs"]);
  const none = await fetchCiLog({ ghText: async () => ({ status: 200, text: JSON.stringify({ jobs: [{ id: 1, name: "build", conclusion: "success" }] }) }), userId: "u1" }, "octo/hello", 56);
  assert.equal(none, null, "нет упавших job'ов — лога нет");
  await assert.rejects(fetchCiLog({ ghText: async () => { throw new Error("GitHub 404"); }, userId: "u1" }, "octo/hello", 57), /GitHub 404/);
});
