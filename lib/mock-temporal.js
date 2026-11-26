// Demo data for Temporal pipelines (npm run demo, README screenshots). In-memory only:
// pipes in demo projects, runs in every state (including GitHub background PR run & rework),
// schedules, and GitHub triggers with event journal.
import { TEMPLATES, templateFace } from "../shared/temporal-templates.js";
import { buildResumePlan } from "./temporal/resume-plan.js";
import { previewResumeSelection } from "../shared/temporal-resume.js";

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
const PR_SUMMARY = `Implemented rate-limit retry with exponential backoff and added unit tests.

- Added \`src/http/retry.ts\` with jittered backoff (max 3 attempts)
- Updated \`tests/retry.test.ts\` (12/12 passing)`;

const DEF_REVIEW = {
  name: "Nightly PR review", directory: "/home/dev/projects/api-server",
  inputs: [{ name: "branch", type: "string", required: true }],
  steps: [
    { id: "review", type: "model", name: "Review the diff", engine: "claude", model: "claude-sonnet-5-5", instruction: "Review the diff of {{input.branch}} against main: risks, missing tests, breaking changes. End with a recommendation.", timeoutSeconds: 900, maxAttempts: 2, dependsOn: [] },
    { id: "gate", type: "approval", name: "Approve the review", reworkTarget: "review", maxReworks: 3, dependsOn: ["review"] },
    { id: "notes", type: "model", name: "Write release notes", engine: "codex", model: "gpt-6.1-sol", instruction: "Write release notes for {{input.branch}} from this review: {{steps.review}}", timeoutSeconds: 600, maxAttempts: 1, dependsOn: ["gate"] },
    { id: "summary", type: "model", name: "Short GLM summary", engine: "opencode", model: "glm-5.3-flash", instruction: "Summarize the release notes for {{input.branch}} in three bullets: {{steps.notes}}", timeoutSeconds: 600, maxAttempts: 1, dependsOn: ["notes"] },
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
    { id: "find", type: "model", name: "Find flaky tests in CI logs", engine: "acp", model: "gemini-4-neon-medium", instruction: "Read the last 20 CI logs and list tests that both passed and failed. Answer YES if any.", timeoutSeconds: 600, maxAttempts: 1, dependsOn: [] },
    { id: "any", type: "condition", name: "If any were found", check: { source: "step", ref: "find", op: "contains", value: "YES" }, dependsOn: ["find"] },
    { id: "fix", type: "model", name: "Propose fixes", engine: "codex", model: "gpt-6.1-sol", instruction: "Propose a fix for each flaky test: {{steps.find}}", timeoutSeconds: 900, maxAttempts: 1, dependsOn: ["any"] },
  ],
};
const DEF_ISSUE_PR = {
  name: "Issue → PR", directory: "/home/dev/projects/api-server",
  inputs: [{ name: "repo", type: "string", required: true }, { name: "number", type: "string", required: false }, { name: "title", type: "string", required: false }],
  steps: [
    { id: "work", type: "model", name: "Implement changes", engine: "claude", model: "claude-sonnet-5-5", worktree: true, instruction: "Implement GitHub issue #{{input.number}}: {{input.title}}", timeoutSeconds: 3600, maxAttempts: 2, dependsOn: [] },
    { id: "pr", type: "pull_request", name: "Open PR", source: "work", branch: "teleharness/task-{{input.number}}", title: "Issue #{{input.number}}: {{input.title}}", mode: "new", dependsOn: ["work"] },
  ],
};

const PIPES = [
  { id: "11111111-1111-4111-8111-111111111111", def: DEF_REVIEW, slug: "nightly-pr-review", versions: 3, updated: 2 * H },
  { id: "22222222-2222-4222-8222-222222222222", def: DEF_DEPS, slug: "dependency-update", versions: 1, updated: 26 * H },
  { id: "33333333-3333-4333-8333-333333333333", def: DEF_FLAKY, slug: "flaky-test-triage", versions: 2, updated: 50 * H },
  { id: "44444444-4444-4444-8444-444444444444", def: DEF_ISSUE_PR, slug: "issue-to-pr", versions: 1, updated: 4 * H },
];

const MODEL_LABELS = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.1-sol-mini": "GPT-6.1 Sol Mini",
  "gemini-4-neon-high": "Gemini 4 Neon (High)",
  "gemini-4-neon-medium": "Gemini 4 Neon (Medium)",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.3": "GLM-5.3",
};

const shape = (def) => def.steps.map((s) => ({
  id: s.id, name: s.name, type: s.type,
  ...(s.engine ? { engine: s.engine, model: s.model } : {}),
  ...(s.filename ? { filename: s.filename, source: s.source } : {}),
  ...(s.check ? { check: s.check } : {}),
  ...(s.reworkTarget ? { reworkTarget: s.reworkTarget, maxReworks: s.maxReworks ?? 3 } : {}),
  ...(s.mode ? { mode: s.mode, source: s.source } : {}),
}));
const record = (p) => ({
  id: p.id, owner: "admin", revision: p.versions + 1, slug: p.slug, folder: "pipelines/" + p.slug, draft: p.def,
  versions: Array.from({ length: p.versions }, (_, i) => ({ version: i + 1, definition: p.def, publishedAt: iso(p.updated + (p.versions - i) * H) })),
});

// Demo GitHub triggers + event journal.
// 2.8.1 (BUG-319): limits carry no maxActive — one run per subject is an invariant,
// not a setting; a stormy trigger shows queuedCount/stormAt and the «Clear queue» action.
const DEMO_LIMITS = { perHour: 6, queue: 20, userPerDay: 30 };
const TRIGGERS = [
  {
    id: "demo-trig-task",
    definitionId: PIPES[3].id,
    repo: "acme/api-server",
    kinds: ["issue_labeled", "comment_command"],
    filters: { label: "agent", command: "agent", trustedAuthors: ["alex-dev", "maya-ops"] },
    delivery: "auto",
    hookConfigured: true,
    pollSeconds: 120,
    limits: { ...DEMO_LIMITS },
    enabled: true,
    errors: 0,
    activeCount: 0,
    queuedCount: 0,
    stormAt: null,
    lastAt: iso(18 * MIN),
  },
  {
    id: "demo-trig-ci",
    definitionId: PIPES[2].id,
    repo: "acme/landing",
    kinds: ["ci_failed"],
    filters: { trustedAuthors: ["alex-dev"] },
    delivery: "poll",
    hookConfigured: false,
    pollSeconds: 120,
    limits: { ...DEMO_LIMITS },
    enabled: true,
    errors: 0,
    activeCount: 1,
    queuedCount: 3,
    stormAt: iso(40 * MIN),
    lastAt: iso(3 * H),
  },
];

const JOURNALS = {
  "demo-trig-task": [
    {
      id: "ev-1",
      at: iso(18 * MIN),
      kind: "issue_labeled",
      repo: "acme/api-server",
      number: 142,
      actor: "alex-dev",
      via: "webhook",
      decision: "started",
      workflowId: "demo-run-gh",
      eventJson: { kind: "issue_labeled", title: "Add exponential backoff to webhook retries", label: "agent", author: "alex-dev", url: "https://github.com/acme/api-server/issues/142" },
    },
    {
      id: "ev-2",
      at: iso(2 * H),
      kind: "comment_command",
      repo: "acme/api-server",
      number: 139,
      actor: "external-user",
      via: "webhook",
      decision: "untrusted_author",
      reason: "Untrusted author",
      eventJson: { kind: "comment_command", title: "Update README badge", command: "agent", author: "external-user", url: "https://github.com/acme/api-server/issues/139" },
    },
    {
      id: "ev-3",
      at: iso(5 * H),
      kind: "issue_labeled",
      repo: "acme/api-server",
      number: 136,
      actor: "maya-ops",
      via: "webhook",
      decision: "rate_limited",
      reason: "Hourly limit reached",
      eventJson: { kind: "issue_labeled", title: "Rotate signing keys gracefully", label: "agent", author: "maya-ops", url: "https://github.com/acme/api-server/issues/136" },
    },
  ],
  "demo-trig-ci": [
    {
      id: "ev-7",
      at: iso(50 * MIN),
      kind: "ci_failed",
      repo: "acme/landing",
      actor: "alex-dev",
      via: "poll",
      decision: "queue_full",
      reason: "Queue full",
      eventJson: { kind: "ci_failed", branch: "feat/hero-layout", prNumber: 91, workflow: "CI", url: "https://github.com/acme/landing/actions/runs/9030" },
    },
    {
      id: "ev-6",
      at: iso(70 * MIN),
      kind: "push",
      repo: "acme/landing",
      actor: "alex-dev",
      via: "poll",
      decision: "push_reset",
      reason: "Reset: human commit",
      eventJson: { kind: "push", branch: "feat/hero-layout", url: "https://github.com/acme/landing" },
    },
    {
      id: "ev-5",
      at: iso(2 * H),
      kind: "push",
      repo: "acme/landing",
      actor: "alex-dev",
      via: "poll",
      decision: "agent_loop",
      reason: "Agent commit (CI attempts not reset)",
      eventJson: { kind: "push", branch: "feat/hero-layout", url: "https://github.com/acme/landing" },
    },
    {
      id: "ev-4",
      at: iso(3 * H),
      kind: "ci_failed",
      repo: "acme/landing",
      actor: "alex-dev",
      via: "poll",
      decision: "started",
      workflowId: "demo-run-flaky",
      eventJson: { kind: "ci_failed", branch: "feat/hero-layout", prNumber: 88, workflow: "CI", url: "https://github.com/acme/landing/actions/runs/9012" },
    },
  ],
};

// 2.8.1 (BUG-317) demo stand-in for checkGitOrigin: a project folder «belongs» to
// acme/<folder name>; any other repository is a blocking readiness problem.
const demoRepos = new Set(["acme/api-server", "acme/landing", "acme/billing", "acme/infra"]);
function demoOriginProblem(body) {
  const repo = String(body?.repo ?? "").trim();
  const expected = "acme/" + (String(body?.directory ?? "").split("/").filter(Boolean).pop() ?? "");
  if (!repo || !demoRepos.has(expected) || expected === repo) return null;
  return { field: "directory", message: `Folder points to ${expected}, but repository ${repo} is selected`, blocking: true };
}

// demo state: the waiting run moves on after «Approve»
let approvedAt = null;
let reworksCount = 0;
// FEAT-19.32: runs created in the demo via «Resume from step» live here.
const RESUMED = [];
let resumeSeq = 0;

const stepFaces = (def) => (def.steps ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type, dependsOn: s.dependsOn ?? [] }));
const resumePlanOf = (x, targetDef) => {
  try {
    return buildResumePlan({ sourceDefinition: x.pipe.def, targetDefinition: targetDef, sourceState: { steps: x.steps, conditions: x.conditions ?? {}, pr: x.pr ?? {}, reworks: x.reworks ?? {} } });
  } catch {
    const faces = stepFaces(targetDef);
    return { reusableSteps: [], defaultFromStepId: faces[0]?.id ?? null };
  }
};

const RUNS = () => {
  const after = approvedAt ? NOW() - approvedAt : null;
  const waitRun = { id: "demo-run-wait", pipe: PIPES[0], version: 3, source: "manual", start: 9 * MIN, inputs: { branch: "feature/token-refresh" }, reworks: { gate: reworksCount } };
  if (after == null) Object.assign(waitRun, { status: "RUNNING", steps: { review: "completed", gate: "running", notes: "waiting", summary: "waiting", save: "waiting" }, pending: ["gate"], results: ["review"], chats: { review: "ses_demo_auth_refactor" } });
  else if (after < 5000) Object.assign(waitRun, { status: "RUNNING", steps: { review: "completed", gate: "completed", notes: "running", summary: "waiting", save: "waiting" }, pending: [], results: ["review"], chats: { review: "ses_demo_auth_refactor", notes: "ses_demo_codex_flaky_test" } });
  else Object.assign(waitRun, { status: "COMPLETED", close: Math.max(0, 9 * MIN - after - 40_000), steps: { review: "completed", gate: "completed", notes: "completed", summary: "completed", save: "completed" }, pending: [], results: ["review", "notes"], chats: { review: "ses_demo_auth_refactor", notes: "ses_demo_codex_flaky_test" }, files: true });
  return [
    waitRun,
    {
      id: "demo-run-gh",
      pipe: PIPES[3],
      version: 1,
      source: "github",
      eventRef: "acme/api-server#142 · label agent",
      eventUrl: "https://github.com/acme/api-server/issues/142",
      triggerId: "demo-trig-task",
      start: 18 * MIN,
      close: 12 * MIN,
      status: "COMPLETED",
      steps: { work: "completed", pr: "completed" },
      pr: { pr: { state: "done", outcome: "created", url: "https://github.com/acme/api-server/pull/318", branch: "teleharness/task-142", base: "main", sha: "9f2a10c" } },
      pending: [],
      results: ["work"],
      chats: { work: "ses_demo_auth_refactor" },
      inputs: { repo: "acme/api-server", number: "142", title: "Add exponential backoff to webhook retries" },
    },
    { id: "demo-run-deps", pipe: PIPES[1], version: 1, source: "schedule", start: 3 * MIN, status: "RUNNING", steps: { bump: "running", ok: "waiting" }, pending: [], results: [], chats: { bump: "ses_demo_vite6" } },
    { id: "demo-run-flaky", pipe: PIPES[2], version: 2, source: "schedule", start: 72 * MIN, status: "RUNNING", steps: { find: "quota_wait", any: "waiting", fix: "waiting" }, pending: [], results: [], waitReasons: { find: "quota_wait" } },
    { id: "demo-run-done", pipe: PIPES[0], version: 3, source: "manual", start: 20 * H, close: 20 * H - 11 * MIN, status: "COMPLETED", steps: { review: "completed", gate: "completed", notes: "completed", summary: "completed", save: "completed" }, pending: [], results: ["review", "notes"], chats: { review: "ses_demo_auth_refactor", notes: "ses_demo_codex_flaky_test" }, files: true, inputs: { branch: "feature/rate-limits" } },
    { id: "demo-run-skip", pipe: PIPES[2], version: 2, source: "schedule", start: 26 * H, close: 26 * H - 2 * MIN, status: "COMPLETED", steps: { find: "completed", any: "completed", fix: "skipped" }, conditions: { any: false }, pending: [], results: ["find"] },
    { id: "demo-run-fail", pipe: PIPES[1], version: 1, source: "schedule", start: 27 * H, close: 27 * H - 30 * MIN, status: "FAILED", steps: { bump: "completed", ok: "waiting" }, pending: [], results: [] },
    { id: "demo-run-cancel", pipe: PIPES[0], version: 2, source: "manual", start: 49 * H, close: 49 * H - 3 * MIN, status: "CANCELED", steps: { review: "running", gate: "waiting", notes: "waiting", summary: "waiting", save: "waiting" }, pending: [], results: [] },
    ...RESUMED,
  ];
};

function summary(r) {
  const steps = shape(r.pipe.def);
  const at = (id) => { const i = steps.findIndex((s) => s.id === id); return i < 0 ? null : { id, name: steps[i].name, type: steps[i].type, index: i + 1 }; };
  const cur = steps.find((s) => r.steps[s.id] === "quota_wait") ?? steps.find((s) => r.pending.includes(s.id)) ?? steps.find((s) => r.steps[s.id] === "running");
  const prStep = r.pr ? Object.values(r.pr)[0] : null;
  const base = {
    stepsTotal: steps.length, status: r.status, startTime: iso(r.start), closeTime: r.close != null ? iso(r.close) : null,
    paused: false, waitReasons: r.waitReasons ?? {}, done: steps.filter((s) => r.steps[s.id] === "completed").length,
    ...(prStep ? { pr: prStep } : {}),
  };
  if (r.status !== "RUNNING") return { ...base, kind: { COMPLETED: "ok", FAILED: "err", CANCELED: "cancel" }[r.status], current: null, waiting: false };
  const kind = r.pending.length ? "wait" : Object.values(r.steps).includes("quota_wait") ? "quota" : "run";
  return { ...base, kind, current: cur ? at(cur.id) : null, waiting: kind === "wait" };
}

const listRow = (r) => ({
  owner: "admin", workflowId: r.id, definitionId: r.pipe.id, version: r.version, accepted: true, name: r.pipe.def.name,
  source: r.source, ...(r.eventRef ? { eventRef: r.eventRef, eventUrl: r.eventUrl, triggerId: r.triggerId } : {}),
  steps: shape(r.pipe.def), summary: summary(r),
});

function detail(r) {
  const ws = r.pipe.def.directory + "/pipelines/" + r.pipe.slug;
  const folder = "runs/20261122-" + (r.id === "demo-run-done" ? "0040" : "2131") + "-" + r.id.slice(-8);
  const files = r.files ? [{ path: folder + "/notes.md", name: "notes.md", size: NOTES.length }, { path: folder + "/review.md", name: "review.md", size: REVIEW.length }] : [];
  // FEAT-19.32: the run detail carries the resume contract (options for finished runs, provenance for resumed ones).
  const latestVersion = r.pipe.versions;
  let resumeOptions = null;
  if (r.status !== "RUNNING" && !r.resumedFrom) {
    const faces = stepFaces(r.pipe.def);
    const plan = resumePlanOf(r, r.pipe.def);
    const versions = [];
    if (latestVersion !== r.version) versions.push({ version: latestVersion, isLatest: true, isOriginal: false });
    versions.push({ version: r.version, isLatest: r.version === latestVersion, isOriginal: true });
    resumeOptions = { versions: versions.map((v) => ({ ...v, available: true, steps: faces, reusableSteps: plan.reusableSteps, defaultFromStepId: plan.defaultFromStepId ?? faces[0]?.id ?? null })) };
  }
  return {
    workflowId: r.id, runId: "00000000-0000-4000-8000-" + r.id.slice(-12).padStart(12, "0").replace(/[^0-9a-f]/g, "0"), status: r.status,
    state: {
      paused: false, pending: r.pending, generation: "gen-" + r.id, steps: r.steps,
      waitReasons: r.waitReasons ?? {}, conditions: r.conditions ?? {},
      ...(r.pr ? { pr: r.pr } : {}),
      ...(r.reworks ? { reworks: r.reworks } : {}),
    },
    startTime: iso(r.start), closeTime: r.close != null ? iso(r.close) : null, resultSteps: r.results, name: r.pipe.def.name, version: r.version,
    latestVersion,
    resumedFrom: r.resumedFrom ?? null, resumeFromStep: r.resumeFromStep ?? null, resumedSteps: r.resumedSteps ?? [],
    ...(resumeOptions ? { resumeOptions } : {}),
    definitionId: r.pipe.id, directory: r.pipe.def.directory, source: r.source,
    ...(r.eventRef ? { eventRef: r.eventRef, eventUrl: r.eventUrl, triggerId: r.triggerId } : {}),
    steps: shape(r.pipe.def), summary: summary(r),
    workspace: ws, runFolder: folder, files, chats: r.chats ?? {}, inputs: r.inputs ?? {},
  };
}

const RESULTS = { review: REVIEW, notes: NOTES, find: "NO — all 20 recent runs are stable.", bump: SCORE, work: PR_SUMMARY };
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

const DEMO_COMMANDS = [
  {
    id: "lint-report",
    name: "Run linter & summary",
    description: "Executes the project linter without shell interpolation and prints a short Markdown summary.",
    kind: "exec",
    executable: "/usr/local/bin/node",
    args: ["scripts/lint-summary.mjs", "--scope={{param.scope}}"],
    cwdMode: "project",
    env: {},
    timeoutSeconds: 180,
    allowedRoles: ["admin", "user"],
    params: [{ name: "scope", type: "string", required: false, default: "changed", description: "Target scope (changed | all)" }],
  },
  {
    id: "nightly-etl",
    name: "Nightly ETL workflow",
    description: "Triggers an external Temporal workflow and polls until completion.",
    kind: "temporal-workflow",
    target: { mode: "workflow", address: "127.0.0.1:7233", namespace: "default", workflowType: "NightlyEtlWorkflow", taskQueue: "etl-workers" },
    timeoutSeconds: 1800,
    allowedRoles: ["admin"],
    params: [{ name: "date", type: "string", required: false, default: "today", description: "Partition date" }],
  },
];

const DEMO_EXTERNAL_WORKFLOWS = [
  {
    workflowId: "billing-reconcile-2026-11-26",
    runId: "9a3f21b0-4d1a-4c88-9b7e-01a2b3c4d5e6",
    workflowType: "BillingReconcileWorkflow",
    status: "RUNNING",
    taskQueue: "billing-workers",
    startTime: iso(14 * MIN),
    closeTime: null,
    executionDuration: null,
    historyLength: 7,
    isPortal: false,
    uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/billing-reconcile-2026-11-26/9a3f21b0-4d1a-4c88-9b7e-01a2b3c4d5e6",
    input: { ledgerDate: "2026-11-26", dryRun: false },
    result: null,
    failure: null,
    pendingActivities: [{ activityId: "fetch-settlements", activityType: "FetchSettlementBatch", state: "STARTED", attempt: 1, lastFailure: null }],
    signals: [],
    events: [
      { eventId: 1, eventTime: iso(14 * MIN), eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED", shortType: "WorkflowExecutionStarted", summary: "BillingReconcileWorkflow · queue billing-workers", resettable: false },
      { eventId: 4, eventTime: iso(13 * MIN), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", shortType: "WorkflowTaskCompleted", summary: "worker billing-worker@1", resettable: true },
      { eventId: 7, eventTime: iso(4 * MIN), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", shortType: "WorkflowTaskCompleted", summary: "worker billing-worker@1", resettable: true },
    ],
  },
  {
    workflowId: "export-warehouse-42",
    runId: "7c12a0f4-8e21-4a7b-b3d9-112233445566",
    workflowType: "WarehouseExportWorkflow",
    status: "COMPLETED",
    taskQueue: "etl-workers",
    startTime: iso(2 * H),
    closeTime: iso(110 * MIN),
    executionDuration: "600s",
    historyLength: 12,
    isPortal: false,
    uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/export-warehouse-42/7c12a0f4-8e21-4a7b-b3d9-112233445566",
    input: { table: "orders_daily" },
    result: { rowsExported: 48210, checksum: "sha256:9f84b1" },
    failure: null,
    pendingActivities: [],
    signals: [],
    events: [
      { eventId: 1, eventTime: iso(2 * H), eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED", shortType: "WorkflowExecutionStarted", summary: "WarehouseExportWorkflow · queue etl-workers", resettable: false },
      { eventId: 4, eventTime: iso(119 * MIN), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", shortType: "WorkflowTaskCompleted", summary: "worker etl-worker@2", resettable: true },
      { eventId: 12, eventTime: iso(110 * MIN), eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED", shortType: "WorkflowExecutionCompleted", summary: "Completed", resettable: false },
    ],
  },
];

let demoExtSeq = 1;

export function mockTemporal(req, res, url, p, { sendJson, readBody }) {
  const isAdminCmd = p === "/teleharness/api/admin/temporal-commands" || p.startsWith("/teleharness/api/admin/temporal-commands/");
  const isAdminExt = p === "/teleharness/api/admin/temporal-workflows" || p.startsWith("/teleharness/api/admin/temporal-workflows/");
  if (!isAdminCmd && !isAdminExt && !p.startsWith("/teleharness/api/temporal/") && !(p === "/teleharness/api/file" && String(url.searchParams.get("directory") ?? "").includes("/pipelines/"))) return false;
  const reply = (status, obj) => { sendJson(res, status, JSON.stringify(obj)); return true; };
  if (p === "/teleharness/api/file") {
    const name = String(url.searchParams.get("path") ?? "").split("/").pop();
    const text = name === "notes.md" ? NOTES : name === "review.md" ? REVIEW : null;
    if (text == null) return reply(404, { error: "not found" });
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-cache" });
    res.end(text);
    return true;
  }
  if (isAdminCmd) {
    if (req.method === "GET" && p === "/teleharness/api/admin/temporal-commands") {
      return reply(200, { items: DEMO_COMMANDS, allowedRoots: ["/usr/local/bin", "/home/dev/projects"], file: "data/temporal-commands.json", ok: true, errors: [] });
    }
    if (req.method === "GET" && p === "/teleharness/api/admin/temporal-commands/schedules") {
      return reply(200, { items: [{ scheduleId: "nightly-etl-schedule", workflowType: "NightlyEtlWorkflow", taskQueue: "etl-workers", paused: false }], address: "127.0.0.1:7233", namespace: "default" });
    }
    if (req.method === "POST" && p === "/teleharness/api/admin/temporal-commands/reload") {
      return reply(200, { ok: true, count: DEMO_COMMANDS.length, items: DEMO_COMMANDS });
    }
    if (req.method === "POST" && p === "/teleharness/api/admin/temporal-commands") {
      (async () => {
        const body = await readBody(req);
        if (!body?.id) return reply(400, { error: "Command id is required" });
        DEMO_COMMANDS.push(body);
        reply(201, body);
      })().catch(() => res.destroy());
      return true;
    }
    const cm = /^\/teleharness\/api\/admin\/temporal-commands\/([^/]+)$/.exec(p);
    if (cm) {
      const id = decodeURIComponent(cm[1]);
      const idx = DEMO_COMMANDS.findIndex((c) => c.id === id);
      if (req.method === "DELETE") {
        if (idx < 0) return reply(404, { error: "Command not found" });
        DEMO_COMMANDS.splice(idx, 1);
        return reply(200, { ok: true, id });
      }
      if (req.method === "PUT") {
        (async () => {
          const body = await readBody(req);
          if (idx < 0) return reply(404, { error: "Command not found" });
          DEMO_COMMANDS[idx] = { ...DEMO_COMMANDS[idx], ...body, id };
          reply(200, DEMO_COMMANDS[idx]);
        })().catch(() => res.destroy());
        return true;
      }
    }
    return reply(405, { error: "method not allowed" });
  }
  if (isAdminExt) {
    if (p === "/teleharness/api/admin/temporal-workflows") {
      if (req.method === "GET") {
        const status = (url.searchParams.get("status") || "").toUpperCase();
        const wt = (url.searchParams.get("workflowType") || "").trim().toLowerCase();
        const tq = (url.searchParams.get("taskQueue") || "").trim().toLowerCase();
        const excludePortal = url.searchParams.get("excludePortal") === "1" || url.searchParams.get("excludePortal") === "true";
        const items = DEMO_EXTERNAL_WORKFLOWS
          .filter((w) => !excludePortal || !w.isPortal)
          .filter((w) => !status || w.status === status)
          .filter((w) => !wt || w.workflowType.toLowerCase().includes(wt))
          .filter((w) => !tq || w.taskQueue.toLowerCase().includes(tq))
          .map(({ input: _i, result: _r, failure: _f, pendingActivities: _pa, events: _ev, signals: _s, ...summary }) => summary);
        return reply(200, { items, address: url.searchParams.get("address") || "127.0.0.1:7233", namespace: url.searchParams.get("namespace") || "default", uiBase: "http://127.0.0.1:8233", queryUsed: null });
      }
      if (req.method === "POST") {
        (async () => {
          const body = await readBody(req);
          if (!body?.workflowType || !body?.taskQueue) return reply(400, { error: "workflowType and taskQueue are required" });
          const now = new Date().toISOString();
          const wfId = (body.workflowId || "").trim() || ("ext-demo-" + String(demoExtSeq++).padStart(3, "0"));
          const runId = "run-" + wfId;
          let parsedInput = null;
          if (body.input !== undefined && body.input !== null && body.input !== "") {
            if (typeof body.input === "string") {
              try { parsedInput = JSON.parse(body.input); } catch { return reply(400, { error: "Invalid JSON in input" }); }
            } else parsedInput = body.input;
          }
          const wf = {
            workflowId: wfId, runId, workflowType: String(body.workflowType).trim(), status: "RUNNING",
            taskQueue: String(body.taskQueue).trim(), startTime: now, closeTime: null, executionDuration: null,
            historyLength: 4, isPortal: false,
            uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/" + encodeURIComponent(wfId) + "/" + encodeURIComponent(runId),
            input: parsedInput, result: null, failure: null, pendingActivities: [], signals: [],
            events: [
              { eventId: 1, eventTime: now, eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED", shortType: "WorkflowExecutionStarted", summary: body.workflowType + " · queue " + body.taskQueue, resettable: false },
              { eventId: 4, eventTime: now, eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", shortType: "WorkflowTaskCompleted", summary: "worker demo-worker@1", resettable: true },
            ],
          };
          DEMO_EXTERNAL_WORKFLOWS.unshift(wf);
          reply(201, { workflowId: wfId, runId, workflowType: wf.workflowType, taskQueue: wf.taskQueue, address: "127.0.0.1:7233", namespace: "default", uiUrl: wf.uiUrl });
        })().catch(() => res.destroy());
        return true;
      }
    }
    const actM = /^\/teleharness\/api\/admin\/temporal-workflows\/([^/]+)\/(signal|query|reset|cancel|terminate)$/.exec(p);
    if (req.method === "POST" && actM) {
      const wfId = decodeURIComponent(actM[1]);
      const action = actM[2];
      (async () => {
        const body = await readBody(req);
        const wf = DEMO_EXTERNAL_WORKFLOWS.find((w) => w.workflowId === wfId);
        if (!wf) return reply(404, { error: "Workflow not found" });
        const now = new Date().toISOString();
        if (action === "signal") {
          if (!body?.name) return reply(400, { error: "Signal name is required" });
          wf.signals.push({ name: body.name, input: body.input ?? null, at: now });
          wf.events.push({ eventId: wf.events.length + 1, eventTime: now, eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED", shortType: "WorkflowExecutionSignaled", summary: "signal " + body.name, resettable: false });
          wf.historyLength = wf.events.length;
          return reply(200, { ok: true, workflowId: wfId, runId: wf.runId, name: body.name, address: "127.0.0.1:7233", namespace: "default" });
        }
        if (action === "query") {
          if (!body?.type) return reply(400, { error: "Query type is required" });
          const result = { query: body.type, status: wf.status, signals: wf.signals, input: wf.input };
          return reply(200, { ok: true, workflowId: wfId, runId: wf.runId, type: body.type, result, raw: JSON.stringify(result), address: "127.0.0.1:7233", namespace: "default" });
        }
        if (action === "reset") {
          if (!body?.reason) return reply(400, { error: "Reason is required" });
          wf.runId = "run-reset-" + Date.now().toString(36);
          wf.status = "RUNNING"; wf.closeTime = null; wf.failure = null;
          return reply(200, { ok: true, workflowId: wfId, runId: wf.runId, eventId: body.eventId ?? null, resetType: body.resetType ?? null, reason: body.reason, address: "127.0.0.1:7233", namespace: "default" });
        }
        if (action === "cancel") {
          wf.status = "CANCELED"; wf.closeTime = now;
          return reply(200, { ok: true, workflowId: wfId, runId: wf.runId, action: "cancel", reason: body?.reason || null, address: "127.0.0.1:7233", namespace: "default" });
        }
        if (!body?.reason) return reply(400, { error: "Reason is required" });
        wf.status = "TERMINATED"; wf.closeTime = now;
        return reply(200, { ok: true, workflowId: wfId, runId: wf.runId, action: "terminate", reason: body.reason, address: "127.0.0.1:7233", namespace: "default" });
      })().catch(() => res.destroy());
      return true;
    }
    const detM = /^\/teleharness\/api\/admin\/temporal-workflows\/([^/]+)$/.exec(p);
    if (req.method === "GET" && detM) {
      const wfId = decodeURIComponent(detM[1]);
      const wf = DEMO_EXTERNAL_WORKFLOWS.find((w) => w.workflowId === wfId);
      if (!wf) return reply(404, { error: "Workflow not found" });
      const { input, result, failure, pendingActivities, events, signals: _s, ...workflow } = wf;
      const resetPoints = events.filter((e) => e.resettable).map((e) => ({ eventId: e.eventId, eventTime: e.eventTime, label: "#" + e.eventId + " · WorkflowTaskCompleted" })).reverse();
      return reply(200, { workflow, input, result, failure, pendingActivities, events, totalEvents: events.length, resetPoints, address: "127.0.0.1:7233", namespace: "default" });
    }
    return reply(404, { error: "unknown route" });
  }
  const r = p.slice("/teleharness/api/temporal/".length);
  if (req.method === "GET") {
    if (r === "capabilities") return reply(200, {
      definitions: true, pipelineAvailable: true, schedulesAvailable: true, runListAvailable: true, timerStartAvailable: false,
      ledger: "postgres", commandsAvailable: DEMO_COMMANDS.length > 0, socketPathError: null,
      execution: { available: true, reason: "Execution connected" },
      engines: ["claude", "codex", "acp", "opencode"], codexTextOnly: false,
      subscriptionModels: {
        claude: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"],
        codex: ["gpt-6.1-sol", "gpt-6.1-sol-mini"],
        acp: ["gemini-4-neon-high", "gemini-4-neon-medium", "gemini-3.8-flash"],
        opencode: ["glm-5.3-flash", "glm-5.3"],
      },
      modelLabels: MODEL_LABELS,
      triggers: { available: true, publicUrl: "https://demo.teleharness.local", adminStopped: false, claudePerDay: 20, claudeUsedToday: 3, claudeLeftToday: 17 },
    });
    if (r === "commands") return reply(200, { items: DEMO_COMMANDS.map(({ id, name, description, kind, timeoutSeconds, allowedRoles, params }) => ({ id, name, description, kind, timeoutSeconds, allowedRoles, params })) });
    if (r === "projects") return reply(200, { projects: ["/home/dev/projects/api-server", "/home/dev/projects/landing", "/home/dev/projects/billing", "/home/dev/infra"].map((d) => ({ directory: d, name: d.split("/").pop() })), default: "/home/dev/projects/api-server" });
    if (r === "attention") return reply(200, { waiting: RUNS().filter((x) => summary(x).waiting).length });
    if (r === "runs") return reply(200, RUNS().map(listRow));
    if (r === "definitions") return reply(200, PIPES.map((x) => ({ id: x.id, name: x.def.name, directory: x.def.directory, folder: "pipelines/" + x.slug, revision: x.versions + 1, latestVersion: x.versions, updatedAt: iso(x.updated) })));
    if (r === "schedules") return reply(200, SCHEDULES.map((s) => ({ ...s, nextTimes: s.paused ? [] : nextTimes(s.cron) })));
    if (r === "templates") return reply(200, { templates: TEMPLATES.map(templateFace) });
    if (r === "triggers") return reply(200, TRIGGERS);
    let m = /^triggers\/([^/]+)\/journal$/.exec(r);
    if (m) {
      const f = url.searchParams.get("filter") || "";
      let rows = JOURNALS[m[1]] ?? [];
      if (f === "started") rows = rows.filter((x) => x.decision === "started");
      else if (f === "skipped") rows = rows.filter((x) => x.decision !== "started" && x.decision !== "error");
      else if (f === "errors") rows = rows.filter((x) => ["untrusted_author", "error", "bad_signature"].includes(x.decision));
      return reply(200, rows);
    }
    m = /^triggers\/([^/]+)$/.exec(r);
    if (m) { const x = TRIGGERS.find((q) => q.id === m[1]); return x ? reply(200, x) : reply(404, { error: "Trigger not found" }); }
    m = /^definitions\/([0-9a-f-]+)$/.exec(r);
    if (m) { const x = PIPES.find((q) => q.id === m[1]); return x ? reply(200, record(x)) : reply(404, { error: "Pipe not found" }); }
    m = /^runs\/([a-z0-9-]+)\/results\/([a-z]+)$/.exec(r);
    if (m) return RESULTS[m[2]] ? reply(200, { text: RESULTS[m[2]] }) : reply(404, { error: "Result not found" });
    m = /^runs\/([a-z0-9-]+)$/.exec(r);
    if (m) { const x = RUNS().find((q) => q.id === m[1]); return x ? reply(200, detail(x)) : reply(404, { error: "Run not found" }); }
    return reply(404, { error: "unknown route" });
  }
  (async () => {
    const body = (await readBody(req)) ?? {};
    let m = /^runs\/([a-z0-9-]+)\/actions$/.exec(r);
    if (m) {
      if (m[1] === "demo-run-wait" && body.action === "approve") approvedAt = NOW();
      if (m[1] === "demo-run-wait" && body.action === "rework") reworksCount = Math.min(3, reworksCount + 1);
      if (body.action === "reset") { approvedAt = null; reworksCount = 0; }
      return reply(200, { accepted: true, action: body.action });
    }
    if (r === "runs") return reply(202, { workflowId: "demo-run-wait", definitionId: body.definitionId, version: body.version });
    // FEAT-19.32: «Resume from step» — seed the reused steps as completed and start the rest.
    let rm = /^runs\/([a-z0-9-]+)\/resume$/.exec(r);
    if (rm) {
      const src = RUNS().find((q) => q.id === rm[1]);
      if (!src) return reply(404, { error: "Run not found" });
      if (src.status === "RUNNING") return reply(409, { error: "An active run cannot be resumed — wait for it to finish or cancel it first" });
      const faces = stepFaces(src.pipe.def);
      const plan = resumePlanOf(src, src.pipe.def);
      const version = Number.isSafeInteger(body.version) && body.version >= 1 ? body.version : src.pipe.versions;
      const fromStepId = typeof body.fromStepId === "string" && faces.some((s) => s.id === body.fromStepId) ? body.fromStepId : plan.defaultFromStepId;
      const pick = previewResumeSelection({ steps: faces, reusableSteps: plan.reusableSteps, fromStepId });
      const id = "demo-run-res" + (resumeSeq > 0 ? resumeSeq + 1 : "");
      resumeSeq += 1;
      const entry = {
        id, pipe: src.pipe, version, source: src.source, ...(src.eventRef ? { eventRef: src.eventRef, eventUrl: src.eventUrl, triggerId: src.triggerId } : {}),
        start: 2 * MIN, status: "RUNNING",
        steps: Object.fromEntries(faces.map((s) => [s.id, pick.reusedSteps.includes(s.id) ? "completed" : s.id === pick.fromStepId ? "running" : "waiting"])),
        pending: [], results: (src.results ?? []).filter((sid) => pick.reusedSteps.includes(sid)),
        chats: Object.fromEntries(Object.entries(src.chats ?? {}).filter(([k]) => pick.reusedSteps.includes(k))),
        inputs: src.inputs ?? {}, conditions: Object.fromEntries(Object.entries(src.conditions ?? {}).filter(([k]) => pick.reusedSteps.includes(k))),
        resumedFrom: src.id, resumeFromStep: pick.fromStepId, resumedSteps: pick.reusedSteps,
      };
      RESUMED.push(entry);
      return reply(202, { workflowId: id, version, resumedFrom: src.id, fromStepId: pick.fromStepId, reusedSteps: pick.reusedSteps });
    }
    m = /^templates\/([a-z0-9-]+)\/readiness$/.exec(r);
    if (m) {
      // 2.8.1 (BUG-317): the folder's git origin must point at the chosen repository
      // (demo folders map to acme/<folder name>).
      const mismatch = demoOriginProblem(body);
      return reply(200, mismatch ? { ready: false, problems: [mismatch] } : { ready: true, problems: [] });
    }
    if (r === "triggers") {
      const mismatch = demoOriginProblem(body);
      if (mismatch) return reply(422, { error: mismatch.message, code: "origin_mismatch" });
      const tr = {
        id: "demo-trig-" + (TRIGGERS.length + 1),
        definitionId: body.definitionId || PIPES[3].id,
        repo: body.repo || "acme/api-server",
        kinds: body.kinds || ["issue_labeled"],
        filters: body.filters || {},
        delivery: body.delivery || "auto",
        hookConfigured: false,
        pollSeconds: body.pollSeconds || 120,
        limits: { ...DEMO_LIMITS, ...(body.limits || {}) },
        enabled: true,
        errors: 0,
        activeCount: 0,
        queuedCount: 0,
        stormAt: null,
        lastAt: null,
      };
      TRIGGERS.push(tr);
      return reply(201, { ...tr, key: "demo_key_once", secret: "demo_secret_once", hookUrl: "https://demo.teleharness.local/teleharness/hooks/github/demo_key_once" });
    }
    m = /^triggers\/([^/]+)\/queue\/clear$/.exec(r);
    if (m) {
      // 2.8.1 (BUG-319): clearing the queue keeps running pipes and lifts the storm flag.
      const tr = TRIGGERS.find((q) => q.id === m[1]);
      if (!tr) return reply(404, { error: "Trigger not found" });
      const cleared = tr.queuedCount ?? 0;
      tr.queuedCount = 0;
      tr.stormAt = null;
      (JOURNALS[tr.id] ??= []).unshift({
        id: "ev-queue-" + Date.now(), at: iso(0), kind: "queue", repo: tr.repo, actor: "admin", via: "manual",
        decision: "queue_cleared", reason: cleared ? `Queue cleared (${cleared})` : "Queue cleared", eventJson: null,
      });
      return reply(200, { ok: true, cleared });
    }
    m = /^triggers\/([^/]+)\/(enable|disable|replay|webhook)$/.exec(r);
    if (m) {
      const tr = TRIGGERS.find((q) => q.id === m[1]);
      if (!tr) return reply(404, { error: "Trigger not found" });
      if (m[2] === "enable") tr.enabled = true;
      if (m[2] === "disable") tr.enabled = false;
      if (m[2] === "webhook") { tr.hookConfigured = true; return reply(200, { hookId: 42, pinged: true }); }
      if (m[2] === "replay") return reply(202, { accepted: true, workflowId: "demo-run-gh" });
      return reply(200, tr);
    }
    m = /^schedules\/([0-9a-f-]+)\/(pause|resume)$/.exec(r);
    if (m) { const s = SCHEDULES.find((q) => q.id === m[1]); if (s) s.paused = m[2] === "pause"; return reply(200, { ...s, nextTimes: s?.paused ? [] : nextTimes(s.cron) }); }
    if (r === "schedules") { const s = { ...body, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: PIPES.find((q) => q.id === body.definitionId)?.def.name ?? "Pipe", paused: false }; SCHEDULES.push(s); return reply(201, s); }
    if (r === "definitions") return reply(201, { id: "55555555-5555-4555-8555-555555555555", owner: "admin", revision: 1, slug: "new-pipe", folder: "pipelines/new-pipe", draft: body.draft, versions: [] });
    m = /^definitions\/([0-9a-f-]+)$/.exec(r);
    if (m && req.method === "PUT") { const x = PIPES.find((q) => q.id === m[1]); const rec = x ? record(x) : { id: m[1], versions: [] }; return reply(200, { ...rec, revision: (body.revision ?? 1) + 1, draft: body.draft }); }
    m = /^definitions\/([0-9a-f-]+)\/publish$/.exec(r);
    if (m) { const x = PIPES.find((q) => q.id === m[1]); return x ? reply(409, { error: `No changes — version ${x.versions} is current`, version: x.versions }) : reply(200, { id: m[1], revision: 2, versions: [{ version: 1, definition: body.draft }] }); }
    return reply(404, { error: "unknown route" });
  })().catch(() => res.destroy());
  return true;
}
