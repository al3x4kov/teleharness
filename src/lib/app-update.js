// BUG-179 (BUG-08.11): выкат фронта без рестарта не доходил до приложения на
// телефоне — iOS держит веб-приложение в памяти, страница не перезагружается
// часами. При старте запоминаем ETag app.js; при возврате в приложение
// сравниваем; сменился — перезагрузка, если пользователь не печатает
// (черновик чата переживает перезагрузку, ISSUE-015).
const MIN_GAP_MS = 30_000;

export function createUpdater({ fetchHead, reload, isTyping, now, minGapMs = MIN_GAP_MS }) {
  let base = null;
  let last = -Infinity;
  const head = async () => {
    try {
      return (await fetchHead()) || null;
    } catch {
      return null;
    }
  };
  return {
    async init() {
      base = await head();
      last = now();
    },
    // → true, если запущена перезагрузка
    async onVisible() {
      if (now() - last < minGapMs) return false;
      last = now();
      const e = await head();
      if (!e) return false;
      if (!base) {
        base = e;
        return false;
      }
      if (e === base || isTyping()) return false;
      reload();
      return true;
    },
  };
}

export function installAppUpdate() {
  if (typeof document === "undefined" || typeof fetch !== "function") return () => {};
  const url = new URL("app.js", document.baseURI).href;
  const u = createUpdater({
    fetchHead: async () => {
      const r = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
      return r.ok ? r.headers.get("etag") || r.headers.get("last-modified") : null;
    },
    reload: () => location.reload(),
    isTyping: () => {
      const tag = document.activeElement?.tagName;
      return tag === "TEXTAREA" || tag === "INPUT";
    },
    now: () => Date.now(),
  });
  u.init();
  const onVis = () => {
    if (document.visibilityState === "visible") u.onVisible();
  };
  document.addEventListener("visibilitychange", onVis);
  return () => document.removeEventListener("visibilitychange", onVis);
}
