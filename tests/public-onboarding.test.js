// Contract tests for npm package readiness, Docker/PaaS configs,
// focused README showcase (desktop GIF + comparison table), and repo cleanliness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package.json: publishable npm package with explicit compact files list", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.notEqual(pkg.private, true, "package.json must not be private for npm publishing");
  assert.ok(Array.isArray(pkg.files) && pkg.files.length >= 10, "package.json must define explicit files allowlist");
  for (const req of ["bin/", "lib/", "routes/", "shared/", "ops/", "public/", "fixtures-demo/", "server.js", "build.mjs"]) {
    assert.ok(pkg.files.includes(req), `files must include ${req}`);
  }
  for (const heavy of ["docs/", "docs/screenshots/", "tests/", "openspec/"]) {
    assert.ok(!pkg.files.includes(heavy), `files must exclude heavy directory ${heavy}`);
  }
  assert.equal(pkg.scripts?.prepublishOnly, "npm run build");
});

test("repo root has no zero-byte stub html files", () => {
  assert.equal(existsSync(path.join(ROOT, "projects.html")), false, "projects.html stub should be removed");
  assert.equal(existsSync(path.join(ROOT, "settings.html")), false, "settings.html stub should be removed");
});

test("Dockerfile, .dockerignore, docker-compose.yml and render.yaml exist and match healthz/demo/selfhosted contracts", () => {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22-slim/m);
  assert.match(dockerfile, /TELEHARNESS_DEMO=1/);
  assert.match(dockerfile, /TELEHARNESS_DATA_DIR=\/data/);
  assert.match(dockerfile, /TELEHARNESS_HOME=\/workspace/);
  assert.match(dockerfile, /TELEHARNESS_FILE_ROOTS=\/workspace/);
  assert.match(dockerfile, /VOLUME \["\/data"\]/);
  assert.match(dockerfile, /chown -R node:node \/app \/data \/workspace/);
  assert.match(dockerfile, /\/teleharness\/api\/healthz/);
  assert.match(dockerfile, /USER node/);

  const dockerignore = readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^docs$/m);
  assert.match(dockerignore, /^tests$/m);

  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  assert.match(compose, /TELEHARNESS_DEMO:\s*"1"/);
  assert.match(compose, /TELEHARNESS_COOKIE_NAME:\s*"teleharness_t_demo"/);
  assert.match(compose, /profiles:\s*\["selfhosted"\]/);
  assert.match(compose, /PORT:\s*"4170"/);
  assert.match(compose, /TELEHARNESS_DATA_DIR:\s*"\/data"/);
  assert.match(compose, /TELEHARNESS_HOME:\s*"\/workspace"/);
  assert.match(compose, /host\.docker\.internal:4196/);
  assert.doesNotMatch(compose, /:4096/, "docker-compose.yml must not reference legacy opencode 1.x port :4096");
  assert.match(compose, /TELEHARNESS_OC_API:/);
  assert.match(compose, /TELEHARNESS_OC_PASSWORD:/);
  assert.match(compose, /TELEHARNESS_ADMIN_TOKEN:/);
  assert.match(compose, /teleharness-data:\/data/);

  const render = readFileSync(path.join(ROOT, "render.yaml"), "utf8");
  assert.match(render, /runtime:\s*docker/);
  assert.match(render, /healthCheckPath:\s*\/teleharness\//);
  assert.match(render, /TELEHARNESS_DEMO/);
});

test("CI and npm publish workflows exist with full docker from-scratch smoke and npm publish steps", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /^\s+docker:/m);
  assert.match(ci, /docker compose config --quiet/);
  assert.match(ci, /docker compose --profile selfhosted up -d teleharness/);
  assert.match(ci, /docker compose --profile selfhosted restart teleharness/);
  assert.match(ci, /PORT=10000/);
  assert.match(ci, /\/teleharness\/api\/auth\/login/);
  assert.match(ci, /\/teleharness\/api\/healthz/);

  const pub = readFileSync(path.join(ROOT, ".github/workflows/publish-npm.yml"), "utf8");
  assert.match(pub, /npm publish --access public/);
  assert.match(pub, /secrets\.NPM_TOKEN/);
});

test("EN and RU desktop demo GIFs exist, are non-empty and under 3 MB, and READMEs stay focused", () => {
  for (const rel of ["docs/screenshots/desktop-demo.gif", "docs/screenshots/ru/desktop-demo.gif"]) {
    const abs = path.join(ROOT, rel);
    assert.ok(existsSync(abs), `${rel} must exist`);
    const size = statSync(abs).size;
    assert.ok(size > 100_000, `${rel} looks too small (${size} bytes)`);
    assert.ok(size < 3 * 1024 * 1024, `${rel} exceeds 3 MB budget (${size} bytes)`);
  }

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const [rel, gif, tour, comp] of [
    ["README.md", "docs/screenshots/desktop-demo.gif", "docs/tour.md", "How Teleharness compares"],
    ["README.ru.md", "docs/screenshots/ru/desktop-demo.gif", "docs/tour.ru.md", "Сравнение с альтернативами"],
  ]) {
    const md = readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(md.slice(0, 2500).includes(gif), `${rel} must showcase ${gif} near the top`);
    assert.ok(md.includes(tour), `${rel} must link to ${tour}`);
    assert.ok(md.includes(comp), `${rel} must include comparison table`);
    assert.ok(md.includes("npx teleharness --demo"), `${rel} must mention npx teleharness --demo`);
    assert.ok(md.includes(`--branch v${pkg.version}`), `${rel} Quick Start must reference current v${pkg.version}`);
  }

  const sec = readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
  assert.match(sec, /Single-user on `localhost` \/ Tailscale/);
});
