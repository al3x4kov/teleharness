# ops/sandbox — песочница команд тенантов (FEAT-04.9)

Тенанты (пользователи портала) получают инструмент `bash` и Python. Каждая их команда
выполняется в Windows AppContainer тенанта. Плагин `ops/opencode/vault-cache.ts`
переписывает команду тенанта в вызов `zai-jail.exe`; admin-сессии не затрагиваются.

## Что здесь

| Файл | Зачем |
|---|---|
| `ZaiJail.cs` | исходник запускателя `zai-jail.exe` (C#, .NET Framework 4, без зависимостей) |
| `build.ps1` | сборка `csc` → `ops\sandbox\zai-jail.exe` (бинарь в `.gitignore`) |
| `setup-python.ps1` | идемпотентно: venv `D:\zai-sandbox\python`, пакеты, `sitecustomize.py`, ACL |
| `sitecustomize.py` | WMI в AppContainer роняет процесс, поэтому `platform._wmi_query` бросает OSError |
| `tests/jail-live.test.mjs` | живой тест изоляции (только Windows, нужен собранный exe и окружение) |
| `tests/skills-live.test.mjs` | живой тест рецептов скиллов `zai-*` (FEAT-04.10): каждый рецепт из `ops/opencode/skills/*/SKILL.md` выполняется в zai-jail, результат перечитывается |

## Запускатель

    zai-jail.exe --name zai-t-<tenant> --dir <папка тенанта> [--cwd <папка внутри --dir>]
                 [--net] [--cafile <cacert.pem>] [--path-prepend <dir>] --b64 <командная строка>

- `--b64` — base64 или base64url UTF-8 полной командной строки процесса. Плагин передаёт
  `cmd.exe /d /s /c "<команда тенанта>"`. Так кавычки, `&`, `|`, `"` не разбирает внешний
  shell opencode: в нём остаются только `[A-Za-z0-9_-]` и пути с прямыми слэшами.
- `--name` — `^zai-t-[A-Za-z0-9_-]{1,40}$`; профиль AppContainer создаётся при первом вызове.
- `--dir` — контейнеру выдаётся Modify на эту папку (наследуемо). Больше записи нигде нет.
- `--cwd` — рабочая папка, только внутри `--dir`, иначе отказ (код 2).
- `--net` — capability `internetClient`: интернет есть, loopback (127.0.0.1) и LAN закрыты.
- `--cafile` — `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`: хранилище сертификатов Windows из контейнера недоступно.
- `--path-prepend` — первым в `PATH` (плагин передаёт `D:\zai-sandbox\python\Scripts`).
  Остальной `PATH` — только `System32`, `Windows`, `Wbem`.
- Окружение — allowlist (системные переменные, без токенов, ключей, `OPENCODE_*`, `ZAI_*`);
  `HOME`/`USERPROFILE` — папка тенанта, `APPDATA`/`LOCALAPPDATA`/`TEMP` — в `<папка>\.appdata`.
- Окно станции и рабочего стола выдаётся SID контейнера (как в Chromium): без этого USER32/OLE
  не загружаются, а с ними `ctypes`, `ssl` и pandas.
- Job object с `KILL_ON_JOB_CLOSE`: когда opencode убивает запускатель по таймауту, умирает всё дерево.
- Коды выхода: код команды; `2` — аргументы; `125` — подготовка контейнера; `126` — команда не запустилась.
  Ошибки — по-русски в stderr (UTF-8).

## Пакеты Python (`D:\zai-sandbox\python`)

| Пакет | Для чего | С какой задачи |
|---|---|---|
| pandas, openpyxl, xlrd | таблицы, .xlsx/.xls | FEAT-04.9 |
| python-docx | Word .docx | FEAT-04.9 |
| pypdf | PDF: чтение, слияние, разделение | FEAT-04.9 |
| matplotlib | графики в .png; его DejaVuSans — кириллический шрифт для PDF | FEAT-04.9 |
| pillow | картинки | FEAT-04.9 |
| requests, certifi | https (корни TLS — certifi) | FEAT-04.9 |
| python-pptx | PowerPoint .pptx | FEAT-04.10 |
| XlsxWriter | .xlsx с диаграммами и условным форматированием | FEAT-04.10 |
| reportlab | создание PDF | FEAT-04.10 |
| pdfplumber (+ pdfminer.six, pypdfium2, cryptography) | текст и таблицы из PDF | FEAT-04.10 |
| markdown, beautifulsoup4, jinja2 | HTML: из Markdown, разбор, шаблоны | FEAT-04.10 |

Все пакеты импортируются внутри zai-jail (проверено 2026-11-04). Из контейнера читаются
`C:\Windows\Fonts` (arial.ttf, calibri.ttf) и шрифт DejaVuSans из matplotlib (`D:\zai-sandbox\python\Lib\site-packages\matplotlib\mpl-data\fonts\ttf\DejaVuSans.ttf`).

## Ограничения

- PowerShell 5.1 и Git Bash в AppContainer не стартуют. Shell тенанта — только `cmd.exe`.
- `dir` и `vol` в контейнере отвечают «Access is denied»: им нужен корень тома. Список файлов —
  инструментами `list`/`glob` или `python -c "import os; print(os.listdir())"`.
- Квот CPU и памяти нет (job object позволяет; отдельная задача).

## Установка (прод и стенд — одна машина)

    powershell -NoProfile -ExecutionPolicy Bypass -File ops\sandbox\setup-python.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File ops\sandbox\build.ps1

Плагин ищет `ZAI_JAIL_EXE` (по умолчанию `D:/Portal/zai/ops/sandbox/zai-jail.exe`) и
`ZAI_SANDBOX_PY` (по умолчанию `D:/zai-sandbox/python`). Нет любого из них — shell тенанту
запрещён (fail-closed).

## Проверки

    node --test ops/sandbox/tests/jail-live.test.mjs

Тест создаёт временные папки двух тенантов и проверяет: запись в `D:\Portal\zai` и `C:\Windows`,
чтение `data\users.json`, `admin-token.txt`, `C:\Users\USER\Documents`, чужой папки и
`127.0.0.1:4096` — отказ; своя запись, `pandas.read_excel`, https — работают.
Путь к exe — `ZAI_JAIL_EXE` или `ops\sandbox\zai-jail.exe` рядом с тестом.
