// TASK-18.18: guard against accidental legacy brand leaks in the public Teleharness repository.
// External LLM provider names (z.ai, zai-coding-plan, zai/glm-*, zai-org/*) and the historical
// CHANGELOG.md rename note are legitimate and explicitly allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", "node_modules", "data", "public", "__pycache__", ".venv", "venv"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".json", ".jsonc", ".md", ".yml", ".yaml", ".sh", ".ps1", ".cmd", ".css", ".html", ".svg", ".example", ".plist", ".service"]);
const ALLOW_FILES = new Set(["tests/no-legacy-brand.test.js", "CHANGELOG.md"]);

function walk(dir, rel = "", out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, nextRel, out);
    else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (TEXT_EXT.has(ext) || ent.name === ".env.example") out.push(nextRel);
    }
  }
  return out;
}

// Strip every legitimate Z.AI LLM-provider occurrence individually so a single-line JSON file
// with both providerID:"zai" and an accidental brand leak still fails.
function stripLegitimateProviderRefs(line) {
  let s = line
    .replace(/\bzai:\s*(?:async|deps\.usageStats|null|"Z\.AI"|\{)/g, "")
    .replace(/z\.ai/gi, "")
    .replace(/zai-coding-plan/gi, "")
    .replace(/zai-coding/gi, "")
    .replace(/zai_coding/gi, "")
    .replace(/zai-org\//gi, "")
    .replace(/zai\.ai/gi, "")
    .replace(/zai\/glm[^\s"'`,)]*/gi, "")
    .replace(/["']?(?:providerID|provider)["']?\s*[:=]\s*["']zai["']/g, "")
    .replace(/["']?id["']?\s*[:=]\s*["']zai["']/g, "")
    .replace(/(?:\.id|pid|needs)\s*===\s*["']zai["']/g, "")
    .replace(/needs:\s*["']zai["']/g, "")
    .replace(/raw\["zai"\]/g, "")
    .replace(/\bby\.zai\b/g, "")
    .replace(/\bzai\??\.models\b/g, "")
    .replace(/\bzai:\s*(?:async|deps\.usageStats|null|"Z\.AI"|\{)/g, "")
    .replace(/\b(?:zaiPlan|zaiApi)\b/g, "")
    .replace(/isPaidOpencodeModel\("zai"/g, "")
    .replace(/\bm\("zai"/g, "")
    .replace(/\boc\("a[12]",\s*"zai"/g, "")
    .replace(/answer\("zai",\s*"glm-/g, "")
    .replace(/GLM\("glm-[^"]+",\s*"zai"\)/g, "")
    .replace(/text\("zai"\)/g, "")
    .replace(/\(zai\)/g, "")
    .replace(/\^zai/g, "")
    .replace(/\bu = await zai\(\)/g, "")
    .replace(/\bzai\(\) → payload/g, "")
    .replace(/const zai = /g, "")
    .replace(/providers:\s*\[zai\b/g, "")
    .replace(/"zai":\s*\{\s*"type":\s*"api"/g, "")
    .replace(/assert\.equal\(turn\.providerID,\s*"zai"\)/g, "");
  // Narrow line-level allowlist for provider arrays/signatures in catalog/subscription code & tests
  if (/PROVIDER_ORDER|connected.*["']zai["']|["']zai["'],\s*["'](?:openrouter|claude)["']|tIds,\s*\["zai"\]|subscriptionCards\(\{|"admin:<ENV>"/.test(line)) {
    s = s.replace(/["']zai["']|\bzai\b/g, "");
  }
  return s;
}

test("public repo has no non-provider legacy brand mentions", () => {
  const leaks = [];
  for (const rel of walk(ROOT)) {
    if (ALLOW_FILES.has(rel)) continue;
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    if (!/zai/i.test(text)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/zai/i.test(lines[i])) continue;
      const stripped = stripLegitimateProviderRefs(lines[i]);
      if (/zai/i.test(stripped)) {
        leaks.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(leaks, [], "Found non-provider legacy brand mentions:\n" + leaks.join("\n"));
});
