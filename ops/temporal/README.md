# Локальный запуск Temporal без PostgreSQL

Портал и воркер `worker/temporal/pipeline_worker.py` умеют работать без PostgreSQL и без установленного `psycopg`, если задан режим `TELEHARNESS_TEMPORAL_LEDGER=none`. В этом режиме доступны все не-модельные шаги пайпов: «Команда» (`exec` и `temporal-workflow`), «Условие», «Артефакт», «Таймер», «Решение человека», «Параллельные ветки». Модельные шаги отклоняются с кодом `422` до включения `TELEHARNESS_TEMPORAL_LEDGER=postgres`.


## 1. Подготовка Python-окружения воркера (без `psycopg`)

```bash
python3 -m venv ~/.local/share/teleharness/venv
~/.local/share/teleharness/venv/bin/pip install temporalio protobuf nexus-rpc
```

## 2. Изолированный namespace в Temporal

Если на машине уже работает Temporal на `127.0.0.1:7233` (например, со своим `default` namespace), создайте отдельный namespace для пайпов портала:

```bash
temporal operator namespace create teleharness-local --address 127.0.0.1:7233
```

Если своего Temporal ещё нет — можно поднять локальный сервер по образцу `dev.teleharness.temporal-server.plist.example`.

## 3. Короткий путь Unix-сокета (macOS: лимит 103 байта)

На macOS `AF_UNIX` ограничивает путь сокета 103 байтами (`sun_path`). Если `<TELEHARNESS_DATA_DIR>/temporal-private/worker.sock` длиннее 103 байт, задайте общий короткий путь для портала и воркера:

```bash
mkdir -p -m 700 /tmp/teleharness-temporal
export TELEHARNESS_TEMPORAL_MODEL_SOCKET=/tmp/teleharness-temporal/worker.sock
```

При превышении лимита портал сообщит об этом в логе и в `GET /teleharness/api/temporal/capabilities` (`socketPathError`).

## 4. Переменные окружения портала

```bash
export TELEHARNESS_TEMPORAL_PIPELINES=1
export TELEHARNESS_TEMPORAL_CLI="$(which temporal)"
export TELEHARNESS_TEMPORAL_ADDRESS=127.0.0.1:7233
export TELEHARNESS_TEMPORAL_NAMESPACE=teleharness-local
export TELEHARNESS_TEMPORAL_QUEUE=teleharness-local-pipeline-v1
export TELEHARNESS_TEMPORAL_LEDGER=none
export TELEHARNESS_TEMPORAL_MODEL_SOCKET=/tmp/teleharness-temporal/worker.sock
export TELEHARNESS_TEMPORAL_COMMAND_SLOTS=2
# Разрешённые корневые каталоги для скриптов exec (через «;»):
export TELEHARNESS_TEMPORAL_COMMAND_ROOTS="/opt/scripts;/Users/YOUR_USER/scripts"
```

## 5. Запуск воркера через `launchd` на macOS

1. Скопируйте `dev.teleharness.temporal-worker.plist.example` в `~/Library/LaunchAgents/dev.teleharness.temporal-worker.plist` и подставьте реальные пути.
2. Загрузите агент:
   ```bash
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.teleharness.temporal-worker.plist
   ```
3. Проверьте логи в `/tmp/teleharness-temporal/worker.err.log`.
