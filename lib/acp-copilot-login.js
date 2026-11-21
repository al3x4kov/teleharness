// FEAT-20.4 / BUG-279 / BUG-282. Copilot CLI предлагает вход по коду устройства отдельной командой.
import { killChildTree } from "./proc.js";

function stopChild(child) {
  if (!child) return;
  if (child.pid) killChildTree(child);
  else child.kill?.();
}

export class CopilotLoginSessions {
  #profiles = new Map();
  #onFinish;
  #isReady;
  // onFinish(owner, status) — портал пишет маркер входа, переживающий рестарт.
  // isReady(owner) — проверка маркера .portal-ready после рестарта (BUG-279).
  constructor(launch, onFinish = null, isReady = null) {
    this.launch = launch;
    this.#onFinish = onFinish;
    this.#isReady = isReady;
  }
  get(owner) {
    return this.#profiles.get(owner) ?? (this.#isReady?.(owner) ? { status: "ready" } : { status: "idle" });
  }

  start(owner) {
    const current = this.get(owner);
    if (["starting", "awaiting-device"].includes(current.status)) return current;
    const child = this.launch(owner);
    this.#profiles.set(owner, { status: "starting" });
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.#onFinish?.(owner, status);
      this.#profiles.set(owner, { status });
    };
    const timer = setTimeout(() => { finish("expired"); stopChild(child); }, 900000);
    timer.unref();
    for (const stream of [child.stdout, child.stderr]) {
      let tail = "";
      stream.setEncoding("utf8").on("data", (chunk) => {
        if (finished) return;
        tail = (tail + chunk).slice(-4096);
        const match = tail.match(/https:\/\/github\.com\/login\/device and enter (?:the )?code ([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s)/);
        if (match) this.#profiles.set(owner, { status: "awaiting-device", url: "https://github.com/login/device", code: match[1] });
      });
    }
    child.once("error", () => finish("failed"));
    child.once("close", (code) => finish(code === 0 ? "ready" : "rejected"));
    return this.get(owner);
  }
}
