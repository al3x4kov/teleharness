// Fake voice worker (FEAT-06.2 tests): same JSON-lines protocol as
// ops/voice/voice-worker.py, no models. tts → a tiny WAV whose data bytes
// spell the text; stt → "распознано <n> байт"; text "CRASH" exits; "SLOWTTS"
// never answers (timeout path).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const wav = (text) => {
  const data = Buffer.from(String(text), "utf8");
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24);
  h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const reply = (o) => process.stdout.write(JSON.stringify({ id: req.id, ...o }) + "\n");
  if (req.op === "ping") return reply({ ok: true, voices: ["denis", "irina"], stt: true });
  if (req.op === "warm") return reply({ ok: true });
  if (req.op === "tts") {
    if (req.text === "CRASH") process.exit(3);
    if (req.text === "SLOWTTS") return;
    if (req.voice === "nope") return reply({ ok: false, error: "ValueError: unknown voice: nope" });
    return reply({ ok: true, wav: wav(`${req.voice}|${req.rate}|${req.text}`).toString("base64") });
  }
  if (req.op === "norm") return reply({ ok: true, text: `норм:${req.text}`, normMs: 1.5 });
  if (req.op === "stt") return reply({ ok: true, text: `распознано ${Buffer.from(req.pcm ?? "", "base64").length} байт` });
  reply({ ok: false, error: "unknown op" });
});
rl.on("close", () => process.exit(0));
