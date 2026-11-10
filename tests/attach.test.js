// Unit tests for lib/attach.js — non-image data: URL file parts are written
// to <dir>/.zai-uploads and replaced with a text reference part.
// Run: node --test tests/attach.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeFileParts, sanitizeFilename, UPLOAD_DIR } from "../lib/attach.js";

const root = mkdtempSync(path.join(tmpdir(), "zai-attach-"));
after(() => rmSync(root, { recursive: true, force: true }));

const filePart = (name, mime, bytes) => ({
  type: "file",
  mime,
  filename: name,
  url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
});

test("sanitizeFilename strips path separators and control junk", () => {
  assert.equal(sanitizeFilename("../../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\temp\\отчёт.xlsx"), "отчёт.xlsx");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename(null), "file");
  assert.equal(sanitizeFilename("a:b*c?d|e").length > 0, true);
});

test("non-image file part is materialized and swapped for a text reference", () => {
  const body = Buffer.from(
    JSON.stringify({
      agent: "build",
      parts: [
        { type: "text", text: "посмотри файл" },
        filePart("data.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      ],
    }),
  );
  const out = materializeFileParts(body, root);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0].type, "text");
  assert.equal(parsed.parts[1].type, "text", "file part must be replaced");
  assert.ok(parsed.parts[1].text.includes(`${UPLOAD_DIR}/data.xlsx`));
  assert.ok(parsed.parts[1].text.includes("4 байт"));

  const saved = path.join(root, UPLOAD_DIR, "data.xlsx");
  assert.ok(existsSync(saved), "file must exist on disk");
  assert.deepEqual(readFileSync(saved), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});

test("image parts and non-file bodies pass through untouched", () => {
  const img = { agent: "build", parts: [{ type: "text", text: "hi" }, { type: "file", mime: "image/png", filename: "p.png", url: "data:image/png;base64,aGk=" }] };
  const out = materializeFileParts(Buffer.from(JSON.stringify(img)), root);
  assert.deepEqual(JSON.parse(out.toString("utf8")), img, "image file part must stay inline");
  const notJson = Buffer.from("plain text body");
  assert.equal(materializeFileParts(notJson, root), notJson);
  const noParts = Buffer.from(JSON.stringify({ foo: 1 }));
  assert.equal(materializeFileParts(noParts, root), noParts);
});

test("BUG-140: inlineImages=false — the picture is saved to .zai-uploads and referenced by its absolute path for look_at", () => {
  const img = { agent: "Sisyphus", parts: [{ type: "text", text: "Опиши картинку" }, { type: "file", mime: "image/png", filename: "vision.png", url: "data:image/png;base64,aGk=" }] };
  const parsed = JSON.parse(materializeFileParts(Buffer.from(JSON.stringify(img)), root, { inlineImages: false }).toString("utf8"));
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts.some((p) => p.type === "file"), false, "no inline picture for a text-only model");
  const ref = parsed.parts[1].text;
  const saved = path.join(root, UPLOAD_DIR, "vision.png");
  assert.ok(existsSync(saved));
  assert.ok(ref.includes(saved), "absolute path for the vision subagent");
  assert.match(ref, /look_at/);
  // the client chip regex (MessageBubble FILE_REF_RE) still matches
  assert.match(ref, /^\[Пользователь приложил файл: \.zai-uploads\/(.+) \((\d+) байт(?:, ([^)]+))?\)\./);
  assert.equal(ref.indexOf("]"), ref.length - 1, "one bracketed reference (shared/title FILE_REF_RE)");
});

test("BUG-140: modelAcceptsImages — catalog capabilities, older shapes, unknown = null", async () => {
  const { modelAcceptsImages } = await import("../lib/attach.js");
  const catalog = {
    all: [
      { id: "zai-coding-plan", models: {
        "glm-5.3": { id: "glm-5.3", capabilities: { input: { text: true, image: false } } },
        "glm-5.3-flash": { id: "glm-5.3-flash", capabilities: { input: { text: true, image: true } } },
        old: { id: "old", modalities: { input: ["text"] } },
        older: { id: "older", attachment: true },
        bare: { id: "bare" },
      } },
    ],
  };
  const m = (modelID) => ({ providerID: "zai-coding-plan", modelID });
  assert.equal(modelAcceptsImages(catalog, m("glm-5.3")), false);
  assert.equal(modelAcceptsImages(catalog, m("glm-5.3-flash")), true);
  assert.equal(modelAcceptsImages(catalog, m("old")), false);
  assert.equal(modelAcceptsImages(catalog, m("older")), true);
  assert.equal(modelAcceptsImages(catalog, m("bare")), null);
  assert.equal(modelAcceptsImages(catalog, m("nope")), null);
  assert.equal(modelAcceptsImages(null, m("glm-5.3")), null);
});

test("BUG-163: visionSibling — the tenant's text model gets a same-provider vision model for a turn with pictures", async () => {
  const { visionSibling } = await import("../lib/attach.js");
  const catalog = {
    all: [
      { id: "zai-coding-plan", models: {
        "glm-5.3": { id: "glm-5.3", capabilities: { input: { text: true, image: false } } },
        "glm-5.3-air": { id: "glm-5.3-air", capabilities: { input: { text: true, image: true } } },
        "glm-5.3-flash": { id: "glm-5.3-flash", capabilities: { input: { text: true, image: true } } },
      } },
      { id: "other", models: { t: { id: "t", capabilities: { input: { image: false } } }, v: { id: "v", capabilities: { input: { image: true } } } } },
      { id: "blind", models: { t: { id: "t", capabilities: { input: { image: false } } } } },
    ],
  };
  const m = (providerID, modelID) => ({ providerID, modelID });
  // preferred id wins over catalog order
  assert.deepEqual(visionSibling(catalog, m("zai-coding-plan", "glm-5.3"), { preferred: "glm-5.3-flash" }), m("zai-coding-plan", "glm-5.3-flash"));
  // no preferred id → first vision model of the same provider
  assert.deepEqual(visionSibling(catalog, m("zai-coding-plan", "glm-5.3")), m("zai-coding-plan", "glm-5.3-air"));
  assert.deepEqual(visionSibling(catalog, m("other", "t"), { preferred: "glm-5.3-flash" }), m("other", "v"));
  // the model already sees pictures / is unknown → null (nothing to reroute)
  assert.equal(visionSibling(catalog, m("zai-coding-plan", "glm-5.3-flash")), null);
  assert.equal(visionSibling(catalog, m("zai-coding-plan", "nope")), null);
  // a provider without any vision model → null (the BUG-140 file path stays)
  assert.equal(visionSibling(catalog, m("blind", "t")), null);
  // never crosses providers; allowed() filter (tenant catalog) is honoured
  assert.equal(visionSibling(catalog, m("zai-coding-plan", "glm-5.3"), { allowed: () => false }), null);
  assert.deepEqual(visionSibling(catalog, m("zai-coding-plan", "glm-5.3"), { preferred: "glm-5.3-flash", allowed: (x) => x.modelID !== "glm-5.3-flash" }), m("zai-coding-plan", "glm-5.3-air"));
  assert.equal(visionSibling(null, m("zai-coding-plan", "glm-5.3")), null);
});

test("same-name uploads get numeric suffixes instead of overwriting", () => {
  const mk = () =>
    materializeFileParts(
      Buffer.from(JSON.stringify({ parts: [filePart("same.bin", "application/octet-stream", Buffer.from([1]))] })),
      root,
    );
  const first = JSON.parse(mk().toString()).parts[0].text;
  const second = JSON.parse(mk().toString()).parts[0].text;
  assert.ok(first.includes(`${UPLOAD_DIR}/same.bin`));
  assert.ok(second.includes(`${UPLOAD_DIR}/same-1.bin`), second);
});
