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

test("demo: capabilities with Claude and Codex, runs in every state, one waiting for a decision", async () => {
  const caps = await json("GET", "/teleharness/api/temporal/capabilities");
  assert.equal(caps.pipelineAvailable, true); assert.deepEqual(caps.engines, ["claude", "codex"]);
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
