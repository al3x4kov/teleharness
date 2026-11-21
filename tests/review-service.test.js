// @suite: server
// FEAT-20.1: ревью на настоящем git — снимок ревизии (индекс пользователя не
// меняется, большие файлы вне снимка, недоверенный репозиторий), пункт на чат,
// ревизии, комментарии с версиями (409), «Вернуть агенту» идемпотентно,
// «Принять» (409 busy / stale-revision / already), «Убрать», чат удалён,
// режим «по ходам» без git, планы (одно решение на план), права (чужой → 404).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRepo } from "../lib/git.js";
import { snapshotTree, treeChanges, treeDiff, headTree } from "../lib/review-snapshot.js";
import { ReviewService, ReviewStore, ReviewError } from "../lib/review.js";

const gitc = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "teleharness-rv-repo-"));
  gitc(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.js"), Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(path.join(dir, "token.js"), "export const t = 1;\nexport const u = 2;\n");
  writeFileSync(path.join(dir, "gone.js"), "one\ntwo\nthree\n");
  gitc(dir, "add", "-A");
  gitc(dir, "commit", "-qm", "init");
  return dir;
}
function service({ busy = () => false, post } = {}) {
  const data = mkdtempSync(path.join(os.tmpdir(), "teleharness-rv-data-"));
  const posts = [];
  let t = 1_800_000_000_000;
  const events = [];
  const svc = new ReviewService({
    store: new ReviewStore({ dir: path.join(data, "review"), log: () => {}, now: () => t }),
    objectsRoot: path.join(data, "objects"), tmpDir: path.join(data, "tmp"), busy,
    post: post ?? (async (x) => { posts.push(x); return { ok: true, status: 204 }; }),
    emit: (u, p) => events.push([u, p]), log: () => {}, now: () => (t += 1000),
  });
  return { svc, data, posts, events };
}
const U = "admin1";
const turn = (svc, dir, extra = {}) => svc.turnEnd({ users: [U], sid: "ses_1", dir, untrusted: false, turnId: "msg_" + Math.random(), meta: { title: "Токен", engine: "claude", model: "claude-haiku-4-5" }, ...extra });

test("Scenario «Индекс пользователя не меняется»: снимок не трогает status, индекс и объекты репозитория", async () => {
  const dir = repo();
  writeFileSync(path.join(dir, "staged.js"), "s\n");
  gitc(dir, "add", "staged.js");
  appendFileSync(path.join(dir, "a.js"), "more\n");
  const before = gitc(dir, "status", "--porcelain=v2");
  const objsBefore = gitc(dir, "count-objects");
  const r = await openRepo(dir);
  const data = mkdtempSync(path.join(os.tmpdir(), "teleharness-rv-obj-"));
  const s = await snapshotTree(r, { objDir: path.join(data, "o"), tmpDir: path.join(data, "t") });
  assert.equal(gitc(dir, "status", "--porcelain=v2"), before);
  assert.equal(gitc(dir, "count-objects"), objsBefore, "объекты пишутся только в хранилище портала");
  const files = await treeChanges(r, { objDir: path.join(data, "o"), from: await headTree(r), to: s.tree });
  assert.deepEqual(files.map((f) => `${f.status} ${f.path}`), ["M a.js", "A staged.js"]);
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

test("кр. 15: файл > 5 МБ не входит в снимок; переименование распознаётся (-M); двоичный — binary", async () => {
  const dir = repo();
  writeFileSync(path.join(dir, "huge.bin"), Buffer.alloc(6 * 1024 * 1024, 1));
  renameSync(path.join(dir, "token.js"), path.join(dir, "session.js"));
  writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
  const r = await openRepo(dir);
  const data = mkdtempSync(path.join(os.tmpdir(), "teleharness-rv-obj-"));
  const objDir = path.join(data, "o");
  const s = await snapshotTree(r, { objDir, tmpDir: path.join(data, "t") });
  assert.deepEqual(s.big, ["huge.bin"]);
  const files = await treeChanges(r, { objDir, from: await headTree(r), to: s.tree });
  const ren = files.find((f) => f.status === "R");
  assert.equal(ren.path, "session.js");
  assert.equal(ren.oldPath, "token.js");
  assert.equal(files.find((f) => f.path === "logo.png").binary, true);
  const d = await treeDiff(r, { objDir, from: await headTree(r), to: s.tree, file: "logo.png" });
  assert.equal(d.binary, true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

test("недоверенный репозиторий с программой в конфиге — режим «по ходам» с причиной unsafe-repo (N-40)", async () => {
  const dir = repo();
  gitc(dir, "config", "core.fsmonitor", "evil-program");
  const { svc } = service();
  appendFileSync(path.join(dir, "a.js"), "x\n");
  const parts = [{ type: "tool", tool: "write", state: { status: "completed", input: { filePath: path.join(dir, "a.js"), content: "x\n" }, metadata: { exists: true } } }];
  const [r] = await svc.turnEnd({ users: [U], sid: "ses_1", dir, untrusted: true, parts, meta: {} });
  assert.equal(r.item.mode, "turns");
  assert.equal(r.item.modeReason, "unsafe-repo");
  rmSync(dir, { recursive: true, force: true });
});

test("кр. 1, 2, 7, 8, 9: ход → пункт, второй ход — тот же пункт, комментарии, возврат, ревизия 2, принять", async () => {
  const dir = repo();
  let busy = false;
  const { svc, posts, events } = service({ busy: () => busy });
  await svc.turnStart({ users: [U], sid: "ses_1", dir, untrusted: false });
  // ход без правок — пункта нет
  assert.deepEqual(await turn(svc, dir), []);
  // ход с правками
  await svc.turnStart({ users: [U], sid: "ses_1", dir, untrusted: false });
  appendFileSync(path.join(dir, "a.js"), "added 61\n");
  writeFileSync(path.join(dir, "new.js"), "n\n");
  const [r1] = await turn(svc, dir);
  assert.equal(r1.item.revision, 1);
  assert.equal(r1.item.mode, "snapshot");
  assert.ok(events.some(([u, p]) => u[0] === U && p.id === r1.item.id && p.waiting === true), "teleharness.review.updated владельцу");
  // второй ход того же чата — тот же пункт, ревизия 2, 2 хода
  unlinkSync(path.join(dir, "gone.js"));
  const [r2] = await turn(svc, dir);
  assert.equal(r2.item.id, r1.item.id);
  const list = svc.list(U);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].turns, 2);
  assert.equal(list.items[0].files, 3);
  const id = r1.item.id;
  let d = await svc.detail(U, id, { untrusted: false });
  assert.deepEqual(d.fileList.map((f) => `${f.status} ${f.path}`), ["M a.js", "D gone.js", "A new.js"]);
  // дифф удалённого файла — все строки «−»
  const gd = await svc.diff(U, id, { file: "gone.js", untrusted: false });
  assert.match(gd.patch, /-one\n-two\n-three/);
  // просмотрено
  svc.setViewed(U, id, { file: "a.js" });
  assert.equal((await svc.detail(U, id, { untrusted: false })).fileList.find((f) => f.path === "a.js").reviewed, true);
  // комментарии: создание, версия, 409 на устаревшую (N-4)
  const c1 = svc.putComment(U, id, "c_one111", { side: "new", file: "a.js", from: 61, to: 61, quote: ["added 61"], text: "Зачем?", version: 0 }).comment;
  assert.equal(c1.version, 1);
  svc.putComment(U, id, "c_one111", { side: "new", file: "a.js", from: 61, to: 61, quote: ["added 61"], text: "Зачем это?", version: 1 });
  assert.throws(() => svc.putComment(U, id, "c_one111", { side: "new", file: "a.js", from: 61, text: "старое", version: 1 }), (e) => e.status === 409 && e.code === "version" && e.extra.current.text === "Зачем это?");
  svc.putComment(U, id, "c_two222", { side: "old", file: "gone.js", from: 1, to: 2, quote: ["one", "two"], text: "Не удаляй", version: 0 });
  // «Вернуть агенту»: устаревшая ревизия → 409; повтор ключа → одно сообщение (кр. 6, N-5/N-6)
  await assert.rejects(svc.send(U, id, { key: "send-key-1", revision: 1 }), (e) => e.code === "stale-revision");
  const s1 = await svc.send(U, id, { key: "send-key-1", revision: 2, general: "В целом ок" });
  const s2 = await svc.send(U, id, { key: "send-key-1", revision: 2 });
  assert.equal(posts.length, 1);
  assert.equal(s2.already, true);
  assert.equal(s1.count, 3);
  assert.match(posts[0].text, /^## Ревью · 3 комментария к 2 файлам \(ревизия 2\)/);
  assert.match(posts[0].text, /Удалённые строки 1–2/);
  assert.equal(svc.list(U).items[0].status, "returned");
  assert.equal(svc.list(U).items[0].needsYou, false);
  // агент правит строку 61 → ревизия 3, «с прошлого ревью» — только a.js, комментарий «строки изменились»
  writeFileSync(path.join(dir, "a.js"), readFileSync(path.join(dir, "a.js"), "utf8").replace("added 61", "added 61 fixed"));
  const [r3] = await turn(svc, dir);
  assert.equal(r3.item.revision, 3);
  d = await svc.detail(U, id, { untrusted: false });
  assert.equal(d.status, "waiting");
  assert.equal(d.sinceRevision, 2);
  assert.deepEqual(d.sinceFiles, ["a.js"]);
  assert.equal(d.comments.find((c) => c.id === "c_one111").outcome, "changed");
  const since = await svc.diff(U, id, { file: "a.js", since: 2, untrusted: false });
  assert.match(since.patch, /-added 61\n\+added 61 fixed/);
  // файлы изменились после снимка → «Изменилось», принять → 409 stale (кр. 9)
  appendFileSync(path.join(dir, "new.js"), "by hand\n");
  d = await svc.detail(U, id, { untrusted: false });
  assert.equal(d.stale.revision, 4);
  assert.deepEqual(d.stale.changedFiles, ["new.js"]);
  assert.equal(svc.list(U).items[0].status, "changed");
  await assert.rejects(svc.accept(U, id, { key: "acc-key-1", revision: 3, untrusted: false }), (e) => e.code === "stale-revision");
  // идёт ход → 409 busy (кр. 10)
  busy = true;
  await assert.rejects(svc.refresh(U, id, { untrusted: false }), (e) => e.code === "busy");
  await assert.rejects(svc.accept(U, id, { key: "acc-key-1", revision: 3, untrusted: false }), (e) => e.code === "busy");
  busy = false;
  const rf = await svc.refresh(U, id, { untrusted: false });
  assert.deepEqual(rf, { revision: 4, changed: true });
  const a1 = await svc.accept(U, id, { key: "acc-key-1", revision: 4, untrusted: false });
  assert.deepEqual(a1.files.sort(), ["a.js", "gone.js", "new.js"]);
  assert.deepEqual(await svc.accept(U, id, { key: "acc-key-1", revision: 4, untrusted: false }), a1, "повтор того же ключа");
  await assert.rejects(svc.accept(U, id, { key: "acc-key-2", revision: 4, untrusted: false }), (e) => e.status === 409 && e.code === "already" && e.extra.at === a1.at);
  assert.equal(svc.list(U).items.length, 0);
  assert.equal(svc.list(U, { accepted: true }).accepted.length, 1);
  // после принятия база — принятая ревизия: следующий ход показывает только новое
  appendFileSync(path.join(dir, "token.js"), "export const v = 3;\n");
  const [r4] = await turn(svc, dir);
  assert.notEqual(r4.item.id, id);
  assert.deepEqual(r4.item.revisions[0].files.map((f) => f.path), ["token.js"]);
  rmSync(dir, { recursive: true, force: true });
});

test("кр. 16: чужой пункт — 404 без названия; admin не видит пункты тенанта", async () => {
  const dir = repo();
  const { svc } = service();
  appendFileSync(path.join(dir, "a.js"), "x\n");
  const [r] = await svc.turnEnd({ users: ["tenantA"], sid: "ses_t", dir, untrusted: true, meta: { title: "Секрет" } });
  assert.equal(svc.list("tenantB").items.length, 0);
  assert.equal(svc.list(U).items.length, 0);
  await assert.rejects(svc.detail("tenantB", r.item.id, { untrusted: true }), (e) => e.status === 404 && !String(e.message).includes("Секрет"));
  await assert.rejects(svc.accept("tenantB", r.item.id, { key: "kkkkkk1", revision: 1, untrusted: true }), (e) => e.status === 404);
  assert.equal(svc.list("tenantA").items[0].status, "waiting", "состояние не изменилось");
  rmSync(dir, { recursive: true, force: true });
});

test("N-5: отправка не прошла — комментарии остаются черновиками, ключ освобождается", async () => {
  const dir = repo();
  let fail = true;
  const posts = [];
  const { svc } = service({ post: async (x) => { posts.push(x); return fail ? { ok: false, status: 429, error: "limit" } : { ok: true, status: 204 }; } });
  appendFileSync(path.join(dir, "a.js"), "x\n");
  const [r] = await turn(svc, dir);
  svc.putComment(U, r.item.id, "c_aaaaaa", { side: "file", file: "a.js", text: "Почему?", version: 0 });
  await assert.rejects(svc.send(U, r.item.id, { key: "key-aaaa", revision: 1 }), (e) => e.status === 429);
  assert.equal(svc.list(U).items[0].drafts, 1);
  fail = false;
  const ok = await svc.send(U, r.item.id, { key: "key-aaaa", revision: 1 });
  assert.equal(ok.already, false);
  assert.equal(posts.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("N-10/N-39: чат удалён — «Чат удалён» вне счётчиков; «Убрать» удаляет черновики", async () => {
  const dir = repo();
  const { svc } = service();
  appendFileSync(path.join(dir, "a.js"), "x\n");
  const [r] = await turn(svc, dir);
  svc.putComment(U, r.item.id, "c_bbbbbb", { side: "general", text: "черновик", version: 0 });
  svc.chatDeleted("ses_1");
  const s = svc.list(U).items[0];
  assert.equal(s.status, "chat-deleted");
  assert.equal(s.needsYou, false);
  const d = await svc.dismiss(U, r.item.id, { key: "dis-key-1" });
  assert.equal(d.drafts, 1);
  assert.equal(svc.list(U).items.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("P-20/N-17: папка без git — ревью по частям хода, фрагмент Claude без номеров", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "teleharness-rv-nogit-"));
  const { svc } = service();
  const parts = [
    { type: "tool", tool: "edit", state: { status: "completed", input: { file_path: path.join(dir, "x.js"), old_string: "a = 1", new_string: "a = 2" } } },
    { type: "tool", tool: "write", state: { status: "completed", input: { file_path: path.join(dir, "y.md"), content: "# y\n" } } },
  ];
  const [r] = await svc.turnEnd({ users: [U], sid: "ses_n", dir, untrusted: true, parts, meta: {} });
  assert.equal(r.item.mode, "turns");
  assert.equal(r.item.modeReason, "no-git");
  const d = await svc.diff(U, r.item.id, { file: "x.js", untrusted: true });
  assert.equal(d.mode, "turns");
  assert.equal(d.partial, true);
  assert.equal(d.hunks[0].lines.find((l) => l.t === "+").text, "a = 2");
  // ход без правок — «Агент правит» возвращается в очередь
  svc.putComment(U, r.item.id, "c_cccccc", { side: "new", file: "x.js", quote: ["a = 2"], text: "почему 2?", version: 0 });
  await svc.send(U, r.item.id, { key: "key-cccc", revision: 1 });
  assert.equal(svc.list(U).items[0].status, "returned");
  await svc.turnEnd({ users: [U], sid: "ses_n", dir, untrusted: true, parts: [], meta: {} });
  assert.equal(svc.list(U).items[0].status, "waiting");
  rmSync(dir, { recursive: true, force: true });
});

test("кр. 13/N-25/N-26: план — одно решение (двойной тап, вторая вкладка), переживает рестарт", async () => {
  const { svc, data } = service();
  const p1 = svc.createPlan(U, { sid: "ses_p", engine: "claude", model: "claude-opus-5-5", text: "1. Сделать X" });
  const p2 = svc.createPlan(U, { sid: "ses_p", engine: "claude", model: "claude-opus-5-5", text: "1. Сделать Y" });
  assert.equal(svc.plan(U, p1.id).state, "superseded", "N-14: старый — «Заменён планом 2»");
  let runs = 0;
  const run = async () => { runs += 1; return { ok: true, engine: "codex", model: "gpt-6.1-sol" }; };
  // рестарт: новое хранилище на тех же файлах
  const svc2 = new ReviewService({ store: new ReviewStore({ dir: path.join(data, "review"), log: () => {} }), objectsRoot: path.join(data, "o"), tmpDir: path.join(data, "t") });
  const [a, b] = await Promise.all([svc2.decide(U, p2.id, { action: "approve", key: "tap-key-1" }, run), svc2.decide(U, p2.id, { action: "approve", key: "tap-key-1" }, run)]);
  assert.equal(runs, 1);
  assert.equal(a.already !== b.already, true);
  await assert.rejects(svc2.decide(U, p2.id, { action: "approve", key: "tab-key-2" }, run), (e) => e.status === 409 && e.extra.state === "approved");
  assert.equal(svc2.plan(U, p2.id).execEngine, "codex", "N-27: план выполнил другой движок");
  await assert.rejects(svc2.decide("other", p2.id, { action: "reject", key: "x-key-1" }), (e) => e instanceof ReviewError && e.status === 404);
  const empty = svc2.createPlan(U, { sid: "ses_p", text: "" });
  assert.equal(empty.state, "failed", "N-24: «План не получен»");
});

test("N-23: план-ход изменил файлы — нарушение для карточки плана", async () => {
  const dir = repo();
  const { svc } = service();
  await svc.turnStart({ users: [U], sid: "ses_1", dir, untrusted: false });
  appendFileSync(path.join(dir, "a.js"), "plan edit\n");
  const [r] = await turn(svc, dir, { planTurn: true });
  assert.deepEqual(r.planViolation.map((f) => f.path), ["a.js"]);
  rmSync(dir, { recursive: true, force: true });
});

test("маршруты: чужой и выдуманный id — одинаковый 404 «Ревью недоступно»; список — только свои; принять через API чужого — 404", async () => {
  const { reviewRoutes } = await import("../routes/review.js");
  const dir = repo();
  const { svc } = service();
  appendFileSync(path.join(dir, "a.js"), "x\n");
  const [r] = await svc.turnEnd({ users: ["tenantA"], sid: "ses_t", dir, untrusted: true, meta: { title: "Секретный чат" } });
  const sent = [];
  const table = reviewRoutes({ sendJson: (res, status, body) => sent.push({ status, body }), readJsonBody: async (req) => req.body, reviews: svc, untrusted: () => true, planRun: async () => ({ ok: true }) });
  const call = async (method, p, user, body) => {
    const route = table.find((x) => (Array.isArray(x.method) ? x.method.includes(method) : x.method === method) && (typeof x.path === "string" ? x.path === p : x.path.test(p)));
    const u = new URL("http://x" + p);
    const match = typeof route.path === "string" ? null : u.pathname.match(route.path);
    await route.handler({ req: { method, body }, res: {}, url: u, user: { id: user }, admin: user === "admin1", match });
    return sent.at(-1);
  };
  const own = await call("GET", `/teleharness/api/review/${r.item.id}`, "tenantA");
  assert.equal(own.status, 200);
  assert.equal(own.body.title, "Секретный чат");
  const foreign = await call("GET", `/teleharness/api/review/${r.item.id}`, "tenantB");
  const fake = await call("GET", "/teleharness/api/review/rv_ZZZZZZZZZZZZ", "tenantB");
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, fake.body);
  assert.ok(!JSON.stringify(foreign.body).includes("Секрет"));
  assert.equal((await call("POST", `/teleharness/api/review/${r.item.id}/accept`, "admin1", { key: "kkkkkkk", revision: 1 })).status, 404);
  assert.equal((await call("GET", "/teleharness/api/review", "admin1")).body.items.length, 0);
  assert.equal((await call("GET", "/teleharness/api/review", "tenantA")).body.items.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("BUG (dogfood 20.1): поздний ExitPlanMode после конца хода (фоновый субагент) заменяет план из ответа; после решения — нет", async () => {
  const { svc } = service();
  const p = svc.createPlan(U, { sid: "ses_bg", text: "Запустил поиск. Жду результатов...", source: "answer" });
  const up = svc.planFromTool(U, "ses_bg", "# План\n1. Добавить sub");
  assert.equal(up.id, p.id);
  assert.equal(svc.plan(U, p.id).text, "# План\n1. Добавить sub");
  assert.equal(svc.plan(U, p.id).source, "tool");
  assert.equal(svc.planFromTool(U, "ses_bg", "другой"), null, "план от инструмента не перетирается");
  const q = svc.createPlan(U, { sid: "ses_bg2", text: "ответ", source: "answer" });
  await svc.decide(U, q.id, { action: "reject", key: "rej-key-1" });
  assert.equal(svc.planFromTool(U, "ses_bg2", "поздно"), null, "после решения текст не меняется");
});
