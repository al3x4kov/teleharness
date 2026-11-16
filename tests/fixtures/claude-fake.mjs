// Test fixture: a claude CLI stand-in for the portal runner tests. Spawned
// as `node claude-fake.mjs <runner args>`; the PROMPT ARRIVES ON STDIN (UTF-8,
// then EOF) like the real `claude -p --input-format text`. Emits canned
// stream-json on stdout. Contract mirrors the real CLI shapes the runner
// consumes.
//   - "--resume <id>" present → session_id echoes it with a "resumed-" prefix
//     and every text chunk carries "(resumed)" (lets tests assert the flag).
//   - prompt contains "HANG"  → emits init and stays alive (abort/idle paths).
//   - prompt contains "FAIL"  → result.is_error=true, result="boom".
//   - prompt contains "LIMIT" → result.is_error=true with the CLI's subscription
//                               limit text (FEAT-18.6 auto-relay); "LIMITTEXT" —
//                               the same text as a plain answer, is_error=false.
//   - prompt contains "ECHO"  → answers with the prompt and argv as JSON
//                               ({prompt, argv, envKeys}).
//   - prompt contains "MULTI" → two assistant messages with a tool call in
//                               between (multi-step answer).
//   - prompt contains "TOOLS" → real-CLI-like turn (FEAT-13.19): thinking
//                               summary, a PowerShell call with its result,
//                               then the answer text.
//   - prompt contains "SLOW"  → a delta every 100 ms for ~1 s, then done.
//   - prompt contains "WAIT"  → answers after 1.5 s (queue tests).
//   - "BGTAIL<ms>" [+ "BGROUND"] → after `result` stays alive <ms> (a background
//     task of the agent), optionally one more round of its own (BUG-184).
// FEAT-01.57 / FEAT-01.58 (only with CLAUDE_CONFIG_DIR set — never touches
// the real ~/.claude):
//   - every turn appends its prompt and answer to the transcript
//     <CLAUDE_CONFIG_DIR>/projects/<slug cwd>/<session id>.jsonl, starting
//     from the --resume file's content (like the real CLI);
//   - "--fork-session" with --resume → a NEW session id ("fork-<pid>");
//   - prompt contains "HISTORY" → answers with the JSON list of the earlier
//     prompts this session remembers (from the resumed transcript);
//   - "WRITEFILE <name> <text>" / "EDITFILE <name> <text>" → runs the
//     PreToolUse hooks of --settings (matcher vs Write / Edit, payload on
//     stdin like the real CLI), then writes <text> into <cwd>/<name>.
// FEAT-18.4 (permission bridge, shapes of the spike on claude 2.1.322):
//   - "--input-format stream-json" → the prompt is the first stdin line
//     {"type":"user","message":{"role":"user","content":"…"}}; stdin stays
//     open, later lines are control_response; after `result` the fake exits
//     when stdin closes (like the real CLI);
//   - "ASKWRITE <name> <text>" → with "--permission-prompt-tool stdio" sends
//     control_request can_use_tool {tool_name:"Write", input:{file_path,
//     content}} and waits: allow → writes the file (updatedInput), deny →
//     answers «Отказано: <message>»; without the flag → auto-denied.
//   - "ASKTWICE" with ASKWRITE → a second request after the first answer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const model = flagValue("--model") ?? "unknown";
const resume = flagValue("--resume");
const suffix = resume ? " (resumed)" : "";
const fork = Boolean(resume && argv.includes("--fork-session"));
const sid = fork ? `fork-${process.pid}` : resume ? `resumed-${resume}` : `fresh-${process.pid}`;

// --- transcript (FEAT-01.57) ---
const projDir = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-")) : null;
const resumedText = projDir && resume && existsSync(path.join(projDir, `${resume}.jsonl`)) ? readFileSync(path.join(projDir, `${resume}.jsonl`), "utf8") : "";
const remembered = resumedText
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((e) => e?.type === "user" && typeof e.message?.content === "string")
  .map((e) => e.message.content);
function saveTranscript(prompt, answer) {
  if (!projDir) return;
  mkdirSync(projDir, { recursive: true });
  const t = (o) => JSON.stringify({ ...o, sessionId: sid }) + "\n";
  writeFileSync(
    path.join(projDir, `${sid}.jsonl`),
    resumedText +
      t({ type: "queue-operation", operation: "enqueue" }) +
      t({ type: "user", message: { role: "user", content: prompt } }) +
      t({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) +
      t({ type: "last-prompt" }),
  );
}

// --- PreToolUse hooks of --settings (FEAT-01.58) ---
function runHooks(tool, filePath) {
  let settings = {};
  try {
    settings = JSON.parse(flagValue("--settings") ?? "{}");
  } catch {}
  for (const group of settings.hooks?.PreToolUse ?? []) {
    if (group.matcher && !new RegExp(`^(?:${group.matcher})$`).test(tool)) continue;
    for (const h of group.hooks ?? []) {
      if (h.type !== "command") continue;
      spawnSync(h.command, { shell: true, input: JSON.stringify({ session_id: sid, cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: filePath } }), windowsHide: true });
    }
  }
}
const line = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
// Exit only after stdout is flushed: on POSIX a stdout pipe is asynchronous
// and a bare process.exit() drops whatever is still queued past the pipe
// buffer (~64K) — a 100K ECHO answer lost its `result` line on Linux/macOS.
// The callback of an empty write fires once every earlier chunk is written.
const exit = (code) => {
  process.stdout.write("", () => process.exit(code));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delta = (text, extra = {}) => line({ type: "stream_event", ...extra, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

const streamIn = flagValue("--input-format") === "stream-json";
const chunks = [];
// FEAT-18.4: stream-json input — line by line; control responses resolve waiters.
const waiters = new Map(); // request_id → resolve(response)
let stdinEnded = false;
const onStdinEnd = [];
if (streamIn) {
  let inBuf = "";
  let started = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    inBuf += c;
    let nl;
    while ((nl = inBuf.indexOf("\n")) >= 0) {
      const l = inBuf.slice(0, nl).trim();
      inBuf = inBuf.slice(nl + 1);
      if (!l) continue;
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o.type === "user" && !started) {
        started = true;
        const c0 = o.message?.content;
        main(typeof c0 === "string" ? c0 : Array.isArray(c0) ? c0.map((b) => b?.text ?? "").join("") : "");
      } else if (o.type === "control_response") {
        const r = o.response ?? {};
        const w = waiters.get(r.request_id);
        if (w) {
          waiters.delete(r.request_id);
          w(r);
        }
      }
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    for (const fn of onStdinEnd.splice(0)) fn();
    // stdin closed with requests open (a stop) — nothing to wait for
    if (!started) process.exit(0);
  });
} else {
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => main(Buffer.concat(chunks).toString("utf8")));
}
// BUG-237: like the real CLI 2.1.322 — with stream-json input a background subagent keeps working after
// `result` while stdin is open; stdin closed early → the CLI kills it (task_updated killed) and exits.
function napOrKilled(ms, toolUseId) {
  return new Promise((resolve) => {
    if (streamIn && stdinEnded) return resolve(killNow(toolUseId, resolve));
    const t = setTimeout(() => resolve(false), ms);
    if (streamIn) onStdinEnd.push(() => { clearTimeout(t); killNow(toolUseId, resolve); });
  });
}
function killNow(toolUseId, resolve) {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "killed", end_time: Date.now() } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] }) + "\n");
  setTimeout(() => process.exit(0), 20);
  resolve(true);
  return true;
}
// The real CLI in stream-json mode lives until its stdin closes.
function finish(code = 0) {
  if (!streamIn || stdinEnded) return exit(code);
  onStdinEnd.push(() => exit(code));
  setTimeout(() => process.exit(code), 30_000).unref();
}
let reqSeq = 0;
function askHost(toolName, input, description) {
  const id = `req_${process.pid}_${++reqSeq}`;
  line({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: toolName, input, description, permission_suggestions: [], tool_use_id: `toolu_${reqSeq}` } });
  return new Promise((resolve) => waiters.set(id, resolve));
}

async function main(prompt) {
  if (!argv.includes("-p") || !["text", "stream-json"].includes(flagValue("--input-format"))) {
    process.stderr.write("fake: expected -p --input-format text|stream-json\n");
    return exit(2);
  }
  // Title generator mode (lib/title.js, BUG-13.14): plain text out.
  //   prompt contains "TITLEFAIL" → exit 3; "TITLEHANG" → never answers;
  //   otherwise «Заголовок: «Тема <first 3 words>»» (exercises cleaning).
  if (flagValue("--output-format") === "text") {
    if (prompt.includes("TITLEFAIL")) return exit(3);
    if (prompt.includes("TITLEHANG")) {
      setTimeout(() => process.exit(0), 60_000);
      return;
    }
    const tools = argv.indexOf("--tools");
    if (tools < 0 || argv[tools + 1] !== "") {
      process.stderr.write("fake: title mode expects --tools \"\"\n");
      return exit(4);
    }
    process.stdout.write(`Заголовок: «Тема ${prompt.split(/\s+/).slice(0, 3).join(" ")}»\n`);
    return exit(0);
  }
  line({ type: "system", subtype: "init", session_id: sid });
  // BUG-184: "STALEBG" → a resumed session whose background task died with the
  // previous process: the real CLI first runs an EMPTY round for the stale task
  // notification (init → result with no text), then answers the prompt.
  // "EMPTYONLY" → only that empty round, then exit (a genuinely empty answer).
  if (prompt.includes("STALEBG") || prompt.includes("EMPTYONLY")) {
    line({ type: "system", subtype: "task_notification" });
    line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: "", used_model: model });
    if (prompt.includes("EMPTYONLY")) return exit(0);
    line({ type: "system", subtype: "init", session_id: sid });
  }
  // FEAT-01.77: the subagent fixture sequence (claude-stream-subagent-2.1.322.jsonl).
  // "SUBAGENT<ms>" → Agent call, task_started, the async tool_result, the answer
  // and `result`; the subagent then works in the TAIL (steps after `result`,
  // with a ~<ms> pause), task_updated + task_notification complete it, and the
  // CLI runs one more round (init → answer → result) like the real one.
  // "SUBAGENTSTOP" → the subagent stays running (no notification) for 30 s:
  // the test stops the turn mid-work.
  if (/SUBAGENT/.test(prompt)) {
    const AG = "toolu_ag1";
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: AG, name: "Agent", input: {} } } });
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: AG, name: "Agent", input: { subagent_type: "explorer", description: "Список файлов", prompt: "Перечисли файлы." } }] } });
    line({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_agent" }] });
    line({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: AG, description: "Список файлов", is_backgrounded: true, task_type: "local_agent" });
    line({ type: "user", message: { content: [{ tool_use_id: AG, type: "tool_result", content: "Async agent launched successfully." }] } });
    const a1 = "Субагент запущен и работает в фоне.";
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m2" } } });
    delta(a1);
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: a1 }] } });
    line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: a1, used_model: model });
    // the subagent works in the tail: its traffic carries parent_tool_use_id
    const pause = Math.max(150, /SUBAGENT(\d+)/.exec(prompt)?.[1] | 0);
    if (await napOrKilled(Math.round(pause * 0.4), AG)) return;
    line({ type: "assistant", parent_tool_use_id: AG, message: { id: "s1", content: [{ type: "tool_use", id: "toolu_p1", name: "PowerShell", input: { command: "Get-ChildItem | Select-Object Name", description: "List all files" } }] } });
    line({ type: "user", parent_tool_use_id: AG, message: { content: [{ tool_use_id: "toolu_p1", type: "tool_result", content: "a.txt\nb.txt", is_error: false }] } });
    line({ type: "assistant", parent_tool_use_id: AG, message: { id: "s2", content: [{ type: "text", text: "Результаты: в папке a.txt и b.txt." }] } });
    if (prompt.includes("MIDROUND")) {
      // BUG-237: a round the CLI opens by itself while the subagent still works
      line({ type: "system", subtype: "init", session_id: sid, model });
      const am = "Субагент ещё работает.";
      line({ type: "stream_event", event: { type: "message_start", message: { id: "m5" } } });
      delta(am);
      line({ type: "assistant", message: { id: "m5", content: [{ type: "text", text: am }] } });
      line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: am, used_model: model });
    }
    if (prompt.includes("SUBAGENTSTOP")) {
      await sleep(30_000);
      process.exit(0);
    }
    if (await napOrKilled(Math.round(pause * 0.4), AG)) return;
    line({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed", end_time: Date.now() } });
    line({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: AG, status: "completed", summary: "Результаты: в папке a.txt и b.txt." }); line({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    line({ type: "system", subtype: "init", session_id: sid, model });
    const a2 = "В папке два файла (a.txt и b.txt).";
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m9" } } });
    delta(a2);
    line({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: a2 }] } });
    line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: a2, used_model: model });
    finish(0); // BUG-237: stream-json — lives until stdin closes
  }
  // FEAT-18.5: "USAGE" → usage как у CLI 2.1.322 (claude-stream-subagent-2.1.322.jsonl):
  // два вызова основного разговора и вызов субагента с message.usage, затем
  // result с СУММОЙ основных вызовов, total_cost_usd и modelUsage.contextWindow.
  if (prompt.includes("USAGE")) {
    const u = (i, r, w, o) => ({ input_tokens: i, cache_read_input_tokens: r, cache_creation_input_tokens: w, output_tokens: o });
    line({ type: "assistant", message: { id: "m1", usage: u(9, 18737, 8251, 8), content: [{ type: "tool_use", id: "toolu_u", name: "Read", input: {} }] } });
    line({ type: "assistant", parent_tool_use_id: "tu1", message: { id: "s1", usage: u(10, 0, 16878, 7), content: [{ type: "text", text: "sub" }] } });
    line({ type: "user", message: { content: [{ tool_use_id: "toolu_u", type: "tool_result", content: "ok" }] } });
    const a = "Готово.";
    delta(a);
    line({ type: "assistant", message: { id: "m2", usage: u(8, 26988, 969, 2), content: [{ type: "text", text: a }] } });
    line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: a, total_cost_usd: 0.05584425, usage: { ...u(17, 45725, 9220, 388), iterations: [u(8, 26988, 969, 92)] }, modelUsage: { [model]: { contextWindow: 200000, costUSD: 0.05584425 } } });
    process.exit(0);
  }
  if (prompt.includes("TOOLHANG")) {
    // FEAT-13.19: a command call that never returns (stop mid-call).
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_h", name: "Bash", input: {} } } });
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_h", name: "Bash", input: { command: "sleep 600" } }] } });
    setTimeout(() => process.exit(0), 60_000);
    return;
  }
  if (prompt.includes("CRASH")) {
    // BUG-182: the CLI dies mid-answer (out of memory, killed) — some text, then no `result` line.
    delta("Начинаю работу");
    process.stderr.write("fatal: allocation failed (fake)\n")
    setTimeout(() => process.exit(prompt.includes("CRASH0") ? 0 : 134), 100);
    return;
  }
  if (prompt.includes("HANG")) {
    setTimeout(() => process.exit(0), 60_000); // alive but silent
    return;
  }
  let answer;
  const fileOp = /\b(WRITEFILE|EDITFILE) (\S+) ([^\n]*)/.exec(prompt);
  const askOp = /\bASKWRITE (\S+) ([^\n]*)/.exec(prompt);
  if (askOp) {
    // FEAT-18.4: the permission bridge
    const results = [];
    const rounds = prompt.includes("ASKTWICE") ? 2 : 1;
    for (let i = 0; i < rounds; i++) {
      const name = i === 0 ? askOp[1] : `2-${askOp[1]}`;
      const input = { file_path: path.resolve(process.cwd(), name), content: askOp[2].replace(/\s*ASKTWICE\s*/, "") };
      line({ type: "assistant", message: { id: `m${i}`, content: [{ type: "tool_use", id: `toolu_w${i}`, name: "Write", input }] } });
      let r;
      if (streamIn && argv.includes("--permission-prompt-tool") && flagValue("--permission-prompt-tool") === "stdio") {
        r = await askHost("Write", input, name);
      } else {
        r = { subtype: "success", response: { behavior: "deny", message: "auto-denied" } };
      }
      const decision = r.response ?? {};
      if (decision.behavior === "allow") {
        const inp = decision.updatedInput ?? input;
        writeFileSync(inp.file_path, inp.content);
        results.push(`Файл ${name} записан.`);
      } else results.push(`Отказано: ${decision.message ?? "?"}`);
      line({ type: "user", message: { content: [{ tool_use_id: `toolu_w${i}`, type: "tool_result", content: results.at(-1), is_error: decision.behavior !== "allow" }] } });
    }
    answer = results.join(" ");
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m9" } } });
    delta(answer);
    line({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: answer }] } });
  } else if (fileOp) {
    const target = path.resolve(process.cwd(), fileOp[2]);
    runHooks(fileOp[1] === "WRITEFILE" ? "Write" : "Edit", target);
    writeFileSync(target, fileOp[3]);
    answer = `Файл ${fileOp[2]} записан.`;
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    delta(answer);
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: answer }] } });
  } else if (prompt.includes("HISTORY")) {
    answer = JSON.stringify(remembered);
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    delta(answer);
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: answer }] } });
  } else if (prompt.includes("ECHO")) {
    answer = JSON.stringify({ prompt, argv, envKeys: Object.keys(process.env), cwd: process.cwd() });
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    delta(answer);
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: answer }] } });
  } else if (prompt.includes("MULTI")) {
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    delta("Сначала читаю файл.");
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Сначала читаю файл." }] } });
    line({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } } });
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read", input: {} }] } });
    // subagent chatter must never become answer text
    line({ type: "assistant", parent_tool_use_id: "tu1", message: { id: "sub1", content: [{ type: "text", text: "SUBAGENT" }] } });
    line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
    line({ type: "stream_event", event: { type: "message_start", message: { id: "m2" } } });
    delta("Готово: в файле 3 строки.");
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Готово: в файле 3 строки." }] } });
    answer = "Готово: в файле 3 строки.";
  } else if (prompt.includes("TOOLS")) {
    const ev = (event) => line({ type: "stream_event", event });
    ev({ type: "message_start", message: { id: "m1" } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Нужно выполнить команду." } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "PowerShell", input: {} } });
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "PowerShell", input: { command: "echo 42", description: "Вывести 42" } }] } });
    ev({ type: "content_block_stop", index: 1 });
    line({ type: "user", message: { content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "42", is_error: false }] } });
    ev({ type: "message_start", message: { id: "m2" } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Вывод: 42." } });
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Вывод: 42." }] } });
    ev({ type: "content_block_stop", index: 0 });
    answer = "Вывод: 42.";
  } else if (prompt.includes("SLOW")) {
    for (let i = 0; i < 10; i++) {
      delta(`${i}`);
      await sleep(100);
    }
    answer = "0123456789";
    line({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  } else {
    if (prompt.includes("WAIT")) await sleep(1500);
    delta(`Привет,${suffix}`);
    delta(`мир!${suffix}`);
    answer = `Привет, мир!${suffix}`;
    line({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  }
  const LIMIT_TEXT = "Claude AI usage limit reached|1731000000";
  const limitText = prompt.includes("LIMITTEXT");
  const limit = !limitText && prompt.includes("LIMIT");
  if (limitText) {
    answer = LIMIT_TEXT;
    line({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  }
  const fail = prompt.includes("FAIL") || limit;
  saveTranscript(prompt, answer);
  line({ type: "result", subtype: fail ? "error_max_turns" : "success", session_id: sid, is_error: fail, result: limit ? LIMIT_TEXT : fail ? "boom" : answer, used_model: model });
  // BUG-184: "BGTAIL<ms>" → like the real CLI with a background task left: after
  // `result` the process stays alive <ms>, then exits; "BGROUND" → when the task
  // ends the CLI runs one more round on its own (task notification → init →
  // answer → result) before it exits.
  const tail = /BGTAIL(\d+)/.exec(prompt);
  if (tail) {
    line({ type: "system", subtype: "background_tasks_changed" });
    await sleep(Number(tail[1]));
    line({ type: "system", subtype: "task_notification" });
    if (prompt.includes("BGEMPTY")) {
      line({ type: "system", subtype: "init", session_id: sid, model });
      line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: "", used_model: model });
    }
    if (prompt.includes("BGROUND")) {
      line({ type: "system", subtype: "init", session_id: sid, model });
      line({ type: "stream_event", event: { type: "message_start", message: { id: "m9" } } });
      delta("Фоновая задача завершилась.");
      line({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: "Фоновая задача завершилась." }] } });
      line({ type: "result", subtype: "success", session_id: sid, is_error: false, result: "Фоновая задача завершилась.", used_model: model });
    }
  }
  finish(0);
}
