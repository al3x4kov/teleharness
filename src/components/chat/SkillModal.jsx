// Modal dialog displaying a skill's title, description, optional filesystem
// path (admin only), and rendered SKILL.md body.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { api } from "../../lib/api.js";
import { useModalFocus } from "../Pickers.jsx";
import { t } from "../../lib/i18n.js";
import Markdown from "./Markdown.jsx";

const FRONTMATTER_RE = /^---\r?\n[^\s:-][^\r\n:]*:[^\r\n]*\r?\n(?:(?:[ \t]*[^\s:-][^\r\n:]*:[^\r\n]*|[ \t]*- [^\r\n]*|[ \t]*)\r?\n)*---\r?\n?/;
export function stripSkillFrontmatter(text) {
  return String(text ?? "").replace(FRONTMATTER_RE, "");
}

function errorMessageFor(err) {
  if (err?.status === 403 || err?.body?.error === "skill_forbidden") return t("rightPanel.skillForbidden");
  if (err?.status === 404 || err?.body?.error === "skill_not_found") return t("rightPanel.skillNotFound");
  if (typeof err?.body?.error === "string" && err.body.error.trim()) return err.body.error.trim();
  return t("rightPanel.skillLoadError");
}

export default function SkillModal({ skill, directory, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef(null);
  const modalRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const skillId = skill?.id || skill?.name || "";

  useModalFocus(modalRef, { inertShell: true });

  useEffect(() => {
    closeRef.current?.focus?.();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!skillId) return;
    let cancelled = false;
    setDetail(null);
    setLoading(true);
    setError("");
    api.getSkill(skillId, directory).then(
      (data) => {
        if (cancelled) return;
        setDetail(data && typeof data === "object" ? data : null);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        setError(errorMessageFor(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [skillId, directory, attempt]);

  const title = detail?.name || skill?.name || skillId;
  const desc = detail?.description ?? skill?.description ?? "";
  const filePath = detail?.path || skill?.path || "";
  const bodyText = stripSkillFrontmatter(detail?.content ?? "").trim();

  return createPortal(
    <div
      class="rp-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current?.();
      }}
    >
      <div
        ref={modalRef}
        class="rp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rp-skill-modal-title"
        tabIndex={-1}
      >
        <header class="rp-modal-head">
          <div class="rp-modal-meta">
            <h2 id="rp-skill-modal-title" class="rp-modal-title">{title}</h2>
            {desc && <p class="rp-modal-desc">{desc}</p>}
            {filePath && <p class="rp-modal-path">{filePath}</p>}
          </div>
          <button
            ref={closeRef}
            class="rp-modal-close"
            type="button"
            aria-label={t("rightPanel.skillClose")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div class="rp-modal-body">
          {loading ? (
            <div class="rp-skeleton" role="status">
              <span class="rp-sr">{t("rightPanel.skillLoading")}</span>
              <span class="rp-sk-line" />
              <span class="rp-sk-line" />
              <span class="rp-sk-line" />
              <span class="rp-sk-line" />
            </div>
          ) : error ? (
            <div class="rp-error" role="status">
              <span class="rp-error-text">
                <span class="rp-error-x" aria-hidden="true">✕</span> {error}
              </span>
              <button class="rp-retry" type="button" onClick={() => setAttempt((a) => a + 1)}>
                {t("rightPanel.retry")}
              </button>
            </div>
          ) : bodyText ? (
            <div class="rp-modal-md md">
              <Markdown text={bodyText} />
            </div>
          ) : (
            <p class="rp-modal-empty">{desc || t("rightPanel.skillEmpty")}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
