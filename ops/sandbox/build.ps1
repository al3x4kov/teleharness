# Сборка teleharness-jail.exe из TeleharnessJail.cs компилятором .NET Framework 4 (FEAT-04.9).
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\sandbox\build.ps1 [-Out <путь к exe>]
# Бинарь не коммитится (.gitignore); прод и стенд берут его из ops\sandbox\teleharness-jail.exe
# (переопределение — env TELEHARNESS_JAIL_EXE у opencode serve).
param([string]$Out = (Join-Path $PSScriptRoot 'teleharness-jail.exe'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "нет компилятора: $csc" }
$src = Join-Path $PSScriptRoot 'TeleharnessJail.cs'
$tmp = "$Out.new"
& $csc /nologo /optimize+ /platform:x64 /target:exe "/out:$tmp" $src
if ($LASTEXITCODE -ne 0) { if (Test-Path $tmp) { Remove-Item $tmp -Force }; throw "csc завершился с кодом $LASTEXITCODE" }
# Замена после успешной сборки: работающий запускатель не остаётся без бинаря.
Move-Item -Force $tmp $Out
$h = (Get-FileHash $Out -Algorithm SHA256).Hash.Substring(0, 16)
"teleharness-jail: $Out ($((Get-Item $Out).Length) байт, sha256 $h)"
