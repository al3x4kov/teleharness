// FEAT-06.2 voice mode routes. deps: { sendJson, readBody, readJsonBody, voice
// (VoiceService), quota (VoiceQuota), bodyLimit }.
//   GET  /zai/api/voice      → {enabled, ready, voices:[{id,name}], stt}
//   POST /zai/api/voice/tts  {text, voice?, rate?} → audio/wav
//   POST /zai/api/voice/stt  raw int16 LE mono 16 kHz PCM → {text}
//   POST /zai/api/voice/norm {text} → {text, ms} — admin debug (FEAT-06.3): what
//        the TTS will actually say after the speech normalizer
// Tenants are limited per day (quota); admin never. Disabled/missing worker →
// 503 {code:"unavailable"} so the client falls back to the browser engines.
import { DEFAULT_VOICE, MAX_STT_SECONDS, cleanTtsText, pcmSeconds, voiceLabel } from "../lib/voice.js";

const VOICE_ID = /^[a-z]{2,24}$/;

export function voiceRoutes(deps) {
  const { sendJson } = deps;
  const fail = (res, err) => {
    const code = err?.code === "unavailable" || err?.code === "parked" ? err.code : "failed";
    return sendJson(res, 503, { error: code === "failed" ? "Голосовой сервис не ответил" : "Голосовой сервис недоступен", code });
  };
  return [
    {
      method: "GET",
      path: "/zai/api/voice",
      scope: "user",
      handler: async ({ res }) => {
        const v = deps.voice;
        if (!v?.available) return sendJson(res, 200, { enabled: false, ready: false, voices: [], stt: false, defaultVoice: DEFAULT_VOICE });
        const info = await v.info();
        return sendJson(res, 200, {
          enabled: true,
          ready: info.ready === true,
          parked: info.parked === true,
          voices: (info.voices ?? []).map((id) => ({ id, name: voiceLabel(id) })),
          stt: info.stt === true,
          defaultVoice: DEFAULT_VOICE,
        });
      },
    },
    {
      method: "POST",
      path: "/zai/api/voice/tts",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        if (!deps.voice?.available) return fail(res, { code: "unavailable" });
        const body = await deps.readJsonBody(req, 16 * 1024);
        if (!body || typeof body !== "object") return sendJson(res, 400, { error: "bad json" });
        const text = cleanTtsText(body.text);
        if (!text) return sendJson(res, 400, { error: "empty text" });
        const voice = typeof body.voice === "string" && VOICE_ID.test(body.voice) ? body.voice : DEFAULT_VOICE;
        const rate = Number.isFinite(Number(body.rate)) ? Math.min(1.6, Math.max(0.7, Number(body.rate))) : 1;
        if (!admin && !deps.quota.takeTts(user.id, text.length)) return sendJson(res, 429, { error: "Дневной лимит озвучки исчерпан", code: "quota" });
        try {
          const wav = await deps.voice.tts({ text, voice, rate });
          res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "cache-control": "no-store" });
          return res.end(wav);
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/zai/api/voice/norm",
      scope: "admin",
      handler: async ({ req, res }) => {
        if (!deps.voice?.available) return fail(res, { code: "unavailable" });
        const body = await deps.readJsonBody(req, 16 * 1024);
        if (!body || typeof body !== "object") return sendJson(res, 400, { error: "bad json" });
        const text = cleanTtsText(body.text);
        if (!text) return sendJson(res, 400, { error: "empty text" });
        try {
          return sendJson(res, 200, await deps.voice.norm(text));
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/zai/api/voice/stt",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        if (!deps.voice?.available) return fail(res, { code: "unavailable" });
        const raw = await deps.readBody(req, MAX_STT_SECONDS * 32_000 + 1024);
        if (raw == null) return sendJson(res, 413, { error: "audio too long" });
        const seconds = pcmSeconds(raw.length);
        if (!admin && !deps.quota.takeStt(user.id, seconds)) return sendJson(res, 429, { error: "Дневной лимит распознавания исчерпан", code: "quota" });
        try {
          const text = await deps.voice.stt(raw);
          return sendJson(res, 200, { text, seconds: Math.round(seconds * 10) / 10 });
        } catch (err) {
          return fail(res, err);
        }
      },
    },
  ];
}
