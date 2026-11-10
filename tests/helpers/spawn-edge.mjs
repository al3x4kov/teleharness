// Запуск копии/экземпляра edge (ops/portal-server.js) для тестов (TASK-14.8, tests.md A6).
//
// Боевой edge захардкожен на прод: /zai → 127.0.0.1:4170, /tv/api → :8099,
// статика из D:\Portal, слушает :80/:443. Тест не имеет права ни слушать эти
// порты, ни проксировать в прод, поэтому helper:
//   1) копирует исходник во временный .mjs, подменяя цели (порт портала, порт
//      TV API, ROOT статики) на тестовые — если шаблон не найден, бросает
//      (edge переписали → helper надо обновить, а не молча ходить в прод);
//   2) выбирает свободные порты для http и https;
//   3) поднимает фейковые бэкенды: «портал» (эхо пути/метода, SSE на /zai/api/event)
//      и «TV API»;
//   4) TLS — по выбору: { tls: true } берёт сертификаты из ops/certs (только
//      чтение; если их нет — tls выключен и HTTPS-only не активен).
//
//   const edge = await spawnEdge({ tls: true });
//   after(() => edge.stop());
//   await edge.request("/ZAI/data/x")            // http
//   await edge.request("/zai/", { https: true }) // https (самоподписанный CA — проверка выключена)
//   edge.backend.requests                         // что дошло до «портала»
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { cleanEnv, makeTmpRoot } from "./env.mjs";
import { ROOT } from "./spawn-server.mjs";

export const EDGE_SRC = path.join(ROOT, "ops", "portal-server.js");
const CERT_DIR = path.join(ROOT, "ops", "certs");

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Фейковый бэкенд: отвечает JSON-эхом { method, url, headers }, на
// /zai/api/event — SSE с кадром сразу и вторым через 50 мс (проверка
// небуферизованной прокачки).
export async function startEchoBackend(name) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url.startsWith("/zai/api/event")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: first\n\n");
      const t = setTimeout(() => res.write("data: second\n\n"), 50);
      req.on("close", () => clearTimeout(t));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-backend": name });
    res.end(JSON.stringify({ backend: name, method: req.method, url: req.url }));
  });
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// Подмена захардкоженных целей. Экспортирована для теста самого helper-а.
export function patchEdgeSource(src, { zaiPort, tvPort, staticRoot }) {
  const subs = [
    [/(const\s+ZAI\s*=\s*\{\s*host:\s*"127\.0\.0\.1",\s*port:\s*)4170(\s*\})/, `$1${zaiPort}$2`],
    [/(const\s+TV_API\s*=\s*\{\s*host:\s*"127\.0\.0\.1",\s*port:\s*)8099(\s*\})/, `$1${tvPort}$2`],
    [/const\s+ROOT\s*=\s*"D:\\\\Portal";/, `const ROOT = ${JSON.stringify(staticRoot)};`],
  ];
  let out = src;
  for (const [re, rep] of subs) {
    if (!re.test(out)) {
      throw new Error(`spawn-edge: в ops/portal-server.js не найден шаблон ${re} — edge изменился, обнови tests/helpers/spawn-edge.mjs`);
    }
    out = out.replace(re, rep);
  }
  if (/port:\s*(4170|8099)\b/.test(out) || /"D:\\\\Portal"/.test(out)) {
    throw new Error("spawn-edge: после подмены в копии edge остались прод-цели");
  }
  return out;
}

export async function spawnEdge({ tls = false, httpsOnly = true, readyTimeoutMs = 10_000, staticFiles = {} } = {}) {
  const tmp = makeTmpRoot("zai-edge-");
  const zai = await startEchoBackend("zai");
  const tv = await startEchoBackend("tv");

  // Статика: D:\Portal заменён на tmp-корень с минимальным деревом tv/ и
  // «опасными» соседями, которые edge обязан НЕ отдавать.
  const staticRoot = path.join(tmp.root, "portal");
  const files = {
    "tv/index.html": "<h1>tv</h1>",
    "tv/status.json": "{}",
    "zai/data/admin-token.txt": "SECRET-ADMIN-TOKEN",
    "zai-stage/stand.cmd": "SECRET-STAND",
    "secrets/qb.json": "SECRET-QB",
    "watchdog.ps1": "SECRET-WATCHDOG",
    ...staticFiles,
  };
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(staticRoot, ...rel.split("/"));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  const caFile = path.join(tmp.root, "rootCA.pem");
  writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n");

  // Edge с env-оверрайдами (Г1, ADR-006 п.7: ZAI_EDGE_UPSTREAM/…_TV_UPSTREAM/
  // …_ROOT/…_LOG_DIR) запускается как есть; старый захардкоженный — через
  // подмену в копии. В обоих случаях после старта проверяем, что целей прода нет.
  const edgeSrc = readFileSync(EDGE_SRC, "utf8");
  const envConfigurable = /ZAI_EDGE_UPSTREAM/.test(edgeSrc) && /ZAI_EDGE_ROOT/.test(edgeSrc);
  let script = EDGE_SRC;
  if (!envConfigurable) {
    script = path.join(tmp.root, "portal-server.test-copy.mjs");
    writeFileSync(script, patchEdgeSource(edgeSrc, { zaiPort: zai.port, tvPort: tv.port, staticRoot }));
  }

  const httpPort = await freePort();
  const tlsPort = await freePort();
  let cert = path.join(tmp.root, "no-cert.pem");
  let key = path.join(tmp.root, "no-key.pem");
  if (tls) {
    const pem = existsSync(CERT_DIR) ? (await import("node:fs")).readdirSync(CERT_DIR).filter((f) => f.endsWith(".pem")) : [];
    const k = pem.find((f) => f.endsWith("-key.pem"));
    const c = k && pem.find((f) => f === k.replace(/-key\.pem$/, ".pem"));
    if (k && c) { cert = path.join(CERT_DIR, c); key = path.join(CERT_DIR, k); }
  }
  const tlsActive = existsSync(cert) && existsSync(key);

  const child = spawn(process.execPath, [script], {
    cwd: tmp.root,
    env: cleanEnv({
      PORT: httpPort,
      TLS_PORT: tlsPort,
      ZAI_TLS_CERT: cert,
      ZAI_TLS_KEY: key,
      ZAI_TLS_CA: caFile,
      ZAI_HTTPS_ONLY: httpsOnly ? "1" : "0",
      ZAI_EDGE_UPSTREAM: `127.0.0.1:${zai.port}`,
      ZAI_EDGE_TV_UPSTREAM: `127.0.0.1:${tv.port}`,
      ZAI_EDGE_ROOT: staticRoot,
      ZAI_EDGE_LOG_DIR: tmp.logs, // не в боевой data/logs
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { log += c; });
  const exited = new Promise((r) => child.once("exit", r));
  const want = tlsActive ? /portal-tls listening/ : /portal-node listening/;
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`edge-копия не поднялась за ${readyTimeoutMs} мс\n${log}`)), readyTimeoutMs);
      child.stdout.on("data", (c) => {
        log += c;
        if (want.test(log) && /portal-node listening/.test(log)) { clearTimeout(t); resolve(); }
      });
      exited.then((code) => { clearTimeout(t); reject(new Error(`edge-копия завершилась (code ${code})\n${log}`)); });
    });
  } catch (err) {
    child.kill();
    await zai.close();
    await tv.close();
    tmp.cleanup();
    throw err;
  }

  // Сырой запрос: путь уходит как есть (fetch нормализует %2e, регистр — нет,
  // но точки/.. схлопывает), поэтому http.request с path без нормализации.
  function request(p, { method = "GET", https: useTls = false, headers = {}, body, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const mod = useTls ? https : http;
      const req = mod.request(
        {
          host: "127.0.0.1",
          port: useTls ? tlsPort : httpPort,
          path: p,
          method,
          headers: { host: "192.168.0.10", ...headers },
          rejectUnauthorized: false,
        },
        (res) => {
          if (raw) return resolve(res);
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  return {
    httpPort,
    tlsPort,
    tlsActive,
    backend: zai,
    tv,
    request,
    get log() { return log; },
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      }
      await zai.close();
      await tv.close();
      tmp.cleanup();
    },
  };
}
