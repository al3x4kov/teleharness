// BUG-218 (SRV-05, design §2): имя загружаемого файла подбиралось по
// existsSync, а файл открывался отдельно — 20 параллельных загрузок одного
// имени получали один путь и затирали друг друга. Теперь файл создаётся
// эксклюзивно (openSync flag "wx", lib/attach.js openUnique) — при EEXIST
// берётся следующее имя. Образец server-тестов — tests/v2-server.test.js.
// Run: node --test --test-timeout=60000 tests/upload-race.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-upload-race-" + "5".repeat(24);
const NAME = "report.txt";
const PAYLOADS = Array.from({ length: 20 }, (_, i) => Buffer.from(`payload-${String(i).padStart(2, "0")}-${"x".repeat(i * 137)}`));

let up, srv;
const api = (p, opts = {}) =>
  fetch(srv.base + p, { ...opts, headers: { authorization: `Bearer ${ADMIN}`, ...(opts.headers ?? {}) } });

before(async () => {
  // НЕ мок: mockHandler перехватывает /upload и не касается диска.
  up = await startFakeOpencode();
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("20 параллельных загрузок одного имени — 20 разных файлов с целым содержимым", async () => {
  const dir = srv.tmp.home;
  const uploads = await Promise.all(
    PAYLOADS.map((buf) =>
      api(`/zai/api/upload?directory=${encodeURIComponent(dir)}&name=${NAME}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buf,
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  );
  const bad = uploads.filter((u) => u.status !== 200);
  assert.deepEqual(bad, [], `все загрузки должны пройти 200: ${JSON.stringify(bad)}`);

  const names = uploads.map((u) => u.body.name);
  assert.equal(new Set(names).size, names.length, "имена различны");
  const uploadDir = path.join(dir, ".zai-uploads");
  const onDisk = readdirSync(uploadDir).filter((f) => f.startsWith("report"));
  assert.equal(onDisk.length, 20, `в каталоге 20 файлов: ${onDisk.join(", ")}`);

  const contents = PAYLOADS.map((b) => b.toString("utf8")).sort();
  for (const [i, name] of names.entries()) {
    const got = readFileSync(path.join(uploadDir, name), "utf8");
    assert.ok(contents.includes(got), `содержимое ${name} целое и совпадает с одним из отправленных`);
  }
});
