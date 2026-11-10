// Загрузчик компонентов для L2-тестов (TASK-14.7).
//
// loadUI({ Composer: "src/components/chat/Composer.jsx", ... }) бандлит ОДИН
// esm-модуль (esbuild, jsx automatic / jsxImportSource preact, .css → пусто),
// который реэкспортирует запрошенные компоненты, preact (h/render/act) и весь
// src/lib/store.js. Так у теста и компонентов один экземпляр preact и
// @preact/signals (сигналы store, которые тест меняет, — те же, на которые
// подписан компонент). Бандл пишется во временный файл в os.tmpdir() и
// импортируется; DOM-глобалы ставятся до импорта (setupDom).
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupDom } from "./dom.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function loadUI(components = {}, opts = {}) {
  const lines = [
    'export { h, render, Fragment } from "preact";',
    'export { act } from "preact/test-utils";',
    'export * as store from "./src/lib/store.js";',
  ];
  // "path/File.jsx" — default-экспорт; "path/File.jsx#Named" — именованный.
  for (const [name, spec] of Object.entries(components)) {
    const [rel, named = "default"] = spec.split("#");
    lines.push(`export { ${named} as ${name} } from ${JSON.stringify("./" + rel.replace(/\\/g, "/"))};`);
  }
  const res = await build({
    stdin: { contents: lines.join("\n"), resolveDir: ROOT, sourcefile: "zai-component-test-entry.js", loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".css": "empty", ".svg": "text", ".png": "dataurl" },
    logLevel: "silent",
    sourcemap: "inline",
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "zai-ct-"));
  const file = path.join(dir, "bundle.mjs");
  writeFileSync(file, res.outputFiles[0].text);
  after(() => rmSync(dir, { recursive: true, force: true }));
  setupDom(); // после esbuild (его сервису нужны чистые node-глобалы), до импорта бандла
  // i18n: компонентные тесты проверяют русские тексты — язык UI закреплён
  // на ru (src/lib/i18n.js читает пин раньше localStorage/navigator).
  // Тест может передать loadUI(..., { lang: "en" }) или null (без пина).
  globalThis.__ZAI_LANG__ = opts.lang === undefined ? "ru" : opts.lang;
  return import(pathToFileURL(file).href);
}

// ---- утилиты рендера/событий ------------------------------------------------

export function createHarness(ui) {
  const { act, render, h } = ui;
  const mounted = [];

  function mount(Comp, props = {}) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    act(() => render(h(Comp, props), root));
    mounted.push(root);
    return {
      root,
      rerender(next) {
        act(() => render(h(Comp, { ...props, ...next }), root));
      },
      unmount() {
        act(() => render(null, root));
        root.remove();
      },
    };
  }

  function cleanup() {
    for (const root of mounted.splice(0)) {
      act(() => render(null, root));
      root.remove();
    }
    document.body.innerHTML = ""; // порталы (PickerSheet) живут в body
  }

  function fire(el, type, init = {}, Ctor = Event, extra = {}) {
    if (!el) throw new Error(`fire(${type}): элемент не найден`);
    const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init });
    for (const [k, v] of Object.entries(extra)) Object.defineProperty(ev, k, { value: v, configurable: true });
    let ok;
    act(() => {
      ok = el.dispatchEvent(ev);
    });
    return ok;
  }

  const click = (el) => fire(el, "click", {}, MouseEvent);

  function typeInto(el, value) {
    if (!el) throw new Error("typeInto: элемент не найден");
    act(() => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function key(el, k, init = {}) {
    return fire(el, "keydown", { key: k, ...init }, KeyboardEvent);
  }

  // Синтетический touch: в happy-dom init {touches} не обязателен — кладём
  // touches на событие напрямую (компонент читает только clientX/clientY).
  function touch(el, type, x, y) {
    const pts = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }];
    return fire(el, type, {}, Event, { touches: pts, changedTouches: [{ clientX: x, clientY: y }] });
  }

  // Ожидание условия без sleep: прокручиваем микротаски/setImmediate и
  // сбрасываем отложенные рендеры/эффекты preact через act.
  async function waitFor(cond, { tries = 200 } = {}) {
    let last;
    for (let i = 0; i < tries; i += 1) {
      act(() => {});
      try {
        last = cond();
        if (last) return last;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`waitFor: условие не выполнено (${last instanceof Error ? last.message : String(last)})`);
  }

  async function flush(n = 5) {
    for (let i = 0; i < n; i += 1) {
      await new Promise((r) => setImmediate(r));
      act(() => {});
    }
  }

  return { mount, cleanup, fire, click, typeInto, key, touch, waitFor, flush, act };
}

// Поиск по тексту: первый элемент selector, чей textContent содержит text.
export function byText(root, selector, text) {
  return [...root.querySelectorAll(selector)].find((el) => el.textContent.includes(text)) ?? null;
}

export function $(root, sel) {
  return root.querySelector(sel);
}

export function $$(root, sel) {
  return [...root.querySelectorAll(sel)];
}
