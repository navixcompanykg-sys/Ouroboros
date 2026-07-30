@echo off
title OUROBOROS Server
color 0B
 
:: Switch to the directory where this bat file lives
cd /d "%~dp0"
 
echo.
echo  OUROBOROS — Galaxy Simulation
echo  -------------------------------------------------------
echo  Working dir: %CD%
echo.
 
:: Kill any process already holding port 8080
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr /R ":8080 " ^| findstr /R "LISTENING"') do (
    echo  Port 8080 busy ^(PID %%p^) — terminating...
    taskkill /F /PID %%p >nul 2>&1
)

:: Check Go is installed
where go >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Go is not installed or not in PATH.
    echo  Download from https://go.dev/dl/
    echo.
    pause
    exit /b 1
)
 
:: Generate galaxy.json if it doesn't exist
if not exist galaxy.json (
    echo  galaxy.json not found — generating with default seed...
    go run galaxy_gen.go -config config.json
    if %errorlevel% neq 0 (
        echo  ERROR: Galaxy generation failed.
        pause
        exit /b 1
    )
    echo  galaxy.json created OK
    echo.
)
 
:: Open browser once server is ready (background poller, up to 60s)
echo  Server starting on http://localhost:8080
echo  Press Ctrl+C to stop
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$i=0; while($i -lt 120){try{Invoke-WebRequest -Uri 'http://localhost:8080' -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop; break}catch{Start-Sleep -Milliseconds 500; $i++}}; Start-Process 'http://localhost:8080'"

:: Start Go server (blocking)
go run main.go
 
pause