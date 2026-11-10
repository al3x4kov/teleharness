// Edge (ops/portal-server.js): выбор сертификата по SNI (2026-11-04, example.org).
// Некоторые мобильные сети режут TLS по SNI, поэтому портал может публиковаться
// под собственным доменом (example.org).
// Для имён из ZAI_TLS_PUBLIC_NAMES edge отдаёт публичный сертификат, для всего остального
// (LAN IP, без SNI) — прежний mkcert. Копия edge на свободных портах с
// одноразовыми самоподписанными сертификатами; прод :80/:443 не трогается.
// Run: node --test tests/edge-sni.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), "zai-edge-sni-"));
mkdirSync(path.join(TMP, "Portal"), { recursive: true });
const EDGE = path.join(TMP, "portal-server.js");
copyFileSync(path.join(ROOT, "ops", "portal-server.js"), EDGE);

const OPENSSL = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].find((bin) => {
  try {
    return spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
});
function selfSigned(name, cn) {
  const cert = path.join(TMP, `${name}.pem`);
  const key = path.join(TMP, `${name}-key.pem`);
  if (OPENSSL) {
    spawnSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${cn}`], { stdio: "ignore" });
  }
  return { cert, key };
}
const lan = selfSigned("lan", "lan-mkcert");
const pub = selfSigned("pub", "example.org");
const HAVE = existsSync(lan.cert) && existsSync(pub.cert);
const skip = HAVE ? false : "нет openssl — сертификаты не сгенерировать";

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const children = [];
async function startEdge(extraEnv) {
  const PORT = await freePort();
  const TLS_PORT = await freePort();
  const child = spawn(process.execPath, [EDGE], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TLS_PORT: String(TLS_PORT),
      ZAI_EDGE_ROOT: path.join(TMP, "Portal"),
      ZAI_EDGE_UPSTREAM: "127.0.0.1:9",
      ZAI_EDGE_TV_UPSTREAM: "127.0.0.1:9",
      ZAI_EDGE_LOG_DIR: "0",
      ZAI_TLS_CERT: lan.cert,
      ZAI_TLS_KEY: lan.key,
      ZAI_TLS_CA: path.join(TMP, "no-ca.pem"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`edge не поднялся:\n${out}`)), 10000);
    const on = (c) => {
      out += c;
      if (out.includes("portal-tls listening")) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
  });
  return { TLS_PORT, log: () => out };
}

function peerCN(port, servername) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }, () => {
      const cn = s.getPeerCertificate()?.subject?.CN;
      s.end();
      resolve(cn);
    });
    s.on("error", reject);
  });
}

after(async () => {
  for (const c of children) c.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("SNI example.org / www.example.org (любой регистр) → публичный сертификат", { skip }, async () => {
  const e = await startEdge({ ZAI_TLS_PUBLIC_CERT: pub.cert, ZAI_TLS_PUBLIC_KEY: pub.key });
  assert.match(e.log(), /public cert for example\.org, www\.example\.org/);
  assert.equal(await peerCN(e.TLS_PORT, "example.org"), "example.org");
  assert.equal(await peerCN(e.TLS_PORT, "www.example.org"), "example.org");
  assert.equal(await peerCN(e.TLS_PORT, "WWW.Example.ORG"), "example.org");
});

test("прочие SNI и подключение без SNI (LAN IP) → прежний mkcert", { skip }, async () => {
  const e = await startEdge({ ZAI_TLS_PUBLIC_CERT: pub.cert, ZAI_TLS_PUBLIC_KEY: pub.key });
  assert.equal(await peerCN(e.TLS_PORT, "zai.home.example.net"), "lan-mkcert");
  assert.equal(await peerCN(e.TLS_PORT, "evil.example.org"), "lan-mkcert");
  assert.equal(await peerCN(e.TLS_PORT, undefined), "lan-mkcert");
});

test("нет файлов публичного сертификата → edge работает только на mkcert", { skip }, async () => {
  const e = await startEdge({
    ZAI_TLS_PUBLIC_CERT: path.join(TMP, "missing.pem"),
    ZAI_TLS_PUBLIC_KEY: path.join(TMP, "missing-key.pem"),
  });
  assert.doesNotMatch(e.log(), /public cert for/);
  assert.equal(await peerCN(e.TLS_PORT, "example.org"), "lan-mkcert");
});

test("битый публичный сертификат не роняет TLS-листенер", { skip }, async () => {
  const e = await startEdge({ ZAI_TLS_PUBLIC_CERT: pub.cert, ZAI_TLS_PUBLIC_KEY: lan.key });
  assert.match(e.log(), /public cert skipped/);
  assert.equal(await peerCN(e.TLS_PORT, "example.org"), "lan-mkcert");
});
