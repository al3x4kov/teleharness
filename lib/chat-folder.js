// FEAT-04.12 stage B (2026-11-06): every NEW tenant chat works in its
// own subfolder <tenant folder>\chats\<session id without «ses_»>, so parallel
// chats no longer overwrite each other's files. The session directory stays the
// tenant root: opencode keeps ONE instance (config, plugins, MCP processes) per
// tenant instead of one per chat (BUG-182: 117 instances exhausted the stand).
// The folder exists only for chats created under this scheme — its presence is
// the switch (old chats keep working in the root). Inside: a junction
// «.zai-uploads» to the tenant's attachments, so the «.zai-uploads/<name>»
// reference of a message works from the chat folder (cwd, jail, python).
// The opencode plugin (ops/opencode/vault-cache.ts chatDirOf) derives the same
// path; tests/chat-folder.test.js pins the formula.
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

export const CHATS_DIR = "chats";
export const UPLOADS = ".zai-uploads";
const ID = /^ses_([A-Za-z0-9]{1,64})$/;

// "ses_e4db…" → "e4db…"; anything else → null (never a path piece from junk).
export function chatFolderName(sid) {
  const m = ID.exec(String(sid ?? ""));
  return m ? m[1] : null;
}

export function chatFolderFor(root, sid) {
  const name = chatFolderName(sid);
  if (!name || typeof root !== "string" || !root) return null;
  return path.join(root, CHATS_DIR, name);
}

// The chat folder when it exists as a real directory, else null (an old chat).
export function existingChatFolder(root, sid) {
  const dir = chatFolderFor(root, sid);
  if (!dir) return null;
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch {
    return null;
  }
}

// Create the folder and its attachments junction (idempotent). → folder or null.
export function ensureChatFolder(root, sid) {
  const dir = chatFolderFor(root, sid);
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const uploads = path.join(root, UPLOADS);
  mkdirSync(uploads, { recursive: true });
  const link = path.join(dir, UPLOADS);
  if (!existsSync(link)) {
    try {
      symlinkSync(uploads, link, "junction");
    } catch {
      // no junction (non-NTFS): attachments stay reachable by the absolute path
    }
  }
  return dir;
}
