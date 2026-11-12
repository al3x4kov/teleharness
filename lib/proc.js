// TASK-17.1 (EPIC-17, ADR-011): process-tree kill for Windows and Linux.
// Windows: `taskkill /T /F` (claude.exe spawns shells and MCP servers; a plain
// TerminateProcess leaves them running). POSIX: the child is spawned in its own
// process group (detached), so one `kill(-pgid)` takes the whole tree.
import { execFileSync, spawn } from "node:child_process";

const isWin = (platform) => (platform ?? process.platform) === "win32";

/** Spawn options that put the child in its own process group on POSIX. */
export function groupSpawnOpts(opts = {}, platform) {
  return isWin(platform) ? { ...opts } : { ...opts, detached: true };
}

/** Kill a process with its whole tree. Returns true when a kill was issued. */
export function killTreeSync(pid, { platform, kill = process.kill.bind(process), exec = (cmd, args) => execFileSync(cmd, args, { stdio: "ignore", timeout: 15_000, windowsHide: true }) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isWin(platform)) {
    try {
      exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
      return true;
    } catch {
      return false;
    }
  }
  try {
    kill(-pid, "SIGKILL"); // the whole process group
    return true;
  } catch {
    try {
      kill(pid, "SIGKILL"); // not a group leader (spawned without detached)
      return true;
    } catch {
      return false;
    }
  }
}

/** Async variant for a live ChildProcess: never blocks the event loop on Windows. */
export function killChildTree(child, platform) {
  if (!child?.pid) return;
  if (isWin(platform)) {
    const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    tk.on("error", () => {
      try {
        child.kill();
      } catch {}
    });
    return;
  }
  if (!killTreeSync(child.pid, { platform })) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}
