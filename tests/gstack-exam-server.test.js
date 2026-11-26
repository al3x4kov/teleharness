// @suite server
// регрессия 5 серверных дефектов из полного QA-экзамена gstack:
// - ISSUE-001: PATCH /temporal/triggers/:id {enabled:true} для тенанта на Claude-пайпе → 403;
//              POST /temporal/triggers с явным spec.version (Claude) при non-Claude latest → 403;
//              defense-in-depth в launch() при запуске Claude-пайпа не-админом.
// - ISSUE-002: GET /review/chat/%E0%A4%A → 400 (без неперехваченного URIError 500).
// - ISSUE-008: PATCH /session/:id при upstream 404 не мутирует data/session-titles.json.
// - ISSUE-013: POST /auth/pair/claim при теле > 4 КБ → 413, при битом JSON → 400.
// - ISSUE-014: GET /costs/chat/<неизвестный_sid> под тенантом без записей в ledger → 404.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "exam-srv-admin-" + "b".repeat(40);
let up, srv, tenant, repoDir;

function api(route, { token = ADMIN, method = "GET", body, rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  return fetch(srv.base + route, {
    method,
    headers: h,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  up = await startFakeOpencode();
  srv = await spawnPortal({
    upstream: up.url,
    env: {
      TELEHARNESS_ADMIN_TOKEN: ADMIN,
      TELEHARNESS_TEMPORAL_PIPELINES: "1",
      TELEHARNESS_PUBLIC_URL: "http://127.0.0.1:1/teleharness/",
    },
  });
  const res = await api("/teleharness/api/admin/users", { method: "POST", body: { name: "exam-tenant" } });
  assert.equal(res.status, 201);
  tenant = await res.json();
  repoDir = path.join(tenant.user.directories[0], "demo-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/octo/demo.git"], { cwd: repoDir });
  const p = await api(`/teleharness/api/admin/users/${tenant.user.id}`, { method: "PATCH", body: { directories: [repoDir] } });
  assert.equal(p.status, 200);
});

after(async () => {
  await srv?.stop();
  await up?.close();
});

test("/ ISSUE-001: тенант не может создать триггер на явную Claude-версию (POST) и включить его через PATCH {enabled:true}", async () => {
  // v1: шаг с engine=claude; v2 (latest): шаг без Claude (approval).
  // Создадим пайп под тенантом как opencode, затем подменим v1→claude через admin или создадим с v1=claude (опубликовать пайп с claude тенант может? проверим!).
  const v1Draft = {
    name: "ExamPipe",
    directory: repoDir,
    inputs: [],
    steps: [{ id: "s1", name: "Сделай", type: "model", engine: "opencode", model: "zai-coding-plan/glm-5.3", instruction: "ok", dependsOn: [], timeoutSeconds: 60, maxAttempts: 1 }],
  };
  const cr = await api("/teleharness/api/temporal/definitions", { token: tenant.token, method: "POST", body: { draft: v1Draft } });
  assert.equal(cr.status, 201, await cr.clone().text());
  const def = await cr.json();
  const defId = def.id;
  let rev = def.revision;
  // Опубликуем v1 (opencode) и создадим триггер (initially disabled by store.create).
  const pub1 = await api(`/teleharness/api/temporal/definitions/${defId}/publish`, { token: tenant.token, method: "POST", body: { revision: rev } });
  assert.equal(pub1.status, 200, await pub1.clone().text());
  rev = (await pub1.json()).revision;

  const tr = await api("/teleharness/api/temporal/triggers", {
    token: tenant.token,
    method: "POST",
    body: { definitionId: defId, version: null, repo: "octo/demo", kinds: ["issue_labeled"], filters: { labels: ["agent"] }, delivery: "poll" },
  });
  assert.equal(tr.status, 201, await tr.clone().text());
  const trigger = await tr.json();

  // Обновляем v2 на шаг Claude (при необходимости временно выдаём движок claude тенанту для публикации версии, затем отбираем).
  const claudeDraft = {
    name: "ExamPipe",
    directory: repoDir,
    inputs: [],
    steps: [{ id: "s1", name: "ClaudeStep", type: "model", engine: "claude", model: "claude-sonnet-4-6", instruction: "hi", dependsOn: [], timeoutSeconds: 60, maxAttempts: 1 }],
  };
  const updV2 = await api(`/teleharness/api/temporal/definitions/${defId}`, {
    token: tenant.token,
    method: "PUT",
    body: { revision: rev, draft: claudeDraft },
  });
  let grantedTemp = false;
  if (updV2.status === 403) {
    grantedTemp = true;
    await api(`/teleharness/api/admin/users/${tenant.user.id}`, { method: "PATCH", body: { engines: ["opencode", "claude"] } });
    const upd2 = await api(`/teleharness/api/temporal/definitions/${defId}`, {
      token: tenant.token,
      method: "PUT",
      body: { revision: rev, draft: claudeDraft },
    });
    assert.equal(upd2.status, 200, await upd2.clone().text());
    rev = (await upd2.json()).revision;
  } else {
    assert.equal(updV2.status, 200, await updV2.clone().text());
    rev = (await updV2.json()).revision;
  }
  const pub2 = await api(`/teleharness/api/temporal/definitions/${defId}/publish`, { token: tenant.token, method: "POST", body: { revision: rev } });
  assert.equal(pub2.status, 200, await pub2.clone().text());
  rev = (await pub2.json()).revision;
  if (grantedTemp) {
    await api(`/teleharness/api/admin/users/${tenant.user.id}`, { method: "PATCH", body: { engines: ["opencode"] } });
  }

  // Сценарий A: v2 (latest) использует Claude; триггер имеет version=null → PATCH { enabled: true } обязан вернуть 403!
  const patchOn = await api(`/teleharness/api/temporal/triggers/${trigger.id}`, {
    token: tenant.token,
    method: "PATCH",
    body: { enabled: true },
  });
  assert.equal(patchOn.status, 403, `PATCH {enabled:true} на Claude-пайпе должен вернуть 403, пришло ${patchOn.status}`);

  // Сценарий B: публикуем v3 (approval — без Claude), чтобы latest стал без Claude, а v2 остался с Claude.
  const updV3 = await api(`/teleharness/api/temporal/definitions/${defId}`, {
    token: tenant.token,
    method: "PUT",
    body: {
      revision: rev,
      draft: {
        name: "ExamPipe",
        directory: repoDir,
        inputs: [],
        steps: [{ id: "w", name: "Одобрение", type: "approval", dependsOn: [] }],
      },
    },
  });
  assert.equal(updV3.status, 200, await updV3.clone().text());
  rev = (await updV3.json()).revision;
  const pub3 = await api(`/teleharness/api/temporal/definitions/${defId}/publish`, { token: tenant.token, method: "POST", body: { revision: rev } });
  assert.equal(pub3.status, 200, await pub3.clone().text());

  // POST с явным version: 2 (Claude) при non-Claude latest (v3) обязан вернуть 403!
  const postV2 = await api("/teleharness/api/temporal/triggers", {
    token: tenant.token,
    method: "POST",
    body: { definitionId: defId, version: 2, repo: "octo/demo", kinds: ["issue_labeled"], filters: { labels: ["agent"] }, delivery: "poll" },
  });
  assert.equal(postV2.status, 403, `POST с явным version=2 (Claude) должен вернуть 403, пришло ${postV2.status}`);
});

test("/ ISSUE-002: GET /teleharness/api/review/chat/%E0%A4%A возвращает 400, не 500", async () => {
  const res = await api("/teleharness/api/review/chat/%E0%A4%A");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test("/ ISSUE-008: PATCH /teleharness/api/session/<missing> при 404 от upstream не мутирует data/session-titles.json", async () => {
  const titlesPath = path.join(srv.env.TELEHARNESS_DATA_DIR, "session-titles.json");
  const before = existsSync(titlesPath) ? readFileSync(titlesPath, "utf8") : null;
  const res = await api("/teleharness/api/session/ses_missing_404_check", {
    method: "PATCH",
    body: { title: "Should Not Persist" },
  });
  assert.equal(res.status, 404);
  const after = existsSync(titlesPath) ? readFileSync(titlesPath, "utf8") : null;
  if (after !== null) {
    assert.equal(after.includes("ses_missing_404_check"), false, "session-titles.json не должен содержать несуществующую сессию после 404");
    assert.equal(after, before);
  }
});

test("/ ISSUE-013: POST /teleharness/api/auth/pair/claim с телом > 4 КБ → 413, с битым JSON → 400", async () => {
  const big = JSON.stringify({ code: "x".repeat(5000) });
  const rBig = await api("/teleharness/api/auth/pair/claim", {
    token: null,
    method: "POST",
    rawBody: big,
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.13.1" },
  });
  assert.equal(rBig.status, 413, `Ожидалось 413 при >4КБ, пришло ${rBig.status}`);

  const rBad = await api("/teleharness/api/auth/pair/claim", {
    token: null,
    method: "POST",
    rawBody: "{not-json",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.13.2" },
  });
  assert.equal(rBad.status, 400, `Ожидалось 400 при битом JSON, пришло ${rBad.status}`);
});

test("/ ISSUE-014: GET /teleharness/api/costs/chat/<неизвестный_sid> под тенантом без записей в ledger → 404", async () => {
  const res = await api("/teleharness/api/costs/chat/ses_unknown_tenant_cost", { token: tenant.token });
  assert.equal(res.status, 404, `Ожидалось 404 для неизвестного чата под тенантом, пришло ${res.status}`);
});
