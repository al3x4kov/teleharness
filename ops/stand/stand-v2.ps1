# Стенд v2 портала zai (FEAT-16.3, tasks 5.2/6.1; design §8–§9).
# Поднимает пару «opencode 2.2.6 serve :4101 + портал :4174» со своими папками
# под D:\zai-stage\oc2 (XDG) и D:\zai-stage\stand2-data (users.json). Прод
# (:4096/:4170) и стенд v1 (:4097/:4172) не трогает — только свои порты.
#
# Режимы:
#   powershell -File stand-v2.ps1                 # полный старт (перезапуск обоих)
#   powershell -File stand-v2.ps1 -Detach         # то же в фоновом окне
#   powershell -File stand-v2.ps1 -Stop           # остановить стенд v2 (данные остаются)
#   powershell -File stand-v2.ps1 -RestartOpencode # перечитать конфиг/плагин serve :4101
#
# Пароль serve генерируется при первом запуске в <oc2>\pass-файл (вне git, ACL
# только на текущего пользователя) и передаётся процессам ТОЛЬКО через env
# (OPENCODE_SERVER_PASSWORD / ZAI_OC_PASSWORD); скрипт его нигде не печатает.
param(
  [switch]$Detach,
  [switch]$Stop,
  [switch]$RestartOpencode,
  [string]$RepoRoot = "D:\Portal\zai",
  [string]$StageRoot = "D:\zai-stage",
  [string]$DownloadRoot = "D:\zai-tmp-scripts\oc2-dl"
)
$ErrorActionPreference = "Stop"

$OcPort = 4101
$PortalPort = 4174
$Oc2 = Join-Path $StageRoot "oc2"
$Data2 = Join-Path $StageRoot "stand2-data"
$PublicDir = Join-Path $StageRoot "public"
$ConfigDir = Join-Path $Oc2 "config" # XDG_CONFIG_HOME
$ConfigOc = Join-Path $ConfigDir "opencode"
$VaultRoot = Join-Path $Oc2 "tenants\vault" # зона базы знаний тенантов (своя, не v1)
$TenantHome = Join-Path $Oc2 "tenants\home" # рабочие папки тенантов (свои)
$PassFile = Join-Path (Join-Path $Oc2 "secrets") "password.txt" # пароль serve; не печатается
$OcExe = Join-Path $DownloadRoot "bin\opencode.exe"

# --- служебные ---
function Get-ListenerPid([int]$Port) {
  $line = netstat -ano | Select-String -Pattern "127\.0\.0\.1:$Port\s+.+LISTENING" | Select-Object -First 1
  if ($line) {
    $parts = $line.ToString().Trim() -split "\s+"
    return [int]$parts[-1]
  }
  return $null
}
function Stop-PortListener([int]$Port, [string]$What) {
  $pid2 = Get-ListenerPid $Port
  if ($pid2) {
    taskkill /F /PID $pid2 | Out-Null
    Write-Host "$What (:$Port) остановлен (pid $pid2)"
  } else {
    Write-Host "$What (:$Port) не был поднят"
  }
}
function Test-PortUp([int]$Port) {
  $c = New-Object Net.Sockets.TcpClient
  try { return $c.ConnectAsync("127.0.0.1", $Port).Wait(1000) -and $c.Connected } finally { $c.Dispose() }
}
function Wait-PortUp([int]$Port, [int]$Seconds, [string]$What) {
  for ($i = 0; $i -lt $Seconds * 2; $i++) {
    if (Test-PortUp $Port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  throw "$What (:$Port) не поднялся за $Seconds с; логи: $Oc2\logs\"
}

# --- бинарник: SHA256 oc2.zip по SHA256SUMS, распаковка при необходимости ---
function Install-Binary {
  $zip = Join-Path $DownloadRoot "oc2.zip"
  $sums = Join-Path $DownloadRoot "SHA256SUMS"
  if (-not (Test-Path $zip) -or -not (Test-Path $sums)) { throw "нет $zip или $sums — положите дистрибутив v2 (TASK-12.23)" }
  $entry = "opencode-windows-x64.zip"
  $line = Get-Content $sums | Where-Object { $_ -match [regex]::Escape($entry) } | Select-Object -First 1
  if (-not $line) { throw "в SHA256SUMS нет строки для $entry" }
  $expected = ($line -split "\s+")[0].ToLower()
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { throw "SHA256 $zip не совпал с $entry из SHA256SUMS ($actual != $expected)" }
  if (-not (Test-Path $OcExe)) {
    $tmp = Join-Path $DownloadRoot "_unzip"
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $OcExe) | Out-Null
    Copy-Item (Join-Path $tmp "opencode.exe") $OcExe -Force
    Remove-Item $tmp -Recurse -Force
    Write-Host "бинарник распакован: $OcExe"
  }
  Write-Host "SHA256 $entry — ок"
}

# --- пароль: генерация один раз, чтение в переменную; НЕ печатается ---
function Get-StandPassword {
  if (-not (Test-Path $PassFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $PassFile) | Out-Null
    # два GUID = 64 hex-символа, криптографический ГСЧ
    $pw = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
    [IO.File]::WriteAllText($PassFile, $pw)
    icacls $PassFile /inheritance:r /grant:r "$env:USERNAME:F" | Out-Null
    Write-Host "пароль serve создан: $PassFile (ACL: только $env:USERNAME)"
  }
  return (Get-Content $PassFile -Raw).Trim()
}

# --- установка конфига/плагина/скиллов в XDG-зону стенда (идемпотентно) ---
function Install-Config {
  foreach ($d in @($ConfigOc, (Join-Path $Oc2 "data"), (Join-Path $Oc2 "state"), (Join-Path $Oc2 "home"), (Join-Path $Oc2 "logs"), $Data2, $TenantHome, $VaultRoot)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  $ops = Join-Path $RepoRoot "ops\opencode"

  # конфиг v2: два патча под стенд (прод-путь правил → копия рядом с конфигом;
  # зона тенантов прод → своя зона стенда). Точная замена маркеров: если
  # маркера нет — конфиг изменился, падаем, а не молча оставляем прод-пути.
  $raw = Get-Content (Join-Path $ops "opencode.v2.json") -Raw
  $jsonDir = $ConfigOc.Replace("\", "\\")
  $rulesMarker = 'C:\\Users\\USER\\.config\\opencode\\prompts\\glm-rules.md'
  $vaultMarker = 'D:\\Obsidian\\tenants\\*'
  foreach ($m in @($rulesMarker, $vaultMarker)) {
    if (-not $raw.Contains($m)) { throw "маркер не найден в opencode.v2.json: $m — обновите stand-v2.ps1" }
  }
  $raw = $raw.Replace($rulesMarker, "$jsonDir\\prompts\\glm-rules.md")
  $raw = $raw.Replace($vaultMarker, ($VaultRoot.Replace("\", "\\") + "\\*"))
  # стенд: инструкции из копии базы стенда, а не из базы владельца (как stand.ps1 v1)
  $indexMarker = 'D:\\Obsidian\\agents\\_index.md'
  if (-not $raw.Contains($indexMarker)) { throw "маркер не найден в opencode.v2.json: $indexMarker" }
  $raw = $raw.Replace($indexMarker, ((Join-Path $StageRoot 'vault\agents\_index.md').Replace('\', '\\')))
  [IO.File]::WriteAllText((Join-Path $ConfigOc "opencode.json"), $raw)

  # плагин v2 (директория; назначение — сам $ConfigOc: при повторном старте
  # PowerShell скопировал бы источник ВНУТРЬ существующий $ConfigOc\plugin-v2),
  # промпты ({file:./prompts/...} резолвятся от конфига), скиллы zai-*, slim-конфиг
  Copy-Item (Join-Path $ops "plugin-v2") $ConfigOc -Recurse -Force
  # plugin-v2 импортирует ../sandbox-core: без него v2 только пишет WARN «failed to load plugin» и работает БЕЗ песочницы
  Copy-Item (Join-Path $ops "sandbox-core") $ConfigOc -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $ConfigOc "prompts") | Out-Null
  Copy-Item (Join-Path $ops "prompts\*.md") (Join-Path $ConfigOc "prompts") -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $ConfigOc "skills") | Out-Null
  Copy-Item (Join-Path $ops "skills\zai-*") (Join-Path $ConfigOc "skills") -Recurse -Force
  Copy-Item (Join-Path $ops "oh-my-opencode-slim.json") $ConfigOc -Force
  Write-Host "конфиг/плагин/промпты/скиллы поставлены в $ConfigOc"

  # users.json: копия стенда v1 при первом запуске; дальше файл стенда v2 живёт своей жизнью
  $users2 = Join-Path $Data2 "users.json"
  if (-not (Test-Path $users2)) {
    $src = Join-Path $StageRoot "stand-data\users.json"
    if (-not (Test-Path $src)) { throw "нет $src — укажите источник users.json для стенда v2" }
    Copy-Item $src $users2
    Write-Host "users.json скопирован из стенда v1: $users2"
  }
}

# --- env песочницы/плагина для процесса serve (читает их sandbox-core плагина) ---
function Set-ServeEnv([string]$pw) {
  $env:XDG_CONFIG_HOME = $ConfigDir
  $env:XDG_DATA_HOME = Join-Path $Oc2 "data"
  $env:XDG_STATE_HOME = Join-Path $Oc2 "state"
  $env:HOME = Join-Path $Oc2 "home"
  $env:OPENCODE_SERVER_PASSWORD = $pw
  $env:OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  $env:OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = "65536"
  $env:ZAI_USERS_FILE = Join-Path $Data2 "users.json"
  $env:ZAI_TENANT_HOME = $TenantHome
  $env:ZAI_TENANT_VAULT = $VaultRoot
  $env:VAULT_CACHE_ROOT = Join-Path $StageRoot "vault\agents" # копия базы стенда (как у стенда v1), НЕ база владельца
  $env:VAULT_CACHE_PROTECT = Join-Path $StageRoot "vault"
  $env:VAULT_CACHE_LOG = Join-Path $Oc2 "data\vault-cache.log"
  $env:ZAI_JAIL_EXE = Join-Path $StageRoot "tools\zai-jail.exe" # стендовый jail, как в stand.ps1
  $env:ZAI_SANDBOX_PY = "D:\zai-sandbox\python"
  $env:ZAI_TURN_UNDO_ROOT = Join-Path $Oc2 "data\turn-undo"
}

function Start-OcServe([string]$pw) {
  Set-ServeEnv $pw
  if (-not (Test-Path $env:ZAI_JAIL_EXE)) { Write-Host "ВНИМАНИЕ: zai-jail.exe нет — shell тенантов будет запрещён (fail-closed)" }
  $p = Start-Process -FilePath $OcExe -ArgumentList @("serve", "--hostname", "127.0.0.1", "--port", "$OcPort") `
    -WorkingDirectory "C:\Windows\System32" -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Oc2 "logs\oc-out.log") -RedirectStandardError (Join-Path $Oc2 "logs\oc-err.log") `
    -PassThru
  [IO.File]::WriteAllText((Join-Path $Oc2 "serve.pid"), "$($p.Id)")
  Wait-PortUp $OcPort 60 "opencode serve v2"
  Write-Host "opencode serve v2 :$OcPort поднят (spawn pid $($p.Id), listener $(Get-ListenerPid $OcPort))"
}

# --- env портала (lib/config.js); пароль только через env ---
function Start-Portal([string]$pw) {
  $env:PORT = "$PortalPort"
  $env:ZAI_ENV = "stand"
  $env:ZAI_OC_API = "v2"
  $env:ZAI_UPSTREAM = "http://127.0.0.1:$OcPort"
  $env:ZAI_OC_PASSWORD = $pw
  $env:ZAI_DATA_DIR = $Data2
  $env:ZAI_COOKIE_NAME = "zai_t_stage2"
  $env:ZAI_PUBLIC_DIR = $PublicDir
  $env:ZAI_USERS_FILE = Join-Path $Data2 "users.json"
  $env:ZAI_TENANT_HOME = $TenantHome
  $env:ZAI_TENANT_VAULT = $VaultRoot
  $env:ZAI_TURN_UNDO_ROOT = Join-Path $Oc2 "data\turn-undo"
  $env:ZAI_KB_ROOT = Join-Path $StageRoot "vault\agents"
  $p = Start-Process -FilePath "node" -ArgumentList @(Join-Path $RepoRoot "server.js") `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Oc2 "logs\portal-out.log") -RedirectStandardError (Join-Path $Oc2 "logs\portal-err.log") `
    -PassThru
  [IO.File]::WriteAllText((Join-Path $Oc2 "portal.pid"), "$($p.Id)")
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PortalPort/zai/api/healthz" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ok) { throw "портал (:$PortalPort) не ответил /healthz 200; логи: $Oc2\logs\portal-*.log" }
  Write-Host "портал v2 :$PortalPort поднят (pid $($p.Id)), ZAI_OC_API=v2, upstream :$OcPort"
}

# Ключ провайдера v2 не мигрирует из auth.json (api-map §10): проверяем каталог
# и в случае пустоты печатаем КОМАНДУ для установки (сам ключ нигде не показывается).
function Show-CredentialHint([string]$pw) {
  try {
    $hdr = @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pw")) }
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$OcPort/api/provider" -Headers $hdr -TimeoutSec 10
    if ($r.data -and $r.data.Count -gt 0) { Write-Host "credential: провайдер подключён ($($r.data.Count))" ; return }
  } catch { Write-Host "credential: проверка не удалась ($($_.Exception.Message))" }
  Write-Host "Похоже, ключ провайдера не установлен. Выполните (пароль — из файла стенда):"
  Write-Host "  \$env:ZAI_OC_PASSWORD = (Get-Content \"$PassFile\" -Raw).Trim()"
  Write-Host "  node $RepoRoot\ops\deploy\oc2-credential.mjs --url=http://127.0.0.1:$OcPort --auth=$StageRoot\opencode\data\opencode\auth.json"
}


# FEAT-16.3 fail-closed: opencode 2.x on a plugin load failure only WARNs and runs WITHOUT the sandbox.
# The stand does not come up until GET /api/plugin lists zai-tenant-v2 with state.status = active.
function Wait-SandboxPlugin([string]$pw) {
  $hdr = @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pw")) }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$OcPort/api/plugin" -Headers $hdr -TimeoutSec 5
      $p = @($r.data) | Where-Object { $_.id -eq 'zai-tenant-v2' -and $_.state.status -eq 'active' }
      if ($p) { Write-Host "sandbox plugin zai-tenant-v2 active on :$OcPort"; return }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw "zai-tenant-v2 NOT active on :$OcPort in 60 s - STOP: no stand without the sandbox"
}

function Invoke-Start {
  Stop-PortListener $PortalPort "портал v2"
  Stop-PortListener $OcPort "opencode serve v2"
  Install-Binary
  Install-Config
  $pw = Get-StandPassword
  Start-OcServe $pw
  Wait-SandboxPlugin $pw
  Start-Portal $pw
  Show-CredentialHint $pw
  Write-Host "Стенд v2 поднят: портал http://127.0.0.1:$PortalPort, serve http://127.0.0.1:$OcPort"
}

if ($Detach) {
  # фоновый запуск самого себя без -Detach: env у процесса свой
  $args2 = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath)
  if ($RestartOpencode) { $args2 += "-RestartOpencode" }
  Start-Process -FilePath "powershell.exe" -ArgumentList $args2 -WindowStyle Hidden | Out-Null
  Write-Host "стенд v2 запускается в фоне (powershell pid $PID → ребёнок)"
  exit 0
}
if ($Stop) {
  Stop-PortListener $PortalPort "портал v2"
  Stop-PortListener $OcPort "opencode serve v2"
  exit 0
}
if ($RestartOpencode) {
  Stop-PortListener $OcPort "opencode serve v2"
  Install-Binary
  Install-Config
  $pw = Get-StandPassword
  Start-OcServe $pw
  Wait-SandboxPlugin $pw
  Show-CredentialHint $pw
  exit 0
}
Invoke-Start
