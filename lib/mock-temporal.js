// Demo data for Temporal pipelines (npm run demo, README screenshots). In-memory only:
// a few pipes in the demo projects, runs in every state, schedules, and a run that waits
// for a decision — «Approve» walks it to a result with files within a few seconds.
const WS = "/home/dev/projects/api-server/pipelines/nightly-pr-review";
const NOW = () => Date.now();
const iso = (msAgo) => new Date(NOW() - msAgo).toISOString();
const MIN = 60_000, H = 60 * MIN;

const REVIEW = `**Diff review — feature/token-refresh (+186 −74, 6 files)**

- \`token.ts\`: refresh is atomic now — good. The 5-minute skew constant should be configurable.
- \`session.ts\`: the cookie is renewed together with the token. ✅
- Missing test for an expired refresh token → added a note to the release.
- No breaking API changes.

Recommendation: **approve**, ship with the skew constant in config.`;
const NOTES = `## api-server 2.8.0

### Changed
- Auth tokens refresh atomically; the session cookie is renewed with the token.
- Token checks moved into \`token.ts\`.

### Fixed
- A request racing a refresh no longer gets a 401.

### Upgrade notes
- New optional setting \`AUTH_REFRESH_SKEW_SECONDS\` (default 300).`;
const SCORE = "8/10 — clear and specific; consider naming the version in the title.";

const STEPS_REVIEW = [
  { id: "review", name: "Review the diff", type: "model", engine: "claude", model: "claude-sonnet-5-5" },
  { id: "gate", name: "Approve the review", type: "approval" },
  { id: "notes", name: "Write release notes", type: "model", engine: "codex", model: "gpt-6.1-sol" },
  { id: "save", name: "Save notes.md", type: "artifact", filename: "notes.md", source: "notes" },
];
const DEF_REVIEW = {
  name: "Nightly PR review", directory: "/home/dev/projects/api-server",
  inputs: [{ name: "branch", type: "string", required: true }],
  steps: [
    { id: "review", type: "model", name: "Review the diff", engine: "claude", model: "claude-sonnet-5-5", instruction: "Review the diff of {{input.branch}} against main: risks, missing tests, breaking changes. End with a recommendation.", timeoutSeconds: 900, maxAttempts: 2, dependsOn: [] },
    { id: "gate", type: "approval", name: "Approve the review", dependsOn: ["review"] },
    { id: "notes", type: "model", name: "Write release notes", engine: "codex", model: "gpt-6.1-sol", instruction: "Write release notes for {{input.branch}} from this review: {{steps.review}}", timeoutSeconds: 600, maxAttempts: 1, dependsOn: ["gate"] },
    { id: "save", type: "artifact", name: "Save notes.md", source: "notes", filename: "notes.md", dependsOn: ["notes"] },
  ],
};
const DEF_DEPS = {
  name: "Dependency update", directory: "/home/dev/projects/landing", inputs: [],
  steps: [
    { id: "bump", type: "model", name: "Bump minor versions and run tests", engine: "codex", model: "gpt-6.1-sol", instruction: "Update minor and patch versions, run the tests, summarize what changed.", timeoutSeconds: 1800, maxAttempts: 1, dependsOn: [] },
    { id: "ok", type: "approval", name: "Merge the update?", dependsOn: ["bump"] },
  ],
};
const DEF_FLAKY = {
  name: "Flaky test triage", directory: "/home/dev/projects/api-server", inputs: [],
  steps: [
    { id: "find", type: "model", name: "Find flaky tests in CI logs", engine: "claude", model: "claude-haiku-4-5", instruction: "Read the last 20 CI logs and list tests that both passed and failed. Answer YES if any.", timeoutSeconds: 600, maxAttempts: 1, dependsOn: [] },
    { id: "any", type: "condition", name: "If any were found", check: { source: "step", ref: "find", op: "contains", value: "YES" }, dependsOn: ["find"] },
    { id: "fix", type: "model", name: "Propose fixes", engine: "codex", model: "gpt-6.1-sol", instruction: "Propose a fix for each flaky test: {{steps.find}}", timeoutSeconds: 900, maxAttempts: 1, dependsOn: ["any"] },
  ],
};
const PIPES = [
  { id: "11111111-1111-4111-8111-111111111111", def: DEF_REVIEW, slug: "nightly-pr-review", versions: 3, updated: 2 * H },
  { id: "22222222-2222-4222-8222-222222222222", def: DEF_DEPS, slug: "dependency-update", versions: 1, updated: 26 * H },
  { id: "33333333-3333-4333-8333-333333333333", def: DEF_FLAKY, slug: "flaky-test-triage", versions: 2, updated: 50 * H },
];
const shape = (def) => def.steps.map((s) => ({ id: s.id, name: s.name, type: s.type, ...(s.engine ? { engine: s.engine, model: s.model } : {}), ...(s.filename ? { filename: s.filename, source: s.source } : {}), ...(s.check ? { check: s.check } : {}) }));
const record = (p) => ({ id: p.id, owner: "admin", revision: p.versions + 1, slug: p.slug, folder: "pipelines/" + p.slug, draft: p.def,
  versions: Array.from({ length: p.versions }, (_, i) => ({ version: i + 1, definition: p.def, publishedAt: iso(p.updated + (p.versions - i) * H) })) });

// demo state: the waiting run moves on after «Approve»
let approvedAt = null;
const RUNS = () => {
  const after = approvedAt ? NOW() - approvedAt : null;
  const waitRun = { id: "demo-run-wait", pipe: PIPES[0], version: 3, source: "manual", start: 9 * MIN, inputs: { branch: "feature/token-refresh" } };
  if (after == null) Object.assign(waitRun, { status: "RUNNING", steps: { review: "completed", gate: "running", notes: "waiting", save: "waiting" }, pending: ["gate"], results: ["review"], chats: { review: "ses_demo_auth_refactor" } });
  else if (after < 5000) Object.assign(waitRun, { status: "RUNNING", steps: { review: "completed", gate: "completed", notes: "running", save: "waiting" }, pending: [], results: ["review"], chats: { review: "ses_demo_auth_refactor", notes: "ses_demo_codex_flaky_test" } });
  else Object.assign(waitRun, { status: "COMPLETED", close: Math.max(0, 9 * MIN - after - 40_000), steps: { review: "completed", gate: "completed", notes: "completed", save: "completed" }, pending: [], results: ["review", "notes"], chats: { review: "ses_demo_auth_refactor", notes: "ses_demo_codex_flaky_test" }, files: true });
  return [
    waitRun,
    { id: "demo-run-deps", pipe: PIPES[1], version: 1, source: "schedule", start: 3 * MIN, status: "RUNNING", steps: { bump: "running", ok: "waiting" }, pending: [], results: [], chats: { bump: "ses_demo_vite6" } },
    { id: "demo-run-flaky", pipe: PIPES[2], version: 2, source: "schedule", start: 72 * MIN, status: "RUNNING", steps: { find: "quota_wait", any: "waiting", fix: "waiting" }, pending: [], results: [], waitReasons: { find: "quota_wait" } },
    { id: "demo-run-done", pipe: PIPES[0], version: 3, source: "manual", start: 20 * H, close: 20 * H - 11 * MIN, status: "COMPLETED", steps: { review: "completed", gate: "completed", notes: "completed", save: "completed" }, pending: [], results: ["review", "notes"], chats: { review: "ses_demo_auth_refactor", notes: "ses_demo_codex_flaky_test" }, files: true, inputs: { branch: "feature/rate-limits" } },
    { id: "demo-run-skip", pipe: PIPES[2], version: 2, source: "schedule", start: 26 * H, close: 26 * H - 2 * MIN, status: "COMPLETED", steps: { find: "completed", any: "completed", fix: "skipped" }, conditions: { any: false }, pending: [], results: ["find"] },
    { id: "demo-run-fail", pipe: PIPES[1], version: 1, source: "schedule", start: 27 * H, close: 27 * H - 30 * MIN, status: "FAILED", steps: { bump: "running", ok: "waiting" }, pending: [], results: [] },
    { id: "demo-run-cancel", pipe: PIPES[0], version: 2, source: "manual", start: 49 * H, close: 49 * H - 3 * MIN, status: "CANCELED", steps: { review: "running", gate: "waiting", notes: "waiting", save: "waiting" }, pending: [], results: [] },
  ];
};
function summary(r) {
  const steps = shape(r.pipe.def);
  const at = (id) => { const i = steps.findIndex((s) => s.id === id); return i < 0 ? null : { id, name: steps[i].name, type: steps[i].type, index: i + 1 }; };
  const cur = steps.find((s) => r.steps[s.id] === "quota_wait") ?? steps.find((s) => r.pending.includes(s.id)) ?? steps.find((s) => r.steps[s.id] === "running");
  const base = { stepsTotal: steps.length, status: r.status, startTime: iso(r.start), closeTime: r.close != null ? iso(r.close) : null, paused: false, waitReasons: r.waitReasons ?? {}, done: steps.filter((s) => r.steps[s.id] === "completed").length };
  if (r.status !== "RUNNING") return { ...base, kind: { COMPLETED: "ok", FAILED: "err", CANCELED: "cancel" }[r.status], current: null, waiting: false };
  const kind = r.pending.length ? "wait" : Object.values(r.steps).includes("quota_wait") ? "quota" : "run";
  return { ...base, kind, current: cur ? at(cur.id) : null, waiting: kind === "wait" };
}
const listRow = (r) => ({ owner: "admin", workflowId: r.id, definitionId: r.pipe.id, version: r.version, accepted: true, name: r.pipe.def.name, source: r.source, steps: shape(r.pipe.def), summary: summary(r) });
function detail(r) {
  const ws = r.pipe.def.directory + "/pipelines/" + r.pipe.slug;
  const folder = "runs/20261118-" + (r.id === "demo-run-done" ? "0040" : "2131") + "-" + r.id.slice(-8);
  const files = r.files ? [{ path: folder + "/notes.md", name: "notes.md", size: NOTES.length }, { path: folder + "/review.md", name: "review.md", size: REVIEW.length }] : [];
  return { workflowId: r.id, runId: "00000000-0000-4000-8000-" + r.id.slice(-12).padStart(12, "0").replace(/[^0-9a-f]/g, "0"), status: r.status,
    state: { paused: false, pending: r.pending, generation: "gen-" + r.id, steps: r.steps, waitReasons: r.waitReasons ?? {}, conditions: r.conditions ?? {} },
    startTime: iso(r.start), closeTime: r.close != null ? iso(r.close) : null, resultSteps: r.results, name: r.pipe.def.name, version: r.version,
    definitionId: r.pipe.id, directory: r.pipe.def.directory, source: r.source, steps: shape(r.pipe.def), summary: summary(r),
    workspace: ws, runFolder: folder, files, chats: r.chats ?? {}, inputs: r.inputs ?? {} };
}
const RESULTS = { review: REVIEW, notes: NOTES, find: "NO — all 20 recent runs are stable.", bump: SCORE };
const SCHEDULES = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", definitionId: PIPES[1].id, name: DEF_DEPS.name, version: 1, cron: "0 9 * * 1-5", timezone: "Europe/Berlin", overlap: "skip", catchupSeconds: 3600, paused: false },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", definitionId: PIPES[2].id, name: DEF_FLAKY.name, version: 2, cron: "30 7 * * *", timezone: "Europe/Berlin", overlap: "buffer-one", catchupSeconds: 3600, paused: false },
];
function nextTimes(cron) {
  const [m, h, , , dow] = cron.split(" ").map((x) => x);
  const out = []; const d = new Date(); d.setSeconds(0, 0);
  for (let i = 0; i < 24 * 60 * 8 && out.length < 3; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (d.getMinutes() !== Number(m) || d.getHours() !== Number(h)) continue;
    if (dow === "1-5" && [0, 6].includes(d.getDay())) continue;
    out.push(d.toISOString());
  }
  return out;
}

export function mockTemporal(req, res, url, p, { sendJson, readBody }) {
  if (!p.startsWith("/teleharness/api/temporal/") && !(p === "/teleharness/api/file" && String(url.searchParams.get("directory") ?? "").includes("/pipelines/"))) return false;
  const reply = (status, obj) => { sendJson(res, status, JSON.stringify(obj)); return true; };
  if (p === "/teleharness/api/file") {
    const name = String(url.searchParams.get("path") ?? "").split("/").pop();
    const text = name === "notes.md" ? NOTES : name === "review.md" ? REVIEW : null;
    if (text == null) return reply(404, { error: "not found" });
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-cache" });
    res.end(text);
    return true;
  }
  const r = p.slice("/teleharness/api/temporal/".length);
  if (req.method === "GET") {
    if (r === "capabilities") return reply(200, { definitions: true, pipelineAvailable: true, schedulesAvailable: true, runListAvailable: true, timerStartAvailable: false,
      execution: { available: true, reason: "Execution connected" }, engines: ["claude", "codex"], codexTextOnly: false,
      subscriptionModels: { claude: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"], codex: ["gpt-6.1-sol", "gpt-6.1-sol-mini"] } });
    if (r === "projects") return reply(200, { projects: ["/home/dev/projects/api-server", "/home/dev/projects/landing", "/home/dev/projects/billing", "/home/dev/infra"].map((d) => ({ directory: d, name: d.split("/").pop() })), default: "/home/dev/projects/api-server" });
    if (r === "attention") return reply(200, { waiting: RUNS().filter((x) => summary(x).waiting).length });
    if (r === "runs") return reply(200, RUNS().map(listRow));
    if (r === "definitions") return reply(200, PIPES.map((x) => ({ id: x.id, name: x.def.name, directory: x.def.directory, folder: "pipelines/" + x.slug, revision: x.versions + 1, latestVersion: x.versions, updatedAt: iso(x.updated) })));
    if (r === "schedules") return reply(200, SCHEDULES.map((s) => ({ ...s, nextTimes: s.paused ? [] : nextTimes(s.cron) })));
    let m = /^definitions\/([0-9a-f-]+)$/.exec(r);
    if (m) { const x = PIPES.find((q) => q.id === m[1]); return x ? reply(200, record(x)) : reply(404, { error: "Pipe not found" }); }
    m = /^runs\/([a-z-]+)\/results\/([a-z]+)$/.exec(r);
    if (m) return RESULTS[m[2]] ? reply(200, { text: RESULTS[m[2]] }) : reply(404, { error: "Result not found" });
    m = /^runs\/([a-z-]+)$/.exec(r);
    if (m) { const x = RUNS().find((q) => q.id === m[1]); return x ? reply(200, detail(x)) : reply(404, { error: "Run not found" }); }
    return reply(404, { error: "unknown route" });
  }
  (async () => {
    const body = (await readBody(req)) ?? {};
    let m = /^runs\/([a-z-]+)\/actions$/.exec(r);
    if (m) { if (m[1] === "demo-run-wait" && body.action === "approve") approvedAt = NOW(); if (body.action === "reset") approvedAt = null; return reply(200, { accepted: true, action: body.action }); } // reset: replay the demo
    if (r === "runs") return reply(202, { workflowId: "demo-run-wait", definitionId: body.definitionId, version: body.version });
    m = /^schedules\/([0-9a-f-]+)\/(pause|resume)$/.exec(r);
    if (m) { const s = SCHEDULES.find((q) => q.id === m[1]); if (s) s.paused = m[2] === "pause"; return reply(200, { ...s, nextTimes: s?.paused ? [] : nextTimes(s.cron) }); }
    if (r === "schedules") { const s = { ...body, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: PIPES.find((q) => q.id === body.definitionId)?.def.name ?? "Pipe", paused: false }; SCHEDULES.push(s); return reply(201, s); }
    if (r === "definitions") return reply(201, { id: "44444444-4444-4444-8444-444444444444", owner: "admin", revision: 1, slug: "new-pipe", folder: "pipelines/new-pipe", draft: body.draft, versions: [] });
    m = /^definitions\/([0-9a-f-]+)$/.exec(r);
    if (m && req.method === "PUT") { const x = PIPES.find((q) => q.id === m[1]); const rec = x ? record(x) : { id: m[1], versions: [] }; return reply(200, { ...rec, revision: (body.revision ?? 1) + 1, draft: body.draft }); }
    m = /^definitions\/([0-9a-f-]+)\/publish$/.exec(r);
    if (m) { const x = PIPES.find((q) => q.id === m[1]); return x ? reply(409, { error: `No changes — version ${x.versions} is current`, version: x.versions }) : reply(200, { id: m[1], revision: 2, versions: [{ version: 1, definition: body.draft }] }); }
    return reply(404, { error: "unknown route" });
  })().catch(() => res.destroy());
  return true;
}
