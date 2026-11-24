// Chat artifacts: the fullscreen FileViewer overlay. Renders what the browser
// can do natively (images, PDF and sandboxed HTML in iframes, video/audio),
// markdown via the chat renderer, text/code as pre, CSV/TSV as a table and —
// without heavy libraries — xlsx (sheet tabs) and docx (text, headings,
// lists, tables) through src/lib/office.js (FEAT-05.10/FV-02). «Скачать»
// (Content-Disposition: attachment) is always there; formats no browser
// previews get an honest download card.
// Every load path has the same three honest outcomes (FV-03/04/09): skeleton
// while loading, a reasoned error screen with «Повторить» (404/403/5xx/no
// network — never a raw JSON body in a frame or a silent empty player), or
// the content. Path-based pdf/html/media are HEAD-checked first.
// z-index 45: topmost overlay. Focus is trapped inside and returns to the
// chip that opened it (FV-18/BUG-01.38).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { activeSessionDir, fileUrl } from "../../lib/store.js";
import {
  dataUrlBytes,
  detectCsvDelimiter,
  fileErrorInfo,
  fileKindOf,
  fileTypeLabel,
  fmtBytes,
  isNumericCell,
  middleEllipsis,
  parseCsv,
  resolveRelativePath,
} from "../../lib/normalize.js";
import { parseDocx, parsePptx, parseXlsx } from "../../lib/office.js";
import Markdown from "./Markdown.jsx";
import { t } from "../../lib/i18n.js";

const TEXT_CAP = 1024 * 1024; // >1MB text files get the download card
const OFFICE_CAP = 20 * 1024 * 1024; // in-browser unzip/parse budget
const CSV_ROW_CAP = 300;

export function kindForFile(name = "") {
  return fileKindOf(name);
}

export function isPreviewable(name = "") {
  return kindForFile(name) !== "binary";
}

function kindForDataUrl(dataUrl, name = "") {
  const m = /^data:([^;,]+)/i.exec(String(dataUrl ?? ""));
  const mime = (m?.[1] ?? "").trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "md";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
  if (mime === "text/html") return "html";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return kindForFile(name);
}

function decodeDataUrl(dataUrl) {
  const s = String(dataUrl ?? "");
  const comma = s.indexOf(",");
  if (comma < 0) return { bytes: new Uint8Array(0), mime: "application/octet-stream" };
  const meta = s.slice(5, comma);
  const mime = meta.split(";")[0]?.trim() || "application/octet-stream";
  const payload = s.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return { bytes: out, mime };
  }
  const text = decodeURIComponent(payload);
  return { bytes: new TextEncoder().encode(text), mime };
}

async function readResponseBounded(res, cap) {
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > cap) {
          try { await reader.cancel(); } catch {}
          return { tooBig: true, bytes: total, buffer: null };
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return { tooBig: false, bytes: total, buffer: out.buffer };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > cap) return { tooBig: true, bytes: buf.byteLength, buffer: null };
  return { tooBig: false, bytes: buf.byteLength, buffer: buf };
}

// Obsidian-style YAML frontmatter ("---\nkey: value\n...\n---") is metadata,
// not prose: rendered by the markdown engine it mangles into a setext heading.
// Only strips when the FIRST line is --- AND every line up to the closing ---
// looks like "key: value" — a doc that merely opens with a rule survives.
// BUG-153: nested YAML (indented "  key: v"), lists ("  - item") and blank lines
// inside are frontmatter too — the first line must still be a top-level key.
const FRONTMATTER_RE = /^---\r?\n[^\s:-][^\r\n:]*:[^\r\n]*\r?\n(?:(?:[ \t]*[^\s:-][^\r\n:]*:[^\r\n]*|[ \t]*- [^\r\n]*|[ \t]*)\r?\n)*---\r?\n?/;

export function stripFrontmatter(text) {
  return String(text ?? "").replace(FRONTMATTER_RE, "");
}

const DocIcon = ({ size = 40 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

function Table({ rows, cap = CSV_ROW_CAP, total }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, cap);
  const [head, ...body] = shown;
  const width = Math.max(...shown.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  return (
    <div class="file-table-wrap" tabIndex={0} role="region" aria-label={t("fileViewer.table.aria")}>
      <table class="file-csv">
        <thead>
          <tr>{pad(head).map((c, i) => <th key={i} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {pad(r).map((c, j) => <td key={j} class={isNumericCell(c) ? "num" : undefined}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {(total ?? rows.length) > cap && (
        <p class="file-note file-note--left">{t("fileViewer.table.capped", { cap, total: total ?? rows.length })}</p>
      )}
    </div>
  );
}

function XlsxView({ data }) {
  const [tab, setTab] = useState(0);
  const sheets = data.sheets ?? [];
  if (sheets.length === 0) return <p class="file-empty">{t("fileViewer.xlsx.noSheets")}</p>;
  const sheet = sheets[Math.min(tab, sheets.length - 1)];
  return (
    <div class="file-office">
      {sheets.length > 1 && (
        <div class="file-tabs" role="tablist" aria-label={t("fileViewer.xlsx.sheetsAria")}>
          {sheets.map((s, i) => (
            <button key={i} type="button" role="tab" class="file-tab" aria-selected={i === tab} onClick={() => setTab(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet.rows.length === 0 ? <p class="file-empty">{t("fileViewer.xlsx.sheetEmpty")}</p> : <Table rows={sheet.rows} />}
      {(sheet.truncatedRows || sheet.truncatedCols) && (
        <p class="file-note file-note--left">
          {t("fileViewer.xlsx.partial", {
            rows: sheet.truncatedRows ? t("fileViewer.xlsx.firstRows") : "",
            cols: sheet.truncatedCols ? t("fileViewer.xlsx.firstCols") : "",
          })}
        </p>
      )}
      <p class="file-note file-note--left">{t("fileViewer.xlsx.valuesOnly")}</p>
    </div>
  );
}

function Runs({ runs }) {
  return runs.map((r, i) => {
    let node = r.text;
    if (r.italic) node = <em>{node}</em>;
    if (r.bold) node = <strong>{node}</strong>;
    return <span key={i}>{node}</span>;
  });
}

function renderBlocks(blocks) {
  const out = [];
  let list = null;
  blocks.forEach((b, i) => {
    if (b.type === "p" && b.list && !b.empty) {
      if (!list) {
        list = [];
        out.push(<ul key={"ul" + i}>{list}</ul>);
      }
      list.push(<li key={i}><Runs runs={b.runs} /></li>);
      return;
    }
    list = null;
    if (b.type === "h") {
      const H = "h" + Math.min(6, b.level + 1); // h1 belongs to the page
      out.push(<H key={i}><Runs runs={b.runs} /></H>);
    } else if (b.type === "table") {
      out.push(<Table key={i} rows={b.rows} />);
    } else if (!b.empty) {
      out.push(<p key={i}><Runs runs={b.runs} /></p>);
    }
  });
  return out;
}

function DocxView({ data }) {
  const blocks = data.blocks ?? [];
  if (blocks.every((b) => b.empty)) return <p class="file-empty">{t("fileViewer.docx.empty")}</p>;
  return (
    <div class="file-docx md">
      {renderBlocks(blocks)}
      {data.truncated && <p class="file-note">{t("fileViewer.docx.truncated")}</p>}
    </div>
  );
}

function PptxView({ data }) {
  const slides = data.slides ?? [];
  const imgUrls = useMemo(() => {
    const map = new Map();
    for (const s of slides) {
      const list = (s.images ?? []).map((img) => ({
        name: img.name,
        url: URL.createObjectURL(new Blob([img.bytes], { type: img.mime || "application/octet-stream" })),
      }));
      map.set(s.index, list);
    }
    return map;
  }, [data]);

  useEffect(() => {
    return () => {
      for (const list of imgUrls.values()) {
        for (const item of list) {
          try { URL.revokeObjectURL(item.url); } catch {}
        }
      }
    };
  }, [imgUrls]);

  if (slides.length === 0) return <p class="file-empty">{t("fileViewer.pptx.empty")}</p>;

  return (
    <div class="file-pptx">
      {slides.map((s) => {
        const imgs = imgUrls.get(s.index) ?? [];
        const content = renderBlocks(s.blocks ?? []);
        const isEmptySlide = !s.title && content.length === 0 && imgs.length === 0;
        return (
          <section class="file-slide md" key={s.index} aria-label={t("fileViewer.pptx.slide", { n: s.index })}>
            <div class="file-slide-head">{t("fileViewer.pptx.slide", { n: s.index })}</div>
            {s.title && <h3 class="file-slide-title">{s.title}</h3>}
            {content}
            {imgs.length > 0 && (
              <div class="file-slide-imgs">
                {imgs.map((img, j) => (
                  <img key={j} class="file-slide-img" src={img.url} alt={img.name || t("fileViewer.pptx.imageAlt", { n: j + 1 })} loading="lazy" />
                ))}
              </div>
            )}
            {isEmptySlide && <p class="file-empty">{t("fileViewer.pptx.slideEmpty")}</p>}
            {s.notes && (
              <details class="file-pptx-notes">
                <summary>{t("fileViewer.pptx.notes")}</summary>
                <p>{s.notes}</p>
              </details>
            )}
          </section>
        );
      })}
      {data.truncated && (
        <p class="file-note file-note--left">{t("fileViewer.pptx.truncated")}</p>
      )}
    </div>
  );
}

export default function FileViewer({ file, onClose }) {
  const kind = file.dataUrl ? kindForDataUrl(file.dataUrl, file.name) : kindForFile(file.name);
  const directory = file.directory ?? activeSessionDir() ?? ""; // FEAT-19.16: a run folder outside any chat
  const url = file.dataUrl ?? (file.path ? fileUrl(directory, file.path) : "");
  const downloadUrl = file.dataUrl ?? (file.path ? fileUrl(directory, file.path, true) : "");
  const isOffice = kind === "xlsx" || kind === "docx" || kind === "pptx";
  const fetchBody = ["md", "text", "csv", "xlsx", "docx", "pptx"].includes(kind);
  // phase: loading | ready | error | too-big | empty | unreadable
  const [phase, setPhase] = useState(file.dataUrl && !fetchBody ? "ready" : "loading");
  const [status, setStatus] = useState(null);
  const [bytes, setBytes] = useState(null);
  const [text, setText] = useState("");
  const [office, setOffice] = useState(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [imgDims, setImgDims] = useState(null); // ISSUE-012: «PNG · W×H · размер»
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState("");
  const closeRef = useRef(null);
  const panelRef = useRef(null);

  // Panel is portaled to body — stays interactive while the shell behind is inert.
  useEffect(() => {
    const shell = document.querySelector(".shell");
    const opener = document.activeElement;
    shell?.setAttribute("inert", "");
    shell?.setAttribute("aria-hidden", "true");
    return () => {
      shell?.removeAttribute("inert");
      shell?.removeAttribute("aria-hidden");
      // FV-18: back to the chip that opened the viewer.
      if (opener && opener.isConnected && typeof opener.focus === "function") {
        try {
          opener.focus({ preventScroll: true });
        } catch {}
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        onClose?.();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      // Focus trap: Tab cycles inside the panel only.
      const items = [...panelRef.current.querySelectorAll(
        'a[href], button:not([disabled]), iframe, video, audio, summary, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panelRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", onKey);
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      removeEventListener("keydown", onKey);
      body.style.overflow = prev;
    };
  }, []);

  const parseOfficeBuffer = (buf) => {
    if (kind === "xlsx") return parseXlsx(buf);
    if (kind === "docx") return parseDocx(buf);
    return parsePptx(buf);
  };

  // Load: body-fetch kinds read the content; path-based previews HEAD-check
  // first so a 404 never lands as raw JSON inside an iframe/player.
  useEffect(() => {
    let dead = false;
    if (file.dataUrl) {
      if (!fetchBody) {
        setPhase("ready");
        return undefined;
      }
      setPhase("loading");
      (async () => {
        try {
          const { bytes: raw } = decodeDataUrl(file.dataUrl);
          if (dead) return;
          setBytes(raw.byteLength);
          const cap = isOffice ? OFFICE_CAP : TEXT_CAP;
          if (raw.byteLength > cap) {
            setPhase("too-big");
            return;
          }
          if (isOffice) {
            try {
              const data = await parseOfficeBuffer(raw.buffer);
              if (dead) return;
              setOffice(data);
              setPhase("ready");
            } catch {
              if (!dead) setPhase("unreadable");
            }
            return;
          }
          const t = new TextDecoder().decode(raw);
          if (dead) return;
          setText(t);
          setPhase(t.trim() === "" ? "empty" : "ready");
        } catch {
          if (!dead) setPhase("unreadable");
        }
      })();
      return () => {
        dead = true;
      };
    }

    setPhase("loading");
    setStatus(null);
    setMediaReady(false);
    (async () => {
      try {
        if (!url) throw Object.assign(new Error("no url"), { status: 404 });
        if (!fetchBody) {
          const r = await fetch(url, { method: "HEAD" });
          if (dead) return;
          if (!r.ok) throw Object.assign(new Error("http"), { status: r.status });
          const rawLen = r.headers.get("content-length");
          const len = rawLen !== null && rawLen !== "" ? Number(rawLen) : NaN;
          setBytes(Number.isFinite(len) ? len : null);
          setPhase(Number.isFinite(len) && len === 0 ? "empty" : "ready");
          return;
        }
        const res = await fetch(url);
        if (dead) return;
        if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });
        const rawLen = res.headers.get("content-length");
        const len = rawLen !== null && rawLen !== "" ? Number(rawLen) : NaN;
        if (Number.isFinite(len)) setBytes(len);
        const cap = isOffice ? OFFICE_CAP : TEXT_CAP;
        if (Number.isFinite(len) && len > cap) {
          try {
            res.body?.cancel?.();
          } catch {}
          setPhase("too-big");
          return;
        }
        const read = await readResponseBounded(res, cap);
        if (dead) return;
        setBytes(read.bytes);
        if (read.tooBig) {
          setPhase("too-big");
          return;
        }
        if (isOffice) {
          try {
            const data = await parseOfficeBuffer(read.buffer);
            if (dead) return;
            setOffice(data);
            setPhase("ready");
          } catch {
            if (!dead) setPhase("unreadable");
          }
          return;
        }
        const t = new TextDecoder().decode(read.buffer);
        if (dead) return;
        setText(t);
        setPhase(t.trim() === "" ? "empty" : "ready");
      } catch (err) {
        if (dead) return;
        setStatus(err?.status ?? 0);
        setPhase("error");
      }
    })();
    return () => {
      dead = true;
    };
  }, [url, attempt]);

  const retry = () => setAttempt((n) => n + 1);
  const mediaFailed = () => {
    setStatus(-1);
    setPhase("error");
  };

  const triggerDownload = (e) => {
    if (!downloadUrl || (phase === "error" && status !== -1) || downloading) {
      e.preventDefault();
      return;
    }
    const isStandalone = Boolean(navigator.standalone) || Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches);
    const isData = downloadUrl.startsWith("data:");
    if (!isStandalone && !isData) return;

    e.preventDefault();
    setDownloading(true);
    setDlError("");
    const fname = file.name || "file";
    (async () => {
      try {
        let blob;
        if (isData) {
          const { bytes: raw, mime } = decodeDataUrl(downloadUrl);
          blob = new Blob([raw], { type: mime });
        } else {
          const res = await fetch(downloadUrl, { credentials: "same-origin" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          blob = await res.blob();
        }
        if (typeof navigator.canShare === "function" && typeof navigator.share === "function" && typeof File === "function") {
          const shareFile = new File([blob], fname, { type: blob.type || "application/octet-stream" });
          let can = false;
          try { can = navigator.canShare({ files: [shareFile] }); } catch { can = false; }
          if (can) {
            try {
              await navigator.share({ files: [shareFile], title: fname });
              return;
            } catch (err) {
              if (err?.name === "AbortError") return;
            }
          }
        }
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = fname;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        const revokeTimer = setTimeout(() => {
          try { URL.revokeObjectURL(objUrl); } catch {}
        }, 60_000);
        revokeTimer?.unref?.();
      } catch {
        setDlError(t("fileViewer.downloadFailed"));
      } finally {
        setDownloading(false);
      }
    })();
  };

  const downloadBtn = (label = t("fileViewer.download")) => (
    <a
      class={"btn-primary file-bin-dl" + (downloading ? " is-busy" : "")}
      href={downloadUrl || "#"}
      download={file.name || true}
      aria-busy={downloading || undefined}
      onClick={triggerDownload}
    >
      {downloading ? t("fileViewer.downloading") : label}
    </a>
  );

  const card = (title, note, actions) => (
    <div class="file-bin" role={phase === "error" ? "alert" : undefined}>
      <DocIcon />
      <p class="file-bin-name">{title}</p>
      {note && <p class="file-note">{note}</p>}
      {dlError && <p class="file-note file-note--err" role="alert">{dlError}</p>}
      <div class="file-bin-actions">{actions}</div>
    </div>
  );

  // Markdown links/images relative to the viewed file go through /api/file.
  const resolveUrl = file.path
    ? (href) => {
        const p = resolveRelativePath(file.path, href);
        return p ? fileUrl(directory, p) : null;
      }
    : undefined;

  let body = null;
  if (phase === "loading") {
    body = (
      <div class="file-sk-wrap" role="status" aria-label={t("fileViewer.loading")}>
        <span class={"sk file-sk" + (kind === "image" || kind === "video" || kind === "pdf" ? " is-media" : "")} />
        {fetchBody && <span class="sk file-sk-line" />}
        {fetchBody && <span class="sk file-sk-line is-short" />}
      </div>
    );
  } else if (phase === "error") {
    const info = status === -1
      ? { title: t("fileViewer.unsupported.title"), text: t("fileViewer.unsupported.text"), retry: false }
      : fileErrorInfo(status);
    body = card(
      info.title,
      info.text,
      <>
        {info.retry && <button class="btn-primary" type="button" onClick={retry}>{t("common.retry")}</button>}
        {status === -1 && downloadBtn()}
      </>,
    );
  } else if (phase === "too-big") {
    body = card(
      file.name,
      t("fileViewer.tooBig") + (bytes != null ? ` · ${fmtBytes(bytes)}` : ""),
      downloadBtn(),
    );
  } else if (phase === "empty") {
    body = card(file.name, `${t("fileViewer.empty")} · ${fmtBytes(bytes ?? 0)}`, downloadBtn());
  } else if (phase === "unreadable") {
    body = card(
      file.name,
      t("fileViewer.unreadable") + (bytes != null ? ` · ${fmtBytes(bytes)}` : ""),
      downloadBtn(),
    );
  } else {
    switch (kind) {
      case "image":
        body = (
          <>
            {!mediaReady && <span class="sk file-sk is-media" aria-hidden="true" />}
            <img
              class={"file-img" + (mediaReady ? "" : " is-pending")}
              src={url}
              alt={file.name}
              onLoad={(e) => {
                const im = e.currentTarget;
                if (im?.naturalWidth && im?.naturalHeight) setImgDims({ w: im.naturalWidth, h: im.naturalHeight });
                setMediaReady(true);
              }}
              onError={mediaFailed}
            />
          </>
        );
        break;
      case "pdf":
        body = <iframe class="file-frame" src={url} title={file.name} />;
        break;
      case "html":
        body = (
          <>
            <iframe class="file-frame file-frame--html" src={url} title={file.name} sandbox="allow-scripts allow-popups allow-forms" />
            <p class="file-note">{t("fileViewer.html.sandbox")}</p>
          </>
        );
        break;
      case "md":
        body = <div class="file-md"><Markdown text={stripFrontmatter(text)} resolveUrl={resolveUrl} /></div>;
        break;
      case "text":
        body = <pre class="file-pre">{text}</pre>;
        break;
      case "csv": {
        const rows = parseCsv(text, detectCsvDelimiter(text, file.name));
        body = rows.length === 0 ? <p class="file-empty">{t("fileViewer.csv.empty")}</p> : <Table rows={rows} />;
        break;
      }
      case "xlsx":
        body = <XlsxView data={office ?? { sheets: [] }} />;
        break;
      case "docx":
        body = <DocxView data={office ?? { blocks: [] }} />;
        break;
      case "pptx":
        body = <PptxView data={office ?? { slides: [] }} />;
        break;
      case "video":
        body = <video class="file-media" src={url} controls playsinline preload="metadata" onError={mediaFailed} />;
        break;
      case "audio":
        body = <audio class="file-audio" src={url} controls preload="metadata" onError={mediaFailed} />;
        break;
      default:
        body = card(
          file.name,
          t("fileViewer.noPreview") + (bytes != null && Number.isFinite(bytes) ? ` · ${fmtBytes(bytes)}` : ""),
          downloadBtn(),
        );
    }
  }

  // Images read «PNG · 1024×768 · 315 Б» (ISSUE-012): format, pixels, size.
  const imgExt = kind === "image" ? (/\.([a-z0-9]+)$/i.exec(file.name ?? "")?.[1] ?? /^data:image\/([a-z0-9+.-]+)/i.exec(file.dataUrl ?? "")?.[1] ?? "") : "";
  const dataBytes = bytes == null && file.dataUrl ? dataUrlBytes(file.dataUrl) : null;
  const shownBytes = bytes ?? dataBytes;
  const sub = [
    kind === "image" && imgExt ? imgExt.toUpperCase().replace("JPEG", "JPG").replace("SVG+XML", "SVG") : fileTypeLabel(file.name),
    kind === "image" && imgDims ? `${imgDims.w}×${imgDims.h}` : "",
    shownBytes != null && Number.isFinite(shownBytes) ? fmtBytes(shownBytes) : "",
  ].filter(Boolean).join(" · ");
  const wide = kind === "pdf" || kind === "html" || kind === "xlsx" || kind === "pptx" || kind === "csv" || kind === "video";

  // createPortal to <body>: the viewer must NOT live inside the chat scroll
  // container (iOS Safari anchors position:fixed descendants of a touch
  // scroller to the scrolling layer — iPhone report 2026-10-31).
  return createPortal(
    <div class="file-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()} role="presentation">
      <div class={"file-panel" + (wide ? " is-wide" : "")} role="dialog" aria-modal="true" aria-label={t("fileViewer.dialogAria", { name: file.name })} ref={panelRef}>
        <header class="file-head">
          <div class="file-head-text">
            <span class="file-title" title={file.name}>{middleEllipsis(file.name, 44)}</span>
            {sub && <span class="file-sub">{sub}</span>}
          </div>
          {kind === "pdf" && phase === "ready" && (
            <a class="file-head-link" href={url} target="_blank" rel="noopener noreferrer">{t("fileViewer.openFull")}</a>
          )}
          <a class={"file-head-btn" + (downloading ? " is-busy" : "")} href={downloadUrl || "#"} download={file.name || true} aria-label={t("fileViewer.downloadAria", { name: file.name })} aria-busy={downloading || undefined} onClick={triggerDownload}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
          </a>
          <button class="file-head-btn" type="button" ref={closeRef} onClick={onClose} aria-label={t("common.close")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>
        {dlError && phase === "ready" && (
          <div class="file-dl-banner" role="alert">{dlError}</div>
        )}
        <div class="file-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
