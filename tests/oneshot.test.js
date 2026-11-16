// FEAT-18.8: lib/oneshot.js pure parts and the opencode runner on a fake
// client — the prompt (language, diff cap), cleaning of the answer, the
// claude / codex argv (no resume, tools off, ephemeral mode), the CLI result
// parsing, and the temporary opencode session (model, deleted on success,
// failure and timeout). Spawning runs live in tests/git-server.test.js.
// Run: node --test tests/oneshot.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OneshotError, ONESHOT_DIFF_MAX, claudeOneshotArgs, cleanCommitMessage, codexOneshotArgs, commitPrompt, finishedAnswer, resultText, runOpencodeOneshot,
} from "../lib/oneshot.js";
import { cleanGitSettings, emailLocalPart, gitDefaults } from "../lib/auth.js";
import { codexPolicy, parseArgs } from "../lib/codex-shim.mjs";

test("commitPrompt: language, Conventional Commits rules, the diff capped", () => {
  const ru = commitPrompt("+a\n", { lang: "ru" });
  assert.match(ru, /in Russian/);
  assert.match(ru, /72 characters/);
  assert.match(ru, /<diff>\n\+a\n\n<\/diff>/);
  assert.match(commitPrompt("x", { lang: "en" }), /in English/);
  const big = commitPrompt("y".repeat(ONESHOT_DIFF_MAX + 500));
  assert.ok(big.length < ONESHOT_DIFF_MAX + 1500);
  assert.match(big, /diff truncated/);
});

test("cleanCommitMessage: fences, quotes, preface dropped", () => {
  assert.equal(cleanCommitMessage("```\nfeat: x\n\nbody\n```"), "feat: x\n\nbody");
  assert.equal(cleanCommitMessage("Commit message: fix: y"), "fix: y");
  assert.equal(cleanCommitMessage("«docs: z»"), "docs: z");
  assert.equal(cleanCommitMessage("\r\n  chore: w \r\n"), "chore: w");
  assert.equal(cleanCommitMessage("x".repeat(5000)).length, 2000);
});

test("argv: claude — print, json, model, tools off, no resume / persistence; codex — one-shot flag", () => {
  const a = claudeOneshotArgs("claude-haiku-4-5");
  assert.equal(a[a.indexOf("--model") + 1], "claude-haiku-4-5");
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.equal(a[a.indexOf("--output-format") + 1], "json");
  assert.ok(a.includes("--no-session-persistence") && a.includes("--strict-mcp-config"));
  assert.equal(a.includes("--resume"), false);
  assert.ok(claudeOneshotArgs("claude-opus-4-1[1m]"));
  const c = codexOneshotArgs("gpt-6.1-sol");
  assert.ok(c.includes("--teleharness-oneshot"));
  assert.equal(c.includes("--resume"), false);
  for (const bad of ["--dangerously-skip-permissions", "", null, "a b"]) assert.throws(() => claudeOneshotArgs(bad), OneshotError, String(bad));
});

test("resultText: json object, stream-json lines, error result, nothing", () => {
  assert.equal(resultText(JSON.stringify({ type: "result", is_error: false, result: "feat: a" })), "feat: a");
  assert.equal(resultText(['{"type":"system"}', '{"type":"result","is_error":false,"result":"fix: b"}'].join("\n")), "fix: b");
  assert.throws(() => resultText('{"type":"result","is_error":true,"result":"boom"}'), /boom/);
  assert.throws(() => resultText("garbage"), OneshotError);
});

test("finishedAnswer: waits for completion and the last step", () => {
  const asst = (extra) => ({ info: { role: "assistant", time: { created: 1, ...(extra.completed ? { completed: 2 } : {}) }, ...extra.info }, parts: extra.parts ?? [] });
  assert.equal(finishedAnswer([]), null);
  assert.equal(finishedAnswer([asst({})]), null);
  assert.equal(finishedAnswer([asst({ completed: true, info: { finish: "tool-calls" } })]), null);
  assert.equal(finishedAnswer([asst({ completed: true, parts: [{ type: "text", text: "a" }, { type: "text", text: "hidden", synthetic: true }, { type: "reasoning", text: "r" }] })]), "a");
  assert.throws(() => finishedAnswer([asst({ info: { error: { name: "X", data: { message: "quota" } } } })]), /quota/);
});

function fakeOc({ api = "v1", answer = "feat: ok", fail = null, never = false } = {}) {
  const calls = [];
  return {
    api,
    calls,
    createSession: async (o) => (calls.push(["create", o]), { id: "ses_tmp" }),
    setSessionModel: async (id, o) => calls.push(["model", id, o.model]),
    setSessionAgent: async (id, o) => calls.push(["agent", id, o.agent]),
    prompt: async (o) => {
      calls.push(["prompt", o]);
      if (fail) throw fail;
    },
    listMessages: async () => ({ messages: never ? [] : [{ info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" }, parts: [{ type: "text", text: answer }] }] }),
    abort: async (id) => calls.push(["abort", id]),
    deleteSession: async (id) => calls.push(["delete", id]),
  };
}

test("runOpencodeOneshot: v1 — model in the prompt, answer, session deleted", async () => {
  const oc = fakeOc();
  const text = await runOpencodeOneshot({ oc, model: { providerID: "p", modelID: "m" }, agent: "build", prompt: "P", pollMs: 5 });
  assert.equal(text, "feat: ok");
  const p = oc.calls.find((c) => c[0] === "prompt")[1];
  assert.deepEqual(p.model, { providerID: "p", modelID: "m" });
  assert.equal(p.agent, "build");
  assert.match(p.parts[0].text, /P$/);
  assert.deepEqual(oc.calls.at(-1), ["delete", "ses_tmp"]);
  assert.equal(oc.calls.some((c) => c[0] === "abort"), false);
});

test("runOpencodeOneshot: v2 — model/agent set on the session; failure and timeout still delete", async () => {
  const oc = fakeOc({ api: "v2" });
  await runOpencodeOneshot({ oc, model: { providerID: "p", modelID: "m" }, prompt: "P", pollMs: 5 });
  assert.deepEqual(oc.calls.find((c) => c[0] === "model"), ["model", "ses_tmp", { providerID: "p", modelID: "m" }]);
  assert.equal(oc.calls.find((c) => c[0] === "prompt")[1].model, undefined);
  const bad = fakeOc({ fail: Object.assign(new Error("x"), { status: 500 }) });
  await assert.rejects(runOpencodeOneshot({ oc: bad, prompt: "P", pollMs: 5 }), (e) => e instanceof OneshotError && /opencode/.test(e.message));
  assert.ok(bad.calls.some((c) => c[0] === "delete"));
  const slow = fakeOc({ never: true });
  await assert.rejects(runOpencodeOneshot({ oc: slow, prompt: "P", pollMs: 5, timeoutMs: 60 }), /не ответила/);
  assert.ok(slow.calls.some((c) => c[0] === "abort") && slow.calls.some((c) => c[0] === "delete"));
});

test("git settings (lib/auth.js): e-mail from the name, defaults, validation", () => {
  assert.equal(emailLocalPart("Анна Петрова"), "anna-petrova");
  assert.equal(emailLocalPart("admin"), "admin");
  assert.equal(emailLocalPart("щука_Ёж"), "shchuka_ezh");
  assert.equal(emailLocalPart("!!!"), "user");
  assert.deepEqual(gitDefaults({ id: "bob", name: "Боб", role: "user" }), { authorName: "Боб", authorEmail: "bob@teleharness.local", messageLang: "ui", preselect: "modified", pushAllowed: false });
  assert.equal(gitDefaults({ id: "root", name: "root", role: "admin" }).pushAllowed, true);
  assert.deepEqual(cleanGitSettings({ authorName: "  A  ", authorEmail: "", messageLang: "en" }), { authorName: "A", authorEmail: null, messageLang: "en" });
  for (const bad of [null, [], { authorEmail: "a@b c" }, { authorName: "a<b>" }, { authorName: "a\tb" }, { preselect: 1 }]) assert.throws(() => cleanGitSettings(bad), (e) => e.status === 400, JSON.stringify(bad));
});

test("codex shim --teleharness-oneshot: read-only, approval never, whatever else argv asks", () => {
  const o = parseArgs(["-p", "--output-format", "stream-json", "--teleharness-oneshot", "--permission-mode", "bypassPermissions"]);
  assert.equal(o.oneshot, true);
  assert.deepEqual(o.unknown, []);
  const pol = codexPolicy(o);
  assert.equal(pol.sandbox, "read-only");
  assert.equal(pol.approvalPolicy, "never");
  assert.equal(pol.canAsk, false);
  assert.equal(codexPolicy(parseArgs(["-p", "--permission-mode", "bypassPermissions"])).sandbox === "read-only", false, "a normal turn keeps its policy");
});
