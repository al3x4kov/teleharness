// Markdown: marked -> DOMPurify -> optional highlight.js (subset).
// Two renderer pipelines: MD_FULL highlights code on the completed pass,
// MD_FAST escapes only while streaming. Updates are coalesced to one
// render per animation frame while streaming.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import { SANITIZE_CONFIG } from "../../lib/sanitize-config.js";
import { copyText } from "../../lib/clipboard.js";
import { lang, t } from "../../lib/i18n.js";

for (const [name, def] of Object.entries({ javascript, typescript, python, bash, json, css, xml, markdown })) {
  hljs.registerLanguage(name, def);
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function makeParser(highlight) {
  return new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      code({ text, lang }) {
        const base = String(lang ?? "").trim().split(/\s+/)[0].toLowerCase();
        const language = hljs.getLanguage(base) ? base : "";
        const body =
          highlight && language
            ? hljs.highlight(text ?? "", { language, ignoreIllegals: true }).value
            : esc(text);
        const label = esc(base || "code");
        // Visible label + icon, 32px tall with a 44px hit zone (R-17). The
        // icon is a CSS mask (.md-copy::before): the sanitizer strips svg.
        return (
          `<div class="md-code"><div class="md-code-head"><span>${label}</span>` +
          `<button type="button" class="md-copy" data-raw="${encodeURIComponent(text ?? "")}">` +
          `<span class="md-copy-label">${esc(t("common.copy"))}</span></button>` +
          `</div><pre><code class="hljs">${body}</code></pre></div>`
        );
      },
      link({ href, title, tokens }) {
        const t = title ? ` title="${esc(title)}"` : "";
        return `<a href="${esc(href)}"${t} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
}

const MD_FULL = makeParser(true);
const MD_FAST = makeParser(false);

function render(text, streaming) {
  let html;
  try {
    html = (streaming ? MD_FAST : MD_FULL).parse(text ?? "");
  } catch {
    html = `<p>${esc(text)}</p>`;
  }
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

// Relative src/href rewrite (FV-19, FileViewer only): DOMPurify output keeps
// attributes double-quoted, so a targeted attribute pass is enough.
const UNESC = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
function rewriteUrls(html, resolveUrl) {
  return html.replace(/\s(src|href)="([^"]*)"/g, (m, attr, val) => {
    const raw = val.replace(/&(amp|lt|gt|quot|#39);/g, (e) => UNESC[e] ?? e);
    const next = resolveUrl(raw);
    return next ? ` ${attr}="${esc(next)}"` : m;
  });
}

function onCopyClick(e) {
  const btn = e.target?.closest?.(".md-copy");
  if (!btn) return;
  const raw = decodeURIComponent(btn.dataset.raw ?? "");
  const label = btn.querySelector(".md-copy-label");
  copyText(raw).then((ok) => {
    if (!label) return;
    label.textContent = ok ? t("common.copied") : t("markdown.copyFailed");
    btn.classList.toggle("is-done", ok);
    setTimeout(() => {
      if (!btn.isConnected) return;
      label.textContent = t("common.copy");
      btn.classList.remove("is-done");
    }, 1400);
  });
}

export default function Markdown({ text = "", streaming = false, caret = false, resolveUrl }) {
  const [shown, setShown] = useState(text);
  const raf = useRef(0);

  useEffect(() => {
    if (!streaming) {
      setShown(text); // completed pass: full render with highlighting
      return;
    }
    if (text === shown) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setShown(text));
    return () => cancelAnimationFrame(raf.current);
  }, [text, streaming]);

  const html = useMemo(
    () => {
      const base = render(shown, streaming);
      return (resolveUrl ? rewriteUrls(base, resolveUrl) : base) + (caret && streaming ? '<span class="md-caret"></span>' : "");
    },
    [shown, streaming, caret, resolveUrl, lang.value],
  );

  return <div class="md" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
