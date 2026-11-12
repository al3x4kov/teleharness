// Reasoning part: visible while it streams, auto-collapsed once it ends
// (a finished "Думал 12с" must not eat 44vh on every visit); a manual
// toggle always wins over the auto behavior.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../lib/i18n.js";

export default function Reasoning({ text = "", time, streaming = false, hasText = false }) {
  const start = Number(time?.start);
  const end = Number(time?.end);
  const secs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, Math.round((end - start) / 1000)) : null;
  const live = streaming && !Number.isFinite(end);

  const [open, setOpen] = useState(live);
  const touched = useRef(false); // user opened/closed by hand
  const seenLive = useRef(live);

  useEffect(() => {
    if (live) seenLive.current = true;
  }, [live]);

  useEffect(() => {
    // First text delta, or the reasoning just finished: fold it away unless
    // the user explicitly expanded it.
    if (touched.current) return;
    if (hasText) setOpen(false);
    else if (seenLive.current && !live) setOpen(false);
  }, [hasText, live]);

  const label = !live && secs != null ? t("reasoning.thoughtFor", { secs }) : t("reasoning.thinking");
  const bodyRef = useRef(null);

  // Follow the tail while streaming: the block caps at 44vh, and without this
  // the newest text hides below the fold (user feedback 2026-10-31). When the
  // user scrolls UP manually, tracking stops until they return to the bottom.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !live) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stick) el.scrollTop = el.scrollHeight;
  }, [text, open, live]);

  return (
    <div class="reasoning">
      <button
        class={"reasoning-head" + (live ? " is-streaming" : "")}
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
      >
        <span class="reasoning-dot" aria-hidden="true" />
        <span>{label}</span>
        <span class="reasoning-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && <div class="reasoning-body" ref={bodyRef}>{text}</div>}
    </div>
  );
}
