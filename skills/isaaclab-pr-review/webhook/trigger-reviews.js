#!/usr/bin/env node
// Trigger reviews for unreviewed PRs by writing pending task files and waking the agent
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PENDING_DIR = path.join(__dirname, '..', 'pending-tasks');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// PRs to review (passed as args or hardcoded)
const prNumbers = process.argv.slice(2).map(Number).filter(Boolean);
if (!prNumbers.length) {
  console.error('Usage: node trigger-reviews.js <pr1> <pr2> ...');
  process.exit(1);
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign({ iat: now - 60, exp: now + 600, iss: config.appId }, config.privateKey, { algorithm: 'RS256' });
  const res = await fetch(`https://api.github.com/app/installations/${config.installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  });
  const data = await res.json();
  return data.token;
}

async function getPR(token, num) {
  const res = await fetch(`https://api.github.com/repos/isaac-sim/IsaacLab/pulls/${num}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) { console.error(`Failed to fetch PR #${num}: ${res.status}`); return null; }
  return res.json();
}

(async () => {
  const token = await getToken();
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });

  for (const num of prNumbers) {
    const pr = await getPR(token, num);
    if (!pr || pr.state !== 'open') {
      console.log(`PR #${num}: skipped (${pr ? pr.state : 'not found'})`);
      continue;
    }

    const taskFile = path.join(PENDING_DIR, `isaaclab-pr-review-${num}-${Date.now()}.json`);
    const task = {
      task: `REVIEW_PR_PLACEHOLDER`,
      label: `isaaclab-pr-review-${num}`,
      created: new Date().toISOString(),
      prNumber: num,
      token: token,
      title: pr.title,
      author: pr.user.login,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      changedFiles: pr.changed_files,
      url: pr.html_url,
    };
    fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
    console.log(`PR #${num}: task written (${pr.title.slice(0, 60)})`);

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\nDone. ${prNumbers.length} PRs queued. Tasks in ${PENDING_DIR}`);
})();
