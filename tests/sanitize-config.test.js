// Unit & DOMPurify tests for src/lib/sanitize-config.js (BUG-302).
// Verifies both the frozen allowlist data and real DOMPurify sanitization
// against XSS, CSS overlays, forged controls, and arbitrary data-* attributes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import createDOMPurify from "dompurify";
import { SANITIZE_CONFIG } from "../src/lib/sanitize-config.js";

function makePurify() {
  const win = new Window();
  // happy-dom 21 overrides nodeName on Element.prototype while Node.prototype.nodeName
  // returns "". DOMPurify 3.4 reads Node.prototype.nodeName getter directly to defeat
  // DOM clobbering, so align happy-dom's Node.prototype.nodeName with the WHATWG DOM spec.
  const elGet = Object.getOwnPropertyDescriptor(win.Element.prototype, "nodeName")?.get;
  const origGet = Object.getOwnPropertyDescriptor(win.Node.prototype, "nodeName")?.get;
  if (elGet && origGet) {
    Object.defineProperty(win.Node.prototype, "nodeName", {
      configurable: true,
      enumerable: true,
      get() {
        if (this.nodeType === 1) return elGet.call(this);
        if (this.nodeType === 3) return "#text";
        if (this.nodeType === 8) return "#comment";
        if (this.nodeType === 9) return "#document";
        if (this.nodeType === 11) return "#document-fragment";
        return origGet.call(this);
      },
    });
  }
  return { win, DOMPurify: createDOMPurify(win) };
}

test("no dangerous tags are allowed: script/iframe/object/embed/button/input and friends absent", () => {
  for (const tag of [
    "script", "iframe", "object", "embed", "form", "base", "link", "meta",
    "svg", "math", "template", "style", "button", "input", "textarea", "select",
  ]) {
    assert.ok(!SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag), `<${tag}> must not be allowed`);
  }
});

test("no on* event-handler, style, or arbitrary data-* attributes are allowed", () => {
  for (const attr of SANITIZE_CONFIG.ALLOWED_ATTR) {
    assert.ok(!attr.toLowerCase().startsWith("on"), `attribute '${attr}' must not be allowed`);
  }
  for (const banned of ["onerror", "onclick", "onload", "onmouseover", "style"]) {
    assert.ok(!SANITIZE_CONFIG.ALLOWED_ATTR.includes(banned), `attribute '${banned}' must not be allowed`);
  }
  assert.equal(SANITIZE_CONFIG.ALLOW_DATA_ATTR, false, "arbitrary data-* attributes must be disabled");
});

test("markdown pipeline output survives: core tags plus table/details/a11y attributes", () => {
  for (const tag of [
    "p", "br", "hr", "a", "img", "code", "pre", "em", "strong", "del",
    "blockquote", "ul", "ol", "li", "h1", "h6", "div", "span",
    "table", "thead", "tbody", "tr", "th", "td", "details", "summary",
  ]) {
    assert.ok(SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag), `<${tag}> must stay allowed`);
  }
  for (const attr of ["href", "src", "alt", "title", "class", "target", "rel", "align", "role", "aria-label"]) {
    assert.ok(SANITIZE_CONFIG.ALLOWED_ATTR.includes(attr), `attribute '${attr}' must stay allowed`);
  }
});

test("allowlists are plain frozen data: no prototype keys, no mutation", () => {
  const protoKeys = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"];
  for (const list of [SANITIZE_CONFIG.ALLOWED_TAGS, SANITIZE_CONFIG.ALLOWED_ATTR]) {
    assert.ok(Array.isArray(list));
    for (const key of protoKeys) {
      assert.ok(!list.includes(key), `'${key}' must not appear`);
    }
    assert.ok(Object.isFrozen(list), "allowlists must be frozen against runtime tampering");
  }
  assert.ok(Object.isFrozen(SANITIZE_CONFIG));
  assert.deepEqual(Object.keys(SANITIZE_CONFIG).sort(), ["ALLOWED_ATTR", "ALLOWED_TAGS", "ALLOW_DATA_ATTR"]);
});

test("DOMPurify with SANITIZE_CONFIG strips XSS, CSS overlay, forged controls, and data-* payloads", () => {
  const { win, DOMPurify } = makePurify();
  try {
    assert.equal(DOMPurify.sanitize("<script>alert(1)</script>", SANITIZE_CONFIG), "", "script stripped");
    assert.equal(
      DOMPurify.sanitize('<img src="x" onerror="alert(2)">', SANITIZE_CONFIG),
      '<img src="x">',
      "onerror stripped",
    );
    assert.equal(
      DOMPurify.sanitize('<div style="position:fixed;inset:0;z-index:999999">overlay</div>', SANITIZE_CONFIG),
      "<div>overlay</div>",
      "inline style stripped (CSS overlay blocked)",
    );
    assert.equal(
      DOMPurify.sanitize('<button class="md-copy" data-raw="pwned">Fake</button>', SANITIZE_CONFIG),
      "Fake",
      "forged <button> stripped",
    );
    assert.equal(
      DOMPurify.sanitize('<input type="password" placeholder="PIN">', SANITIZE_CONFIG),
      "",
      "forged <input> stripped",
    );
    assert.equal(
      DOMPurify.sanitize('<a href="javascript:alert(3)">click</a>', SANITIZE_CONFIG),
      "<a>click</a>",
      "javascript: URI stripped",
    );
    assert.equal(
      DOMPurify.sanitize('<p data-secret="1" class="ok">hello</p>', SANITIZE_CONFIG),
      '<p class="ok">hello</p>',
      "data-* attributes stripped while safe class preserved",
    );
    assert.equal(
      DOMPurify.sanitize(
        '<table><thead><tr><th align="right">N</th></tr></thead><tbody><tr><td align="right">42</td></tr></tbody></table>',
        SANITIZE_CONFIG,
      ),
      '<table><thead><tr><th align="right">N</th></tr></thead><tbody><tr><td align="right">42</td></tr></tbody></table>',
      "safe table align preserved",
    );
  } finally {
    win.close();
  }
});

