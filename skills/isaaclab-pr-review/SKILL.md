# Isaac Lab PR Review Bot

Webhook-driven, multi-perspective code review bot for `isaac-sim/IsaacLab`.

## Architecture

```
GitHub PR event → GitHub webhook → smee.io → local smee client → webhook server (port 19876) → OpenClaw coordinator
                                                                                                      ↓
                                                                                    ┌─────────────────┼─────────────────┐
                                                                                    ↓                 ↓                 ↓
                                                                            Isaac Lab Expert   Failure Hunter   Test Analyzer
                                                                                    ↓                 ↓                 ↓
                                                                                    └─────────────────┼─────────────────┘
                                                                                                      ↓
                                                                                                 Aggregator
                                                                                                      ↓
                                                                                              GitHub PR Review
```

**Review Modes:**
- **New PRs:** Multi-agent review (3 specialized perspectives + aggregation)
- **Follow-up pushes:** Lightweight single-agent incremental review
- **Comment replies:** Context-aware conversational response

**Bot posts as:** GitHub App (`IsaacLab Review Bot[bot]`), not as any personal account.

## Multi-Agent Review System

New PRs get reviewed by 3 specialized agents in parallel, then aggregated:

### 1. Isaac Lab Expert (`agents/isaaclab-expert.md`)
- Architecture and design assessment
- Cross-module impact analysis
- Implementation correctness (tensor ops, simulation lifecycle)
- Framework-specific patterns and conventions

### 2. Silent Failure Hunter (`agents/silent-failure-hunter.md`)
*Inspired by [Anthropic's PR Review Toolkit](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit/agents)*
- Error handling audit
- Silent failure detection
- Broad exception catching
- Missing error checks

### 3. Test Coverage Analyzer (`agents/test-analyzer.md`)
*Inspired by [Superpowers](https://github.com/obra/superpowers) code review methodology*
- Test coverage quality
- Regression test requirements for bug fixes
- Test determinism and isolation
- Critical gap identification

### Aggregator (`agents/aggregator.md`)
- Deduplicates findings across agents
- Calibrates severity ratings
- Resolves conflicting assessments
- Produces unified review with 3-8 high-quality findings

## Files

```
agents/
  isaaclab-expert.md     — Domain expert prompt
  silent-failure-hunter.md — Error handling auditor prompt
  test-analyzer.md       — Test coverage analyst prompt
  aggregator.md          — Review synthesizer prompt
webhook/
  server.js              — Webhook receiver + agent trigger
  multi-agent.js         — Multi-agent task builder
  start.sh               — Start smee + server
  stop.sh                — Stop everything
  config.json            — App credentials (gitignored)
scripts/
  poll-prs.sh            — (Legacy) cron-based polling
  review-prompt.md       — Single-agent prompt reference
state.json               — Tracks reviewed PRs
```

## Setup

### Prerequisites
- Node.js 18+
- OpenClaw CLI (`openclaw`)
- smee-client (`npm install -g smee-client`)

### 1. Create GitHub App

| Setting | Value |
|---------|-------|
| Name | `IsaacLab Review Bot` |
| Homepage URL | `https://github.com/isaac-sim/IsaacLab` |
| Webhook URL | `https://smee.io/Il4Fu89qzX4Gpom` |
| Webhook secret | *(generate one)* |

**Permissions:** Pull requests (R&W), Contents (Read), Checks (Read), Metadata (Read)
**Events:** Pull requests, Pull request review comments, Issue comments
**Install on:** `isaac-sim/IsaacLab` only

### 2. Configure

```bash
cp webhook/config.json.template webhook/config.json
# Edit config.json with App ID, Installation ID, Private Key
```

### 3. Run with Supervisord (recommended)

```bash
# Create /etc/supervisor/conf.d/isaaclab-review-bot.conf
sudo supervisorctl reread && sudo supervisorctl update
sudo supervisorctl status isaaclab-review-bot isaaclab-review-smee
```

Or manually: `bash webhook/start.sh`

## What Gets Reviewed

### Design & Architecture
- Is this the right abstraction level?
- Does it follow Isaac Lab's ownership model?
- Cross-module impact analysis
- Alternative approaches considered

### Implementation
- Tensor shape/device/dtype correctness
- Simulation lifecycle (pre/post physics, reset handling)
- API contract compliance
- Performance implications

### Error Handling
- Silent failure detection
- Exception handling quality
- Fallback behavior appropriateness

### Test Coverage
- Regression tests for bug fixes (mandatory)
- Edge case coverage
- Test quality and determinism

### Style Guide
- License headers
- Docstring quality
- Type hints
- CHANGELOG updates

## Slash Commands

In PR comments:
- `/review` — Request a fresh full review
- `/rebase` — Rebase the PR branch onto base
- `/bot <question>` — Ask the bot a question

## Credits

Multi-agent architecture inspired by:
- [Superpowers](https://github.com/obra/superpowers) — Structured code review methodology
- [Anthropic PR Review Toolkit](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit/agents) — Specialized review agents
