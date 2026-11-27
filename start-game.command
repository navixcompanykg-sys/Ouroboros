#!/bin/bash
# Ouroboros: one click on macOS - start the local server and open the game in the browser.
# Double-click this file in Finder. The server runs in this Terminal window;
# close the window or press Ctrl+C to stop it. Mac analogue of start-game.bat.

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8080}"
URL="http://localhost:${PORT}/"
export PORT

# Finder starts .command files with a minimal PATH - add the usual Node.js locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

echo "=== Ouroboros launcher ==="
echo

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Install it from https://nodejs.org (or: brew install node) and run this file again."
    read -r -p "Press Enter to close..."
    exit 1
fi

PIDS=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "Stopping the server already running on port $PORT (PID $PIDS)..."
    kill $PIDS 2>/dev/null
    sleep 1
fi

echo "Starting server on port $PORT..."
node serve.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM HUP

echo "Waiting for the server to answer..."
for i in $(seq 1 20); do
    if curl -s -o /dev/null "$URL"; then
        echo "Server is up."
        if [ -z "$NO_BROWSER" ]; then
            echo "Opening the game in your browser..."
            open "$URL"
        fi
        echo
        echo "The server is running in this window - close it or press Ctrl+C to stop."
        echo "For a phone on the same Wi-Fi use the address printed above."
        wait $SERVER_PID
        exit 0
    fi
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "Server exited with an error - see the messages above."
        read -r -p "Press Enter to close..."
        exit 1
    fi
    sleep 1
done

echo "Server did not start in 20 seconds - see the messages above."
read -r -p "Press Enter to close..."
exit 1
