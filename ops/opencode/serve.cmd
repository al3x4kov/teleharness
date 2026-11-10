@echo off
rem zai-opencode-serve (prod :4096). Security 2026-11-04 (FEAT-04.10): opencode must not load
rem project config (.opencode/plugins, opencode.json, mcp) from session folders - tenants can
rem write their home from the jail. Global config ~/.config/opencode stays in force.
set OPENCODE_DISABLE_PROJECT_CONFIG=1
rem BUG-180 2026-11-06: opencode caps max_tokens at min(model output, 32000); GLM-5.3 reasoning
rem plus a large file write can hit it and a cut tool call may still report tool_calls.
set OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536
"C:\Users\USER\AppData\Local\Microsoft\WinGet\Links\opencode.exe" serve --hostname 127.0.0.1 --port 4096
