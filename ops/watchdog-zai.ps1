# Блок для D:\Portal\watchdog.ps1 — надзор за zai (вставить в общий скрипт watchdog)

if (-not (Get-NetTCPConnection -LocalPort 4170 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'zai-web') { Start-ScheduledTask -TaskName 'zai-web'; Log 'zai web (4170) not listening -> started' }
}

# 2026-11-08: prod engine is opencode 2.x (:4196, task zai-opencode-v2); 1.x :4096 retired (task disabled)
if (-not (Get-NetTCPConnection -LocalPort 4196 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'zai-oc2') { Start-ScheduledTask -TaskName 'zai-opencode-v2'; Log 'opencode v2 (4196) not listening -> started' }
}

# Создание задачи zai-web (запустить один раз от имени пользователя):
# schtasks /create /tn "zai-web" /tr "D:\nodejs\node.exe D:\Portal\zai\server.js" /sc onlogon /f
