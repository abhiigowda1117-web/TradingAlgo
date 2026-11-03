@echo off
title AlgoTrade server
cd /d "%~dp0"
echo.
echo  ===== AlgoTrade: update and start =====
echo.

echo [1/5] Stopping any old AlgoTrade web server on port 3001...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1

echo [2/5] Getting the latest version from GitHub...
rem npm can rewrite the lock files on Windows; reset them so they never block the update.
git checkout -- package-lock.json web/package-lock.json >nul 2>&1
git pull
if errorlevel 1 echo     (Could not update; starting the version you already have.)

echo [3/5] Installing anything new (fast if nothing changed)...
call npm.cmd install --no-audit --no-fund --loglevel=error
call npm.cmd install --prefix web --no-audit --no-fund --loglevel=error

echo [4/5] Building the website...
call npm.cmd run web:build --silent
if errorlevel 1 (
  echo.
  echo  The website build failed. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)

echo [5/5] Starting the server. Your browser will open in a few seconds.
echo.
echo  KEEP THIS WINDOW OPEN. Closing it stops the website.
echo.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3001"
call npm.cmd run server

echo.
echo  The server stopped. If you did not stop it yourself, take a screenshot of this window and send it to Claude.
pause
