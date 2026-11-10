// Edge ops/portal-server.js — маршрутизация /zai и HTTPS-only (TASK-14.8, Г7;
// BUG-001, BUG-002/08.7; TC-INF-001/002). Статические обходы (allow-list,
// ADS/8.3/регистр, битые URL), ADR-009 и access-log — в tests/edge.test.js (Г1);
// здесь — то, чего там нет: 308 на https, ca.pem по http, регистр ID сессий,
// /zai/data уходит в портал, SSE без буферизации.
// Экземпляр edge — tests/helpers/spawn-edge.mjs (свободные порты, фейковые
// бэкенды, свой static root и лог; прод :80/:443/:4170 не трогается).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnEdge } from "./helpers/spawn-edge.mjs";

// tlsEdge — HTTPS-only (сертификаты ops/certs, только чтение); plain — без TLS.
const [tlsEdge, plain] = await Promise.all([spawnEdge({ tls: true }), spawnEdge({ tls: false })]);
after(async () => {
  await Promise.all([tlsEdge?.stop(), plain?.stop()]);
});

const noTls = tlsEdge.tlsActive ? false : "нет ops/certs — HTTPS-only не проверить";

test("http /zai/* → 308 на https, путь и query сохранены", { skip: noTls }, async () => {
  const r = await tlsEdge.request("/zai/api/session?x=1");
  assert.equal(r.status, 308);
  assert.equal(r.headers.location, "https://192.168.0.10/zai/api/session?x=1");
});

test("http POST /zai/* → 308 (метод сохраняется), до бэкенда не доходит", { skip: noTls }, async () => {
  const before = tlsEdge.backend.requests.length;
  const r = await tlsEdge.request("/zai/api/session", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(r.status, 308);
  assert.equal(tlsEdge.backend.requests.length, before);
});

test("http /ZAI, /Zai/… — то же правило 308 (BUG-001)", { skip: noTls }, async () => {
  for (const p of ["/ZAI/", "/Zai/api/session", "/zAi"]) {
    const r = await tlsEdge.request(p);
    assert.equal(r.status, 308, p);
    assert.match(r.headers.location, /^https:\/\//, p);
  }
});

test("http /zai/ca.pem — 200 без редиректа (бутстрап устройства)", { skip: noTls }, async () => {
  const r = await tlsEdge.request("/zai/ca.pem");
  assert.equal(r.status, 200);
  assert.match(r.body, /TEST-CA/);
  assert.equal(r.headers["content-type"], "application/x-x509-ca-cert");
});

test("https /zai → 308 /zai/; https /zai/ проксируется с HSTS", { skip: noTls }, async () => {
  const r1 = await tlsEdge.request("/zai", { https: true });
  assert.equal(r1.status, 308);
  assert.equal(r1.headers.location, "/zai/");
  const r2 = await tlsEdge.request("/zai/", { https: true });
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body).backend, "zai");
  assert.match(r2.headers["strict-transport-security"] ?? "", /max-age/);
});

test("ID сессии в смешанном регистре доходит до портала без изменений (BUG-002)", async () => {
  const r = await plain.request("/zai/api/session/ses_AbCdEf123XyZ/message?directory=D%3A%5CProj");
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).url, "/zai/api/session/ses_AbCdEf123XyZ/message?directory=D%3A%5CProj");
});

test("/ZAI/… нормализует только префикс; хвост пути сохраняет регистр", async () => {
  const r = await plain.request("/ZAI/api/session/ses_MiXeD");
  assert.equal(JSON.parse(r.body).url, "/zai/api/session/ses_MiXeD");
});

test("/zai/data/* и регистровые/процентные варианты уходят в портал, файлом не отдаются", async () => {
  for (const p of ["/zai/data/admin-token.txt", "/ZAI/data/admin-token.txt", "/Zai/%64ata/admin-token.txt"]) {
    const r = await plain.request(p);
    assert.doesNotMatch(r.body, /SECRET/, p);
    assert.equal(JSON.parse(r.body).backend, "zai", p);
  }
});

test("служебные деревья стенда/QA — 404 в любом регистре", async () => {
  for (const p of ["/zai-stage/stand.cmd", "/ZAI-STAGE/stand.cmd", "/Zai-Stage/stand.cmd", "/zai-stage%20/stand.cmd", "/zai-qa/report.json"]) {
    const r = await plain.request(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /SECRET/, p);
  }
});

test("SSE через edge не буферизуется: первый кадр приходит до второго", async () => {
  const res = await plain.request("/zai/api/event", { raw: true });
  assert.equal(res.headers["content-type"], "text/event-stream");
  const first = await new Promise((resolve, reject) => {
    res.once("data", (c) => resolve(String(c)));
    res.once("error", reject);
  });
  assert.match(first, /data: first/);
  assert.doesNotMatch(first, /second/, "второй кадр пришёл склеенным — edge буферизует SSE");
  res.destroy();
});
