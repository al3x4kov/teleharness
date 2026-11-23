// FEAT-20.37 — фикстура claude CLI для tests/claude-plan.test.js: кадры
// tool_use TodoWrite и служебный system/plan в потоке stream-json.
// Спавнится раннером как `node claude-plan-fake.mjs <args>`, промпт — на stdin.
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sid = `plan-${process.pid}`;
const line = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
// Раннер зовёт CLI в stream-json (первая строка stdin — {"type":"user",…},
// stdin открыт до result); text-режим оставлен для ручных прогонов.
const streamIn = flagValue("--input-format") === "stream-json";
let started = false;
let inBuf = "";
let textChunks = [];
const onStdinEnd = () => {
  if (started) return;
  started = true;
  main(Buffer.concat(textChunks).toString("utf8"));
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  if (!streamIn) {
    textChunks.push(Buffer.from(c, "utf8"));
    return;
  }
  inBuf += c;
  let nl;
  while ((nl = inBuf.indexOf("\n")) >= 0) {
    const l = inBuf.slice(0, nl).trim();
    inBuf = inBuf.slice(nl + 1);
    if (!l || started) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === "user") {
      started = true;
      const c0 = o.message?.content;
      main(typeof c0 === "string" ? c0 : Array.isArray(c0) ? c0.map((b) => b?.text ?? "").join("") : "");
    }
  }
});
process.stdin.on("end", onStdinEnd);

function main(prompt) {
  if (!argv.includes("-p") || !["text", "stream-json"].includes(flagValue("--input-format"))) {
    process.stderr.write("fake: expected -p --input-format text|stream-json\n");
    process.exit(2);
  }
  if (flagValue("--output-format") === "text") {
    // режим генератора заголовков — простой текст
    process.stdout.write(`Заголовок: «План ${prompt.split(/\s+/).slice(0, 3).join(" ")}»\n`);
    process.exit(0);
  }
  line({ type: "system", subtype: "init", session_id: sid });
  // TodoWrite самого CLI: план хода из input.todos (мусорный статус → pending)
  if (prompt.includes("TODOWRITE")) {
    line({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "TodoWrite",
            input: {
              todos: [
                { id: 1, content: "Разобраться", status: "completed" },
                { id: 2, content: "Починить", status: "in_progress" },
                { content: "Проверить", status: "weird" },
              ],
            },
          },
        ],
      },
    });
  }
  // повторный todowrite в одном ходе — план просто перезаписывается
  if (prompt.includes("TODOBAD")) {
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: [{ content: "Шаг", status: "unknown" }] } }] } });
    line({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "tu2", name: "todowrite", input: { todos: [{ id: "a", content: "Финал", status: "completed" }] } }] } });
  }
  // план СУБАГЕНТА (parent_tool_use_id) — в план главного хода не попадает
  if (prompt.includes("PLANSUB")) {
    line({ type: "system", subtype: "plan", parent_tool_use_id: "tu9", todos: [{ content: "Чужой шаг", status: "pending" }] });
  }
  // служебный кадр ACP-шима — план хода основного разговора
  if (prompt.includes("PLANFRAME")) {
    line({
      type: "system",
      subtype: "plan",
      session_id: sid,
      todos: [
        { content: "Кадр 1", status: "in_progress" },
        { content: "Кадр 2", status: "completed" },
      ],
    });
  }
  line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: "готово", used_model: "claude-haiku-4-5" });
  process.exit(0);
}
