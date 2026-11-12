// FEAT-13.19: claude CLI stream-json → opencode-shaped parts
// (lib/claude-transcript.js). The recording is a real claude CLI 2.1.316 run
// (Read + two Bash calls, one failing; thinking summaries on), scrubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeTranscript, OUTPUT_CAP, clip, resultText, toolName } from "../lib/claude-transcript.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDING = readFileSync(path.join(HERE, "fixtures", "claude-stream-2.1.316.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const make = () => {
  let n = 0;
  let t = 1000;
  return new ClaudeTranscript({ sessionID: "s1", messageID: "a1", newId: () => `p${++n}`, now: () => (t += 10) });
};

// Replays ops the way the client does (upsertPart / applyDelta / removed).
function replay(ops, parts = []) {
  for (const op of ops) {
    if (op.op === "updated") {
      const i = parts.findIndex((p) => p.id === op.part.id);
      if (i < 0) parts.push(structuredClone(op.part));
      else parts[i] = { ...parts[i], ...structuredClone(op.part) };
    } else if (op.op === "delta") {
      const p = parts.find((x) => x.id === op.partID);
      assert.ok(p, `delta for an unknown part ${op.partID}`);
      p[op.field] = (p[op.field] ?? "") + op.delta;
    } else if (op.op === "removed") {
      parts.splice(parts.findIndex((p) => p.id === op.partID), 1);
    }
  }
  return parts;
}

test("toolName maps CLI tools to opencode names; MCP names stay", () => {
  assert.equal(toolName("Bash"), "bash");
  assert.equal(toolName("PowerShell"), "bash");
  assert.equal(toolName("Read"), "read");
  assert.equal(toolName("MultiEdit"), "edit");
  assert.equal(toolName("LS"), "list");
  assert.equal(toolName("WebSearch"), "websearch");
  assert.equal(toolName("TodoWrite"), "todowrite");
  assert.equal(toolName("Task"), "task");
  assert.equal(toolName("Agent"), "task");
  assert.equal(toolName("mcp__playwright__browser_click"), "mcp__playwright__browser_click");
  assert.equal(toolName(""), "tool");
});

test("resultText / clip: text blocks joined, pictures never kept, long output cut with a note", () => {
  assert.equal(resultText("ok"), "ok");
  assert.equal(resultText([{ type: "text", text: "a" }, { type: "image", source: { data: "AAAA" } }, { type: "text", text: "b" }]), "a\n[изображение]\nb");
  const long = "x".repeat(OUTPUT_CAP + 5);
  const c = clip(long, OUTPUT_CAP);
  assert.ok(c.startsWith("x".repeat(OUTPUT_CAP)));
  assert.match(c, /обрезано: ещё 5 симв\./);
});

test("real CLI 2.1.316 recording: steps, thinking summary, read/bash cards, failing bash, answer text (FEAT-13.19 а–г)", () => {
  const tr = make();
  const ops = [];
  for (const evt of RECORDING) ops.push(...tr.feed(evt));
  ops.push(...tr.finish());
  const live = replay(ops);
  const stored = tr.parts();
  // what the client built live equals what the history stores
  assert.deepEqual(live.filter((p) => p.type !== "text" || p.text.trim()), stored);

  const types = stored.map((p) => p.type);
  assert.ok(types.filter((t) => t === "step-start").length >= 2, "one step-start per model message");
  assert.equal(types[0], "step-start");

  const reasoning = stored.filter((p) => p.type === "reasoning");
  assert.ok(reasoning.length >= 1);
  assert.match(reasoning[0].text, /a\.txt/, "thinking summary text streamed");
  for (const r of reasoning) assert.ok(r.time.end >= r.time.start, "reasoning closed");

  const tools = stored.filter((p) => p.type === "tool");
  assert.deepEqual(tools.map((t) => t.tool), ["read", "bash", "bash"]);
  const [read, echo, fail] = tools;
  assert.equal(read.state.status, "completed");
  assert.match(read.state.input.file_path, /a\.txt$/);
  assert.match(read.state.output, /hello/);
  assert.equal(echo.state.status, "completed");
  assert.equal(echo.state.input.command, "echo 42");
  assert.match(echo.state.output, /42/);
  assert.equal(fail.state.status, "error");
  assert.match(fail.state.output, /Exit code 3/);
  for (const t of tools) {
    assert.ok(t.callID?.startsWith("toolu_"));
    assert.ok(t.state.time.end >= t.state.time.start);
    assert.equal(t.sessionID, "s1");
    assert.equal(t.messageID, "a1");
  }
  // parts are in the order the model produced them: the final text comes last
  const lastTool = types.lastIndexOf("tool");
  assert.ok(types.slice(lastTool).includes("text"), "the answer follows the tool calls");
  assert.ok(tr.text().length > 0);
  const result = RECORDING.find((e) => e.type === "result");
  assert.ok(tr.text().includes(result.result.trim().slice(0, 20)), "answer text = what the CLI reported");
});

test("subagent traffic (parent_tool_use_id) never becomes separate parts; the Task call is one agent card (FEAT-13.19 в, FEAT-01.77)", () => {
  const tr = make();
  const ops = [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_t", name: "Task", input: {} } } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_t", name: "Task", input: { description: "Найти тесты", subagent_type: "Explore", prompt: "..." } }] } },
    { type: "assistant", parent_tool_use_id: "toolu_t", message: { id: "sub", content: [{ type: "text", text: "SUBAGENT" }, { type: "tool_use", id: "toolu_s", name: "Grep", input: {} }] } },
    { type: "user", parent_tool_use_id: "toolu_t", message: { content: [{ type: "tool_result", tool_use_id: "toolu_s", content: "x" }] } },
    { type: "stream_event", parent_tool_use_id: "toolu_t", event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUB" } } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_t", content: [{ type: "text", text: "Нашёл 3 файла" }] }] } },
  ].flatMap((e) => tr.feed(e));
  const parts = replay(ops);
  assert.deepEqual(parts.map((p) => p.type), ["step-start", "tool"]);
  const task = parts[1];
  assert.equal(task.tool, "task");
  assert.equal(task.state.status, "completed");
  assert.equal(task.state.title, "Найти тесты");
  assert.equal(task.state.input.subagent_type, "Explore");
  assert.equal(task.state.output, "Нашёл 3 файла");
  // FEAT-01.77: трафик субагента достраивает zaiRun части Task (шаги, ответ),
  // но отдельными частями и в тексте основной беседы не появляется
  const z = task.state.metadata.zaiRun;
  assert.deepEqual(z.steps.map((s) => [s.tool, s.status]), [["grep", "done"]]);
  assert.equal(z.output, "SUBAGENT");
  assert.equal(JSON.stringify(parts.filter((p) => p.type !== "tool")).includes("SUB"), false, "текст субагента не становится частью ответа");
  assert.equal(tr.text().includes("SUBAGENT"), false);
});

test("finish(): open tool → error, open reasoning closed (stop mid-call, FEAT-13.19 е)", () => {
  const tr = make();
  const ops = [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Думаю…" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_b", name: "Bash", input: {} } } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "sleep 100" } }] } },
  ].flatMap((e) => tr.feed(e));
  assert.equal(replay(ops).find((p) => p.type === "tool").state.status, "running");
  const closing = tr.finish();
  const parts = replay([...ops, ...closing]);
  const tool = parts.find((p) => p.type === "tool");
  assert.equal(tool.state.status, "error");
  assert.ok(tool.state.time.end);
  assert.ok(parts.find((p) => p.type === "reasoning").time.end);
  assert.equal(tr.hasText(), false);
  const mark = tr.addText("[Прервано]");
  assert.equal(mark.part.type, "text");
  assert.equal(tr.parts().at(-1).text, "[Прервано]");
});

test("dropText(): an error result replaces the answer text, tool cards stay", () => {
  const tr = make();
  tr.feed({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "частичный ответ" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }] } });
  const removed = tr.dropText();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].op, "removed");
  tr.addText("Claude вернул ошибку");
  assert.deepEqual(tr.parts().map((p) => p.type), ["step-start", "tool", "text"]);
  assert.equal(tr.text(), "Claude вернул ошибку");
});

test("text without block events (older CLI / fake): deltas join, the authoritative text wins, re-sent text ignored (BUG-13.8)", () => {
  const tr = make();
  const ops = [
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Привет," } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "мир!" } } },
    { type: "assistant", message: { content: [{ type: "text", text: "Привет, мир!" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Привет, мир!" }] } },
  ].flatMap((e) => tr.feed(e));
  const parts = replay(ops);
  assert.deepEqual(parts.map((p) => [p.type, p.text]), [["text", "Привет, мир!"]]);

  // two model messages with a tool between: both texts kept, in order
  const t2 = make();
  [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "шаг 1" } } },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "шаг 1" }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "stream_event", event: { type: "message_start", message: { id: "m2" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "шаг 2" } } },
    { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "шаг 2" }] } },
  ].forEach((e) => t2.feed(e));
  assert.deepEqual(t2.parts().map((p) => p.type), ["step-start", "text", "tool", "step-start", "text"]);
  assert.equal(t2.text(), "шаг 1\n\nшаг 2");
  assert.equal(t2.parts()[2].state.status, "completed");
});

test("long tool input/output are clipped for the history (FEAT-13.19 б)", () => {
  const tr = make();
  tr.feed({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "D:\\w\\a.txt", content: "y".repeat(10_000) } }] } });
  tr.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(OUTPUT_CAP * 2) }] } });
  const tool = tr.parts().find((p) => p.type === "tool");
  assert.equal(tool.tool, "write");
  assert.ok(tool.state.input.content.length < 4_100);
  assert.ok(tool.state.output.length < OUTPUT_CAP + 100);
  assert.equal(tool.state.input.file_path, "D:\\w\\a.txt");
});
