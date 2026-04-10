# HEARTBEAT.md

## Pending PR Review Tasks
Check for pending review tasks in `skills/isaaclab-pr-review/pending-tasks/`. For each `.json` file found:
1. Read the task file to get the `task`, `label`, and `model` fields
2. Spawn a sub-agent with `sessions_spawn` using the task content and the specified model (default: `nvidia/aws/anthropic/claude-opus-4-5`)
3. Delete the task file after spawning
If no pending tasks, skip this check.

## Review Bot Health Check
The review bot webhook server and smee proxy run under supervisord (`isaaclab-review-bot`, `isaaclab-review-smee`).
Quick check: `sudo supervisorctl status isaaclab-review-bot isaaclab-review-smee`
If either is not RUNNING, run: `sudo supervisorctl restart isaaclab-review-bot isaaclab-review-smee`
Only alert if restart fails.

## Telegram Connection Check
Run `bash /home/horde/.openclaw/workspace/scripts/telegram-health.sh`
If output is TELEGRAM_OK — skip. If TELEGRAM_UNHEALTHY or RESTART_FAILED — alert immediately.

## Training Campaign Quick Check
Run `bash /home/horde/IsaacLab/training_campaign/watchdog.sh` — if it says CAMPAIGN_DEAD, restart it (the script handles this automatically). Only alert if RESTART_FAILED.
