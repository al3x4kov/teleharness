// Unit tests for src/lib/sanitize-config.js — the DOMPurify allowlist the
// chat markdown pipeline runs against (architecture review §9.4(13)).
// Pure data assertions, no DOM needed. Run: node --test tests/sanitize-config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SANITIZE_CONFIG } from "../src/lib/sanitize-config.js";

test("no dangerous tags are allowed: script/iframe/object/embed and friends absent", () => {
  for (const tag of ["script", "iframe", "object", "embed", "form", "base", "link", "meta", "svg", "math", "template"]) {
    assert.ok(!SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag), `<${tag}> must not be allowed`);
  }
});

test("no on* event-handler attributes are allowed", () => {
  for (const attr of SANITIZE_CONFIG.ALLOWED_ATTR) {
    assert.ok(!attr.toLowerCase().startsWith("on"), `attribute '${attr}' must not be allowed`);
  }
  for (const banned of ["onerror", "onclick", "onload", "onmouseover"]) {
    assert.ok(!SANITIZE_CONFIG.ALLOWED_ATTR.includes(banned));
  }
});

test("markdown pipeline output survives: core tags plus renderer/GFM chrome", () => {
  // core markdown
  for (const tag of ["p", "br", "hr", "a", "img", "code", "pre", "em", "strong", "del", "blockquote", "ul", "ol", "li", "h1", "h6"]) {
    assert.ok(SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag), `<${tag}> must stay allowed`);
  }
  // custom renderer chrome (md-code block + copy button) and GFM extras
  for (const tag of ["div", "span", "button", "table", "thead", "tbody", "tr", "th", "td", "input"]) {
    assert.ok(SANITIZE_CONFIG.ALLOWED_TAGS.includes(tag), `<${tag}> must stay allowed`);
  }
  // attributes the rendered output carries
  for (const attr of ["href", "src", "alt", "title", "class", "target", "rel", "style", "type", "checked", "disabled"]) {
    assert.ok(SANITIZE_CONFIG.ALLOWED_ATTR.includes(attr), `attribute '${attr}' must stay allowed`);
  }
});

test("allowlists are plain frozen data: no prototype keys, no mutation", () => {
  const protoKeys = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"];
  for (const list of [SANITIZE_CONFIG.ALLOWED_TAGS, SANITIZE_CONFIG.ALLOWED_ATTR]) {
    assert.ok(Array.isArray(list));
    for (const key of protoKeys) {
      assert.ok(!list.includes(key), `'${key}' must not appear as a ${list === SANITIZE_CONFIG.ALLOWED_TAGS ? "tag" : "attr"}`);
    }
    assert.ok(Object.isFrozen(list), "allowlists must be frozen against runtime tampering");
  }
  assert.ok(Object.isFrozen(SANITIZE_CONFIG));
  assert.deepEqual(Object.keys(SANITIZE_CONFIG).sort(), ["ALLOWED_ATTR", "ALLOWED_TAGS", "ALLOW_DATA_ATTR"]);
  assert.equal(SANITIZE_CONFIG.ALLOW_DATA_ATTR, true, "the copy button carries its payload in data-raw");
});
