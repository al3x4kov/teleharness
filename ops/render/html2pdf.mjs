// FEAT-04.12: HTML/SVG → PDF for teleharness-render (called by teleharness_render.py on the host).
// Headless Edge through Playwright; EVERY request of the page is intercepted:
// only files of the copied page folder are served (http://teleharness-render.invalid/…),
// everything else — internet, loopback (opencode :4096), LAN, other schemes —
// is aborted. file:// cannot be loaded from an http page by the browser itself.
// argv: <site dir> <page file name> <out pdf>
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TELEHARNESS_RENDER_PLAYWRIGHT || (process.platform === "win32" ? "D:/Apps/teleharness-qa/node_modules/playwright" : "playwright"));

const [site, page, out] = process.argv.slice(2);
const root = realpathSync(path.resolve(site));
const TYPES = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const HOST = "teleharness-render.invalid";

const platformLaunch = process.platform === "win32" ? { channel: "msedge" } : {
  ...(process.env.TELEHARNESS_RENDER_CHROMIUM ? { executablePath: process.env.TELEHARNESS_RENDER_CHROMIUM } : {}),
  // Disable only inside the already-isolated offline tenant container.
  chromiumSandbox: process.env.TELEHARNESS_RENDER_CHROMIUM_SANDBOX !== "0",
};
const browser = await chromium.launch({ ...platformLaunch, headless: true, timeout: 45_000, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run", ...(process.env.TELEHARNESS_RENDER_CHROMIUM_SANDBOX === "0" ? ["--single-process", "--no-zygote", "--disable-gpu"] : [])] });
let code = 0;
try {
  const ctx = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true });
  await ctx.route("**/*", (route) => {
    let u;
    try {
      u = new URL(route.request().url());
    } catch {
      return route.abort("blockedbyclient");
    }
    if (u.protocol !== "http:" || u.hostname !== HOST || route.request().method() !== "GET") return route.abort("blockedbyclient");
    try {
      const p = realpathSync(path.resolve(root, decodeURIComponent(u.pathname).replace(/^\/+/, "")));
      if (p !== root && !p.startsWith(root + path.sep)) return route.abort("blockedbyclient");
      if (!statSync(p).isFile()) return route.abort("blockedbyclient");
      return route.fulfill({ status: 200, headers: { "content-type": TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream" }, body: readFileSync(p) });
    } catch {
      return route.abort("blockedbyclient");
    }
  });
  if (typeof ctx.routeWebSocket === "function") await ctx.routeWebSocket(/.*/, (ws) => ws.close());
  // WebRTC is not routed at all — refuse it (and WebSocket again) in the page itself.
  await ctx.addInitScript(() => {
    for (const k of ["WebSocket", "RTCPeerConnection", "webkitRTCPeerConnection", "EventSource"]) {
      try {
        Object.defineProperty(window, k, { value: undefined, configurable: false });
      } catch {}
    }
  });
  const pg = await ctx.newPage();
  await pg.goto(`http://${HOST}/${encodeURIComponent(page)}`, { waitUntil: "load", timeout: 60_000 });
  await pg.waitForTimeout(1500);
  const svg = /\.svg$/i.test(page);
  await pg.pdf({ path: out, printBackground: true, preferCSSPageSize: !svg, format: svg ? undefined : "A4", width: svg ? "1280px" : undefined, height: svg ? "960px" : undefined, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
} catch (e) {
  console.error(String(e?.message ?? e).slice(0, 400));
  code = 1;
} finally {
  await browser.close().catch(() => {});
}
process.exit(code);
