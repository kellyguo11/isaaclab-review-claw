// Multi-Agent Ensemble Review Task Builders
// Runs two parallel review pipelines with different models, then merges results

const fs = require("fs");
const path = require("path");

const AGENTS_DIR = path.join(__dirname, "..", "agents");
const STATE_PATH = path.join(__dirname, "..", "state.json");
const REPO = "isaac-sim/IsaacLab";

// Model configuration for ensemble
const ENSEMBLE_MODELS = {
  primary: "nvidia/aws/anthropic/claude-opus-4-5",    // NVIDIA NIM - thorough analysis
  secondary: "nvidia/aws/anthropic/bedrock-claude-opus-4-6"  // Bedrock - different perspective
};

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

  return `You are the Isaac Lab Review Bot coordinator. Your job is to orchestrate an **ENSEMBLE** multi-model code review of PR #${prNum}.

## Architecture: Ensemble Multi-Model Review

You will run **TWO parallel review pipelines** using different models, then merge all findings:

**Pipeline A (Opus 4.5 - NVIDIA NIM):** Known for thorough, detailed analysis
**Pipeline B (Opus 4.6 - Bedrock):** Different perspective, catches different issues

Each pipeline spawns 3 specialized agents → 6 total agents → merged into one cohesive review.

This ensemble approach catches more issues because different models have different blind spots.

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

## Step 2: Spawn 6 Review Agents (2 Pipelines × 3 Agents)

Use \`sessions_spawn\` to create agents. **CRITICAL: Specify the model for each agent.**

### Pipeline A: Opus 4.5 (NVIDIA NIM)
Use \`model: "${ENSEMBLE_MODELS.primary}"\` for these 3 agents:

**Agent A1: Isaac Lab Expert (4.5)**
\`\`\`
${isaacLabExpert}
\`\`\`

**Agent A2: Silent Failure Hunter (4.5)**
\`\`\`
${silentFailureHunter}
\`\`\`

**Agent A3: Test Coverage Analyzer (4.5)**
\`\`\`
${testAnalyzer}
\`\`\`

### Pipeline B: Opus 4.6 (Bedrock)
Use \`model: "${ENSEMBLE_MODELS.secondary}"\` for these 3 agents:

**Agent B1: Isaac Lab Expert (4.6)**
\`\`\`
${isaacLabExpert}
\`\`\`

**Agent B2: Silent Failure Hunter (4.6)**
\`\`\`
${silentFailureHunter}
\`\`\`

**Agent B3: Test Coverage Analyzer (4.6)**
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

**Spawn all 6 agents in parallel** with \`sessions_spawn\`, specifying the model:
- Agents A1, A2, A3: \`model: "${ENSEMBLE_MODELS.primary}"\`
- Agents B1, B2, B3: \`model: "${ENSEMBLE_MODELS.secondary}"\`

Use \`sessions_yield\` to wait for all results.

## Step 3: Aggregate & Deduplicate Results

Once all 6 agents return, merge their outputs using this aggregation guide:

\`\`\`
${aggregator}
\`\`\`

### Ensemble-Specific Aggregation Rules:

1. **High-confidence findings** (found by both models): Mark with 🔴 or ⚠️ — these are very likely real issues
2. **Single-model findings** (found by only one model): Still include, but verify carefully before marking Critical
3. **Deduplicate aggressively**: Same issue found by multiple agents → merge into one finding
4. **Note model agreement**: In findings, you can mention "Both Opus 4.5 and 4.6 flagged this" for high-confidence issues
5. **Don't double-count**: 6 agents finding the same bug = 1 finding, not 6

### Severity Calibration:
- 🔴 **Critical**: Confirmed by both models OR clear correctness bug
- ⚠️ **Warning**: High confidence from one model, or both models agree it's notable
- 💡 **Suggestion**: Nice-to-have improvements, single model only

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
  review_type: 'ensemble-multi-model'
};
delete (s.pending_reviews || {})['${prNum}'];
fs.writeFileSync('${stateFilePath}', JSON.stringify(s, null, 2) + '\\n');
console.log('State updated for PR #${prNum}');
"
\`\`\`

## Important Notes

1. **Spawn ALL 6 agents in parallel** — don't wait for one before starting another
2. **Specify model explicitly** for each agent (3x Opus 4.5, 3x Opus 4.6)
3. **Deduplicate findings** — same issue from multiple agents = one finding
4. **Note model agreement** — higher confidence when both models concur
5. **Quality over quantity** — aim for 5-10 high-quality findings, not exhaustive lists
6. **Verify before posting** — every finding must be correct and actionable

Report: PR number, findings per agent (A1-A3, B1-B3), overlap stats, final aggregated count, verdict.`;
}

// Export for use in server
module.exports = { buildMultiAgentReviewTask, loadAgentPrompt, ENSEMBLE_MODELS };
