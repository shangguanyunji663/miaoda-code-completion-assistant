@echo off
cls
REM ============================================================
REM  Restart YOUR OWN Edge with the debug port enabled.
REM
REM  Why: Edge/Chrome 136+ blocks the debug port on the default
REM  user profile dir. This script creates a directory junction
REM  (a link, no admin needed) to your REAL profile and launches
REM  through it - so you keep all logins / history / extensions,
REM  and the agent can attach to your own browser.
REM
REM  NOTE: your running Edge will be closed first (3s countdown,
REM  tabs can be restored via session restore).
REM
REM  After this, just double-click start-watch.bat.
REM  If you later open Edge normally from the taskbar (no debug
REM  port), run this script again before using the agent.
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Please install Node.js 18+ first.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules" (
  echo [ERROR] node_modules not found. Please run: npm install
  pause
  exit /b 1
)

echo Restarting YOUR OWN Edge with debug port...
echo.
node src\cli.mjs my-edge
echo.
echo Next: double-click start-watch.bat to let the agent attach.
pause
