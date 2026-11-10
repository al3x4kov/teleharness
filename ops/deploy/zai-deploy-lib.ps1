# zai deploy helpers (BUG-157 / BUG-15.8). Dot-source from D:\zai-stage\deploy-*.ps1:
#   . D:\Portal\zai\ops\deploy\zai-deploy-lib.ps1
#
# Why: the 1.11.2 deploy (2026-11-05 00:44) failed twice over in Windows PowerShell 5.1:
#  1. `Invoke-RestMethod http://127.0.0.1:4096/config` returns a RAW STRING for opencode's
#     ~1 MB config (the JSON cannot be turned into a PSObject), so `.snapshot` was $null and a
#     healthy deploy was judged FAILED.
#  2. The rollback copy was made with `git show <rev>:<file> | Set-Content -Encoding utf8`:
#     the pipeline decodes git's UTF-8 output with the OEM code page, so the "backup" had a BOM
#     and mojibake Cyrillic, and the rollback put those files into the working tree (and prod).
# Rules: JSON is read by node, never by Invoke-RestMethod; files are restored by git itself
# (`git restore --source`), never through a PowerShell pipeline.

$ZaiNode = 'D:\nodejs\node.exe'

# Value of a (dot-separated) field of a JSON endpoint as JSON text: 'false', '"x"', '12',
# '<absent>' when the field is missing, '<error: ...>' when the request or the parse failed.
function Get-ZaiJsonValue {
  param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Field, [int]$TimeoutSec = 30)
  # No double quotes inside: Windows PowerShell 5.1 does not escape them for native arguments.
  $code = 'const [u, f, t] = process.argv.slice(1); try { const r = await fetch(u, { signal: AbortSignal.timeout(Number(t) * 1000) }); let v = await r.json(); for (const k of f.split(`.`)) v = v == null ? undefined : v[k]; console.log(v === undefined ? `<absent>` : JSON.stringify(v)); } catch (e) { console.log(`<error: ${e.message}>`); }'
  $out = & $ZaiNode --input-type=module -e $code $Uri $Field $TimeoutSec 2>&1
  return [string]($out | Select-Object -Last 1)
}

# Restore $Files (repo-relative, \ or /) to their content at $Rev, byte for byte, without
# touching the index. Files absent at $Rev are left as they are (an older server does not
# import them). Returns the list of restored paths.
function Restore-ZaiFromGit {
  param([Parameter(Mandatory)][string]$Rev, [Parameter(Mandatory)][string[]]$Files, [string]$Repo = 'D:\Portal\zai')
  $present = @()
  foreach ($f in $Files) {
    $g = $f -replace '\\', '/'
    & git -C $Repo cat-file -e "${Rev}:$g" 2>$null
    if ($LASTEXITCODE -eq 0) { $present += $g }
  }
  if ($present.Count -gt 0) {
    & git -C $Repo restore "--source=$Rev" --worktree -- @present
    if ($LASTEXITCODE -ne 0) { throw "git restore --source=$Rev failed ($LASTEXITCODE)" }
  }
  return $present
}

# BUG-183 (BUG-12.25): after serve restarts the DEFAULT opencode instance (no `directory` = the serve's
# cwd, C:\Windows\System32 on prod) answered GET /mcp with 499 and an empty body. Call this after every
# zai-opencode-serve restart: a failing /mcp -> POST /instance/dispose (default instance) -> check again.
# Returns @{ Ok = $bool; Text = 'one line for the deploy log' }. JSON is read by node (BUG-157 rule).
# TimeoutSec 120 > opencode MCP connect timeout (30 s): aborting /mcp during the MCP init would itself poison
# the instance (InstanceState caches the interruption).
function Test-ZaiOpencodeMcp {
  param([string]$Base = 'http://127.0.0.1:4096', [int]$TimeoutSec = 120)
  # No double quotes inside: Windows PowerShell 5.1 does not escape them for native arguments.
  $code = 'const [b, t] = process.argv.slice(1); try { const r = await fetch(b + `/mcp`, { signal: AbortSignal.timeout(Number(t) * 1000) }); const s = await r.text(); if (!r.ok || !s.trim()) { console.log(`HTTP ` + r.status + (s.trim() ? `` : ` empty`)); } else { const j = JSON.parse(s); console.log(`OK ` + Object.entries(j).map(([k, v]) => k + `=` + (v && v.status)).join(` `)); } } catch (e) { console.log(`ERR ` + e.message); }'
  $first = [string](& $ZaiNode --input-type=module -e $code $Base $TimeoutSec 2>&1 | Select-Object -Last 1)
  if ($first -like 'OK *') { return @{ Ok = $true; Text = "mcp: $($first.Substring(3))" } }
  try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Base/instance/dispose" -TimeoutSec 15 | Out-Null } catch {}
  Start-Sleep -Seconds 3
  $second = [string](& $ZaiNode --input-type=module -e $code $Base $TimeoutSec 2>&1 | Select-Object -Last 1)
  if ($second -like 'OK *') { return @{ Ok = $true; Text = "mcp: $first -> dispose default instance -> $($second.Substring(3))" } }
  return @{ Ok = $false; Text = "mcp: $first; after dispose of the default instance: $second" }
}
