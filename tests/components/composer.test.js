// C1 Composer (L2, TASK-14.7): лицо кнопки (микрофон / стрелка / «Стоп» /
// «в очередь»), отправка, лимиты вложений, удержание-для-голоса и выходы из
// диктовки, отсутствие микрофона без SpeechRecognition (не secure context).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ Composer: "src/components/chat/Composer.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  delete globalThis.SpeechRecognition;
  FakeRecognition.last = null;
  installFetch();
});

const ARROW = 'button.send-btn path[d="M12 19V5"]';
const MIC = 'button.send-btn path[d="M19 10v1a7 7 0 0 1-14 0v-1"]';
const sendBtn = (root) => $(root, "button.send-btn");
const ta = (root) => $(root, 'textarea[aria-label="Сообщение"]');

// Заглушка Web Speech API: тест сам «произносит» фразы через say().
class FakeRecognition {
  static last = null;
  constructor() {
    this.started = 0;
    this.aborted = false;
    FakeRecognition.last = this;
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
  say(text, isFinal = true) {
    const res = [{ transcript: text }];
    res.isFinal = isFinal;
    this.onresult?.({ resultIndex: 0, results: [res] });
  }
}
const withVoice = () => {
  globalThis.SpeechRecognition = FakeRecognition;
};

function mountComposer(props = {}) {
  const calls = { send: [], stop: 0 };
  const h = t$.mount(ui.Composer, {
    status: "idle",
    onSend: (text, att) => calls.send.push({ text, att }),
    onStop: () => (calls.stop += 1),
    ...props,
  });
  return { ...h, calls };
}

test("без SpeechRecognition (http, не secure context): пусто → стрелка, микрофона нет", () => {
  const { root } = mountComposer();
  assert.ok(ta(root), "поле ввода с aria-label");
  assert.ok($(root, ARROW), "стрелка");
  assert.equal($(root, MIC), null, "микрофона нет");
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Отправить");
});

test("пусто + голос доступен → микрофон «удерживайте для голоса»", () => {
  withVoice();
  const { root } = mountComposer();
  assert.ok($(root, MIC), "микрофон");
  assert.equal($(root, ARROW), null);
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Отправить — удерживайте для голоса");
  // BUG-269 п.1: тёмный вид микрофона — по классу, а не по подписи (в Teleharness подпись на языке интерфейса)
  assert.ok(sendBtn(root).classList.contains("is-mic"), "класс is-mic в режиме микрофона");
  t$.typeInto(ta(root), "текст");
  assert.equal(sendBtn(root).classList.contains("is-mic"), false, "со стрелкой — без is-mic");
});

test("BUG-269 п.1: в CSS тёмный микрофон задан классом is-mic, без привязки к тексту подписи", () => {
  const css = readFileSync(new URL("../../src/claude-look.css", import.meta.url), "utf8");
  assert.match(css, /\.send-btn\.is-mic\s*\{/);
  assert.doesNotMatch(css, /aria-label\^="Отправить — удерживайте"/);
});

test("ввод текста → стрелка «Отправить»; клик отправляет и чистит поле", () => {
  withVoice();
  const { root, calls } = mountComposer();
  t$.typeInto(ta(root), "  привет  ");
  assert.ok($(root, ARROW), "стрелка вернулась");
  assert.equal($(root, MIC), null);
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Отправить");
  t$.click(sendBtn(root));
  assert.deepEqual(calls.send, [{ text: "привет", att: [] }]);
  assert.equal(ta(root).value, "");
});

test("Enter на десктопе отправляет, Shift+Enter — нет", () => {
  const { root, calls } = mountComposer();
  t$.typeInto(ta(root), "строка");
  t$.key(ta(root), "Enter", { shiftKey: true });
  assert.equal(calls.send.length, 0);
  t$.key(ta(root), "Enter");
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].text, "строка");
});

test("пробелы — не сообщение: клик ничего не отправляет", () => {
  const { root, calls } = mountComposer();
  t$.typeInto(ta(root), "   ");
  t$.click(sendBtn(root));
  assert.equal(calls.send.length, 0);
});

test("busy без текста → «Остановить», клик вызывает onStop", () => {
  withVoice();
  const { root, calls } = mountComposer({ status: "busy" });
  const btn = sendBtn(root);
  assert.equal(btn.getAttribute("aria-label"), "Остановить");
  assert.ok($(root, "button.send-btn rect.stop-square"), "квадрат «Стоп»");
  assert.equal($(root, MIC), null, "в busy микрофона нет");
  t$.click(btn);
  assert.equal(calls.stop, 1);
});

test("busy + текст → подпись по движку (Claude — очередь, opencode — на ближайшем шаге), отправка доступна", () => {
  // ревью 212 (N-1): opencode вплетает досланное в текущий ход — очередь ему не обещаем
  const { root, calls } = mountComposer({ status: "busy" });
  t$.typeInto(ta(root), "досылка");
  const btn = sendBtn(root);
  assert.equal(btn.getAttribute("aria-label"), "Отправить — агент учтёт на ближайшем шаге");
  assert.equal(btn.disabled, false);
  t$.click(btn);
  assert.deepEqual(calls.send, [{ text: "досылка", att: [] }]);
  t$.cleanup();
  ui.store.sessions.value = [{ id: "ses_cl", teleharness: { model: { providerID: "anthropic", modelID: "claude-opus-5-5" } } }];
  ui.store.active.value = { id: "ses_cl" };
  try {
    const m = mountComposer({ status: "busy" });
    t$.typeInto(ta(m.root), "досылка");
    assert.equal(sendBtn(m.root).getAttribute("aria-label"), "Отправить — встанет в очередь за текущим ходом");
  } finally {
    ui.store.sessions.value = [];
    ui.store.active.value = null;
  }
});

test("stopping → кнопка «Останавливаю» заблокирована, скрепка тоже", () => {
  const { root } = mountComposer({ status: "stopping" });
  const btn = sendBtn(root);
  assert.equal(btn.getAttribute("aria-label"), "Останавливаю");
  assert.equal(btn.disabled, true);
  assert.ok($(root, "button.send-btn .spin"));
  assert.equal($(root, 'button[aria-label="Вложить файл"]').disabled, true);
});

// Файлы-подделки: Composer читает только name/size/type; крупные файлы
// отсекаются ДО чтения/загрузки, так что ни FileReader, ни сеть не нужны.
const MB = 1024 * 1024;
const fakeFile = (name, size, type = "application/pdf") => ({ name, size, type });

function pickFiles(root, files) {
  const input = $(root, 'input[type="file"]');
  Object.defineProperty(input, "files", { value: files, configurable: true });
  t$.fire(input, "change");
}

test("лимит MAX_FILES=20: 21-й файл → ошибка «Максимум 20 файлов»", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // таймер ошибки 6 с не держит процесс
  const { root } = mountComposer();
  const files = Array.from({ length: 21 }, (_, i) => fakeFile(`big-${i}.bin`, 101 * MB));
  pickFiles(root, files);
  const err = await t$.waitFor(() => $(root, '.composer-error[role="status"]'));
  assert.match(err.textContent, /Максимум 20 файлов — лишние пропущены/);
  assert.match(err.textContent, /big-0\.bin: больше 100 МБ/);
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/upload").length, 0, "ничего не загружено");
});

test("лимит 500 МБ на сообщение: файлы сверх суммы отсекаются, остальные загружаются", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // таймер ошибки 6 с не держит процесс
  installFetch([{ method: "POST", path: "/teleharness/api/upload", reply: (c) => ({ name: c.query.name, size: 1 }) }]);
  const { root, calls } = mountComposer();
  const files = Array.from({ length: 6 }, (_, i) => fakeFile(`part-${i}.zip`, 90 * MB, "application/zip"));
  pickFiles(root, files);
  const err = await t$.waitFor(() => $(root, ".composer-error"));
  assert.match(err.textContent, /part-5\.zip: превышен общий лимит 500 МБ на сообщение/);
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/upload").length, 5);
  await t$.waitFor(() => !root.querySelector(".is-uploading"));
  // Загруженные файлы уходят ссылками (ref), не base64.
  t$.click(sendBtn(root));
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].att.length, 5);
  assert.match(calls.send[0].att[0].ref, /\.teleharness-uploads\/part-0\.zip/);
});

// R-26 (Г4): неудачная загрузка НЕ убирает чип молча — он остаётся помеченным
// «failed» и не уходит в отправку. Сравниваем булевы значения, не DOM-узлы:
// assert.equal(узел happy-dom, null) при падении сериализует весь DOM и роняет
// процесс (Array buffer allocation failed).
test("ошибка загрузки → «не удалось загрузить», чип помечен и не отправляется (R-26)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // таймер ошибки 6 с не держит процесс
  installFetch([{ method: "POST", path: "/teleharness/api/upload", reply: () => ({ status: 500, body: { error: "x" } }) }]);
  const { root, calls } = mountComposer();
  pickFiles(root, [fakeFile("report.pdf", 10)]);
  const err = await t$.waitFor(() => $(root, ".composer-error"));
  assert.match(err.textContent, /report\.pdf: не удалось загрузить/);
  assert.equal(root.textContent.includes("report.pdf"), true, "чип с именем файла остался");
  t$.typeInto(ta(root), "текст");
  t$.click(sendBtn(root));
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].att.length, 0, "failed-вложение не уходит в отправку");
});

// ---- голос: удержание 350 мс -----------------------------------------------

function holdStart(root, y = 500) {
  t$.fire(sendBtn(root), "pointerdown", { pointerId: 1, clientY: y }, PointerEvent);
}

// Тик mock-таймеров ВНУТРИ act: setState из колбэка таймера иначе уходит в
// микротаск preact (вне act) и до синхронной проверки не отрисовывается.
const tick = (t, ms) => t$.act(() => t.mock.timers.tick(ms));

test("удержание 349 мс — не диктовка (тап), 350 мс — диктовка", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withVoice();
  const { root } = mountComposer();
  holdStart(root);
  tick(t, 349);
  t$.act(() => {});
  assert.equal($(root, ".voice-hint"), null, "349 мс: ещё не слушаем");
  assert.equal(FakeRecognition.last, null);
  tick(t, 1);
  t$.act(() => {});
  assert.ok($(root, '.voice-hint[role="status"]'), "350 мс: подсказка диктовки");
  assert.ok($(root, ".composer-pill.is-voice"));
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Слушаю… отпустите, чтобы вставить");
  assert.ok(sendBtn(root).classList.contains("is-recording"));
  assert.equal(FakeRecognition.last.started, 1);
});

test("короткий тап до порога не включает диктовку", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withVoice();
  const { root } = mountComposer();
  holdStart(root);
  tick(t, 200);
  t$.fire(sendBtn(root), "pointerup", { pointerId: 1 }, PointerEvent);
  tick(t, 1000);
  t$.act(() => {});
  assert.equal($(root, ".voice-hint"), null);
  assert.equal(FakeRecognition.last, null);
});

test("отпускание → распознанный текст остаётся в поле", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withVoice();
  const { root, calls } = mountComposer();
  t$.typeInto(ta(root), "");
  holdStart(root);
  tick(t, 350);
  t$.act(() => FakeRecognition.last.say("привет мир"));
  assert.equal(ta(root).value, "привет мир");
  t$.fire(sendBtn(root), "pointerup", { pointerId: 1 }, PointerEvent);
  t$.click(sendBtn(root)); // клик сразу после отпускания проглатывается
  assert.equal(calls.send.length, 0, "отпускание не отправляет");
  tick(t, 1200);
  t$.act(() => {});
  assert.equal($(root, ".voice-hint"), null, "диктовка завершена");
  assert.equal(ta(root).value, "привет мир");
});

test("смахивание вверх > 70 px → «Отмена…», отпускание откатывает текст", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withVoice();
  const { root } = mountComposer();
  holdStart(root, 500);
  tick(t, 350);
  t$.act(() => FakeRecognition.last.say("лишнее"));
  t$.fire(sendBtn(root), "pointermove", { pointerId: 1, clientY: 420 }, PointerEvent);
  const hint = $(root, ".voice-hint.is-cancel");
  assert.ok(hint, "режим отмены");
  assert.match(hint.textContent, /Отмена…/);
  t$.fire(sendBtn(root), "pointerup", { pointerId: 1 }, PointerEvent);
  assert.equal(ta(root).value, "", "текст до диктовки восстановлен");
  assert.equal(FakeRecognition.last.aborted, true);
  assert.equal($(root, ".voice-hint"), null);
});

test("Escape во время диктовки → отмена без вставки", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withVoice();
  const { root } = mountComposer();
  t$.typeInto(ta(root), "было");
  // С текстом кнопка — стрелка, но удержание всё равно включает голос.
  holdStart(root);
  tick(t, 350);
  t$.act(() => {});
  t$.act(() => FakeRecognition.last.say("стало"));
  assert.equal(ta(root).value, "было стало");
  t$.key(document.body, "Escape");
  assert.equal(ta(root).value, "было");
  assert.equal($(root, ".voice-hint"), null);
});

test("vision guard: картинка + модель без imageInput → предупреждение", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // таймер ошибки 6 с не держит процесс
  ui.store.providerCfg.value = {
    models: [{ id: "blind-1", providerID: "zai", label: "Blind (zai)", imageInput: false }],
  };
  try {
    const { root } = mountComposer({ model: { providerID: "zai", modelID: "blind-1" } });
    // Картинка, которую нельзя декодировать, уходит обычной загрузкой
    // (processImage падает в happy-dom) — для guard важен только mime чипа.
    installFetch([{ method: "POST", path: "/teleharness/api/upload", reply: () => ({ name: "shot.png" }) }]);
    pickFiles(root, [fakeFile("shot.png", 10, "image/png")]);
    const warn = await t$.waitFor(() => $(root, ".composer-vision"));
    assert.match(warn.textContent, /blind-1 не анализирует изображения/);
  } finally {
    ui.store.providerCfg.value = null;
  }
});

// ---- BUG-01.75 (BUG-221): отказ отправки не теряет набранное ----------------

test("BUG-01.75: отправка вернула false → текст снова в поле", async () => {
  const sent = [];
  const { root } = mountComposer({ onSend: (text) => (sent.push(text), Promise.resolve(false)) });
  t$.typeInto(ta(root), "важный длинный текст");
  t$.click(sendBtn(root));
  assert.deepEqual(sent, ["важный длинный текст"]);
  await t$.waitFor(() => ta(root).value === "важный длинный текст");
  assert.equal(sendBtn(root).getAttribute("aria-label"), "Отправить", "можно повторить сразу");
});

test("BUG-01.75: отправка принята (true) → поле остаётся пустым", async () => {
  const { root } = mountComposer({ onSend: () => Promise.resolve(true) });
  t$.typeInto(ta(root), "обычное сообщение");
  t$.click(sendBtn(root));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ta(root).value, "");
});

test("BUG-01.75: после отказа новый набранный текст не затирается возвратом старого", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { root } = mountComposer({ onSend: () => gate });
  t$.typeInto(ta(root), "первый");
  t$.click(sendBtn(root));
  t$.typeInto(ta(root), "второй");
  release(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ta(root).value, "второй");
});

// ---- FEAT-01.88: вставка из буфера (Ctrl/⌘+V) ------------------------------
// clipboardData — подделка с files/getData; файлы — настоящие File (их стримит
// загрузка). Картинку happy-dom не декодирует → она уходит обычной загрузкой,
// имя видно в query.name запроса /teleharness/api/upload.
const clip = ({ files = [], text = "" } = {}) => ({ files, items: null, getData: (t) => (t === "text/plain" ? text : "") });
const paste = (root, data) => t$.fire(ta(root), "paste", {}, Event, { clipboardData: data });
const uploads = () => fetchCalls.filter((c) => c.method === "POST" && c.path === "/teleharness/api/upload");
const echoUpload = () => installFetch([{ method: "POST", path: "/teleharness/api/upload", reply: (c) => ({ name: c.query.name, size: 1 }) }]);
// happy-dom не декодирует картинки (onload/onerror не приходят) — «битая»
// картинка уходит обычной загрузкой, как у скрепки (см. vision guard).
function brokenImages(t) {
  const Orig = globalThis.Image;
  globalThis.Image = class {
    set src(_) {
      queueMicrotask(() => this.onerror?.(new Error("decode")));
    }
  };
  t.after(() => (globalThis.Image = Orig));
}

test("FEAT-01.88: Ctrl+V снимка → чип «Снимок <дата время>.png», текст поля не меняется", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  brokenImages(t);
  echoUpload();
  const { root } = mountComposer();
  t$.typeInto(ta(root), "Вот что вижу");
  const ok = paste(root, clip({ files: [new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" })] }));
  assert.equal(ok, false, "браузерная вставка отменена");
  await t$.waitFor(() => uploads().length === 1, { tries: 3000 });
  assert.match(uploads()[0].query.name, /^Снимок \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.png$/);
  // BUG-269: в чипе имя сокращено посередине, полное — в title
  await t$.waitFor(() => [...root.querySelectorAll(".attach-name")].some((n) => /^Снимок \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.png$/.test(n.getAttribute("title") ?? "")));
  assert.equal(ta(root).value, "Вот что вижу");
});

test("FEAT-01.88: два снимка подряд — разные имена; файл из проводника сохраняет имя", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  brokenImages(t);
  echoUpload();
  const { root } = mountComposer();
  const shot = () => new File([new Uint8Array([1])], "image.png", { type: "image/png" });
  paste(root, clip({ files: [shot(), shot()] }));
  paste(root, clip({ files: [new File(["%PDF"], "ТЗ-портал.pdf", { type: "application/pdf" })], text: "ТЗ-портал.pdf" }));
  // три последовательные загрузки настоящих File: на медленных CI-машинах нужно больше оборотов цикла
  await t$.waitFor(() => uploads().length === 3, { tries: 3000 });
  const names = uploads().map((c) => c.query.name);
  assert.equal(new Set(names).size, 3, "имена различаются: " + names.join(" | "));
  assert.ok(names.includes("ТЗ-портал.pdf"));
  assert.ok(names.some((n) => / \(2\)\.png$/.test(n)), "второй снимок той же секунды — « (2)»");
});

test("FEAT-01.88: обычный текст и текст с картинкой-рендером (Excel) — вставка браузера, чипов нет", () => {
  const { root } = mountComposer();
  assert.equal(paste(root, clip({ text: "привет" })), true, "не отменено — текст вставит браузер");
  assert.equal(paste(root, clip({ text: "A1\tB1", files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })] })), true);
  assert.equal(uploads().length, 0);
  assert.equal($(root, ".attach"), null);
});

test("FEAT-01.88: текст длиннее 5000 символов → файл «Вставка <дата время>.txt», поле не меняется", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  echoUpload();
  const { root } = mountComposer();
  const ok = paste(root, clip({ text: "строка лога\n".repeat(1000) }));
  assert.equal(ok, false);
  await t$.waitFor(() => uploads().length === 1);
  assert.match(uploads()[0].query.name, /^Вставка \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(ta(root).value, "");
});

test("FEAT-01.88: вставка подчиняется лимитам скрепки (файл > 100 МБ — причина строкой)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = mountComposer();
  const big = new File([new Uint8Array(1)], "запись.mov", { type: "video/quicktime" });
  Object.defineProperty(big, "size", { value: 101 * MB });
  paste(root, clip({ files: [big] }));
  const err = await t$.waitFor(() => $(root, ".composer-error"));
  assert.match(err.textContent, /запись\.mov: больше 100\sМБ/);
  assert.equal(uploads().length, 0);
});

test("FEAT-01.88: во время остановки вставка файла ничего не прикрепляет", () => {
  const { root } = mountComposer({ status: "stopping" });
  paste(root, clip({ files: [new File(["x"], "a.pdf", { type: "application/pdf" })] }));
  assert.equal(uploads().length, 0);
  assert.equal($(root, ".attach"), null);
});

test("FEAT-01.88: filesApi — зона перетаскивания добавляет файлы общим путём; папки — причиной", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  echoUpload();
  const api = { current: null };
  const { root } = mountComposer({ filesApi: api });
  assert.equal(api.current.blocked, false);
  t$.act(() => api.current.add([new File(["x"], "июль.xlsx", { type: "application/vnd.ms-excel" })], ["Выгрузки"]));
  await t$.waitFor(() => uploads().length === 1);
  assert.equal(uploads()[0].query.name, "июль.xlsx");
  const err = await t$.waitFor(() => $(root, ".composer-error"));
  assert.match(err.textContent, /Выгрузки: папки не прикрепляются — перетащите файлы из неё/);
  t$.cleanup();
  assert.equal(api.current, null, "после размонтирования доступа нет");
  mountComposer({ filesApi: api, status: "stopping" });
  assert.equal(api.current.blocked, true, "остановка — запрет");
});
