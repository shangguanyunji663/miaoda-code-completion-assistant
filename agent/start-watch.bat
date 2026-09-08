@echo off
REM ============================================================
REM  Start the agent in watch mode (persistent).
REM
REM  The process keeps running. Whenever you navigate to a NEW
REM  task page, it answers automatically and clicks 评测.
REM  It never clicks "next level" for you - navigation stays
REM  in your hands.
REM
REM  Already-open task pages are skipped on startup, so it will
REM  not resubmit answers you already finished.
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

echo Starting watch mode. Press Ctrl+C to stop.
echo.
node src\cli.mjs watch
pause
