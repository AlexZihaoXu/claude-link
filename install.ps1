# claude-link installer (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/install.ps1 | iex
#
# Or with a fork / branch:
#   $env:CLAUDE_LINK_REPO = 'foo/claude-link'
#   $env:CLAUDE_LINK_REF  = 'dev'
#   irm https://raw.githubusercontent.com/foo/claude-link/dev/install.ps1 | iex

$ErrorActionPreference = 'Stop'

function Write-Err($msg) { Write-Host "X $msg" -ForegroundColor Red }
function Write-Say($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)  { Write-Host "OK $msg" -ForegroundColor Green }

$Repo = if ($env:CLAUDE_LINK_REPO) { $env:CLAUDE_LINK_REPO } else { 'AlexZihaoXu/claude-link' }
$Ref  = if ($env:CLAUDE_LINK_REF)  { $env:CLAUDE_LINK_REF }  else { 'main' }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Err "bun not found on PATH. Install it from https://bun.sh first."
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "node not found on PATH. Install Node.js (>=18) first: https://nodejs.org"
    exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Err "claude not found on PATH. Install Claude Code first: https://claude.com/code"
    exit 1
}

Write-Say "installing claude-link from github:$Repo#$Ref (global)..."
bun install -g "github:$Repo#$Ref"
if ($LASTEXITCODE -ne 0) { Write-Err "bun install failed."; exit $LASTEXITCODE }

# Make sure bun global bin is on PATH for this shell.
$BunBin = if ($env:BUN_INSTALL) { Join-Path $env:BUN_INSTALL 'bin' } else { Join-Path $env:USERPROFILE '.bun\bin' }
$GlobalNm = Join-Path (Split-Path $BunBin -Parent) 'install\global\node_modules'
if ((Test-Path $BunBin) -and ($env:PATH -notlike "*$BunBin*")) {
    $env:PATH = "$BunBin;$env:PATH"
}

$ClaudeLinkMcp = Get-Command claude-link-mcp -ErrorAction SilentlyContinue
if (-not $ClaudeLinkMcp) {
    Write-Err "claude-link-mcp not on PATH after install."
    Write-Err "Bun's global bin is usually at $BunBin. Add it to your PATH and re-run."
    exit 1
}

# The launcher runs on Node, not Bun. Drop a .cmd wrapper.
$LauncherCjs = Join-Path $GlobalNm 'claude-link\dist\launcher.cjs'
if (-not (Test-Path $LauncherCjs)) {
    Write-Err "missing launcher at $LauncherCjs - install is broken."
    exit 1
}
$WrapperCmd = Join-Path $BunBin 'claude-link.cmd'
Write-Say "creating claude-link launcher wrapper at $WrapperCmd..."
$Lines = @(
    '@echo off'
    "node `"$LauncherCjs`" %*"
)
Set-Content -Path $WrapperCmd -Value $Lines -Encoding ascii

# node-datachannel + node-pty native binary fallback if Bun didn't run the postinstall.
foreach ($pkg in @('node-datachannel', 'node-pty')) {
    $pkgDir = Join-Path $GlobalNm $pkg
    if (Test-Path $pkgDir) {
        $hasNative = Get-ChildItem -Path $pkgDir -Filter '*.node' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $hasNative) {
            Write-Say "fetching prebuilt binary for $pkg..."
            Push-Location $pkgDir
            try {
                bunx prebuild-install -r napi 2>&1 | Out-Null
            } catch {} finally { Pop-Location }
        }
    }
}

Write-Ok "claude-link installed: $($ClaudeLink.Source)"

# Register the MCP server.
Write-Say "registering claude-link MCP server with Claude Code (user scope)..."
claude mcp remove --scope user claude-link 2>$null | Out-Null
claude mcp add --scope user claude-link -- claude-link-mcp
if ($LASTEXITCODE -ne 0) {
    Write-Err "claude mcp add failed."
    exit $LASTEXITCODE
}
Write-Ok "MCP server registered."

# Install the skill so the agent knows what claude-link is and when to use it.
$SkillSrc = Join-Path $GlobalNm 'claude-link\skills\claude-link'
$SkillDst = if ($env:CLAUDE_HOME) { Join-Path $env:CLAUDE_HOME 'skills\claude-link' } else { Join-Path $env:USERPROFILE '.claude\skills\claude-link' }
if (Test-Path $SkillSrc) {
    Write-Say "installing claude-link skill at $SkillDst..."
    New-Item -ItemType Directory -Path (Split-Path $SkillDst -Parent) -Force | Out-Null
    if (Test-Path $SkillDst) { Remove-Item -Recurse -Force $SkillDst }
    Copy-Item -Recurse $SkillSrc $SkillDst
    Write-Ok "skill installed."
} else {
    Write-Err "skill source not found at $SkillSrc - agent guidance won't be available, but tools will still work."
}

# Auto-allow claude-link MCP tools so the agent doesn't ask for permission.
$PermScript = Join-Path $GlobalNm 'claude-link\scripts\install-permissions.cjs'
if (Test-Path $PermScript) {
    Write-Say "auto-allowing claude-link tools in user settings..."
    node $PermScript
    if ($LASTEXITCODE -ne 0) {
        Write-Err "could not update settings.json - you may see permission prompts"
    }
}

# Auto-generate a salt if none exists.
$SaltFile = (claude-link-config path).Trim()
$NeedsSalt = -not (Test-Path $SaltFile -PathType Leaf) -or (Get-Item $SaltFile).Length -eq 0
if ($NeedsSalt -and -not $env:CLAUDE_LINK_SALT) {
    Write-Say "generating a random salt at $SaltFile..."
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $SaltVal = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    claude-link-config set $SaltVal | Out-Null
    Write-Ok "salt written. Share it (Get-Content '$SaltFile') with anyone you want to link with."
} else {
    Write-Ok "existing salt detected - kept as-is."
}

Write-Host ""
Write-Ok "claude-link is ready. Launch Claude through it from now on:"
Write-Host "    claude-link             # instead of `claude`"
Write-Host "    claude-link --resume    # all claude args still work"
Write-Host ""
Write-Host "Helper commands:"
Write-Host "    claude-link-config get|set|path"
Write-Host "    claude-link-id [<session-uuid>]"
Write-Host ""
Write-Host "Uninstall:"
Write-Host "    claude mcp remove --scope user claude-link"
Write-Host "    bun remove -g claude-link"
