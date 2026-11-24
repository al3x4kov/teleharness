// Запуск копии/экземпляра edge (ops/portal-server.js) для тестов (TASK-14.8, tests.md A6).
//
// Боевой edge захардкожен на прод: /teleharness → 127.0.0.1:4170, /tv/api → :8099,
// статика из D:\Apps, слушает :80/:443. Тест не имеет права ни слушать эти
// порты, ни проксировать в прод, поэтому helper:
//   1) копирует исходник во временный .mjs, подменяя цели (порт портала, порт
//      TV API, ROOT статики) на тестовые — если шаблон не найден, бросает
//      (edge переписали → helper надо обновить, а не молча ходить в прод);
//   2) выбирает свободные порты для http и https;
//   3) поднимает фейковые бэкенды: «портал» (эхо пути/метода, SSE на /teleharness/api/event)
//      и «TV API»;
//   4) TLS — по выбору: { tls: true } берёт сертификаты из ops/certs (только
//      чтение; если их нет — tls выключен и HTTPS-only не активен).
//
//   const edge = await spawnEdge({ tls: true });
//   after(() => edge.stop());
//   await edge.request("/TELEHARNESS/data/x")            // http
//   await edge.request("/teleharness/", { https: true }) // https (самоподписанный CA — проверка выключена)
//   edge.backend.requests                         // что дошло до «портала»
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { cleanEnv, makeTmpRoot } from "./env.mjs";
import { ROOT } from "./spawn-server.mjs";

export const EDGE_SRC = path.join(ROOT, "ops", "portal-server.js");
const CERT_DIR = path.join(ROOT, "ops", "certs");

const OPENSSL = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].find((bin) => {
  try {
    return spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
});

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
// /teleharness/api/event — SSE с кадром сразу и вторым через 50 мс (проверка
// небуферизованной прокачки).
export async function startEchoBackend(name) {
  const requests = [];
  let sseClosed = 0;
  const sseWaiters = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url.startsWith("/teleharness/api/event")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: first\n\n");
      const silent = req.url.includes("silent=1");
      const t = silent ? null : setTimeout(() => { if (!res.writableEnded) res.write("data: second\n\n"); }, 50);
      const onClose = () => {
        if (t) clearTimeout(t);
        sseClosed += 1;
        while (sseWaiters.length) sseWaiters.shift()(sseClosed);
      };
      res.once("close", onClose);
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
    get sseClosed() { return sseClosed; },
    waitSseClose(afterCount = sseClosed, timeoutMs = 1500) {
      if (sseClosed > afterCount) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = sseWaiters.indexOf(on);
          if (i !== -1) sseWaiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
        const on = (n) => {
          if (n > afterCount) {
            clearTimeout(timer);
            resolve(true);
          } else {
            sseWaiters.push(on);
          }
        };
        sseWaiters.push(on);
      });
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// Подмена захардкоженных целей. Экспортирована для теста самого helper-а.
export function patchEdgeSource(src, { teleharnessPort, tvPort, staticRoot }) {
  const subs = [
    [/(const\s+TELEHARNESS\s*=\s*\{\s*host:\s*"127\.0\.0\.1",\s*port:\s*)4170(\s*\})/, `$1${teleharnessPort}$2`],
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

export async function spawnEdge({ tls = false, httpsOnly = true, readyTimeoutMs = 10_000, staticFiles = {}, env = {} } = {}) {
  const tmp = makeTmpRoot("teleharness-edge-");
  const teleharness = await startEchoBackend("teleharness");
  const tv = await startEchoBackend("tv");

  // Статика: D:\Apps заменён на tmp-корень с минимальным деревом tv/ и
  // «опасными» соседями, которые edge обязан НЕ отдавать.
  const staticRoot = path.join(tmp.root, "portal");
  const files = {
    "tv/index.html": "<h1>tv</h1>",
    "tv/status.json": "{}",
    "teleharness/data/admin-token.txt": "SECRET-ADMIN-TOKEN",
    "teleharness-stage/stand.cmd": "SECRET-STAND",
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

  // Edge с env-оверрайдами (Г1, ADR-006 п.7: TELEHARNESS_EDGE_UPSTREAM/…_TV_UPSTREAM/
  // …_ROOT/…_LOG_DIR) запускается как есть; старый захардкоженный — через
  // подмену в копии. В обоих случаях после старта проверяем, что целей прода нет.
  const edgeSrc = readFileSync(EDGE_SRC, "utf8");
  const envConfigurable = /TELEHARNESS_EDGE_UPSTREAM/.test(edgeSrc) && /TELEHARNESS_EDGE_ROOT/.test(edgeSrc);
  let script = EDGE_SRC;
  if (!envConfigurable) {
    script = path.join(tmp.root, "portal-server.test-copy.mjs");
    writeFileSync(script, patchEdgeSource(edgeSrc, { teleharnessPort: teleharness.port, tvPort: tv.port, staticRoot }));
  }

  const httpPort = await freePort();
  const tlsPort = await freePort();
  let cert = path.join(tmp.root, "no-cert.pem");
  let key = path.join(tmp.root, "no-key.pem");
  if (tls) {
    let pem = [];
    try {
      pem = existsSync(CERT_DIR) ? (await import("node:fs")).readdirSync(CERT_DIR).filter((f) => f.endsWith(".pem")) : [];
    } catch {}
    const k = pem.find((f) => f.endsWith("-key.pem"));
    const c = k && pem.find((f) => f === k.replace(/-key\.pem$/, ".pem"));
    if (k && c) {
      cert = path.join(CERT_DIR, c);
      key = path.join(CERT_DIR, k);
    } else if (OPENSSL) {
      const genCert = path.join(tmp.root, "cert.pem");
      const genKey = path.join(tmp.root, "key.pem");
      spawnSync(
        OPENSSL,
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", genKey, "-out", genCert, "-days", "1", "-subj", "/CN=127.0.0.1"],
        { stdio: "ignore" },
      );
      if (existsSync(genCert) && existsSync(genKey)) {
        cert = genCert;
        key = genKey;
      }
    }
  }
  const tlsActive = existsSync(cert) && existsSync(key);

  const child = spawn(process.execPath, [script], {
    cwd: tmp.root,
    env: cleanEnv({
      PORT: httpPort,
      TLS_PORT: tlsPort,
      TELEHARNESS_TLS_CERT: cert,
      TELEHARNESS_TLS_KEY: key,
      TELEHARNESS_TLS_CA: caFile,
      TELEHARNESS_HTTPS_ONLY: httpsOnly ? "1" : "0",
      TELEHARNESS_EDGE_UPSTREAM: `127.0.0.1:${teleharness.port}`,
      TELEHARNESS_EDGE_TV_UPSTREAM: `127.0.0.1:${tv.port}`,
      TELEHARNESS_EDGE_ROOT: staticRoot,
      TELEHARNESS_EDGE_LOG_DIR: tmp.logs, // не в боевой data/logs
      ...env,
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
    await teleharness.close();
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
          headers: { host: "192.0.2.10", ...headers },
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
    backend: teleharness,
    tv,
    request,
    get log() { return log; },
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      }
      await teleharness.close();
      await tv.close();
      tmp.cleanup();
    },
  };
}
