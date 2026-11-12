// TASK-17.1 (EPIC-17): убийство дерева процессов на Windows и Linux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSpawnOpts, killTreeSync } from "../lib/proc.js";

test("TASK-17.1: Linux — группа процессов: kill(-pid, SIGKILL); при ошибке — сам процесс", () => {
  const calls = [];
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  assert.equal(killTreeSync(4242, { platform: "linux", kill }), true);
  assert.deepEqual(calls, [[-4242, "SIGKILL"], [4242, "SIGKILL"]]);
});

test("TASK-17.1: Linux — группа убита с первого раза, процесс отдельно не трогаем", () => {
  const calls = [];
  assert.equal(killTreeSync(7, { platform: "linux", kill: (p, s) => calls.push([p, s]) }), true);
  assert.deepEqual(calls, [[-7, "SIGKILL"]]);
});

test("TASK-17.1: Windows — taskkill /T /F (как раньше)", () => {
  const runs = [];
  assert.equal(killTreeSync(55, { platform: "win32", exec: (cmd, args) => runs.push([cmd, args]) }), true);
  assert.deepEqual(runs, [["taskkill", ["/PID", "55", "/T", "/F"]]]);
});

test("TASK-17.1: неверный pid — false без вызовов", () => {
  let n = 0;
  assert.equal(killTreeSync(0, { platform: "linux", kill: () => n++ }), false);
  assert.equal(n, 0);
});

test("TASK-17.1: groupSpawnOpts — detached только на POSIX (своя группа процессов)", () => {
  assert.deepEqual(groupSpawnOpts({ cwd: "/x" }, "linux"), { cwd: "/x", detached: true });
  assert.deepEqual(groupSpawnOpts({ cwd: "C:\\x" }, "win32"), { cwd: "C:\\x" });
});
