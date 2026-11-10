# Окружение Python для команд тенантов (FEAT-04.9, FEAT-04.10). Идемпотентно: повторный запуск
# досоздаёт недостающее и ничего не ломает.
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\sandbox\setup-python.ps1 [-Root D:\zai-sandbox] [-BasePython <python.exe>]
#
# Что делает:
#  1. venv <Root>\python на базе Python 3.12 владельца (если его ещё нет);
#  2. пакеты для документов и данных (pip install --upgrade-strategy only-if-needed);
#  3. sitecustomize.py (WMI в AppContainer роняет процесс → platform получает OSError);
#  4. ACL: RX для всех AppContainer (*S-1-15-2-1, ALL APPLICATION PACKAGES) на <Root>
#     и на каталог базового Python — venv грузит из него stdlib и DLL.
#     Запись в эти каталоги контейнерам не выдаётся.
param(
  [string]$Root = 'D:\zai-sandbox',
  [string]$BasePython = 'C:\Users\USER\AppData\Local\Programs\Python\Python312\python.exe'
)
$ErrorActionPreference = 'Stop'
# FEAT-04.10: + python-pptx, XlsxWriter, reportlab, pdfplumber (тянет pdfminer.six, pypdfium2, cryptography),
# markdown, beautifulsoup4, jinja2 — для скиллов zai-* (ops/opencode/skills). Все импортируются в zai-jail
# (ops/sandbox/tests/skills-live.test.mjs).
$Packages = @('pandas', 'openpyxl', 'xlrd', 'python-docx', 'pypdf', 'matplotlib', 'pillow', 'requests', 'certifi',
  'python-pptx', 'XlsxWriter', 'reportlab', 'pdfplumber', 'markdown', 'beautifulsoup4', 'jinja2')
$Venv = Join-Path $Root 'python'
$Py = Join-Path $Venv 'Scripts\python.exe'

if (-not (Test-Path $BasePython)) { throw "нет базового Python: $BasePython" }
New-Item -ItemType Directory -Force $Root | Out-Null

# 1. venv
if (-not (Test-Path $Py)) {
  "venv: создаю $Venv"
  & $BasePython -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw "python -m venv завершился с кодом $LASTEXITCODE" }
} else { "venv: есть ($Venv)" }

# 2. пакеты
& $Py -m pip install --disable-pip-version-check --quiet --upgrade-strategy only-if-needed @Packages
if ($LASTEXITCODE -ne 0) { throw "pip install завершился с кодом $LASTEXITCODE" }
"пакеты: $($Packages -join ', ')"

# 3. sitecustomize
$site = (& $Py -c "import sysconfig;print(sysconfig.get_paths()['purelib'])").Trim()
Copy-Item -Force (Join-Path $PSScriptRoot 'sitecustomize.py') (Join-Path $site 'sitecustomize.py')
"sitecustomize: $site"

# 4. ACL (icacls /grant идемпотентен: повтор не дублирует запись)
$baseDir = Split-Path -Parent $BasePython
foreach ($d in @($Root, $baseDir)) {
  & icacls $d /grant '*S-1-15-2-1:(OI)(CI)(RX)' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $d завершился с кодом $LASTEXITCODE" }
  "ACL: RX для ALL APPLICATION PACKAGES на $d"
}

# Проверка без контейнера: пакеты импортируются, certifi на месте.
& $Py -c "import pandas, openpyxl, xlrd, docx, pypdf, matplotlib, PIL, requests, certifi, pptx, xlsxwriter, reportlab, pdfplumber, markdown, bs4, jinja2; print('импорт ок; cacert:', certifi.where())"
if ($LASTEXITCODE -ne 0) { throw 'проверка импорта не прошла' }
