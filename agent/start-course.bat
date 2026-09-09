@echo off
cls
REM ============================================================
REM  Start the agent in COURSE mode (autopilot).
REM
REM  What it does:
REM    1. Iterates the left menu sections under "course experiments"
REM    2. Opens every card via "start learning" (skips finished n/n)
REM    3. Solves every level inside a card
REM    4. After a level passes, clicks "next level". If the page
REM       does NOT advance, the card is considered finished:
REM       clicks Exit (top-right), then the back arrow (top-left),
REM       and continues with the next card.
REM
REM  Prerequisite:
REM    Run start-browser.bat first, log in, and OPEN the course
REM    experiment list page (the one with "start learning" cards).
REM
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

echo Starting course mode. Press Ctrl+C to stop.
echo.
node src\cli.mjs course
pause
