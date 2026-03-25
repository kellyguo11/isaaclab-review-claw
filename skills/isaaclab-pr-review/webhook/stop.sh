#!/bin/bash
# Stop the webhook server and smee client

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.pids"

if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping PID $pid..."
      kill "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  echo "Stopped."
else
  echo "No PID file found. Trying to find processes..."
  pkill -f "isaaclab-pr-review/webhook/server.js" 2>/dev/null || true
  pkill -f "smee.*19876" 2>/dev/null || true
  echo "Done."
fi
