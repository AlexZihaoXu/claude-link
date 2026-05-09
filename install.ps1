# claude-link installer (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/install.ps1 | iex
#
# Env overrides:
#   CLAUDE_LINK_REPO     fork (default: AlexZihaoXu/claude-link)
#   CLAUDE_LINK_REF      git ref (default: main)
#   BUN_INSTALL          override bun's install root
#   CLAUDE_HOME          override Claude Code dir

$ErrorActionPreference = 'Stop'

function Write-Err($msg) { Write-Host "X $msg" -ForegroundColor Red }
function Write-Say($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)  { Write-Host "OK $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Host "! $msg"  -ForegroundColor Yellow }

$Repo = if ($env:CLAUDE_LINK_REPO) { $env:CLAUDE_LINK_REPO } else { 'AlexZihaoXu/claude-link' }
$Ref  = if ($env:CLAUDE_LINK_REF)  { $env:CLAUDE_LINK_REF }  else { 'main' }

# ----- requirements -----
$missing = $false
foreach ($cmd in @('bun', 'node', 'claude')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        switch ($cmd) {
            'bun'    { Write-Err "bun not found - install from https://bun.sh first" }
            'node'   { Write-Err "node not found - install Node.js (>=18) from https://nodejs.org first" }
            'claude' { Write-Err "claude not found - install Claude Code from https://claude.com/code first" }
        }
        $missing = $true
    }
}
if ($missing) { exit 1 }

$bun_v    = (bun --version 2>&1 | Select-Object -First 1)
$node_v   = (node --version 2>&1 | Select-Object -First 1)
$claude_v = (claude --version 2>&1 | Select-Object -First 1)
Write-Say "tools: bun=$bun_v  node=$node_v  claude=$claude_v"

# ----- install package -----
Write-Say "installing claude-link from github:$Repo#$Ref"
bun install -g "github:$Repo#$Ref" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "bun install failed"; exit $LASTEXITCODE }

$BunBin   = if ($env:BUN_INSTALL) { Join-Path $env:BUN_INSTALL 'bin' } else { Join-Path $env:USERPROFILE '.bun\bin' }
$GlobalNm = Join-Path (Split-Path $BunBin -Parent) 'install\global\node_modules'

if ((Test-Path $BunBin) -and ($env:PATH -notlike "*$BunBin*")) {
    $env:PATH = "$BunBin;$env:PATH"
}

if (-not (Get-Command claude-link-mcp -ErrorAction SilentlyContinue)) {
    Write-Err "claude-link-mcp not on PATH after install"
    Write-Err "  bun's global bin is at: $BunBin"
    Write-Err "  add it to your User PATH (System Properties -> Environment Variables)"
    exit 1
}

# ----- launcher wrapper (.cmd that calls Node) -----
$LauncherCjs = Join-Path $GlobalNm 'claude-link\dist\launcher.cjs'
if (-not (Test-Path $LauncherCjs)) {
    Write-Err "missing launcher at $LauncherCjs - install is broken"
    exit 1
}
$WrapperCmd = Join-Path $BunBin 'claude-link.cmd'
$Lines = @(
    '@echo off'
    "node `"$LauncherCjs`" %*"
)
Set-Content -Path $WrapperCmd -Value $Lines -Encoding ascii
Write-Ok "launcher: $WrapperCmd"

# ----- native binary fallback -----
foreach ($pkg in @('node-datachannel', 'node-pty')) {
    $pkgDir = Join-Path $GlobalNm $pkg
    if (Test-Path $pkgDir) {
        $hasNative = Get-ChildItem -Path $pkgDir -Filter '*.node' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $hasNative) {
            Write-Say "fetching prebuilt binary for $pkg"
            Push-Location $pkgDir
            try { bunx prebuild-install -r napi 2>&1 | Out-Null } catch {} finally { Pop-Location }
        }
    }
}

# ----- MCP registration -----
Write-Say "registering claude-link MCP server with Claude Code (user scope)"
claude mcp remove --scope user claude-link 2>$null | Out-Null
claude mcp add --scope user claude-link -- claude-link-mcp 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "claude mcp add failed"; exit $LASTEXITCODE }
Write-Ok "MCP registered"

# ----- skill -----
$SkillSrc = Join-Path $GlobalNm 'claude-link\skills\claude-link'
$SkillDst = if ($env:CLAUDE_HOME) { Join-Path $env:CLAUDE_HOME 'skills\claude-link' } else { Join-Path $env:USERPROFILE '.claude\skills\claude-link' }
if (Test-Path $SkillSrc) {
    New-Item -ItemType Directory -Path (Split-Path $SkillDst -Parent) -Force | Out-Null
    if (Test-Path $SkillDst) { Remove-Item -Recurse -Force $SkillDst }
    Copy-Item -Recurse $SkillSrc $SkillDst
    Write-Ok "skill: $SkillDst"
} else {
    Write-Warn "skill source missing at $SkillSrc - agent guidance won't be available"
}

# ----- permissions -----
$PermScript = Join-Path $GlobalNm 'claude-link\scripts\install-permissions.cjs'
if (Test-Path $PermScript) {
    node $PermScript 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "MCP tools auto-allowed in user settings"
    } else {
        Write-Warn "could not update settings.json - you may see permission prompts"
    }
}

# ----- auto salt -----
$SaltFile = (claude-link-config path 2>$null)
if (-not $SaltFile) { $SaltFile = Join-Path $env:APPDATA 'claude-link\salt' }
$SaltFile = $SaltFile.Trim()
$NeedsSalt = -not (Test-Path $SaltFile -PathType Leaf) -or (Get-Item $SaltFile).Length -eq 0
if ($NeedsSalt -and -not $env:CLAUDE_LINK_SALT) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $SaltVal = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    claude-link-config set $SaltVal | Out-Null
    Write-Ok "salt generated: $SaltFile"
} else {
    Write-Ok "salt: $SaltFile (kept)"
}

# ----- PATH advice -----
$UserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($UserPath -notlike "*$BunBin*") {
    Write-Warn "$BunBin is not on your User PATH for new shells"
    Write-Warn "  add it via: System Properties -> Environment Variables -> User PATH"
}

Write-Host ""
Write-Ok "claude-link is ready."
Write-Host ""
Write-Host "  Launch Claude through it (drop-in replacement for ``claude``):"
Write-Host "      claude-link"
Write-Host "      claude-link --resume"
Write-Host ""
Write-Host "  Helpers:"
Write-Host "      claude-link-config get|set|path"
Write-Host "      claude-link-id [<session-uuid>]"
Write-Host ""
Write-Host "  Uninstall (one-liner):"
Write-Host "      irm https://raw.githubusercontent.com/$Repo/$Ref/uninstall.ps1 | iex"
