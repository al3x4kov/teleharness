// BUG-185: opencode parses SKILL.md frontmatter as strict YAML and silently
// drops a skill whose frontmatter does not parse (zai-pptx disappeared from
// /skill after 1.14.9: an unquoted description with «…): …»). The Claude
// CLI is lenient, so only the GLM engine lost the skill. Dependency-free check
// of the rule that bit us plus the fields both engines need.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SKILLS = path.resolve(import.meta.dirname, "..", "ops", "opencode", "skills");

// → [{key, value, quoted}] for the top-level one-line `key: value` entries.
export function frontmatterEntries(text) {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    out.push({ key: kv[1], value, quoted: /^(["']).*\1$/.test(value) });
  }
  return out;
}

// YAML plain scalars may not contain ": " or " #" (mapping / comment).
export function plainScalarProblem(value) {
  if (/:\s/.test(value) || /:$/.test(value)) return "contains «: » — quote the value";
  if (/\s#/.test(value)) return "contains « #» — quote the value";
  if (/^[\[\]{}>|*&!%@`]/.test(value)) return "starts with a YAML indicator — quote the value";
  return null;
}

test("frontmatterEntries / plainScalarProblem catch the BUG-185 shape", () => {
  const bad = "---\nname: zai-pptx\ndescription: PowerPoint — стиль (цвета, шрифты): титульный слайд\n---\nbody";
  const e = frontmatterEntries(bad);
  assert.equal(e.find((x) => x.key === "description").quoted, false);
  assert.match(plainScalarProblem(e.find((x) => x.key === "description").value), /quote/);
  const good = '---\nname: x\ndescription: "a: b"\n---\n';
  assert.equal(frontmatterEntries(good).find((x) => x.key === "description").quoted, true);
  assert.equal(plainScalarProblem("PowerPoint (.pptx) — создать презентацию"), null);
});

const dirs = existsSync(SKILLS) ? readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

test("ops/opencode/skills is not empty", () => assert.ok(dirs.length > 0));

for (const dir of dirs) {
  test(`skill ${dir}: frontmatter is valid for opencode and Claude`, () => {
    const file = path.join(SKILLS, dir, "SKILL.md");
    assert.ok(existsSync(file), "SKILL.md missing");
    const entries = frontmatterEntries(readFileSync(file, "utf8"));
    assert.ok(entries, "no --- frontmatter --- block");
    const get = (k) => entries.find((x) => x.key === k);
    assert.equal(get("name")?.value.replace(/^["']|["']$/g, ""), dir, "name must equal the folder name");
    assert.ok(get("description")?.value, "description required");
    for (const { key, value, quoted } of entries) {
      if (quoted || value === "") continue;
      const p = plainScalarProblem(value);
      assert.equal(p, null, `${key}: ${p}`);
    }
  });
}
