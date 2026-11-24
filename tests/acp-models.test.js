// BUG-303 / TASK-14.21 — тесты discoverAcpModels: кэш, force:true, ошибки и таймаут.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentEntry } from "../lib/acp-registry.js";
import { discoverAcpModels, cachedAcpModels } from "../lib/acp-models.js";

function fakeAgentSource({ modeFile, countFile }) {
  return `
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const modePath = ${JSON.stringify(modeFile)};
const countPath = ${JSON.stringify(countFile)};
let n = 0;
try { n = Number(readFileSync(countPath, "utf8")) || 0; } catch {}
writeFileSync(countPath, String(n + 1));
const mode = (() => { try { return readFileSync(modePath, "utf8").trim(); } catch { return "v1"; } })();
if (mode === "crash") process.exit(1);
if (mode === "hang") { setInterval(() => {}, 10000); }
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (mode === "hang") continue;
  const { id, method } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: mode === "v2" } } } });
  } else if (method === "session/new") {
    const models = mode === "v2"
      ? { currentModelId: "m-v2", availableModels: [{ modelId: "m-v1", name: "V1" }, { modelId: "m-v2", name: "V2" }] }
      : { currentModelId: "m-v1", availableModels: [{ modelId: "m-v1", name: "V1" }] };
    send({ id, result: { sessionId: "s1", models } });
  }
}
`;
}

test("discoverAcpModels кэширует модели и обновляет их только при force: true", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-models-test-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const modeFile = path.join(dir, "mode.txt");
  const countFile = path.join(dir, "count.txt");
  const cli = agentEntry(dir, "github-copilot-cli");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, fakeAgentSource({ modeFile, countFile }), "utf8");
  await writeFile(modeFile, "v1", "utf8");

  const first = await discoverAcpModels(dir, "admin", "github-copilot-cli");
  assert.deepEqual(first?.availableModels, [{ modelId: "m-v1", name: "V1" }]);
  assert.equal(first?.promptCapabilities?.image, false);
  assert.equal(Number(await readFile(countFile, "utf8")), 1);
  assert.deepEqual(cachedAcpModels(dir, "admin", "github-copilot-cli")?.availableModels, [{ modelId: "m-v1", name: "V1" }]);

  // Меняем ответ агента, но без force должен вернуться свежий кэш без запуска процесса
  await writeFile(modeFile, "v2", "utf8");
  const second = await discoverAcpModels(dir, "admin", "github-copilot-cli");
  assert.deepEqual(second?.availableModels, [{ modelId: "m-v1", name: "V1" }]);
  assert.equal(Number(await readFile(countFile, "utf8")), 1);

  // С force: true обязан реально перечитать модели и обновить кэш
  const forced = await discoverAcpModels(dir, "admin", "github-copilot-cli", { force: true });
  assert.deepEqual(forced?.availableModels, [{ modelId: "m-v1", name: "V1" }, { modelId: "m-v2", name: "V2" }]);
  assert.equal(forced?.promptCapabilities?.image, true);
  assert.equal(Number(await readFile(countFile, "utf8")), 2);
  assert.deepEqual(cachedAcpModels(dir, "admin", "github-copilot-cli")?.availableModels, [
    { modelId: "m-v1", name: "V1" },
    { modelId: "m-v2", name: "V2" },
  ]);
});

test("discoverAcpModels при ошибке или таймауте возвращает кэш (или null без кэша)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-models-err-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const modeFile = path.join(dir, "mode.txt");
  const countFile = path.join(dir, "count.txt");
  const cli = agentEntry(dir, "github-copilot-cli");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, fakeAgentSource({ modeFile, countFile }), "utf8");

  // Без кэша: падение процесса -> null
  await writeFile(modeFile, "crash", "utf8");
  const coldErr = await discoverAcpModels(dir, "admin", "github-copilot-cli");
  assert.equal(coldErr, null);

  // Заполняем кэш валидным ответом
  await writeFile(modeFile, "v1", "utf8");
  const ok = await discoverAcpModels(dir, "admin", "github-copilot-cli", { force: true });
  assert.equal(ok?.availableModels?.[0]?.modelId, "m-v1");

  // Падение при force: true -> откат на кэш
  await writeFile(modeFile, "crash", "utf8");
  const errWithCache = await discoverAcpModels(dir, "admin", "github-copilot-cli", { force: true });
  assert.equal(errWithCache?.availableModels?.[0]?.modelId, "m-v1");
  assert.equal(Number(await readFile(countFile, "utf8")), 3);

  // Таймаут при force: true -> откат на кэш и завершение процесса
  await writeFile(modeFile, "hang", "utf8");
  const timeoutWithCache = await discoverAcpModels(dir, "admin", "github-copilot-cli", { force: true, timeoutMs: 150 });
  assert.equal(timeoutWithCache?.availableModels?.[0]?.modelId, "m-v1");
  assert.equal(Number(await readFile(countFile, "utf8")), 4);
});
