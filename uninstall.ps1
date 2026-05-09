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

# Best-effort: clean the permissions.allow entries.
if (Get-Command node -ErrorAction SilentlyContinue) {
    $script = @'
const fs = require('fs');
const path = require('path');
const os = require('os');
const p = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
let s; try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { process.exit(0); }
if (!s.permissions || !Array.isArray(s.permissions.allow)) process.exit(0);
s.permissions.allow = s.permissions.allow.filter(e => typeof e !== 'string' || !e.startsWith('mcp__claude-link__'));
if (s.permissions.allow.length === 0) delete s.permissions.allow;
if (Object.keys(s.permissions).length === 0) delete s.permissions;
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
'@
    node -e $script 2>$null | Out-Null
}

$SaltPath = if ($env:CLAUDE_LINK_SALT_FILE) { $env:CLAUDE_LINK_SALT_FILE } else { Join-Path $env:APPDATA 'claude-link\salt' }
Write-Ok "claude-link uninstalled."
Write-Host "Salt file (kept; remove manually if you want): $SaltPath"
