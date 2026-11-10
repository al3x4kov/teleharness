// Attachment chip. Message file parts: bare 64px image thumb (data: URIs)
// or doc chip with filename + type badge («xlsx», «pdf» — FV-17/R-06).
// Composer chips add a remove button and use object URLs for image previews;
// an in-flight upload shows a progress bar (progress 0..1, null = unknown →
// pulse), a failed one stays visibly marked instead of vanishing (R-26).
// Message context passes onOpen — the chip (or image) becomes a button that
// opens the FileViewer overlay.
import { useState } from "preact/hooks";
import { fileBadge } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";

const DOC_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

export default function Attachment({
  mime, filename, url, preview, onRemove, onOpen, className = "",
  status = null, // null | "uploading" | "processing" | "failed"
  progress = null,
}) {
  const src = preview ?? url ?? "";
  // BUG-161: a picture referenced by name (Claude chats keep uploads as
  // reference texts) is shown through the portal file API; a missing file
  // falls back to the doc chip instead of a broken image.
  const [broken, setBroken] = useState(false);
  const isImage = !broken && (mime ?? "").startsWith("image/") && /^(data:|blob:|\/zai\/api\/file\?)/.test(src);
  const tappable = !onRemove && typeof onOpen === "function";
  const extra = (className ? ` ${className}` : "") + (status === "failed" ? " is-failed" : status && progress == null ? " is-uploading" : status ? " is-progress" : "");
  const badge = fileBadge(filename);

  if (isImage && !onRemove) {
    const img = <img class="attach-img" src={src} alt={filename} loading="lazy" onError={() => setBroken(true)} />;
    if (tappable) {
      return (
        <button class={"attach-img-btn" + extra} type="button" onClick={onOpen} aria-label={t("attach.open", { name: filename ?? t("attach.image") })}>
          {img}
        </button>
      );
    }
    return img;
  }

  const stateText =
    status === "uploading"
      ? progress != null ? t("attach.uploadingPct", { pct: Math.round(progress * 100) }) : t("attach.uploading")
      : status === "processing" ? t("attach.processing")
        : status === "failed" ? t("attach.failed") : null;

  const body = (
    <>
      {isImage ? <img class="attach-thumb" src={src} alt="" /> : <span class="attach-icon">{DOC_ICON}</span>}
      <span class="attach-text">
        <span class="attach-name" title={filename}>{filename}</span>
        {stateText && <span class="attach-state" role={status === "failed" ? "alert" : undefined}>{stateText}</span>}
      </span>
      {badge && !stateText && <span class="file-kind">{badge}</span>}
      {onRemove && (
        <button class="attach-x" type="button" onClick={onRemove}
          aria-label={t(status === "uploading" ? "attach.cancelUpload" : "attach.remove", { name: filename })}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 6l12 12" />
            <path d="M18 6L6 18" />
          </svg>
        </button>
      )}
      {status === "uploading" && progress != null && (
        <span class="attach-prog" style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} aria-hidden="true" />
      )}
    </>
  );

  if (tappable) {
    return (
      <button class={"attach is-link" + extra} type="button" onClick={onOpen} title={filename}
        aria-label={t("attach.open", { name: filename ?? t("message.file") }) + (badge ? `, ${badge}` : "")}>
        {body}
      </button>
    );
  }
  return <span class={"attach" + extra}>{body}</span>;
}
