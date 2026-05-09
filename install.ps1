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

# node-datachannel native binary fallback if Bun didn't run the postinstall.
$NdDir = Join-Path $BunBin '..\install\global\node_modules\node-datachannel'
if (Test-Path $NdDir) {
    $NdBin = Join-Path $NdDir 'build\Release\node_datachannel.node'
    if (-not (Test-Path $NdBin)) {
        Write-Say "fetching node-datachannel native binary..."
        Push-Location $NdDir
        try {
            bunx prebuild-install -r napi 2>&1 | Out-Null
            if (-not (Test-Path $NdBin)) {
                Write-Err "prebuild-install did not produce $NdBin. Try manually:"
                Write-Err "  cd `"$NdDir`"; npm install --build-from-source"
                exit 1
            }
        } finally {
            Pop-Location
        }
    }
}

Write-Ok "claude-link installed: $($ClaudeLink.Source)"

Write-Say "registering claude-link MCP server with Claude Code (user scope)..."
claude mcp remove --scope user claude-link 2>$null | Out-Null
claude mcp add --scope user claude-link -- claude-link mcp
if ($LASTEXITCODE -ne 0) {
    Write-Err "claude mcp add failed."
    exit $LASTEXITCODE
}
Write-Ok "MCP server registered."

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Set your salt (the shared secret that pairs you with another agent):"
Write-Host "       claude-link config set `"<a long random string>`""
Write-Host "     (Both ends of any link must use the SAME salt - share it out of band.)"
Write-Host ""
Write-Host "  2. Launch Claude through claude-link from now on:"
Write-Host "       claude-link             # instead of `claude`"
Write-Host "       claude-link --resume    # all claude args still work"
Write-Host ""
Write-Host "  3. To uninstall:"
Write-Host "       claude mcp remove --scope user claude-link"
Write-Host "       bun remove -g claude-link"
