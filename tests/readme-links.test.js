// README.md and README.ru.md are the project's landing page: every local image and link must point to an existing
// file, and every in-page anchor (#...) must match a heading, so a rewrite of the README cannot ship broken media or
// a dead table of contents. package.json keeps the positioning keywords the GitHub topics are built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["README.md", "README.ru.md"];

// GitHub heading slug: lowercase, drop punctuation except - and _, spaces to -.
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function targets(md) {
  const out = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  for (const m of md.matchAll(/\b(?:src|href)="([^"]+)"/g)) out.push(m[1]);
  return out.filter((t) => !/^(https?:|mailto:)/.test(t));
}

for (const rel of FILES) {
  test(`${rel}: local links, images and anchors resolve`, () => {
    const md = readFileSync(path.join(ROOT, rel), "utf8");
    const anchors = new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
    const bad = [];
    for (const t of targets(md)) {
      const [file, hash] = t.split("#");
      if (file) {
        if (!existsSync(path.join(ROOT, decodeURIComponent(file)))) bad.push(`missing file: ${t}`);
      } else if (hash && !anchors.has(decodeURIComponent(hash))) bad.push(`missing anchor: ${t}`);
    }
    assert.deepEqual(bad, []);
  });
}

test("README headline and package.json name all three pillars and engines", () => {
  for (const rel of FILES) {
    const head = readFileSync(path.join(ROOT, rel), "utf8").slice(0, 2500);
    for (const word of ["Claude Code", "Codex", "opencode", "Temporal"]) assert.ok(head.includes(word), `${rel} header lacks ${word}`);
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const word of ["Claude Code", "Codex", "opencode", "Temporal"]) assert.ok(pkg.description.includes(word), `description lacks ${word}`);
  for (const kw of ["claude-code", "codex", "opencode", "temporal", "agent-orchestration", "human-in-the-loop"]) {
    assert.ok(pkg.keywords.includes(kw), `keywords lack ${kw}`);
  }
});
