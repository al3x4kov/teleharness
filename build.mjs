// teleharness frontend bundler. Bundles src/main.jsx -> public/app.js with esbuild.
// Tolerates a missing frontend (this scaffold ships before src/ exists).
import { build } from "esbuild";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(root, "src", "main.jsx");
// TELEHARNESS_OUT_DIR: bundle into a staging public/ instead of the live one — the
// production server serves public/ directly, so a test build must not land
// there before the matching server.js is deployed (2026-11-02).
const outDir = process.env.TELEHARNESS_OUT_DIR ? path.resolve(process.env.TELEHARNESS_OUT_DIR) : path.join(root, "public");

// Optional guard for a server that serves public/ straight from the working
// copy: with TELEHARNESS_BUILD_GUARD=1 writing into public/ needs an explicit
// TELEHARNESS_BUILD_PROD=1 (set by the deploy script); other builds must target a
// staging dir via TELEHARNESS_OUT_DIR. Off by default — a plain `npm run build` builds.
if (process.env.TELEHARNESS_BUILD_GUARD === "1" && !process.env.TELEHARNESS_OUT_DIR && process.env.TELEHARNESS_BUILD_PROD !== "1") {
  console.error("[teleharness/build] refusing to write the live public/ — set TELEHARNESS_OUT_DIR=<dir> for a test build, or TELEHARNESS_BUILD_PROD=1 for a deploy.");
  process.exit(2);
}

if (!existsSync(entry)) {
  console.log("[teleharness/build] src/main.jsx not found yet - nothing to bundle. Skipping (frontend not scaffolded).");
  process.exit(0);
}

const result = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outfile: path.join(outDir, "app.js"),
  jsx: "automatic",
  jsxImportSource: "preact",
  // FEAT-03.19: the preloader artwork is imported as SVG text (same loader as tests/components/helpers/load.mjs).
  loader: { ".svg": "text" },
  metafile: true,
});

console.log(`[teleharness/build] wrote ${path.relative(root, path.join(outDir, "app.js")) || "app.js"}`);

// FEAT-07.20: the service worker is a hand-written static file in public/
// (not bundled). A staging out dir (stand, tests) gets a copy so /teleharness/sw.js
// exists wherever app.js registers it.
const swSrc = path.join(root, "public", "sw.js");
if (existsSync(swSrc) && path.resolve(outDir) !== path.join(root, "public")) {
  copyFileSync(swSrc, path.join(outDir, "sw.js"));
  console.log(`[teleharness/build] copied sw.js → ${path.relative(root, path.join(outDir, "sw.js"))}`);
}

// Components import their stylesheets from js (src/app.css first, then
// component css): esbuild emits the whole graph's css to public/app.css. The
// standalone app.css pass below would overwrite that file, so it runs only
// when the js graph produced no css output.
const cssEntry = path.join(root, "src", "app.css");
const jsEmittedCss = Object.keys(result.metafile.outputs).some((file) => file.endsWith(".css"));
if (jsEmittedCss) {
  console.log(`[teleharness/build] wrote ${path.relative(root, path.join(outDir, "app.css"))} (from js graph)`);
} else if (existsSync(cssEntry)) {
  await build({
    entryPoints: [cssEntry],
    bundle: true,
    minify: true,
    outfile: path.join(outDir, "app.css"),
  });
  console.log("[teleharness/build] wrote public/app.css");
} else {
  console.log("[teleharness/build] src/app.css not found - skipping css bundle.");
}
