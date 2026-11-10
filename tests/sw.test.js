// FEAT-07.20 / BUG-150 (L1): public/sw.js in a fake worker scope.
//   - push → showNotification; NOT shown when a focused visible window shows
//     that chat — asked over a MessageChannel (Client.url misses hash
//     navigations in Chromium, live check 2026-11-04);
//   - a window that does not answer → its URL decides (fallback);
//   - notificationclick → focus + «zai.open» to an open window, else openWindow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js"), "utf8");

function client({ url, focused = true, visibilityState = "visible", answers = undefined }) {
  const posted = [];
  return {
    url, focused, visibilityState, posted,
    postMessage(msg, ports) {
      posted.push(msg);
      if (msg.type === "zai.which-chat" && answers !== undefined) ports[0].postMessage({ chat: answers });
    },
    focus: async function () {
      this.didFocus = true;
      return this;
    },
  };
}

function worker(clients) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: "https://zai.test" },
    addEventListener: (t, fn) => (handlers[t] = fn),
    skipWaiting: () => {},
    clients: { matchAll: async () => clients, claim: async () => {}, openWindow: async (u) => opened.push(u) },
    registration: { showNotification: async (title, opts) => shown.push({ title, ...opts }) },
  };
  vm.runInNewContext(SRC, { self, MessageChannel, setTimeout, clearTimeout, URL, fetch: async () => ({}), console });
  const fire = async (type, ev) => {
    let p;
    handlers[type]({ ...ev, waitUntil: (x) => (p = x) });
    await p;
  };
  return { fire, shown, opened };
}
const pushEv = (data) => ({ data: { json: () => data, text: () => JSON.stringify(data) } });
const DATA = { title: "Готово: Живой чат", body: "Ход завершён", chat: "ses_live", url: "/zai/#/chat/ses_live", tag: "zai-ses_live" };

test("push: the window answers «ses_live» (its URL still says #/settings) → no notification", async () => {
  const w = worker([client({ url: "https://zai.test/zai/#/settings", answers: "ses_live" })]);
  await w.fire("push", pushEv(DATA));
  assert.equal(w.shown.length, 0);
});

test("push: another chat in front, an unfocused or hidden window with this chat → notification with url/tag", async () => {
  for (const c of [
    client({ url: "https://zai.test/zai/#/chat/ses_live", answers: "ses_other" }),
    client({ url: "https://zai.test/zai/#/chat/ses_live", focused: false, answers: "ses_live" }),
    client({ url: "https://zai.test/zai/#/chat/ses_live", visibilityState: "hidden", answers: "ses_live" }),
  ]) {
    const w = worker([c]);
    await w.fire("push", pushEv(DATA));
    assert.equal(w.shown.length, 1);
    assert.equal(w.shown[0].title, "Готово: Живой чат");
    assert.equal(w.shown[0].data.url, "/zai/#/chat/ses_live");
    assert.equal(w.shown[0].tag, "zai-ses_live");
  }
});

test("push: a window that does not answer → its URL decides", async () => {
  const w = worker([client({ url: "https://zai.test/zai/#/chat/ses_live" })]);
  await w.fire("push", pushEv(DATA));
  assert.equal(w.shown.length, 0);
});

test("notificationclick: open window → «zai.open» + focus; none → openWindow(/zai/#/chat/<id>)", async () => {
  const c = client({ url: "https://zai.test/zai/#/settings" });
  const w = worker([c]);
  let closed = false;
  await w.fire("notificationclick", { notification: { data: { url: "/zai/#/chat/ses_live" }, close: () => (closed = true) } });
  assert.ok(closed);
  assert.equal(JSON.stringify(c.posted.at(-1)), JSON.stringify({ type: "zai.open", url: "/zai/#/chat/ses_live" }));
  assert.ok(c.didFocus);
  const w2 = worker([]);
  await w2.fire("notificationclick", { notification: { data: { url: "/zai/#/chat/ses_live" }, close: () => {} } });
  assert.equal(JSON.stringify(w2.opened), JSON.stringify(["https://zai.test/zai/#/chat/ses_live"]));
});
