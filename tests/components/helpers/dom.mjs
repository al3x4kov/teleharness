// DOM-окружение для компонентных тестов (L2, TASK-14.7): happy-dom Window,
// чьи глобалы выставляются в globalThis ДО импорта бандла компонентов
// (store.js читает localStorage, DOMPurify/preact-hooks смотрят на window и
// requestAnimationFrame при загрузке модуля).
//
// Таймеры (setTimeout/setInterval/Date) остаются node-овыми — иначе
// mock.timers из node:test не управлял бы таймерами компонентов.
// Сеть: fetch подменяется фейком (installFetch), EventSource — заглушкой;
// реальных запросов из тестов не бывает.
import { after } from "node:test";
import { Window } from "happy-dom";

let win = null;

// Конструкторы, которые оставляем node-овыми: сетевой стек (Response нужен
// фейковому fetch), URL (createObjectURL), AbortController/AbortSignal
// (store.replySignal → AbortSignal.timeout), а также всё, что happy-dom
// реализует поверх node-шного.
const KEEP_NODE = new Set([
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Blob",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "WebSocket",
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "BroadcastChannel",
  "MessageChannel",
  "MessagePort",
  "MessageEvent",
  "DOMException",
  "Performance",
  "Crypto",
  "CryptoKey",
  "SubtleCrypto",
]);

// DOM-классы, которые есть и в node: берём версию happy-dom (её события
// принимают элементы happy-dom).
const DOM_OVERRIDE = new Set(["Event", "EventTarget", "CustomEvent", "File", "FileReader", "Navigator", "Storage"]);

function define(key, value) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
}

export function setupDom({ url = "https://zai.test/zai/" } = {}) {
  if (win) return win;
  win = new Window({ url, width: 1280, height: 900 });

  // Все DOM-конструкторы (HTMLElement, Event, KeyboardEvent, TouchEvent,
  // PointerEvent, ResizeObserver, FileReader, Image, …) — из happy-dom, чтобы
  // события, созданные тестом, принимались элементами happy-dom.
  // Встроенные JS-глобалы (Array, Uint8Array, …), которые happy-dom тоже
  // кладёт на window, не трогаем: подмена ломает node-код (esbuild-сервис).
  for (const key of Object.getOwnPropertyNames(win)) {
    if (!/^[A-Z]/.test(key) || KEEP_NODE.has(key)) continue;
    if (key in globalThis && !DOM_OVERRIDE.has(key)) continue;
    let v;
    try {
      v = win[key];
    } catch {
      continue;
    }
    if (typeof v === "function") define(key, v);
  }

  define("window", win);
  define("document", win.document);
  define("navigator", win.navigator);
  define("location", win.location);
  define("history", win.history);
  define("localStorage", win.localStorage);
  define("sessionStorage", win.sessionStorage);
  define("screen", win.screen);
  define("customElements", win.customElements);
  define("getComputedStyle", win.getComputedStyle.bind(win));
  define("innerWidth", win.innerWidth);
  define("innerHeight", win.innerHeight);
  define("isSecureContext", true);
  // Голые addEventListener/removeEventListener в компонентах (Escape у
  // модалок, PickerSheet, Composer) вешаются на window.
  define("addEventListener", win.addEventListener.bind(win));
  define("removeEventListener", win.removeEventListener.bind(win));
  define("dispatchEvent", win.dispatchEvent.bind(win));
  // Десктоп по умолчанию: (pointer: coarse) не совпадает → Enter отправляет.
  define("matchMedia", (q) => ({
    matches: false,
    media: String(q),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  // rAF на setImmediate: preact-hooks планирует эффекты через rAF; при
  // включённом mock.timers (setTimeout/Date) эффекты всё равно доезжают.
  define("requestAnimationFrame", (cb) => setImmediate(() => cb(performance.now())));
  define("cancelAnimationFrame", (id) => clearImmediate(id));

  // Заглушка EventSource: store.installEventStream её открывает, но событий
  // нет — тесты кормят store.handleEvent напрямую, если нужно.
  define(
    "EventSource",
    class FakeEventSource {
      constructor(u) {
        this.url = u;
        this.readyState = 1;
        FakeEventSource.instances.push(this);
      }
      close() {
        this.readyState = 2;
      }
      addEventListener() {}
      removeEventListener() {}
      static instances = [];
    },
  );

  // Без SpeechRecognition = «не secure context»: голосовой режим выключен.
  delete globalThis.SpeechRecognition;
  delete globalThis.webkitSpeechRecognition;

  installFetch();

  // XHR (Composer.uploadWithProgress, R-26): у happy-dom XMLHttpRequest
  // настоящий — он пошёл бы в сеть на https://zai.test и повис. Подменяем
  // фейком поверх фейкового fetch (те же маршруты и журнал fetchCalls).
  define(
    "XMLHttpRequest",
    class FakeXHR {
      constructor() {
        this.upload = {};
        this.status = 0;
        this.responseText = "";
        this.headers = {};
        this.aborted = false;
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(k, v) {
        this.headers[k] = v;
      }
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
      send(body) {
        const size = typeof body?.size === "number" ? body.size : 0;
        globalThis
          .fetch(this.url, { method: this.method, headers: this.headers, body: typeof body === "string" ? body : undefined })
          .then(async (res) => {
            if (this.aborted) return;
            this.upload.onprogress?.({ lengthComputable: size > 0, loaded: size, total: size });
            this.status = res.status;
            this.responseText = await res.text();
            this.onload?.();
          })
          .catch(() => {
            if (!this.aborted) this.onerror?.();
          });
      }
    },
  );

  after(() => {
    try {
      win.happyDOM?.abort?.();
      win.close?.();
    } catch {}
  });
  return win;
}

// ---- фейковый fetch ---------------------------------------------------------
// routes: [{method?, path: string|RegExp, reply: (req) => {status?, body?} | body}]
// Путь сравнивается без query. Непокрытый маршрут → 404 (никогда не висит).
// Базовые ответы для store.init()/pollBusy/seedDialogs: пустые коллекции.
const BASE_ROUTES = [
  { method: "GET", path: "/zai/api/session", reply: () => [] },
  { method: "GET", path: "/zai/api/dialogs", reply: () => [] },
  { method: "GET", path: "/zai/api/status", reply: () => ({}) },
  { method: "GET", path: "/zai/api/provider", reply: () => ({}) },
  { method: "GET", path: "/zai/api/agent", reply: () => [] },
  { method: "GET", path: "/zai/api/mcp", reply: () => ({}) },
  // FEAT-03.22: «Системный промпт» row in Настройки (empty by default)
  { method: "GET", path: "/zai/api/me/system-prompt", reply: () => ({ text: "", max: 4000 }) },
];

export const fetchCalls = [];
let routes = [];

export function installFetch(extra = []) {
  routes = [...extra, ...BASE_ROUTES];
  fetchCalls.length = 0;
  define("fetch", async (input, init = {}) => {
    const u = new URL(String(input), "https://zai.test");
    const method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const call = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), params: u.searchParams, body };
    fetchCalls.push(call);
    const r = routes.find(
      (x) =>
        (!x.method || x.method === method) &&
        (x.path instanceof RegExp ? x.path.test(u.pathname) : x.path === u.pathname),
    );
    if (!r) return new Response("not found", { status: 404 });
    if (r.reply === "network") throw new TypeError("fetch failed"); // обрыв сети
    const out = await r.reply(call);
    if (out && typeof out === "object" && "status" in out && "body" in out) {
      return new Response(out.body == null ? null : JSON.stringify(out.body), {
        status: out.status,
        headers: { "content-type": "application/json", ...(out.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify(out ?? null), { status: 200, headers: { "content-type": "application/json" } });
  });
}
