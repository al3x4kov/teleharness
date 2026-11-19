// FEAT-18.8 «Изменения хода и git» (design/mockups-v2/changes-git.html, кадры 1–9):
// строка «Изменения» под ответом, лист «Изменения хода», DiffView (перенос, свёрнутые
// куски, «Сейчас vs коммит» → GET /git/diff, большой файл), экран Git (статус, галочки
// по настройке, коммит, «Предложить сообщение», отправка только у admin, ошибки,
// «Папка не под git»), Настройки → Git (GET/PUT /me/git), «⋯ → Git» в меню чата.
// API — контракт design.md «API», замокан installFetch.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    DiffView: "src/components/git/DiffView.jsx",
    GitView: "src/components/views/GitView.jsx",
    GitSection: "src/components/git/GitSection.jsx",
    menuItems: "src/components/ChatMenu.jsx#menuItems",
    withGitPath: "src/components/git/Changes.jsx#withGitPath",
    pushErrorView: "src/lib/git-client.js#pushErrorView",
    resolveGitRoot: "src/lib/git-client.js#resolveGitRoot",
    gitRootSignal: "src/lib/git-client.js#gitRoot",
    gitRepoSignal: "src/lib/git-client.js#gitRepo",
    lineDiff: "src/lib/diff.js#lineDiff",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.busyMap.value = {};
  ui.store.me.value = null;
  installFetch();
});

const SID = "ses_git";
const DIR = "C:\\work\\shop-api";
const NOW = Date.now();
const SESSION = { id: SID, title: "Миграция индекса заказов", directory: DIR, time: { created: NOW, updated: NOW }, teleharness: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: null, prompted: true } };
const tool = (id, name, input, status = "completed") => ({ id, type: "tool", tool: name, callID: "c_" + id, state: { status, input, output: status === "completed" ? "ok" : "", ...(status === "error" ? { error: "boom" } : {}) } });
const user = (id, text, at) => ({ info: { id, role: "user", sessionID: SID, time: { created: NOW + at } }, parts: [{ id: "p_" + id, type: "text", text }] });
const asst = (id, parent, at, parts) => ({
  info: { id, role: "assistant", sessionID: SID, parentID: parent, providerID: "anthropic", modelID: "claude-opus-5-5", time: { created: NOW + at, completed: NOW + at + 1 } },
  parts,
});
const HISTORY = [
  user("u1", "Прочитай README", 0),
  asst("a1", "u1", 10, [tool("r1", "read", { file_path: DIR + "\\README.md" }), { id: "t1", type: "text", text: "Прочитал." }]),
  user("u2", "Добавь индекс и поправь тест", 20),
  asst("a2", "u2", 30, [
    tool("e1", "edit", { file_path: DIR + "\\db\\orders.sql", old_string: "create table orders;\n", new_string: "create table orders;\ncreate index idx on orders(customer_id);\n" }),
    tool("e2", "edit", { file_path: DIR + "\\src\\orders.test.ts", old_string: "a\nb\nc\n", new_string: "a\nB\nc\n" }),
    tool("w1", "write", { file_path: DIR + "\\CHANGELOG.md", content: "# Changes\n- index\n" }),
    tool("e3", "edit", { file_path: DIR + "\\nope.txt", old_string: "x", new_string: "y" }, "error"),
    { id: "t2", type: "text", text: "Готово: индекс добавлен." },
  ]),
];
const STATUS = {
  repo: true, root: "C:/work/shop-api", branch: "main", detached: false, upstream: "origin/main", ahead: 2, behind: 0,
  lastCommit: { hash: "abc1234def", subject: "Add order index", at: new Date(NOW - 2 * 3600_000).toISOString() },
  files: [
    { path: "db/orders.sql", status: "M", staged: false, additions: 12, deletions: 2 },
    { path: "src/orders.test.ts", status: "M", staged: false, additions: 9, deletions: 4 },
    { path: "scratch.md", status: "?", staged: false, additions: 40, deletions: 0 },
  ],
  pushAllowed: true,
};
const PATCH = ["diff --git a/db/orders.sql b/db/orders.sql", "--- a/db/orders.sql", "+++ b/db/orders.sql", "@@ -1,2 +1,3 @@", " create table orders;", "+create index idx on orders(customer_id);", " -- end"].join("\n");

function chatRoutes({ status = STATUS } = {}) {
  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => HISTORY },
    { method: "GET", path: "/teleharness/api/git/status", reply: () => status },
    { method: "GET", path: "/teleharness/api/git/diff", reply: (c) => ({ file: c.query.file, patch: PATCH, additions: 1, deletions: 0, binary: false, truncated: false }) },
  ]);
}
async function openChat(opts) {
  chatRoutes(opts);
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  ui.store.sessions.value = [SESSION];
  const v = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(v.root, ".msg").length >= 4);
  return v.root;
}

// ---- кадр 1: строка ----------------------------------------------------------
test("кадр 1: строка «Изменения · 3 файла · +a −d» только под ходом с правками; ошибка инструмента не считается", async () => {
  const root = await openChat();
  const rows = await t$.waitFor(() => ($$(root, ".chg").length ? $$(root, ".chg") : null));
  assert.equal(rows.length, 1, "ход, который только читал, строки не получил");
  const row = rows[0];
  assert.match(row.textContent, /Изменения · 3 файла/);
  assert.match(row.textContent, /orders\.sql, orders\.test\.ts, CHANGELOG\.md/);
  assert.doesNotMatch(row.textContent, /nope\.txt/, "упавшая правка не в счёт");
  // +1 (sql) +1 (test) +2 (changelog) = +4, −1
  assert.equal($(row, ".dnum .p").textContent, "+4");
  assert.equal($(row, ".dnum .m").textContent, "−1", "минус — настоящий знак «−»");
  assert.ok(row.closest(".msg"), "строка стоит под ответом");
});

// ---- кадр 2: лист --------------------------------------------------------------
test("кадр 2: лист «Изменения хода» — буква статуса + слово, путь, примечание, «Git проекта» (папка под git) и «Отменить ход»", async () => {
  const root = await openChat();
  const row = await t$.waitFor(() => $(root, ".chg"));
  t$.click(row);
  const sheet = await t$.waitFor(() => $(document.body, ".chg-sheet"));
  assert.match(document.body.textContent, /Изменения хода/);
  assert.match($(sheet, ".sub").textContent, /3 файла · \+4 −1 · что изменил этот ход/);
  const files = $$(sheet, ".frow");
  assert.equal(files.length, 3);
  assert.equal($(files[0], ".st").textContent, "M");
  assert.match(files[0].textContent, /orders\.sql/);
  assert.match($(files[0], ".fn-sub").textContent, /^db · изменён$/);
  assert.equal($(files[2], ".st").textContent, "A");
  assert.match($(files[2], ".fn-sub").textContent, /корень проекта · новый/);
  assert.match(sheet.textContent, /Позже файл мог измениться ещё раз — дифф показывает именно этот ход\./);
  await t$.waitFor(() => byText(sheet, "button", "Git проекта"));
  assert.ok(fetchCalls.some((c) => c.path === "/teleharness/api/git/status" && c.query.sid === SID), "git-статус папки чата спрошен по sid");
  assert.ok(byText(sheet, "button", "Отменить ход"), "отмена хода рядом — это последний ход");
});

test("кадр 2: папка не под git — «Git проекта» в листе нет, в диффе нет переключателя", async () => {
  const root = await openChat({ status: { repo: false } });
  t$.click(await t$.waitFor(() => $(root, ".chg")));
  const sheet = await t$.waitFor(() => $(document.body, ".chg-sheet"));
  await t$.waitFor(() => fetchCalls.some((c) => c.path === "/teleharness/api/git/status"));
  await t$.flush();
  assert.equal(byText(sheet, "button", "Git проекта"), null);
  t$.click($$(sheet, ".frow")[0]);
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  assert.equal($(dv, ".dseg"), null);
});

// ---- кадр 3: дифф ------------------------------------------------------------
test("кадр 3: дифф файла — знак в своей колонке, «1 из 3 ›», «Сейчас vs коммит» зовёт GET /git/diff с путём от корня репозитория", async () => {
  const root = await openChat();
  t$.click(await t$.waitFor(() => $(root, ".chg")));
  const sheet = await t$.waitFor(() => $(document.body, ".chg-sheet"));
  await t$.waitFor(() => byText(sheet, "button", "Git проекта"));
  t$.click($$(sheet, ".frow")[1]);
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  assert.equal($(dv, ".dv-top .tt b").textContent, "orders.test.ts");
  const del = $(dv, ".ln.del");
  const add = $(dv, ".ln.add");
  assert.equal($(del, ".s").textContent, "−");
  assert.equal($(del, ".c").textContent, "b");
  assert.equal($(add, ".s").textContent, "+");
  assert.equal($(add, ".c").textContent, "B");
  assert.match(dv.textContent, /Фрагмент правки/, "Claude Edit без номеров строк помечен");
  const next = byText(dv, "button", "из 3");
  assert.match(next.textContent, /2 из 3 ›/);
  t$.click(next);
  assert.equal($(dv, ".dv-top .tt b").textContent, "CHANGELOG.md");
  t$.click(next);
  assert.equal($(dv, ".dv-top .tt b").textContent, "orders.sql");
  const seg = $(dv, ".dseg");
  assert.ok(byText(seg, "button", "Этот ход").classList.contains("on"));
  t$.click(byText(seg, "button", "Сейчас vs коммит"));
  await t$.waitFor(() => $(dv, ".ln.add") && /create index idx/.test($(dv, ".ln.add").textContent));
  const call = fetchCalls.find((c) => c.path === "/teleharness/api/git/diff");
  assert.equal(call.query.sid, SID);
  assert.equal(call.query.file, "db/orders.sql", "путь от корня репозитория, прямые слэши");
  assert.equal(byText(seg, "button", "Сейчас vs коммит").getAttribute("aria-pressed"), "true");
  assert.equal($(dv, ".ln.add .n").textContent, "2", "у git-диффа настоящие номера строк");
});

test("DiffView: неизменённые куски свёрнуты («▾ N строк без изменений»), тап разворачивает; строки переносятся (pre-wrap в CSS-классе .ln)", async () => {
  const a = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const b = a.slice();
  b[2] = "LINE 3";
  b[30] = "LINE 31 " + "очень длинная строка ".repeat(20);
  const d = ui.lineDiff(a.join("\n"), b.join("\n"));
  const files = [{ path: "src/a.js", name: "a.js", dir: "src", status: "M", hunks: d.hunks, additions: d.additions, deletions: d.deletions }];
  const v = t$.mount(ui.DiffView, { files, onClose() {} });
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  const gap = byText(dv, "button.gap", "без изменений");
  assert.match(gap.textContent, /▾ 21 строка без изменений/);
  const before = $$(dv, ".ln").length;
  t$.click(gap);
  assert.equal($$(dv, ".ln").length, before + 21);
  assert.equal(byText(dv, "button.gap", "без изменений"), null);
  assert.equal($(dv, ".dseg"), null, "без git — переключателя нет");
  assert.equal(byText(dv, "button", "из 1"), null, "один файл — без «1 из 1»");
  v.unmount();
});

test("кадр 7: большой файл — первые 400 строк и «Показать всё» / «Скачать патч»", async () => {
  const lines = Array.from({ length: 900 }, (_, i) => ({ t: "+", text: `x${i}`, o: null, n: i + 1 }));
  const files = [{ path: "dist/bundle.js", name: "bundle.js", dir: "dist", status: "M", hunks: [{ header: "@@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 900, gap: 0, gapLines: null, lines }], additions: 900, deletions: 0 }];
  t$.mount(ui.DiffView, { files, onClose() {} });
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  assert.match(dv.textContent, /Файл большой \(900 строк изменений\)\. Показаны первые 400\./);
  assert.equal($$(dv, ".ln").length, 400);
  assert.ok(byText(dv, "button", "Скачать патч"));
  t$.click(byText(dv, "button", "Показать всё"));
  assert.equal($$(dv, ".ln").length, 900);
});

test("withGitPath: путь хода → путь от корня репозитория (абсолютный, относительный к папке чата, вне репозитория)", () => {
  const files = [{ path: "db/orders.sql", abs: "C:\\work\\shop-api\\db\\orders.sql" }, { path: "rel.txt", abs: "rel.txt" }, { path: "x", abs: "D:\\other\\x" }];
  const out = ui.withGitPath(files, "C:/work/shop-api", "C:\\work\\shop-api\\sub");
  assert.equal(out[0].gitPath, "db/orders.sql");
  assert.equal(out[1].gitPath, "sub/rel.txt");
  assert.equal(out[2].gitPath, undefined);
});

// ---- кадры 4–6: экран Git ---------------------------------------------------------
function gitRoutes({ status = STATUS, settings = { preselect: "modified" }, suggest = () => ({ message: "Add composite index\n\nBody" }), commit = (c) => ({ hash: "fff0001", subject: c.body.message.split("\n")[0], files: c.body.files }), push = () => ({ ok: true, pushed: 2 }) } = {}) {
  let st = status;
  installFetch([
    { method: "GET", path: "/teleharness/api/git/status", reply: () => st },
    { method: "GET", path: "/teleharness/api/me/git", reply: () => ({ authorName: "admin", authorEmail: "admin@teleharness.local", messageLang: "ui", pushAllowed: false, ...settings }) },
    { method: "POST", path: "/teleharness/api/git/suggest-message", reply: suggest },
    { method: "POST", path: "/teleharness/api/git/commit", reply: (c) => {
      const r = commit(c);
      if (!r?.status) st = { ...st, ahead: st.ahead + 1, files: st.files.filter((f) => !c.body.files.includes(f.path)) };
      return r;
    } },
    { method: "POST", path: "/teleharness/api/git/push", reply: push },
    { method: "GET", path: "/teleharness/api/git/diff", reply: (c) => ({ file: c.query.file, patch: PATCH, additions: 1, deletions: 0, binary: false, truncated: false }) },
  ]);
}
async function openGit({ role = "admin", props = { id: SID }, ...opts } = {}) {
  gitRoutes(opts);
  ui.store.me.value = { id: role, name: role, role };
  ui.store.sessions.value = [SESSION];
  const v = t$.mount(ui.GitView, props);
  await t$.waitFor(() => !$(v.root, '[aria-label="Загружаю состояние git…"]'));
  return v.root;
}
const boxes = (root) => $$(root, '.git-file [role="checkbox"]');

test("кадр 4: ветка, ↑2 к origin, последний коммит, файлы с галочками — изменённые отмечены, новые (не в git) нет", async () => {
  const root = await openGit();
  await t$.waitFor(() => boxes(root).length === 3 && boxes(root)[0].getAttribute("aria-checked") === "true");
  const br = $(root, ".br");
  assert.match(br.textContent, /^\s*main/);
  assert.ok($(br, ".bname svg.branch-ic"), "TASK-18.13 D9: the branch glyph is an SVG");
  assert.match(br.textContent, /↑2 к origin/);
  assert.match(br.textContent, /3 изменено/);
  assert.match(root.textContent, /Последний коммит: «Add order index» · 2 ч назад/);
  assert.deepEqual(boxes(root).map((b) => b.getAttribute("aria-checked")), ["true", "true", "false"]);
  assert.match($$(root, ".git-file")[2].textContent, /scratch\.md.*корень проекта · не в git/);
  assert.equal($$(root, ".git-file .st")[2].textContent, "?");
  const st = fetchCalls.find((c) => c.path === "/teleharness/api/git/status");
  assert.equal(st.query.sid, SID);
});

test("кадр 4: «Коммит · N файлов» неактивна без сообщения; коммит шлёт ровно отмеченные файлы и сообщение, затем тост и обновление", async () => {
  const root = await openGit();
  await t$.waitFor(() => boxes(root)[0]?.getAttribute("aria-checked") === "true");
  const btn = () => byText(root, "button", "Коммит ·");
  assert.match(btn().textContent, /Коммит · 2 файла/);
  assert.equal(btn().disabled, true, "без сообщения — неактивна");
  t$.click(boxes(root)[1]);
  assert.match(btn().textContent, /Коммит · 1 файл$/);
  t$.typeInto($(root, "textarea.git-msg"), "Add composite index on orders\n\nDetails");
  assert.equal(btn().disabled, false);
  const before = fetchCalls.filter((c) => c.path === "/teleharness/api/git/status").length;
  t$.click(btn());
  const toast = await t$.waitFor(() => $(root, ".git-toast"));
  assert.match(toast.textContent, /^Коммит «Add composite index on o…» создан · 1 файл$/);
  const call = fetchCalls.find((c) => c.path === "/teleharness/api/git/commit");
  assert.deepEqual(call.body, { files: ["db/orders.sql"], message: "Add composite index on orders\n\nDetails" });
  assert.equal(call.query.sid, SID);
  await t$.waitFor(() => fetchCalls.filter((c) => c.path === "/teleharness/api/git/status").length > before);
  await t$.waitFor(() => boxes(root).length === 2);
  assert.equal($(root, "textarea.git-msg").value, "", "сообщение очищено");
});

test("кадр 4: «✦ Предложить сообщение» — POST suggest-message {files, sid}, загрузка, текст в поле; ошибка — понятной строкой", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const root = await openGit({ suggest: async () => { await gate; return { message: "Add composite index" }; } });
  await t$.waitFor(() => boxes(root)[0]?.getAttribute("aria-checked") === "true");
  const sb = byText(root, "button", "Предложить сообщение");
  t$.click(sb);
  await t$.waitFor(() => sb.getAttribute("aria-busy") === "true");
  assert.match(root.textContent, /Модель чата пишет сообщение…/);
  release();
  await t$.waitFor(() => $(root, "textarea.git-msg").value === "Add composite index");
  const call = fetchCalls.find((c) => c.path === "/teleharness/api/git/suggest-message");
  assert.deepEqual(call.body, { files: ["db/orders.sql", "src/orders.test.ts"], lang: "ru", sid: SID });
  t$.cleanup();

  const root2 = await openGit({ suggest: () => ({ status: 502, body: { error: "Модель не ответила за 90 с" } }) });
  await t$.waitFor(() => boxes(root2)[0]?.getAttribute("aria-checked") === "true");
  t$.click(byText(root2, "button", "Предложить сообщение"));
  const err = await t$.waitFor(() => $(root2, ".git-err"));
  assert.equal(err.textContent, "Модель не ответила за 90 с", "a 502 sentence is shown as is (TASK-18.13 D6)");
});

test("кадр 4: «Отправить ↑2» у admin при pushAllowed и upstream; ошибки отправки — карточки по kind (кадр 6)", async () => {
  const root = await openGit({ push: () => ({ status: 502, body: { error: "auth failed", kind: "auth" } }) });
  const pb = await t$.waitFor(() => byText(root, "button", "Отправить ↑2"));
  assert.match(root.textContent, /Отправка/);
  assert.match(root.textContent, /Отправка в origin\/main/);
  assert.doesNotMatch(root.textContent, /доступны только администратору/);
  t$.click(pb);
  const card = await t$.waitFor(() => $(root, '.gcard.warn[data-kind="auth"]'));
  assert.match(card.textContent, /Отправка не прошла/);
  assert.match(card.textContent, /Сервер не может войти в удалённый репозиторий/);
  t$.cleanup();

  const root2 = await openGit({ push: () => ({ status: 409, body: { error: "rejected", kind: "rejected" } }) });
  t$.click(await t$.waitFor(() => byText(root2, "button", "Отправить ↑2")));
  const card2 = await t$.waitFor(() => $(root2, '.gcard.warn[data-kind="rejected"]'));
  assert.match(card2.textContent, /Отправка отклонена: в origin есть новые коммиты/);
  assert.match(card2.textContent, /подтяни изменения и реши конфликты/);
  t$.cleanup();

  const root3 = await openGit();
  t$.click(await t$.waitFor(() => byText(root3, "button", "Отправить ↑2")));
  const toast = await t$.waitFor(() => $(root3, ".git-toast"));
  assert.match(toast.textContent, /Отправлено в origin · ↑2/);
  assert.equal(fetchCalls.find((c) => c.path === "/teleharness/api/git/push").query.sid, SID);
});

test("«Отправить» скрыта: admin без pushAllowed, без upstream, без ↑", async () => {
  for (const status of [{ ...STATUS, pushAllowed: false }, { ...STATUS, upstream: null }, { ...STATUS, ahead: 0 }]) {
    const root = await openGit({ status });
    await t$.waitFor(() => boxes(root).length === 3);
    assert.equal(byText(root, "button", "Отправить"), null);
    t$.cleanup();
  }
});

test("кадр 5: обычный пользователь — без отправки, с примечанием; коммит доступен", async () => {
  const root = await openGit({ role: "user", status: { ...STATUS, pushAllowed: false, files: [STATUS.files[0]] } });
  await t$.waitFor(() => boxes(root).length === 1);
  // the ticks follow /me/git, which may answer after the status
  await t$.waitFor(() => /Коммит · 1 файл/.test(byText(root, "button", "Коммит ·")?.textContent ?? ""));
  assert.equal(byText(root, "button", "Отправить"), null);
  assert.match(root.textContent, /Отправка в удалённый репозиторий и смена веток доступны только администратору\./);
  // предвыбор файлов приходит с настройками отдельным запросом — под нагрузкой позже чекбоксов (флейк полного прогона 2026-11-19)
  await t$.waitFor(() => /Коммит · 1 файл/.test(byText(root, "button", "Коммит ·")?.textContent ?? ""));
  assert.match(byText(root, "button", "Коммит ·").textContent, /Коммит · 1 файл/);
});

test("кадр 6: «Папка не под git» — действий коммита нет; «Изменений нет»", async () => {
  const root = await openGit({ status: { repo: false } });
  await t$.waitFor(() => /Папка не под git/.test(root.textContent));
  assert.match(root.textContent, /Здесь нет репозитория\. Изменения ходов по-прежнему видны в чате\./);
  assert.equal($(root, "textarea"), null);
  assert.equal(byText(root, "button", "Коммит"), null);
  t$.cleanup();

  const root2 = await openGit({ status: { ...STATUS, files: [] } });
  await t$.waitFor(() => /Изменений нет/.test(root2.textContent));
  assert.match(root2.textContent, /Рабочая папка совпадает с последним коммитом\./);
  assert.equal($(root2, "textarea"), null);
});

test("настройка «Отмечать изменённые» выключена — ничего не отмечено; проект открывается по ?directory=", async () => {
  const root = await openGit({ settings: { preselect: "none" }, props: { directory: DIR } });
  await t$.waitFor(() => boxes(root).length === 3);
  await t$.flush();
  assert.deepEqual(boxes(root).map((b) => b.getAttribute("aria-checked")), ["false", "false", "false"]);
  assert.match(byText(root, "button", "Коммит ·").textContent, /Коммит · 0 файлов/);
  const st = fetchCalls.find((c) => c.path === "/teleharness/api/git/status");
  assert.equal(st.query.directory, DIR);
  assert.equal(st.query.sid, undefined);
  // the project's chat writes the message
  t$.click(boxes(root)[0]);
  t$.click(byText(root, "button", "Предложить сообщение"));
  await t$.waitFor(() => fetchCalls.some((c) => c.path === "/teleharness/api/git/suggest-message"));
  assert.equal(fetchCalls.find((c) => c.path === "/teleharness/api/git/suggest-message").body.sid, SID);
});

test("экран Git: тап по файлу — дифф «сейчас vs коммит» (GET /git/diff)", async () => {
  const root = await openGit();
  await t$.waitFor(() => boxes(root).length === 3);
  t$.click($(root, ".git-file .frow"));
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  await t$.waitFor(() => $(dv, ".ln.add"));
  assert.equal(fetchCalls.find((c) => c.path === "/teleharness/api/git/diff").query.file, "db/orders.sql");
  assert.equal($(dv, ".dseg"), null, "на экране Git дифф только против коммита");
});

// ---- кадр 9: Настройки → Git ---------------------------------------------------
test("кадр 9: Настройки → Git — GET /me/git, имя/почта, язык, «Отмечать изменённые», у admin — отправка; PUT с телом", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/me/git", reply: () => ({ authorName: "Алексей", authorEmail: "alexey@teleharness.local", messageLang: "ui", preselect: "modified", pushAllowed: false }) },
    { method: "PUT", path: "/teleharness/api/me/git", reply: (c) => ({ ...c.body, pushAllowed: c.body.pushAllowed === true }) },
  ]);
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  const { root } = t$.mount(ui.GitSection, {});
  await t$.waitFor(() => $(root, 'input[type="text"]'));
  assert.equal($(root, 'input[type="text"]').value, "Алексей");
  assert.equal($(root, 'input[type="email"]').value, "alexey@teleharness.local");
  assert.match(root.textContent, /Автор коммитов/);
  assert.match(root.textContent, /«Предложить сообщение» спрашивает модель этого чата/);
  const radios = $$(root, '[role="radio"]');
  assert.deepEqual(radios.map((r) => $(r, ".fn b").textContent), ["На языке интерфейса", "Всегда по-английски"]);
  assert.equal(radios[0].getAttribute("aria-checked"), "true");
  t$.click(radios[1]);
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PUT"));
  assert.deepEqual(fetchCalls.find((c) => c.method === "PUT").body, { authorName: "Алексей", authorEmail: "alexey@teleharness.local", messageLang: "en", preselect: "modified", pushAllowed: false });
  await t$.waitFor(() => $$(root, '[role="radio"]')[1].getAttribute("aria-checked") === "true" && /Сохранено/.test(root.textContent));
  const push = byText(root, '[role="checkbox"]', "Разрешить «Отправить» с этого сервера");
  assert.ok(push);
  t$.click(push);
  await t$.waitFor(() => fetchCalls.filter((c) => c.method === "PUT").length === 2);
  assert.equal(fetchCalls.filter((c) => c.method === "PUT")[1].body.pushAllowed, true);
  await t$.waitFor(() => !push.disabled);
  // name: saved when the field is left
  const name = $(root, 'input[type="text"]');
  t$.typeInto(name, "Алексей К.");
  t$.fire(name, "focusout", {}, FocusEvent); // preact/compat: onBlur → focusout
  await t$.waitFor(() => fetchCalls.filter((c) => c.method === "PUT").length === 3);
  assert.equal(fetchCalls.filter((c) => c.method === "PUT")[2].body.authorName, "Алексей К.");
});

test("кадр 9: у пользователя нет блока отправки и pushAllowed в PUT; ошибка сохранения — текстом и откатом", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/me/git", reply: () => ({ authorName: "anna", authorEmail: "anna@teleharness.local", messageLang: "ui", preselect: "modified", pushAllowed: false }) },
    { method: "PUT", path: "/teleharness/api/me/git", reply: () => ({ status: 500, body: { error: "x" } }) },
  ]);
  ui.store.me.value = { id: "anna", name: "anna", role: "user" };
  const { root } = t$.mount(ui.GitSection, {});
  const opt = await t$.waitFor(() => byText(root, '[role="checkbox"]', "Отмечать изменённые"));
  assert.equal(byText(root, '[role="checkbox"]', "Разрешить"), null);
  assert.doesNotMatch(root.textContent, /Отправка \(только администратор\)/);
  t$.click(opt);
  await t$.waitFor(() => /Не удалось сохранить/.test(root.textContent));
  const put = fetchCalls.find((c) => c.method === "PUT");
  assert.equal(put.body.preselect, "none");
  assert.equal("pushAllowed" in put.body, false);
  assert.equal(byText(root, '[role="checkbox"]', "Отмечать изменённые").getAttribute("aria-checked"), "true", "откат");
});

// ---- меню чата ---------------------------------------------------------------
test("«⋯ → Git»: пункт есть только с обработчиком, перед «Удалить»", () => {
  assert.deepEqual(ui.menuItems({}).map((i) => i.id), ["pin", "rename", "delete"]);
  const ids = ui.menuItems({ git: true, relay: true }).map((i) => i.id);
  assert.deepEqual(ids, ["pin", "rename", "relay", "git", "delete"]);
  assert.equal(ui.menuItems({ git: true }).find((i) => i.id === "git").label, "Git");
  assert.equal(ui.menuItems({ git: true, offline: true }).find((i) => i.id === "git").disabled, true);
});

test("меню чата в ChatView: «Git» ведёт на #/git/<sid>", async () => {
  const root = await openChat();
  t$.click($(root, ".chat-menu-btn"));
  const item = await t$.waitFor(() => $(document.body, '.chat-menu [data-act="git"]'));
  t$.click(item);
  assert.equal(location.hash, `#/git/${SID}`);
  location.hash = "";
});

// ---- TASK-18.13: fixes after the full git dogfood -----------------------------
const bigPatch = (n = 450) => [
  "diff --git a/big.txt b/big.txt", "--- a/big.txt", "+++ b/big.txt", `@@ -1,${n} +1,${n} @@`,
  ...Array.from({ length: n }, (_, i) => `-old ${i}`), ...Array.from({ length: n }, (_, i) => `+new ${i}`),
];
test("D2: «Показать всё» в «Сейчас vs коммит» — одно нажатие грузит весь дифф и убирает плашку", async () => {
  const full = bigPatch();
  installFetch([
    { method: "GET", path: "/teleharness/api/git/diff", reply: (c) => (c.query.full === "1"
      ? { file: "big.txt", patch: full.join("\n") + "\n", additions: 450, deletions: 450, binary: false, truncated: false }
      : { file: "big.txt", patch: full.slice(0, 400).join("\n") + "\n", additions: 450, deletions: 450, binary: false, truncated: true }) },
  ]);
  const files = [{ path: "big.txt", gitPath: "big.txt", name: "big.txt", dir: "", status: "M", additions: 450, deletions: 450 }];
  t$.mount(ui.DiffView, { files, mode: "git", where: { sid: SID }, onClose() {} });
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  await t$.waitFor(() => $(dv, ".big-note"));
  assert.ok($$(dv, ".ln").length <= 400, "only the first 400 patch lines");
  t$.click(byText(dv, "button", "Показать всё"));
  await t$.waitFor(() => $$(dv, ".ln").length === 900);
  assert.equal($(dv, ".big-note"), null, "the banner is gone after ONE tap");
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/git/diff" && c.query.full === "1").length, 1);
});

test("D4: тенант без абсолютного root — путь хода переводится в путь git через rootRel и папку чата", async () => {
  assert.equal(ui.resolveGitRoot({ rel: "chats/abc" }, "C:\\t\\alice"), "C:/t/alice/chats/abc");
  assert.equal(ui.resolveGitRoot({ rel: "" }, "C:\\t\\alice\\"), "C:/t/alice");
  assert.equal(ui.resolveGitRoot({ rel: ".." }, "C:/t/alice/proj"), "C:/t/alice");
  assert.equal(ui.resolveGitRoot("D:/abs", "C:/x"), "D:/abs");
  assert.equal(ui.resolveGitRoot(null, "C:/x"), null);
  // the repo is the «db» subfolder of the chat's directory (like chats\<id>)
  ui.gitRootSignal.value = {};
  ui.gitRepoSignal.value = {};
  const root = await openChat({ status: { ...STATUS, root: null, rootRel: "db", name: "shop-api" } });
  t$.click(await t$.waitFor(() => $(root, ".chg")));
  const sheet = await t$.waitFor(() => $(document.body, ".chg-sheet"));
  await t$.waitFor(() => byText(sheet, "button", "Git проекта"));
  t$.click($$(sheet, ".frow")[0]);
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  t$.click(byText($(dv, ".dseg"), "button", "Сейчас vs коммит"));
  await t$.waitFor(() => fetchCalls.some((c) => c.path === "/teleharness/api/git/diff"));
  assert.equal(fetchCalls.find((c) => c.path === "/teleharness/api/git/diff").query.file, "orders.sql", "relative to the repo root db/");
  ui.gitRootSignal.value = {};
  ui.gitRepoSignal.value = {};
});

test("D5: карточка ошибки отправки — один заголовок и одно пояснение на каждый kind, без повторов", () => {
  const serverText = { network: "Отправка не прошла: удалённый репозиторий недоступен (сеть). Коммиты остались локально.", "no-upstream": "У ветки нет upstream — отправлять некуда.", unknown: "Отправка не прошла (git: odd). Коммиты остались локально." };
  for (const kind of ["auth", "rejected", "no-upstream", "network", "unknown", "detached"]) {
    const v = ui.pushErrorView({ status: 502, body: { error: serverText[kind] ?? "x", kind, ...(kind === "unknown" ? { detail: "odd" } : {}) } });
    assert.equal(v.text.includes(v.title), false, `${kind}: the title is not repeated in the text`);
    assert.ok((v.text.match(/Коммиты (сохранены|остались)/g) ?? []).length <= 1, `${kind}: «коммиты локально» once — ${v.text}`);
    assert.equal((v.text.match(/Отправка не прошла/g) ?? []).length, 0, `${kind}: ${v.text}`);
    assert.doesNotMatch(v.text, /остались локально/, `${kind}: the server's own tail is not appended`);
  }
  assert.match(ui.pushErrorView({ status: 502, body: { kind: "unknown", detail: "odd" } }).text, /«odd»/);
  assert.equal(ui.pushErrorView({ status: 502, body: { kind: "network", error: serverText.network } }).text, "Удалённый репозиторий недоступен (нет связи с ним). Коммиты сохранены локально — отправьте позже.");
});

test("D6: ошибка «Предложить сообщение» — одна русская фраза без двойного префикса, сырой текст свёрнут", async () => {
  const root = await openGit({ suggest: () => ({ status: 502, body: { error: "Лимит модели этого чата исчерпан — напишите сообщение сами или попробуйте позже.", kind: "limit", detail: "Weekly/Monthly Limit Exhausted." } }) });
  await t$.waitFor(() => boxes(root)[0]?.getAttribute("aria-checked") === "true");
  t$.click(byText(root, "button", "Предложить сообщение"));
  const err = await t$.waitFor(() => $(root, ".git-err"));
  assert.equal($(err, "p").textContent, "Лимит модели этого чата исчерпан — напишите сообщение сами или попробуйте позже.");
  const det = $(err, "details");
  assert.ok(det && !det.open, "the raw text is collapsed");
  assert.match(det.textContent, /Weekly\/Monthly Limit Exhausted/);
  assert.doesNotMatch($(err, "p").textContent, /Не удалось/);
  t$.cleanup();
  // a 400 (nothing changed) keeps the action prefix once
  const root2 = await openGit({ suggest: () => ({ status: 400, body: { error: "в выбранных файлах нет изменений" } }) });
  await t$.waitFor(() => boxes(root2)[0]?.getAttribute("aria-checked") === "true");
  t$.click(byText(root2, "button", "Предложить сообщение"));
  const e2 = await t$.waitFor(() => $(root2, ".git-err"));
  assert.equal(e2.textContent, "Не удалось предложить сообщение: в выбранных файлах нет изменений");
});

test("D7: detached HEAD — шапка «<hash> без ветки (detached HEAD)», ошибка отправки — свой текст", async () => {
  const root = await openGit({ status: { ...STATUS, branch: null, detached: true, upstream: null, ahead: 0 } });
  const br = await t$.waitFor(() => $(root, ".br"));
  assert.match(br.textContent, /abc1234/);
  assert.match(br.textContent, /без ветки \(detached HEAD\)/);
  assert.doesNotMatch(br.textContent, /null|undefined/);
  assert.match(root.textContent, /Не выбрана ветка/);
  const v = ui.pushErrorView({ status: 409, body: { kind: "detached", error: "x" } });
  assert.equal(v.text, "Не выбрана ветка (detached HEAD) — отправлять нечего; переключитесь на ветку через агента.");
  assert.doesNotMatch(v.text, /upstream/);
});

test("D8: карточка «Отправка» не утверждает про доступ — «Отправка в origin/main»", async () => {
  const root = await openGit();
  await t$.waitFor(() => byText(root, "button", "Отправить ↑2"));
  assert.match(root.textContent, /Отправка в origin\/main/);
  assert.doesNotMatch(root.textContent, /доступ настроен/);
});

test("D9: ветка — SVG-иконка, символа ⎇ в интерфейсе нет", async () => {
  const { readFileSync } = await import("node:fs");
  const root = await openGit();
  const bn = await t$.waitFor(() => $(root, ".bname"));
  const svg = $(bn, "svg.branch-ic");
  assert.ok(svg, "inline SVG");
  assert.equal(svg.getAttribute("width"), "1.1em", "sized with the text");
  assert.equal(svg.getAttribute("stroke"), "currentColor", "follows the theme");
  assert.doesNotMatch(root.textContent, /⎇/);
  for (const f of ["src/components/views/GitView.jsx", "src/components/views/ProjectView.jsx"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /⎇/, f);
  }
});

test("D10: подзаголовок экрана Git — название чата, не внутренний id папки; при ошибке — тоже название, не «Git»", async () => {
  const tenantStatus = { ...STATUS, root: null, rootRel: "chats/e1b0a4a63ffe65UCEiKn5wXiHy", name: "alice", pushAllowed: false };
  const root = await openGit({ role: "user", status: tenantStatus });
  await t$.waitFor(() => boxes(root).length === 3);
  assert.equal($(root, ".project-sub").textContent, SESSION.title);
  assert.doesNotMatch(root.textContent, /e1b0a4a63ffe65/);
  t$.cleanup();
  installFetch([
    { method: "GET", path: "/teleharness/api/git/status", reply: () => ({ status: 409, body: { error: "в настройках этого репозитория есть команды" } }) },
    { method: "GET", path: "/teleharness/api/me/git", reply: () => ({ preselect: "modified" }) },
  ]);
  ui.store.me.value = { id: "u", name: "u", role: "user" };
  ui.store.sessions.value = [SESSION];
  const v = t$.mount(ui.GitView, { id: SID });
  await t$.waitFor(() => /Git не загрузился/.test(v.root.textContent));
  assert.equal($(v.root, ".project-sub").textContent, SESSION.title, "error screen: the chat's name, not a second «Git»");
  t$.cleanup();
  // a project: its folder name
  const r3 = await openGit({ props: { directory: DIR } });
  await t$.waitFor(() => boxes(r3).length === 3);
  assert.equal($(r3, ".project-sub").textContent, "shop-api");
});

test("D11: подпись «корень проекта» — без обрезки с начала (только у настоящих путей)", async () => {
  const { readFileSync } = await import("node:fs");
  const root = await openGit();
  await t$.waitFor(() => boxes(root).length === 3);
  const subs = $$(root, ".git-file .fn-sub");
  assert.equal(subs[0].classList.contains("is-label"), false, "db — a path: cut from the start");
  assert.equal(subs[2].classList.contains("is-label"), true, "root label: not a path");
  assert.match(subs[2].textContent, /^корень проекта · не в git$/);
  const css = readFileSync("src/components/git/git.css", "utf8");
  assert.match(css, /\.fn-sub\.is-label\s*\{[^}]*direction:\s*ltr/);
});

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
test("D12: выключенная «Коммит» — контраст ≥ 3:1 в тёмной и светлой теме (без полупрозрачного бренда)", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("src/components/git/git.css", "utf8");
  const rule = /\.gbtn\.pri:disabled\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /opacity:\s*1/);
  assert.match(rule, /background:\s*var\(--input\)/);
  assert.match(rule, /color:\s*var\(--text-2\)/);
  for (const file of ["src/app.css", "src/claude-look.css"]) {
    const app = readFileSync(file, "utf8");
    const v = (block, name) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1];
    const at = app.indexOf(':root[data-theme="light"]');
    for (const [name, block] of [["dark", app.slice(0, at)], ["light", app.slice(at)]]) {
      const c = contrast(v(block, "--text-2"), v(block, "--input"));
      assert.ok(c >= 3, `${file} ${name}: ${c.toFixed(2)}`);
    }
  }
});

test("D12: двоичный файл — «двоичный» вместо «+0»; переименованный — «переименован из …» в списке и в диффе", async () => {
  const status = {
    ...STATUS,
    files: [
      { path: "img/logo.png", status: "M", staged: false, additions: 0, deletions: 0, binary: true },
      { path: "docs.md", status: "R", staged: true, additions: 0, deletions: 0, oldPath: "README.md" },
    ],
  };
  const root = await openGit({ status });
  await t$.waitFor(() => boxes(root).length === 2);
  const rows = $$(root, ".git-file");
  assert.equal($(rows[0], ".dnum").textContent, "двоичный");
  assert.doesNotMatch(rows[0].textContent, /\+0/);
  assert.match($(rows[1], ".fn-sub").textContent, /переименован из README\.md/);
  t$.cleanup();
  installFetch([
    { method: "GET", path: "/teleharness/api/git/diff", reply: (c) => (c.query.file === "docs.md"
      ? { file: "docs.md", oldPath: "README.md", patch: "diff --git a/README.md b/docs.md\nsimilarity index 100%\nrename from README.md\nrename to docs.md\n", additions: 0, deletions: 0, binary: false, truncated: false }
      : { file: "img/logo.png", patch: "diff --git a/img/logo.png b/img/logo.png\nBinary files a/img/logo.png and b/img/logo.png differ\n", additions: 0, deletions: 0, binary: true, truncated: false }) },
  ]);
  const files = status.files.map((f) => ({ ...f, gitPath: f.path, name: f.path.split("/").pop(), dir: f.path.includes("/") ? f.path.split("/")[0] : "" }));
  t$.mount(ui.DiffView, { files, mode: "git", where: { sid: SID }, onClose() {} });
  const dv = await t$.waitFor(() => $(document.body, ".dv"));
  await t$.waitFor(() => /Двоичный файл/.test(dv.textContent));
  assert.equal($(dv, ".dv-top .dnum").textContent, "двоичный");
  t$.click(byText(dv, "button", "из 2"));
  await t$.waitFor(() => $(dv, ".dv-renamed"));
  assert.equal($(dv, ".dv-renamed").textContent, "переименован из README.md");
  await t$.waitFor(() => /Только переименование/.test(dv.textContent));
  assert.doesNotMatch(dv.textContent, /Изменений нет/, "a pure rename is not «Изменений нет»");
});
