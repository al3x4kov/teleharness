// Общий запуск server.js для server-e2e тестов (TASK-14.4/14.5, tests.md A3).
//
//   const srv = await spawnPortal({ upstream: fake.url });   // или { mock: true }
//   after(() => srv.stop());
//   await fetch(`${srv.base}/zai/api/session`)
//
// Гарантии: белый список env (см. env.mjs), свои tmp DATA/HOME/TENANT_*/LOGS,
// upstream обязателен и не может быть прод/стендом, таймаут готовности 15 с,
// stop() = kill + ожидание exit + удаление tmp. Логи процесса копятся в srv.log —
// печатаются в ошибке, если сервер не поднялся.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedServerEnv, makeTmpRoot, assertSafeUrl } from "./env.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function spawnPortal({
  upstream,
  mock = false,
  env = {},
  readyTimeoutMs = 15_000,
  tmp = makeTmpRoot(),
  script = path.join(ROOT, "server.js"),
} = {}) {
  const fullEnv = isolatedServerEnv({ tmp, upstream, mock, extra: env });
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: fullEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { log += c; });

  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server.js не поднялся за ${readyTimeoutMs} мс\n${log.slice(-2000)}`)),
        readyTimeoutMs,
      );
      child.stdout.on("data", (c) => {
        log += c;
        const m = log.match(/listening on (http:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1].replace(/\/+$/, "")); }
      });
      exited.then((code) => { clearTimeout(timer); reject(new Error(`server.js завершился до старта (code ${code})\n${log.slice(-2000)}`)); });
    });
  } catch (err) {
    child.kill();
    tmp.cleanup();
    throw err;
  }
  assertSafeUrl(base, "server base");

  let stopped = false;
  return {
    base,
    child,
    tmp,
    env: fullEnv,
    get log() { return log; },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      }
      tmp.cleanup();
    },
  };
}
