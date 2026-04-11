// Multi-Agent Ensemble Review Task Builders
// Runs two parallel review pipelines with different models, then merges results
// into a single unified review. The final output must not reveal that multiple
// models were used — users see one coherent review.

const fs = require("fs");
const path = require("path");

const AGENTS_DIR = path.join(__dirname, "..", "agents");
const STATE_PATH = path.join(__dirname, "..", "state.json");
const REPO = "isaac-sim/IsaacLab";

// Model configuration for ensemble
// Two models provide independent perspectives; final output is unified.
const ENSEMBLE_MODELS = {
  primary: "nvidia/aws/anthropic/claude-opus-4-5",
  secondary: "nvidia/aws/anthropic/bedrock-claude-opus-4-6"
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

  return `You are the Isaac Lab Review Bot coordinator. Your job is to orchestrate a multi-perspective code review of PR #${prNum}.

## Architecture: Multi-Perspective Review

You will run **TWO parallel review pipelines**, then merge all findings into a **single unified review**.

Each pipeline spawns 3 specialized agents → 6 total agents → merged into one cohesive review.

**CRITICAL RULE: The final review posted on the PR must NOT mention, hint at, or reveal that multiple models or pipelines were used.** The users must see a single authoritative review as if written by one reviewer. No references to "Pipeline A", "Pipeline B", model names, ensemble, or multi-model anywhere in the posted review.

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

### Pipeline 1
Use \`model: "${ENSEMBLE_MODELS.primary}"\` for these 3 agents:

**Agent 1A: Isaac Lab Expert**
\`\`\`
${isaacLabExpert}
\`\`\`

**Agent 1B: Silent Failure Hunter**
\`\`\`
${silentFailureHunter}
\`\`\`

**Agent 1C: Test Coverage Analyzer**
\`\`\`
${testAnalyzer}
\`\`\`

### Pipeline 2
Use \`model: "${ENSEMBLE_MODELS.secondary}"\` for these 3 agents:

**Agent 2A: Isaac Lab Expert**
\`\`\`
${isaacLabExpert}
\`\`\`

**Agent 2B: Silent Failure Hunter**
\`\`\`
${silentFailureHunter}
\`\`\`

**Agent 2C: Test Coverage Analyzer**
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

**Spawn all 6 agents in parallel using the \`sessions_spawn\` TOOL:**

⚠️ CRITICAL: \`sessions_spawn\` is an API tool call, NOT a shell command!
Do NOT run \`openclaw sessions spawn\` in bash — that will fail.
Use the sessions_spawn tool directly with parameters: task, model, label.

Model assignments:
- Agents 1A, 1B, 1C: \`model: "${ENSEMBLE_MODELS.primary}"\`
- Agents 2A, 2B, 2C: \`model: "${ENSEMBLE_MODELS.secondary}"\`

After spawning all 6, use \`sessions_yield\` to wait for results.

## Step 3: Aggregate & Deduplicate Results

Once all 6 agents return, merge their outputs using this aggregation guide:

\`\`\`
${aggregator}
\`\`\`

### Aggregation Rules:

1. **High-confidence findings** (found by both pipelines): These are very likely real issues — prioritize them
2. **Single-pipeline findings**: Still include if valid, but verify carefully before marking Critical
3. **Deduplicate aggressively**: Same issue found by multiple agents → merge into one finding
4. **DO NOT mention pipelines, models, or ensemble in the output**: The review must read as one unified analysis. Never say "multiple reviewers found", "both analyses flagged", or anything that implies more than one review pass.
5. **Don't double-count**: 6 agents finding the same bug = 1 finding, not 6

### Severity Calibration:
- 🔴 **Critical**: Confirmed by multiple agents OR clear correctness bug
- ⚠️ **Warning**: High confidence finding, notable impact
- 💡 **Suggestion**: Nice-to-have improvements

## Step 4: Validate the Aggregated Review

Before posting, run a thorough validation pass on the aggregated review:

### Validation Checklist:
1. **No model/pipeline leaks**: Scan the entire review text. It must NOT contain:
   - Any model names ("Opus", "Claude", "Bedrock", "4.5", "4.6")
   - References to pipelines ("Pipeline A/B", "both analyses", "multiple reviewers")
   - References to ensemble/multi-model approach
   - Any phrasing that implies more than one review pass occurred
   If found, rewrite those sections to read as a single unified review.

2. **Finding accuracy**: For every finding:
   - Re-read the relevant code to confirm the issue is real
   - Verify file paths and line numbers exist in the diff
   - Ensure the fix suggestion is correct and complete
   - Remove any finding you cannot independently verify from the code

3. **Actionability check**: Every finding must:
   - State exactly what is wrong with evidence
   - Explain WHY it matters (impact)
   - Provide a concrete fix (code suggestion preferred)
   - Remove vague findings ("might", "could", "consider")

4. **Severity calibration**: Review all severity ratings:
   - 🔴 Critical should be reserved for real bugs, data corruption, or correctness issues
   - 🟡 Warning for design concerns, missing error handling with realistic failure modes
   - 🔵 Suggestion for quality improvements
   - Downgrade any over-inflated severities

5. **Coherence check**: Read the full review as if you wrote it all yourself:
   - Does the summary match the findings?
   - Is the verdict consistent with the severity of findings?
   - Are there contradictions between different findings?
   - Does it flow naturally as a single cohesive review?

6. **Signal-to-noise**: Aim for 3-8 high-quality findings:
   - If you have >10 findings, cut the weakest ones
   - Every finding must be worth the author's time to investigate
   - Remove duplicates and near-duplicates

Only proceed to posting after ALL validation checks pass.

## Step 5: Post the Review

Build a JSON payload with the validated review and post it:

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

## Step 6: Update State

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
2. **Specify model explicitly** for each agent (3 per pipeline)
3. **Deduplicate findings** — same issue from multiple agents = one finding
4. **NEVER reveal the multi-model/ensemble approach** — the posted review must read as one unified review
5. **Quality over quantity** — aim for 5-10 high-quality findings, not exhaustive lists
6. **Validate thoroughly before posting** — every finding must be correct, actionable, and verified
7. **Run the full validation checklist** (Step 4) before posting — no shortcuts

Internal report (NOT posted to GitHub): PR number, findings per agent, overlap stats, final aggregated count, verdict.`;
}

// Export for use in server
module.exports = { buildMultiAgentReviewTask, loadAgentPrompt, ENSEMBLE_MODELS };
