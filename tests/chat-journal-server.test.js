// FEAT-11.18 (шаг Б): конец хода → журнал чата в зоне базы знаний; следующий ход получает в
// системном промпте строку с путём к журналу. Дочерняя сессия субагента журнала не получает.
// Run: node --test tests/chat-journal-server.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { waitFor } from "./helpers/wait.mjs";

const ADMIN = "j".repeat(20) + "-admin-token-" + "3".repeat(24);
const TMP = mkdtempSync(path.join(tmpdir(), "zai-jrn-"));
const KB = path.join(TMP, "kb");
const DIR = path.join(TMP, "proj");
let up, srv;
const api = (p, { method = "GET", body } = {}) => fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, origin: srv.base, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const T0 = Date.now() - 60_000;
const model = { providerID: "zai-coding-plan", modelID: "glm-5.3" };

before(async () => {
  up = await startFakeOpencode();
  up.route("POST", "/session/ses_j/prompt_async", () => ({ status: 204 }));
  up.state.sessions.push({ id: "ses_j", directory: DIR, title: "Журнальный чат", model }, { id: "ses_kid", directory: DIR, title: "дочерняя", parentID: "ses_j", model });
  up.state.messages.ses_j = [
    { info: { id: "u1", role: "user", sessionID: "ses_j", time: { created: T0 } }, parts: [{ id: "p1", type: "text", text: "Собери отчёт" }] },
    { info: { id: "a1", role: "assistant", sessionID: "ses_j", modelID: "glm-5.3", time: { created: T0 + 1000, completed: T0 + 5000 } }, parts: [{ id: "p2", type: "tool", tool: "write", state: { status: "completed", input: { filePath: path.join(DIR, "report.md") } } }, { id: "p3", type: "text", text: "Отчёт собран." }] },
  ];
  up.state.messages.ses_kid = [{ info: { id: "k1", role: "user", sessionID: "ses_kid", time: { created: T0 } }, parts: [{ id: "kp", type: "text", text: "подзадача" }] }];
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_KB_ROOT: KB, ZAI_JOURNAL_DEBOUNCE_MS: "20" } });
});
after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  rmSync(TMP, { recursive: true, force: true });
});

test("FEAT-11.18: до первого хода строки о журнале нет; после конца хода журнал записан и строка появляется", async () => {
  const prompts = () => up.requests.filter((r) => r.method === "POST" && r.path === "/session/ses_j/prompt_async");
  let r = await api(`/zai/api/session/ses_j/prompt?directory=${encodeURIComponent(DIR)}`, { method: "POST", body: { parts: [{ type: "text", text: "Собери отчёт" }], model } });
  assert.ok(r.status < 300, `prompt ${r.status} ${await r.text()}`);
  await waitFor(() => prompts().length === 1, { what: "первый prompt" });
  assert.ok(!String(prompts()[0].body.system ?? "").includes("Журнал этого чата"), "журнала ещё нет — строки нет");

  up.emit({ type: "session.idle", properties: { sessionID: "ses_j" } }, DIR);
  up.emit({ type: "session.idle", properties: { sessionID: "ses_kid" } }, DIR);
  const jdir = path.join(KB, "journal");
  await waitFor(() => existsSync(jdir) && readdirSync(jdir).some((n) => n.endsWith("-ses_j.md")), { what: "журнал записан", timeoutMs: 8000 });
  const files = readdirSync(jdir);
  assert.deepEqual(files.filter((n) => n.includes("ses_kid")), [], "у дочерней сессии субагента журнала нет");
  const text = readFileSync(path.join(jdir, files.find((n) => n.endsWith("-ses_j.md"))), "utf8");
  assert.match(text, /# Журнал чата: Журнальный чат/);
  assert.match(text, /Собери отчёт/);
  assert.match(text, /Отчёт собран\./);
  assert.match(text, /report\.md/);

  r = await api(`/zai/api/session/ses_j/prompt?directory=${encodeURIComponent(DIR)}`, { method: "POST", body: { parts: [{ type: "text", text: "Дальше" }], model } });
  assert.ok(r.status < 300);
  await waitFor(() => prompts().length === 2, { what: "второй prompt" });
  const sys = String(prompts()[1].body.system ?? "");
  assert.match(sys, /Журнал этого чата/);
  assert.ok(sys.includes(`-ses_j.md`), "в строке — путь к журналу этого чата");
  assert.match(sys, /Правило портала о файлах/, "правило о файлах на месте");
});

test("FEAT-11.18: удаление чата убирает его журнал из базы знаний", async () => {
  const jdir = path.join(KB, "journal");
  assert.ok(readdirSync(jdir).some((n) => n.endsWith("-ses_j.md")), "журнал есть после предыдущего теста");
  up.route("DELETE", "/session/ses_j", () => ({ status: 200, json: true }));
  const r = await api(`/zai/api/session/ses_j?directory=${encodeURIComponent(DIR)}`, { method: "DELETE" });
  assert.ok(r.status < 300, `delete ${r.status} ${await r.text()}`);
  await waitFor(() => !readdirSync(jdir).some((n) => n.endsWith("-ses_j.md")), { what: "журнал удалён" });
});
