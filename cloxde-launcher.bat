@echo off
REM CloXde launcher - runs the project in dev mode from its checkout.
REM Triggered by the desktop shortcut (via cloxde-launcher.vbs, which starts
REM this with no console window). We invoke electron-vite directly to avoid
REM the Unix-only env -u prefix that the package.json dev script uses.

setlocal
cd /d "%~dp0"

REM Some parent processes (e.g. an IDE-spawned shell) export
REM ELECTRON_RUN_AS_NODE=1, which makes Electron boot as plain Node - then
REM require('electron').app is undefined and the main process dies with
REM "Cannot read properties of undefined (reading whenReady)". Clear it for
REM this launch only.
set "ELECTRON_RUN_AS_NODE="

REM Log to a stable location so a silent (windowless) launch stays
REM diagnosable: notepad %LOCALAPPDATA%\CloXde\launcher.log
set "LOG_DIR=%LOCALAPPDATA%\CloXde"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\launcher.log"

if not exist "%~dp0node_modules\.bin\electron-vite.cmd" (
    echo [CloXde] node_modules not found. Run "pnpm install" once first.> "%LOG_FILE%"
    exit /b 1
)

REM Redirect here (not in the VBS wrapper) so the launch path is a single
REM quoted command with no fragile nested-quote handoff to cmd /c.
call "%~dp0node_modules\.bin\electron-vite.cmd" dev > "%LOG_FILE%" 2>&1
