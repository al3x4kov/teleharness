// README.md, README.ru.md and docs/tour*.md are the project's landing & tour pages:
// every local image and link must point to an existing file, and every in-page anchor (#...)
// must match a heading, so a rewrite cannot ship broken media or a dead table of contents.
// package.json keeps the positioning keywords the GitHub topics are built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_FILES = ["README.md", "README.ru.md"];
const DOC_FILES = [...README_FILES, "docs/tour.md", "docs/tour.ru.md"];

// GitHub heading slug: lowercase, drop punctuation except - and _, spaces to -.
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function targets(md) {
  const out = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  for (const m of md.matchAll(/\b(?:src|href)="([^"]+)"/g)) out.push(m[1]);
  return out.filter((t) => !/^(https?:|mailto:)/.test(t));
}

function headingAnchors(filePath) {
  const md = readFileSync(filePath, "utf8");
  return new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
}

for (const rel of DOC_FILES) {
  test(`${rel}: local links, images and anchors resolve`, () => {
    const abs = path.join(ROOT, rel);
    const baseDir = path.dirname(abs);
    const md = readFileSync(abs, "utf8");
    const anchors = headingAnchors(abs);
    const bad = [];
    for (const t of targets(md)) {
      const [file, hash] = t.split("#");
      if (file) {
        const resolved = path.resolve(baseDir, decodeURIComponent(file));
        if (!existsSync(resolved)) bad.push(`missing file: ${t}`);
        else if (hash && resolved.endsWith(".md")) {
          const targetAnchors = headingAnchors(resolved);
          if (!targetAnchors.has(decodeURIComponent(hash))) bad.push(`missing target anchor: ${t}`);
        }
      } else if (hash && !anchors.has(decodeURIComponent(hash))) bad.push(`missing anchor: ${t}`);
    }
    assert.deepEqual(bad, []);
  });
}

test("README headline and package.json name all three pillars and engines", () => {
  for (const rel of README_FILES) {
    const head = readFileSync(path.join(ROOT, rel), "utf8").slice(0, 2500);
    for (const word of ["Claude Code", "Codex", "opencode", "Temporal"]) assert.ok(head.includes(word), `${rel} header lacks ${word}`);
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const word of ["Claude Code", "Codex", "opencode", "Temporal"]) assert.ok(pkg.description.includes(word), `description lacks ${word}`);
  for (const kw of ["claude-code", "codex", "opencode", "temporal", "agent-orchestration", "human-in-the-loop"]) {
    assert.ok(pkg.keywords.includes(kw), `keywords lack ${kw}`);
  }
});
