#!/bin/bash
# Isaac Lab PR Review Bot — Start Script
# Runs the smee client and webhook server together

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
PID_FILE="$SCRIPT_DIR/.pids"

# Ensure openclaw and smee are on PATH
export PATH="$HOME/.npm-global/bin:$PATH"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: $CONFIG_FILE not found. Create it first."
  exit 1
fi

SMEE_URL=$(node -e "console.log(require('$CONFIG_FILE').smeeUrl)")
PORT=$(node -e "console.log(require('$CONFIG_FILE').port || 19876)")

echo "=== Isaac Lab PR Review Bot ==="
echo "Smee URL: $SMEE_URL"
echo "Local port: $PORT"
echo ""

# Kill any existing processes
if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# Start webhook server
echo "[start] Starting webhook server on port $PORT..."
node "$SCRIPT_DIR/server.js" &
SERVER_PID=$!
echo $SERVER_PID >> "$PID_FILE"

# Wait for server to be ready
sleep 1

# Start smee client
echo "[start] Starting smee client..."
SMEE_BIN="$(which smee 2>/dev/null || echo "$HOME/.npm-global/bin/smee")"
"$SMEE_BIN" --url "$SMEE_URL" --port "$PORT" --path /webhook &
SMEE_PID=$!
echo $SMEE_PID >> "$PID_FILE"

echo ""
echo "[start] Bot is running!"
echo "  Webhook server PID: $SERVER_PID"
echo "  Smee client PID: $SMEE_PID"
echo ""
echo "  To stop: bash $SCRIPT_DIR/stop.sh"
echo ""

# Wait for both processes
wait
