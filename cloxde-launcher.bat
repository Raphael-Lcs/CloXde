@echo off
REM CloXde launcher - thin wrapper around the Node.js supervisor.
REM
REM All the real lifecycle logic (watchdog loop, exit-intent handling,
REM crash-loop detection, conservative self-mod rollback, last-good tracking)
REM lives in scripts\supervisor.mjs. Batch proved too fragile for that logic,
REM so this file does only two things: pick the right working dir and launch
REM the supervisor under Node. The supervisor writes the detailed log to
REM %LOCALAPPDATA%\CloXde\launcher.log; this wrapper's own output (e.g. a
REM "node not found" error before the supervisor starts) goes to launcher-boot.log.
REM
REM Triggered by the desktop shortcut via cloxde-launcher.vbs (hidden window).

cd /d "%~dp0"

REM Electron must boot as Electron, not plain Node (the supervisor re-clears this
REM for the child too, but clear it here for safety).
set "ELECTRON_RUN_AS_NODE="

set "LOG_DIR=%LOCALAPPDATA%\CloXde"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "BOOT_LOG=%LOG_DIR%\launcher-boot.log"

node "%~dp0scripts\supervisor.mjs" > "%BOOT_LOG%" 2>&1
