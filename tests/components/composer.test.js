// C1 Composer (L2, TASK-14.7): лицо кнопки (микрофон / стрелка / «Стоп» /
// «в очередь»), отправка, лимиты вложений, удержание-для-голоса и выходы из
// диктовки, отсутствие микрофона без SpeechRecognition (не secure context).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
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
  ui.store.sessions.value = [{ id: "ses_cl", zai: { model: { providerID: "anthropic", modelID: "claude-opus-5-5" } } }];
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
  assert.equal(fetchCalls.filter((c) => c.path === "/zai/api/upload").length, 0, "ничего не загружено");
});

test("лимит 500 МБ на сообщение: файлы сверх суммы отсекаются, остальные загружаются", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // таймер ошибки 6 с не держит процесс
  installFetch([{ method: "POST", path: "/zai/api/upload", reply: (c) => ({ name: c.query.name, size: 1 }) }]);
  const { root, calls } = mountComposer();
  const files = Array.from({ length: 6 }, (_, i) => fakeFile(`part-${i}.zip`, 90 * MB, "application/zip"));
  pickFiles(root, files);
  const err = await t$.waitFor(() => $(root, ".composer-error"));
  assert.match(err.textContent, /part-5\.zip: превышен общий лимит 500 МБ на сообщение/);
  assert.equal(fetchCalls.filter((c) => c.path === "/zai/api/upload").length, 5);
  await t$.waitFor(() => !root.querySelector(".is-uploading"));
  // Загруженные файлы уходят ссылками (ref), не base64.
  t$.click(sendBtn(root));
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].att.length, 5);
  assert.match(calls.send[0].att[0].ref, /\.zai-uploads\/part-0\.zip/);
});

// R-26 (Г4): неудачная загрузка НЕ убирает чип молча — он остаётся помеченным
// «failed» и не уходит в отправку. Сравниваем булевы значения, не DOM-узлы:
// assert.equal(узел happy-dom, null) при падении сериализует весь DOM и роняет
// процесс (Array buffer allocation failed).
test("ошибка загрузки → «не удалось загрузить», чип помечен и не отправляется (R-26)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // таймер ошибки 6 с не держит процесс
  installFetch([{ method: "POST", path: "/zai/api/upload", reply: () => ({ status: 500, body: { error: "x" } }) }]);
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
    installFetch([{ method: "POST", path: "/zai/api/upload", reply: () => ({ name: "shot.png" }) }]);
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
