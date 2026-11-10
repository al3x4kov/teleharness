// Composer: autosizing textarea (max 6 lines), Enter=send on desktop,
// attachments of ANY format (user rule 2026-10-31). Images downscale to
// 1568px and ride inline; every other file uploads binary to the session
// folder right away (fetch streams the File — no base64 in browser memory)
// and the message carries a path reference. Caps (user request 31.10):
// 100MB/file, 20 files, 500MB per batch. While the agent is busy, a typed
// message QUEUES upstream (opencode plays the queue after the current
// turn): the send action stays available, and only an EMPTY input shows
// the stop button. Voice (user request 31.10): hold the send button 350ms
// -> dictation (Web Speech API, ru-RU); release -> recognized text stays
// in the composer, slide up while holding -> cancel. Every exit (release,
// cancel, Escape, pointercancel, tab hide, permission denial) lands in
// finishVoice().
// FEAT-06.2: with an empty field and the server voice mode on (onVoiceMode
// given by ChatView), the button wears the «волна» face: a TAP opens the
// voice mode, a HOLD is still the dictation above (FEAT-06.1 unchanged).
import { useEffect, useRef, useState } from "preact/hooks";
import Attachment from "./Attachment.jsx";
import { active, activeSessionDir, cancelEdit, deleteUpload, editing, loadDraft, prefs, providerCfg, saveDraft, sessions, uploadFile } from "../../lib/store.js";
import { bindingOf, queuedSendLabel } from "../../lib/engine.js";
import { PencilIcon } from "./TurnActions.jsx";
import { createRecognizer, speechSupported } from "../../lib/voice.js";
import { t } from "../../lib/i18n.js";

const MAX_H = 154; // 6 lines + vertical padding, keep in sync with .composer-ta
const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_BYTES = 500 * 1024 * 1024;
const HOLD_MS = 350; // press-and-hold threshold before voice mode arms
const CANCEL_SHIFT_PX = 70; // slide up this far while holding -> cancel

const SVG = (props) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...props} />
);

// MIC_SVG pre-builds a vnode at module load, so SVG must be initialized
// BEFORE this line: esbuild flattens const to hoisted var, and a later
// definition evaluates as undefined here -> vnode with type=undefined,
// which preact renders as the literal text "[object Object]".
const MIC_SVG = (
  <SVG>
    <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
    <path d="M12 18v4" />
  </SVG>
);

const WAVE_SVG = (
  <SVG stroke-width="2">
    <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
  </SVG>
);

let keySeq = 0;
const nextKey = () => `f${Date.now().toString(36)}-${(keySeq += 1)}`;

// Upload through the store facade (XHR in the browser): onProgress feeds the
// chip's bar, and removing an in-flight chip aborts the real request (R-26).
// `cancelled` also covers a transport that ignores the signal.
function uploadWithProgress(file, directory, { onProgress, register } = {}) {
  let cancelled = false;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  register?.(() => {
    cancelled = true;
    ctl?.abort();
  });
  return uploadFile(file, directory, { onProgress, signal: ctl?.signal }).then((r) => {
    if (cancelled) throw Object.assign(new Error("aborted"), { aborted: true });
    return r;
  });
}

// Server limits (BUG-12.10) → a reason the user can act on.
function uploadErrorText(err) {
  if (err?.status === 413) {
    return err?.body?.error === "upload quota exceeded"
      ? t("composer.upload.quota")
      : t("composer.upload.tooLarge");
  }
  if (err?.status === 429) return t("composer.upload.rateLimited");
  if (err?.status === 403) return t("composer.upload.forbidden");
  return t("composer.upload.failed");
}

const readAsDataURL = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });

const loadImage = (url) =>
  new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("image decode failed"));
    img.src = url;
  });

function hasAlpha(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const stride = Math.max(4, Math.floor((d.length / 4 / 4096)) * 4); // sample ~4k px
  for (let i = 3; i < d.length; i += stride) if (d[i] < 255) return true;
  return false;
}

async function processImage(file) {
  const original = await readAsDataURL(file);
  const img = await loadImage(original);
  const scale = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1) return { url: original, mime: file.type || "image/png" }; // small enough as-is
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const png = hasAlpha(ctx, w, h);
  return { url: canvas.toDataURL(png ? "image/png" : "image/jpeg", 0.85), mime: png ? "image/png" : "image/jpeg" };
}

// model: the open chat's bound model (vision guard); falls back to the
// Settings default for a chat nobody has bound yet.
// sessionId: the chat this composer belongs to — the unsent text is kept as
// a per-user, per-chat draft (ISSUE-015: it survives a reload).
export default function Composer({ status = "idle", onSend, onStop, onStopHidden = null, model = null, sessionId = null, onVoiceMode = null }) {
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [files, setFiles] = useState([]); // {mime, filename, url, preview?}
  const [error, setError] = useState("");
  const [voice, setVoice] = useState(null); // {phase: "listening"|"finishing", cancelling} | null
  const [partial, setPartial] = useState(""); // live interim transcript (display only)
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const filesRef = useRef(files);
  const errTimer = useRef(0);
  const voiceOk = speechSupported(); // false on insecure origins: plain typing as before
  const voiceRef = useRef(voice);
  const recRef = useRef(null);
  const textAtVoiceStart = useRef("");
  const holdTimer = useRef(0);
  const holdOriginY = useRef(0);
  const finTimer = useRef(0);
  const justVoice = useRef(false); // swallow the click that follows a voice release
  const aborters = useRef({}); // chip key -> abort() of its in-flight upload
  filesRef.current = files;
  voiceRef.current = voice;
  // FEAT-01.57: «Изменить» — the last question in the field, the draft
  // typed before it comes back on «Отмена».
  const ed = editing.value?.sid === sessionId ? editing.value : null;
  const draftBeforeEdit = useRef(null);
  useEffect(() => {
    if (!ed) return;
    if (draftBeforeEdit.current == null) draftBeforeEdit.current = text;
    setText(ed.text ?? "");
    taRef.current?.focus();
  }, [ed?.messageID]);
  function onCancelEdit() {
    cancelEdit();
    setText(draftBeforeEdit.current ?? "");
    draftBeforeEdit.current = null;
  }

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_H) + "px";
  }, [text]);

  // The clear after a submit must not wipe a draft the store re-parks when
  // that send fails (sendParts saves it) — submit() clears it itself.
  const skipDraftSave = useRef(false);
  useEffect(() => {
    if (skipDraftSave.current) {
      skipDraftSave.current = false;
      return;
    }
    if (ed) return; // the edited question is not a draft
    saveDraft(sessionId, text);
  }, [text, sessionId]);

  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  const busy = status === "busy" || status === "stopping";
  const stopping = status === "stopping";
  // An image still being downscaled counts as uploading: it must not miss the
  // message it was attached to (BUG-01.37 п.4).
  const uploading = files.some((f) => f.uploading || f.processing);
  const sendable = files.filter((f) => !f.failed);
  // Досылка в очередь: при busy НАБРАННОЕ сообщение уходит в очередь апстрима
  // (opencode 1.19.5 играет её после текущего хода) — блокирует только
  // stopping (ход abort'ится) и незавершённая загрузка. Пустой ввод при busy —
  // лицо кнопки остаётся «Стоп» (остановить текущий ход).
  const canSend = !stopping && !uploading && (text.trim().length > 0 || sendable.length > 0 || (ed?.parts?.length ?? 0) > 0);
  // FEAT-01.69: the chat header has no «Стоп» of its own any more — it
  // shows one only while this composer's stop gives way to «Отправить».
  const stopHidden = busy && canSend;
  useEffect(() => {
    onStopHidden?.(stopHidden);
  }, [stopHidden]);
  useEffect(() => () => onStopHidden?.(false), []);

  // Vision guard: warn while an image chip is attached and the effective model
  // is catalogued WITHOUT image input (imageInput===false). Catalog vs reality:
  // some providers over-report vision (glm-5.3-flash says image:true but fails
  // on real requests, 2026-11-01) — this hint covers the honest «слепые»
  // models and never blocks sending.
  const chosen = model ?? prefs.value.model;
  const chosenModel = chosen?.modelID
    ? (providerCfg.value?.models ?? []).find((m) => m.providerID === chosen.providerID && m.id === chosen.modelID)
    : null;
  const visionWarn =
    files.some((f) => (f.mime ?? "").startsWith("image/")) && chosenModel?.imageInput === false;
  // Empty composer + capable browser: the send glyph becomes a mic — hold it
  // to talk (WhatsApp grammar). Once there is text, the arrow returns.
  const micMode = voiceOk && !busy && !canSend;
  // FEAT-06.2: empty field → «Голосовой режим» (tap); hold = dictation.
  const waveMode = typeof onVoiceMode === "function" && !busy && !canSend && !ed;

  // ---- voice mode (hold the send button) ----

  function voiceError(msg) {
    showError(msg);
    setVoice(null);
    setPartial("");
  }

  function voiceEnd() {
    clearTimeout(finTimer.current);
    recRef.current = null;
    setVoice(null);
    setPartial("");
  }

  function voicePartial(committed, interim) {
    const a = textAtVoiceStart.current;
    setText(a && committed ? `${a} ${committed}` : a || committed);
    setPartial(interim);
  }

  function startVoice() {
    const rec = createRecognizer({
      onPartial: voicePartial,
      onError: voiceError,
      onEnd: voiceEnd,
    });
    if (!rec) return; // raced an unsupported engine — nothing to do
    recRef.current = rec;
    textAtVoiceStart.current = text;
    setPartial("");
    setVoice({ phase: "listening", cancelling: false });
    rec.start();
  }

  // The single exit door: commit=true keeps the recognized text (already in
  // state), commit=false rolls back to the pre-voice text. release = commit,
  // slide-up / Escape / pointercancel / tab-hide = cancel.
  function finishVoice(commit) {
    const rec = recRef.current;
    if (!rec) {
      setVoice(null);
      setPartial("");
      return;
    }
    if (!commit) {
      setText(textAtVoiceStart.current);
      setPartial("");
      setVoice(null);
      rec.abort();
      return;
    }
    rec.stop(); // finals already landed via onPartial
    setVoice({ phase: "finishing", cancelling: false });
    setPartial("");
    // Safety net: if onend never fires (old WebKit quirk), clear anyway.
    clearTimeout(finTimer.current);
    finTimer.current = setTimeout(voiceEnd, 1200);
  }

  function onSendDown(e) {
    if (busy || !voiceOk) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    holdOriginY.current = e.clientY;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = 0;
      startVoice();
      try {
        navigator.vibrate?.(15);
      } catch {}
    }, HOLD_MS);
  }

  function onSendMove(e) {
    if (!voiceRef.current || voiceRef.current.phase !== "listening") return;
    const cancelling = e.clientY < holdOriginY.current - CANCEL_SHIFT_PX;
    setVoice((v) => (v && v.cancelling !== cancelling ? { ...v, cancelling } : v));
  }

  function onSendUp() {
    if (holdTimer.current) {
      // released before the hold threshold: a plain tap — let onClick submit
      clearTimeout(holdTimer.current);
      holdTimer.current = 0;
      return;
    }
    if (voiceRef.current) {
      justVoice.current = true;
      setTimeout(() => {
        justVoice.current = false;
      }, 400);
      finishVoice(!voiceRef.current.cancelling);
    }
  }

  function onSendCancel() {
    clearTimeout(holdTimer.current);
    holdTimer.current = 0;
    if (voiceRef.current) finishVoice(false);
  }

  function onSendClick() {
    if (justVoice.current || voiceRef.current) return;
    if (waveMode) {
      onVoiceMode(); // synchronous: the audio unlock must run inside this tap (iOS)
      return;
    }
    submit();
  }

  // Escape cancels dictation; hiding the tab (iOS swipe-away, lock) aborts
  // the engine safely — half-recognized text is dropped, not half-sent.
  useEffect(() => {
    if (!voice) return;
    const onKey = (e) => {
      if (e.key === "Escape") finishVoice(false);
    };
    addEventListener("keydown", onKey);
    const onVis = () => {
      if (document.hidden && voiceRef.current) finishVoice(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [voice !== null]); // re-arm only when the mode toggles

  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(finTimer.current);
      recRef.current?.abort();
    },
    [],
  );

  function showError(msg) {
    setError(msg);
    clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setError(""), 6000); // batch errors need reading time
  }

  function clearFiles(list) {
    list.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    setFiles([]);
  }

  function submit() {
    if (!canSend) return;
    // Failed chips are not sent (they are marked and explained); everything
    // else goes as before.
    if (!ed) saveDraft(sessionId, "");
    skipDraftSave.current = text !== "";
    const sent = onSend(
      text.trim(),
      sendable.map(({ mime, filename, url, ref }) => (ref ? { ref, filename } : { mime, filename, url })),
    );
    if (ed) {
      // FEAT-01.57: the edited text stays in the field until the server took
      // the revert; then the draft typed before «Изменить» comes back.
      clearFiles(files);
      Promise.resolve(sent).then((ok) => {
        if (ok === false && editing.peek()) return;
        setText(draftBeforeEdit.current ?? "");
        draftBeforeEdit.current = null;
      });
      return;
    }
    setText("");
    clearFiles(files);
  }

  function onKeyDown(e) {
    const desktop = typeof matchMedia === "function" && !matchMedia("(pointer: coarse)").matches;
    if (
      e.key === "Enter" && desktop && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
      // Preact hands the native event directly (no React `nativeEvent` wrapper).
      !e.isComposing
    ) {
      e.preventDefault();
      submit();
    }
  }

  // The active session's folder (store.activeSessionDir reads the id stamped
  // by ChatView): uploads land in <directory>/.zai-uploads so the agent can
  // read them with tools. Each chip carries a stable key: progress updates and
  // the outcome patch THAT chip (R-26 — a failed upload stays visibly marked,
  // × on an in-flight chip aborts it).
  const patchFile = (key, patch) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  async function uploadOne(file) {
    const key = nextKey();
    const temp = { key, filename: file.name, bytes: file.size, uploading: true, progress: null, mime: file.type || "application/octet-stream" };
    setFiles((prev) => [...prev, temp]);
    const dir = activeSessionDir() ?? "";
    try {
      const { name } = await uploadWithProgress(file, dir, {
        onProgress: (p) => patchFile(key, { progress: p }),
        register: (abort) => (aborters.current[key] = abort),
      });
      const ref =
        `[Пользователь приложил файл: .zai-uploads/${name} ` +
        `(${file.size} байт, ${file.type || "тип неизвестен"}). ` +
        `Файл лежит в папке сессии и доступен инструментам — прочитай его с диска, если нужен контент.]`;
      patchFile(key, { uploading: false, progress: null, ref, storedName: name, dir });
    } catch (err) {
      if (err?.aborted) return; // removed by the user — chip is already gone
      patchFile(key, { uploading: false, progress: null, failed: true });
      showError(`${file.name}: ${uploadErrorText(err)}`);
    } finally {
      delete aborters.current[key];
    }
  }

  async function onFiles(e) {
    const picked = [...e.currentTarget.files];
    e.currentTarget.value = "";
    if (picked.length === 0) return;
    const errs = [];
    const room = MAX_FILES - files.length;
    const batch = picked.slice(0, Math.max(0, room));
    if (picked.length > room) errs.push(t("composer.files.max", { count: MAX_FILES }));
    let bytesSoFar = files.reduce((n, f) => n + (f.bytes ?? 0), 0);

    for (const file of batch) {
      if (file.size > MAX_FILE_BYTES) {
        errs.push(`${file.name}: ${t("composer.files.over100")}`);
        continue;
      }
      if (bytesSoFar + file.size > MAX_BATCH_BYTES) {
        errs.push(`${file.name}: ${t("composer.files.batchLimit")}`);
        continue;
      }
      bytesSoFar += file.size;
      if ((file.type ?? "").startsWith("image/")) {
        const key = nextKey();
        let preview = null;
        try {
          preview = URL.createObjectURL(file);
        } catch {
          preview = null; // not a real Blob — the decode below fails and uploads it
        }
        setFiles((prev) => [...prev, { key, mime: file.type, filename: file.name, bytes: file.size, preview, processing: true }]);
        try {
          const { url, mime } = await processImage(file);
          patchFile(key, { mime, url, processing: false });
        } catch {
          if (preview) URL.revokeObjectURL(preview);
          setFiles((prev) => prev.filter((f) => f.key !== key));
          await uploadOne(file); // undecodable "image": upload as binary
        }
        continue;
      }
      await uploadOne(file); // sequential: gentle on the phone and the server
    }
    if (errs.length > 0) showError(errs.join(" · "));
  }

  function removeFile(key) {
    aborters.current[key]?.(); // cancel an in-flight upload
    // ISSUE-009: an already uploaded file goes too — no orphans in .zai-uploads.
    const done = files.find((x) => x.key === key);
    if (done?.storedName) deleteUpload(done.dir, done.storedName);
    setFiles((prev) => {
      const f = prev.find((x) => x.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter((x) => x.key !== key);
    });
  }

  return (
    <>
      {voice && (
        <div class={"voice-hint" + (voice.cancelling ? " is-cancel" : "")} role="status" aria-live="polite">
          <span class="voice-dot" aria-hidden="true" />
          {voice.cancelling ? t("composer.voice.cancelling") : t("composer.voice.hint")}
        </div>
      )}
      {ed && (
        <div class="edit-bar" role="status">
          <PencilIcon size={15} />
          <span class="edit-bar-text">{t("composer.edit.title")}</span>
          <button class="edit-bar-cancel" type="button" onClick={onCancelEdit}>{t("common.cancel")}</button>
        </div>
      )}
      <div class={"composer-pill" + (voice ? " is-voice" : "") + (ed ? " is-editing" : "")}>
        <button class="icon-btn" onClick={() => fileRef.current?.click()} aria-label={t("composer.attach")} disabled={status === "stopping"}>
          <SVG>
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </SVG>
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          onChange={onFiles}
        />
        <div class="composer-main">
          {files.length > 0 && (
            <div class="composer-chips">
              {files.map((f) => (
                <Attachment
                  key={f.key}
                  mime={f.mime}
                  filename={f.filename}
                  url={f.url}
                  preview={f.preview}
                  status={f.failed ? "failed" : f.uploading ? "uploading" : f.processing ? "processing" : null}
                  progress={f.uploading ? f.progress ?? null : null}
                  onRemove={() => removeFile(f.key)}
                />
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            class="composer-ta"
            rows="1"
            placeholder={t("composer.placeholder")}
            aria-label={t("composer.message")} enterkeyhint="send"
            value={partial ? (text ? `${text} ${partial}` : partial) : text}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {busy && !canSend ? (
          <button
            class="send-btn"
            onClick={onStop}
            disabled={stopping}
            aria-label={stopping ? t("chat.stopping") : t("chat.stop")}
          >
            {stopping ? (
              <span class="spin" aria-hidden="true" />
            ) : (
              <SVG><rect class="stop-square" x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" /></SVG>
            )}
          </button>
        ) : (
          <button
            class={"send-btn" + (voice ? " is-recording" : waveMode ? " is-wave" : "")}
            disabled={stopping}
            title={waveMode && !voice ? t("composer.voiceMode") : undefined}
            aria-label={
              voice
                ? t("composer.listening")
                : waveMode
                  ? voiceOk
                    ? t("composer.voiceModeHold")
                    : t("composer.voiceMode")
                  : micMode
                  ? t("composer.sendHold")
                  : ed
                    ? t("composer.sendEdited")
                    : busy
                    ? queuedSendLabel(bindingOf(sessions.value.find((s) => s.id === (active.value?.id ?? globalThis.__zaiActiveId)))?.engine)
                    : t("composer.send")
            }
            onPointerDown={onSendDown}
            onPointerMove={onSendMove}
            onPointerUp={onSendUp}
            onPointerCancel={onSendCancel}
            onClick={onSendClick}
          >
            {voice ? MIC_SVG : waveMode ? WAVE_SVG : micMode ? MIC_SVG : <SVG><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></SVG>}
          </button>
        )}
      </div>
      {busy && !stopping && canSend && !voice && (
        <div class="composer-hint" role="status">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {t("composer.queuedHint")}
        </div>
      )}
      {visionWarn && (
        <div class="composer-vision" role="status">
          {t("composer.visionWarn", { model: chosen?.modelID ?? "" })}
        </div>
      )}
      {error && <div class="composer-error" role="status">{error}</div>}
    </>
  );
}
