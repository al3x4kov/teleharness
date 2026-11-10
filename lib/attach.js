// Non-image attachments cannot ride inline to the model provider (GLM API:
// "'file part media type application/…' functionality not supported", live
// 2026-10-31). CLI opencode writes such files next to the session and lets
// the agent read them with tools — we do the same server-side: decode the
// data: URL into <session dir>/.zai-uploads/<name> and swap the file part
// for a text part referencing it. Images stay inline (vision works).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const UPLOAD_DIR = ".zai-uploads";

export function sanitizeFilename(name) {
  const base = String(name ?? "").split(/[\\/:*?"<>|\r\n\t]/).pop().trim();
  const safe = (base || "file").slice(0, 120);
  return safe;
}

// First free path in dir for the given (sanitized) name: name, name-1, name-2…
export function pickUniqueName(dir, name) {
  let target = path.join(dir, name);
  for (let i = 1; existsSync(target); i += 1) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    target = path.join(dir, `${stem}-${i}${ext}`);
  }
  return path.basename(target);
}

function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma); // "mime;base64" | "mime" | ";base64"
  const payload = url.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) return { buf: Buffer.from(payload, "base64"), mime: meta.replace(/;base64$/i, "") || null };
    return { buf: Buffer.from(decodeURIComponent(payload), "utf8"), mime: meta || null };
  } catch {
    return null;
  }
}

// The single source of truth for the reference text the model sees. The
// client renders parts matching FILE_REF_RE back into attachment chips.
export function fileRefText(storedName, bytes, mime) {
  return (
    `[Пользователь приложил файл: ${UPLOAD_DIR}/${storedName} ` +
    `(${bytes} байт, ${mime || "тип неизвестен"}). ` +
    `Файл лежит в папке сессии и доступен инструментам — прочитай его с диска, если нужен контент.]`
  );
}

// BUG-140 (FEAT-03.12): a picture for a model WITHOUT image input (GLM-5.3
// text model behind Sisyphus) is rejected by the model, and the agent has no
// path to hand to its vision helper. Such a picture is saved like any other
// attachment and referenced with its absolute path and a hint for look_at.
// Same «[Пользователь приложил файл: .zai-uploads/<name> (N байт, mime).»
// prefix as fileRefText, so the client shows the usual attachment chip.
export function imageRefText(storedName, bytes, mime, absPath) {
  return (
    `[Пользователь приложил файл: ${UPLOAD_DIR}/${storedName} ` +
    `(${bytes} байт, ${mime || "тип неизвестен"}). ` +
    `Это изображение; текущая модель не принимает картинки напрямую — для анализа передай полный путь ${absPath} ` +
    `инструменту look_at (субагент multimodal-looker) или другой vision-модели.]`
  );
}

// Does the model accept image input? From the upstream /provider catalog
// ({all:[{id, models:{id:{capabilities:{input:{image}}}}}]}; older shapes:
// modalities.input[] / attachment). true / false, null = unknown (the
// caller keeps the old inline behaviour).
export function modelAcceptsImages(catalog, model) {
  const pid = model?.providerID;
  const mid = model?.modelID;
  if (!pid || !mid) return null;
  const prov = (Array.isArray(catalog?.all) ? catalog.all : []).find((p) => p?.id === pid);
  const m = prov?.models?.[mid] ?? Object.values(prov?.models ?? {}).find((x) => x?.id === mid);
  if (!m) return null;
  const img = m.capabilities?.input?.image;
  if (typeof img === "boolean") return img;
  if (Array.isArray(m.modalities?.input)) return m.modalities.input.includes("image");
  if (typeof m.attachment === "boolean") return m.attachment;
  return null;
}

// BUG-163: a model of the same provider that sees pictures, for one turn of a
// tenant whose chat model is text-only (the tenant has no vision subagent).
// preferred: model id tried first (ZAI_TENANT_VISION_MODEL); allowed(model) →
// false skips a model (the tenant's own catalog). null when the model already
// sees pictures, is unknown, or the provider has no vision model. Pure.
export function visionSibling(catalog, model, { preferred = "", allowed = () => true } = {}) {
  if (modelAcceptsImages(catalog, model) !== false) return null;
  const prov = (Array.isArray(catalog?.all) ? catalog.all : []).find((p) => p?.id === model.providerID);
  const ids = Object.values(prov?.models ?? {})
    .map((x) => x?.id)
    .filter((id) => typeof id === "string");
  const order = preferred && ids.includes(preferred) ? [preferred, ...ids.filter((id) => id !== preferred)] : ids;
  for (const modelID of order) {
    const cand = { providerID: model.providerID, modelID };
    if (modelAcceptsImages(catalog, cand) === true && allowed(cand)) return cand;
  }
  return null;
}

// Takes a prompt request body (Buffer), returns the body to send upstream.
// Anything that is not a JSON {parts:[...]} passes through untouched.
// inlineImages: false → pictures are materialized too (BUG-140: the model
// has no image input); default true = pictures stay inline (vision works).
export function materializeFileParts(bodyBuffer, sessionDir, { inlineImages = true } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return bodyBuffer;
  }
  if (!Array.isArray(parsed?.parts)) return bodyBuffer;

  const out = [];
  let changed = false;
  for (const part of parsed.parts) {
    const isImage = String(part?.mime ?? "").startsWith("image/");
    const isFile =
      part?.type === "file" &&
      typeof part.url === "string" &&
      part.url.startsWith("data:") &&
      (!isImage || !inlineImages);
    if (!isFile) {
      out.push(part);
      continue;
    }
    const decoded = decodeDataUrl(part.url);
    if (!decoded || decoded.buf.length === 0) {
      out.push(part); // undecodable: pass through, the upstream will say its word
      continue;
    }
    const dirAbs = path.join(String(sessionDir ?? "."), UPLOAD_DIR);
    mkdirSync(dirAbs, { recursive: true });
    const stored = pickUniqueName(dirAbs, sanitizeFilename(part.filename));
    const target = path.join(dirAbs, stored);
    writeFileSync(target, decoded.buf);
    const mime = part.mime || decoded.mime;
    out.push({
      type: "text",
      text: isImage ? imageRefText(stored, decoded.buf.length, mime, path.resolve(target)) : fileRefText(stored, decoded.buf.length, mime),
    });
    changed = true;
  }
  if (!changed) return bodyBuffer;
  parsed.parts = out;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}
