# FEAT-16.3 step 9: one-time provisioning of prod opencode v2 (2.2.6).
# Writes files and registers the autostart task ONLY - starts nothing, restarts nothing:
# prod 1.x serve (:4096, task zai-opencode-serve) and zai-web keep running until the
# owner-approved cutover (start the v2 task manually, then switch web via ops\web-v2.cmd).
# Idempotent: re-run refreshes copied files and the task, keeps the existing password.
# ASCII-only on purpose: Windows PowerShell 5.1 without BOM reads non-ASCII as ANSI.
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\Portal\zai\ops\deploy\oc2-install.ps1
#            [-Binary <opencode.exe>] [-ExpectedSha256 <hex>] [-Root D:\Portal\zai-oc2]
#            [-PasswordFile D:\Portal\zai\data\oc2-password.txt] [-Repo D:\Portal\zai]
#            [-AgentSkillsRoot <plugin cache dir>]
param(
  [string]$Binary = "D:\zai-tmp-scripts\oc2-dl\bin\opencode.exe",
  [string]$Root = "D:\Portal\zai-oc2",
  [string]$PasswordFile = "D:\Portal\zai\data\oc2-password.txt",
  [string]$Repo = "D:\Portal\zai",
  [string]$ExpectedSha256 = "",
  [string]$AgentSkillsRoot = ""
)
$ErrorActionPreference = "Stop"
function Say([string]$m) { Write-Host "[oc2-install] $m" }
function Fail([string]$m) { Write-Host "[oc2-install] FAIL: $m"; exit 1 }

# ---- 1) binary: SHA256-checked copy into the v2 zone -------------------------
# Source hash must match the pin (-ExpectedSha256, from the oc2-dl download record)
# when given; the copy is then verified byte-identical by hash.
if (-not (Test-Path $Binary)) { Fail "binary not found: $Binary" }
$srcHash = (Get-FileHash -Algorithm SHA256 $Binary).Hash
if ($ExpectedSha256 -and $srcHash -ne $ExpectedSha256) { Fail "SHA256 mismatch for $($Binary): $srcHash" }
New-Item -ItemType Directory -Force -Path "$Root\bin" | Out-Null
$dstBin = "$Root\bin\opencode.exe"
Copy-Item $Binary $dstBin -Force
$dstHash = (Get-FileHash -Algorithm SHA256 $dstBin).Hash
if ($dstHash -ne $srcHash) { Fail "binary copy corrupted: $dstHash" }
Say "binary: ok ($dstHash)"

# ---- 2) serve password: generate once, ACL to the current user, never printed -
# Written WITHOUT trailing newline as UTF-8 no BOM: serve-v2.cmd / web-v2.cmd read it
# with `set /p`, which would keep a CR/spaces as part of the password otherwise.
if (Test-Path $PasswordFile) {
  Say "password: exists (kept)"
} else {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $pw = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant() # 64 hex chars
  [IO.File]::WriteAllText($PasswordFile, $pw, [Text.UTF8Encoding]::new($false))
  Say "password: generated (64 hex chars) -> $PasswordFile"
}
& icacls $PasswordFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "icacls failed on $PasswordFile" }
Say "password: ACL set (current user only)"

# ---- 3) XDG zone --------------------------------------------------------------
foreach ($d in @("config", "data", "state", "home", "logs", "config\opencode")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null
}
Say "xdg: $Root\{config,data,state,home,logs}"

# ---- 4) config zone (same layout as the v2 stand, prod paths) -----------------
# opencode.v2.json already carries prod paths (instructions D:\Obsidian\agents\_index.md,
# Sandbox allow-zone D:\Obsidian\tenants\*); the only patch: glm-rules.md points to the
# copy placed NEXT TO this config (same marker-patch as stand-v2.ps1), so the v2 zone
# does not depend on the 1.x config dir.
$cfg = "$Root\config\opencode"
$doc = [IO.File]::ReadAllText("$Repo\ops\opencode\opencode.v2.json")
$oldRules = "C:\\Users\\USER\\.config\\opencode\\prompts\\glm-rules.md"
$newRules = $cfg.Replace("\", "\\") + "\\prompts\\glm-rules.md"
if (-not $doc.Contains($oldRules)) { Fail "glm-rules marker not found in opencode.v2.json" }
$doc = $doc.Replace($oldRules, $newRules)
try { $null = $doc | ConvertFrom-Json } catch { Fail "patched config is not valid JSON: $_" }
[IO.File]::WriteAllText("$cfg\opencode.json", $doc, [Text.UTF8Encoding]::new($false))
Say "config: opencode.json written (glm-rules -> v2 zone copy)"

New-Item -ItemType Directory -Force -Path "$cfg\plugin-v2" | Out-Null
Copy-Item "$Repo\ops\opencode\plugin-v2\*" "$cfg\plugin-v2\" -Force
# plugin-v2/index.ts imports "../sandbox-core/index.mjs" - core goes next to the plugin
New-Item -ItemType Directory -Force -Path "$cfg\sandbox-core" | Out-Null
Copy-Item "$Repo\ops\opencode\sandbox-core\*" "$cfg\sandbox-core\" -Force
New-Item -ItemType Directory -Force -Path "$cfg\prompts" | Out-Null
Copy-Item "$Repo\ops\opencode\prompts\*.md" "$cfg\prompts\" -Force
New-Item -ItemType Directory -Force -Path "$cfg\skills" | Out-Null
Copy-Item "$Repo\ops\opencode\skills\zai-*" "$cfg\skills\" -Force -Recurse
Copy-Item "$Repo\ops\opencode\oh-my-opencode-slim.json" "$cfg\oh-my-opencode-slim.json" -Force
Say "layout: plugin-v2 + sandbox-core + prompts + skills zai-* + slim json"

# ---- 5) agent-skills: skills + references + as-* agents + as-* commands --------
# Same installer as prod 1.x; second arg is the target config dir (here: the v2 zone).
if (-not $AgentSkillsRoot) {
  $base = "$env:USERPROFILE\.claude\plugins\cache\addy-agent-skills\agent-skills"
  $cand = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "skills") } |
    Sort-Object { try { [version]$_.Name } catch { $_.Name } } -ErrorAction SilentlyContinue
  if ($cand) { $AgentSkillsRoot = ($cand | Select-Object -Last 1).FullName }
}
if ($AgentSkillsRoot -and (Test-Path (Join-Path $AgentSkillsRoot "skills"))) {
  $node = if (Test-Path "D:\nodejs\node.exe") { "D:\nodejs\node.exe" } else { "node" }
  & $node "$Repo\ops\opencode\agent-skills-opencode.mjs" $AgentSkillsRoot $cfg
  if ($LASTEXITCODE -ne 0) { Fail "agent-skills installer exit $LASTEXITCODE" }
  Say "agent-skills: installed from $AgentSkillsRoot"
} else {
  Say "agent-skills: SKIPPED (plugin cache not found; install agent-skills@addy-agent-skills and re-run)"
}

# ---- 6) autostart task zai-opencode-v2 (S4U, at startup like zai-opencode-serve): registered, NOT started -
# Mirrors the 1.x pattern (tasks zai-opencode-serve / zai-web are S4U, boot trigger).
$act = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Repo\ops\opencode\serve-v2.cmd`""
$trg = New-ScheduledTaskTrigger -AtStartup
$prn = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName "zai-opencode-v2" -Action $act -Trigger $trg -Principal $prn -Force | Out-Null
Say "task: zai-opencode-v2 registered (S4U, at startup) - NOT started"
Say "done. cutover is a manual step (owner decision): start task zai-opencode-v2, then zai-web with ops\web-v2.cmd"
