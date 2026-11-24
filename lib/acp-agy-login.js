// FEAT-20.4 / BUG-279 / BUG-282. Вход в Google Antigravity (ACP v1 по stdio):
// сервер печатает на stderr ссылку Google и слушает loopback-редирект.
// Пользователь копирует адрес страницы после входа, портал ретранслирует GET
// строго на порт и путь redirect_uri текущей попытки. Вход по платному API-ключу
// отключён (только подписки).
import { randomUUID } from "node:crypto";
import { killChildTree } from "./proc.js";

const AUTH_URL_RE = /Open the following link to authenticate the ACP server: (https:\/\/accounts\.google\.com\/\S+)/;

function parseExpectedRedirect(authUrl) {
  try {
    const raw = new URL(authUrl).searchParams.get("redirect_uri");
    if (!raw) return null;
    const u = new URL(raw);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port) return null;
    return { port: u.port, pathname: u.pathname || "/" };
  } catch {
    return null;
  }
}

function stopChild(child) {
  if (!child) return;
  if (child.pid) killChildTree(child);
  else child.kill?.();
}

export class AgyLoginSessions {
  #sessions = new Map();
  #onFinish;
  #isReady;
  // onFinish(owner, status) — портал пишет маркер входа, переживающий рестарт.
  // isReady(owner) — проверка маркера .portal-ready после рестарта портала (BUG-279).
  constructor(launch, onFinish = null, isReady = null) {
    this.launch = launch;
    this.#onFinish = onFinish;
    this.#isReady = isReady;
  }

  get(owner) {
    const attempt = this.#sessions.get(owner);
    if (attempt) return { id: attempt.id, ...(attempt.end ? { status: attempt.end } : attempt.state) };
    return this.#isReady?.(owner) ? { status: "ready" } : { status: "idle" };
  }

  start(owner, opts = {}) {
    if (opts?.method && opts.method !== "oauth-personal") {
      throw Object.assign(new Error("Вход по API-ключу отключён — используйте вход через подписку"), { status: 400 });
    }
    const methodId = "oauth-personal";
    const previous = this.#sessions.get(owner);
    if (previous && !previous.end) return this.get(owner);
    const child = this.launch(owner, null);
    const attempt = { id: randomUUID(), state: { status: "starting" }, child, redirectTarget: null };
    this.#sessions.set(owner, attempt);
    const finish = (status) => {
      if (attempt.end) return;
      attempt.end = status;
      this.#onFinish?.(owner, status);
      clearTimeout(timer);
      clearTimeout(attempt.verifyTimer);
      stopChild(child);
      delete attempt.finish;
      delete attempt.verifyTimer;
      delete attempt.child;
      delete attempt.state;
      delete attempt.tail;
      delete attempt.redirectTarget;
    };
    const timer = setTimeout(() => finish("expired"), 900000);
    timer.unref();
    attempt.finish = finish;
    const rpc = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    child.stdin.on("error", () => finish("failed"));
    child.once("error", () => finish("unavailable"));
    child.once("exit", () => finish("failed"));
    let initialized = false;
    let pending = "";
    // stderr: только ссылка Google становится состоянием, остальное отбрасывается.
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (attempt.end || attempt.state.status !== "starting") return;
      attempt.tail = ((attempt.tail ?? "") + chunk).slice(-32768);
      const match = attempt.tail.match(AUTH_URL_RE);
      if (match) {
        attempt.redirectTarget = parseExpectedRedirect(match[1]);
        attempt.state = { status: "awaiting-code", url: match[1] };
        attempt.tail = "";
      }
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
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
          if (!reply.result?.authMethods?.some((method) => method.id === methodId)) return finish("failed");
          initialized = true;
          rpc(2, "authenticate", { methodId });
        } else if (reply.id === 2 && initialized) {
          // Ответ authenticate: отказ (-32000 Onboarding failed…) — только статус.
          return finish(reply.error ? "rejected" : reply.result ? "ready" : "failed");
        }
      }
    });
    rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    return this.get(owner);
  }

  // Пользователь вставляет адрес страницы после входа; портал ретранслирует
  // GET строго на loopback-слушатель текущей попытки и ждёт ответ authenticate.
  async submit(owner, id, redirectUrl) {
    const attempt = this.#sessions.get(owner);
    if (!attempt || attempt.id !== id || this.get(owner).status !== "awaiting-code") throw new Error("Попытка входа завершена");
    const target = attempt.redirectTarget;
    if (!target) throw new Error("Вставьте адрес страницы после входа");
    // Браузер телефона часто копирует адрес без схемы — добавляем http:// сами.
    let raw = typeof redirectUrl === "string" ? redirectUrl.trim() : "";
    if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error("Вставьте адрес страницы после входа"); }
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== target.port ||
      parsed.pathname !== target.pathname ||
      !parsed.search ||
      parsed.search.length > 4097
    ) {
      throw new Error("Вставьте адрес страницы после входа");
    }
    const safeUrl = `http://127.0.0.1:${target.port}${target.pathname}${parsed.search}`;
    attempt.state = { status: "verifying" };
    attempt.verifyTimer = setTimeout(() => attempt.finish?.("verification-timeout"), 60000);
    attempt.verifyTimer.unref();
    try {
      const res = await fetch(safeUrl, { signal: AbortSignal.timeout(15000), redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        if (!attempt.end) attempt.finish?.("verification-timeout");
        return this.get(owner);
      }
    } catch {
      // Адрес не дошёл до слушателя — проверки ждать нечего.
      if (!attempt.end) attempt.finish?.("verification-timeout");
      return this.get(owner);
    }
    return this.get(owner);
  }
}
