@echo off
cls
REM ============================================================
REM  Start the web workbench (http://127.0.0.1:8787, local only).
REM
REM  Open the printed URL in your browser. It gives you:
REM    - page probe (task type / editor / problem preview)
REM    - solve current task (submits evaluation for real)
REM    - live log stream
REM
REM  Prerequisite: npm install once; AI config in .env.local;
REM  a debug-port browser with the task page open (start-my-edge.bat).
REM  Press Ctrl+C in this window to stop.
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

echo Starting web workbench at http://127.0.0.1:8787 (local only)
echo.
node src\web-server.mjs
pause
