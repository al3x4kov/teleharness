// TASK-17.1 (EPIC-17): карточка «Компьютер» на Linux — /proc, /sys, statfs вместо PowerShell CIM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linuxMountPoints, linuxDiskFromStatfs, linuxTempCelsius } from "../lib/host.js";

const MOUNTS = `overlay / overlay rw,relatime,lowerdir=/var/lib/docker/... 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
tmpfs /dev tmpfs rw,nosuid,size=65536k 0 0
/dev/sda1 /data ext4 rw,relatime 0 0
/dev/sdb1 /srv/backups xfs rw,relatime 0 0
/dev/sda1 /etc/hosts ext4 rw,relatime 0 0
shm /dev/shm tmpfs rw 0 0
/dev/sdc1 /mnt/with\\040space btrfs rw 0 0
sysfs /sys sysfs ro 0 0`;

test("TASK-17.1: linuxMountPoints — только реальные ФС, без псевдо и bind-файлов; один раз на устройство", () => {
  assert.deepEqual(linuxMountPoints(MOUNTS), ["/", "/data", "/srv/backups", "/mnt/with space"]);
});

test("TASK-17.1: linuxDiskFromStatfs — проценты и ГБ как у Windows-ветки", () => {
  const d = linuxDiskFromStatfs("/data", { bsize: 4096, blocks: 262144000, bfree: 131072000, bavail: 120000000 });
  assert.equal(d.drive, "/data");
  assert.equal(d.totalGb, 1000);
  assert.equal(d.usedPct, 50);
  assert.equal(linuxDiskFromStatfs("/x", { bsize: 4096, blocks: 0, bfree: 0 }), null);
});

test("TASK-17.1: linuxTempCelsius — максимум из thermal_zone (миллиградусы), мусор отбрасывается", () => {
  assert.equal(linuxTempCelsius(["45000\n", "52500\n", "oops", ""]), 52.5);
  assert.equal(linuxTempCelsius([]), null);
  assert.equal(linuxTempCelsius(["-273000"]), null, "нереальные значения — нет данных");
});
