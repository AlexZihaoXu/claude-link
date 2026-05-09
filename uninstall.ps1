$ErrorActionPreference = 'Continue'

function Write-Say($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)  { Write-Host "OK $msg" -ForegroundColor Green }

if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Say "removing claude-link MCP registration..."
    claude mcp remove --scope user claude-link 2>$null | Out-Null
}

$BunBin = if ($env:BUN_INSTALL) { Join-Path $env:BUN_INSTALL 'bin' } else { Join-Path $env:USERPROFILE '.bun\bin' }
$WrapperCmd = Join-Path $BunBin 'claude-link.cmd'
if (Test-Path $WrapperCmd) {
    Write-Say "removing claude-link launcher wrapper..."
    Remove-Item $WrapperCmd
}

if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Say "removing global package..."
    bun remove -g claude-link 2>$null | Out-Null
}

$SkillDst = if ($env:CLAUDE_HOME) { Join-Path $env:CLAUDE_HOME 'skills\claude-link' } else { Join-Path $env:USERPROFILE '.claude\skills\claude-link' }
if (Test-Path $SkillDst) {
    Write-Say "removing skill at $SkillDst..."
    Remove-Item -Recurse -Force $SkillDst
}

Write-Ok "claude-link uninstalled."
$SaltPath = try { (claude-link config path) 2>$null } catch { '~/.config/claude-link/salt' }
Write-Host "Salt file (kept; remove manually if you want): $SaltPath"
