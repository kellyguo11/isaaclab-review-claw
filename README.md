# Isaac Lab Review Bot

Automated PR review bot for [isaac-sim/IsaacLab](https://github.com/isaac-sim/IsaacLab) and [isaac-sim/IsaacLab-Arena](https://github.com/isaac-sim/IsaacLab-Arena) repositories.

## Architecture

```
GitHub PR Event
     │
     ▼
┌─────────────┐    ┌─────────────────┐    ┌──────────────────┐
│  Smee.io    │───▶│  Webhook Server │───▶│  Pending Tasks   │
│  (relay)    │    │  (port 19876)   │    │  (JSON files)    │
└─────────────┘    └─────────────────┘    └──────────────────┘
                                                   │
                                                   ▼
                   ┌─────────────────┐    ┌──────────────────┐
                   │ OpenClaw Agent  │◀───│   Heartbeat /    │
                   │ (main session)  │    │   Task Queue     │
                   └─────────────────┘    └──────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │   Sub-agents    │───▶ GitHub PR Review
                   │ (review tasks)  │
                   └─────────────────┘
```

## Prerequisites

- Node.js v22+ (via nvm)
- OpenClaw CLI: `npm install -g openclaw`
- Supervisor (for process management)
- GitHub App credentials configured

## Setup

### 1. Clone the repository

```bash
git clone git@github.com:kellyguo11/isaaclab-review-claw.git
cd isaaclab-review-claw
```

### 2. Configure OpenClaw

Ensure OpenClaw is configured with your API keys:

```bash
openclaw config
```

### 3. Configure webhook server

Edit `skills/isaaclab-pr-review/webhook/config.json`:

```json
{
  "repos": ["isaac-sim/IsaacLab", "isaac-sim/IsaacLab-Arena"],
  "webhookSecret": "<your-github-webhook-secret>",
  "appId": "<your-github-app-id>",
  "privateKeyPath": "/path/to/github-app-private-key.pem"
}
```

### 4. Install supervisor services

```bash
sudo ./scripts/setup-supervisor.sh
```

This installs and starts three services:
- **openclaw-gateway**: OpenClaw gateway daemon (required for subagent reviews)
- **isaaclab-review-bot**: Webhook server that queues PR review tasks
- **isaaclab-review-smee**: Smee.io relay for GitHub webhooks

### 5. Verify services

```bash
sudo supervisorctl status
```

All three services should show `RUNNING`.

## Services

| Service | Description | Port | Logs |
|---------|-------------|------|------|
| `openclaw-gateway` | OpenClaw gateway for subagent communication | 18789 | `/var/log/openclaw-gateway.*.log` |
| `isaaclab-review-bot` | Webhook server, queues review tasks | 19876 | `/var/log/isaaclab-review-bot.*.log` |
| `isaaclab-review-smee` | Smee.io relay for GitHub webhooks | - | `/var/log/isaaclab-review-smee.*.log` |

## Usage

Once set up, the bot automatically:

1. Receives GitHub webhook events via Smee.io relay
2. Queues PR review tasks as JSON files in `skills/isaaclab-pr-review/pending-tasks/`
3. OpenClaw agent picks up tasks on heartbeat and spawns sub-agents
4. Sub-agents post reviews to GitHub PRs

### Manual operations

```bash
# Check service status
sudo supervisorctl status

# Restart a service
sudo supervisorctl restart isaaclab-review-bot

# View logs
tail -f /var/log/isaaclab-review-bot.out.log

# Check pending tasks
ls skills/isaaclab-pr-review/pending-tasks/

# Clear stale tasks (if tokens expired)
rm skills/isaaclab-pr-review/pending-tasks/*.json
```

## Telegram Health Check

A health check script is available for monitoring:

```bash
./scripts/telegram-health.sh
```

Returns `TELEGRAM_OK` if healthy, `TELEGRAM_UNHEALTHY` or `RESTART_FAILED` if issues detected.

## Files

- `skills/isaaclab-pr-review/` - Main review bot skill
  - `webhook/server.js` - Webhook server
  - `webhook/config.json` - Configuration
  - `pending-tasks/` - Queued review tasks
  - `state.json` - PR review state tracking
- `scripts/` - Setup and utility scripts
- `HEARTBEAT.md` - Heartbeat check instructions for OpenClaw agent

## Troubleshooting

### Gateway connection issues
If reviews hang or fail with "gateway closed":
```bash
sudo supervisorctl restart openclaw-gateway
```

### Stale task backlog
If tokens expire before processing:
```bash
rm skills/isaaclab-pr-review/pending-tasks/*.json
```
Tasks will re-queue on next PR push.

### Webhook not receiving events
1. Check Smee relay: `sudo supervisorctl status isaaclab-review-smee`
2. Verify webhook URL in GitHub App settings matches Smee URL
3. Check logs: `tail -f /var/log/isaaclab-review-smee.out.log`
