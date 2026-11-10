# Блок для D:\Portal\watchdog.ps1 — надзор за zai (вставить в общий скрипт watchdog)

if (-not (Get-NetTCPConnection -LocalPort 4170 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'zai-web') { Start-ScheduledTask -TaskName 'zai-web'; Log 'zai web (4170) not listening -> started' }
}

if (-not (Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'zai-oc') { Start-ScheduledTask -TaskName 'zai-opencode-serve'; Log 'opencode serve (4096) not listening -> started' }
}

# Создание задачи zai-web (запустить один раз от имени пользователя):
# schtasks /create /tn "zai-web" /tr "D:\nodejs\node.exe D:\Portal\zai\server.js" /sc onlogon /f
