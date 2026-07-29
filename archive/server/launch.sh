#!/bin/bash
# ─── OUROBOROS — launcher (WSL / Git Bash / macOS) ──────────
# Запускает Go-сервер и Claude Code в папке проекта.

# Переходим в папку скрипта
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  OUROBOROS — Galaxy Simulation"
echo "  Project dir: $SCRIPT_DIR"
echo ""

# ─── Проверяем Go ───────────────────────────────────────────
if ! command -v go &>/dev/null; then
    echo "  [ERROR] Go not found. Install from https://go.dev/dl/"
    exit 1
fi
echo "  [OK] $(go version)"

# ─── Проверяем Claude Code ──────────────────────────────────
HAS_CLAUDE=true
if ! command -v claude &>/dev/null; then
    echo "  [WARN] Claude Code not found."
    echo "         Install: npm install -g @anthropic-ai/claude-code"
    HAS_CLAUDE=false
fi

# ─── Запускаем Go-сервер фоново ─────────────────────────────
echo ""
echo "  Starting Go server on http://localhost:8080 ..."
go run main.go &
SERVER_PID=$!
echo "  Server PID: $SERVER_PID"

# Ждём поднятия сервера
sleep 1

# ─── Открываем браузер ──────────────────────────────────────
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:8080 &>/dev/null &
elif command -v open &>/dev/null; then
    open http://localhost:8080 &>/dev/null &
fi

# ─── При выходе из скрипта убиваем сервер ───────────────────
trap "echo '  Shutting down server...'; kill $SERVER_PID 2>/dev/null" EXIT

# ─── Запускаем Claude Code ──────────────────────────────────
if $HAS_CLAUDE; then
    echo "  Starting Claude Code..."
    echo "  ─────────────────────────────────────────────────"
    claude
else
    echo "  Server running. Press Ctrl+C to stop."
    wait $SERVER_PID
fi
