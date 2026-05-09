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
 
:: Open browser after short delay
echo  Server starting on http://localhost:8080
echo  Press Ctrl+C to stop
echo.
start "" cmd /c "timeout /t 2 >nul && start http://localhost:8080"
 
:: Start Go server (blocking)
go run main.go
 
pause