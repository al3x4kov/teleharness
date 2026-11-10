// FEAT-04.12 stage B: every new tenant chat works in its own subfolder
// <tenant>\chats\<session id without ses_>; the session directory stays the
// tenant root (one opencode instance per tenant). lib/chat-folder.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatFolderName, chatFolderFor, ensureChatFolder, existingChatFolder } from "../lib/chat-folder.js";

test("имя подпапки: id сессии без ses_, только [A-Za-z0-9]; мусор → null", () => {
  assert.equal(chatFolderName("ses_e4dbc9c08ffe3VS4UTeP794cRa"), "e4dbc9c08ffe3VS4UTeP794cRa");
  assert.equal(chatFolderName("ses_x1"), "x1");
  for (const bad of ["", null, "ses_", "ses_../x", "ses_a b", "ses_a\\b", "abc", "ses_Привет"]) assert.equal(chatFolderName(bad), null, String(bad));
  assert.equal(chatFolderFor("C:/t/alice", "ses_ab12"), path.join("C:/t/alice", "chats", "ab12"));
  assert.equal(chatFolderFor("C:/t/alice", "bad"), null);
});

test("ensureChatFolder: папка + .zai-uploads → общие вложения тенанта; повтор не ломает; existingChatFolder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zai-chatdir-"));
  try {
    assert.equal(existingChatFolder(root, "ses_abc"), null, "до создания — null (старый чат)");
    const dir = ensureChatFolder(root, "ses_abc");
    assert.equal(dir, path.join(root, "chats", "abc"));
    assert.ok(lstatSync(dir).isDirectory());
    const link = path.join(dir, ".zai-uploads");
    assert.ok(lstatSync(link).isSymbolicLink(), "junction на вложения");
    assert.equal(realpathSync(link).toLowerCase(), realpathSync(path.join(root, ".zai-uploads")).toLowerCase());
    writeFileSync(path.join(root, ".zai-uploads", "a.txt"), "x");
    assert.equal(readFileSync(path.join(link, "a.txt"), "utf8"), "x", "вложение читается из подпапки");
    assert.equal(ensureChatFolder(root, "ses_abc"), dir, "идемпотентно");
    assert.equal(existingChatFolder(root, "ses_abc"), dir);
    assert.equal(ensureChatFolder(root, "ses_../evil"), null);
    assert.equal(existsSync(path.join(root, "evil")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existingChatFolder: файл вместо папки или ссылка наружу — не рабочая папка", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zai-chatdir-"));
  try {
    mkdirSync(path.join(root, "chats"), { recursive: true });
    writeFileSync(path.join(root, "chats", "f1"), "x");
    assert.equal(existingChatFolder(root, "ses_f1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
