// Tests for the voice dictation adapter (src/lib/voice.js): transcript
// accumulation, error mapping, and the recognizer state machine against a
// fake SpeechRecognition constructor — auto-restart on engine stop (iOS ~1min
// cap), the Safari start()-before-stop() workaround, no respawn after fatal
// errors, no-op in engines without the API.
// Run: node --test tests/voice.test.js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTranscript, createRecognizer, errorText, speechSupported } from "../src/lib/voice.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  delete globalThis.SpeechRecognition;
  delete globalThis.webkitSpeechRecognition;
});

test("speechSupported: false without the API, true when present", () => {
  assert.equal(speechSupported(), false);
  globalThis.webkitSpeechRecognition = class {};
  assert.equal(speechSupported(), true);
});

test("createTranscript: finals append trimmed, reset clears", () => {
  const t = createTranscript();
  t.addFinal("привет");
  t.addFinal("  как дела ");
  assert.equal(t.text, "привет как дела");
  t.addFinal("");
  t.addFinal(null);
  assert.equal(t.text, "привет как дела");
  t.reset();
  assert.equal(t.text, "");
});

test("errorText: known codes are human, unknown fall back", () => {
  assert.equal(errorText("not-allowed"), "Нет доступа к микрофону — разрешите его для сайта в настройках");
  assert.ok(errorText("mystery").length > 0);
});

test("createRecognizer: null without the API", () => {
  assert.equal(createRecognizer({}), null);
});

test("recognizer: results flow partial/final, engine stop triggers respawn", async () => {
  const instances = [];
  let startCalls = 0;
  globalThis.SpeechRecognition = class {
    constructor() {
      instances.push(this);
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
    }
    start() {
      startCalls += 1;
    }
    stop() {}
    abort() {}
  };

  const seen = [];
  const rec = createRecognizer({
    onPartial: (committed, interim) => seen.push([committed, interim]),
  });
  rec.start();
  assert.equal(startCalls, 1);
  assert.equal(instances[0].lang, "ru-RU");
  assert.equal(instances[0].interimResults, true);

  instances[0].onresult({ resultIndex: 0, results: [{ 0: { transcript: "при" }, isFinal: false }] });
  instances[0].onresult({ resultIndex: 0, results: [{ 0: { transcript: "привет" }, isFinal: true }] });
  assert.deepEqual(seen, [["", "при"], ["привет", ""]]);
  assert.equal(rec.committed(), "привет");

  // iOS: the engine stops itself (~1min cap) → adapter respawns automatically
  instances[0].onend();
  await sleep(250);
  assert.equal(instances.length, 2, "must respawn while the session is active");

  rec.stop(); // Safari workaround: start() precedes stop() on the instance
  instances[1].onend();
  await sleep(250);
  assert.equal(instances.length, 2, "no respawn after an intentional stop");
});

test("recognizer: stop() uses the Safari start-then-stop workaround", () => {
  const calls = [];
  globalThis.SpeechRecognition = class {
    constructor() {
      this.onend = null;
      this.onerror = null;
      this.onresult = null;
    }
    start() {
      calls.push("start");
    }
    stop() {
      calls.push("stop");
    }
    abort() {
      calls.push("abort");
    }
  };
  const rec = createRecognizer({});
  rec.start();
  rec.stop();
  assert.deepEqual(calls, ["start", "start", "stop"]);
});

test("recognizer: fatal errors surface once and kill the session", async () => {
  const instances = [];
  let startCalls = 0;
  globalThis.SpeechRecognition = class {
    constructor() {
      instances.push(this);
      this.onend = null;
      this.onerror = null;
      this.onresult = null;
    }
    start() {
      startCalls += 1;
    }
    stop() {}
    abort() {}
  };
  const errors = [];
  const ends = [];
  const rec = createRecognizer({ onError: (m) => errors.push(m), onEnd: () => ends.push(1) });
  rec.start();
  instances[0].onerror({ error: "no-speech" }); // restart noise: must be silent
  assert.deepEqual(errors, []);
  instances[0].onerror({ error: "not-allowed" });
  assert.deepEqual(errors, [errorText("not-allowed")]);
  instances[0].onend();
  await sleep(250);
  assert.equal(startCalls, 1, "no respawn after a fatal error");
  assert.equal(ends.length, 1, "onEnd delivered after the engine settles");
});

test("recognizer: abort cancels without respawn", async () => {
  let startCalls = 0;
  const aborts = [];
  globalThis.SpeechRecognition = class {
    constructor() {
      this.onend = null;
      this.onerror = null;
      this.onresult = null;
    }
    start() {
      startCalls += 1;
    }
    stop() {}
    abort() {
      aborts.push(1);
    }
  };
  const rec = createRecognizer({});
  rec.start();
  rec.abort();
  assert.equal(aborts.length, 1);
  await sleep(200);
  assert.equal(startCalls, 1);
});
