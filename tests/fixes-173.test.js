// zai 1.7.3 — prod dogfood 1.7.2 low findings (BUG-088, BUG-089).
// BUG-086 → client-172.test.js, BUG-087 → chat-display.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keepTitle, mergeSessionList, upsertSession, isDefaultSessionTitle } from "../src/lib/normalize.js";
import { findOwnerlessTenantDirs, removeEmptyTree, sweepOwnerlessTenantDirs } from "../lib/gc.js";

const DEF = "New session - 2026-11-03T08:12:51.585Z";

test("BUG-088: a known title never goes back to the upstream default", () => {
  assert.equal(isDefaultSessionTitle(DEF), true);
  assert.equal(keepTitle("Столица Франции", DEF), "Столица Франции");
  assert.equal(keepTitle(DEF, "Столица Франции"), "Столица Франции");
  assert.equal(keepTitle("Старое", "Новое"), "Новое"); // rename still wins
  const list = [{ id: "a", title: "Столица Франции", time: { updated: 200 } }];
  assert.equal(upsertSession(list, { id: "a", title: DEF })[0].title, "Столица Франции");
  // stale full refetch: old title + old time are not applied over live ones
  const merged = mergeSessionList(list, [{ id: "a", title: DEF, time: { updated: 100 }, directory: "D:/x" }, { id: "b", title: DEF, time: { updated: 150 } }]);
  assert.deepEqual(merged.map((s) => [s.id, s.title, s.time.updated]), [["a", "Столица Франции", 200], ["b", DEF, 150]]);
  assert.equal(merged[0].directory, "D:/x");
  // a chat gone from the fetched list is gone (deleted elsewhere)
  assert.deepEqual(mergeSessionList(list, []).length, 0);
});

test("BUG-089: ownerless tenant folders — reported; only empty, chat-free, old ones removable", () => {
  const home = mkdtempSync(path.join(tmpdir(), "zai-ten-"));
  try {
    const mk = (n, file = false) => {
      const p = path.join(home, n);
      mkdirSync(path.join(p, "sub", "deep"), { recursive: true });
      if (file) writeFileSync(path.join(p, "sub", "f.txt"), "x");
      return p;
    };
    const owned = mk("Alice");
    const empty = mk("kcprobe1");
    const withFile = mk("smokecheck", true);
    const withChat = mk("chatdir");
    const later = Date.now() + 2 * 3_600_000;
    const list = findOwnerlessTenantDirs({ home, isReferenced: (p) => p === owned, sessionDirs: [path.join(withChat, "sub")], now: later });
    const by = Object.fromEntries(list.map((x) => [path.basename(x.path), x]));
    assert.equal(by.Alice, undefined);
    assert.equal(by.kcprobe1.removable, true);
    assert.equal(by.smokecheck.removable, false);
    assert.equal(by.smokecheck.files, 1);
    assert.equal(by.chatdir.removable, false);
    // fresh folder (now = real time) is not removable yet
    assert.equal(findOwnerlessTenantDirs({ home, isReferenced: () => false }).every((x) => !x.removable), true);
    // removeEmptyTree never deletes a file
    assert.throws(() => removeEmptyTree(withFile));
    assert.equal(existsSync(path.join(withFile, "sub", "f.txt")), true);
    return sweepOwnerlessTenantDirs(list).then((r) => {
      assert.deepEqual(r.removed.map((p) => path.basename(p)), ["kcprobe1"]);
      assert.equal(existsSync(empty), false);
      assert.equal(existsSync(withFile) && existsSync(withChat) && existsSync(owned), true);
    });
  } finally {
    setTimeout(() => rmSync(home, { recursive: true, force: true }), 50);
  }
});

test("BUG-164: a finished turn of the open chat re-reads its history once (debounced); other chats — never", async () => {
  const { scheduleHeal } = await import("../src/lib/store/events.js");
  const { active } = await import("../src/lib/store/state.js");
  const calls = [];
  const refresh = (sid) => calls.push(sid);
  active.value = { id: "open", messages: [], status: "idle" };
  scheduleHeal("open", { delay: 20, refresh });
  scheduleHeal("open", { delay: 20, refresh }); // idle + status idle: one re-read
  scheduleHeal("other", { delay: 20, refresh });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(calls, ["open"]);
  active.value = null;
});
