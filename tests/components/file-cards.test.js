// FEAT-05.17 (openspec file-cards-iphone-safari): files in an assistant
// answer are Claude-app style cards — tinted tile, name without extension,
// «Тип · РАСШ», stacked BEFORE the final answer text; tap opens the viewer.
// Reference: screenshots of the Claude iOS app (one file / four files).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ MessageBubble: "src/components/chat/MessageBubble.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.setActiveId(null);
  installFetch();
});

const SID = "ses_fc";
const DIR = "D:\\Chats\\fc";
const NOW = Date.now();
const write = (id, name) => ({
  id, type: "tool", tool: "write", callID: "c" + id,
  state: { status: "completed", input: { filePath: `${DIR}\\${name}`, content: "x" }, output: "", time: { start: NOW, end: NOW } },
});
const answer = (files, text = "Убрал. Из пространства команды выпали семь задач-зеркал.") => ({
  info: { id: "a_fc", role: "assistant", sessionID: SID, time: { created: NOW, completed: NOW } },
  parts: [...files.map((f, i) => write("w" + i, f)), { id: "t_fc", type: "text", text }],
});
const mount = (msg) => {
  ui.store.sessions.value = [{ id: SID, title: "x", directory: DIR }];
  ui.store.setActiveId(SID);
  return t$.mount(ui.MessageBubble, { msg });
};

test("четыре файла — четыре карточки стопкой: имя без расширения, «Тип · РАСШ»", () => {
  const { root } = mount(answer(["crpv-schema.html", "crpv-schema.drawio", "crpv-schema.md", "crpv-model-preview.png"]));
  const cards = $$(root, ".file-cards > .file-card");
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => $(c, ".fc-name").textContent), ["crpv-schema", "crpv-schema", "crpv-schema", "crpv-model-preview"]);
  assert.deepEqual(cards.map((c) => $(c, ".fc-sub").textContent), ["Код · HTML", "Файл · DRAWIO", "Документ · MD", "Изображение · PNG"]);
  assert.deepEqual(cards.map((c) => c.className.replace("file-card ", "")), ["is-code", "is-file", "is-doc", "is-image"]);
  assert.equal($$(cards[3], ".fc-tile img").length, 1, "у картинки миниатюра в плашке");
  assert.equal($$(cards[0], ".fc-tile svg").length, 1, "у кода — иконка");
  assert.equal(cards[0].tagName, "BUTTON");
  assert.match(cards[0].getAttribute("aria-label"), /^Открыть crpv-schema\.html, Код HTML$/);
  assert.equal($$(root, ".msg-files, .result-imgs, .attach").length, 0, "старых чипов и миниатюр нет");
});

test("карточки стоят перед итоговым текстом ответа", () => {
  const { root } = mount(answer(["opencode-obsidian-setup.md"], "Упростил: iCloud и git убраны целиком."));
  const stack = $(root, ".file-cards");
  assert.equal($$(stack, ".file-card").length, 1);
  assert.equal($(stack, ".fc-sub").textContent, "Документ · MD");
  const md = $$(root, ".md").find((el) => /Упростил/.test(el.textContent));
  assert.ok(md, "текст ответа отрисован");
  assert.ok(stack.compareDocumentPosition(md) & 4, "текст идёт ПОСЛЕ карточек");
});

test("тап по карточке открывает FileViewer с этим файлом", async () => {
  const { root } = mount(answer(["notes.md"]));
  t$.click($(root, ".file-card"));
  await t$.flush();
  assert.ok(document.querySelector(".fv, .file-viewer, [role=dialog]"), "открыт просмотр");
  assert.match(document.body.textContent, /notes\.md/);
});

test("ответ без файлов — блока карточек нет", () => {
  const { root } = mount(answer([]));
  assert.equal($(root, ".file-cards"), null);
});

test("UI-ISSUE-02 (BUG-161): картинка-вложение из ссылки (Claude-чат после перезагрузки) — миниатюра через /zai/api/file, не карточка документа", () => {
  const user = {
    info: { id: "u_ref", role: "user", sessionID: SID, time: { created: NOW } },
    parts: [
      { id: "t_q", type: "text", text: "Что на картинке?" },
      { id: "t_ref", type: "text", text: "[Пользователь приложил файл: .zai-uploads/pic 1.png (2048 байт, image/png). Файл лежит в папке сессии и доступен инструментам — прочитай его с диска, если нужен контент.]" },
      { id: "t_doc", type: "text", text: "[Пользователь приложил файл: .zai-uploads/отчёт.xlsx (4096 байт, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet). Файл лежит в папке сессии и доступен инструментам — прочитай его с диска, если нужен контент.]" },
    ],
  };
  const { root } = mount(user);
  const imgs = $$(root, ".msg-files img.attach-img");
  assert.equal(imgs.length, 1, "картинка — миниатюрой");
  const src = new URL(imgs[0].getAttribute("src"), "https://zai.test");
  assert.equal(src.pathname, "/zai/api/file");
  assert.equal(src.searchParams.get("directory"), DIR);
  assert.equal(src.searchParams.get("path"), ".zai-uploads/pic 1.png");
  assert.equal($$(root, ".msg-files .attach .attach-name").map((n) => n.textContent).join(","), "отчёт.xlsx", "xlsx — карточкой документа");
});
