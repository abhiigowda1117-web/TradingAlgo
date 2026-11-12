@echo off
rem AlgoTrade in the background: started hidden at Windows sign-in by setup-anywhere-link.cmd.
rem Updates from GitHub, builds the website, then runs the server and restarts it if it ever stops.
rem Output goes to logs\autostart.log and logs\server.log. To stop it: double-click stop-algotrade.cmd.
cd /d "%~dp0..\.."
if not exist logs mkdir logs
if exist data\autostart.off del data\autostart.off

rem Give Windows a moment to connect to the internet after sign-in.
timeout /t 20 /nobreak >nul
echo [%date% %time%] AlgoTrade background start >> logs\autostart.log

rem Stop any AlgoTrade server already running on port 3001 (for example from start-algotrade.cmd).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1

git checkout -- package-lock.json web/package-lock.json >nul 2>&1
git fetch origin feature/web-platform-foundation >> logs\autostart.log 2>&1
git checkout feature/web-platform-foundation >> logs\autostart.log 2>&1
git pull --ff-only origin feature/web-platform-foundation >> logs\autostart.log 2>&1
if errorlevel 1 echo [%date% %time%] Could not update; running the version already here. >> logs\autostart.log
call npm.cmd install --no-audit --no-fund --loglevel=error >> logs\autostart.log 2>&1
call npm.cmd install --prefix web --no-audit --no-fund --loglevel=error >> logs\autostart.log 2>&1
call npm.cmd run web:build --silent >> logs\autostart.log 2>&1

rem Only this computer (and the Tailscale link) can reach the server; the link adds HTTPS.
set HOST=127.0.0.1
set TRUST_PROXY=true

:loop
if exist data\autostart.off goto end
echo [%date% %time%] Starting the AlgoTrade server >> logs\autostart.log
call npm.cmd run server > logs\server.log 2>&1
if exist data\autostart.off goto end
echo [%date% %time%] The server stopped; restarting in 10 seconds >> logs\autostart.log
timeout /t 10 /nobreak >nul
goto loop

:end
echo [%date% %time%] AlgoTrade stopped by stop-algotrade.cmd >> logs\autostart.log
