// FEAT-20.4 / BUG-291 / BUG-292 — адаптер stream-json общего раннера чата к ACP v1.
import { readFileSync, statSync } from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { effectivePermMode } from "./binding.js";
import { antigravitySessionHasStaleSteps, loadAcpMcpServers, normalizeAcpTool, runAcpChat, tenantAcpToolAllowed } from "./acp-chat.js";
import { acpProfileDir, launchAcpChat } from "./acp-login-launch.js";
import { killChildTree } from "./proc.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const event = (value) => output({ type: "stream_event", event: value });
let child;
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
const lines = readline.createInterface({ input: process.stdin });
const input = lines[Symbol.asyncIterator]();
const decisions = new Map();

function loadTurnImages(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = [];
  for (const item of list) {
    if (typeof item?.path !== "string" || !item.path || typeof item?.mimeType !== "string" || !item.mimeType.startsWith("image/")) continue;
    try {
      const st = statSync(item.path);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) continue;
      out.push({ data: readFileSync(item.path).toString("base64"), mimeType: item.mimeType });
    } catch {}
  }
  return out;
}

async function readDecisions() {
  for await (const line of input) {
    const reply = JSON.parse(line).response;
    const resolve = decisions.get(reply?.request_id);
    if (resolve) {
      decisions.delete(reply.request_id);
      resolve(reply?.response?.behavior === "allow");
    }
  }
  for (const resolve of decisions.values()) resolve(false);
  decisions.clear();
}

try {
  const first = await input.next();
  const turn = JSON.parse(first.value);
  // ClaudeRunner admits only authenticated admin turns to the ACP shim.
  const rawMode = turn.mode ?? effectivePermMode(null, { admin: turn.admin === true });
  const mode = rawMode === "edits" ? "ask" : rawMode;
  readDecisions().catch(() => abort.abort());
  child = launchAcpChat(turn.dataDir, turn.owner, turn.agent, process.cwd());
  let text = "";
  let textOpen = false;
  let textSeq = 0;
  const openText = () => {
    if (textOpen) return;
    textOpen = true;
    event({ type: "message_start", message: { id: "acp-text-" + ++textSeq, role: "assistant", content: [] } });
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  };
  const closeText = () => {
    if (!textOpen) return;
    textOpen = false;
    event({ type: "content_block_stop", index: 0 });
  };
  const tools = new Map();
  let acpSessionId = null;
  const images = loadTurnImages(turn.images);
  // FEAT-20.21: MCP-серверы портала пробрасываются в ACP только для администратора.
  const mcpServers = turn.admin === true && turn.mcpConfig ? loadAcpMcpServers(turn.mcpConfig) : [];
  // BUG-298: защита от «отравленной» SQLite-БД Antigravity с застрявшим активным шагом.
  let resume = turn.resume;
  if (resume && turn.agent === "antigravity" && turn.dataDir && turn.owner) {
    const profileDir = acpProfileDir(turn.dataDir, turn.owner, turn.agent);
    if (antigravitySessionHasStaleSteps(profileDir, resume)) {
      process.stderr.write(`[teleharness-acp] BUG-298: skipping session/load for stale Antigravity session ${resume}\n`);
      resume = null;
    }
  }
  const result = await runAcpChat(child, {
    signal: abort.signal,
    cwd: process.cwd(),
    prompt: turn.prompt,
    images,
    mcpServers,
    modelId: turn.modelId,
    resume,
    context: turn.context,
    onPermission(tool) {
      if (mode === "plan" || mode === "plan-ro") return false;
      if (turn.admin !== true && !tenantAcpToolAllowed(tool, process.cwd())) return false;
      if (mode === "full" || turn.nonInteractive === true) return true;
      const request_id = randomUUID();
      return new Promise((resolve) => {
        decisions.set(request_id, resolve);
        output({
          type: "control_request",
          request_id,
          request: {
            subtype: "can_use_tool",
            tool_name: tool.kind ?? "tool",
            description: tool.title ?? "Действие агента",
            input: tool.rawInput ?? {},
          },
        });
      });
    },
    onSession(sessionId) {
      acpSessionId = sessionId;
      output({ type: "system", subtype: "init", session_id: sessionId });
    },
    onPlan(entries) {
      output({ type: "system", subtype: "plan", session_id: acpSessionId ?? null, todos: entries });
    },
    onTool(update) {
      closeText();
      const id = update.toolCallId;
      let meta = tools.get(id);
      if (!meta) {
        const info = normalizeAcpTool(update);
        meta = { isSubagent: info.isSubagent, done: false };
        tools.set(id, meta);
        output({
          type: "assistant",
          message: {
            id: "acp-tool-" + id,
            role: "assistant",
            content: [{ type: "tool_use", id, name: info.name, input: info.input }],
          },
        });
        if (info.isSubagent) {
          output({ type: "system", subtype: "task_started", task_id: id, tool_use_id: id, description: info.description });
        }
      }
      if (update.status === "completed" || update.status === "failed") {
        const content = (update.content ?? [])
          .map((item) => item.content?.text ?? (item.type === "diff" ? (item.newText ?? "") : ""))
          .filter(Boolean)
          .join("\n") || (typeof update.rawOutput === "string" ? update.rawOutput : update.rawOutput?.formatted_output ?? "");
        output({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content, is_error: update.status === "failed" }],
          },
        });
        if (meta.isSubagent && update.status === "failed") {
          meta.done = true;
          output({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: id, status: "failed" });
        }
      }
    },
    onText(chunk) {
      openText();
      text += chunk;
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
    },
  });
  closeText();
  for (const [id, meta] of tools) {
    if (meta.isSubagent && !meta.done) {
      meta.done = true;
      output({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: id, status: "completed" });
    }
  }
  output({ type: "result", subtype: "success", is_error: false, result: text, session_id: result.sessionId });
} catch (error) {
  if (!abort.signal.aborted) {
    output({ type: "result", subtype: "error_during_execution", is_error: true, result: error.message });
  }
} finally {
  if (child) killChildTree(child);
  lines.close();
  process.stdin.destroy();
}
