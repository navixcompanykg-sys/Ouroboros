@echo off
setlocal enabledelayedexpansion
REM Ouroboros: one click - start the local server and open the game in the browser.
REM Double-click this file. The server runs in its own window; close it to stop.

set PORT=8080
set URL=http://localhost:%PORT%/

echo === Ouroboros launcher ===
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js not found. Install it from https://nodejs.org and run this file again.
    pause
    exit /b 1
)

echo Stopping any server already running on port %PORT%...
set LAST=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do (
    if not "%%P"=="!LAST!" (
        echo   killing PID %%P
        taskkill /PID %%P /F >nul 2>&1
        set LAST=%%P
    )
)

echo Starting server on port %PORT%...
start "Ouroboros server :%PORT%" /D "%~dp0" cmd /k "echo ==== OUROBOROS SERVER :%PORT% ==== & echo (close this window, or Ctrl+C, to stop it) & echo. & node serve.js"

echo Waiting for the server to answer...
set /a TRIES=0
:wait
set /a TRIES+=1
curl -s -o nul %URL% >nul 2>&1
if not errorlevel 1 goto ready
if !TRIES! geq 20 (
    echo Server did not start in 20 seconds - look at the "Ouroboros server" window for errors.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul 2>&1 || ping -n 2 127.0.0.1 >nul
goto wait

:ready
echo Server is up.
if not defined NO_BROWSER (
    echo Opening the game in your browser...
    start "" "%URL%"
)

echo.
echo Done. The server is running in the "Ouroboros server :%PORT%" window -
echo close that window, or just run this script again, to restart it.
echo For a phone on the same Wi-Fi use the address printed in that window.
timeout /t 5 >nul 2>&1
