// zai entry: mount the app shell. Permission/question requests render INLINE
// above the composer (DialogBar in ChatView) — a blocking modal was removed on
// purpose: nothing in this UI may gray out the screen or trap taps.
// app.css is imported here so esbuild emits one stylesheet (base + component
// css imported from js) to public/app.css — see build.mjs.
import "./app.css";
import { render } from "preact";
import { applyStoredTheme } from "./lib/theme.js";
import AppShell from "./components/AppShell.jsx";
import { listenServiceWorker, pushSupport, registerServiceWorker, startPresence } from "./lib/push.js";
// FEAT-09.20: слой стиля приложения Claude — ПОСЛЕДНИМ, чтобы перекрыть
// токены и вид компонентов из app/views/chat/dialogs css.
import "./claude-look.css";

// Restore the stored theme BEFORE the first render: index.html's head script
// already covers pre-paint; this keeps the attribute authoritative for the
// SPA lifetime no matter which route the tab boots on.
applyStoredTheme();

render(
  <AppShell />,
  document.getElementById("root"),
);

// FEAT-07.20: service worker (scope /zai/) for Web Push + notification taps;
// presence tells the server which chat is in front (no push for it).
if (pushSupport().ok) {
  listenServiceWorker();
  registerServiceWorker().then(() => startPresence());
}
