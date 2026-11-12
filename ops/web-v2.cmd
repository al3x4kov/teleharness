@echo off
rem zai-web in v2 mode (FEAT-16.3): the same server.js with the same prod defaults
rem (port 4170, data dir, users.json, cookies) - only the upstream is switched
rem to the opencode v2 serve on :4196.
rem Used as the zai-web task action by the v2 deploy; rollback = the original action
rem D:\nodejs\node.exe D:\Portal\zai\server.js (prod 1.x defaults) + restart zai-web.
set "ZAI_OC_API=v2"
set "ZAI_UPSTREAM=http://127.0.0.1:4196"
rem BUG-190: opencode config of the v2 XDG zone - harness (slim) version for About
set "ZAI_OC_CONFIG_FILE=D:\Portal\zai-oc2\config\opencode\opencode.json"
rem Same serve password as serve-v2.cmd (HTTP Basic opencode:<password>), read from file,
rem never printed; it stays inside the portal process (lib/config.js marks it secret).
set "ZAI_OC_PASSWORD="
set /p ZAI_OC_PASSWORD=<D:\Portal\zai\data\oc2-password.txt
if not defined ZAI_OC_PASSWORD (
  echo [web-v2] password file missing or empty: D:\Portal\zai\data\oc2-password.txt
  exit /b 2
)
echo [web-v2] starting server.js (upstream %ZAI_UPSTREAM%, api %ZAI_OC_API%)
cd /d D:\Portal\zai
D:\nodejs\node.exe D:\Portal\zai\server.js
