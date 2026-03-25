#!/usr/bin/env node
// Isaac Lab PR Review Bot — Webhook Server
// Receives GitHub webhooks (via smee.io proxy), verifies signatures,
// and triggers OpenClaw agent sessions for PR reviews and comment replies.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const jwt = require("jsonwebtoken");

// --- Configuration ---
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "..", "state.json");
const PORT = parseInt(process.env.WEBHOOK_PORT || "19876", 10);
const REPO = "isaac-sim/IsaacLab";

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error(`Missing or invalid ${CONFIG_PATH}. Create it with app credentials.`);
  process.exit(1);
}

const WEBHOOK_SECRET = config.webhookSecret;
const APP_ID = config.appId;
const PRIVATE_KEY = config.privateKey;
const INSTALLATION_ID = config.installationId;

// --- Token Management ---
let cachedToken = null;
let tokenExpiresAt = 0;

function generateJWT() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 60 sec clock drift allowance
    exp: now + 600, // 10 min max for app JWTs
    iss: APP_ID,
  };
  return jwt.sign(payload, PRIVATE_KEY, { algorithm: "RS256" });
}

async function getInstallationToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const appJwt = generateJWT();
  const res = await fetch(
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.expires_at).getTime();
  console.log(`[token] Refreshed installation token, expires at ${data.expires_at}`);
  return cachedToken;
}

// --- GitHub API helpers ---
async function ghApi(endpoint, method = "GET", body = null) {
  const token = await getInstallationToken();
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`https://api.github.com${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    console.error(`[ghApi] ${method} ${endpoint} -> ${res.status}: ${text}`);
    return null;
  }
  return res.json();
}

// --- Signature Verification ---
function verifySignature(payload, signature) {
  if (!signature) return false;
  const sig = Buffer.from(signature.replace("sha256=", ""), "hex");
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(payload);
  const digest = hmac.digest();
  return crypto.timingSafeEqual(sig, digest);
}

// --- State Management ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { reviewed_prs: {}, last_poll: null, pending_reviews: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// --- Dedup / Rate Limiting ---
const recentEvents = new Map(); // key -> timestamp
const DEDUP_WINDOW_MS = 120_000; // 2 min

function isDuplicate(key) {
  const now = Date.now();
  // Clean old entries
  for (const [k, ts] of recentEvents) {
    if (now - ts > DEDUP_WINDOW_MS) recentEvents.delete(k);
  }
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, now);
  return false;
}

// --- OpenClaw Agent Trigger ---
// We use the cron wake mechanism to inject a system event into the main session,
// or spawn an isolated agent session via the gateway API.
function triggerAgent(task, label) {
  // Use openclaw CLI to inject into a session
  const sanitizedTask = task.replace(/'/g, "'\\''");
  const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "/home/horde/.npm-global/bin/openclaw";
  try {
    // Write task to a temp file to avoid shell escaping issues
    const tmpFile = `/tmp/isaaclab-review-task-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, task);
    const cmd = `${OPENCLAW_BIN} send --file "${tmpFile}" --label "${label}" --timeout 0 2>&1 || true`;
    console.log(`[agent] Triggering: ${label}`);
    const result = execSync(cmd, { timeout: 10000, encoding: "utf8" });
    console.log(`[agent] Result: ${result.trim().slice(0, 200)}`);
    // Clean up
    try { fs.unlinkSync(tmpFile); } catch {}
  } catch (e) {
    console.error(`[agent] Failed to trigger via CLI, falling back to cron wake`);
    // Fallback: write task to a file and use cron wake
    const taskFile = path.join(__dirname, "..", `pending-task-${Date.now()}.json`);
    fs.writeFileSync(taskFile, JSON.stringify({ task, label, created: new Date().toISOString() }));
    console.log(`[agent] Wrote pending task to ${taskFile}`);
  }
}

// --- Event Handlers ---

async function handlePullRequest(payload) {
  const action = payload.action;
  const pr = payload.pull_request;
  const prNum = pr.number;

  // Only trigger on open, synchronize (new push), reopened
  if (!["opened", "synchronize", "reopened"].includes(action)) {
    console.log(`[pr] Ignoring action=${action} for PR #${prNum}`);
    return;
  }

  const dedupKey = `pr-${prNum}-${pr.head.sha}`;
  if (isDuplicate(dedupKey)) {
    console.log(`[pr] Dedup: already processing PR #${prNum} @ ${pr.head.sha.slice(0, 8)}`);
    return;
  }

  console.log(`[pr] PR #${prNum} ${action}: "${pr.title}" by @${pr.user.login} (${pr.head.sha.slice(0, 8)})`);

  // Check if we already reviewed this exact SHA
  const state = loadState();
  const existing = state.reviewed_prs[String(prNum)];
  if (existing && existing.last_reviewed_sha === pr.head.sha) {
    console.log(`[pr] Already reviewed PR #${prNum} at SHA ${pr.head.sha.slice(0, 8)}, skipping`);
    return;
  }

  // Get the installation token for the sub-agent to use
  const token = await getInstallationToken();

  const task = buildReviewTask(pr, token);
  triggerAgent(task, `isaaclab-pr-review-${prNum}`);

  // Mark as pending
  state.pending_reviews = state.pending_reviews || {};
  state.pending_reviews[String(prNum)] = {
    sha: pr.head.sha,
    triggered_at: new Date().toISOString(),
    action,
  };
  saveState(state);
}

async function handlePRReviewComment(payload) {
  const action = payload.action;
  const comment = payload.comment;
  const pr = payload.pull_request;
  const prNum = pr.number;

  // Only handle new comments (not edits/deletes)
  if (action !== "created") return;

  // Don't respond to our own comments (check if author is the app bot)
  const botLogin = config.botLogin || "isaaclab-review-bot[bot]";
  if (comment.user.login === botLogin || comment.user.type === "Bot") {
    console.log(`[comment] Ignoring own comment on PR #${prNum}`);
    return;
  }

  const dedupKey = `comment-${comment.id}`;
  if (isDuplicate(dedupKey)) return;

  console.log(`[comment] PR #${prNum}: @${comment.user.login} replied to review comment: "${comment.body.slice(0, 100)}..."`);

  const token = await getInstallationToken();
  const task = buildCommentReplyTask(pr, comment, token);
  triggerAgent(task, `isaaclab-pr-comment-${prNum}-${comment.id}`);
}

async function handleIssueComment(payload) {
  const action = payload.action;
  const comment = payload.comment;
  const issue = payload.issue;

  // Only PRs have pull_request field
  if (!issue.pull_request) return;
  if (action !== "created") return;

  const botLogin = config.botLogin || "isaaclab-review-bot[bot]";
  if (comment.user.login === botLogin || comment.user.type === "Bot") return;

  const prNum = issue.number;
  const dedupKey = `issue-comment-${comment.id}`;
  if (isDuplicate(dedupKey)) return;

  // Check if the comment mentions the bot or is a reply to the bot's review
  const botMentioned = comment.body.includes(`@${botLogin.replace("[bot]", "")}`) ||
                       comment.body.toLowerCase().includes("@isaaclab-review");

  if (!botMentioned) {
    // Check if this is a reply in a thread started by the bot
    // For now, skip general PR comments that don't mention the bot
    console.log(`[issue-comment] PR #${prNum}: @${comment.user.login} commented but didn't mention bot, skipping`);
    return;
  }

  console.log(`[issue-comment] PR #${prNum}: @${comment.user.login} mentioned bot: "${comment.body.slice(0, 100)}..."`);

  const token = await getInstallationToken();
  const task = buildGeneralReplyTask(issue, comment, token);
  triggerAgent(task, `isaaclab-pr-reply-${prNum}-${comment.id}`);
}

// --- Task Builders ---

function buildReviewTask(pr, token) {
  const prNum = pr.number;
  const headRef = pr.head.ref;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;
  const stateFilePath = STATE_PATH;

  return `You are a ruthlessly thorough senior staff engineer on the Isaac Lab project (isaac-sim/IsaacLab). You have deep, first-principles understanding of the entire codebase: the core framework (isaaclab), task environments (isaaclab_tasks), RL wrappers (isaaclab_rl), asset configs (isaaclab_assets), and mimic (isaaclab_mimic). You understand GPU simulation, tensor pipelines, physics stepping, and RL training loops at a low level.

Your job: perform an exhaustive, implementation-level code review of PR #${prNum} on isaac-sim/IsaacLab.

## Review Philosophy

**Be harsh. Be precise. Be right.**

You are the last line of defense before code merges into a robotics simulation framework used in production. Every bug you miss could corrupt training runs, cause silent numerical errors, or break downstream users.

**Rules of engagement:**
1. **Every comment MUST be correct.** Before posting a comment, verify your claim by reading the actual code. If you're not sure, fetch the file and confirm. A wrong review comment is worse than no comment.
2. **No nit-picking.** Do NOT comment on: formatting (ruff handles it), import ordering (isort handles it), minor style preferences, or things that are correct but "could be done differently."
3. **No overly conservative warnings.** Do NOT flag: standard Python patterns as "risky," working code as "could theoretically fail in edge cases" without demonstrating the edge case, or hypothetical performance concerns without evidence.
4. **Every comment must be actionable.** State what's wrong, WHY it's wrong (with evidence), and how to fix it. Include a \\\`\\\`\\\`suggestion block whenever possible.
5. **Read the full file, not just the diff.** Diff-only reviews miss context. Always fetch the complete file before commenting.
6. **Trace the blast radius.** For every changed function/class/API, find what calls it.
7. **Verify before you claim.** If you think a function doesn't exist, a type is wrong, or an import is missing — CHECK. Search. Fetch the file. Don't guess.

**What makes a comment worth posting:**
- 🔴 Bugs: logic errors, off-by-one, wrong variable, incorrect tensor shapes, device mismatches
- 🔴 Silent failures: code that runs but produces wrong results — wrong math, swapped args, missing negation, incorrect broadcasting
- 🔴 Data corruption: state mutation bleeding across resets, missing .clone()/.detach(), buffer aliasing
- 🟡 Semantic errors: wrong behavior under specific but realistic conditions
- 🟡 API contract violations: breaking public API without deprecation, changing return types
- 🟡 Missing error handling: only when the failure mode is realistic and the result is confusing crash or silent corruption
- 🔵 Code quality improvements that raise the bar: dead code that should be removed, unclear abstractions that will confuse the next person, duplicated logic that should be factored out, misleading variable names that will cause bugs later, missing validation that will produce cryptic errors, suboptimal algorithms where a clearly better approach exists, inconsistency with established patterns in the rest of the codebase
- 🔵 Concrete performance improvements: unnecessary allocations in hot paths, O(n²) where O(n) is straightforward, repeated computation that should be cached, GPU↔CPU round-trips that can be eliminated

**The quality bar:** This codebase must be top-notch. Every PR is an opportunity to make it cleaner. If you see code that "works but shouldn't pass review at a top-tier engineering org," flag it with a concrete improvement. The goal is a codebase where every file is exemplary — not just functional.

**The signal-to-noise rule:** Every comment you post must be worth the author's time to investigate. If an engineer reads your comment and thinks "yeah, that's a real improvement," you've succeeded. If they think "this is pedantic" or "this is wrong," you've failed. When in doubt: would YOU want to receive this comment on your own PR? Would it make you a better engineer or just annoy you?

**What is NOT worth posting:**
- Formatting, import ordering, or anything ruff/pre-commit auto-catches
- "What if X is None?" without proving X can actually be None in a realistic path
- "This might be slow" without demonstrating where the bottleneck is
- Generic style preferences not grounded in the project's actual conventions
- Praising good code inline (save acknowledgments for the summary)
- Restating what the code already clearly does ("this function calls X") — only comment if there's something to improve

## Test Coverage Requirements

**Non-negotiable.** Every PR must be evaluated for test coverage:

**Bug fix PRs:** MUST include a unit test that reproduces the bug and verifies the fix. The test should fail before the fix and pass after. A bug fix without a regression test is 🔴 Critical — the same bug can silently return. Evaluate included tests carefully: does the test actually exercise the specific code path that was broken? A test that passes regardless of the fix is useless.

**New feature PRs:** MUST include unit tests covering new code paths — normal operation, edge cases, and error handling. No tests = 🟡 Warning — new features without tests are tech debt from day one.

**Test quality evaluation (when tests ARE included):**
- Does the test actually test what it claims? Read assertions carefully.
- Does the test cover the failure mode? For bug fixes, it must exercise the exact condition that triggered the bug.
- Is the test deterministic? Watch for random seeds, timing deps, float comparisons without tolerances.
- Is the test isolated? No global state deps, no order-dependent assertions.
- Are edge cases covered? Empty inputs, zero-length tensors, single-env, boundary values.
- Will the test catch regressions? If someone reintroduces this bug in 6 months, will this test catch it?

**When tests are NOT required:** Pure refactoring covered by existing tests, doc-only changes, config/CI/build changes, trivial fixes (typos) with near-zero regression risk.

## Authentication
You MUST use this token for ALL GitHub API calls (this is the bot app token, NOT the user's personal token):
export GH_TOKEN="${token}"

For gh CLI commands, set: export GH_TOKEN="${token}"
For curl: -H "Authorization: Bearer ${token}"

## PR Details
- Number: #${prNum}
- Title: ${pr.title.replace(/"/g, '\\"')}
- Author: @${pr.user.login}
- Head: ${headRef} (${headSha})
- Base: ${baseRef}
- Files changed: ${pr.changed_files}
- URL: ${pr.html_url}

## Review Process

### Step 1: Understand the PR
\`\`\`bash
export GH_TOKEN="${token}"
gh pr view ${prNum} --repo ${REPO} --json title,body,author,baseRefName,headRefName,files,commits,labels
gh pr diff ${prNum} --repo ${REPO}
gh pr diff ${prNum} --repo ${REPO} --name-only
\`\`\`

Read the PR description carefully. Understand WHAT is being changed and WHY. If the description is vague, note that in the summary.

### Step 2: Deep-dive into changed files
For EVERY changed file:

1. **Fetch the full file at PR HEAD** (not just the diff):
\`\`\`bash
gh api repos/${REPO}/contents/{FILE_PATH}?ref=${headRef} -H "Accept: application/vnd.github.raw+json"
\`\`\`

2. **Fetch the base version** for comparison on non-trivial changes:
\`\`\`bash
gh api repos/${REPO}/contents/{FILE_PATH}?ref=${baseRef} -H "Accept: application/vnd.github.raw+json"
\`\`\`

3. **Trace dependencies** — for any modified function/class, find what imports it:
\`\`\`bash
gh api "search/code?q=repo:isaac-sim/IsaacLab+{MODULE_NAME}+language:python" --jq '.items[].path'
\`\`\`

4. **Check related configs** — if a class is modified, find its \`*_cfg.py\` counterpart and vice versa.

5. **Read surrounding test files** — if a test is modified, understand what it's testing and whether the test change is correct or is masking a real bug.

### Step 3: Implementation-Level Analysis

For EVERY hunk in the diff, analyze at the implementation level:

**Correctness:**
- Does the new code do what the PR description claims?
- Are conditional branches correct? Check boundary conditions.
- Are loop invariants maintained?

**Tensor/Math Operations (critical for this codebase):**
- Shape correctness: trace tensor shapes through every operation. Write them out.
- Device consistency: are all tensors on the same device? Any silent CPU↔GPU transfers?
- Dtype correctness: float32 vs float64 vs int, implicit casting that loses precision?
- Broadcasting: is it intentional or accidental?
- In-place operations: do they break autograd? Are they on leaf tensors?
- Missing .clone(): is a tensor being modified that's a view of another tensor?
- Missing .detach(): is a tensor carrying gradients into a no-grad context?
- Index operations: correct dimensions? Off-by-one?

**Simulation Lifecycle:**
- Pre-physics vs post-physics: are operations in the correct phase?
- Reset handling: does env_ids partial reset work correctly? Are buffers properly zeroed/reinitialized?
- State corruption: can state from one episode bleed into the next?
- Articulation/rigid body API: correct joint indices, body indices, DOF ordering?

**Config/Dataclass:**
- New fields: do they have defaults? Are defaults sane?
- class_type/func references: do they point to real, importable classes?
- __post_init__ logic: correct validation, no side effects during config construction?

### Step 4: Cross-Module Impact Analysis

1. **Changed APIs:** For every function/method/class whose signature or behavior changed:
   - Search for ALL callers across the repo
   - Verify each caller is compatible with the new behavior
   - If a return type changes, trace what consumes the return value

2. **Changed configs:** For every config field added/removed/renamed:
   - Search for all references to that field
   - Check if any YAML/JSON configs or scripts reference it

3. **Removed code:** For every deletion:
   - Was it actually unused? Search for references.
   - Was it part of a public API? If so, is there a deprecation path?

### Step 5: Check CI
\`\`\`bash
gh pr checks ${prNum} --repo ${REPO}
gh api repos/${REPO}/commits/${headSha}/check-runs --jq '.check_runs[] | {name, status, conclusion}'
\`\`\`
For failures, investigate logs and determine if PR-caused or pre-existing.

### Step 6: Self-Check Before Posting

Before composing the review, go through EVERY inline comment you plan to post and ask:
1. **Is this actually wrong?** Did I verify by reading the full file?
2. **Is this actionable?** Does the author know exactly what to change?
3. **Is this worth the author's time?** Would a senior engineer care, or is it noise?
4. **Am I sure about the context?** Did I check what calls this code?
5. **Am I being specific?** "This might cause issues" is useless. "This tensor has shape [N,3] but line 42 expects [N,4]" is useful.

**Delete any comment that fails these checks.** 5 precise, verified comments > 20 hedging maybes.

### Step 7: Post Review
Build a JSON payload and post via the API. The review body should follow this format:

\`\`\`markdown
## 🤖 Isaac Lab Review Bot

### Summary
{2-3 sentences: what does this PR do, and is it correct? Be direct.}

### Architecture Impact
{Cross-module impact analysis. Who calls the changed code? What breaks? Or "No cross-module impact — changes are self-contained."}

### Implementation Verdict
{One of:
- **Ship it** — Clean implementation, no issues found.
- **Minor fixes needed** — Correct approach, N issues to address.
- **Significant concerns** — Problems that could cause {specific bad outcomes}.
- **Needs rework** — Fundamental approach has issues.}

### Test Coverage
{Evaluate test coverage:
- For bug fixes: Does the PR include a regression test? Does the test actually reproduce the original bug?
- For new features: Are the new code paths tested? What's missing?
- For existing tests: Are they well-written, deterministic, and targeted?
- If no tests needed (pure refactor, docs-only, etc.), state why.}

### CI Status
{Test failures and analysis, or "All checks passing ✅"}

### Findings
{Each finding must be concrete:
🔴 **Critical: {file}:{line} — {what's wrong and why it matters}**
🟡 **Warning: {file}:{line} — {what's wrong and the realistic impact}**
🔵 **Improvement: {file}:{line} — {what to change and the concrete benefit}**}
\`\`\`

Post with inline comments using:
\`\`\`bash
curl -s -X POST \\
  -H "Authorization: Bearer ${token}" \\
  -H "Accept: application/vnd.github+json" \\
  https://api.github.com/repos/${REPO}/pulls/${prNum}/reviews \\
  -d '<json_payload>'
\`\`\`

Use COMMENT event (never APPROVE/REQUEST_CHANGES). Use \\\`\\\`\\\`suggestion blocks for concrete fixes.

**Inline comment format:** One sentence stating the issue → evidence → fix. No filler. No hedging. No "consider" or "might want to."

### Step 7: Update State
After posting, update the state file:
\`\`\`bash
STATE_FILE="${stateFilePath}"
# Read current state, update reviewed_prs.${prNum}, write back
node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('${stateFilePath}', 'utf8'));
s.reviewed_prs = s.reviewed_prs || {};
s.reviewed_prs['${prNum}'] = {
  last_reviewed_sha: '${headSha}',
  reviewed_at: new Date().toISOString(),
  status: 'reviewed'
};
delete (s.pending_reviews || {})['${prNum}'];
fs.writeFileSync('${stateFilePath}', JSON.stringify(s, null, 2) + '\\n');
console.log('State updated for PR #${prNum}');
"
\`\`\`

Report: PR number, inline comments posted, overall assessment, CI status.`;
}

function buildCommentReplyTask(pr, comment, token) {
  return `You are the Isaac Lab Review Bot. An engineer has replied to one of your review comments on PR #${pr.number}.

## Authentication
export GH_TOKEN="${token}"

## Context
- PR: #${pr.number} "${pr.title.replace(/"/g, '\\"')}" by @${pr.user.login}
- Comment by: @${comment.user.login}
- Comment on file: ${comment.path || "N/A"} line ${comment.line || comment.original_line || "N/A"}
- Their message: ${JSON.stringify(comment.body)}
- Diff context: ${JSON.stringify(comment.diff_hunk || "")}
- Comment ID: ${comment.id}
- In-reply-to ID: ${comment.in_reply_to_id || "N/A"}

## Your Job
1. Read their comment carefully. They may be:
   - Asking for clarification on your review feedback
   - Disagreeing with your suggestion
   - Asking for a better alternative
   - Pointing out context you missed

2. If needed, fetch the relevant file to re-examine:
   \`\`\`bash
   gh api repos/${REPO}/contents/${comment.path}?ref=${pr.head.ref} -H "Accept: application/vnd.github.raw+json"
   \`\`\`

3. Respond thoughtfully:
   - If they make a good point, acknowledge it
   - If you still think there's an issue, explain WHY with more context
   - Be concrete — reference specific code
   - Be respectful and collaborative

4. Post your reply:
   \`\`\`bash
   curl -s -X POST \\
     -H "Authorization: Bearer ${token}" \\
     -H "Accept: application/vnd.github+json" \\
     https://api.github.com/repos/${REPO}/pulls/${pr.number}/comments/${comment.id}/replies \\
     -d '{"body": "<your reply>"}'
   \`\`\`

Keep replies concise and helpful. You're a collaborator, not an authority.`;
}

function buildGeneralReplyTask(issue, comment, token) {
  return `You are the Isaac Lab Review Bot. An engineer mentioned you in a general comment on PR #${issue.number}.

## Authentication
export GH_TOKEN="${token}"

## Context
- PR: #${issue.number} "${issue.title.replace(/"/g, '\\"')}"
- Comment by: @${comment.user.login}
- Their message: ${JSON.stringify(comment.body)}
- Comment ID: ${comment.id}

## Your Job
1. Understand what they're asking. They might want:
   - A re-review after pushing changes
   - Clarification on a finding
   - Help understanding something in the codebase

2. If they're asking for a re-review, run the full review process again (fetch new diff, check files, etc.)

3. If they're asking a question, fetch relevant code and answer concretely.

4. Post your reply:
   \`\`\`bash
   curl -s -X POST \\
     -H "Authorization: Bearer ${token}" \\
     -H "Accept: application/vnd.github+json" \\
     https://api.github.com/repos/${REPO}/issues/${issue.number}/comments \\
     -d '{"body": "<your reply>"}'
   \`\`\`

Be helpful, concise, and reference specific code.`;
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    // Verify signature
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(body, sig)) {
      console.error("[webhook] Invalid signature");
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    const event = req.headers["x-github-event"];
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    console.log(`[webhook] Event: ${event}, action: ${payload.action || "N/A"}`);

    // Respond immediately, process async
    res.writeHead(200);
    res.end("OK");

    try {
      switch (event) {
        case "pull_request":
          await handlePullRequest(payload);
          break;
        case "pull_request_review_comment":
          await handlePRReviewComment(payload);
          break;
        case "issue_comment":
          await handleIssueComment(payload);
          break;
        default:
          console.log(`[webhook] Unhandled event: ${event}`);
      }
    } catch (e) {
      console.error(`[webhook] Error handling ${event}:`, e.message);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] Isaac Lab PR Review webhook server listening on 127.0.0.1:${PORT}`);
  console.log(`[server] Smee URL: ${config.smeeUrl || "not configured"}`);
  console.log(`[server] Repo: ${REPO}`);
});
