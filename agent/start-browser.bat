@echo off
REM ============================================================
REM  Start Edge with remote debugging for the coding agent.
REM
REM  Why this file exists:
REM  1. The agent cannot spawn the browser itself - a browser started
REM     from a command is terminated when that command ends.
REM     Launching from Explorer keeps it alive across commands.
REM  2. Edge must NOT already be running. Edge merges a newly launched
REM     instance into the existing one even with a different
REM     --user-data-dir, silently dropping --remote-debugging-port.
REM     Verified: 16 Edge processes running, none carried the debug
REM     flag, port 9333 never bound.
REM
REM  This script therefore closes all Edge processes first, waits for
REM  them to fully exit, then starts a clean debug instance.
REM
REM  Usage:
REM  1. Double-click this file. All Edge windows will be CLOSED.
REM  2. A new Edge window opens with an isolated profile. Log in to
REM     your judge platform and open a task page.
REM  3. Run: npm run probe
REM
REM  Note: isolated profile means you must log in once. Afterwards the
REM  session is remembered in .browser-profile.
REM ============================================================

set PORT=9333

REM Edge preferred; Chrome only as fallback (both Chromium, same CDP).
set BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set PROFILE=%~dp0.browser-profile

if not exist "%BROWSER%" set BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe
if not exist "%BROWSER%" set BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe
if not exist "%BROWSER%" set BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe

echo Port    : %PORT%
echo Browser : %BROWSER%
echo Profile : %PROFILE%
echo.

REM ---- Close running Edge (with a chance to abort) ----
tasklist /FI "IMAGENAME eq msedge.exe" 2>NUL | find /I "msedge.exe" >NUL
if not errorlevel 1 (
  echo ============================================================
  echo  WARNING: this will CLOSE ALL EDGE WINDOWS.
  echo  Unsaved content in open tabs will be lost.
  echo.
  echo  Press Ctrl+C within 6 seconds to abort.
  echo ============================================================
  timeout /t 6
  echo Closing Edge...
  taskkill /F /IM msedge.exe /T >NUL 2>&1
)

REM ---- Wait until Edge has fully exited (label kept outside the block) ----
:waitloop
tasklist /FI "IMAGENAME eq msedge.exe" 2>NUL | find /I "msedge.exe" >NUL
if not errorlevel 1 (
  timeout /t 1 >NUL
  goto waitloop
)
echo All Edge processes closed.
echo.

echo Starting Edge with debug port %PORT% ...
start "" "%BROWSER%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-features=StartupBoost

echo.
echo Browser started.
echo Next: log in to your judge platform, open a task page,
echo       then run  npm run probe  in the agent directory.
echo.
timeout /t 8 >nul
