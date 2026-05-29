# scripts/install-shortcut.ps1
#
# Creates a "CloXde" shortcut on the current user's desktop. The shortcut
# launches cloxde-launcher.vbs, which in turn runs cloxde-launcher.bat
# *hidden* — no flashing cmd window, no taskbar console entry. The bat's
# output is redirected to %LOCALAPPDATA%\CloXde\launcher.log if you ever
# need to investigate a startup failure.
#
# Usage from PowerShell at the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
# Or:
#   pnpm shortcut

$ErrorActionPreference = 'Stop'

# Resolve-Path returns a PathInfo; the COM shortcut object insists on strings.
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher    = Join-Path $projectRoot 'cloxde-launcher.vbs'
$iconPath    = Join-Path $projectRoot 'resources\icon.ico'

if (-not (Test-Path $launcher)) {
    Write-Error "Launcher not found at $launcher. Did you run from the project root?"
    exit 1
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$lnkPath  = Join-Path $desktop 'CloXde.lnk'

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
# Run wscript.exe explicitly so the .vbs is dispatched even if the user has
# remapped its default association (some installers do this). The argument
# is the absolute path to our launcher VBS.
$lnk.TargetPath       = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments        = '"' + $launcher + '"'
$lnk.WorkingDirectory = $projectRoot
$lnk.Description      = 'CloXde - Claude + Codex A2A desktop console'
# VBS run-mode handles the hidden-window part; the shortcut itself can be
# the normal style (1) — the wscript host never paints a window when its
# script calls shell.Run(..., 0, ...).
$lnk.WindowStyle      = 1
if (Test-Path $iconPath) {
    $lnk.IconLocation = "$iconPath,0"
}
$lnk.Save()

Write-Host "Created shortcut: $lnkPath"
Write-Host "Target           : wscript.exe `"$launcher`""
Write-Host "Log              : %LOCALAPPDATA%\CloXde\launcher.log"
if (-not (Test-Path $iconPath)) {
    Write-Host ""
    Write-Host "Note: resources\icon.ico not found. The shortcut will use a generic icon."
    Write-Host "      To get the CloXde logo as the shortcut icon, run 'pnpm icon' first."
}
