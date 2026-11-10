# Блок для D:\Portal\watchdog.ps1 — надзор за teleharness (вставить в общий скрипт watchdog)

if (-not (Get-NetTCPConnection -LocalPort 4170 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'teleharness-web') { Start-ScheduledTask -TaskName 'teleharness-web'; Log 'teleharness web (4170) not listening -> started' }
}

if (-not (Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'teleharness-oc') { Start-ScheduledTask -TaskName 'teleharness-opencode-serve'; Log 'opencode serve (4096) not listening -> started' }
}

# Создание задачи teleharness-web (запустить один раз от имени пользователя):
# schtasks /create /tn "teleharness-web" /tr "D:\nodejs\node.exe D:\Portal\teleharness\server.js" /sc onlogon /f
