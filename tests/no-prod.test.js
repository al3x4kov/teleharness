// Негативный контракт «тесты не трогают прод» (TASK-14.4, tests.md §3.6-25).
// Статическая проверка исходников тестов + юниты helper-ов изоляции.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeUrl, cleanEnv, isolatedServerEnv, makeTmpRoot } from "./helpers/env.mjs";
import { patchEdgeSource } from "./helpers/spawn-edge.mjs";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(TESTS).filter((f) => f.endsWith(".test.js"));
const src = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(TESTS, f), "utf8")]));
const spawnsServer = (s) => /spawn\([^)]*server\.js/.test(s.replace(/\s+/g, " ")) || /path\.join\(ROOT, "server\.js"\)/.test(s);

test("assertSafeUrl: прод/стенд-порты запрещены, эфемерные — нет", () => {
  for (const u of ["http://127.0.0.1:4096", "http://127.0.0.1:4170", "http://localhost:4172", "http://127.0.0.1:4097", "http://127.0.0.1:4196", "http://192.168.0.10/", "https://192.168.0.10/zai/"]) {
    assert.throws(() => assertSafeUrl(u), /прод|стенд/, u);
  }
  assert.equal(assertSafeUrl("http://127.0.0.1:53123"), "http://127.0.0.1:53123");
});

test("cleanEnv: переменные шелла ZAI_* не наследуются", () => {
  process.env.ZAI_UPSTREAM_LEAK_PROBE = "x";
  try {
    const env = cleanEnv({ A: 1 });
    assert.equal("ZAI_UPSTREAM_LEAK_PROBE" in env, false);
    assert.equal(Object.keys(env).some((k) => k.startsWith("ZAI_")), false);
    assert.equal(env.A, "1");
  } finally {
    delete process.env.ZAI_UPSTREAM_LEAK_PROBE;
  }
});

test("isolatedServerEnv: upstream обязателен для не-мока, все пути данных — в tmp", () => {
  const tmp = makeTmpRoot();
  try {
    assert.throws(() => isolatedServerEnv({ tmp }), /upstream обязателен/);
    assert.throws(() => isolatedServerEnv({ tmp, upstream: "http://127.0.0.1:4096" }), /прод/);
    const env = isolatedServerEnv({ tmp, mock: true });
    assert.notEqual(env.ZAI_UPSTREAM, "http://127.0.0.1:4096", "даже мок не смотрит в прод opencode");
    for (const k of ["ZAI_DATA_DIR", "ZAI_HOME", "ZAI_TENANT_HOME", "ZAI_TENANT_VAULT", "ZAI_LOG_DIR"]) {
      assert.ok(env[k].startsWith(tmp.root), `${k}=${env[k]}`);
    }
  } finally {
    tmp.cleanup();
  }
});

test("edge настраивается env-ом для тестов, либо (старый формат) прод-цели подменяются в копии", () => {
  const edge = readFileSync(path.join(TESTS, "..", "ops", "portal-server.js"), "utf8");
  if (/ZAI_EDGE_UPSTREAM/.test(edge)) {
    for (const k of ["ZAI_EDGE_UPSTREAM", "ZAI_EDGE_TV_UPSTREAM", "ZAI_EDGE_ROOT", "ZAI_EDGE_LOG_DIR", "TLS_PORT"]) assert.match(edge, new RegExp(k), k);
  }
  const legacy = 'const TV_API = { host: "127.0.0.1", port: 8099 };\nconst ZAI = { host: "127.0.0.1", port: 4170 };\nconst ROOT = "D:\\\\Portal";\n';
  const out = patchEdgeSource(legacy, { zaiPort: 50001, tvPort: 50002, staticRoot: "C:\\tmp\\x" });
  assert.doesNotMatch(out, /port:\s*4170\b/);
  assert.match(out, /port:\s*50001/);
  assert.throws(() => patchEdgeSource("const ZAI = { host: \"10.0.0.1\", port: 4170 };", { zaiPort: 1, tvPort: 2, staticRoot: "x" }), /не найден шаблон/);
});

test("каждый тест, спавнящий server.js, задаёт явный не-прод ZAI_UPSTREAM (или мок) и свой ZAI_DATA_DIR", () => {
  const bad = [];
  for (const [f, s] of Object.entries(src)) {
    if (!spawnsServer(s)) continue;
    const viaHelper = /spawnPortal\(/.test(s);
    const upstreamOk = viaHelper || /ZAI_UPSTREAM\s*:/.test(s);
    const dataOk = viaHelper || /ZAI_DATA_DIR\s*:/.test(s);
    if (!upstreamOk || !dataOk) bad.push(`${f}: upstream=${upstreamOk} data=${dataOk}`);
    assert.doesNotMatch(s, /ZAI_UPSTREAM\s*:\s*["'`]http:\/\/127\.0\.0\.1:(4096|4097|4170|4172|4196)/, f);
  }
  assert.deepEqual(bad, []);
});

// Остаток TASK-14.4: эти файлы (владельцы — Г1–Г5) ещё спавнят server.js с
// `...process.env` — наследуют ZAI_* шелла. Перевести на tests/helpers/spawn-server.mjs.
const inherit = Object.entries(src).filter(([, s]) => spawnsServer(s) && /\.\.\.process\.env/.test(s)).map(([f]) => f);
test(`спавны без наследования process.env (осталось: ${inherit.join(", ") || "—"})`, { todo: inherit.length ? "перевести на spawnPortal (TASK-14.4)" : false }, () => {
  assert.deepEqual(inherit, []);
});
