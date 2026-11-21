#!/usr/bin/env node
// FEAT-20.4 — фейковый Antigravity ACP-сервер (binary-поставка), без сети
// наружу: initialize/authMethods, authenticate печатает ссылку Google в
// stderr и слушает loopback-редирект; GET с code/state завершает вход.
// Ходовая часть повторяет tests/fixtures/acp-chat-agent.mjs.
import readline from "node:readline";
import http from "node:http";

const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let loaded = false;
let selected;
let waiting;
let authPending = null;

const relay = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body>Authentication successful</body></html>");
  if (authPending && url.searchParams.get("code")) {
    send({ id: authPending, result: {} });
    authPending = null;
  }
});
relay.listen(0, "127.0.0.1", () => {
  const port = relay.address().port;
  process.stderr.write(
    `Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake.apps.googleusercontent.com&redirect_uri=${encodeURIComponent("http://127.0.0.1:" + port + "/")}&state=fake-state\n`,
  );
});

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
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }] },
    });
  if (method === "authenticate") authPending = id; // ждёт релейный GET с code/state
  if (method === "session/new") send({ id, result: { sessionId: "s-test", models: { currentModelId: "neon-test", availableModels: [{modelId:"neon-test",name:"Gemini 4 Neon"}] } } });
  if (method === "session/load") {
    if (params.sessionId === "missing") send({ id, error: { code: -32602, message: "unknown session" } });
    else {
      loaded = true;
      send({ id, result: {} });
    }
  }
  if (method === "session/set_model") { selected=params.modelId; send({id,result:{}}); }
  if (method === "session/prompt") {
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
    for (const text of [selected || "one", loaded ? " resumed" : " two"])
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
