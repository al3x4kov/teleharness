// FEAT-18.8: «Изменения хода» — pure diff helpers (no DOM, node-importable).
//
// turnChanges(parts, {base}) → the files a turn changed, built from the tool
// parts of its steps (design.md «Этот ход», variant A — works for any past
// turn, no storage):
//   - Claude: Edit {file_path, old_string, new_string} / MultiEdit {edits[]}
//     (the transcript names both "edit"), Write {file_path, content} ("write");
//   - opencode: edit (state.metadata.diff — a unified diff; metadata.filediff
//     {before, after}; else oldString/newString), write (metadata.exists),
//     patch / apply_patch (metadata.diff | metadata.files | input.patchText);
//   - Codex (lib/codex-shim.mjs): Edit {file_path, diff} (a unified diff of
//     one file), Edit {file_path, files: ["update p", "add p"]} (several files,
//     no text), Write {file_path, content} (a new file).
// Only completed tools count: errors, refusals and running tools are skipped.
// Edits of one file within the turn merge in order (status: A stays A, D wins).
// A fragment without line numbers (Claude Edit — the tool has none) or a
// clipped input is marked `partial`.
//
// parseUnified(text) → [{path, oldPath, status, hunks, additions, deletions, binary}]
// lineDiff(a, b, {context}) → {hunks, additions, deletions} — Myers by lines,
// context 3, unchanged runs between hunks collapsed (hunk.gap / gapLines).
//
// Hunk: {header, oldStart, oldLines, newStart, newLines, gap, gapLines, lines:[{t, text, o, n}]}
//   t: " " | "+" | "-"; o / n — old / new line numbers (null when unknown).

import { lang, t } from "./i18n.js";

export const CONTEXT = 3;
export const BIG_LINES = 400; // a bigger diff shows the first 400 lines + «Показать всё» (brief, frame 7)

// lib/claude-transcript.js clip(): a long string input ends with this mark.
const CLIP_RE = /\n… \[обрезано: ещё \d+ симв\.\]$/;

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const filesLabel = (n) => t("git.files", { count: n });
export const unchangedLabel = (n) => t("git.unchangedLines", { count: n });

export function splitLines(text) {
  if (text == null || text === "") return [];
  const s = String(text).replace(/\r\n?/g, "\n");
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

function unclip(v) {
  if (typeof v !== "string") return { text: v == null ? "" : String(v), clipped: false };
  return CLIP_RE.test(v) ? { text: v.replace(CLIP_RE, ""), clipped: true } : { text: v, clipped: false };
}

// ---- Myers (O(ND)) on lines ------------------------------------------------
const MAX_D = 3000; // beyond that: a plain «all old out, all new in» (still correct, just coarse)

// → ops [{t, text, o, n}] (1-based line numbers)
export function diffOps(a, b) {
  const A = Array.isArray(a) ? a : splitLines(a);
  const B = Array.isArray(b) ? b : splitLines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre += 1;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf += 1;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const mid = myers(a2, b2);
  const ops = [];
  for (let i = 0; i < pre; i += 1) ops.push({ t: " ", text: A[i], o: i + 1, n: i + 1 });
  let o = pre;
  let n = pre;
  for (const [t, text] of mid) {
    if (t === " ") ops.push({ t, text, o: ++o, n: ++n });
    else if (t === "-") ops.push({ t, text, o: ++o, n: null });
    else ops.push({ t, text, o: null, n: ++n });
  }
  for (let i = 0; i < suf; i += 1) ops.push({ t: " ", text: A[A.length - suf + i], o: ++o, n: ++n });
  return ops;
}

function myers(a, b) {
  const N = a.length;
  const M = b.length;
  if (N === 0) return b.map((x) => ["+", x]);
  if (M === 0) return a.map((x) => ["-", x]);
  const max = Math.min(N + M, MAX_D);
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [...a.map((x) => ["-", x]), ...b.map((x) => ["+", x])];
  // backtrack
  const out = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d -= 1) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push([" ", a[x - 1]]);
      x -= 1;
      y -= 1;
    }
    if (x === prevX) out.push(["+", b[y - 1]]);
    else out.push(["-", a[x - 1]]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push([" ", a[x - 1]]);
    x -= 1;
    y -= 1;
  }
  return out.reverse();
}

// ops → hunks with `context` lines around changes; the unchanged run between
// two hunks becomes hunk.gap (count) + gapLines (so the UI can unfold it).
export function hunksFromOps(ops, { context = CONTEXT } = {}) {
  const changed = [];
  ops.forEach((op, i) => op.t !== " " && changed.push(i));
  if (changed.length === 0) return { hunks: [], tailGap: 0 };
  const groups = [];
  let s = changed[0];
  let e = changed[0];
  for (const i of changed.slice(1)) {
    if (i - e - 1 <= context * 2) e = i;
    else {
      groups.push([s, e]);
      s = e = i;
    }
  }
  groups.push([s, e]);
  const hunks = [];
  let prevEnd = 0;
  for (const [gs, ge] of groups) {
    const from = Math.max(prevEnd, gs - context);
    const to = Math.min(ops.length, ge + context + 1);
    const lines = ops.slice(from, to).map((x) => ({ t: x.t, text: x.text, o: x.o ?? null, n: x.n ?? null }));
    const gapLines = ops.slice(prevEnd, from).map((x) => ({ t: " ", text: x.text, o: x.o ?? null, n: x.n ?? null }));
    hunks.push(makeHunk(lines, gapLines.length, gapLines));
    prevEnd = to;
  }
  return { hunks, tailGap: ops.length - prevEnd };
}

function makeHunk(lines, gap = 0, gapLines = null) {
  const firstO = lines.find((l) => l.o != null)?.o ?? null;
  const firstN = lines.find((l) => l.n != null)?.n ?? null;
  const oldLines = lines.filter((l) => l.t !== "+").length;
  const newLines = lines.filter((l) => l.t !== "-").length;
  const oldStart = firstO ?? (firstN != null ? Math.max(0, firstN - 1) : null);
  const newStart = firstN ?? (firstO != null ? Math.max(0, firstO - 1) : null);
  const header = oldStart != null && newStart != null ? `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@` : "@@";
  return { header, oldStart, oldLines, newStart, newLines, gap, gapLines, lines };
}

const countOf = (hunks, t) => hunks.reduce((n, h) => n + h.lines.filter((l) => l.t === t).length, 0);

export function lineDiff(a, b, { context = CONTEXT } = {}) {
  const ops = diffOps(a, b);
  const { hunks, tailGap } = hunksFromOps(ops, { context });
  return { hunks, tailGap, additions: countOf(hunks, "+"), deletions: countOf(hunks, "-") };
}

// ---- unified diff ------------------------------------------------------------
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function cleanPath(p, strip) {
  let s = String(p ?? "").replace(/\t.*$/, "").trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s === "/dev/null") return null;
  if (strip) s = s.replace(/^[ab]\//, "");
  return s;
}

export function parseUnified(text) {
  const rows = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const files = [];
  let f = null;
  let h = null;
  let o = 0;
  let n = 0;
  let git = false;
  const start = (path = null) => {
    f = { path, oldPath: null, status: "M", hunks: [], additions: 0, deletions: 0, binary: false };
    files.push(f);
    h = null;
  };
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.startsWith("diff --git ")) {
      git = true;
      start();
      const m = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/.exec(r);
      if (m) f.path = m[2];
      continue;
    }
    if (r.startsWith("Index: ")) {
      if (f && !f.path && f.hunks.length === 0) f.path = r.slice(7).trim();
      else start(r.slice(7).trim());
      continue;
    }
    if (/^={20,}$/.test(r)) continue;
    if (h && h.left <= 0 && h.right <= 0) h = null; // the hunk is complete
    if (h && (r.startsWith(" ") || r.startsWith("+") || r.startsWith("-") || r === "")) {
        const t = r === "" ? " " : r[0];
        const body = r === "" ? "" : r.slice(1);
        if (t === "+") {
          h.hunk.lines.push({ t, text: body, o: null, n: n++ });
          h.right -= 1;
          f.additions += 1;
        } else if (t === "-") {
          h.hunk.lines.push({ t, text: body, o: o++, n: null });
          h.left -= 1;
          f.deletions += 1;
        } else {
          h.hunk.lines.push({ t: " ", text: body, o: o++, n: n++ });
          h.left -= 1;
          h.right -= 1;
        }
        continue;
    }
    if (r.startsWith("\\")) continue; // «\ No newline at end of file»
    if (r.startsWith("--- ")) {
      if (!f || f.hunks.length > 0) start();
      const p = cleanPath(r.slice(4), git || /^--- a\//.test(r));
      if (p == null) f.status = "A";
      else f.oldPath = p;
      continue;
    }
    if (r.startsWith("+++ ")) {
      if (!f) start();
      const p = cleanPath(r.slice(4), git || /^\+\+\+ b\//.test(r));
      if (p == null) {
        f.status = "D";
        f.path = f.path ?? f.oldPath;
      } else f.path = p;
      continue;
    }
    if (f && /^new file mode/.test(r)) f.status = "A";
    else if (f && /^deleted file mode/.test(r)) f.status = "D";
    else if (f && r.startsWith("rename from ")) {
      f.oldPath = r.slice(12);
      f.status = "R";
    } else if (f && r.startsWith("rename to ")) {
      f.path = r.slice(10);
      f.status = "R";
    } else if (f && /^Binary files .* differ$/.test(r)) f.binary = true;
    const m = HUNK_RE.exec(r);
    if (m) {
      if (!f) start();
      const os = Number(m[1]);
      const ol = m[2] == null ? 1 : Number(m[2]);
      const ns = Number(m[3]);
      const nl = m[4] == null ? 1 : Number(m[4]);
      const prev = f.hunks[f.hunks.length - 1];
      const prevEnd = prev ? prev.oldStart + prev.oldLines : 1;
      const gap = Math.max(0, (ol === 0 ? os + 1 : os) - prevEnd);
      const hunk = { header: r, oldStart: os, oldLines: ol, newStart: ns, newLines: nl, gap, gapLines: null, lines: [] };
      f.hunks.push(hunk);
      h = { hunk, left: ol, right: nl };
      o = ol === 0 ? os + 1 : os;
      n = nl === 0 ? ns + 1 : ns;
    }
  }
  for (const x of files) {
    if (x.status === "M" && x.oldPath && x.path && x.oldPath !== x.path && !git) x.oldPath = null;
    if (x.oldPath === x.path) x.oldPath = null;
  }
  return files.filter((x) => x.path || x.hunks.length > 0 || x.binary);
}

// opencode apply_patch text: *** Update File / *** Add File / *** Delete File.
export function parseApplyPatch(text) {
  const out = [];
  let f = null;
  let h = null;
  for (const r of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(r);
    if (m) {
      f = { path: m[2].trim(), oldPath: null, status: m[1] === "Add" ? "A" : m[1] === "Delete" ? "D" : "M", hunks: [], additions: 0, deletions: 0, binary: false };
      out.push(f);
      h = null;
      continue;
    }
    if (!f || /^\*\*\* (Begin|End) Patch/.test(r) || r.startsWith("*** End of File")) continue;
    if (r.startsWith("*** Move to: ")) {
      f.oldPath = f.path;
      f.path = r.slice(13).trim();
      f.status = "R";
      continue;
    }
    if (r.startsWith("@@") || !h) {
      h = { header: "@@", oldStart: null, oldLines: 0, newStart: null, newLines: 0, gap: 0, gapLines: null, lines: [] };
      f.hunks.push(h);
      if (r.startsWith("@@")) continue;
    }
    const t = r[0] === "+" || r[0] === "-" ? r[0] : " ";
    h.lines.push({ t, text: t === " " && r[0] !== " " ? r : r.slice(1), o: null, n: null });
    if (t === "+") f.additions += 1;
    else if (t === "-") f.deletions += 1;
  }
  for (const x of out) x.hunks = x.hunks.filter((hk) => hk.lines.length > 0);
  return out;
}

// ---- tool parts → changed files ---------------------------------------------
const norm = (p) => String(p ?? "").replace(/\\/g, "/");
const keyOf = (p) => {
  const s = norm(p).replace(/^\.\//, "");
  return /^[a-z]:\//i.test(s) || /\\/.test(String(p)) ? s.toLowerCase() : s;
};

// path relative to base (the chat folder) when inside it; else as is.
export function relPath(path, base) {
  const p = norm(path);
  const b = norm(base).replace(/\/+$/, "");
  if (b && p.toLowerCase().startsWith(b.toLowerCase() + "/")) return p.slice(b.length + 1);
  return p.replace(/^\.\//, "");
}

export function splitPath(path) {
  const p = norm(path).replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}

const inputOf = (p) => {
  const i = p?.state?.input;
  if (i && typeof i === "object") return i;
  if (typeof i === "string") {
    try {
      const v = JSON.parse(i);
      return v && typeof v === "object" ? v : {};
    } catch {}
  }
  return {};
};
const pathIn = (inp) => inp.file_path ?? inp.filePath ?? inp.path ?? inp.file ?? null;

function fragment(oldText, newText) {
  const a = unclip(oldText);
  const b = unclip(newText);
  const d = lineDiff(a.text, b.text);
  // A Claude Edit fragment has no real line numbers (the tool has none).
  for (const hk of d.hunks) {
    hk.header = "@@";
    hk.oldStart = hk.newStart = null;
    for (const l of hk.lines) l.o = l.n = null;
    if (hk.gapLines) for (const l of hk.gapLines) l.o = l.n = null;
  }
  return { hunks: d.hunks, additions: d.additions, deletions: d.deletions, clipped: a.clipped || b.clipped };
}

function wholeFile(content) {
  const c = unclip(content);
  const lines = splitLines(c.text).map((text, i) => ({ t: "+", text, o: null, n: i + 1 }));
  const hunks = lines.length ? [makeHunk(lines)] : [];
  return { hunks, additions: lines.length, deletions: 0, clipped: c.clipped };
}

function writeStatus(p) {
  const md = p.state?.metadata;
  if (md && md.exists === false) return "A";
  if (md && md.exists === true) return "M";
  const out = String(p.state?.output ?? "");
  if (/created|создан/i.test(out)) return "A";
  if (/updated|overwr|перезапис/i.test(out)) return "M";
  return "A"; // Codex Write is only ever a new file
}

// One tool part → [{path, status, hunks, additions, deletions, partial, rewritten?}]
export function toolChanges(p) {
  if (p?.type !== "tool" || p.state?.status !== "completed") return [];
  const tool = String(p.tool ?? "").toLowerCase();
  const inp = inputOf(p);
  const md = p.state?.metadata && typeof p.state.metadata === "object" ? p.state.metadata : {};
  const path = pathIn(inp);
  const fromUnified = (text, fallbackPath) => {
    const files = parseUnified(text);
    if (files.length === 1 && fallbackPath) files[0].path = fallbackPath;
    return files.filter((f) => f.path).map((f) => ({ ...f, partial: false }));
  };

  if (tool === "write") {
    if (Array.isArray(inp.files) && inp.files.length > 1) {
      // Codex: several new files in one change — names only
      return inp.files.map((s) => {
        const m = /^(?:add|delete|update)\s+(.+)$/.exec(String(s));
        return { path: m ? m[1] : String(s), status: "A", hunks: [], additions: 0, deletions: 0, partial: true };
      });
    }
    if (!path) return [];
    const w = wholeFile(inp.content);
    const status = writeStatus(p);
    return [{ path, status, hunks: w.hunks, additions: w.additions, deletions: 0, partial: w.clipped, rewritten: status === "M" }];
  }
  if (tool === "edit" || tool === "multiedit") {
    if (typeof md.diff === "string" && md.diff.includes("@@")) {
      const r = fromUnified(md.diff, path);
      if (r.length) return r;
    }
    const fd = md.filediff;
    if (fd && typeof fd === "object" && (typeof fd.before === "string" || typeof fd.after === "string") && path) {
      const d = lineDiff(fd.before ?? "", fd.after ?? "");
      return [{ path, status: fd.before ? "M" : "A", hunks: d.hunks, additions: d.additions, deletions: d.deletions, partial: false }];
    }
    if (typeof inp.diff === "string" && path) {
      // Codex: the unified diff of one file (hunks, maybe without ---/+++)
      const files = parseUnified(inp.diff);
      if (files.length >= 1 && files[0].hunks.length) {
        const f = files[0];
        return [{ path, status: f.status === "D" ? "D" : "M", hunks: f.hunks, additions: f.additions, deletions: f.deletions, partial: false }];
      }
      const w = wholeFile(inp.diff);
      return [{ path, status: "M", hunks: w.hunks, additions: w.additions, deletions: 0, partial: true }];
    }
    if (Array.isArray(inp.files) && inp.files.length) {
      // Codex, several files in one change: names only
      return inp.files.map((s) => {
        const m = /^(add|delete|update)\s+(.+)$/.exec(String(s));
        const st = m ? (m[1] === "add" ? "A" : m[1] === "delete" ? "D" : "M") : "M";
        return { path: m ? m[2] : String(s), status: st, hunks: [], additions: 0, deletions: 0, partial: true };
      });
    }
    let edits = inp.edits;
    if (typeof edits === "string") {
      try {
        edits = JSON.parse(edits);
      } catch {
        edits = null;
        if (path) return [{ path, status: "M", hunks: [], additions: 0, deletions: 0, partial: true }];
      }
    }
    if (Array.isArray(edits) && path) {
      const out = { path, status: "M", hunks: [], additions: 0, deletions: 0, partial: true };
      for (const e of edits) {
        if (!e || typeof e !== "object") continue;
        const fr = fragment(e.old_string ?? e.oldString, e.new_string ?? e.newString);
        out.hunks.push(...fr.hunks);
        out.additions += fr.additions;
        out.deletions += fr.deletions;
      }
      return [out];
    }
    const oldS = inp.old_string ?? inp.oldString;
    const newS = inp.new_string ?? inp.newString;
    if (path && (oldS != null || newS != null)) {
      const fr = fragment(oldS ?? "", newS ?? "");
      return [{ path, status: oldS ? "M" : "A", hunks: fr.hunks, additions: fr.additions, deletions: fr.deletions, partial: true }];
    }
    return [];
  }
  if (tool === "patch" || tool === "apply_patch") {
    if (typeof md.diff === "string" && md.diff.includes("@@")) {
      const r = fromUnified(md.diff, null);
      if (r.length) return r;
    }
    if (Array.isArray(md.files) && md.files.length) {
      const out = [];
      for (const f of md.files) {
        const fp = f?.filePath ?? f?.file ?? f?.path ?? f?.relativePath;
        if (!fp) continue;
        const st = f.type === "add" ? "A" : f.type === "delete" ? "D" : f.type === "move" ? "R" : "M";
        if (typeof f.diff === "string" && f.diff.includes("@@")) {
          const pf = parseUnified(f.diff)[0];
          if (pf) {
            out.push({ path: fp, status: st, hunks: pf.hunks, additions: pf.additions, deletions: pf.deletions, partial: false });
            continue;
          }
        }
        if (typeof f.before === "string" || typeof f.after === "string") {
          const d = lineDiff(f.before ?? "", f.after ?? "");
          out.push({ path: fp, status: st, hunks: d.hunks, additions: d.additions, deletions: d.deletions, partial: false });
        } else out.push({ path: fp, status: st, hunks: [], additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0, partial: true });
      }
      if (out.length) return out;
    }
    const text = inp.patchText ?? inp.patch ?? inp.input;
    if (typeof text === "string") {
      if (/^\*\*\* Begin Patch/m.test(text)) return parseApplyPatch(text).map((f) => ({ ...f, partial: true }));
      if (text.includes("@@")) return fromUnified(text, null);
    }
    return [];
  }
  return [];
}

function merge(into, add) {
  if (add.status === "D") into.status = "D";
  else if (into.status === "D" && add.status === "A") into.status = "M";
  else if (into.status !== "A" && into.status !== "D" && add.status === "R") into.status = "R";
  into.hunks.push(...add.hunks);
  into.additions += add.additions;
  into.deletions += add.deletions;
  into.partial = into.partial || add.partial;
  if (add.oldPath && !into.oldPath) into.oldPath = add.oldPath;
  into.rewritten = Boolean(into.rewritten || add.rewritten);
  into.edits += 1;
}

export function turnChanges(parts, { base = "" } = {}) {
  const byKey = new Map();
  for (const p of Array.isArray(parts) ? parts : []) {
    for (const c of toolChanges(p)) {
      const rel = relPath(c.path, base);
      const k = /^[a-z]:[\/]/i.test(c.path) || String(c.path).includes("\\") ? keyOf(rel).toLowerCase() : keyOf(rel);
      const cur = byKey.get(k);
      if (cur) merge(cur, c);
      else {
        const { name, dir } = splitPath(rel);
        byKey.set(k, {
          key: k,
          path: rel,
          abs: c.path,
          name,
          dir,
          oldPath: c.oldPath ?? null,
          status: c.status,
          hunks: [...c.hunks],
          additions: c.additions,
          deletions: c.deletions,
          partial: Boolean(c.partial),
          rewritten: Boolean(c.rewritten),
          binary: Boolean(c.binary),
          edits: 1,
        });
      }
    }
  }
  return [...byKey.values()];
}

export function totals(files) {
  return (Array.isArray(files) ? files : []).reduce((t, f) => ({ files: t.files + 1, additions: t.additions + (f.additions || 0), deletions: t.deletions + (f.deletions || 0) }), { files: 0, additions: 0, deletions: 0 });
}

// Parts of every step of a turn (feed order). steps: messages of the turn.
export function turnPartsOf(feed, turn) {
  if (!turn || !Array.isArray(feed)) return [];
  const i0 = feed.findIndex((m) => m?.info?.id === turn.first);
  const i1 = feed.findIndex((m) => m?.info?.id === turn.last);
  if (i0 < 0 || i1 < i0) return [];
  return feed.slice(i0, i1 + 1).flatMap((m) => m?.parts ?? []);
}

// ---- display helpers -----------------------------------------------------------
const STATUS_KEY = { M: "modified", A: "added", D: "deleted", R: "renamed", "?": "untracked", U: "conflict" };
export const STATUS_WORD = Object.defineProperties({}, Object.fromEntries(Object.entries(STATUS_KEY).map(([k, v]) => [k, { get: () => t(`git.status.${v}`), enumerable: true }])));
export function statusWord(f) {
  if (f?.rewritten && f.status === "M") return t("git.status.rewritten");
  return STATUS_WORD[f?.status] ?? t("git.status.modified");
}

// «db/migrations/0042 · изменён»; a file at the root — «корень проекта».
export function fileSub(f, { short = false } = {}) {
  const dir = f?.dir ?? splitPath(f?.path ?? "").dir;
  const where = dir || (short ? t("git.root") : t("git.projectRoot"));
  return short ? where : `${where} · ${statusWord(f)}`;
}

// The line number shown in the single column: old for «−», new otherwise.
export const lineNo = (l) => (l.t === "-" ? l.o : l.n);

// «@@ строки 12–24» from new-side numbers; a fragment without numbers — «фрагмент правки».
export function hunkTitle(h) {
  if (h?.newStart == null) return `@@ ${t("git.hunk.fragment")}`;
  const from = h.newLines === 0 ? h.newStart : h.newStart;
  const to = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart;
  return from === to ? `@@ ${t("git.hunk.line", { n: from })}` : `@@ ${t("git.hunk.lines", { from, to })}`;
}

export const lineCount = (hunks) => (Array.isArray(hunks) ? hunks.reduce((n, h) => n + h.lines.length, 0) : 0);

// The first `max` lines of a diff (frame 7): hunks cut, the rest counted.
export function limitHunks(hunks, max = BIG_LINES) {
  const out = [];
  let left = max;
  for (const h of hunks ?? []) {
    if (left <= 0) break;
    if (h.lines.length <= left) {
      out.push(h);
      left -= h.lines.length;
    } else {
      out.push({ ...h, lines: h.lines.slice(0, left) });
      left = 0;
    }
  }
  return out;
}

// «9,6 тыс.» for big counts, plain below 1000.
export function bigCount(n) {
  if (n < 1000) return String(n);
  const k = (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "");
  return t("git.thousands", { n: lang.value === "ru" ? k.replace(".", ",") : k });
}

// The file as a unified patch text (for «Скачать патч» / copy of «Этот ход»).
export function toUnified(f) {
  const out = [`--- ${f.status === "A" ? "/dev/null" : "a/" + f.path}`, `+++ ${f.status === "D" ? "/dev/null" : "b/" + f.path}`];
  for (const h of f.hunks ?? []) {
    out.push(h.newStart != null && h.oldStart != null ? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` : "@@");
    for (const l of h.lines) out.push(l.t + l.text);
  }
  return out.join("\n") + "\n";
}

export const fmtNum = (n) => Number(n || 0).toLocaleString("ru-RU");
