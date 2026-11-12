@echo off
rem teleharness-web in v2 mode (FEAT-16.3): the same server.js with the same prod defaults
rem (port 4170, data dir, users.json, cookies) - only the upstream is switched
rem to the opencode v2 serve on :4196.
rem Used as the teleharness-web task action by the v2 deploy; rollback = the original action
rem D:\nodejs\node.exe D:\Portal\teleharness\server.js (prod 1.x defaults) + restart teleharness-web.
set "TELEHARNESS_OC_API=v2"
set "TELEHARNESS_UPSTREAM=http://127.0.0.1:4196"
rem BUG-190: opencode config of the v2 XDG zone - harness (slim) version for About
set "TELEHARNESS_OC_CONFIG_FILE=D:\Portal\teleharness-oc2\config\opencode\opencode.json"
rem Same serve password as serve-v2.cmd (HTTP Basic opencode:<password>), read from file,
rem never printed; it stays inside the portal process (lib/config.js marks it secret).
set "TELEHARNESS_OC_PASSWORD="
set /p TELEHARNESS_OC_PASSWORD=<D:\Portal\teleharness\data\oc2-password.txt
if not defined TELEHARNESS_OC_PASSWORD (
  echo [web-v2] password file missing or empty: D:\Portal\teleharness\data\oc2-password.txt
  exit /b 2
)
echo [web-v2] starting server.js (upstream %TELEHARNESS_UPSTREAM%, api %TELEHARNESS_OC_API%)
cd /d D:\Portal\teleharness
D:\nodejs\node.exe D:\Portal\teleharness\server.js
