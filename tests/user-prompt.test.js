// FEAT-03.22 (user system prompt) + FEAT-03.21 (tenant MCP view) — pure units.
// Run: node --test tests/user-prompt.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT_MAX, cleanSystemPrompt, withUserSystem, withUserSystemBody, claudePromptFile, USER_SECTION, REMINDER_MARK, reminderPart } from "../lib/user-prompt.js";
import { TENANT_MCP, tenantMcpView } from "../lib/policy.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), "zai-user-prompt-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

test("cleanSystemPrompt: trims, CRLF → LF, strips control chars, empty/null → ''", () => {
  assert.equal(cleanSystemPrompt("  a\r\nb\rc\u0000\u0007\t d  "), "a\nb\nc\t d");
  assert.equal(cleanSystemPrompt(""), "");
  assert.equal(cleanSystemPrompt(null), "");
  assert.equal(cleanSystemPrompt(undefined), "");
  assert.equal(cleanSystemPrompt("   \n  "), "");
});

test("cleanSystemPrompt: limit 4000 characters (code points), Russian message, non-strings refused", () => {
  assert.equal(SYSTEM_PROMPT_MAX, 4000);
  assert.equal(cleanSystemPrompt("я".repeat(4000)).length, 4000);
  assert.equal([...cleanSystemPrompt("😀".repeat(4000))].length, 4000, "an emoji is one character");
  assert.throws(() => cleanSystemPrompt("я".repeat(4001)), (e) => e.status === 400 && /4000 символов/.test(e.message));
  assert.throws(() => cleanSystemPrompt(42), (e) => e.status === 400 && /текстом/.test(e.message));
  assert.throws(() => cleanSystemPrompt({ text: "x" }), (e) => e.status === 400);
});

test("withUserSystem: tenant — only the stored prompt; admin — own `system` kept in front", () => {
  const body = { parts: [{ type: "text", text: "hi" }], agent: "build" };
  const R = reminderPart("USER");
  assert.deepEqual(withUserSystem(body, "USER"), { ...body, system: "USER", parts: [...body.parts, R] });
  assert.deepEqual(withUserSystem({ ...body, system: "SNEAKY" }, "USER"), { ...body, system: "USER", parts: [...body.parts, R] }, "a tenant cannot add its own");
  assert.deepEqual(withUserSystem({ ...body, system: "SNEAKY" }, ""), body, "nor send one without a stored prompt");
  assert.deepEqual(withUserSystem({ ...body, system: "CLIENT" }, "USER", { admin: true }), { ...body, system: "CLIENT\n\nUSER", parts: [...body.parts, R] });
  assert.deepEqual(withUserSystem(body, "", { admin: true }), body, "no prompt → no field");
  assert.equal(body.system, undefined, "input not mutated");
  assert.equal(body.parts.length, 1, "input parts not mutated");
});

test("withUserSystem: the hidden reminder — synthetic, marked, one per turn; a resent stale copy is replaced or dropped", () => {
  const R = reminderPart("Отвечай кратко");
  assert.equal(R.synthetic, true, "hidden in the portal UI like the voice hint");
  assert.ok(R.text.startsWith(REMINDER_MARK) && R.text.includes("Отвечай кратко") && R.text.endsWith("</system-reminder>"));
  const voice = { type: "text", synthetic: true, text: "[voice] hint" };
  const resent = { parts: [{ type: "text", text: "hi" }, voice, reminderPart("СТАРЫЙ")] };
  const now = withUserSystem(resent, "НОВЫЙ");
  assert.deepEqual(now.parts.map((p) => p.text.includes("СТАРЫЙ")), [false, false, false], "old reminder gone");
  assert.equal(now.parts.filter((p) => p.text.startsWith(REMINDER_MARK)).length, 1);
  assert.equal(now.parts[1], voice, "other synthetic parts (voice hint) kept");
  const cleared = withUserSystem(resent, "");
  assert.deepEqual(cleared.parts, [resent.parts[0], voice], "prompt cleared → no reminder at all");
  const forged = { type: "text", text: REMINDER_MARK + " fake" }; // not synthetic: the user's own visible text stays
  assert.deepEqual(withUserSystem({ parts: [forged] }, "").parts, [forged]);
});

test("withUserSystemBody: Buffer in/out, non-JSON and arrays pass through unchanged", () => {
  const raw = Buffer.from(JSON.stringify({ parts: [{ type: "text", text: "привет" }] }), "utf8");
  const out = JSON.parse(withUserSystemBody(raw, "Отвечай кратко", false).toString("utf8"));
  assert.equal(out.system, "Отвечай кратко");
  assert.equal(out.parts[0].text, "привет", "UTF-8 intact");
  assert.equal(withUserSystemBody(raw, "", false), raw, "nothing to do → same buffer");
  const stale = Buffer.from(JSON.stringify({ parts: [{ type: "text", text: "a" }, reminderPart("old")] }), "utf8");
  assert.equal(JSON.parse(withUserSystemBody(stale, "", true).toString("utf8")).parts.length, 1, "a stale reminder is dropped even with no prompt");
  const junk = Buffer.from("not json");
  assert.equal(withUserSystemBody(junk, "X", false), junk);
  assert.equal(withUserSystemBody("[1]", "X", false).toString(), "[1]");
});

test("claudePromptFile: no prompt → base; tenant base + user section; content-addressed, written once", () => {
  const dir = path.join(TMP, "prompts");
  const base = path.join(TMP, "kit.md");
  writeFileSync(base, "KIT\n\n\n", "utf8");
  assert.equal(claudePromptFile(dir, "", base), base);
  assert.equal(claudePromptFile(dir, "", null), null);
  const f1 = claudePromptFile(dir, "Будь краток", base);
  assert.equal(readFileSync(f1, "utf8"), "KIT\n\n" + USER_SECTION + "Будь краток\n");
  assert.equal(claudePromptFile(dir, "Будь краток", base), f1, "same text → same file");
  const f2 = claudePromptFile(dir, "Будь краток", null);
  assert.notEqual(f2, f1);
  assert.ok(readFileSync(f2, "utf8").startsWith(USER_SECTION), "admin: user section only");
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0, "no temp leftovers");
  assert.equal(readdirSync(dir).length, 2);
});

test("FEAT-03.21: tenantMcpView — whitelist only, status only (no error text, no foreign servers)", () => {
  const raw = {
    websearch: { status: "connected" },
    context7: { status: "connected" },
    grep_app: { status: "connected" },
    lsp: { status: "connected" },
    playwright: { status: "failed", error: "spawn C:\\Users\\USER\\npx ENOENT" },
    marketplace: { status: "failed", error: "C:\\Users\\USER\\AppData\\Local\\ru-marketplace-mcp crashed" },
    "owner-secret": { status: "connected" },
  };
  const v = tenantMcpView(raw);
  assert.deepEqual(Object.keys(v).sort(), ["context7", "grep_app", "marketplace", "websearch"]);
  assert.deepEqual(v.marketplace, { status: "failed" });
  assert.equal(JSON.stringify(v).includes("USER"), false, "no owner paths");
  assert.deepEqual(tenantMcpView([{ name: "marketplace", status: "connected", error: "x" }, { name: "lsp", status: "connected" }]), { marketplace: { status: "connected" } }, "array form");
  assert.deepEqual(tenantMcpView(null), {});
});

test("FEAT-03.21: TENANT_MCP matches the sandbox plugin's TENANT_TOOL_PREFIXES (one truth)", () => {
  const ts = readFileSync(path.join(ROOT, "ops", "opencode", "vault-cache.ts"), "utf8");
  const m = ts.match(/const TENANT_TOOL_PREFIXES = \[([^\]]*)\]/);
  assert.ok(m, "TENANT_TOOL_PREFIXES found in vault-cache.ts");
  const prefixes = [...m[1].matchAll(/"([^"]+)_"/g)].map((x) => x[1]).sort();
  assert.deepEqual([...TENANT_MCP].sort(), prefixes);
});
