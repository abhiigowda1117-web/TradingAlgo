@echo off
title AlgoTrade server
cd /d "%~dp0"
echo.
echo  ===== AlgoTrade: update and start =====
echo.

rem Node.js 22.13 or newer has the built-in database AlgoTrade uses (no PostgreSQL needed).
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" >nul 2>&1
if errorlevel 1 (
  echo  Node.js 22.13 or newer is needed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
rem First start on this computer: create the settings file from the template.
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo  Created .env with default settings ^(built-in database, paper trading^).
)

rem With the anywhere link set up, AlgoTrade already runs in the background: just open it.
if not exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AlgoTrade.vbs" goto normalstart
if exist data\autostart.off goto normalstart
echo  AlgoTrade already runs in the background (set up by setup-anywhere-link.cmd). Opening it...
set "LINK=http://localhost:3001"
if exist MY-ALGOTRADE-LINK.txt set /p LINK=<MY-ALGOTRADE-LINK.txt
start "" "%LINK%"
timeout /t 3 >nul
exit /b 0

:normalstart
echo [1/5] Stopping any old AlgoTrade web server on port 3001...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1

echo [2/5] Getting the latest version from GitHub...
rem npm can rewrite the lock files on Windows; reset them so they never block the update.
git checkout -- package-lock.json web/package-lock.json >nul 2>&1
git fetch origin feature/web-platform-foundation
git checkout feature/web-platform-foundation >nul 2>&1
git pull --ff-only origin feature/web-platform-foundation
if errorlevel 1 (
  echo.
  echo  *** COULD NOT DOWNLOAD THE UPDATE. You are still on the OLD version. ***
  echo  Take a screenshot of this window and send it to Claude.
  echo.
  git status --short
  pause
)
for /f "delims=" %%v in ('git log -1 --format^="%%h %%s (%%cd)" --date^=short') do echo     Version: %%v

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
echo  First time on this computer? The browser shows "Create your account".
echo.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3001"
call npm.cmd run server

echo.
echo  The server stopped. If you did not stop it yourself, take a screenshot of this window and send it to Claude.
pause
