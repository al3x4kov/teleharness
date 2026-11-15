# Блок для D:\Apps\watchdog.ps1 — надзор за teleharness (вставить в общий скрипт watchdog)

if (-not (Get-NetTCPConnection -LocalPort 4170 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'teleharness-web') { Start-ScheduledTask -TaskName 'teleharness-web'; Log 'teleharness web (4170) not listening -> started' }
}

# 2026-11-08: prod engine is opencode 2.x (:4196, task teleharness-opencode-v2); 1.x :4096 retired (task disabled)
if (-not (Get-NetTCPConnection -LocalPort 4196 -State Listen -ErrorAction SilentlyContinue)) {
  if (CanRestart 'teleharness-oc2') { Start-ScheduledTask -TaskName 'teleharness-opencode-v2'; Log 'opencode v2 (4196) not listening -> started' }
}

# Создание задачи teleharness-web (запустить один раз от имени пользователя):
# schtasks /create /tn "teleharness-web" /tr "D:\tools\node\node.exe D:\Apps\teleharness\server.js" /sc onlogon /f
