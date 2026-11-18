@echo off
rem QA/design mock instance of Teleharness (fixtures, no auth). Runs detached via schtasks.
set PORT=4171
set TELEHARNESS_MOCK=1
cd /d D:\Apps\teleharness
"D:\tools\node\node.exe" server.js >> "D:\Apps\teleharness\ops\mock-4171.log" 2>&1
