// FEAT-13.19: a Claude turn renders step by step like an opencode turn. The
// parts come from the REAL server translation (lib/claude-transcript.js) of a
// recorded claude CLI 2.1.316 stream, then MessageBubble renders them — the
// whole server → client path without a browser.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";
import { ClaudeTranscript } from "../../lib/claude-transcript.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDING = readFileSync(path.join(HERE, "..", "fixtures", "claude-stream-2.1.316.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let ui, t$;
before(async () => {
  ui = await loadUI({
    ToolCard: "src/components/chat/ToolCard.jsx",
    MessageBubble: "src/components/chat/MessageBubble.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.setActiveId(null);
  installFetch();
});

const SID = "ses_cl";
const DIR = "D:\\work";
const NOW = Date.now();

function claudeAnswer(events) {
  let n = 0;
  const tr = new ClaudeTranscript({ sessionID: SID, messageID: "msgc_a1", newId: () => `prt_${++n}` });
  for (const e of events) tr.feed(e);
  tr.finish();
  return {
    info: { id: "msgc_a1", sessionID: SID, role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: NOW, completed: NOW + 5000 } },
    parts: tr.parts(),
  };
}

test("FEAT-13.19: записанный Claude-ход — «Думал», карточки «Чтение файла» и «Команда», «Шаг 2», текст ответа", () => {
  ui.store.me.value = { id: "u_a", name: "Админ", role: "admin" };
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const msg = claudeAnswer(RECORDING);
  const { root } = t$.mount(ui.MessageBubble, { msg });

  const heads = $$(root, ".reasoning-head").map((b) => b.textContent);
  assert.ok(heads.length >= 1, "размышления видны");
  assert.ok(heads.every((h) => /^Думал \d+с/.test(h)), heads.join(" | "));

  const cards = $$(root, ".tool-card");
  assert.equal(cards.length, 3);
  const names = cards.map((c) => $(c, ".tool-name").textContent);
  assert.equal(names[0], "Чтение файла · a.txt");
  assert.match(names[1], /^Команда · /);
  assert.match(names[2], /^Команда · /);
  assert.ok(cards[0].classList.contains("st-completed"));
  assert.ok(cards[2].classList.contains("st-error"), "упавшая команда — красный статус");
  assert.ok($(cards[2], "details").open, "карточка с ошибкой раскрыта");
  assert.match($(cards[1], ".tool-cmdline").textContent, /echo 42/);
  assert.match($(cards[1], ".tool-output").textContent, /42/);

  const steps = $$(root, ".step-label").map((s) => s.textContent);
  assert.ok(steps.includes("Шаг 2"), steps.join(","));
  assert.ok(root.textContent.includes(RECORDING.find((e) => e.type === "result").result.trim().slice(0, 15)));
});

test("FEAT-13.19: WebSearch и подагент Task — «Поиск в интернете» и карточка агента", () => {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const msg = claudeAnswer([
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "preact signals" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "3 results" }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t2", name: "Task", input: { description: "Найти тесты", subagent_type: "Explore", prompt: "…" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Нашёл 3 файла" }] }] } },
  ]);
  const { root } = t$.mount(ui.MessageBubble, { msg });
  const names = $$(root, ".tool-name").map((x) => x.textContent);
  assert.ok(names.some((n) => n.startsWith("Поиск в интернете")), names.join(" | "));
  assert.ok(root.textContent.includes("Explore"), "карточка агента с его типом");
  assert.ok(root.textContent.includes("Найти тесты"));
});

test("FEAT-13.19 з / BUG-13.15: картинка, записанная Claude (Write), получает превью в ответе", () => {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  const file = `${DIR}\\chart.png`;
  const msg = claudeAnswer([
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: file, content: "…" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "File created" }] } },
    { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Готово." }] } },
  ]);
  const { root } = t$.mount(ui.MessageBubble, { msg });
  const fig = $(root, ".file-card.is-image");
  assert.ok(fig, "есть карточка с превью");
  const src = new URL($(fig, ".fc-tile img").getAttribute("src"), "https://zai.test");
  assert.equal(src.searchParams.get("path"), file);
});
