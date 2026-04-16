#!/bin/bash
# Setup script for Isaac Lab Review Bot supervisor services
# Run with: sudo ./scripts/setup-supervisor.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
USER="${SUDO_USER:-$USER}"
HOME_DIR=$(eval echo ~$USER)
NODE_BIN="$HOME_DIR/.nvm/versions/node/v22.22.2/bin"

echo "Setting up Isaac Lab Review Bot services..."
echo "User: $USER"
echo "Home: $HOME_DIR"
echo "Repo: $REPO_DIR"
echo "Node: $NODE_BIN"

# Check prerequisites
if [ ! -f "$NODE_BIN/openclaw" ]; then
    echo "ERROR: OpenClaw not found at $NODE_BIN/openclaw"
    echo "Install with: npm install -g openclaw"
    exit 1
fi

if [ ! -f "$NODE_BIN/npx" ]; then
    echo "ERROR: npx not found at $NODE_BIN/npx"
    exit 1
fi

# Create log directory
mkdir -p /var/log

# Install OpenClaw Gateway service
cat > /etc/supervisor/conf.d/openclaw-gateway.conf << EOF
[program:openclaw-gateway]
command=$NODE_BIN/openclaw gateway start --foreground
directory=$HOME_DIR
user=$USER
autostart=true
autorestart=true
stderr_logfile=/var/log/openclaw-gateway.err.log
stdout_logfile=/var/log/openclaw-gateway.out.log
environment=HOME="$HOME_DIR",PATH="$NODE_BIN:%(ENV_PATH)s"
EOF
echo "✓ Created openclaw-gateway supervisor config"

# Install Review Bot service
cat > /etc/supervisor/conf.d/isaaclab-review-bot.conf << EOF
[program:isaaclab-review-bot]
command=$NODE_BIN/node $REPO_DIR/skills/isaaclab-pr-review/webhook/server.js
directory=$REPO_DIR/skills/isaaclab-pr-review/webhook
user=$USER
autostart=true
autorestart=true
stderr_logfile=/var/log/isaaclab-review-bot.err.log
stdout_logfile=/var/log/isaaclab-review-bot.out.log
environment=HOME="$HOME_DIR",PATH="$NODE_BIN:%(ENV_PATH)s"
EOF
echo "✓ Created isaaclab-review-bot supervisor config"

# Install Smee webhook relay service
cat > /etc/supervisor/conf.d/isaaclab-review-smee.conf << EOF
[program:isaaclab-review-smee]
command=$NODE_BIN/npx smee -u https://smee.io/Il4Fu89qzX4Gpom -p 19876
directory=$REPO_DIR
user=$USER
autostart=true
autorestart=true
stderr_logfile=/var/log/isaaclab-review-smee.err.log
stdout_logfile=/var/log/isaaclab-review-smee.out.log
environment=HOME="$HOME_DIR",PATH="$NODE_BIN:%(ENV_PATH)s"
EOF
echo "✓ Created isaaclab-review-smee supervisor config"

# Reload supervisor
echo "Reloading supervisor..."
supervisorctl reread
supervisorctl update

# Start services
echo "Starting services..."
supervisorctl start openclaw-gateway || true
supervisorctl start isaaclab-review-bot || true
supervisorctl start isaaclab-review-smee || true

echo ""
echo "✅ Setup complete! Check status with:"
echo "   sudo supervisorctl status"
echo ""
echo "Services:"
echo "  - openclaw-gateway:    OpenClaw gateway daemon (required for subagent reviews)"
echo "  - isaaclab-review-bot: Webhook server that queues PR review tasks"
echo "  - isaaclab-review-smee: Smee.io relay for GitHub webhooks"
echo ""
echo "Logs at /var/log/openclaw-gateway.*.log, isaaclab-review-bot.*.log, isaaclab-review-smee.*.log"
