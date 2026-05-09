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
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Err "claude not found on PATH. Install Claude Code first: https://claude.com/code"
    exit 1
}

Write-Say "installing claude-link from github:$Repo#$Ref (global)..."
bun install -g "github:$Repo#$Ref"
if ($LASTEXITCODE -ne 0) { Write-Err "bun install failed."; exit $LASTEXITCODE }

# Make sure bun global bin is on PATH for this shell.
$BunBin = if ($env:BUN_INSTALL) { Join-Path $env:BUN_INSTALL 'bin' } else { Join-Path $env:USERPROFILE '.bun\bin' }
if ((Test-Path $BunBin) -and ($env:PATH -notlike "*$BunBin*")) {
    $env:PATH = "$BunBin;$env:PATH"
}

$ClaudeLink = Get-Command claude-link -ErrorAction SilentlyContinue
if (-not $ClaudeLink) {
    Write-Err "claude-link not on PATH after install."
    Write-Err "Bun's global bin is usually at $BunBin. Add it to your PATH and re-run."
    exit 1
}

# node-datachannel + node-pty native binary fallback if Bun didn't run the postinstall.
$GlobalNm = Join-Path (Split-Path $BunBin -Parent) 'install\global\node_modules'
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
