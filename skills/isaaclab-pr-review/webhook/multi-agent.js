// Multi-Agent Review Task Builders
// These create tasks for the 3 specialized review agents + aggregator

const fs = require("fs");
const path = require("path");

const AGENTS_DIR = path.join(__dirname, "..", "agents");
const STATE_PATH = path.join(__dirname, "..", "state.json");
const REPO = "isaac-sim/IsaacLab";

// Import identity check from server
function identityCheckBlock(token) {
  return `## 🛑 MANDATORY: Bot Authentication (MUST run before ANY GitHub operation)

**CRITICAL SAFEGUARD**: This prevents accidentally posting as the user's personal account.

\`\`\`bash
# Step 1: Set the bot token
export GH_TOKEN="${token}"

# Step 2: Verify identity — MUST be the bot app
IDENTITY=$(curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/user | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('login','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
echo "Authenticated as: $IDENTITY"

# Step 3: ABORT if not bot — this is a hard stop, no exceptions
if [[ "$IDENTITY" != *"[bot]"* ]]; then
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║  FATAL: NOT AUTHENTICATED AS BOT                              ║"
  echo "║  Identity: $IDENTITY                                          ║"
  echo "║  ABORTING — refusing to post as personal account              ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  # DO NOT CONTINUE — report this error and stop the task
  exit 1
fi
echo "✓ Bot authentication verified: $IDENTITY"
\`\`\`

## HARD RULES — VIOLATION = TASK FAILURE
1. **RUN THE ABOVE BLOCK FIRST** — before ANY \`gh\` or \`curl\` command to GitHub
2. **If identity check fails → STOP IMMEDIATELY** — do not attempt workarounds
3. **NEVER use \`gh\` without GH_TOKEN** — the default gh auth is the user's personal account
4. **ALL GitHub API calls MUST include** \`-H "Authorization: Bearer $GH_TOKEN"\`
5. **If you see "Not authenticated as bot"** → Report the error and END the task. Do NOT proceed.
`;
}

function loadAgentPrompt(agentName) {
  const filePath = path.join(AGENTS_DIR, `${agentName}.md`);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    console.warn(`[agents] Could not load ${filePath}: ${e.message}`);
    return null;
  }
}

function buildMultiAgentReviewTask(pr, token) {
  const prNum = pr.number;
  const headRef = pr.head.ref;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;
  const stateFilePath = STATE_PATH;

  // Load agent prompts
  const isaacLabExpert = loadAgentPrompt("isaaclab-expert");
  const silentFailureHunter = loadAgentPrompt("silent-failure-hunter");
  const testAnalyzer = loadAgentPrompt("test-analyzer");
  const aggregator = loadAgentPrompt("aggregator");

  // If any agent prompt is missing, fall back to single-agent review
  if (!isaacLabExpert || !silentFailureHunter || !testAnalyzer || !aggregator) {
    console.warn("[agents] Missing agent prompts, falling back to single-agent review");
    return null; // Caller should fall back to buildReviewTask
  }

  return `You are the Isaac Lab Review Bot coordinator. Your job is to orchestrate a multi-perspective code review of PR #${prNum}.

## Architecture

You will spawn 3 specialized sub-agents in PARALLEL, wait for all results, then synthesize them into one cohesive review.

${identityCheckBlock(token)}

## PR Details
- Number: #${prNum}
- Title: ${pr.title.replace(/"/g, '\\"')}
- Author: @${pr.user.login}
- Head: ${headRef} (${headSha})
- Base: ${baseRef}
- Files changed: ${pr.changed_files}
- URL: ${pr.html_url}

## Step 1: Gather Context

First, fetch the PR diff and file list for the sub-agents:

\`\`\`bash
export GH_TOKEN="${token}"
gh pr view ${prNum} --repo ${REPO} --json title,body,author,baseRefName,headRefName,files,commits,labels
gh pr diff ${prNum} --repo ${REPO} --name-only
gh pr diff ${prNum} --repo ${REPO}
gh pr checks ${prNum} --repo ${REPO}
\`\`\`

Save this context — you'll include relevant parts in each sub-agent task.

## Step 2: Spawn 3 Review Agents in Parallel

Use \`sessions_spawn\` to create 3 sub-agents. Each gets:
1. The PR context (diff, files, description)
2. Their specialized prompt
3. The GH_TOKEN for API calls

**Agent 1: Isaac Lab Expert** (architecture, design, implementation)
\`\`\`
${isaacLabExpert}
\`\`\`

**Agent 2: Silent Failure Hunter** (error handling, edge cases)
\`\`\`
${silentFailureHunter}
\`\`\`

**Agent 3: Test Coverage Analyzer** (test quality, coverage gaps)
\`\`\`
${testAnalyzer}
\`\`\`

For each agent, create a task like:
\`\`\`
You are reviewing PR #${prNum} on isaac-sim/IsaacLab.

## Authentication
export GH_TOKEN="${token}"

## PR Context
{Include: PR title, description, file list, relevant diff sections}

## Your Specialized Role
{Include the agent's prompt from above}

## Instructions
1. Fetch full files as needed (not just diff)
2. Apply your specialized analysis
3. Output your findings in the format specified in your role description
4. Be thorough but precise — quality over quantity
\`\`\`

Spawn all 3 with \`sessions_spawn\` and use \`sessions_yield\` to wait for results.

## Step 3: Aggregate Results

Once all 3 agents return, synthesize their outputs using this aggregation guide:

\`\`\`
${aggregator}
\`\`\`

## Step 4: Post the Review

Build a JSON payload with the aggregated review and post it:

\`\`\`bash
curl -s -X POST \\
  -H "Authorization: Bearer ${token}" \\
  -H "Accept: application/vnd.github+json" \\
  https://api.github.com/repos/${REPO}/pulls/${prNum}/reviews \\
  -d '{
    "body": "<aggregated review markdown>",
    "event": "COMMENT",
    "comments": [<inline comments if any>]
  }'
\`\`\`

Use event "COMMENT" — never "APPROVE" or "REQUEST_CHANGES" automatically.

For inline comments, use this structure:
\`\`\`json
{
  "path": "path/to/file.py",
  "line": 42,
  "side": "RIGHT",
  "body": "🔴 **Critical:** ..."
}
\`\`\`

**CRITICAL for inline comments:**
- \`line\` must be the line number in the NEW version of the file (right side of diff)
- The line MUST appear in the PR diff (added or modified lines only)
- Use \`side: "RIGHT"\` for comments on new/modified code
- If a finding references a line NOT in the diff, put it in the review body instead (not as inline comment)
- To find valid line numbers: look at the \`@@ -X,Y +Z,W @@\` hunk headers and count from Z

**To verify a line is in the diff before posting:**
\`\`\`bash
gh pr diff ${prNum} --repo ${REPO} | grep -n "^+" | head -50  # Shows added lines with positions
\`\`\`

## How to Build the Comments Array

For EACH finding that references a specific line in a changed file:

1. **Parse the finding**: Extract file path and line number from "file.py:42" format
2. **Check if line is in diff**: The line must be an ADDED or MODIFIED line (appears with "+" prefix in diff)
3. **Get the line number in the new file**: Look at the hunk header \`@@ -old,len +new,len @@\` — use the NEW side line number
4. **Build the comment object**:
   \`\`\`json
   {"path": "source/file.py", "line": 42, "side": "RIGHT", "body": "🔴 **Critical:** The issue..."}
   \`\`\`

**Example workflow:**
\`\`\`bash
# 1. Find what lines are added/modified in a specific file
gh pr diff ${prNum} --repo ${REPO} | grep -A5 "^+++ b/source/isaaclab/file.py" | head -20

# 2. Look for the line number in hunk headers like @@ -10,5 +10,8 @@
#    The +10 means new file starts at line 10 in this hunk

# 3. Count lines from there to find your target line's position
\`\`\`

**If a finding's line is NOT in the diff** (e.g., it's about existing code context), include it in the review body text instead of the comments array.

## Step 5: Update State

\`\`\`bash
node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('${stateFilePath}', 'utf8'));
s.reviewed_prs = s.reviewed_prs || {};
s.reviewed_prs['${prNum}'] = {
  last_reviewed_sha: '${headSha}',
  reviewed_at: new Date().toISOString(),
  status: 'reviewed',
  review_type: 'multi-agent'
};
delete (s.pending_reviews || {})['${prNum}'];
fs.writeFileSync('${stateFilePath}', JSON.stringify(s, null, 2) + '\\n');
console.log('State updated for PR #${prNum}');
"
\`\`\`

## Important Notes

1. **Spawn agents in parallel** — don't wait for one before starting another
2. **Deduplicate findings** — if multiple agents flag the same issue, merge them
3. **Calibrate severity** — ensure Critical/Warning/Suggestion are applied consistently
4. **Quality over quantity** — aim for 3-8 findings total, not exhaustive lists
5. **Verify before posting** — every finding must be correct and actionable

Report: PR number, number of findings from each agent, final aggregated findings count, overall verdict.`;
}

// Export for use in server
module.exports = { buildMultiAgentReviewTask, loadAgentPrompt };
