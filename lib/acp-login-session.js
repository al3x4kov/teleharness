// FEAT-20.4. Вход работает в отдельном CLI: пользовательский код и ответ ACP
// используют один stdin, а терминальное эхо нельзя отдавать клиенту.
import { randomUUID } from "node:crypto";
import { GeminiLoginOutput } from "./acp-google-login.js";

export class GeminiLoginSessions {
  #sessions = new Map();
  #onFinish;
  // onFinish(owner, status) — портал пишет маркер входа, пережающий рестарт.
  constructor(launch, onFinish = null) { this.launch = launch; this.#onFinish = onFinish; }

  get(owner) {
    const attempt = this.#sessions.get(owner);
    return attempt ? { id: attempt.id, ...(attempt.end ? { status: attempt.end } : attempt.parser.state) } : { status: "idle" };
  }

  start(owner) {
    const previous = this.#sessions.get(owner);
    if (previous && !previous.end) return this.get(owner);
    const child = this.launch(owner);
    const attempt = { id: randomUUID(), parser: new GeminiLoginOutput(), child };
    this.#sessions.set(owner, attempt);
    const finish = (status) => {
      if (attempt.end) return;
      attempt.end = status;
      this.#onFinish?.(owner, status);
      clearTimeout(timer);
      clearTimeout(attempt.verifyTimer);
      child.kill();
      delete attempt.finish;
      delete attempt.verifyTimer;
      delete attempt.child;
      delete attempt.parser;
    };
    const timer = setTimeout(() => finish("expired"), 300000);
    timer.unref();
    attempt.finish=finish;
    const rpc = (id, method, params) => child.stdin.write(JSON.stringify({jsonrpc:"2.0", id, method, params}) + "\n");
    child.stdin.on("error", () => finish("failed"));
    child.once("error", () => finish("unavailable"));
    child.once("exit", () => finish("failed"));
    let initialized = false;
    let pending = "";
    function consume(chunk) {
      if (attempt.end) return;
      attempt.parser.feed(chunk);
      if (attempt.parser.state.status === "rejected") finish("rejected");
    }
    child.stderr.setEncoding("utf8").on("data", consume);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      consume(chunk);
      if (attempt.end) return;
      pending += chunk;
      if (pending.length > 131072) return finish("failed");
      let pos;
      while ((pos = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, pos);
        pending = pending.slice(pos + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply?.jsonrpc !== "2.0") continue;
        if (reply.id === 1 && !initialized) {
          if (!reply.result?.authMethods?.some(method => method.id === "oauth-personal")) return finish("failed");
          initialized = true;
          rpc(2, "authenticate", {methodId:"oauth-personal"});
        } else if (reply.id === 2 && initialized) {
          if (String(reply.error?.message ?? "").includes("This client is no longer supported for Gemini Code Assist for individuals")) return finish("unsupported");
          return finish(reply.error ? "rejected" : reply.result ? "ready" : "failed");
        }
      }
    });
    rpc(1, "initialize", {protocolVersion:1, clientCapabilities:{}});
    return this.get(owner);
  }

  submit(owner, id, code) {
    const attempt = this.#sessions.get(owner);
    if (!attempt || attempt.id !== id || this.get(owner).status !== "awaiting-code") throw new Error("Попытка входа завершена");
    if (typeof code !== "string" || !/^[A-Za-z0-9_./~+=%-]{1,4096}$/.test(code) || /\s/.test(code)) throw new Error("Проверьте код Google");
    attempt.parser.submitted();
    attempt.verifyTimer=setTimeout(()=>attempt.finish("verification-timeout"),30000);
    attempt.verifyTimer.unref();
    attempt.child.stdin.write(code + "\n");
    return this.get(owner);
  }
}
