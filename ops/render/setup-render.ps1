# FEAT-04.12: zai-render on this host — idempotent setup (run as the portal user, admin).
#  1. LibreOffice: administrative extract of the MSI into D:\zai-sandbox\libreoffice
#     (no system registration; winget's machine install failed with 1601 here).
#  2. D:\zai-sandbox\render-tmp — the renderer's private work folder: inheritance off,
#     NO access for AppContainers (S-1-15-2-1), so a tenant can never read another
#     tenant's document copy while it renders.
#  3. The sandbox stub zai-render.cmd (D:\zai-sandbox\python\Scripts): inside a jailed
#     command chain it only explains how to call zai-render as a separate command.
param(
  [string]$Msi = "",
  [string]$Sandbox = "D:\zai-sandbox"
)
$ErrorActionPreference = "Stop"
$lo = Join-Path $Sandbox "libreoffice"
if (-not (Test-Path (Join-Path $lo "program\soffice.com"))) {
  if (-not $Msi) { throw "LibreOffice не найден в $lo — передайте -Msi <LibreOffice_*.msi>" }
  $p = Start-Process msiexec.exe -ArgumentList "/a `"$Msi`" /qn TARGETDIR=$lo" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "msiexec /a: код $($p.ExitCode)" }
}
"libreoffice: " + (& (Join-Path $lo "program\soffice.com") --version)

$tmp = Join-Path $Sandbox "render-tmp"
New-Item -ItemType Directory -Force $tmp | Out-Null
icacls $tmp /inheritance:d /Q | Out-Null
icacls $tmp /remove:g "*S-1-15-2-1" /T /Q | Out-Null
icacls $tmp /remove:g "*S-1-15-2-2" /T /Q | Out-Null
"render-tmp ACL:"; icacls $tmp

Copy-Item -Force (Join-Path $PSScriptRoot "..\sandbox\zai-render.cmd") (Join-Path $Sandbox "python\Scripts\zai-render.cmd")
"stub: " + (Join-Path $Sandbox "python\Scripts\zai-render.cmd")
