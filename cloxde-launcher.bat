@echo off
REM CloXde watchdog launcher - supervises the app in dev mode with self-mod
REM crash-loop protection. Runs in a loop: starts the app, waits for exit, and
REM on repeated crashes (exit code != 0 within CRASH_THRESHOLD_SEC) triggers a
REM conservative rollback IF the current HEAD is a self-mod promoted commit.
REM
REM Triggered by the desktop shortcut (via cloxde-launcher.vbs). We invoke
REM electron-vite directly to avoid the Unix-only env -u prefix in package.json.
REM
REM Exit codes the app can use to signal intent:
REM   0  = clean shutdown (user quit via tray, or smoke-boot self-exit)
REM   42 = self-mod promotion succeeded; watchdog should restart immediately
REM   other nonzero = crash; watchdog counts toward crash-loop threshold

setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Clear ELECTRON_RUN_AS_NODE so Electron boots as Electron, not plain Node.
set "ELECTRON_RUN_AS_NODE="

REM Stable log location for silent (windowless) launches.
set "LOG_DIR=%LOCALAPPDATA%\CloXde"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\launcher.log"
set "WATCHDOG_STATE=%LOG_DIR%\watchdog-state.txt"

REM Crash-loop thresholds: if the app exits nonzero N times within T seconds,
REM trigger rollback (when HEAD is a self-mod commit).
set CRASH_THRESHOLD=3
set CRASH_WINDOW_SEC=60

REM last-good tracking: the commit we roll back TO when a promoted run crashes.
REM Initialized from watchdog-state.txt (persists across launcher restarts) or
REM defaults to current HEAD on first boot. Updated only on a clean run (the
REM app stayed up > STABLE_UPTIME_SEC without crashing).
set STABLE_UPTIME_SEC=120
set "LAST_GOOD_COMMIT="

if exist "%WATCHDOG_STATE%" (
    for /f "usebackq tokens=*" %%a in ("%WATCHDOG_STATE%") do set "LAST_GOOD_COMMIT=%%a"
)
if "%LAST_GOOD_COMMIT%"=="" (
    REM First boot or state lost → snapshot current HEAD as the baseline.
    for /f "usebackq tokens=*" %%a in (`git rev-parse HEAD 2^>nul`) do set "LAST_GOOD_COMMIT=%%a"
    if not "!LAST_GOOD_COMMIT!"=="" (
        echo !LAST_GOOD_COMMIT!> "%WATCHDOG_STATE%"
    )
)

REM Crash history: timestamps of recent nonzero exits (epoch seconds). We keep
REM a rolling window and count how many fall within CRASH_WINDOW_SEC of now.
set "CRASH_TIMES="

echo [%date% %time%] CloXde watchdog starting. last-good=%LAST_GOOD_COMMIT%> "%LOG_FILE%"

if not exist "%~dp0node_modules\.bin\electron-vite.cmd" (
    echo [CloXde] node_modules not found. Run "pnpm install" once first.>> "%LOG_FILE%"
    exit /b 1
)

:LOOP
    echo.>> "%LOG_FILE%"
    echo [%date% %time%] --- Starting app --->> "%LOG_FILE%"
    set START_TIME=%TIME%

    REM Run the app. Redirect its output to the log; capture its exit code.
    call "%~dp0node_modules\.bin\electron-vite.cmd" dev >> "%LOG_FILE%" 2>&1
    set EXIT_CODE=!ERRORLEVEL!

    REM Compute uptime (rough heuristic: if START_TIME and now are far apart, it
    REM was a long-lived run). We parse HH:MM:SS into seconds. This is inexact
    REM (doesn't handle midnight wrap, subsecond precision) but sufficient for
    REM "did it stay up > 2 minutes" vs "crashed in 5 seconds".
    set END_TIME=%TIME%
    call :TIME_TO_SEC !START_TIME! START_SEC
    call :TIME_TO_SEC !END_TIME! END_SEC
    set /a UPTIME_SEC=!END_SEC! - !START_SEC!
    if !UPTIME_SEC! lss 0 set /a UPTIME_SEC=!UPTIME_SEC! + 86400

    echo [%date% %time%] App exited: code=!EXIT_CODE!, uptime=!UPTIME_SEC!s>> "%LOG_FILE%"

    REM Exit code 0 = clean shutdown. If uptime was long enough, promote current
    REM HEAD to last-good (the app is stable). Then stop the loop (user quit).
    if !EXIT_CODE! equ 0 (
        if !UPTIME_SEC! geq %STABLE_UPTIME_SEC% (
            for /f "usebackq tokens=*" %%a in (`git rev-parse HEAD 2^>nul`) do (
                set "LAST_GOOD_COMMIT=%%a"
                echo !LAST_GOOD_COMMIT!> "%WATCHDOG_STATE%"
                echo [%date% %time%] Stable run; last-good updated to !LAST_GOOD_COMMIT!>> "%LOG_FILE%"
            )
        )
        echo [%date% %time%] Clean exit; stopping watchdog.>> "%LOG_FILE%"
        goto :EOF
    )

    REM Exit code 42 = self-mod promotion; restart immediately without counting
    REM as a crash. The new code is now at HEAD; we do NOT update last-good yet
    REM (it must prove stable first).
    if !EXIT_CODE! equ 42 (
        echo [%date% %time%] Self-mod promotion; restarting onto new code.>> "%LOG_FILE%"
        goto :LOOP
    )

    REM Any other nonzero = crash. Record the timestamp and check if we've hit
    REM the crash-loop threshold.
    for /f "usebackq" %%a in (`powershell -NoProfile -Command "[int][double]::Parse((Get-Date -UFormat %%s))"`) do set NOW_EPOCH=%%a
    set "CRASH_TIMES=!CRASH_TIMES! !NOW_EPOCH!"

    REM Prune old crashes outside the window.
    set /a WINDOW_START=!NOW_EPOCH! - %CRASH_WINDOW_SEC%
    set "PRUNED="
    for %%t in (!CRASH_TIMES!) do (
        if %%t geq !WINDOW_START! set "PRUNED=!PRUNED! %%t"
    )
    set "CRASH_TIMES=!PRUNED!"

    REM Count recent crashes.
    set CRASH_COUNT=0
    for %%t in (!CRASH_TIMES!) do set /a CRASH_COUNT+=1

    echo [%date% %time%] Crash count in last %CRASH_WINDOW_SEC%s: !CRASH_COUNT!>> "%LOG_FILE%"

    if !CRASH_COUNT! geq %CRASH_THRESHOLD% (
        echo [%date% %time%] Crash-loop detected.>> "%LOG_FILE%"
        REM Conservative rollback: only if HEAD is a self-mod promoted commit.
        call :CHECK_SELFMOD_HEAD IS_SELFMOD
        if "!IS_SELFMOD!"=="1" (
            if not "!LAST_GOOD_COMMIT!"=="" (
                echo [%date% %time%] HEAD is self-mod commit; rolling back to !LAST_GOOD_COMMIT!>> "%LOG_FILE%"
                git reset --hard !LAST_GOOD_COMMIT!>> "%LOG_FILE%" 2>&1
                REM Record the rollback in the audit log (best-effort).
                powershell -NoProfile -Command "$ts = (Get-Date).ToUniversalTime().ToString('o'); $entry = @{ts=$ts; phase='rolled-back'; runId='watchdog'; detail='crash-loop detected; rolled back to '+$env:LAST_GOOD_COMMIT} | ConvertTo-Json -Compress; Add-Content -Path \"$env:USERPROFILE\.cloxde\selfmod-audit.jsonl\" -Value $entry">> "%LOG_FILE%" 2>&1
                REM Clear crash history and restart.
                set "CRASH_TIMES="
                goto :LOOP
            ) else (
                echo [%date% %time%] No last-good commit recorded; cannot roll back. Stopping.>> "%LOG_FILE%"
                goto :EOF
            )
        ) else (
            echo [%date% %time%] HEAD is not a self-mod commit; refusing to roll back user changes. Stopping.>> "%LOG_FILE%"
            goto :EOF
        )
    )

    REM Crash but below threshold → restart and keep counting.
    timeout /t 2 /nobreak >nul
    goto :LOOP

REM ---------------------------------------------------------------------------
REM Subroutine: convert HH:MM:SS.xx to seconds (ignoring fractional part).
:TIME_TO_SEC
    set TIME_STR=%~1
    for /f "tokens=1-3 delims=:." %%a in ("!TIME_STR!") do (
        set /a H=%%a
        set /a M=%%b
        set /a S=%%c
    )
    set /a %~2=H*3600 + M*60 + S
    goto :EOF

REM ---------------------------------------------------------------------------
REM Subroutine: check if current HEAD is a self-mod promoted commit by reading
REM the audit log. Sets the output var to "1" if HEAD matches a 'promoted'
REM resultCommit, else "0".
:CHECK_SELFMOD_HEAD
    set "%~1=0"
    for /f "usebackq tokens=*" %%a in (`git rev-parse HEAD 2^>nul`) do set "CURRENT_HEAD=%%a"
    if "!CURRENT_HEAD!"=="" goto :EOF
    set AUDIT_PATH=%USERPROFILE%\.cloxde\selfmod-audit.jsonl
    if not exist "!AUDIT_PATH!" goto :EOF
    REM Parse the audit log (JSONL) for any promoted entry whose resultCommit == HEAD.
    REM We use PowerShell for JSON parsing since batch has no native JSON support.
    for /f "usebackq" %%r in (`powershell -NoProfile -Command "Get-Content '%AUDIT_PATH%' | ForEach-Object { try { $o = $_ | ConvertFrom-Json; if ($o.phase -eq 'promoted' -and $o.resultCommit -eq '%CURRENT_HEAD%') { '1'; break } } catch {} }"`) do (
        set "%~1=%%r"
    )
    goto :EOF
