# claude-link uninstaller (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/uninstall.ps1 | iex
#
# Env overrides:
#   $env:KEEP_SALT=1               keep the salt file (default: removed)
#   $env:KEEP_INBOX=1              keep inbox files (default: removed)
#   $env:BUN_INSTALL               override bun install root
#   $env:CLAUDE_HOME               override Claude Code dir
#   $env:CLAUDE_LINK_SALT_FILE     override salt file path

$ErrorActionPreference = 'Continue'

function Write-Say($msg)  { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "OK $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "!  $msg" -ForegroundColor Yellow }

$removed = 0
function Note-Removed($msg) {
    $script:removed++
    Write-Ok $msg
}

# ----- 1. MCP registration -----
if (Get-Command claude -ErrorAction SilentlyContinue) {
    claude mcp remove --scope user claude-link 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Note-Removed "MCP registration removed" }
}

# ----- 2. launcher wrapper -----
$BunBin = if ($env:BUN_INSTALL) { Join-Path $env:BUN_INSTALL 'bin' } else { Join-Path $env:USERPROFILE '.bun\bin' }
foreach ($name in @('claude-link', 'claude-link.cmd', 'claude-link.bunx', 'claude-link.exe')) {
    $p = Join-Path $BunBin $name
    if (Test-Path $p) {
        Remove-Item -Force $p -ErrorAction SilentlyContinue
        if (-not (Test-Path $p)) { Note-Removed "launcher wrapper: $p" }
    }
}

# ----- 3. global bun package -----
if (Get-Command bun -ErrorAction SilentlyContinue) {
    bun remove -g claude-link 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Note-Removed "global package: claude-link" }
}

# ----- 4. skill -----
$SkillDst = if ($env:CLAUDE_HOME) { Join-Path $env:CLAUDE_HOME 'skills\claude-link' } else { Join-Path $env:USERPROFILE '.claude\skills\claude-link' }
if (Test-Path $SkillDst) {
    Remove-Item -Recurse -Force $SkillDst
    Note-Removed "skill: $SkillDst"
}

# ----- 5. permissions in ~/.claude/settings.json -----
if (Get-Command node -ErrorAction SilentlyContinue) {
    $script = @'
const fs = require('fs');
const path = require('path');
const os = require('os');
const p = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
let s; try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { process.exit(2); }
if (!s.permissions || !Array.isArray(s.permissions.allow)) process.exit(2);
const before = s.permissions.allow.length;
s.permissions.allow = s.permissions.allow.filter(e => typeof e !== 'string' || !e.startsWith('mcp__claude-link__'));
if (s.permissions.allow.length === 0) delete s.permissions.allow;
if (Object.keys(s.permissions).length === 0) delete s.permissions;
const removed = before - (s.permissions?.allow?.length ?? 0);
if (removed > 0) { fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n'); process.exit(0); }
process.exit(2);
'@
    node -e $script 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Note-Removed "MCP tool allow-list cleaned from settings.json" }
}

# ----- 6. inbox files -----
$SaltPath = if ($env:CLAUDE_LINK_SALT_FILE) { $env:CLAUDE_LINK_SALT_FILE } else { Join-Path $env:APPDATA 'claude-link\salt' }
$InboxDir = Join-Path (Split-Path $SaltPath -Parent) 'inbox'
if (Test-Path $InboxDir) {
    if ($env:KEEP_INBOX -eq '1') {
        Write-Warn "inbox kept: $InboxDir (`$env:KEEP_INBOX=1)"
    } else {
        Remove-Item -Recurse -Force $InboxDir
        Note-Removed "inbox dir: $InboxDir"
    }
}

# ----- 7. salt -----
if (Test-Path $SaltPath) {
    if ($env:KEEP_SALT -eq '1') {
        Write-Warn "salt kept: $SaltPath (`$env:KEEP_SALT=1)"
    } else {
        Remove-Item -Force $SaltPath
        Note-Removed "salt: $SaltPath"
    }
}

# ----- 8. config dir if empty -----
$ConfigDir = Split-Path $SaltPath -Parent
if ((Test-Path $ConfigDir) -and -not (Get-ChildItem $ConfigDir -Force | Select-Object -First 1)) {
    Remove-Item -Force $ConfigDir
    Note-Removed "empty config dir: $ConfigDir"
}

Write-Host ""
if ($removed -gt 0) {
    Write-Ok "claude-link uninstalled - $removed thing(s) removed."
} else {
    Write-Warn "nothing was removed (claude-link may not have been installed)"
}
