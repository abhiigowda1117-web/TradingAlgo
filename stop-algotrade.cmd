@echo off
title AlgoTrade: stop
cd /d "%~dp0"
rem Stops the background AlgoTrade server (it starts again at the next Windows start).
rem To stop it starting with Windows too, delete "AlgoTrade.vbs" from the Startup folder (Win+R, shell:startup).
if not exist data mkdir data
echo off> data\autostart.off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo AlgoTrade is stopped. It starts again by itself the next time Windows starts,
echo or double-click setup-anywhere-link.cmd to start it now.
pause
