// FEAT-06.2 «Голосовой режим» — the full-screen conversation overlay
// (design/mockups-v2/voice-mode.html frames 2–6; frame 9: on ≥ 900 px it
// floats over the dimmed chat). The orb is concept B «Рой частиц»
// (lib/voice-orb.js). The state is always written under the orb (never
// colour only); controls are 56 px with captions. Esc = «Завершить»,
// Space = microphone on/off. role=dialog + the app's modal focus trap; the
// focus returns to the wave button on close. The screen stays on (Wake Lock)
// while the mode is open.
//
// createSession (tests inject a fake): ({sessionId, ctx, prefs, info,
// onChange}) → {snapshot, level, toggleMute, interrupt, stopTurn, retry,
// close, ttsMode, voiceId}.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { claudeAgents, prefs, providerCfg, sessions, voiceInfo, voicePrefs } from "../../lib/store.js";
import { bindingOf, modelName } from "../../lib/engine.js";
import { createVoiceSession } from "../../lib/voice-session.js";
import { createOrb, orbStateOf } from "../../lib/voice-orb.js";
import { holdWakeLock } from "../../lib/voice-audio.js";
import { STATE_LABEL } from "../../lib/voice-machine.js";
import { useModalFocus } from "../Pickers.jsx";
import { locale, t } from "../../lib/i18n.js";

const Ico = ({ children }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{children}</svg>
);
const MicI = () => <Ico><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></Ico>;
const MicOffI = () => <Ico><path d="M2 2l20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7M19 10a7 7 0 0 1-1.1 3.7M5 10a7 7 0 0 0 11.3 5.5M12 17v5" /></Ico>;
const StopI = () => <Ico><rect x="7" y="7" width="10" height="10" rx="1.5" /></Ico>;
const XI = () => <Ico><path d="M18 6 6 18M6 6l12 12" /></Ico>;
const CcI = () => <Ico><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3" /></Ico>;
const RetryI = () => <Ico><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Ico>;

const IDLE = { state: "listening", phase: "listening", muted: false, heard: "", subtitle: "", action: null, error: null };

const isControl = (el) => {
  const tag = el?.tagName;
  return tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "A" || el?.isContentEditable;
};

const actionText = (label) => {
  const s = String(label ?? "").trim();
  if (!s) return "";
  return `${s[0].toLocaleUpperCase(locale())}${s.slice(1)}${s.endsWith("…") ? "" : "…"}`;
};

export function voiceName(id, info = voiceInfo.value) {
  const hit = (info?.voices ?? []).find((v) => v?.id === id);
  if (hit?.name) return hit.name;
  return id ? id[0].toUpperCase() + id.slice(1) : "";
}

function Ctl({ label, caption, onClick, cls = "", pressed, children }) {
  return (
    <button type="button" class={"vm-ctl" + (cls ? ` ${cls}` : "")} aria-label={label} aria-pressed={pressed == null ? undefined : String(pressed)} onClick={onClick}>
      {children}
      <small aria-hidden="true">{caption}</small>
    </button>
  );
}

export default function VoiceModeView({ sessionId, ctx = null, onClose, createSession = createVoiceSession }) {
  const [snap, setSnap] = useState(IDLE);
  const [captions, setCaptions] = useState(true);
  const ctlRef = useRef(null);
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const orbRef = useRef(null);
  const closedRef = useRef(false);
  useModalFocus(boxRef, { inertShell: true });

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    ctlRef.current?.close();
    onClose?.();
  };
  const toggleMute = () => ctlRef.current?.toggleMute();

  useEffect(() => {
    const ctl = createSession({ sessionId, ctx, prefs: voicePrefs(prefs.peek()), info: voiceInfo.peek(), onChange: (s) => setSnap(s) });
    ctlRef.current = ctl;
    setSnap(ctl.snapshot());
    const release = holdWakeLock();
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    boxRef.current?.focus();
    return () => {
      ctl.close();
      release();
      body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    let reduced = false;
    try {
      reduced = Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {}
    const orb = createOrb(cv, { getLevel: (st) => ctlRef.current?.level?.(st) ?? null, reduced });
    orbRef.current = orb;
    orb.start();
    return () => orb.destroy();
  }, []);

  useEffect(() => {
    orbRef.current?.setState(orbStateOf(snap.state));
  }, [snap.state]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if ((e.key === " " || e.code === "Space") && !isControl(e.target) && !e.repeat) {
        e.preventDefault();
        toggleMute();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Top pills: the chat's own model (+ agent for opencode) and the voice.
  const session = sessions.value.find((s) => s.id === sessionId);
  const binding = bindingOf(session);
  const model = binding
    ? binding.engine === "claude"
      ? modelName(providerCfg.value, binding.model)
      : [modelName(providerCfg.value, binding.model), binding.agent].filter(Boolean).join(" · ")
    : "";
  void claudeAgents.value; // re-render when the agent catalog arrives
  const ctl = ctlRef.current;
  const voiceLabel = ctl && ctl.ttsMode !== "server" ? t("voice.mode.systemVoice") : voiceName(ctl?.voiceId ?? voicePrefs(prefs.value).voice ?? voiceInfo.value?.defaultVoice ?? "irina");

  const st = snap.state;
  const err = st === "error" ? snap.error : null;
  const label = err ? err.title : STATE_LABEL[st] ?? "";
  let sub = null;
  if (err) sub = err.text;
  else if (st === "muted") sub = t("voice.mode.mutedHint");
  else if (captions) {
    if (st === "listening") sub = snap.heard ? snap.heard : <i>{t("voice.mode.speakHint")}</i>;
    else if (st === "speaking") sub = snap.subtitle;
    else if (st === "thinking" || st === "sending")
      sub = (
        <>
          {snap.heard ? t("voice.mode.heard", { text: snap.heard }) : ""}
          {snap.action && (
            <>
              {snap.heard ? <br /> : null}
              <i>{actionText(snap.action)}</i>
            </>
          )}
        </>
      );
  }

  const muted = snap.muted;
  return createPortal(
    <div class="vm-backdrop">
      <div class={`vm is-${st}`} role="dialog" aria-modal="true" aria-label={t("voice.mode.title")} tabIndex={-1} ref={boxRef}>
        <div class="vm-top">
          <span class="vm-pill">{model || t("common.chat")}</span>
          {!err && (
            <span class="vm-pill">
              {t("voice.mode.voice", { name: voiceLabel })}
              <span class="vm-wide-only">{t("voice.mode.escHint")}</span>
            </span>
          )}
        </div>
        <div class="vm-stage">
          <div class="vm-orb-wrap" onClick={st === "speaking" ? () => ctlRef.current?.interrupt() : undefined}>
            <canvas class="vm-orb" ref={canvasRef} aria-hidden="true" />
          </div>
          <div class="vm-state" role="status" aria-live="polite">{label}</div>
          <div class="vm-sub">{sub}</div>
        </div>
        <div class="vm-ctls">
          {err ? (
            <>
              <Ctl label={t("voice.mode.retry")} caption={t("voice.mode.retry")} onClick={() => ctlRef.current?.retry()}>
                {err.retry === "mic" ? <MicI /> : <RetryI />}
              </Ctl>
              <Ctl label={t("voice.mode.end")} caption={t("voice.mode.endCaption")} cls="is-end" onClick={close}><XI /></Ctl>
            </>
          ) : (
            <>
              <Ctl
                label={muted ? t("voice.mode.unmute") : t("voice.mode.mute")}
                caption={muted ? t("voice.mode.unmuteCaption") : t("voice.mode.muteCaption")}
                cls={muted ? "is-on" : ""}
                pressed={muted}
                onClick={toggleMute}
              >
                {muted ? <MicOffI /> : <MicI />}
              </Ctl>
              {st === "speaking" ? (
                <Ctl label={t("voice.mode.interrupt")} caption={t("voice.mode.interrupt")} onClick={() => ctlRef.current?.interrupt()}><StopI /></Ctl>
              ) : st === "thinking" || st === "sending" ? (
                <Ctl label={t("voice.mode.stop")} caption={t("voice.mode.stopCaption")} onClick={() => ctlRef.current?.stopTurn()}><StopI /></Ctl>
              ) : (
                <Ctl label={t("voice.mode.captions")} caption={t("voice.mode.captionsCaption")} pressed={captions} onClick={() => setCaptions((c) => !c)}><CcI /></Ctl>
              )}
              <Ctl label={t("voice.mode.end")} caption={t("voice.mode.endCaption")} cls="is-end" onClick={close}><XI /></Ctl>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
