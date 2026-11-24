// DOMPurify config for the chat markdown pipeline (Markdown.jsx).
// Pure data — no DOM imports — so plain `node --test` can verify it.
// BUG-302: disallow `style` (prevents CSS overlay/phishing), `button`/`input`
// (prevents forged UI controls; Markdown.jsx injects `.md-copy` post-sanitize
// and renders GFM checkboxes as non-interactive spans), and arbitrary `data-*`.
// Setting ALLOWED_* fully replaces DOMPurify's defaults, so script/iframe/on*
// and other non-markdown tags never survive.
export const SANITIZE_CONFIG = Object.freeze({
  ALLOWED_TAGS: Object.freeze([
    "a", "abbr", "b", "blockquote", "br", "code", "del", "details",
    "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
    "kbd", "li", "mark", "ol", "p", "pre", "s", "span", "strike", "strong",
    "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
  ]),
  ALLOWED_ATTR: Object.freeze([
    "align", "alt", "aria-label", "class", "href", "id", "rel", "role", "src",
    "target", "title",
  ]),
  ALLOW_DATA_ATTR: false,
});
