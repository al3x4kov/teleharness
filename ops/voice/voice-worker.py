# zai voice worker (FEAT-06.2): local TTS (Piper) + STT (GigaAM v2 CTC via sherpa-onnx).
# One long-lived process owned by lib/voice.js. Protocol: JSON lines.
#   stdin : {"id": n, "op": "ping"}
#           {"id": n, "op": "tts", "text": str, "voice": "irina", "rate": 1.0, "raw": false}
#           {"id": n, "op": "norm", "text": str}  -> {"text": what tts will speak}
#           {"id": n, "op": "stt", "pcm": base64 int16 LE mono 16 kHz}
# FEAT-06.3: tts text goes through ru_normalize.py (numbers, units, dates,
# abbreviations, latin, stress/ё) unless "raw" is true (A/B listening).
#   stdout: {"id": n, "ok": true, ...} | {"id": n, "ok": false, "error": str}
# Models live outside the repo (ZAI_VOICE_MODELS, default D:\Voice\models):
#   piper/ru_RU-<voice>-medium.onnx(+.json), gigaam/<dir>/model.int8.onnx + tokens.txt
# Voices load lazily (8-10 s each on a GPU-less mini PC) and stay loaded; requests are
# served one at a time (the host has 4 cores shared with opencode/claude).
import base64, io, json, os, sys, time, wave

MODELS = os.environ.get("ZAI_VOICE_MODELS", r"D:\Voice\models")
PIPER_DIR = os.path.join(MODELS, "piper")
GIGAAM_DIR = os.path.join(MODELS, "gigaam", "sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19")
THREADS = int(os.environ.get("ZAI_VOICE_THREADS", "3"))
MAX_TEXT = 600
MAX_NORM = 1500  # numbers grow when spelled out
MAX_PCM_S = 60

_voices = {}
_stt = None
_rn = None


def rn():
    # the worker runs with -I (no script dir on sys.path): load the sibling module by path
    global _rn
    if _rn is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "ru_normalize", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ru_normalize.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _rn = mod
    return _rn


def normalize(text):
    try:
        return rn().normalize(text)[:MAX_NORM].strip()
    except Exception as e:  # never lose the answer because of the normalizer
        sys.stderr.write(f"normalize failed: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        return text


def voices_available():
    out = []
    for f in sorted(os.listdir(PIPER_DIR)) if os.path.isdir(PIPER_DIR) else []:
        if f.startswith("ru_RU-") and f.endswith("-medium.onnx"):
            out.append(f[len("ru_RU-"):-len("-medium.onnx")])
    return out


def voice(name):
    from piper import PiperVoice
    if name not in _voices:
        path = os.path.join(PIPER_DIR, f"ru_RU-{name}-medium.onnx")
        if not os.path.isfile(path):
            raise ValueError(f"unknown voice: {name}")
        _voices[name] = PiperVoice.load(path)
    return _voices[name]


def stt():
    global _stt
    if _stt is None:
        import sherpa_onnx
        _stt = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=os.path.join(GIGAAM_DIR, "model.int8.onnx"),
            tokens=os.path.join(GIGAAM_DIR, "tokens.txt"),
            num_threads=THREADS, sample_rate=16000, feature_dim=64, decoding_method="greedy_search",
        )
    return _stt


def do_tts(req):
    from piper import SynthesisConfig
    text = str(req.get("text") or "").strip()[:MAX_TEXT]
    if not text:
        raise ValueError("empty text")
    rate = float(req.get("rate") or 1.0)
    rate = min(1.6, max(0.7, rate))
    v = voice(str(req.get("voice") or "irina"))
    t0 = time.time()
    if not req.get("raw"):
        text = normalize(text) or text
    norm_ms = int((time.time() - t0) * 1000)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        v.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=1.0 / rate))
    return {"wav": base64.b64encode(buf.getvalue()).decode("ascii"), "normMs": norm_ms}


def do_norm(req):
    text = str(req.get("text") or "").strip()[:MAX_TEXT]
    t0 = time.time()
    out = normalize(text) if text else ""
    return {"text": out, "normMs": round((time.time() - t0) * 1000, 2)}


def do_stt(req):
    import numpy as np
    raw = base64.b64decode(req.get("pcm") or "")
    if len(raw) < 3200:  # < 0.1 s
        return {"text": ""}
    if len(raw) > MAX_PCM_S * 16000 * 2:
        raise ValueError("audio too long")
    a = np.frombuffer(raw[: len(raw) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
    r = stt()
    s = r.create_stream()
    s.accept_waveform(16000, a)
    r.decode_stream(s)
    return {"text": s.result.text.strip()}


def handle(req):
    op = req.get("op")
    if op == "ping":
        return {"voices": voices_available(), "stt": os.path.isfile(os.path.join(GIGAAM_DIR, "model.int8.onnx")),
                "norm": True, "stressDb": os.path.isfile(os.path.join(MODELS, "ru-stress", "ru_stress.db"))}
    if op == "warm":
        for n in req.get("voices") or []:
            voice(n)
        if req.get("stt"):
            stt()
        normalize("Прогрев: 1 файл, API.")  # loads the module, the stress db and espeak en
        return {}
    if op == "tts":
        return do_tts(req)
    if op == "norm":
        return do_norm(req)
    if op == "stt":
        return do_stt(req)
    raise ValueError(f"unknown op: {op}")


def main():
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            t0 = time.time()
            res = handle(req)
            res.update({"id": rid, "ok": True, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # one bad request never kills the worker
            res = {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        out.write(json.dumps(res, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
