@echo off
cls
REM ============================================================
REM  Start the agent in lite (refresh-triggered) mode.
REM
REM  The process keeps running. Whenever you REFRESH a task page,
REM  it detects the question and answers it again automatically,
REM  including the reflect-and-fix retry loop.
REM
REM  Difference from watch mode: watch answers each task URL only
REM  once; lite re-answers every time you refresh the page, so
REM  you can retry a failed task by simply pressing F5.
REM
REM  It never clicks Next for you - navigation stays in your hands.
REM
REM  Prerequisite: run start-browser.bat first and log in.
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

echo Starting lite mode. Refresh a task page to trigger answering.
echo.
node src\cli.mjs lite
pause
