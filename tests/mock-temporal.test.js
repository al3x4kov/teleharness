// Demo data for Temporal (npm run demo / README media): every run state, files, and the
// waiting run that «Approve» walks to a result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockTemporal } from "../lib/mock-temporal.js";

function call(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL("http://localhost" + path);
    const res = { status: 0, headers: {}, body: "", writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(b) { this.body = String(b ?? ""); resolve(this); }, destroy() { resolve(this); } };
    const req = { method };
    const deps = { sendJson: (r, status, text) => { r.writeHead(status, { "content-type": "application/json" }); r.end(text); }, readBody: async () => body ?? {} };
    const handled = mockTemporal(req, res, url, url.pathname, deps);
    if (!handled) resolve(null);
  });
}
const json = async (m, p, b) => JSON.parse((await call(m, p, b)).body);

test("demo: capabilities with Claude, Codex and Gemini (ACP), runs in every state, one waiting for a decision", async () => {
  const caps = await json("GET", "/teleharness/api/temporal/capabilities");
  assert.equal(caps.pipelineAvailable, true); assert.deepEqual(caps.engines, ["claude", "codex", "acp", "opencode"]);
  const runs = await json("GET", "/teleharness/api/temporal/runs");
  const kinds = runs.map((r) => r.summary.kind);
  for (const k of ["wait", "run", "quota", "ok", "err", "cancel"]) assert(kinds.includes(k), k);
  assert.equal((await json("GET", "/teleharness/api/temporal/attention")).waiting, 1);
  const done = await json("GET", "/teleharness/api/temporal/runs/demo-run-done");
  assert.deepEqual(done.files.map((f) => f.name), ["notes.md", "review.md"]); assert(done.chats.notes);
  const file = await call("GET", "/teleharness/api/file?directory=" + encodeURIComponent(done.workspace) + "&path=" + encodeURIComponent(done.files[0].path));
  assert.match(file.body, /api-server 2\.8\.0/); assert.equal(Number(file.headers["content-length"]), Buffer.byteLength(file.body));
});
test("demo: Approve moves the waiting run on; reset replays it; unrelated paths are not handled", async () => {
  await json("POST", "/teleharness/api/temporal/runs/demo-run-wait/actions", { action: "reset" });
  assert.deepEqual((await json("GET", "/teleharness/api/temporal/runs/demo-run-wait")).state.pending, ["gate"]);
  await json("POST", "/teleharness/api/temporal/runs/demo-run-wait/actions", { action: "approve" });
  const after = await json("GET", "/teleharness/api/temporal/runs/demo-run-wait");
  assert.deepEqual(after.state.pending, []); assert.equal(after.state.steps.notes, "running");
  await json("POST", "/teleharness/api/temporal/runs/demo-run-wait/actions", { action: "reset" });
  assert.equal(await call("GET", "/teleharness/api/sessions"), null);
  assert.equal(await call("GET", "/teleharness/api/file?directory=/home/dev&path=a.txt"), null);
});
test("demo: finished runs offer resume options; resume seeds reused steps and links back (FEAT-19.32)", async () => {
  // The failed dependency run carries one completed step — resume from the approval step by default.
  const failed = await json("GET", "/teleharness/api/temporal/runs/demo-run-fail");
  assert.equal(failed.status, "FAILED");
  const opts = failed.resumeOptions?.versions ?? [];
  assert.equal(opts.length, 1); assert.equal(opts[0].isOriginal, true); assert(opts[0].available);
  assert.deepEqual(opts[0].reusableSteps, ["bump"]); assert.equal(opts[0].defaultFromStepId, "ok");

  const resumed = await json("POST", "/teleharness/api/temporal/runs/demo-run-fail/resume", { requestId: "99999999-9999-4999-8999-999999999999" });
  assert.equal(resumed.resumedFrom, "demo-run-fail");
  assert.equal(resumed.fromStepId, "ok"); assert.deepEqual(resumed.reusedSteps, ["bump"]);

  const detail = await json("GET", "/teleharness/api/temporal/runs/" + resumed.workflowId);
  assert.equal(detail.status, "RUNNING"); assert.equal(detail.state.steps.bump, "completed");
  assert.equal(detail.state.steps.ok, "running");
  assert.equal(detail.resumedFrom, "demo-run-fail"); assert.equal(detail.resumeFromStep, "ok");
  assert.deepEqual(detail.resumedSteps, ["bump"]);
  assert.equal(detail.resumeOptions, undefined);
  // The run list includes the resumed run.
  const runs = await json("GET", "/teleharness/api/temporal/runs");
  assert(runs.some((r) => r.workflowId === resumed.workflowId));
  // RUNNING runs and resumed runs do not offer resume; the completed run does.
  const done = await json("GET", "/teleharness/api/temporal/runs/demo-run-done");
  assert.equal(done.resumeOptions.versions.length, 1);
  assert.equal((await json("GET", "/teleharness/api/temporal/runs/demo-run-deps")).resumeOptions, undefined);
});

// 2.8.1: the demo shows the background-agent fixes of BUG-316/317/319.
test("demo 2.8.1 (BUG-319): triggers carry no maxActive; a stormy trigger clears its queue and logs queue_cleared", async () => {
  const list = await json("GET", "/teleharness/api/temporal/triggers");
  for (const tr of list) assert.equal("maxActive" in tr.limits, false, `${tr.id}: maxActive is gone`);
  const ci = list.find((tr) => tr.id === "demo-trig-ci");
  assert.equal(ci.queuedCount, 3);
  assert.ok(ci.stormAt, "the CI trigger is in a storm — the list banner and the card button depend on it");

  // New journal decisions of the release are visible on the CI trigger card.
  const journal = await json("GET", "/teleharness/api/temporal/triggers/demo-trig-ci/journal");
  for (const d of ["agent_loop", "push_reset", "queue_full", "started"]) assert.ok(journal.some((e) => e.decision === d), `journal has ${d}`);
  assert.deepEqual((await json("GET", "/teleharness/api/temporal/triggers/demo-trig-ci/journal?filter=skipped")).map((e) => e.decision), ["queue_full", "push_reset", "agent_loop"]);

  // «Clear queue»: running pipes stay, the storm flag drops, the journal gets queue_cleared.
  const cleared = await json("POST", "/teleharness/api/temporal/triggers/demo-trig-ci/queue/clear", {});
  assert.deepEqual(cleared, { ok: true, cleared: 3 });
  const after = await json("GET", "/teleharness/api/temporal/triggers/demo-trig-ci");
  assert.equal(after.queuedCount, 0);
  assert.equal(after.stormAt, null);
  assert.equal(after.activeCount, 1, "the running pipe is not cancelled by the queue clear");
  assert.equal((await json("GET", "/teleharness/api/temporal/triggers/demo-trig-ci/journal"))[0].decision, "queue_cleared");
  assert.deepEqual(await json("POST", "/teleharness/api/temporal/triggers/demo-trig-ci/queue/clear", {}), { ok: true, cleared: 0 });
  assert.equal((await call("POST", "/teleharness/api/temporal/triggers/no-such-trigger/queue/clear", {})).status, 404);

  // A trigger created in the demo starts with the same new shape.
  const made = await json("POST", "/teleharness/api/temporal/triggers", { definitionId: "demo-pipe", repo: "acme/api-server", kinds: ["issue_labeled"] });
  assert.equal("maxActive" in made.limits, false);
  assert.deepEqual([made.queuedCount, made.stormAt], [0, null]);
});

test("demo 2.8.1 (BUG-317): readiness blocks a folder whose origin differs from the chosen repository", async () => {
  const readiness = (body) => json("POST", "/teleharness/api/temporal/templates/task-to-pr/readiness", body);
  assert.deepEqual(await readiness({ directory: "/home/dev/projects/api-server", repo: "acme/api-server", engine: "claude" }), { ready: true, problems: [] });
  const bad = await readiness({ directory: "/home/dev/projects/api-server", repo: "acme/landing", engine: "claude" });
  assert.equal(bad.ready, false);
  assert.equal(bad.problems.length, 1);
  assert.equal(bad.problems[0].field, "directory");
  assert.equal(bad.problems[0].blocking, true);
  assert.match(bad.problems[0].message, /acme\/api-server/);
  assert.match(bad.problems[0].message, /acme\/landing/);
  // An unknown demo folder has no origin to compare — readiness stays neutral.
  assert.deepEqual(await readiness({ directory: "/srv/elsewhere", repo: "acme/landing", engine: "claude" }), { ready: true, problems: [] });
});
