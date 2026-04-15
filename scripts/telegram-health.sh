#!/usr/bin/env bash
# telegram-health.sh — Monitors Telegram bot connectivity
# Returns: "TELEGRAM_OK" or "TELEGRAM_UNHEALTHY: <reason>"
#
# Checks:
#   1. openclaw-gateway process is running
#   2. Telegram Bot API responds to getMe
#   3. OpenClaw status reports telegram channel as OK

set -euo pipefail

BOT_TOKEN="8766038395:AAFDELTHmdm9qmpb_0KaUZSk6zyW2QTEBzE"
OPENCLAW_BIN="$(which openclaw 2>/dev/null || echo /home/horde/.nvm/versions/node/v22.22.2/bin/openclaw)"

# 1. Check gateway process is running
if ! pgrep -f "openclaw-gateway" >/dev/null 2>&1; then
    echo "TELEGRAM_UNHEALTHY: openclaw-gateway process not running"
    # Attempt restart via openclaw CLI
    $OPENCLAW_BIN gateway restart 2>/dev/null || true
    sleep 5
    if pgrep -f "openclaw-gateway" >/dev/null 2>&1; then
        echo "RESTARTED: gateway recovered"
    else
        echo "RESTART_FAILED: gateway still not running after restart attempt"
    fi
    exit 1
fi

# 2. Check Telegram Bot API is reachable and bot token is valid
API_RESPONSE=$(curl -s --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
API_OK=$(echo "$API_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")

if [[ "$API_OK" != "True" ]]; then
    echo "TELEGRAM_UNHEALTHY: Bot API unreachable or token invalid"
    exit 1
fi

# 3. Check OpenClaw reports telegram as OK
TG_STATUS=$($OPENCLAW_BIN status 2>/dev/null | grep -i telegram | head -1 || echo "")
if echo "$TG_STATUS" | grep -qi "error\|fail\|down"; then
    echo "TELEGRAM_UNHEALTHY: openclaw status reports telegram issue: $TG_STATUS"
    # Attempt gateway restart
    $OPENCLAW_BIN gateway restart 2>/dev/null || true
    sleep 5
    TG_STATUS2=$($OPENCLAW_BIN status 2>/dev/null | grep -i telegram | head -1 || echo "")
    if echo "$TG_STATUS2" | grep -qi "error\|fail\|down"; then
        echo "RESTART_FAILED: telegram still unhealthy after restart"
    else
        echo "RESTARTED: gateway restarted, telegram recovering"
    fi
    exit 1
fi

echo "TELEGRAM_OK"
