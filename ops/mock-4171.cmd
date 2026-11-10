@echo off
rem QA/design mock instance of teleharness (fixtures, no auth). Runs detached via schtasks.
set PORT=4171
set TELEHARNESS_MOCK=1
cd /d D:\Portal\teleharness
"D:\nodejs\node.exe" server.js >> "D:\Portal\teleharness\ops\mock-4171.log" 2>&1
