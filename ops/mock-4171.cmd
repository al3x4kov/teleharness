@echo off
rem QA/design mock instance of zai (fixtures, no auth). Runs detached via schtasks.
set PORT=4171
set ZAI_MOCK=1
cd /d D:\Portal\zai
"D:\nodejs\node.exe" server.js >> "D:\Portal\zai\ops\mock-4171.log" 2>&1
