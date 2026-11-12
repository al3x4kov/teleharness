// File card in an assistant answer (FEAT-05.17, Claude-app look, BRIEF-12):
// a tinted «page» tile with the type icon on the left (a picture shows its own
// thumbnail there), the name WITHOUT its extension and «Тип · РАСШ» under it.
// The whole card is one button that opens the FileViewer.
// thumb: picture URL for the tile. A thumbnail that fails to load falls back
// to the icon (the viewer explains why on tap) — unless hideIfBroken: a
// relative name guessed from the answer text that does not exist is not a
// result at all, so the card disappears (BUG-05.13 / ISSUE-003).
import { useState } from "preact/hooks";
import { fileCardInfo } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";

const svg = (children) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const ICONS = {
  code: svg(<><path d="M9 7l-5 5 5 5" /><path d="M15 7l5 5-5 5" /></>),
  image: svg(<><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9.5" cy="9.5" r="1.6" /><path d="M20 15.5l-4.5-4.5L6 20" /></>),
  video: svg(<><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="M16 10.5l5-3v9l-5-3" /></>),
  audio: svg(<><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>),
  archive: svg(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 4v3M12 9v2M12 13v2" /></>),
  sheet: svg(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 10h16M4 15h16M10 4v16" /></>),
  file: svg(<><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z" /><path d="M14 3v5h5" /></>),
};
const iconFor = (kind) => ICONS[kind] ?? ICONS.file;

export default function FileCard({ name, thumb = null, onOpen, hideIfBroken = false, unavailable = false }) {
  const [broken, setBroken] = useState(false);
  if (broken && hideIfBroken) return null;
  const info = fileCardInfo(name);
  // FEAT-05.29: файл показан агентом, но этой учётной записи недоступен (или его нет) —
  // не кнопка и не голый путь: имя и причина словами.
  if (unavailable) {
    return (
      <div class="file-card is-unavailable" role="note" title={name}>
        <span class="fc-tile" aria-hidden="true">{iconFor(info.kind)}</span>
        <span class="fc-text">
          <span class="fc-name">{info.stem}</span>
          <span class="fc-sub">{t("fileCard.unavailable")}</span>
        </span>
      </div>
    );
  }
  const showThumb = !!thumb && !broken;
  return (
    <button class={"file-card is-" + info.kind} type="button" onClick={onOpen} title={name}
      aria-label={t("fileCard.openAria", { name, sub: info.sub.replace(" · ", " ") })}>
      <span class={"fc-tile" + (showThumb ? " has-thumb" : "")} aria-hidden="true">
        {showThumb ? (
          <img src={thumb} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : iconFor(info.kind)}
      </span>
      <span class="fc-text">
        <span class="fc-name">{info.stem}</span>
        <span class="fc-sub">{info.sub}</span>
      </span>
    </button>
  );
}
