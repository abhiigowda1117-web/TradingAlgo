@echo off
title AlgoTrade: set up the anywhere link
cd /d "%~dp0"
echo.
echo  ===== AlgoTrade: open it from any phone or laptop =====
echo  Run this ONCE. Afterwards AlgoTrade starts by itself whenever Windows starts.
echo.

rem ---- 1. start hidden at every Windows sign-in
echo [1/4] Making AlgoTrade start by itself when Windows starts...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\AlgoTrade.vbs" echo CreateObject("WScript.Shell").Run """%~dp0deploy\windows\algotrade-background.cmd""", 0, False
if not exist "%STARTUP%\AlgoTrade.vbs" (
  echo     Could not write to the Startup folder. Take a screenshot and send it to Claude.
  pause
  exit /b 1
)
echo     Done.

rem ---- 2. no sleep while plugged in
echo [2/4] Keeping the computer awake while it is plugged in...
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
echo     Done. (The screen can still turn off; that is fine.)

rem ---- 3. start it now
echo [3/4] Starting AlgoTrade in the background (updating and building takes 1-3 minutes)...
if exist data\autostart.off del data\autostart.off
wscript "%STARTUP%\AlgoTrade.vbs"
set /a tries=0
:wait
timeout /t 5 /nobreak >nul
curl -s -o nul http://127.0.0.1:3001/api/health && goto started
set /a tries+=1
if %tries% lss 60 goto wait
echo     AlgoTrade did not start within 5 minutes. Send Claude a screenshot of this window
echo     and of the file logs\autostart.log in the TradingAlgo folder.
pause
exit /b 1
:started
echo     AlgoTrade is running.

rem ---- 4. public https link through Tailscale Funnel
echo [4/4] Switching on your public link (Tailscale Funnel)...
set "TS=tailscale"
where tailscale >nul 2>&1 || set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if not "%TS%"=="tailscale" if not exist "%TS%" (
  echo     Tailscale is not installed on THIS computer. Install it from https://tailscale.com/download/windows,
  echo     sign in with the same account as your phone, then run this file again.
  pause
  exit /b 1
)
echo     Tailscale on this computer says:
"%TS%" status
echo.
echo     If a web address appears below, open it in your browser, click "Enable" / "Allow",
echo     then come back to this window and wait.
"%TS%" funnel --bg 3001
if errorlevel 1 (
  echo.
  echo     The link could not be switched on. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)

echo.
echo  ================================================================
echo   Your AlgoTrade link (works on any phone or laptop, anywhere):
echo.
node deploy\windows\link.mjs
echo.
echo   A shortcut "AlgoTrade link" is on your Desktop, and the link is
echo   saved in MY-ALGOTRADE-LINK.txt in the TradingAlgo folder.
echo   It works while this computer is on and connected to the internet.
echo  ================================================================
echo.
pause
