// FEAT-20.7: чистые части рабочих копий вне lib/worktrees.js — Codex в копии
// (writableRoots общего .git в turn/start), шаг пайпа с флагом worktree,
// .teleharness-worktrees скрыты из проектов, шаг чата пайпа идёт в копии запуска.
// Run: node --test tests/worktree-units.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, codexPolicy, turnSandbox } from "../lib/codex-shim.mjs";
import { validateDefinition } from "../shared/temporal-definition.js";
import { isHiddenDir } from "../src/lib/normalize.js";
import { projectCandidate } from "../lib/temporal/workspace.js";
import { chatStepRunner } from "../lib/temporal/chat-step.js";

test("Codex: --teleharness-writable-root → sandboxPolicy workspaceWrite с общим .git; full access и read-only — без изменений", () => {
  const o = parseArgs(["-p", "--model", "gpt", "--teleharness-writable-root", "/p/proj/.git", "--permission-mode", "acceptEdits"]);
  assert.deepEqual(o.writableRoots, ["/p/proj/.git"]);
  assert.deepEqual(o.unknown, []);
  assert.deepEqual(turnSandbox(o, codexPolicy(o)), { sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/p/proj/.git"], networkAccess: false } });
  const full = parseArgs(["--teleharness-writable-root", "/p/.git", "--permission-mode", "bypassPermissions"]);
  assert.deepEqual(turnSandbox(full, codexPolicy(full)), {});
  const plan = parseArgs(["--teleharness-writable-root", "/p/.git", "--permission-mode", "plan"]);
  assert.deepEqual(turnSandbox(plan, codexPolicy(plan)), {});
  assert.deepEqual(turnSandbox(parseArgs(["--teleharness-writable-root", "relative/.git"]), { sandbox: "workspace-write" }), {});
});

test("пайп: флаг worktree у модельного шага — только boolean", () => {
  const d = (worktree) => ({ name: "Ночное обновление", directory: "/p", inputs: [], steps: [{ id: "a", type: "model", name: "Шаг", dependsOn: [], engine: "claude", model: "m", instruction: "x", timeoutSeconds: 600, maxAttempts: 1, ...(worktree === undefined ? {} : { worktree }) }] });
  assert.equal(validateDefinition(d(undefined)).valid, true);
  assert.equal(validateDefinition(d(true)).valid, true);
  assert.equal(validateDefinition(d("yes")).valid, false);
});

test(".teleharness-worktrees — не проект и скрыта из списков", () => {
  assert.equal(isHiddenDir("/home/u/.teleharness-worktrees/teleharness/dobav-1a2b"), true);
  assert.equal(isHiddenDir("/home/u/teleharness"), false);
  assert.equal(projectCandidate("/home/u/.teleharness-worktrees/teleharness", { exists: () => true }), false);
});

test("шаг пайпа с worktree: одна копия запуска, ход в её папке, папка запуска для результатов", async () => {
  const prepared = [];
  const dispatched = [];
  const runner = chatStepRunner({
    createSession: async () => "ses_step1",
    dispatchTurn: async (a) => {
      dispatched.push(a);
      a.res.writeHead(204);
      a.res.end();
      queueMicrotask(() => runner.onTurnEnd({ sid: "ses_step1" }));
    },
    messagesOf: () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "готово" }] }],
    abort: () => {},
    isLimit: () => false,
    prepareWorktree: async (a) => (prepared.push(a), { path: "/p/.teleharness-worktrees/teleharness/run-x-1a2b", branch: "teleharness/run-x-1a2b", base: "main", commonDir: "/p/.git" }),
  });
  const out = await runner.run({ user: { id: "u" }, engine: "claude", model: "m", directory: "/p/pipe", project: "/p", runFolder: "runs/r1", title: "t", instruction: "сделай", worktree: true, workflowId: "wf-1", pipeName: "x" });
  assert.equal(out.text, "готово");
  assert.equal(prepared[0].workflowId, "wf-1");
  assert.equal(dispatched[0].worktree.path, "/p/.teleharness-worktrees/teleharness/run-x-1a2b");
  assert.match(dispatched[0].text, /Рабочая папка этого запуска: runs\/r1/);
  assert.match(dispatched[0].text, /рабочей копии git .* на ветке teleharness\/run-x-1a2b/);
});

// BUG-273 (BUG-20.11): текст «несохранённая работа» — один для сервера (409) и клиента, формы 1/2/5
test("BUG-273: unsavedText — формы числа 1/2/5 (shared)", async () => {
  const { unsavedText } = await import("../shared/worktree.js");
  assert.equal(unsavedText({ uncommitted: 0, commits: 1 }, "main"), "В копии 1 коммит не в main");
  assert.equal(unsavedText({ uncommitted: 1, commits: 1 }, "main"), "В копии 1 незакоммиченный файл и 1 коммит не в main");
  assert.equal(unsavedText({ uncommitted: 2, commits: 3 }, "dev"), "В копии 2 незакоммиченных файла и 3 коммита не в dev");
  assert.equal(unsavedText({ uncommitted: 5, commits: 11 }, "main"), "В копии 5 незакоммиченных файлов и 11 коммитов не в main");
  assert.equal(unsavedText({ uncommitted: 0, commits: 0 }), "");
});
