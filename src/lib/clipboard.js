// One clipboard helper for the chat (BUG-01.30/R-24): navigator.clipboard
// exists only in secure contexts — the portal is also opened over plain http
// on the LAN, where every copy button used to fail silently. Fallback: a
// hidden textarea + execCommand("copy") inside the same user gesture.
// env is injectable for node tests ({navigator, document}). Resolves true on
// success, false otherwise; never throws.
export async function copyText(text, env = globalThis) {
  const s = String(text ?? "");
  if (!s) return false;
  const nav = env?.navigator;
  if (nav?.clipboard?.writeText && env?.isSecureContext !== false) {
    try {
      await nav.clipboard.writeText(s);
      return true;
    } catch {
      // permission denied / insecure — try the legacy path below
    }
  }
  const doc = env?.document;
  if (!doc?.createElement || !doc.body) return false;
  const sel = doc.getSelection?.();
  const savedRanges = [];
  if (sel && sel.rangeCount > 0) {
    for (let i = 0; i < sel.rangeCount; i += 1) {
      try {
        savedRanges.push(sel.getRangeAt(i).cloneRange());
      } catch {}
    }
  }
  const ta = doc.createElement("textarea");
  ta.value = s;
  ta.readOnly = true;
  ta.tabIndex = -1;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.setAttribute("data-teleharness-clipboard", "1");
  // Off-screen, 16px: iOS zooms on focusing a smaller field even for a tick.
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px;pointer-events:none";
  doc.body.appendChild(ta);
  const prevFocus = doc.activeElement;
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange?.(0, s.length);
    ok = doc.execCommand?.("copy") === true;
  } catch {
    ok = false;
  }
  try {
    if (typeof ta.remove === "function") ta.remove();
    else doc.body.removeChild?.(ta);
  } catch {}
  if (sel && savedRanges.length > 0) {
    try {
      sel.removeAllRanges();
      for (const r of savedRanges) sel.addRange(r);
    } catch {}
  }
  try {
    if (prevFocus && prevFocus !== doc.body && prevFocus !== doc.documentElement) {
      prevFocus.focus?.({ preventScroll: true });
    }
  } catch {}
  return ok;
}
