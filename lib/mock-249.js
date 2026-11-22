// Synthetic 2.4.9 mock handlers for `npm run demo` (TELEHARNESS_MOCK=1):
// Attention Board, Mobile Review & Plan-First, Git Worktrees, API-Equivalent
// Costs & Subscriptions, ACP Registry/Login, Push Prefs, and Binding PATCH.
// Synchronous matcher matching mockTemporal's contract: returns true iff handled.

const MIN = 60_000;
const H = 3_600_000;
const D = 86_400_000;

function makeDays(now) {
  const vals = [18.4, 24.1, 31.6, 15.8, 42.3, 38.9, 27.5, 51.2, 46.7, 63.4, 39.8, 55.1, 48.6, 41.2];
  const out = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * D);
    const iso = d.toISOString().slice(0, 10);
    const usd = vals[13 - i];
    out.push({ day: iso, micro: Math.round(usd * 1e6), turns: Math.max(4, Math.round(usd / 2.2)), noData: 0 });
  }
  return out;
}

const DIFF_FILES = {
  "src/auth/tokens.ts": {
    status: "M",
    additions: 18,
    deletions: 6,
    patch: [
      "diff --git a/src/auth/tokens.ts b/src/auth/tokens.ts",
      "--- a/src/auth/tokens.ts",
      "+++ b/src/auth/tokens.ts",
      "@@ -18,12 +18,24 @@ export interface TokenPair {",
      "   expiresAt: number;",
      " }",
      " ",
      "-export async function rotateRefreshToken(token: string): Promise<TokenPair> {",
      "-  const record = await db.tokens.findByHash(hash(token));",
      "-  if (!record || record.revoked) throw new AuthError(\"invalid_token\");",
      "-  await db.tokens.revoke(record.id);",
      "-  return issuePair(record.userId);",
      "+export async function rotateRefreshToken(token: string, now = Date.now()): Promise<TokenPair> {",
      "+  const digest = sha256(token);",
      "+  return db.transaction(async (tx) => {",
      "+    const record = await tx.tokens.findByHashForUpdate(digest);",
      "+    if (!record) throw new AuthError(\"invalid_token\");",
      "+    if (record.revokedAt) {",
      "+      if (now - record.revokedAt <= GRACE_WINDOW_MS && record.replacedBy) {",
      "+        return tx.tokens.findPairById(record.replacedBy);",
      "+      }",
      "+      await tx.tokens.revokeFamily(record.familyId);",
      "+      throw new AuthError(\"token_reuse_detected\");",
      "+    }",
      "+    const next = await issuePair(tx, record.userId, record.familyId);",
      "+    await tx.tokens.markRotated(record.id, next.id, now);",
      "+    return next;",
      "+  });",
      " }",
    ].join("\n"),
  },
  "src/auth/session-store.ts": {
    status: "M",
    additions: 9,
    deletions: 2,
    patch: [
      "diff --git a/src/auth/session-store.ts b/src/auth/session-store.ts",
      "--- a/src/auth/session-store.ts",
      "+++ b/src/auth/session-store.ts",
      "@@ -42,8 +42,15 @@ export class SessionStore {",
      "   async revokeFamily(familyId: string): Promise<number> {",
      "-    return this.db.run(\"DELETE FROM refresh_tokens WHERE family_id = ?\", familyId);",
      "+    const res = await this.db.run(",
      "+      \"UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL\",",
      "+      Date.now(),",
      "+      familyId,",
      "+    );",
      "+    this.metrics.inc(\"auth.family_revoked\");",
      "+    return res.changes;",
      "   }",
      " ",
      "-  async pruneExpired() {",
      "+  async pruneExpired(cutoff = Date.now() - 30 * 86_400_000) {",
      "+    return this.db.run(\"DELETE FROM refresh_tokens WHERE expires_at < ?\", cutoff);",
      "   }",
    ].join("\n"),
  },
  "tests/auth/rotation.test.ts": {
    status: "A",
    additions: 14,
    deletions: 0,
    patch: [
      "diff --git a/tests/auth/rotation.test.ts b/tests/auth/rotation.test.ts",
      "--- /dev/null",
      "+++ b/tests/auth/rotation.test.ts",
      "@@ -0,0 +1,14 @@",
      "+import { describe, it, expect } from \"vitest\";",
      "+import { rotateRefreshToken } from \"../../src/auth/tokens\";",
      "+",
      "+describe(\"refresh token rotation\", () => {",
      "+  it(\"allows concurrent retries within the 10s grace window\", async () => {",
      "+    const [a, b] = await Promise.all([rotateRefreshToken(seed), rotateRefreshToken(seed)]);",
      "+    expect(a.refreshToken).toBe(b.refreshToken);",
      "+  });",
      "+",
      "+  it(\"revokes the entire token family on replay after grace window\", async () => {",
      "+    await expect(rotateRefreshToken(seed, Date.now() + 20_000)).rejects.toThrow(\"token_reuse_detected\");",
      "+  });",
      "+});",
    ].join("\n"),
  },
};

function createState() {
  const now = Date.now();
  return {
    now,
    awayAcked: false,
    seenKeys: new Set(),
    snoozed: new Map(),
    pushPrefs: {
      enabled: true,
      needs: true,
      review: true,
      done: true,
      failed: true,
      quiet: { enabled: true, from: "23:00", to: "08:00" },
    },
    wtSettings: {
      autoCreate: false,
      mergeMethod: "squash",
      autoDeleteAfterMerge: true,
    },
    testCmd: "npm test",
    reviewItem: {
      id: "rv_demo_auth",
      key: "review:rv_demo_auth",
      source: "chat",
      sid: "ses_demo_auth_refactor",
      title: "Auth middleware refresh rotation",
      project: { name: "api-server", dir: "/home/dev/projects/api-server" },
      engine: "claude",
      model: "claude-sonnet-5-5",
      status: "waiting",
      state: "open",
      needsYou: true,
      revision: 2,
      version: 3,
      turns: 4,
      files: 3,
      additions: 41,
      deletions: 8,
      drafts: 1,
      mode: "snapshot",
      modeReason: null,
      busy: false,
      stale: null,
      since: now - 14 * MIN,
      href: "#/review/rv_demo_auth",
      base: { at: now - 42 * MIN, head: "8c3f1a2" },
      revisions: [
        { n: 1, at: now - 28 * MIN, turns: 2, files: 2, fresh: null },
        { n: 2, at: now - 14 * MIN, turns: 2, files: 3, fresh: ["tests/auth/rotation.test.ts"] },
      ],
      fileList: [
        { path: "src/auth/tokens.ts", status: "M", additions: 18, deletions: 6, reviewed: false, big: false },
        { path: "src/auth/session-store.ts", status: "M", additions: 9, deletions: 2, reviewed: true, big: false },
        { path: "tests/auth/rotation.test.ts", status: "A", additions: 14, deletions: 0, reviewed: false, big: false },
      ],
      big: [],
      sinceRevision: 1,
      sinceFiles: ["src/auth/tokens.ts", "tests/auth/rotation.test.ts"],
      comments: [
        {
          id: "c_demo_grace",
          file: "src/auth/tokens.ts",
          side: "new",
          from: 27,
          to: 29,
          quote: "if (now - record.revokedAt <= GRACE_WINDOW_MS && record.replacedBy) {",
          text: "Make GRACE_WINDOW_MS configurable via env (default 10_000 ms) so integration tests do not wait 20s.",
          state: "draft",
          revision: 2,
          version: 1,
          at: now - 5 * MIN,
        },
      ],
      sends: [{ revision: 1, at: now - 22 * MIN, count: 2 }],
      accept: null,
      dismissed: null,
    },
    acceptedReviews: [
      {
        id: "rv_demo_dark",
        key: "review:rv_demo_dark",
        source: "chat",
        sid: "ses_demo_landing_dark_theme",
        title: "Landing dark theme contrast tokens",
        project: { name: "web-app", dir: "/home/dev/projects/web-app" },
        engine: "opencode",
        model: "glm-5",
        status: "accepted",
        needsYou: false,
        revision: 1,
        turns: 3,
        files: 4,
        additions: 68,
        deletions: 21,
        drafts: 0,
        mode: "snapshot",
        since: now - 3 * H,
        acceptedAt: now - 95 * MIN,
        href: "#/review/rv_demo_dark",
      },
    ],
    geminiPlan: {
      id: "pl_demo_gemini_1",
      n: 1,
      state: "waiting",
      engine: "acp",
      model: "gemini-4-neon-medium",
      execModel: "gemini-4-neon-medium",
      turn: "msg_demo_gemini_a1",
      createdAt: now - 4 * MIN,
      decidedAt: null,
      violations: [],
      text: [
        "1. Audit src/middleware/rate-limit.ts — move sliding-window counter to atomic Redis Lua script to remove check-then-set races.",
        "2. Isolate per-tenant burst quotas in src/config/quotas.ts with explicit fallback when Redis is unavailable (fail-open + metric).",
        "3. Add concurrent burst test in tests/rate-limit.concurrent.test.ts covering 50 parallel requests across window boundaries.",
        "4. Keep public HTTP 429 headers (Retry-After, X-RateLimit-Remaining) backwards-compatible.",
      ].join("\n"),
    },
    worktrees: [
      {
        id: "wt_demo_auth",
        sid: "ses_demo_auth_refactor",
        title: "Auth middleware refresh rotation",
        repo: "/home/dev/projects/api-server",
        path: "/home/dev/projects/api-server/.teleharness-worktrees/wt_demo_auth",
        branch: "th/auth-refresh-rotation",
        base: "main",
        state: "active",
        gone: false,
        ahead: 3,
        behind: 1,
        commits: 3,
        uncommitted: 2,
        filesCount: 4,
        size: 18_420_000,
        testCmd: "npm test",
        overlaps: [
          {
            kind: "worktree",
            id: "wt_demo_jwt",
            branch: "th/jwt-key-rotation",
            title: "JWT signing key rotation",
            files: ["src/auth/tokens.ts"],
            conflict: true,
          },
        ],
        createdAt: now - 52 * MIN,
        updatedAt: now - 6 * MIN,
      },
      {
        id: "wt_demo_jwt",
        sid: "ses_demo_reports_api",
        title: "JWT signing key rotation",
        repo: "/home/dev/projects/api-server",
        path: "/home/dev/projects/api-server/.teleharness-worktrees/wt_demo_jwt",
        branch: "th/jwt-key-rotation",
        base: "main",
        state: "active",
        gone: false,
        ahead: 2,
        behind: 0,
        commits: 2,
        uncommitted: 0,
        filesCount: 2,
        size: 14_150_000,
        testCmd: "npm test",
        overlaps: [
          {
            kind: "worktree",
            id: "wt_demo_auth",
            branch: "th/auth-refresh-rotation",
            title: "Auth middleware refresh rotation",
            files: ["src/auth/tokens.ts"],
            conflict: true,
          },
        ],
        createdAt: now - 3 * H,
        updatedAt: now - 35 * MIN,
      },
    ],
    orphanedBranches: [
      { name: "th/legacy-cookie-cleanup", at: now - 2 * D, subject: "chore: drop deprecated session cookie parser" },
    ],
    costSubscriptions: {
      version: 3,
      items: [
        { id: "sub_claude", title: "Claude Max", providers: ["claude"], usdMonthMicro: 100_000_000, activeFrom: "2026-10-01" },
        { id: "sub_codex", title: "ChatGPT Plus", providers: ["codex"], usdMonthMicro: 20_000_000, activeFrom: "2026-10-01" },
        { id: "sub_antigravity", title: "Google Antigravity (Gemini · ACP)", providers: ["acp-antigravity"], usdMonthMicro: 20_000_000, activeFrom: "2026-11-01" },
      ],
    },
    costPrices: {
      version: 4,
      updatedAt: now - 2 * D,
      models: [
        { id: "claude-sonnet-5-5", engine: "claude", provider: "claude", billing: "subscription", usdPerMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
        { id: "claude-opus-4-6", engine: "claude", provider: "claude", billing: "subscription", usdPerMTok: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
        { id: "gpt-6.1-sol", engine: "codex", provider: "codex", billing: "subscription", usdPerMTok: { input: 2.5, output: 10, cacheRead: 0.625, cacheWrite: 0 } },
        { id: "gemini-4-neon-medium", engine: "acp", provider: "acp-antigravity", billing: "subscription", usdPerMTok: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 } },
        { id: "glm-5", engine: "opencode", provider: "zai-coding-plan", billing: "api", usdPerMTok: { input: 0.5, output: 2.0, cacheRead: 0.1, cacheWrite: 0 } },
      ],
    },
    costBudgets: {
      version: 1,
      items: [{ userId: "admin", name: "Alex", usdMonthMicro: 750_000_000, spentMicro: 544_600_000, pct: 73 }],
    },
    costSettings: { version: 1, tz: "UTC" },
  };
}

let ST = createState();
export function resetMock249() { ST = createState(); }

function buildReviewSummary(r) {
  return {
    id: r.id,
    key: r.key,
    source: r.source,
    sid: r.sid,
    title: r.title,
    project: r.project,
    engine: r.engine,
    model: r.model,
    status: r.status,
    needsYou: r.status === "waiting" || r.status === "returned",
    revision: r.revision,
    turns: r.turns,
    files: r.files,
    additions: r.additions,
    deletions: r.deletions,
    drafts: r.comments.filter((c) => c.state === "draft").length,
    mode: r.mode,
    since: r.since,
    href: r.href,
  };
}

function buildBoard() {
  const now = Date.now();
  const revSummary = buildReviewSummary(ST.reviewItem);
  const items = [
    {
      key: "review:rv_demo_auth",
      kind: "review",
      state: "needs",
      reason: "review",
      review: { files: 3 },
      title: "Auth middleware refresh rotation",
      project: { name: "api-server", dir: "/home/dev/projects/api-server" },
      engine: "claude",
      model: "claude-sonnet-5-5",
      snippet: "3 files (+41 −8) · 1 draft comment",
      since: now - 14 * MIN,
      at: now - 14 * MIN,
      href: "#/review/rv_demo_auth",
      pinned: true,
    },
    {
      key: "chat:ses_demo_gemini_audit",
      kind: "chat",
      state: "needs",
      reason: "plan",
      title: "Rate limiter concurrency audit",
      project: { name: "api-server", dir: "/home/dev/projects/api-server" },
      engine: "acp",
      model: "gemini-4-neon-medium",
      snippet: "Plan 1 ready for approval (read-only)",
      since: now - 4 * MIN,
      at: now - 4 * MIN,
      href: "#/chat/ses_demo_gemini_audit",
      pinned: false,
    },
    {
      key: "run:demo-run-wait",
      kind: "run",
      state: "needs",
      reason: "decision",
      title: "nightly-pr-review · feature/token-refresh",
      project: { name: "api-server", dir: "/home/dev/projects/api-server" },
      engine: "claude",
      model: "claude-sonnet-5-5",
      snippet: "Approve the review before Codex writes release notes",
      since: now - 9 * MIN,
      at: now - 9 * MIN,
      href: "#/temporal/run/demo-run-wait",
      pinned: false,
    },
    {
      key: "run:demo-run-deps",
      kind: "run",
      state: "working",
      reason: "running",
      title: "dependency-update · weekly schedule",
      project: { name: "web-app", dir: "/home/dev/projects/web-app" },
      engine: "codex",
      model: "gpt-6.1-sol",
      snippet: "Step 1/2: Bump minor versions and run tests",
      since: now - 3 * MIN,
      at: now - 3 * MIN,
      href: "#/temporal/run/demo-run-deps",
      pinned: false,
    },
    {
      key: "chat:ses_demo_reports_api",
      kind: "chat",
      state: "working",
      reason: "bg",
      title: "Reports API pagination & subagent triage",
      project: { name: "api-server", dir: "/home/dev/projects/api-server" },
      engine: "claude",
      model: "claude-sonnet-5-5",
      snippet: "2 background subagents running tests",
      bgAgents: 2,
      since: now - 6 * MIN,
      at: now - 1 * MIN,
      href: "#/chat/ses_demo_reports_api",
      pinned: false,
    },
    {
      key: "chat:ses_demo_codex_flaky_test",
      kind: "chat",
      state: "done",
      reason: "done",
      title: "Fix flaky webhook retry test",
      project: { name: "api-server", dir: "/home/dev/projects/api-server" },
      engine: "codex",
      model: "gpt-6.1-sol",
      snippet: "All 42 specs pass across 10 consecutive runs",
      since: now - 26 * MIN,
      at: now - 26 * MIN,
      href: "#/chat/ses_demo_codex_flaky_test",
      pinned: false,
    },
    {
      key: "chat:ses_demo_landing_dark_theme",
      kind: "chat",
      state: "done",
      reason: "done",
      title: "Landing page dark theme",
      project: { name: "web-app", dir: "/home/dev/projects/web-app" },
      engine: "claude",
      model: "claude-sonnet-5-5",
      snippet: "Relayed from opencode → Claude Sonnet 5.5 · completed",
      since: now - 48 * MIN,
      at: now - 48 * MIN,
      href: "#/chat/ses_demo_landing_dark_theme",
      pinned: false,
    },
    {
      key: "chat:ses_demo_ci_node22",
      kind: "chat",
      state: "failed",
      reason: "error",
      title: "CI Node 22 native module rebuild",
      project: { name: "infra", dir: "/home/dev/projects/infra" },
      engine: "opencode",
      model: "glm-5",
      snippet: "node-gyp exited with code 1 (missing python3-distutils)",
      since: now - 72 * MIN,
      at: now - 72 * MIN,
      href: "#/chat/ses_demo_ci_node22",
      pinned: false,
    },
  ].filter((it) => !ST.seenKeys.has(it.key));

  const counts = { needs: 0, review: 1, working: 0, done: 0, failed: 0, unknown: 0, snoozed: 0, older: 0 };
  for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;

  return {
    now,
    counts,
    items,
    sources: { opencode: "ok", claude: "ok", codex: "ok", acp: "ok", temporal: "ok" },
    projects: [
      { dir: "/home/dev/projects/api-server", name: "api-server" },
      { dir: "/home/dev/projects/web-app", name: "web-app" },
      { dir: "/home/dev/projects/infra", name: "infra" },
    ],
    truncated: null,
    away: ST.awayAcked
      ? null
      : {
          since: now - 2 * H - 15 * MIN,
          until: now - 2 * MIN,
          durationMs: 2 * H + 13 * MIN,
          counts: { done: 2, failed: 1, needs: 3, runs: 1, limit: 0, relay: 1, restart: 0, crash: 0 },
          events: [
            { at: now - 54 * MIN, kind: "relay", key: "chat:ses_demo_landing_dark_theme", text: "Auto-Relay handed off Landing page dark theme to Claude Sonnet 5.5" },
            { at: now - 26 * MIN, kind: "done", key: "chat:ses_demo_codex_flaky_test", text: "Codex finished Fix flaky webhook retry test" },
            { at: now - 9 * MIN, kind: "run-done", key: "run:demo-run-wait", text: "Pipeline nightly-pr-review paused at approval gate" },
          ],
        },
    reviews: [revSummary],
  };
}

function buildCostsSummary(urlObj) {
  const now = Date.now();
  const periodKind = urlObj.searchParams.get("period") || "month";
  const byDay = makeDays(now);
  const totalSub = 544_600_000;
  const totalApi = 38_200_000;
  const subCost = ST.costSubscriptions.items.reduce((a, b) => a + b.usdMonthMicro, 0);
  const monthIso = new Date(now).toISOString().slice(0, 7);
  const fromIso = byDay[0].day;
  const toIso = byDay.at(-1).day;

  const subItems = [
    { id: "sub_claude", title: "Claude Max", providers: ["claude"], usdMonthMicro: 100_000_000, activeFrom: "2026-10-01", costMicro: 100_000_000, prorated: false, apiMicro: 318_400_000, savedMicro: 218_400_000, payback: 3.2 },
    { id: "sub_codex", title: "ChatGPT Plus", providers: ["codex"], usdMonthMicro: 20_000_000, activeFrom: "2026-10-01", costMicro: 20_000_000, prorated: false, apiMicro: 132_800_000, savedMicro: 112_800_000, payback: 6.6 },
    { id: "sub_antigravity", title: "Google Antigravity (Gemini · ACP)", providers: ["acp-antigravity"], usdMonthMicro: 20_000_000, activeFrom: "2026-11-01", costMicro: 20_000_000, prorated: false, apiMicro: 93_400_000, savedMicro: 73_400_000, payback: 4.7 },
  ];

  return {
    period: { kind: periodKind, from: fromIso, to: toIso, month: monthIso },
    tz: ST.costSettings.tz,
    priceVersion: { version: ST.costPrices.version, createdAt: ST.costPrices.updatedAt },
    totals: {
      turns: 248,
      subscriptionMicro: totalSub,
      apiPaidMicro: totalApi,
      subscriptionTurns: 214,
      apiTurns: 34,
      freeTurns: 0,
      engineEstimateTurns: 12,
      pricedLateTurns: 0,
      longCtxTurns: 9,
      partialTurns: 0,
    },
    noData: { turns: 0 },
    subscriptions: {
      configured: true,
      costMicro: subCost,
      prorated: false,
      items: subItems,
      savedMicro: totalSub - subCost,
      payback: subCost > 0 ? Math.round((totalSub / subCost) * 10) / 10 : null,
    },
    byEngine: [
      { engine: "claude", title: "Claude Code", micro: 318_400_000, turns: 112, noData: 0 },
      { engine: "codex", title: "Codex", micro: 132_800_000, turns: 64, noData: 0 },
      { engine: "acp", title: "Gemini (ACP)", micro: 93_400_000, turns: 38, noData: 0 },
      { engine: "opencode", title: "opencode", micro: 38_200_000, turns: 34, noData: 0 },
    ],
    byModel: [
      { model: "claude-sonnet-5-5", provider: "claude", billing: "subscription", title: "Claude Sonnet 5.5", micro: 234_200_000, turns: 94, noData: 0, noPrice: false },
      { model: "gpt-6.1-sol", provider: "codex", billing: "subscription", title: "GPT-6.1 Sol", micro: 132_800_000, turns: 64, noData: 0, noPrice: false },
      { model: "gemini-4-neon-medium", provider: "acp-antigravity", billing: "subscription", title: "Gemini 4 Neon (Medium)", micro: 93_400_000, turns: 38, noData: 0, noPrice: false },
      { model: "claude-opus-4-6", provider: "claude", billing: "subscription", title: "Claude Opus 4.6", micro: 84_200_000, turns: 18, noData: 0, noPrice: false },
      { model: "glm-5", provider: "zai-coding-plan", billing: "api", title: "GLM-5", micro: 38_200_000, turns: 34, noData: 0, noPrice: false },
    ],
    byProject: [
      { project: "/home/dev/projects/api-server", micro: 342_500_000, turns: 141, runs: 8, noData: 0 },
      { project: "/home/dev/projects/web-app", micro: 164_900_000, turns: 73, runs: 4, noData: 0 },
      { project: "/home/dev/projects/infra", micro: 75_400_000, turns: 34, runs: 2, noData: 0 },
    ],
    topChats: [
      { sid: "ses_demo_auth_refactor", title: "Auth middleware refresh rotation", micro: 48_200_000, turns: 19, engine: "claude" },
      { sid: "ses_demo_reports_api", title: "Reports API pagination & subagent triage", micro: 41_900_000, turns: 16, engine: "claude" },
      { sid: "ses_demo_gemini_audit", title: "Rate limiter concurrency audit", micro: 29_600_000, turns: 11, engine: "acp" },
    ],
    runs: [
      { runId: "demo-run-wait", micro: 14_800_000, turns: 3, maxAttempt: 1 },
      { runId: "demo-run-deps", micro: 9_400_000, turns: 2, maxAttempt: 1 },
    ],
    byDay,
    budget: { usdMonthMicro: 750_000_000, spentMicro: totalSub + totalApi, pct: 78, month: monthIso },
  };
}

export function mock249(req, res, url, p, { sendJson, readBody }) {
  if (!p.startsWith("/teleharness/api/")) return false;
  const sub = p.slice("/teleharness/api".length);
  const m = req.method;
  const reply = (status, obj) => { sendJson(res, status, JSON.stringify(obj)); return true; };
  const parse = (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

  // Push key (prevents 404 in Settings)
  if (sub === "/push/key" && m === "GET") return reply(200, { enabled: false, publicKey: null, subscribed: false });

  // Attention Board
  if (sub === "/attention" && m === "GET") return reply(200, buildBoard());
  if (sub === "/attention/away-ack" && m === "POST") {
    ST.awayAcked = true;
    return reply(200, { ok: true });
  }
  if (sub === "/attention/seen" && m === "POST") {
    readBody(req, (raw) => {
      const b = parse(raw);
      if (b.key) ST.seenKeys.add(b.key);
      if (Array.isArray(b.keys)) b.keys.forEach((k) => ST.seenKeys.add(k));
      reply(200, { ok: true });
    });
    return true;
  }
  if (sub === "/attention/snooze" && m === "POST") {
    readBody(req, (raw) => {
      const b = parse(raw);
      if (b.key) ST.snoozed.set(b.key, b.until || Date.now() + H);
      reply(200, { ok: true });
    });
    return true;
  }

  // Push preferences
  if (sub === "/me/push-prefs" && m === "GET") return reply(200, ST.pushPrefs);
  if (sub === "/me/push-prefs" && m === "PUT") {
    readBody(req, (raw) => {
      ST.pushPrefs = { ...ST.pushPrefs, ...parse(raw) };
      reply(200, ST.pushPrefs);
    });
    return true;
  }

  // Mobile Review & Plan-First
  if (sub === "/review" && m === "GET") {
    const items = [buildReviewSummary(ST.reviewItem)];
    return reply(200, {
      items,
      next: null,
      total: items.length,
      counts: { needs: 1, all: 1, chats: 1, runs: 0, returned: 0 },
      accepted: ST.acceptedReviews,
    });
  }

  const rChat = /^\/review\/chat\/([^/]+)$/.exec(sub);
  if (rChat && m === "GET") {
    const sid = decodeURIComponent(rChat[1]);
    if (sid === "ses_demo_auth_refactor") {
      return reply(200, { review: buildReviewSummary(ST.reviewItem), plans: [], sends: ST.reviewItem.sends });
    }
    if (sid === "ses_demo_gemini_audit") {
      return reply(200, { review: null, plans: [ST.geminiPlan], sends: [] });
    }
    return reply(200, { review: null, plans: [], sends: [] });
  }

  const rDiff = /^\/review\/([^/]+)\/diff$/.exec(sub);
  if (rDiff && m === "GET") {
    const file = url.searchParams.get("file") || "src/auth/tokens.ts";
    const entry = DIFF_FILES[file] || DIFF_FILES["src/auth/tokens.ts"];
    return reply(200, {
      file,
      mode: "snapshot",
      status: entry.status,
      revision: ST.reviewItem.revision,
      since: null,
      binary: false,
      additions: entry.additions,
      deletions: entry.deletions,
      patch: entry.patch,
    });
  }

  const rComment = /^\/review\/([^/]+)\/comments\/([^/]+)$/.exec(sub);
  if (rComment) {
    const cid = decodeURIComponent(rComment[2]);
    if (m === "PUT") {
      readBody(req, (raw) => {
        const b = parse(raw);
        const idx = ST.reviewItem.comments.findIndex((c) => c.id === cid);
        const next = { id: cid, ...b, state: "draft", revision: ST.reviewItem.revision, version: (idx >= 0 ? ST.reviewItem.comments[idx].version : 0) + 1, at: Date.now() };
        if (idx >= 0) ST.reviewItem.comments[idx] = next; else ST.reviewItem.comments.push(next);
        reply(200, { comment: next, drafts: ST.reviewItem.comments.filter((c) => c.state === "draft").length });
      });
      return true;
    }
    if (m === "DELETE") {
      ST.reviewItem.comments = ST.reviewItem.comments.filter((c) => c.id !== cid);
      return reply(200, { ok: true });
    }
  }

  const rSub = /^\/review\/([^/]+)\/(viewed|refresh|preview|send|accept|dismiss)$/.exec(sub);
  if (rSub && m === "POST") {
    const act = rSub[2];
    readBody(req, (raw) => {
      const b = parse(raw);
      if (act === "viewed") {
        const f = ST.reviewItem.fileList.find((x) => x.path === b.file);
        if (f) f.reviewed = b.viewed !== false;
        return reply(200, { ok: true });
      }
      if (act === "refresh") return reply(200, { revision: ST.reviewItem.revision, changed: false });
      if (act === "preview") return reply(200, { text: "Review comments ready to send.", count: ST.reviewItem.comments.length, drafts: ST.reviewItem.comments.length, busy: false, engine: "claude" });
      if (act === "send") return reply(200, { already: false, at: Date.now(), revision: ST.reviewItem.revision, count: ST.reviewItem.comments.length, queued: false });
      if (act === "accept") return reply(200, { ok: true, at: Date.now(), files: ST.reviewItem.files });
      return reply(200, { ok: true, at: Date.now(), drafts: 0 });
    });
    return true;
  }

  const rItem = /^\/review\/([^/]+)$/.exec(sub);
  if (rItem && m === "GET") return reply(200, ST.reviewItem);

  const pAct = /^\/plan\/([^/]+)\/(approve|edit|revise|reject)$/.exec(sub);
  if (pAct && m === "POST") {
    const act = pAct[2];
    readBody(req, (raw) => {
      const b = parse(raw);
      if (act === "approve") ST.geminiPlan.state = "approved";
      else if (act === "edit") { ST.geminiPlan.state = "approved-edited"; if (b.text) ST.geminiPlan.edited = b.text; }
      else if (act === "revise") ST.geminiPlan.state = "revised";
      else if (act === "reject") ST.geminiPlan.state = "rejected";
      ST.geminiPlan.decidedAt = Date.now();
      reply(200, { already: false, plan: ST.geminiPlan });
    });
    return true;
  }

  // Session binding PATCH (planFirst)
  const bindMatch = /^\/session\/([^/]+)\/binding$/.exec(sub);
  if (bindMatch && m === "PATCH") {
    readBody(req, (raw) => {
      reply(200, { ok: true, teleharness: parse(raw) });
    });
    return true;
  }

  // Git Worktrees
  if (sub === "/me/worktrees" && m === "GET") return reply(200, ST.wtSettings);
  if (sub === "/me/worktrees" && m === "PUT") {
    readBody(req, (raw) => {
      ST.wtSettings = { ...ST.wtSettings, ...parse(raw) };
      reply(200, ST.wtSettings);
    });
    return true;
  }
  if (sub === "/worktrees/plan" && m === "GET") {
    return reply(200, {
      repo: true,
      root: "/home/dev/projects/api-server",
      base: "main",
      branches: ["main", "develop"],
      dirty: 0,
      suggestedBranch: "th/feature-work",
      defaultOn: ST.wtSettings.autoCreate,
      testCmd: ST.testCmd,
      limits: { max: 20, used: ST.worktrees.length },
    });
  }
  if (sub === "/worktrees/test-cmd" && m === "PUT") {
    readBody(req, (raw) => {
      ST.testCmd = parse(raw).cmd || "";
      reply(200, { ok: true, cmd: ST.testCmd });
    });
    return true;
  }
  if (sub === "/worktrees/branches" && m === "DELETE") {
    const name = url.searchParams.get("name");
    ST.orphanedBranches = ST.orphanedBranches.filter((b) => b.name !== name);
    return reply(200, { ok: true });
  }
  if (sub === "/worktrees" && m === "GET") {
    const sid = url.searchParams.get("sid");
    const run = url.searchParams.get("run");
    if (sid || run) {
      const hit = ST.worktrees.find((w) => (sid && w.sid === sid) || (run && w.runId === run)) || null;
      return reply(200, { item: hit, pending: null });
    }
    return reply(200, {
      repo: "/home/dev/projects/api-server",
      items: ST.worktrees,
      orphanedBranches: ST.orphanedBranches,
      testCmd: ST.testCmd,
      limits: { max: 20 },
    });
  }
  const wtGet = /^\/worktrees\/([^/]+)$/.exec(sub);
  if (wtGet && m === "GET") {
    const hit = ST.worktrees.find((w) => w.id === decodeURIComponent(wtGet[1])) || ST.worktrees[0];
    return reply(200, hit);
  }
  if (/^\/worktrees\/[^/]+\/unsaved$/.test(sub) && m === "GET") {
    return reply(200, { uncommitted: 2, commits: 3, merged: false });
  }
  if (/^\/worktrees\/[^/]+\/(sync|merge|review)$/.test(sub) && m === "POST") {
    return reply(200, { ok: true, upToDate: true, id: "rv_demo_auth" });
  }

  // Costs & Subscriptions
  if (sub === "/costs/summary" && m === "GET") return reply(200, buildCostsSummary(url));
  if (sub === "/costs/users" && m === "GET") {
    return reply(200, {
      totalMicro: 582_800_000,
      items: [{ userId: "admin", name: "Alex", micro: 582_800_000, turns: 248, share: 100, deleted: false }],
    });
  }
  if (sub === "/costs/prices" && m === "GET") return reply(200, ST.costPrices);
  if (sub === "/costs/prices" && m === "PUT") {
    readBody(req, (raw) => {
      const b = parse(raw);
      ST.costPrices = { version: ST.costPrices.version + 1, updatedAt: Date.now(), models: b.models || ST.costPrices.models };
      reply(200, ST.costPrices);
    });
    return true;
  }
  if (sub === "/costs/subscriptions" && m === "GET") return reply(200, ST.costSubscriptions);
  if (sub === "/costs/subscriptions" && m === "PUT") {
    readBody(req, (raw) => {
      const b = parse(raw);
      ST.costSubscriptions = { version: ST.costSubscriptions.version + 1, items: b.items || ST.costSubscriptions.items };
      reply(200, ST.costSubscriptions);
    });
    return true;
  }
  if (sub === "/costs/budgets" && m === "GET") return reply(200, ST.costBudgets);
  if (sub === "/costs/settings" && m === "GET") return reply(200, ST.costSettings);
  if (sub === "/costs/settings" && m === "PUT") {
    readBody(req, (raw) => {
      const b = parse(raw);
      ST.costSettings = { version: ST.costSettings.version + 1, tz: b.tz || ST.costSettings.tz };
      reply(200, ST.costSettings);
    });
    return true;
  }
  if (sub === "/costs/project" && m === "GET") {
    return reply(200, {
      project: url.searchParams.get("project") || "/home/dev/projects/api-server",
      month: new Date().toISOString().slice(0, 7),
      tz: ST.costSettings.tz,
      micro: 342_500_000,
      turns: 141,
      noData: 0,
    });
  }
  const cChat = /^\/costs\/chat\/([^/]+)$/.exec(sub);
  if (cChat && m === "GET") {
    return reply(200, {
      sid: decodeURIComponent(cChat[1]),
      turns: 12,
      totalMicro: 18_400_000,
      priced: 12,
      noData: 0,
      byModel: [{ model: "claude-sonnet-5-5", title: "Claude Sonnet 5.5", micro: 18_400_000, turns: 12 }],
      subagents: { count: 2, micro: 4_200_000, noData: 0 },
      service: { count: 1, micro: 120_000 },
      bannerSeen: true,
    });
  }
  const cRun = /^\/costs\/run\/([^/]+)$/.exec(sub);
  if (cRun && m === "GET") {
    return reply(200, {
      runId: decodeURIComponent(cRun[1]),
      totalMicro: 14_800_000,
      turns: 3,
      noData: 0,
      retries: 0,
      steps: [
        { stepId: "review", name: "Review the diff", engine: "claude", model: "claude-sonnet-5-5", micro: 9_600_000, attempt: 1 },
        { stepId: "notes", name: "Write release notes", engine: "codex", model: "gpt-6.1-sol", micro: 5_200_000, attempt: 1 },
      ],
    });
  }

  // ACP Registry & Login
  if (sub === "/acp/registry" && (m === "GET" || m === "POST")) {
    return reply(200, {
      version: 3,
      fetchedAt: Date.now() - 18 * MIN,
      skipped: 0,
      agents: [
        {
          id: "antigravity",
          name: "Google Antigravity",
          version: "1.5.2",
          description: "Gemini 4 Neon & Gemini 3.8 Flash over Agent Client Protocol",
          status: "installed",
          installable: true,
        },
        {
          id: "github-copilot-cli",
          name: "GitHub Copilot CLI",
          version: "1.0.114",
          description: "GitHub Copilot coding agent over Agent Client Protocol",
          status: "installed",
          installable: true,
        },
      ],
    });
  }
  const acpLogin = /^\/acp\/([^/]+)\/login$/.exec(sub);
  if (acpLogin) {
    const id = decodeURIComponent(acpLogin[1]);
    if (id === "antigravity") {
      return reply(200, {
        status: "ready",
        account: "dev@example.com",
        models: [
          { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
          { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        ],
      });
    }
    return reply(200, { status: "ready", account: "dev-user" });
  }


  // v2.5.1: GitHub PAT connection (Settings -> GitHub)
  if (sub === "/github/connection") {
    if (m === "GET") {
      return reply(200, {
        connected: true,
        status: "ok",
        login: "alex-dev",
        tokenLast4: "9a3f",
        checkedAt: new Date(Date.now() - 8 * MIN).toISOString(),
        expiresAt: Date.now() + 90 * D,
        expiringSoon: false,
        repos: [
          { fullName: "acme/api-server", permissions: { pull_requests: "write", webhooks: "write" } },
          { fullName: "acme/landing", permissions: { pull_requests: "write", webhooks: "read" } },
        ],
      });
    }
    if (m === "PUT") {
      return reply(200, { connected: true, status: "ok", login: "alex-dev", tokenLast4: "9a3f", checkedAt: new Date().toISOString() });
    }
    if (m === "DELETE") {
      return reply(200, { ok: true, connected: false });
    }
  }
  if (sub === "/github/connection/check" && m === "POST") {
    return reply(200, { connected: true, status: "ok", login: "alex-dev", tokenLast4: "9a3f", checkedAt: new Date().toISOString() });
  }
  if (sub === "/github/repos" && m === "GET") {
    return reply(200, {
      repos: [
        { fullName: "acme/api-server", permissions: { pull_requests: "write", webhooks: "write" } },
        { fullName: "acme/landing", permissions: { pull_requests: "write", webhooks: "read" } },
      ],
    });
  }

  // v2.5.1: Background agents admin controls (Settings -> Background agents)
  if (sub === "/admin/background") {
    const bg = (globalThis.__demoBg ??= { adminStopped: false, claudePerDay: 20, claudeUsedToday: 3 });
    if (m === "GET") {
      return reply(200, {
        ...bg,
        claudeLeftToday: Math.max(0, bg.claudePerDay - bg.claudeUsedToday),
        triggersTotal: 2,
        triggersEnabled: bg.adminStopped ? 0 : 2,
        activeRuns: 1,
        connections: [
          { owner: "admin", login: "alex-dev", tokenLast4: "9a3f", status: "ok", expiresAt: Date.now() + 90 * D },
        ],
      });
    }
    if (m === "PATCH") {
      (async () => {
        const body = (await readBody(req)) ?? {};
        if (typeof body.adminStopped === "boolean") bg.adminStopped = body.adminStopped;
        if (Number.isInteger(body.claudePerDay)) bg.claudePerDay = body.claudePerDay;
        reply(200, {
          ...bg,
          claudeLeftToday: Math.max(0, bg.claudePerDay - bg.claudeUsedToday),
          triggersTotal: 2,
          triggersEnabled: bg.adminStopped ? 0 : 2,
          activeRuns: 1,
          connections: [
            { owner: "admin", login: "alex-dev", tokenLast4: "9a3f", status: "ok", expiresAt: Date.now() + 90 * D },
          ],
        });
      })().catch(() => res.destroy());
      return true;
    }
  }

  // v2.5.1: Continue in merged worktree
  if (/^\/worktrees\/[^/]+\/continue$/.test(sub) && m === "POST") {
    return reply(200, { ok: true, state: "ready" });
  }

  // Admin users (used by Costs filter)
  if (sub === "/admin/users" && m === "GET") {
    return reply(200, { users: [{ id: "admin", name: "Alex", role: "admin" }] });
  }

  return false;
}
