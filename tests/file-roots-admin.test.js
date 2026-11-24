// BUG-249 (BUG-05.29): a file the agent shows by absolute path outside
// TELEHARNESS_FILE_ROOTS (e.g. the stage worktree D/teleharness-stage) was «недоступен в этом
// чате» even for the admin. Admin: any existing file; tenant: own roots only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileRoots } from "../lib/auth.js";
import { workspaceFileExists, resolveInside } from "../lib/file.js";

const chat = mkdtempSync(path.join(tmpdir(), "teleharness-chat-"));
const elsewhere = mkdtempSync(path.join(tmpdir(), "teleharness-stage-"));
after(() => {
  rmSync(chat, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});
mkdirSync(path.join(elsewhere, "design"));
const mock = path.join(elsewhere, "design", "temporal-ui-v2.html");
writeFileSync(mock, "<!doctype html><p>макет</p>");
const admin = { id: "admin", role: "admin" };
const tenant = { id: "t1", role: "tenant", directories: [chat], extraRoots: [] };

test("BUG-249: admin sees an existing file outside the configured roots", () => {
  assert.equal(workspaceFileExists(chat, mock, fileRoots(admin)), true);
});

test("BUG-249: tenant still cannot reach a file outside its roots", () => {
  assert.equal(workspaceFileExists(chat, mock, fileRoots(tenant)), false);
  assert.equal(resolveInside(chat, mock, fileRoots(tenant)), null);
});

test("BUG-249: admin missing file stays missing", () => {
  assert.equal(workspaceFileExists(chat, path.join(elsewhere, "nope.html"), fileRoots(admin)), false);
});
