// FEAT-20.4 — локальная ACP-фикстура, без сети.
import readline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
if (process.argv.includes("--device-code")) process.exit(0);
let workspaceRoots;
let loaded = false;
let modelId = "default";
let seenMcpServers = [];
let waiting;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (id === "ask-test" && waiting) {
    send({
      method: "session/update",
      params: {
        sessionId: "s-test",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.outcome.outcome } },
      },
    });
    send({ id: waiting, result: { stopReason: "end_turn" } });
    continue;
  }
  if (method === "initialize")
    send({
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "oauth-personal" }] },
    });
  if (method === "session/new" || method === "session/load") workspaceRoots = params.additionalDirectories;
  if (method === "authenticate") send({ id, result: {} });
  if (method === "session/new") { seenMcpServers = params?.mcpServers ?? []; send({ id, result: { sessionId: "s-test" } }); }
  if (method === "session/load") {
    if (params.sessionId === "missing") send({ id, error: { code: -32602, message: "unknown session" } });
    else {
      loaded = true;
      seenMcpServers = params?.mcpServers ?? [];
      send({ id, result: {} });
    }
  }
  if (method === "session/set_model") { modelId = params.modelId; send({ id, result: {} }); }
  if (method === "session/prompt") {
    if (params.prompt[0].text === "workspace-roots") {
      send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(workspaceRoots ?? null) } } } });
    }
    if (params.prompt[0].text === "selected-model") send({method:"session/update",params:{sessionId:params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:modelId}}}});
    if (params.prompt[0].text === "mcp-servers") send({method:"session/update",params:{sessionId:params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:JSON.stringify(seenMcpServers)}}}});
    if (params.prompt[0].text === "wait") continue;
    if (params.prompt[0].text === "ask") {
      waiting = id;
      send({
        id: "ask-test",
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: { kind: "read", title: "Прочитать файл" },
          options: [{ kind: "allow_once", optionId: "once" }],
        },
      });
      continue;
    }
    if (params.prompt[0].text === "tools") {
      const update = (payload) => send({ method: "session/update", params: { sessionId: "s-test", update: payload } });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "Прочитать файл",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "README.md" },
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Файл прочитан" } }],
      });
    }
    if (params.prompt[0].text === "history:user-message")
      send({
        method: "session/update",
        params: {
          sessionId: "s-test",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "context received" } },
        },
      });
    for (const text of ["one", loaded ? " resumed" : " two"])
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    send({ id, result: { stopReason: "end_turn" } });
  }
}
