# Сборка zai-jail.exe из ZaiJail.cs компилятором .NET Framework 4 (FEAT-04.9).
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\sandbox\build.ps1 [-Out <путь к exe>]
# Бинарь не коммитится (.gitignore); прод и стенд берут его из ops\sandbox\zai-jail.exe
# (переопределение — env ZAI_JAIL_EXE у opencode serve).
param([string]$Out = (Join-Path $PSScriptRoot 'zai-jail.exe'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "нет компилятора: $csc" }
$src = Join-Path $PSScriptRoot 'ZaiJail.cs'
$tmp = "$Out.new"
& $csc /nologo /optimize+ /platform:x64 /target:exe "/out:$tmp" $src
if ($LASTEXITCODE -ne 0) { if (Test-Path $tmp) { Remove-Item $tmp -Force }; throw "csc завершился с кодом $LASTEXITCODE" }
# Замена после успешной сборки: работающий запускатель не остаётся без бинаря.
Move-Item -Force $tmp $Out
$h = (Get-FileHash $Out -Algorithm SHA256).Hash.Substring(0, 16)
"zai-jail: $Out ($((Get-Item $Out).Length) байт, sha256 $h)"
