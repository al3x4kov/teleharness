@echo off
rem teleharness-opencode-v2 (prod FEAT-16.3, port 4196). opencode 2.2.6 serve in its own XDG zone
rem D:\Apps\teleharness-oc2 - it never reads the 1.x config at C:\Users\dev\.config\opencode,
rem so 1.x serve (:4096) stays installed and running for instant rollback.
rem Binary: local copy (default D:\Apps\teleharness-oc2\bin\opencode.exe), created and SHA256-checked
rem by ops\deploy\oc2-install.ps1; pass another path as arg 1 to override.
rem Plugin env (users.json, tenant zones, jail, vault) is NOT set here: plugin-v2 / sandbox-core
rem defaults already equal the prod 1.x paths (users.json D:\Apps\teleharness\data\users.json,
rem tenants C:\Users\dev\.teleharness-tenants + D:\Vault\tenants, vault D:\Vault\agents,
rem jail D:\Apps\teleharness\ops\sandbox\teleharness-jail.exe).
set "OC2_BIN=%~1"
if not defined OC2_BIN set "OC2_BIN=D:\Apps\teleharness-oc2\bin\opencode.exe"
if not exist "%OC2_BIN%" (
  echo [serve-v2] binary not found: %OC2_BIN%
  exit /b 2
)
set "XDG_CONFIG_HOME=D:\Apps\teleharness-oc2\config"
set "XDG_DATA_HOME=D:\Apps\teleharness-oc2\data"
set "XDG_STATE_HOME=D:\Apps\teleharness-oc2\state"
set "HOME=D:\Apps\teleharness-oc2\home"
rem Security 2026-11-04 (FEAT-04.10): opencode must not load project config from session
rem folders - tenants can write their home from the jail. Global config only.
set "OPENCODE_DISABLE_PROJECT_CONFIG=1"
rem BUG-180 2026-11-06: opencode caps max_tokens at min(model output, 32000); GLM-5.3 reasoning
rem plus a large file write can hit it and a cut tool call may still report tool_calls.
set "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536"
rem Serve password (HTTP Basic opencode:<password>): read from file into env, never printed.
set "OPENCODE_SERVER_PASSWORD="
set /p OPENCODE_SERVER_PASSWORD=<D:\Apps\teleharness\data\oc2-password.txt
if not defined OPENCODE_SERVER_PASSWORD (
  echo [serve-v2] password file missing or empty: D:\Apps\teleharness\data\oc2-password.txt
  exit /b 2
)
echo [serve-v2] starting %OC2_BIN% on 127.0.0.1:4196 (config %XDG_CONFIG_HOME%\opencode, logs D:\Apps\teleharness-oc2\logs\serve-v2.log)
"%OC2_BIN%" serve --hostname 127.0.0.1 --port 4196 >> "D:\Apps\teleharness-oc2\logs\serve-v2.log" 2>&1
