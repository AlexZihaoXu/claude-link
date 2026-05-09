$ErrorActionPreference = 'Continue'

function Write-Say($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)  { Write-Host "OK $msg" -ForegroundColor Green }

if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Say "removing claude-link MCP registration..."
    claude mcp remove --scope user claude-link 2>$null | Out-Null
}

if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Say "removing global package..."
    bun remove -g claude-link 2>$null | Out-Null
}

Write-Ok "claude-link uninstalled."
$SaltPath = try { (claude-link config path) 2>$null } catch { '~/.config/claude-link/salt' }
Write-Host "Salt file (kept; remove manually if you want): $SaltPath"
