@echo off
cls
REM ============================================================
REM  Miaoda daily one-click launcher (the ONLY entry you need).
REM
REM  It chains the two classic scripts into one window:
REM    - controlled Edge restart (SKIPPED when the debug port is
REM      already alive, so your browser is not restarted every time)
REM    - web workbench (same entry as start-web.bat), then opens
REM      http://127.0.0.1:8787 in your default browser
REM
REM  First time? Double-click install.bat first.
REM  Stop = Ctrl+C here, or just close this window.
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please double-click install.bat first.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules" (
  echo [ERROR] Dependencies not installed. Please double-click install.bat first.
  pause
  exit /b 1
)

if not exist "%~dp0.env.local" (
  echo [ERROR] AI keys not configured. Please double-click install.bat first.
  pause
  exit /b 1
)

node scripts\launch-all.mjs
pause
