@echo off
cls
REM ============================================================
REM  Miaoda first-run installer (one time, idempotent).
REM  The Node wizard (scripts\setup.mjs) prints the Chinese guidance:
REM    1. check Node.js version (18+)
REM    2. npm install (only if node_modules is missing)
REM    3. write AI endpoint / key / model into .env.local
REM       (interactive prompts; skipped when pre-filled)
REM    4. create a desktop shortcut (Miaoda) pointing to start-miaoda.bat
REM  Re-run any time - already-done steps are skipped.
REM  Optional: pass --dry-run to preview without writing anything.
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ LTS from https://nodejs.org , then double-click this file again.
  pause
  exit /b 1
)

node scripts\setup.mjs %*
pause
