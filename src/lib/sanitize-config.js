// DOMPurify config for the chat markdown pipeline (Markdown.jsx).
// Pure data — no DOM imports — so plain `node --test` can verify it.
// The lists pin everything marked (gfm + breaks) plus the custom renderer
// can emit: md-code chrome (div/span/button[data-raw]), GFM tables (th/td
// alignment carries style), task lists (input[checked][disabled]), links
// (a[target][rel]). Setting ALLOWED_* fully replaces DOMPurify's defaults,
// so script/iframe/on* and other non-markdown tags never survive.
export const SANITIZE_CONFIG = Object.freeze({
  ALLOWED_TAGS: Object.freeze([
    "a", "abbr", "b", "blockquote", "br", "button", "code", "del", "details",
    "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input",
    "kbd", "li", "mark", "ol", "p", "pre", "s", "span", "strike", "strong",
    "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
  ]),
  ALLOWED_ATTR: Object.freeze([
    "alt", "checked", "class", "disabled", "href", "id", "rel", "src",
    "style", "target", "title", "type",
  ]),
  // the code-copy button carries its raw payload in data-raw
  ALLOW_DATA_ATTR: true,
});
