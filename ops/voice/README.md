# Голосовой режим — серверный процесс (FEAT-06.2)

`voice-worker.py` — постоянный процесс Piper (озвучка) + GigaAM v2 (распознавание), им управляет `lib/voice.js`.

Установка на сервере (однократно):
```
python -m venv D:\Voice\venv
D:\Voice\venv\Scripts\python.exe -m pip install piper-tts sherpa-onnx numpy
```
Модели (вне репозитория, `ZAI_VOICE_MODELS`, по умолчанию `D:\Voice\models`):
- `piper\ru_RU-{irina,denis,dmitri,ruslan}-medium.onnx` + `.onnx.json` — https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU
- `gigaam\sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19\` (model.int8.onnx, tokens.txt) — https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models

Нормализация речи (FEAT-06.3): `ru_normalize.py` (числа, единицы, даты, сокращения, латиница, ё/ударения) вызывается воркером перед Piper; тесты — `D:\Voice\venv\Scripts\python.exe -I ops\voice\test_ru_normalize.py`.
Словарь ударений/«ё» (вне репозитория, без него работает всё, кроме словарных ударений): исходные словари RUAccent (Apache-2.0) в `ruaccent\dictionary\` (`accents.json.gz`, `omographs.json.gz`, `yo_words.json.gz`, https://huggingface.co/ruaccent), сборка `D:\Voice\venv\Scripts\python.exe -I ops\voice\build_ru_stress.py` → `ru-stress\ru_stress.db` (≈ 5,5 мин, 58 МБ).

Настройки: `ZAI_VOICE=0` выключает режим; `ZAI_VOICE_PYTHON`, `ZAI_VOICE_MODELS`, `ZAI_VOICE_WORKER`, квоты тенанта `ZAI_VOICE_TENANT_TTS_CHARS`, `ZAI_VOICE_TENANT_STT_SEC`.
Замеры делались на мини-ПК без GPU.

Словарь ударений и «ё» `D:\Voice\models\ru-stress\ru_stress.db` собран `build_ru_stress.py` из словарей RUAccent (Apache-2.0). Исходные словари после спайка удалены (2026-11-05); для пересборки — снова скачать RUAccent dictionary в `D:\Voice\models\ruaccent\dictionary`.
