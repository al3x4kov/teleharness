// Unit tests for lib/host.js pure helpers (the sampling/PowerShell parts are
// integration-tested via GET /zai/api/host in server.test.js).
// Run: node --test tests/host.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDfK, thermalCelsius, trackTempStuck } from "../lib/host.js";

test("thermalCelsius normalizes both counter scales and rejects nonsense", () => {
  // boards reporting tenths of Kelvin: 3010 -> 301K -> 27.85°C
  assert.equal(thermalCelsius(3010), 27.9);
  // boards reporting plain Kelvin: 301 -> 27.85°C
  assert.equal(thermalCelsius(301), 27.9);
  // plausible CPU-package reading
  assert.equal(thermalCelsius(3291), 56);
  // junk: zero/negative/non-numeric/out of physical range
  assert.equal(thermalCelsius(0), null);
  assert.equal(thermalCelsius(-5), null);
  assert.equal(thermalCelsius("abc"), null);
  assert.equal(thermalCelsius(null), null);
  assert.equal(thermalCelsius(50), null); // 50K = -223°C: not a real reading
});

const T0 = 1_700_000_000_000;

test("trackTempStuck: a moving sensor is never stuck", () => {
  assert.equal(trackTempStuck(40.1, 10, T0), false);
  assert.equal(trackTempStuck(40.3, 30, T0 + 60_000), false); // value changed -> clock reset
  assert.equal(trackTempStuck(41.0, 95, T0 + 120_000), false);
});

test("trackTempStuck: byte-identical reading + load swing >=25pp after 60s -> stuck", () => {
  assert.equal(trackTempStuck(27.9, 15, T0), false);
  assert.equal(trackTempStuck(27.9, 100, T0 + 30_000), false); // swing big, but <60s
  assert.equal(trackTempStuck(27.9, 40, T0 + 70_000), true); // 70s + swing 85 -> frozen stub
});

test("trackTempStuck: identical reading + small load swing needs the full TEMP_STUCK_MS", () => {
  assert.equal(trackTempStuck(28.0, 8, T0), false);
  assert.equal(trackTempStuck(28.0, 12, T0 + 60_000), false); // 60s + swing 4 -> not enough
  assert.equal(trackTempStuck(28.0, 10, T0 + 4 * 60_000), false);
  assert.equal(trackTempStuck(28.0, 10, T0 + 5 * 60_000), true); // 5 min frozen
});

test("trackTempStuck: null reading resets tracking, reports not-stuck", () => {
  assert.equal(trackTempStuck(30.0, 50, T0), false);
  assert.equal(trackTempStuck(null, 50, T0 + 10 * 60_000), false);
  assert.equal(trackTempStuck(30.0, 50, T0 + 11 * 60_000), false); // clock restarted
  assert.equal(trackTempStuck(30.0, 50, T0 + 11 * 60_000 + 5 * 60_000), true);
});

test("parseDfK (macOS / Linux disks): real /dev devices only, no loop/boot/macOS system sub-volumes", () => {
  const out = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    "/dev/sda1 104857600 41943040 62914560 40% /",
    "tmpfs 1024 0 1024 0% /run",
    "/dev/loop0 128 128 0 100% /snap/core/1",
    "/dev/sda2 1024 512 512 50% /boot/efi",
    "/dev/disk3s5 524288000 209715200 314572800 40% /System/Volumes/Data",
    "/dev/disk3s6 524288000 1 314572800 1% /System/Volumes/VM",
    "/dev/sdb1 2097152 1048576 1048576 50% /mnt/my disk",
  ].join("\n");
  assert.deepEqual(parseDfK(out).map((d) => [d.drive, d.usedPct, d.totalGb]), [
    ["/", 40, 100],
    ["/System/Volumes/Data", 40, 500],
    ["/mnt/my disk", 50, 2],
  ]);
  assert.deepEqual(parseDfK(""), []);
});
