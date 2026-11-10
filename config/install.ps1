<#
.SYNOPSIS
  Раскладывает конфиги Claude Code и opencode из репозитория по местам
  и подставляет секреты из переменных окружения.

.DESCRIPTION
  config/claude/*   -> ~/.claude/
  config/opencode/* -> ~/.config/opencode/
  Секреты берутся ТОЛЬКО из env: CLAUDE_CODE_OAUTH_TOKEN, OPENCODE_SERVER_PASSWORD.
  Существующие файлы сохраняются рядом с суффиксом .bak-<время>.

.EXAMPLE
  $env:CLAUDE_CODE_OAUTH_TOKEN = '...'; $env:OPENCODE_SERVER_PASSWORD = '...'
  ./config/install.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$ClaudeHome   = (Join-Path $HOME '.claude'),
  [string]$OpencodeHome = (Join-Path $HOME '.config\opencode')
)
$ErrorActionPreference = 'Stop'
$here  = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Copy-Tree([string]$From, [string]$To) {
  New-Item -ItemType Directory -Force $To | Out-Null
  Get-ChildItem -Force $From | Where-Object { $_.Name -notlike '*.example.json' } | ForEach-Object {
    $target = Join-Path $To $_.Name
    if ((Test-Path $target) -and -not $_.PSIsContainer) { Copy-Item $target "$target.bak-$stamp" }
    if ($PSCmdlet.ShouldProcess($target, 'copy')) { Copy-Item -Recurse -Force $_.FullName $target }
  }
}

Copy-Tree (Join-Path $here 'claude')   $ClaudeHome
Copy-Tree (Join-Path $here 'opencode') $OpencodeHome

# Claude: токен подписки — в env settings.json (CLI читает и из окружения процесса).
if ($env:CLAUDE_CODE_OAUTH_TOKEN) {
  $p = Join-Path $ClaudeHome 'settings.json'
  $j = Get-Content $p -Raw -Encoding utf8 | ConvertFrom-Json
  $j | Add-Member -Force -NotePropertyName env -NotePropertyValue ([pscustomobject]@{ CLAUDE_CODE_OAUTH_TOKEN = $env:CLAUDE_CODE_OAUTH_TOKEN })
  $j | ConvertTo-Json -Depth 20 | Set-Content $p -Encoding utf8
} else { Write-Warning 'CLAUDE_CODE_OAUTH_TOKEN не задан — claude CLI попросит войти (claude /login).' }

# opencode: service.json из шаблона.
if ($env:OPENCODE_SERVER_PASSWORD) {
  @{ password = $env:OPENCODE_SERVER_PASSWORD } | ConvertTo-Json | Set-Content (Join-Path $OpencodeHome 'service.json') -Encoding utf8
} else { Write-Warning 'OPENCODE_SERVER_PASSWORD не задан — service.json не создан.' }

# MCP-серверы Claude: смержить в ~/.claude.json вручную или `claude mcp add-json`.
Write-Host "Готово. MCP-серверы Claude: см. config/claude/mcp-servers.json (claude mcp add-json ...)."
Write-Host "Зависимости opencode: cd '$OpencodeHome'; npm install"
