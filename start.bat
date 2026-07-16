@echo off
REM ───────────────────────────────────────────────────────────────────────
REM  Document Summarizer launcher.
REM  Double-click this. It starts the local app and opens your browser.
REM  Leave this black window open while you use it; close it when done.
REM ───────────────────────────────────────────────────────────────────────
title Document Summarizer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Ask whoever set this up for you to install it.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo   Missing the .env settings file. This app is not configured yet.
  echo.
  pause
  exit /b 1
)

node server.mjs
echo.
echo   The app has stopped.
pause
