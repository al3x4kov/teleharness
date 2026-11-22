// FEAT-20.3 (3.7, кр. 1): токен GitHub не встречается в ответах API, логах/ошибках,
// env модельного шага и истории/входах Temporal.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadKey, encrypt, decrypt, last4, redact } from "../lib/github/secrets.js";
import { connectionService } from "../lib/github/connections.js";
import { triggerService } from "../lib/github/triggers.js";
import { ghFetch, ghText } from "../lib/github/client.js";
import { githubRoutes } from "../routes/github.js";
import { triggerRoutes } from "../routes/temporal-triggers.js";
import { createDispatcher, cleanInputs, eventInputs } from "../lib/github/dispatch.js";
import { prStepRunner } from "../lib/temporal/pr-step.js";
import { projectPlan } from "../lib/temporal/prepare-bridge.js";
import { claudeTextAdapter } from "../lib/temporal/claude-text.js";
import { codexTextAdapter } from "../lib/temporal/codex-text.js";

const CANARY = "github_pat_" + "11CANARY_SECRET_TOKEN_9876543210_XYZW";
const git = (args, cwd) => execFileSync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });

function readJsonBody(req) {
  return new Promise((ok) => {
    const c = []; req.on("data", (d) => c.push(d));
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(c).toString("utf8") || "{}")); } catch { ok({}); } });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}

function matchPath(pattern, pathname) {
  if (pattern instanceof RegExp) {
    const m = pattern.exec(pathname);
    return m ? { match: m } : null;
  }
  const a = String(pattern).split("/"), b = pathname.split("/");
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

test("FEAT-20.3 3.7: канареечный токен не утекает в ответы API, ошибки клиента, push-ошибки, входы/план Temporal и env модельного шага", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-leak-"));
  const logs = [];
  const log = (m) => logs.push(String(m));
  let connections, store;
  try {
    const key = loadKey(dir);
    const secrets = { encrypt: (s) => encrypt(key, s), decrypt: (b) => decrypt(key, b), last4, redact };
    const dbPath = path.join(dir, "gh.sqlite");
    connections = connectionService(dbPath);
    store = triggerService(dbPath, { secrets });

    const routes = [
      ...githubRoutes({
        sendJson, readJsonBody, errLog: log, connections, secrets, log,
        check: async () => ({
          login: "octo", expiresAt: Date.now() + 86_400_000 * 30, etag: '"e1"',
          repos: [{ fullName: "octo/hello", private: true, permissions: { pull: true, push: true, admin: false } }],
        }),
      }),
      ...triggerRoutes({
        sendJson, readJsonBody, errLog: log, store, connections, secrets, log,
        pipelinesEnabled: () => true,
        publicUrl: "https://example.test",
        pipeOf: async () => ({ id: "00000000-0000-4000-8000-000000000001", name: "Задача → PR" }),
        cancelRun: async () => {},
      }),
    ];

    const srv = http.createServer(async (req, res) => {
      try {
        const user = { id: "u1", role: "admin" };
        const url = new URL(req.url, "http://localhost");
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = matchPath(r.path, url.pathname);
          if (!m) continue;
          await r.handler({ req, res, user, url, params: m, match: m.match });
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (e) {
        sendJson(res, 500, { error: String(e?.message ?? e) });
      }
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const apiBodies = [];
    const callApi = async (method, p, body) => {
      const r = await fetch(base + p, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      apiBodies.push({ p, status: r.status, text });
      return { status: r.status, text, data: JSON.parse(text) };
    };

    try {
      const putConn = await callApi("PUT", "/teleharness/api/github/connection", { token: CANARY });
      assert.equal(putConn.status, 200);
      assert.equal(putConn.data.tokenLast4, "XYZW");
      await callApi("GET", "/teleharness/api/github/connection");
      await callApi("POST", "/teleharness/api/github/connection/check");
      await callApi("GET", "/teleharness/api/github/repos");
      const created = await callApi("POST", "/teleharness/api/temporal/triggers", {
        definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: ["issue_labeled"],
      });
      assert.equal(created.status, 201);
      const tid = created.data.id;
      await callApi("GET", "/teleharness/api/temporal/triggers");
      await callApi("GET", `/teleharness/api/temporal/triggers/${tid}`);
      await callApi("GET", `/teleharness/api/temporal/triggers/${tid}/events`);
      await callApi("GET", "/teleharness/api/admin/background");
    } finally {
      srv.closeAllConnections?.(); srv.close();
    }

    for (const item of apiBodies) {
      assert.ok(!item.text.includes(CANARY), `токен утёк в API ${item.p}`);
    }
    const rawConn = connections.get("u1");
    assert.ok(rawConn.tokenEnc && !rawConn.tokenEnc.includes(CANARY), "в БД только шифротекст");

    // 2. Ошибки ghFetch / ghText маскируют канарейку даже при отражении апстримом.
    const reflectingFetch = async () => ({
      status: 403,
      headers: new Headers(),
      json: async () => ({ message: `Bad credentials for ${CANARY}` }),
      text: async () => `Bad credentials for ${CANARY}`,
    });
    await assert.rejects(
      () => ghFetch(CANARY, "/user", { fetchImpl: reflectingFetch }),
      (e) => !String(e.message).includes(CANARY) && String(e.message).includes("••••"),
    );
    await assert.rejects(
      () => ghText(CANARY, "/repos/octo/hello/actions/jobs/1/logs", { fetchImpl: reflectingFetch }),
      (e) => !String(e.message).includes(CANARY) && String(e.message).includes("••••"),
    );

    // 3. Ошибка git push (stderr с канарейкой) не утекает в ошибку шага PR.
    if (process.platform !== "win32") {
      const gdir = mkdtempSync(path.join(tmpdir(), "gh-leak-git-"));
      try {
        const origin = path.join(gdir, "origin.git");
        const seed = path.join(gdir, "seed");
        const work = path.join(gdir, "work");
        git(["init", "--bare", "-b", "main", origin]);
        git(["clone", origin, seed]);
        writeFileSync(path.join(seed, "a.txt"), "1\n");
        git(["add", "."], seed);
        git(["-c", "user.name=s", "-c", "user.email=s@x", "commit", "-m", "init"], seed);
        git(["push", "origin", "main"], seed);
        git(["clone", origin, work]);
        git(["checkout", "-b", "teleharness/leak-test"], work);
        writeFileSync(path.join(work, "b.txt"), "2\n");
        const hook = path.join(origin, "hooks", "pre-receive");
        writeFileSync(hook, ["#!/bin/sh", `echo "rejected with ${CANARY}" >&2`, "exit 1", ""].join("\n"), { mode: 0o755 });
        const runPr = prStepRunner({
          prepareWorktree: async () => ({ path: work, branch: "teleharness/leak-test", base: "main", untrusted: false }),
          gitAuthor: () => ({ name: "Владелец", email: "owner@teleharness.local" }),
          githubApi: async () => ({ status: 200, data: { default_branch: "main" } }),
          githubToken: () => CANARY,
          log,
        });
        await assert.rejects(
          () => runPr({
            user: { id: "u1" }, workflowId: "11430397-c55f-447e-a6d8-39b914a278ad",
            project: "/proj", workspace: "/proj/p", pipeName: "P", pipeSlug: "p",
            inputs: { repo: "octo/hello", number: 1 }, description: "desc", mode: "new",
          }),
          (e) => !String(e.message).includes(CANARY),
        );
      } finally {
        rmSync(gdir, { recursive: true, force: true });
      }
    }

    // 4. История/входы Temporal и план (projectPlan + cleanInputs): токен нигде не передаётся.
    const launchedPayloads = [];
    const dispatcher = createDispatcher({
      store, connections, log,
      launch: async (t, ev, reqId) => {
        const inputs = cleanInputs(ev, [{ name: "repo" }, { name: "title" }, { name: "body" }]);
        launchedPayloads.push({ t, inputs, reqId, allEventInputs: eventInputs(ev) });
        return { workflowId: "wf-leak-1" };
      },
    });
    const trig = store.list("u1")[0];
    await dispatcher.processDelivery({
      deliveryId: "d-leak-1", triggerId: trig.id, event: "issues",
      body: JSON.stringify({
        action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
        issue: { number: 1, title: "T", body: "B", html_url: "https://github.com/octo/hello/issues/1", user: { login: "octo" }, labels: [{ name: "agent" }] },
        label: { name: "agent" },
      }),
    });
    const plan = projectPlan({
      name: "Задача → PR", directory: "/p",
      inputs: [{ name: "repo", type: "text" }],
      steps: [
        { id: "solve", name: "Решить", type: "model", engine: "claude", model: "sonnet", instruction: "Fix", dependsOn: [], timeoutSeconds: 60, maxAttempts: 1 },
        { id: "pr", name: "Открыть PR", type: "pull_request", source: "solve", mode: "new", dependsOn: ["solve"] },
      ],
    });
    assert.ok(!JSON.stringify({ launchedPayloads, plan }).includes(CANARY), "токен не попадает в входы/план Temporal");

    // 5. env модельного шага (claude-text и codex-text): GH_TOKEN / GITHUB_TOKEN / TELEHARNESS_GIT_TOKEN / канарейка отсутствуют.
    const capturedEnvs = [];
    const artDir = path.join(dir, "artifacts");
    const claude = claudeTextAdapter({
      token: "oauth-sub-token", artifactDirectory: artDir, attested: true,
      run: async (_cmd, _args, opts) => { capturedEnvs.push(opts?.env ?? {}); return { stdout: JSON.stringify({ result: "ok" }) }; },
    });
    await claude.execute({
      user: { id: "u1" }, directory: dir, workflowId: "wf-1", stepId: "solve",
      model: claude.models[0], instruction: "Hi", timeoutSeconds: 10,
    });
    const codex = codexTextAdapter({
      models: ["gpt-5.4"], artifactDirectory: artDir, home: dir,
      run: async (_cmd, _args, opts) => {
        capturedEnvs.push(opts?.env ?? {});
        return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\n" };
      },
    });
    await codex.execute({
      user: { id: "u1" }, directory: dir, workflowId: "wf-1", stepId: "solve",
      model: "gpt-5.4", instruction: "Hi", timeoutSeconds: 10,
    });
    assert.equal(capturedEnvs.length, 2);
    for (const env of capturedEnvs) {
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.TELEHARNESS_GIT_TOKEN, undefined);
      assert.ok(!JSON.stringify(env).includes(CANARY), "токен не попадает в env модельного шага");
    }

    // 6. Логи сервера не содержат канарейку.
    assert.ok(!logs.join("\n").includes(CANARY), "токен не попадает в логи");
  } finally {
    store?.close?.(); connections?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
