@echo off
REM CloXde launcher — runs the project in dev mode from its checkout.
REM Triggered by the desktop shortcut. We invoke electron-vite directly to
REM avoid the Unix-only `env -u …` prefix the package.json `dev` script uses.

setlocal
cd /d "%~dp0"

REM Some users have ELECTRON_RUN_AS_NODE=1 set globally, which would force
REM Electron to start as plain Node. Clear it for this launch only.
set "ELECTRON_RUN_AS_NODE="

if not exist "%~dp0node_modules\.bin\electron-vite.cmd" (
    echo [CloXde] node_modules not found. Run "pnpm install" once first.
    pause
    exit /b 1
)

call "%~dp0node_modules\.bin\electron-vite.cmd" dev
