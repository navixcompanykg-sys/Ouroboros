@echo off
setlocal

:: ─── OUROBOROS — launcher ───────────────────────────────────
:: Запускает Go-сервер и Claude Code в папке проекта.
:: Положи этот файл в папку рядом с main.go и запускай двойным кликом.
:: ─────────────────────────────────────────────────────────────

:: Переходим в папку где лежит этот bat-файл (папка проекта)
cd /d "%~dp0"

echo.
echo  ██████  ██    ██ ██████  ██████  ██████   ██████  ███████
echo  ██    ██ ██    ██ ██   ██ ██   ██ ██   ██ ██    ██ ██
echo  ██    ██ ██    ██ ██████  ██   ██ ██████  ██    ██ ███████
echo  ██    ██ ██    ██ ██   ██ ██   ██ ██   ██ ██    ██      ██
echo  ██████   ██████  ██   ██ ██████  ██████   ██████  ███████
echo.
echo  Project dir: %~dp0
echo.

:: ─── Проверяем Go ───────────────────────────────────────────
where go >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Go not found. Install from https://go.dev/dl/
    pause
    exit /b 1
)
echo  [OK] Go found: 
go version

:: ─── Проверяем Claude Code ──────────────────────────────────
where claude >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Claude Code not found in PATH.
    echo         Install: npm install -g @anthropic-ai/claude-code
    echo         Running server only...
    echo.
    goto :run_server_only
)
echo  [OK] Claude Code found

:: ─── Запускаем Go-сервер в отдельном окне ───────────────────
echo.
echo  Starting Go server on http://localhost:8080 ...
start "OUROBOROS Server" cmd /k "cd /d "%~dp0" && go run main.go"

:: ─── Ждём готовности сервера (до 60с) и открываем браузер ───
echo  Waiting for server to start...
powershell -NoProfile -WindowStyle Hidden -Command "$i=0; while($i -lt 120){try{Invoke-WebRequest -Uri 'http://localhost:8080' -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop; break}catch{Start-Sleep -Milliseconds 500; $i++}}; Start-Process 'http://localhost:8080'"
echo  Browser opened.

:: ─── Запускаем Claude Code в текущем окне ───────────────────
echo.
echo  Starting Claude Code in project directory...
echo  ─────────────────────────────────────────────────────────
claude
goto :end

:run_server_only
start "OUROBOROS Server" cmd /k "cd /d "%~dp0" && go run main.go"
echo  Waiting for server to start...
powershell -NoProfile -WindowStyle Hidden -Command "$i=0; while($i -lt 120){try{Invoke-WebRequest -Uri 'http://localhost:8080' -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop; break}catch{Start-Sleep -Milliseconds 500; $i++}}; Start-Process 'http://localhost:8080'"
echo  Server started. Open http://localhost:8080
echo.
cmd /k "cd /d "%~dp0""

:end
endlocal
