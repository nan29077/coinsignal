@echo off
setlocal
cd /d "%~dp0"
title CoinSignal

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22.13+ is required. Download: https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Checking dependencies ... (first run can take a few minutes)
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check the internet connection and run again.
  pause
  exit /b 1
)
if not exist "node_modules\@tailwindcss\vite" (
  echo [ERROR] Dependencies look incomplete. Delete the node_modules folder, then run this file again.
  pause
  exit /b 1
)

echo [2/3] Building web UI ...
call npm run build
if errorlevel 1 (
  echo [ERROR] build failed.
  pause
  exit /b 1
)

echo [3/3] Starting CoinSignal. Open http://localhost:3032 in your browser.
echo Closing this window also stops automatic trading.
echo.
call npm start
echo.
echo CoinSignal stopped.
pause
