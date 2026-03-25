# Isaac Lab PR Review Bot

Webhook-driven, interactive code review bot for `isaac-sim/IsaacLab`.

## Architecture

```
GitHub PR event → GitHub webhook → smee.io → local smee client → webhook server (port 19876) → OpenClaw sub-agent
```

**Triggers:**
- PR opened / new commits pushed / reopened → full code review
- Engineer replies to a review comment → bot responds in-thread
- Engineer @mentions the bot in a PR comment → bot responds

**Bot posts as:** GitHub App (`IsaacLab Review Bot[bot]`), not as any personal account.

## Setup Checklist

1. ✅ Smee channel created: `https://smee.io/Il4Fu89qzX4Gpom`
2. ⬜ GitHub App created (see instructions below)
3. ⬜ App credentials added to `webhook/config.json`
4. ⬜ Webhook server started: `bash webhook/start.sh`

## GitHub App Settings

| Setting | Value |
|---------|-------|
| Name | `IsaacLab Review Bot` |
| Homepage URL | `https://github.com/isaac-sim/IsaacLab` |
| Webhook URL | `https://smee.io/Il4Fu89qzX4Gpom` |
| Webhook secret | `6caba8361d2c7243d2861ce226f25d7a01575662bca15e72e69860b816a09b14` |
| Webhook active | ✅ |

**Permissions:** Pull requests (R&W), Contents (Read), Checks (Read), Metadata (Read)

**Events:** Pull requests, Pull request review comments, Issue comments

**Install on:** `isaac-sim/IsaacLab` only

## Files

```
webhook/
  server.js          — Webhook receiver + agent trigger
  start.sh           — Start smee + server
  stop.sh            — Stop everything
  config.json        — App credentials (gitignored)
  config.json.template — Template for credentials
scripts/
  poll-prs.sh        — (Legacy) cron-based polling
  review-prompt.md   — Review prompt template reference
state.json           — Tracks reviewed PRs
```

## Config

After creating the GitHub App, copy `config.json.template` to `config.json` and fill in:

```json
{
  "appId": "123456",
  "installationId": "12345678",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  "webhookSecret": "6caba8361d2c7243d2861ce226f25d7a01575662bca15e72e69860b816a09b14",
  "smeeUrl": "https://smee.io/Il4Fu89qzX4Gpom",
  "port": 19876,
  "botLogin": "isaaclab-review-bot[bot]"
}
```

Note: `botLogin` format is `{app-slug}[bot]` — check the app's slug after creation.

## What the Bot Reviews

### Style Guide (from CONTRIBUTING.md)
- License headers, file/class structure ordering
- Type hints in signatures only, Google-style docstrings
- Import ordering, CHANGELOG.rst updates
- Line length (120), ruff rules compliance

### Architecture (deep analysis)
- Cross-module impact (core → tasks → rl → assets)
- API symmetry between PhysX/Newton backends
- Config/dataclass consistency
- Breaking changes and backward compatibility
- Tensor ops (shapes, devices, broadcasting, gradients)
- Simulation lifecycle correctness
- Performance issues

### CI Status
- Parse check run results
- Identify PR-caused vs pre-existing failures
- Report relevant test failures with context

## Interactive Comments

When an engineer replies to a bot review comment:
1. Bot receives the webhook
2. Spawns agent with the comment context + relevant file
3. Agent reads the code, understands the question
4. Posts a reply in the same thread

The bot can:
- Clarify its review feedback
- Acknowledge valid counterpoints
- Provide alternative suggestions
- Re-examine code if pointed to missed context
