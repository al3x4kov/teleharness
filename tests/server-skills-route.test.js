// @suite: server
// FEAT-20.37 (полоса A): GET /teleharness/api/skills — каталог скиллов папки
// (routes/catalog.js fetchSkills + lib/oc-client.js skills). REAL server.js
// против фейка opencode, по образцу tests/mcp-route-server.test.js: папка по
// умолчанию (не голый cwd serve), повтор пустого ответа холодного экземпляра,
// читаемый 503, тенанту — только teleharness-* без path.
// Run: node --test --test-concurrency=1 tests/server-skills-route.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import os from "node:os";
import path from "node:path";

const ADMIN = "a".repeat(24) + "-skills-" + "5".repeat(24);
// Как живой 2.2.6: name ≠ id у встроенных; content — тело SKILL.md, которое
// сервер обязан срезать (design §5).
const SKILLS = [
  { id: "teleharness-xlsx", name: "teleharness-xlsx", description: "Excel-файлы", path: "/skills/teleharness-xlsx/SKILL.md", content: "---\nname: teleharness-xlsx\n---\n# Excel\nДелай таблицы с формулами." },
  { id: "teleharness-docs", name: "teleharness-docs", description: "Документы", path: "/skills/teleharness-docs/SKILL.md" },
  { id: "opencode", name: "OpenCode", description: "встроенный", path: "skill://opencode/SKILL.md", content: "X".repeat(4096) },
];
let up, srv, tenant;
let mode = "wrapped"; // wrapped | bare | cold | empty | html | broken
let calls = 0;
const seen = [];
const api = (p, token = ADMIN) => fetch(srv.base + p, { headers: { authorization: `Bearer ${token}` } });

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/skill", (req, body, url) => {
    calls++;
    seen.push(url.searchParams.get("location[directory]")); // FEAT-20.37: только deepObject
    if (mode === "broken") return { status: 500, text: "boom" };
    if (mode === "html") return { status: 200, text: "<!doctype html><html><body>SPA</body></html>" };
    if (mode === "empty") return { json: { location: { directory: seen.at(-1) }, data: [] } };
    if (mode === "bare") return { json: SKILLS }; // голый массив (терпимый unwrap)
    if (mode === "cold" && calls === 1) return { json: { location: { directory: seen.at(-1) }, data: [] } }; // реестр ещё грузится
    return { json: { location: { directory: seen.at(-1) }, data: SKILLS } }; // обёртка живого 2.2.6
  });
  srv = await spawnPortal({ upstream: up.url, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN } });
  const r = await fetch(srv.base + "/teleharness/api/admin/users", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "skillt" }) });
  tenant = await r.json();
  assert.ok(tenant.token);
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("admin без ?directory=: upstream получил location[directory] папки по умолчанию, 200 и нормализованный список", async () => {
  mode = "wrapped";
  calls = 0;
  seen.length = 0;
  const r = await api("/teleharness/api/skills");
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual(body.map((s) => ({ id: s.id, name: s.name, description: s.description, path: s.path })), [
    { id: "teleharness-xlsx", name: "teleharness-xlsx", description: "Excel-файлы", path: "/skills/teleharness-xlsx/SKILL.md" },
    { id: "teleharness-docs", name: "teleharness-docs", description: "Документы", path: "/skills/teleharness-docs/SKILL.md" },
    { id: "opencode", name: "OpenCode", description: "встроенный", path: "skill://opencode/SKILL.md" },
  ]);
  assert.ok(seen.length > 0 && seen.every((d) => d), `каждый запрос зовёт location[directory]: ${JSON.stringify(seen)}`);
  assert.equal(seen[0], srv.env.TELEHARNESS_CHAT_DIR, "по умолчанию спрашивается папка чатов, не cwd serve");
  assert.ok(body.every((s) => !("content" in s)), "content (тела SKILL.md) не едет клиенту");
});

test("admin: явный ?directory= доезжает до upstream дословно", async () => {
  mode = "wrapped";
  seen.length = 0;
  const dir = path.join(os.tmpdir(), "teleharness-skills-project");
  const r = await api(`/teleharness/api/skills?directory=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1), dir);
});

test("обёртка {location,data} живого 2.2.6 и голый массив разбираются одинаково", async () => {
  mode = "wrapped";
  let r = await api("/teleharness/api/skills");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).length, 3, "обёртка {location, data:[…]} разобрана");
  mode = "bare";
  r = await api("/teleharness/api/skills");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).length, 3, "голый массив разобран тоже");
});

test("тенант: только teleharness-* (по id), без path, с id/name/description; спрашивается его папка", async () => {
  mode = "wrapped";
  seen.length = 0;
  const r = await api("/teleharness/api/skills", tenant.token);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual(body.map((s) => ({ id: s.id, name: s.name, description: s.description })), [
    { id: "teleharness-xlsx", name: "teleharness-xlsx", description: "Excel-файлы" },
    { id: "teleharness-docs", name: "teleharness-docs", description: "Документы" },
  ]);
  assert.ok(body.every((s) => !("path" in s) && !("content" in s)), "тенанту path и content не ехали");
  assert.ok(seen.at(-1) && /skillt/i.test(seen.at(-1)), `папка тенанта: ${seen.at(-1)}`);
});

test("холодный экземпляр: первый ответ data:[] → повтор (~700 мс) → 200 непустой", async () => {
  mode = "cold";
  calls = 0;
  const r = await api("/teleharness/api/skills");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).length, 3);
  assert.equal(calls, 2, "пустой ответ перенесён ровно один раз");
});

test("валидный пустой data:[] на обе попытки → 200 [] (не 503)", async () => {
  mode = "empty";
  calls = 0;
  const r = await api("/teleharness/api/skills");
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), []);
  assert.equal(calls, 2, "пустой ответ перепроверен один раз, но остался валидным 200 []");
});

test("upstream 200 HTML вместо JSON → 503 skills_unavailable", async () => {
  mode = "html";
  calls = 0;
  const r = await api("/teleharness/api/skills");
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.code, "skills_unavailable");
  assert.equal(calls, 2);
});

test("upstream 500 на обе попытки → читаемый 503 skills_unavailable", async () => {
  mode = "broken";
  for (const token of [ADMIN, tenant.token]) {
    calls = 0;
    const r = await api("/teleharness/api/skills", token);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.code, "skills_unavailable");
    assert.match(j.error, /Skills/i);
    assert.equal(calls, 2, "ошибка upstream тоже повторяется один раз");
  }
});

// ---- FEAT-20.38: GET /teleharness/api/skills/:id (детали и тело SKILL.md) ----------

test("FEAT-20.38 admin: GET /teleharness/api/skills/:id отдаёт content и path (по id и по name, с ?directory=)", async () => {
  mode = "wrapped";
  seen.length = 0;
  const dir = path.join(os.tmpdir(), "teleharness-skill-detail-dir");
  const r1 = await api(`/teleharness/api/skills/teleharness-xlsx?directory=${encodeURIComponent(dir)}`);
  assert.equal(r1.status, 200, await r1.clone().text());
  const b1 = await r1.json();
  assert.equal(b1.id, "teleharness-xlsx");
  assert.equal(b1.name, "teleharness-xlsx");
  assert.equal(b1.description, "Excel-файлы");
  assert.equal(b1.path, "/skills/teleharness-xlsx/SKILL.md");
  assert.match(b1.content, /Делай таблицы с формулами/);
  assert.equal(seen.at(-1), dir, "?directory= admin передан в upstream");

  // По name (у встроенных name !== id: OpenCode / opencode)
  const r2 = await api("/teleharness/api/skills/OpenCode");
  assert.equal(r2.status, 200);
  const b2 = await r2.json();
  assert.equal(b2.id, "opencode");
  assert.equal(b2.name, "OpenCode");
  assert.equal(b2.content.length, 4096);
  assert.equal(b2.path, "skill://opencode/SKILL.md");
});

test("FEAT-20.38 тенант: teleharness-* отдаёт content без path и игнорирует ?directory=; не-teleharness-* → 403 без похода в upstream", async () => {
  mode = "wrapped";
  calls = 0;
  seen.length = 0;
  const foreignDir = path.join(os.tmpdir(), "foreign-dir");
  const rOk = await api(`/teleharness/api/skills/teleharness-xlsx?directory=${encodeURIComponent(foreignDir)}`, tenant.token);
  assert.equal(rOk.status, 200, await rOk.clone().text());
  const ok = await rOk.json();
  assert.equal(ok.id, "teleharness-xlsx");
  assert.match(ok.content, /Делай таблицы с формулами/);
  assert.ok(!("path" in ok), "решение 2А: тенанту path не отдаётся");
  assert.ok(seen.at(-1) && /skillt/i.test(seen.at(-1)), "чужой ?directory= игнорируется");

  calls = 0;
  const rDeny = await api("/teleharness/api/skills/opencode", tenant.token);
  assert.equal(rDeny.status, 403);
  const deny = await rDeny.json();
  assert.equal(deny.code, "skill_forbidden");
  assert.equal(calls, 0, "отказ 403 до обращения к upstream (не раскрываем существование)");

  const rMiss = await api("/teleharness/api/skills/teleharness-nonexistent", tenant.token);
  assert.equal(rMiss.status, 404);
  assert.equal((await rMiss.json()).code, "skill_not_found");
});

test("FEAT-20.38: 404 на отсутствующий, 400 на битый URI, 503 на сломанный upstream", async () => {
  mode = "wrapped";
  const r404 = await api("/teleharness/api/skills/no-such-skill");
  assert.equal(r404.status, 404);
  assert.equal((await r404.json()).code, "skill_not_found");

  const r400 = await api("/teleharness/api/skills/%E0%A4%A");
  assert.equal(r400.status, 400);
  assert.equal((await r400.json()).code, "invalid_skill_id");

  mode = "broken";
  const r503 = await api("/teleharness/api/skills/teleharness-xlsx");
  assert.equal(r503.status, 503);
  assert.equal((await r503.json()).code, "skills_unavailable");
});
