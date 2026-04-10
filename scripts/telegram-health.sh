#!/usr/bin/env bash
# telegram-health.sh — Monitors Telegram bot connectivity
# Returns: "TELEGRAM_OK" or "TELEGRAM_UNHEALTHY: <reason>"
#
# Checks:
#   1. openclaw-gateway is running (supervisord)
#   2. Telegram Bot API responds to getMe
#   3. No recent persistent errors in gateway logs (sustained failures)

set -euo pipefail

BOT_TOKEN="8766038395:AAFDELTHmdm9qmpb_0KaUZSk6zyW2QTEBzE"
GATEWAY_LOG_ERR="/var/log/supervisor/openclaw-gateway-err.log"
GATEWAY_LOG_OUT="/var/log/supervisor/openclaw-gateway-out.log"

# 1. Check gateway process is running
GW_STATUS=$(sudo supervisorctl status openclaw-gateway 2>/dev/null | awk '{print $2}')
if [[ "$GW_STATUS" != "RUNNING" ]]; then
    echo "TELEGRAM_UNHEALTHY: openclaw-gateway is $GW_STATUS"
    # Attempt restart
    sudo supervisorctl restart openclaw-gateway 2>/dev/null
    sleep 5
    GW_STATUS2=$(sudo supervisorctl status openclaw-gateway 2>/dev/null | awk '{print $2}')
    if [[ "$GW_STATUS2" != "RUNNING" ]]; then
        echo "RESTART_FAILED: gateway still $GW_STATUS2 after restart attempt"
    else
        echo "RESTARTED: gateway recovered"
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

# 3. Check for recent sustained Telegram errors in last 10 minutes
# Count telegram error lines in the last 10 min of the err log
RECENT_ERRORS=0
if [[ -f "$GATEWAY_LOG_ERR" ]]; then
    CUTOFF=$(date -d '10 minutes ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date -v-10M '+%Y-%m-%dT%H:%M' 2>/dev/null || echo "")
    if [[ -n "$CUTOFF" ]]; then
        RECENT_ERRORS=$(tail -100 "$GATEWAY_LOG_ERR" 2>/dev/null | grep -i telegram | grep -c "error\|fatal\|crash\|ECONNREFUSED\|ETIMEDOUT" 2>/dev/null || echo 0)
    fi
fi

# 4. Verify telegram provider started (check stdout log)
TG_STARTED=$(tail -50 "$GATEWAY_LOG_OUT" 2>/dev/null | grep -c "\[telegram\].*starting provider" || echo 0)
if [[ "$TG_STARTED" -eq 0 ]]; then
    # Check if it's been a while since gateway started — maybe logs rotated
    GW_UPTIME=$(sudo supervisorctl status openclaw-gateway 2>/dev/null | grep -oP 'uptime \K.*')
    echo "TELEGRAM_WARN: No recent 'starting provider' in logs (gateway uptime: $GW_UPTIME) — may be fine if running for a while"
fi

if [[ "$RECENT_ERRORS" -gt 5 ]]; then
    echo "TELEGRAM_UNHEALTHY: $RECENT_ERRORS telegram errors in last 10 min — restarting gateway"
    sudo supervisorctl restart openclaw-gateway 2>/dev/null
    sleep 5
    GW_STATUS3=$(sudo supervisorctl status openclaw-gateway 2>/dev/null | awk '{print $2}')
    if [[ "$GW_STATUS3" == "RUNNING" ]]; then
        echo "RESTARTED: gateway restarted due to high error rate"
    else
        echo "RESTART_FAILED: gateway is $GW_STATUS3"
    fi
    exit 1
fi

echo "TELEGRAM_OK"
