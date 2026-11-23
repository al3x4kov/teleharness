// FEAT-20.37 — ACP-фикстура плана хода: session/update {sessionUpdate:"plan"}
// с entries по схеме ACP [{content, priority, status}], плюс кривые entries.
import readline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  const { id, method, params } = msg;
  if (method === "initialize")
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
  if (method === "authenticate") send({ id, result: {} });
  if (method === "session/new") send({ id, result: { sessionId: "s-plan" } });
  if (method === "session/prompt") {
    const text = params.prompt?.[0]?.text ?? "";
    const upd = (update) => send({ method: "session/update", params: { sessionId: "s-plan", update } });
    if (text === "plan")
      upd({
        sessionUpdate: "plan",
        entries: [
          { content: "Прочитать файл", priority: "high", status: "completed" },
          { content: "Починить", priority: "medium", status: "in_progress" },
          { content: "Проверить", priority: "low", status: "pending" },
        ],
      });
    // entries НЕ массив — слой ACP не должен звать onPlan
    if (text === "plan-no-entries") upd({ sessionUpdate: "plan", entries: "мусор" });
    // мусорный статус — транспорт отдаёт entries как есть (нормализует раннер/хаб)
    if (text === "plan-junk-status") upd({ sessionUpdate: "plan", entries: [{ content: "Шаг", status: "unknown" }] });
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "готово" } });
    send({ id, result: { stopReason: "end_turn" } });
  }
}
