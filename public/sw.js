// FEAT-07.20: service worker of the zai portal — Web Push only.
// Scope /zai/ (served as /zai/sw.js). No fetch handler on purpose: the app is
// never served from a cache (a stale bundle after a deploy is worse than no
// offline mode).
//
// push → showNotification, unless a focused visible window already shows
// that chat (the server skips such devices too — /push/presence — because
// iOS revokes subscriptions whose pushes end without a notification).
// notificationclick → focus a portal window and open #/chat/<id>, or open one.
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function chatOf(url) {
  const m = /#\/chat\/([^/?#]+)/.exec(String(url || ""));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// Which chat a window shows. Client.url is NOT enough: Chromium keeps the
// URL the document was created with, hash navigations (#/settings →
// #/chat/x) do not update it (live check 2026-11-04, BUG-150) — so the
// window is asked; its URL is only the fallback when it does not answer.
function askChat(client) {
  return new Promise((resolve) => {
    let ch = null;
    let timer = null;
    const done = (chat) => {
      clearTimeout(timer);
      try {
        ch && ch.port1.close();
      } catch {}
      resolve(chat);
    };
    try {
      ch = new MessageChannel();
      timer = setTimeout(() => done(chatOf(client.url)), 700);
      ch.port1.onmessage = (e) => done((e.data && e.data.chat) || null);
      client.postMessage({ type: "zai.which-chat" }, [ch.port2]);
    } catch {
      done(chatOf(client.url));
    }
  });
}

async function chatIsInFront(chat) {
  if (!chat) return false;
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const front = list.filter((c) => c.focused && c.visibilityState !== "hidden");
  const chats = await Promise.all(front.map(askChat));
  return chats.includes(chat);
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Teleharness", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      if (await chatIsInFront(data.chat)) return;
      await self.registration.showNotification(data.title || "Teleharness", {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        lang: "ru",
        data: { url: data.url || "/zai/", chat: data.chat || null },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/zai/", self.location.origin);
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = list.find((c) => new URL(c.url).pathname.startsWith("/zai/"));
      if (win) {
        // The app switches the hash itself (no reload of a live chat).
        win.postMessage({ type: "zai.open", url: target.pathname + target.hash });
        try {
          return await win.focus();
        } catch {
          return undefined;
        }
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});

// The browser rotated the subscription: hand the new one to the server
// (same-origin fetch carries the session cookie).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription || null;
      if (!sub) {
        const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
        if (!key) return;
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch("/zai/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
    })().catch(() => {}),
  );
});
