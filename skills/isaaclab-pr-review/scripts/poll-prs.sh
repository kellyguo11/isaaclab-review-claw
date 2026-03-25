#!/bin/bash
# Isaac Lab PR Review — Poll Script
# Lists open PRs and outputs JSON for the orchestrator to process
# Usage: bash poll-prs.sh [state_file]

set -euo pipefail

REPO="isaac-sim/IsaacLab"
STATE_FILE="${1:-$(dirname "$0")/../state.json}"

# Ensure state file exists
if [ ! -f "$STATE_FILE" ]; then
  echo '{"reviewed_prs":{},"last_poll":null}' > "$STATE_FILE"
fi

# Fetch open PRs (last 20, sorted by updated)
PRS=$(gh pr list --repo "$REPO" --state open --limit 20 \
  --json number,title,author,headRefName,headRefOid,updatedAt,createdAt,labels,files \
  2>/dev/null)

# Load state
STATE=$(cat "$STATE_FILE")

# Find PRs that need review:
# 1. Not yet reviewed, OR
# 2. Updated since last review (new commits pushed)
echo "$PRS" | jq --argjson state "$STATE" '
  [.[] | 
    . as $pr |
    ($state.reviewed_prs[($pr.number | tostring)] // null) as $reviewed |
    if $reviewed == null then
      . + {review_reason: "new_pr"}
    elif $reviewed.last_reviewed_sha != $pr.headRefOid then
      . + {review_reason: "updated_since_review"}
    else
      empty
    end
  ]
'
