# HEARTBEAT.md

## Pending PR Review Tasks
Check for pending review tasks in `skills/isaaclab-pr-review/pending-tasks/`. For each `.json` file found:
1. Read the task file to get the `task` and `label` fields
2. Spawn a sub-agent with `sessions_spawn` using the task content
3. Delete the task file after spawning
If no pending tasks, skip this check.
