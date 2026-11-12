// L1 (TASK-14.9): lib/paths.js — isAbsoluteDir (BUG-013: относительная папка
// резолвилась от cwd службы C:\WINDOWS\system32). Windows-пути, регистр буквы
// диска, UNC, traversal («..»), мусорный ввод.
// Run: node --test tests/paths.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as paths from "../lib/paths.js";
// The Windows policy is pinned with platform "win32" so it runs on any OS;
// the POSIX rules have their own tests at the end of the file.
const isAbsoluteDir = (d) => paths.isAbsoluteDir(d, "win32");

test("экспорт модуля: isAbsoluteDir, dirProblem, dirProblemText — функции", () => {
  for (const k of ["isAbsoluteDir", "dirProblem", "dirProblemText"]) assert.equal(typeof paths[k], "function", k);
});

test("диск: X:\\ и X:/ в любом регистре — абсолютные", () => {
  for (const d of ["C:\\", "C:/", "c:\\", "d:/Portal/zai", "D:\\Portal\\zai", "Z:\\a b\\c", "D:\\Проекты\\zai", "C:\\Users\\USER\\", "D:\\Portal/zai"]) {
    assert.equal(isAbsoluteDir(d), true, d);
  }
});

test("UNC: \\\\host\\share[\\...] — абсолютный; без share — нет", () => {
  assert.equal(isAbsoluteDir("\\\\nas\\share"), true);
  assert.equal(isAbsoluteDir("\\\\nas\\share\\dir"), true);
  assert.equal(isAbsoluteDir("\\\\nas/share"), true, "смешанный разделитель после host");
  assert.equal(isAbsoluteDir("\\\\nas"), false);
  assert.equal(isAbsoluteDir("\\\\nas\\"), false);
  assert.equal(isAbsoluteDir("\\\\"), false);
  assert.equal(isAbsoluteDir("//nas/share"), false, "UNC через прямые слэши не принимается");
});

test("относительные и неполные пути отклоняются (BUG-013)", () => {
  for (const d of ["relative\\folder", "relative/folder", "folder", ".", ".\\x", "C:", "C:folder", "\\Windows", "/usr/local", "~/x", "1:\\x", "CC:\\x"]) {
    assert.equal(isAbsoluteDir(d), false, d);
  }
});

test("traversal: любой сегмент «..» отклоняется (в начале, середине, конце, любой разделитель)", () => {
  for (const d of ["..", "..\\x", "../x", "C:\\..", "C:\\a\\..", "C:\\a\\..\\b", "C:/a/../b", "D:\\a/..\\b", "\\\\nas\\share\\..\\x", "C:\\..\\"]) {
    assert.equal(isAbsoluteDir(d), false, d);
  }
});

test("точки внутри имени — не traversal", () => {
  for (const d of ["C:\\a..b", "C:\\..a", "C:\\a..", "C:\\...", "C:\\.git", "C:\\a\\.\\b"]) {
    assert.equal(isAbsoluteDir(d), true, d);
  }
});

test("пробелы по краям обрезаются; пустое/не-строка → false", () => {
  assert.equal(isAbsoluteDir("  D:\\Portal  "), true);
  assert.equal(isAbsoluteDir("\tC:/x\n"), true);
  for (const d of ["", "   ", null, undefined, 0, 42, {}, []]) assert.equal(isAbsoluteDir(d), false, String(d));
});

test("не-строка приводится через String(): объект с toString — по содержимому", () => {
  assert.equal(isAbsoluteDir({ toString: () => "D:\\x" }), true);
  assert.equal(isAbsoluteDir(["C:\\x"]), true, "String(['C:\\\\x']) === 'C:\\\\x'");
});

// ---- dirProblem (BUG-12.11: единая политика каталогов чата/тенанта) ------------
const { dirProblemText } = paths;
const dirProblem = (d, o = {}) => paths.dirProblem(d, { platform: "win32", portalRoot: "D:\\Portal", ...o });

test("dirProblem: пусто → empty", () => {
  for (const d of ["", "  ", null, undefined]) assert.equal(dirProblem(d), "empty", String(d));
});

test("dirProblem: device/long-path namespace (\\\\?\\, \\\\.\\, \\??\\) → device-namespace", () => {
  for (const d of ["\\\\?\\C:\\Windows", "\\\\.\\PhysicalDrive0", "\\??\\C:\\x", "//?/C:/x", "//./pipe/x"]) {
    assert.equal(dirProblem(d), "device-namespace", d);
  }
});

test("dirProblem: UNC (любые слэши) → unc", () => {
  for (const d of ["\\\\nas\\share", "\\\\nas\\share\\dir", "//nas/share"]) assert.equal(dirProblem(d), "unc", d);
});

test("dirProblem: относительный путь и traversal → not-absolute", () => {
  for (const d of ["relative\\folder", "folder", "C:folder", "/usr", "C:\\a\\..\\b", "D:/x/.."]) {
    assert.equal(dirProblem(d), "not-absolute", d);
  }
});

test("dirProblem: wildcard, 8.3-алиасы (~), NTFS-потоки (':' после диска) → alias", () => {
  for (const d of ["C:\\a*b", "C:\\a?b", "C:\\PROGRA~1", "D:\\x:stream", "D:\\x::$DATA", "D:\\a<b", "D:\\a|b", 'D:\\a"b']) {
    assert.equal(dirProblem(d), "alias", d);
  }
});

test("dirProblem: корень диска → drive-root (любой регистр/разделитель)", () => {
  for (const d of ["C:\\", "c:/", "D:\\\\", "Z:/"]) assert.equal(dirProblem(d), "drive-root", d);
});

test("dirProblem: системное дерево C: → system, регистр не важен", () => {
  for (const d of [
    "C:\\Windows",
    "c:/windows/System32",
    "C:\\WINDOWS\\system32\\relative",
    "C:\\Program Files\\App",
    "C:\\Program Files (x86)",
    "C:\\ProgramData\\x",
    "C:\\$Recycle.Bin",
    "C:\\System Volume Information",
    "C:\\Windows\\.\\Temp",
  ]) {
    assert.equal(dirProblem(d), "system", d);
  }
});

test("dirProblem: похожие, но не системные имена допустимы", () => {
  for (const d of ["C:\\Windows2", "C:\\WindowsApps-mirror", "C:\\Program Filesx", "D:\\Windowsy", "C:\\Users\\USER\\Windows"]) {
    // D:\Windows is a system tree since 1.7.0 (G7 finding 3: any drive).
    assert.equal(dirProblem(d), null, d);
  }
});

test("dirProblem: обычные рабочие каталоги (кириллица, пробелы, обрезка пробелов) → null", () => {
  for (const d of ["D:\\Проекты\\zai", "C:\\Users\\USER\\My Project", "  D:\\work  ", "D:/work/sub"]) {
    assert.equal(dirProblem(d), null, d);
  }
});

test("dirProblem: портал D:\\Portal — только для тенанта (owner может)", () => {
  assert.equal(dirProblem("D:\\Portal\\zai"), null, "владелец");
  assert.equal(dirProblem("D:\\Portal\\zai", { tenant: true }), "portal");
  assert.equal(dirProblem("d:/portal", { tenant: true }), "portal", "регистр/разделитель");
  assert.equal(dirProblem("D:\\Portal\\", { tenant: true }), "portal", "хвостовой слэш");
  assert.equal(dirProblem("D:\\PortalX", { tenant: true }), null, "префикс имени — не вложенность");
  assert.equal(dirProblem("D:\\Portal", { tenant: true, portalRoot: null }), null, "portalRoot отключён");
  assert.equal(dirProblem("E:\\site", { tenant: true, portalRoot: "E:\\site\\" }), "portal");
});

test("dirProblem: DATA_DIR портала — portal-data только если задан", () => {
  const opts = { tenant: true, dataDir: "E:\\zai-data" };
  assert.equal(dirProblem("E:\\zai-data\\users", opts), "portal-data");
  assert.equal(dirProblem("e:/ZAI-DATA", opts), "portal-data");
  assert.equal(dirProblem("E:\\zai-data", { tenant: true }), null);
  assert.equal(dirProblem("E:\\zai-data", { dataDir: "E:\\zai-data" }), null, "не тенант");
});

test("dirProblem: корень профиля владельца запрещён тенанту, подпапки разрешены", () => {
  const opts = { tenant: true, profileRoot: "C:\\Users\\USER" };
  assert.equal(dirProblem("C:\\Users\\USER", opts), "profile-root");
  assert.equal(dirProblem("c:/users/user/", opts), "profile-root");
  assert.equal(dirProblem("C:\\Users\\USER\\.zai-tenants\\bob", opts), null);
  assert.equal(dirProblem("C:\\Users\\USER", { profileRoot: "C:\\Users\\USER" }), null, "не тенант");
});

test("dirProblem: порядок проверок — device раньше unc, unc раньше not-absolute, system раньше tenant-зон", () => {
  assert.equal(dirProblem("\\\\?\\UNC\\nas\\share"), "device-namespace");
  assert.equal(dirProblem("\\\\nas"), "unc");
  assert.equal(dirProblem("C:\\Windows", { tenant: true, portalRoot: "C:\\" }), "system");
});

test("dirProblemText: каждый код → русский текст; неизвестный/пустой → общий", () => {
  const codes = ["empty", "device-namespace", "unc", "not-absolute", "alias", "drive-root", "system", "portal", "portal-data", "profile-root"];
  const texts = new Set();
  for (const c of codes) {
    const t = dirProblemText(c);
    assert.equal(typeof t, "string");
    assert.notEqual(t, "недопустимый каталог", c);
    assert.match(t, /[а-я]/i, c);
    texts.add(t);
  }
  assert.equal(texts.size, codes.length, "тексты различаются");
  assert.equal(dirProblemText("not-absolute"), "каталог должен быть абсолютным путём");
  for (const c of ["nope", null, undefined, ""]) assert.equal(dirProblemText(c), "недопустимый каталог", String(c));
});

test("dirProblem ↔ dirProblemText: любой код из dirProblem имеет собственный текст", () => {
  const samples = ["", "\\\\?\\x", "\\\\a\\b", "rel", "C:\\a*", "C:\\", "C:\\Windows"];
  for (const d of samples) assert.notEqual(dirProblemText(dirProblem(d)), "недопустимый каталог", d);
});

// ---- POSIX (macOS / Linux) -----------------------------------------------------------
const posix = (d, o = {}) => paths.dirProblem(d, { platform: "linux", portalRoot: "/srv/zai", ...o });

test("POSIX: isAbsoluteDir — только «/…», без «..» и «//»", () => {
  for (const d of ["/", "/home/u", "/tmp/a b", "/Users/u/Проекты"]) assert.equal(paths.isAbsoluteDir(d, { platform: "linux" }), true, d);
  for (const d of ["home/u", "~/x", "C:/x", "//nas/share", "/a/../b", ""]) assert.equal(paths.isAbsoluteDir(d, { platform: "darwin" }), false, d);
});

test("POSIX: dirProblem — корень, системные деревья, тенант-зоны", () => {
  assert.equal(posix("/home/u/proj"), null);
  assert.equal(posix("/"), "drive-root");
  assert.equal(posix("relative/x"), "not-absolute");
  assert.equal(posix("//nas/share"), "not-absolute");
  for (const d of ["/etc", "/usr/local/x", "/proc/1", "/System/Library", "/dev"]) assert.equal(posix(d), "system", d);
  assert.equal(posix("/etcetera"), null, "граница сегмента");
  for (const d of ["/a*b", "/a?b", "/a\\b"]) assert.equal(posix(d), "alias", d);
  assert.equal(posix("/srv/zai/data"), null, "владелец может");
  const t = { tenant: true, dataDir: "/srv/data", profileRoot: "/home/owner" };
  assert.equal(posix("/srv/zai/x", t), "portal");
  assert.equal(posix("/srv/data/users", t), "portal-data");
  assert.equal(posix("/home/owner/", t), "profile-root");
  assert.equal(posix("/home/owner/.zai-tenants/alice", t), null);

});

// ---- BUG-17.14 (BUG-220): сравнение префиксов путей по платформе ----
test("BUG-17.14: pathsOverlap/pathInside — win32 без учёта регистра и слэшей, linux с учётом регистра", () => {
  const { pathsOverlap, pathInside } = paths;
  assert.equal(pathsOverlap("C:\\T\\a", "c:/t/A/sub", "win32"), true);
  assert.equal(pathsOverlap("C:\\T\\a", "C:\\T\\ab", "win32"), false, "общий префикс имени — не вложенность");
  assert.equal(pathsOverlap("/home/t/a", "/home/t/a/b", "linux"), true);
  assert.equal(pathsOverlap("/home/t/a/b", "/home/t/a", "linux"), true);
  assert.equal(pathsOverlap("/home/t/a", "/home/t/a", "linux"), true);
  assert.equal(pathsOverlap("/home/t/a", "/home/t/ab", "linux"), false);
  assert.equal(pathsOverlap("/home/t/A", "/home/t/a/b", "linux"), false, "регистр на POSIX значим");
  assert.equal(pathInside("/srv/tenants/x", "/srv/tenants", "linux"), true);
  assert.equal(pathInside("/srv/tenants", "/srv/tenants", "linux"), false, "сам корень — не внутри");
  assert.equal(pathInside("D:\\Home\\x", "d:\\home", "win32"), true);
});

test("BUG-17.14: scopeReferenced на linux — вложенный каталог живого пользователя защищает папку удаляемого", () => {
  const { scopeReferenced } = paths;
  const users = [
    { id: "b", directories: ["/srv/tenants/a/shared-b"], extraRoots: [], obsidianRoot: null },
    { id: "c", directories: ["/srv/tenants/c"], extraRoots: ["/data/c"], obsidianRoot: "/vault/c" },
  ];
  assert.equal(scopeReferenced(users, "/srv/tenants/a", { platform: "linux" }), true, "внутри папки A живёт каталог B → не удалять");
  assert.equal(scopeReferenced(users, "/srv/tenants/a/shared-b/deep", { platform: "linux" }), true, "папка внутри живого скоупа");
  assert.equal(scopeReferenced(users, "/srv/tenants/z", { platform: "linux" }), false);
  assert.equal(scopeReferenced(users, "/vault/c", { platform: "linux" }), true, "obsidianRoot тоже скоуп");
  assert.equal(scopeReferenced(users, "/srv/tenants/c", { platform: "linux", exceptId: "c" }), false, "exceptId исключает удаляемого");
  assert.equal(scopeReferenced(users, "", { platform: "linux" }), true, "пустой путь — отказ в закрытую");
  const win = [{ id: "b", directories: ["D:\\T\\A\\inner"] }];
  assert.equal(scopeReferenced(win, "d:\\t\\a", { platform: "win32" }), true);
});

test("BUG-17.14: fsKey — нижний регистр только на win32", () => {
  assert.equal(paths.fsKey("D:\\Work\\Proj\\", "win32"), "d:\\work\\proj");
  assert.equal(paths.fsKey("/home/User/Proj/", "linux"), "/home/User/Proj");
});

test("BUG-17.14: значения по умолчанию путей к бинарникам заданы по платформе", () => {
  const w = paths.binDefaults({ platform: "win32", home: "C:\\Users\\USER", portalDir: "D:\\Portal\\zai" });
  assert.equal(w.claudeBin, "C:\\Users\\USER\\.local\\bin\\claude.exe");
  assert.equal(w.jailExe, "D:/Portal/zai/ops/sandbox/zai-jail.exe");
  assert.equal(w.sandboxPy, "D:/zai-sandbox/python");
  const l = paths.binDefaults({ platform: "linux", home: "/home/zai", portalDir: "/opt/zai" });
  assert.equal(l.claudeBin, "/home/zai/.local/bin/claude");
  assert.equal(l.jailExe, "/opt/zai/ops/sandbox/zai-jail");
  assert.equal(l.sandboxPy, "/opt/zai-sandbox/python");
  for (const v of Object.values(l)) assert.ok(!/\\|\.exe$|^[A-Za-z]:/.test(v), v);
});
