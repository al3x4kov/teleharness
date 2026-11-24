# Local Voice Mode (Piper TTS + GigaAM v2 STT)

`voice-worker.py` is an optional persistent local worker managed by `lib/voice.js`. It runs completely
offline on CPU (no cloud speech APIs) and talks to Teleharness over JSON lines on stdin/stdout.

When Python or the voice models are not installed, Teleharness stays fully functional — voice mode is
simply hidden from the UI (browser speech dictation still works where supported).

## 1. Create the Python virtual environment

By default Teleharness looks for the venv and models under `~/.teleharness/voice/`:

- **Linux / macOS:** `~/.teleharness/voice/venv/bin/python3`
- **Windows:** `%USERPROFILE%\.teleharness\voice\venv\Scripts\python.exe`
- **Models directory:** `~/.teleharness/voice/models`

You can override both paths in `.env` via `TELEHARNESS_VOICE_PYTHON` and `TELEHARNESS_VOICE_MODELS`.

### Linux / macOS

```bash
mkdir -p ~/.teleharness/voice/models
python3 -m venv ~/.teleharness/voice/venv
~/.teleharness/voice/venv/bin/pip install --upgrade pip
~/.teleharness/voice/venv/bin/pip install piper-tts sherpa-onnx numpy
```

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.teleharness\voice\models" | Out-Null
python -m venv "$env:USERPROFILE\.teleharness\voice\venv"
& "$env:USERPROFILE\.teleharness\voice\venv\Scripts\python.exe" -m pip install --upgrade pip
& "$env:USERPROFILE\.teleharness\voice\venv\Scripts\python.exe" -m pip install piper-tts sherpa-onnx numpy
```

## 2. Download models

Place the downloaded files under `~/.teleharness/voice/models/` (or your `TELEHARNESS_VOICE_MODELS` directory):

1. **Piper TTS voices** → `models/piper/`
   - Download one or more `.onnx` + matching `.onnx.json` voice models from
     [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) (for example,
     `ru_RU-irina-medium.onnx`, `ru_RU-denis-medium.onnx`, `ru_RU-dmitri-medium.onnx`, `ru_RU-ruslan-medium.onnx`,
     or English voices under `en/en_US/`).
2. **GigaAM v2 STT (sherpa-onnx)** → `models/gigaam/sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19/`
   - Download `model.int8.onnx` and `tokens.txt` from
     [k2-fsa/sherpa-onnx ASR releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models).

## 3. Optional Russian stress & normalization dictionary

`ru_normalize.py` normalizes numbers, units, dates, abbreviations, and Latin terms before Piper speaks them.
You can verify it locally:

```bash
~/.teleharness/voice/venv/bin/python3 -I ops/voice/test_ru_normalize.py
```

To also add dictionary word stress / «ё» restoration, download the Apache-2.0 RUAccent dictionaries
(`accents.json.gz`, `omographs.json.gz`, `yo_words.json.gz` from <https://huggingface.co/ruaccent>)
into `<models>/ruaccent/dictionary/` and build the SQLite database once (~5 min on CPU, ~58 MB):

```bash
TELEHARNESS_VOICE_MODELS=~/.teleharness/voice/models ~/.teleharness/voice/venv/bin/python3 -I ops/voice/build_ru_stress.py
```

This produces `<models>/ru-stress/ru_stress.db`. Without it, voice mode still works with rule-based normalization.

## 4. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TELEHARNESS_VOICE` | `1` | Set `0` to disable server voice mode completely. |
| `TELEHARNESS_VOICE_PYTHON` | `~/.teleharness/voice/venv/...` | Path to the Python executable in the voice venv. |
| `TELEHARNESS_VOICE_MODELS` | `~/.teleharness/voice/models` | Directory containing `piper/`, `gigaam/`, and optional `ru-stress/`. |
| `TELEHARNESS_VOICE_WORKER` | `ops/voice/voice-worker.py` | Custom worker script path. |
| `TELEHARNESS_VOICE_TENANT_TTS_CHARS` | `40000` | Daily TTS character quota per regular user (`0` = unlimited; admin is exempt). |
| `TELEHARNESS_VOICE_TENANT_STT_SEC` | `1800` | Daily STT seconds quota per regular user (`0` = unlimited). |
