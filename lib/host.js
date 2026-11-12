// Host stats for the Settings «Компьютер» card: CPU load (node os sampling),
// RAM (node os), fixed disks + thermal zone (one PowerShell CIM query on
// Windows; `df -kP` elsewhere, temperatures null).
// Zero runtime deps. Everything is cached — the first CIM query on a cold
// PowerShell process can take 1-3s (measured 2026-10-31), warm ~0.5s.
import os from "node:os";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { binDefaults } from "./paths.js";

const CACHE_MS = 10_000;
const cache = { at: 0, data: null, pending: null };

function cpuSample() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  return { idle, total };
}

function cpuLoadPct(sampleMs = 200) {
  return new Promise((resolve) => {
    const a = cpuSample();
    setTimeout(() => {
      const b = cpuSample();
      const dt = b.total - a.total;
      const di = b.idle - a.idle;
      resolve(dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null);
    }, sampleMs);
  });
}

function toGb(bytes) {
  return Math.round((bytes / 2 ** 30) * 10) / 10;
}

function psJson(command) {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", command], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

// Win32_PerfFormattedData_Counters_ThermalZoneInformation.Temperature scale
// varies by board (tenths of Kelvin vs Kelvin) — normalize by magnitude and
// sanity-check the resulting celsius range.
export function thermalCelsius(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  const k = v >= 1000 ? v / 10 : v;
  const c = Math.round((k - 273.15) * 10) / 10;
  return c > -20 && c < 150 ? c : null;
}

// MSAcpi_ThermalZoneTemperature needs admin (PermissionDenied on this host);
// the perf-counter thermal zone under root\CIMV2 reads without elevation.
//
// A frozen ACPI zone is a common firmware stub: on this box TZ00 is pinned to
// 27.9°C (301 K) while CPU load swings 15→100% — a live sensor cannot do that
// (measured 2026-11-02, 7 samples / 35 s). Real core temps need a kernel
// driver we deliberately don't install (unsigned exe vs Smart App Control),
// so instead of showing a confident lie we detect the freeze: same reading for
// TEMP_STUCK_MS, or ≥60 s of the same reading while observed CPU load swung
// ≥25 points — load swings that big always move a real sensor.
const TEMP_STUCK_MS = 5 * 60_000;
const tempWatch = { value: undefined, since: 0, loadMin: null, loadMax: null };

export function trackTempStuck(tempC, loadPct, now = Date.now()) {
  if (tempC == null) {
    tempWatch.value = undefined;
    return false;
  }
  if (tempC !== tempWatch.value) {
    tempWatch.value = tempC;
    tempWatch.since = now;
    tempWatch.loadMin = tempWatch.loadMax = null;
  }
  if (typeof loadPct === "number") {
    tempWatch.loadMin = tempWatch.loadMin == null ? loadPct : Math.min(tempWatch.loadMin, loadPct);
    tempWatch.loadMax = tempWatch.loadMax == null ? loadPct : Math.max(tempWatch.loadMax, loadPct);
  }
  const elapsed = now - tempWatch.since;
  const swing = (tempWatch.loadMax ?? 0) - (tempWatch.loadMin ?? 0);
  return elapsed >= TEMP_STUCK_MS || (elapsed >= 60_000 && swing >= 25);
}

// BUG-03.5 (remainder): the only REAL sensor reachable without a kernel
// driver is the drive's own SMART temperature (Get-StorageReliabilityCounter).
// It moves with load, but Windows serves it only to an elevated token — the
// zai-web task runs Limited (checked 2026-11-02: «Access to a CIM resource was
// not available»), so in that setup it stays null and the UI says why.
// Pure: raw PS value (object | array | null) → hottest plausible °C or null.
export function diskTempCelsius(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  let best = null;
  for (const r of list) {
    const v = Number(r?.Temperature ?? r);
    if (Number.isFinite(v) && v > 0 && v < 120) best = best == null ? v : Math.max(best, v);
  }
  return best;
}

// opencode serve version for «О приложении» (no literal in the client):
// GET <upstream>/global/health → {healthy, version}. Cached; null on failure.
const UPSTREAM = process.env.ZAI_UPSTREAM || "http://127.0.0.1:4096";
const VERSION_TTL_MS = 10 * 60_000;
const versionCache = { at: 0, value: null };
// BUG-190: на opencode 2.x /global/health — HTML веб-интерфейса, версии там нет.
// Сервер в режиме v2 подставляет источник — OC.healthInfo() (/api/info с Basic).
let infoSource = null;
export function setOpencodeInfoSource(fn) {
  infoSource = typeof fn === "function" ? fn : null;
  versionCache.at = 0;
  versionCache.value = null;
}

export function parseHealthVersion(json) {
  const v = json?.version;
  return typeof v === "string" && /^\d+\.\d+(\.\d+)?([-+.][\w.]+)?$/.test(v.trim()) ? v.trim() : null;
}

export async function opencodeVersion(fetchImpl = globalThis.fetch, now = Date.now()) {
  if (versionCache.value && now - versionCache.at < VERSION_TTL_MS) return versionCache.value;
  try {
    let v = null;
    if (infoSource) {
      v = parseHealthVersion(await infoSource());
    } else {
      const r = await fetchImpl(new URL("/global/health", UPSTREAM), { signal: AbortSignal.timeout(2000) });
      v = r?.ok ? parseHealthVersion(await r.json()) : null;
    }
    if (v) {
      versionCache.value = v;
      versionCache.at = now;
    }
    return v ?? versionCache.value;
  } catch {
    return versionCache.value; // keep the last known version through a hiccup
  }
}

// BUG-143: harness versions for «О приложении» — the OmO plugin pinned in the
// opencode config (`plugin: ["oh-my-openagent@5.1.60", …]`) and `claude --version`.
// Unknown → null (the client then prints the name without a number).
export function parseOmoVersion(cfg) {
  const list = Array.isArray(cfg?.plugin) ? cfg.plugin : [];
  for (const p of list) {
    const m = typeof p === "string" ? p.match(/^oh-my-open(?:agent|code)@(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)$/) : null;
    if (m) return m[1];
  }
  return null;
}

// BUG-190: обвязка opencode — OmO (1.x, поле `plugin`) или oh-my-opencode-slim
// (поле `plugin` в 1.x, `plugins` в 2.x; элемент — строка или {package}).
export function parseHarness(cfg) {
  const list = [...(Array.isArray(cfg?.plugins) ? cfg.plugins : []), ...(Array.isArray(cfg?.plugin) ? cfg.plugin : [])];
  for (const p of list) {
    const s = typeof p === "string" ? p : typeof p?.package === "string" ? p.package : "";
    const m = s.match(/^(oh-my-opencode-slim|oh-my-open(?:agent|code))@(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)$/);
    if (m) return { name: m[1] === "oh-my-opencode-slim" ? "slim" : "OmO", version: m[2] };
  }
  return null;
}

export function parseClaudeVersion(out) {
  const m = String(out ?? "").trim().match(/^(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

const harnessCache = { at: 0, value: null };
export async function harnessVersions(now = Date.now()) {
  if (harnessCache.value && now - harnessCache.at < VERSION_TTL_MS) return harnessCache.value;
  const cfgHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  // BUG-190: конфиг 2.x лежит в своей зоне XDG — путь задаёт ZAI_OC_CONFIG_FILE (ops/web-v2.cmd)
  const cfgFile = process.env.ZAI_OC_CONFIG_FILE || path.join(cfgHome, "opencode", "opencode.json");
  let omoVersion = null;
  let harness = null;
  try {
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    harness = parseHarness(cfg);
    omoVersion = parseOmoVersion(cfg);
  } catch {}
  // the default install path first; otherwise whatever `claude` is on PATH (npm -g, Homebrew)
  const homeBin = binDefaults({ home: os.homedir() }).claudeBin;
  const bin = process.env.ZAI_CLAUDE_BIN || (existsSync(homeBin) ? homeBin : "claude");
  const claudeVersion = await new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : parseClaudeVersion(stdout)));
  });
  const value = { omoVersion, harness, claudeVersion };
  if (harness || omoVersion || claudeVersion) {
    harnessCache.value = value;
    harnessCache.at = now;
  }
  return value;
}

// Pure: `df -kP` stdout → disks of real block devices (/dev/*). Skips loop
// devices (snaps), /boot and the macOS system sub-volumes that share the
// container of «/» (only /System/Volumes/Data is kept).
export function parseDfK(stdout) {
  const disks = [];
  const seen = new Set();
  for (const line of String(stdout ?? "").split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(\/.*)$/);
    if (!m) continue;
    const [, fs, total, used, avail, mount] = m;
    if (!fs.startsWith("/dev/") || fs.startsWith("/dev/loop") || seen.has(mount)) continue;
    if (/^\/boot(\/|$)/.test(mount) || (mount.startsWith("/System/Volumes/") && mount !== "/System/Volumes/Data")) continue;
    const size = Number(total) * 1024;
    if (!(size > 0)) continue;
    seen.add(mount);
    const usedB = Number(used) * 1024;
    const pct = usedB + Number(avail) * 1024 > 0 ? usedB / (usedB + Number(avail) * 1024) : 0;
    disks.push({ drive: mount, usedPct: Math.max(0, Math.min(100, Math.round(pct * 100))), usedGb: toGb(usedB), totalGb: toGb(size) });
  }
  return disks;
}

function dfDisks() {
  return new Promise((resolve) => {
    execFile("df", ["-kP"], { timeout: 10_000 }, (err, stdout) => resolve(err && !stdout ? [] : parseDfK(stdout)));
  });
}

async function psDisksAndTemp() {
  if (process.platform !== "win32") return { disks: await dfDisks(), tempC: null, diskTempC: null };
  const out = await psJson(
    "$ErrorActionPreference='SilentlyContinue';" +
      "$d = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace);" +
      "$t = (Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation).Temperature;" +
      "$s = @(Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object Temperature);" +
      "[pscustomobject]@{ disks = $d; temp = $t; smart = $s } | ConvertTo-Json -Compress -Depth 3",
  );
  const rawDisks = Array.isArray(out?.disks) ? out.disks : out?.disks ? [out.disks] : [];
  const disks = rawDisks
    .filter((d) => d?.DeviceID && Number(d?.Size) > 0)
    .map((d) => ({
      drive: d.DeviceID,
      usedPct: Math.max(0, Math.min(100, Math.round((1 - d.FreeSpace / d.Size) * 100))),
      usedGb: toGb(d.Size - d.FreeSpace),
      totalGb: toGb(d.Size),
    }));
  return { disks, tempC: thermalCelsius(out?.temp), diskTempC: diskTempCelsius(out?.smart) };
}

// ---- TASK-17.1 (EPIC-17): Linux — /proc/mounts + statfs, /sys/class/thermal ----
const PSEUDO_FS = new Set(["proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "mqueue", "securityfs", "pstore", "debugfs", "tracefs", "configfs", "fusectl", "bpf", "hugetlbfs", "autofs", "binfmt_misc", "nsfs", "rpc_pipefs", "squashfs", "ramfs", "efivarfs", "fuse.lxcfs"]);

/** Mount points of real filesystems from /proc/mounts text (one per device, no bind-mounted files). */
export function linuxMountPoints(text) {
  const out = [];
  const devs = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const [dev, mnt, type] = line.trim().split(/\s+/);
    if (!dev || !mnt || !type || PSEUDO_FS.has(type)) continue;
    if (devs.has(dev) && dev !== "overlay") continue; // the same device mounted again (bind of a file/dir)
    devs.add(dev);
    out.push(mnt.replace(/\\040/g, " "));
  }
  return out;
}

/** {drive, usedPct, usedGb, totalGb} from fs.statfs, or null for an empty fs. */
export function linuxDiskFromStatfs(mount, st) {
  const total = Number(st?.blocks) * Number(st?.bsize);
  if (!(total > 0)) return null;
  const free = Number(st.bfree) * Number(st.bsize);
  return { drive: mount, usedPct: Math.max(0, Math.min(100, Math.round((1 - free / total) * 100))), usedGb: toGb(total - free), totalGb: toGb(total) };
}

/** Max thermal zone temperature in °C from raw millidegree strings; null when none is sane. */
export function linuxTempCelsius(raws) {
  const vals = (raws ?? []).map((r) => Number(String(r).trim()) / 1000).filter((c) => Number.isFinite(c) && c > 0 && c < 150);
  return vals.length ? Math.max(...vals) : null;
}

async function linuxDisksAndTemp() {
  const { statfs, readdir } = await import("node:fs/promises");
  let mounts = [];
  try {
    mounts = linuxMountPoints(await readFile("/proc/mounts", "utf8"));
  } catch {}
  const disks = [];
  for (const m of mounts) {
    try {
      const d = linuxDiskFromStatfs(m, await statfs(m));
      if (d) disks.push(d);
    } catch {}
  }
  let raws = [];
  try {
    const zones = (await readdir("/sys/class/thermal")).filter((z) => z.startsWith("thermal_zone"));
    raws = await Promise.all(zones.map((z) => readFile(`/sys/class/thermal/${z}/temp`, "utf8").catch(() => "")));
  } catch {}
  // SMART-температура дисков на Linux — только со smartctl в образе (опция), иначе честно нет данных
  return { disks, tempC: linuxTempCelsius(raws), diskTempC: null };
}

export function hostStats() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return Promise.resolve(cache.data);
  if (!cache.pending) {
    cache.pending = (async () => {
      const [loadPct, ps, ocVersion] = await Promise.all([cpuLoadPct(), process.platform === "win32" ? psDisksAndTemp() : linuxDisksAndTemp(), opencodeVersion()]); // TASK-17.1
      const data = {
        cpu: { loadPct, cores: os.cpus()?.length ?? null },
        ram: { usedGb: toGb(os.totalmem() - os.freemem()), totalGb: toGb(os.totalmem()) },
        disks: ps.disks,
        tempC: ps.tempC,
        tempStuck: trackTempStuck(ps.tempC, loadPct),
        diskTempC: ps.diskTempC,
        opencodeVersion: ocVersion,
      };
      cache.at = Date.now();
      cache.data = data;
      cache.pending = null;
      return data;
    })();
    cache.pending.catch(() => {
      cache.pending = null; // a failed sample must not poison future requests
    });
  }
  return cache.pending;
}
