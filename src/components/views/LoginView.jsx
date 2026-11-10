// Login: the long access token IS the credential. A match mints the
// year-long HttpOnly cookie server-side — nothing sensitive is stored in
// the page, and the device stays logged in across reloads. Errors are
// honest and short. Layout: animated zai mark + centered token field over
// a Matrix-style rain in the portal accent (user request 2026-11-01).
// Rain discipline: dim, pointer-transparent, paused when the tab hides,
// reduced-motion renders one static sparse field instead of the loop.
import { useEffect, useRef, useState } from "preact/hooks";
import { loginWithToken, me } from "../../lib/store.js";
import { ZaiMark } from "../Menu.jsx";
import { t } from "../../lib/i18n.js";
import "../views.css";

// L-4: a 401 in the middle of work (cookie revoked, token re-issued) drops
// me from a user object to false (AppShell's onUnauthorized). Watching that
// transition here tells the login screen to explain WHY the user is back —
// a first visit or a deliberate «Выйти» (which reloads the page) never sets it.
let prevMe = me.value;
let expired = false;
me.subscribe((v) => {
  if (v === false && prevMe && typeof prevMe === "object") expired = true;
  else if (v && typeof v === "object") expired = false;
  prevMe = v;
});
export function sessionExpired() {
  return expired;
}

// Error texts name the next action (L-2); `field` = the token itself is wrong
// (only then the input turns red — a network error is not the user's typo).
export function loginError(err) {
  if (err?.status === 401) return { text: t("login.err.401"), field: true };
  if (err?.status === 429) return { text: t("login.err.429"), field: false };
  return { text: t("login.err.network"), field: false };
}

const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ZAI<>+=/\\|".split("");
const TICK_MS = 66; // ~15fps: the classic matrix cadence, battery-friendly

// Matrix rain on a fixed, pointer-transparent canvas. Trail fade uses
// destination-out (erases toward transparency) so the CSS radial glows of
// .login-screen stay visible behind the canvas.
function useMatrixRain(canvasRef) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const styles = getComputedStyle(document.documentElement);
    const accent = (styles.getPropertyValue("--accent") || "#45b8a8").trim() || "#45b8a8";

    let raf = 0;
    let last = 0;
    let drops = [];
    let fontSize = 15;
    let cols = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fontSize = w < 480 ? 13 : 15;
      cols = Math.ceil(w / fontSize);
      // Stagger starting heights so the field lights up spread out.
      drops = Array.from({ length: cols }, () => Math.floor((Math.random() * -h) / fontSize));
      if (reduced) drawStatic();
    };

    const drawGlyph = (col, row, alpha) => {
      const g = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      ctx.fillStyle = accent;
      ctx.globalAlpha = alpha;
      ctx.fillText(g, col * fontSize, row * fontSize);
      ctx.globalAlpha = 1;
    };

    // Reduced motion: one sparse, static field — atmosphere without motion.
    const drawStatic = () => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.font = `${fontSize}px ui-monospace, monospace`;
      const rows = Math.ceil(window.innerHeight / fontSize);
      for (let c = 0; c < cols; c += 1) {
        for (let r = 0; r < rows; r += 1) {
          if (Math.random() < 0.045) drawGlyph(c, r, 0.14);
        }
      }
    };

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      if (now - last < TICK_MS) return;
      last = now;
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Erase toward transparency (keeps the CSS glow behind the canvas).
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 0.09)";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.font = `${fontSize}px ui-monospace, monospace`;
      for (let c = 0; c < drops.length; c += 1) {
        drawGlyph(c, drops[c], 0.55);
        // Occasional brighter head.
        if (Math.random() < 0.06) drawGlyph(c, drops[c] - 1, 0.85);
        drops[c] += 1;
        if (drops[c] * fontSize > h && Math.random() < 0.035) drops[c] = Math.floor((Math.random() * -h) / fontSize);
      }
    };

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    resize();
    if (reduced) {
      drawStatic();
    } else {
      ctx.font = `${fontSize}px ui-monospace, monospace`;
      raf = requestAnimationFrame(tick);
    }
    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [canvasRef]);

  return null;
}

export default function LoginView() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // {text, field}
  const [rainOn, setRainOn] = useState(false);
  const [wasExpired] = useState(sessionExpired);
  const inputRef = useRef(null);
  const rainRef = useRef(null);
  useMatrixRain(rainRef);

  // The rain fades in just after the card entrance (CSS: .login-rain.is-on,
  // opacity var(--rain-on) — quieter on the light theme). Theme is read once:
  // the login screen has no toggle of its own.
  useEffect(() => {
    const light = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "light"
      : matchMedia("(prefers-color-scheme: light)").matches;
    document.documentElement.style.setProperty("--rain-on", light ? "0.28" : "0.85");
    const timer = setTimeout(() => setRainOn(true), 80);
    return () => clearTimeout(timer);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithToken(value); // flips me → AppShell swaps to the shell
    } catch (err) {
      setError(loginError(err));
      setBusy(false);
      // Keep the value, put the caret back: fixing a paste is one gesture.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  return (
    <div class="login-screen">
      <canvas class={"login-rain" + (rainOn ? " is-on" : "")} ref={rainRef} aria-hidden="true" />
      <div class="login-core">
        {/* BUG-104: тот же знак, что в меню и приветствии (FEAT-09.20, BRIEF-11):
            терракотовая «искра» + «zai» антиквой; синий — цвет выбора, не бренда. */}
        <div class="login-mark" aria-hidden="true">
          <ZaiMark size={44} />
          <span class="login-word">Teleharness</span>
        </div>
        <h1 class="login-title">{t("login.title")}</h1>
        <p class="login-hint">{t("login.hint")}</p>
        {wasExpired && !error && (
          <p class="login-note" role="status">{t("login.expired")}</p>
        )}
        <form class="login-form" onSubmit={submit}>
          <input
            ref={inputRef}
            class={"login-input" + (error?.field ? " is-invalid" : "")}
            type="password" inputMode="text" autocomplete="off" enterkeyhint="go"
            autocapitalize="off" autocorrect="off" spellcheck={false}
            placeholder={t("login.token")} aria-label={t("login.token")}
            aria-invalid={error?.field ? "true" : undefined}
            aria-describedby={error ? "login-error" : undefined}
            readOnly={busy}
            value={token}
            onInput={(e) => {
              setToken(e.currentTarget.value);
              if (error) setError(null);
            }}
          />
          {error && <div class="login-error" id="login-error" role="alert">{error.text}</div>}
          <button class={"login-btn" + (busy ? " is-busy" : "")} type="submit" disabled={busy || !token.trim()} aria-busy={busy ? "true" : undefined}>
            {busy && <span class="btn-spin" aria-hidden="true" />}
            {busy ? t("login.checking") : t("login.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
