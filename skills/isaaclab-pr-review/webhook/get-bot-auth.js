#!/usr/bin/env node
// Generate a fresh bot token and authentication block for manual PR reviews
// Usage: node get-bot-auth.js [repo]
// Default repo: isaac-sim/IsaacLab

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const CONFIG_PATH = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign(
    { iat: now - 60, exp: now + 600, iss: config.appId },
    config.privateKey,
    { algorithm: "RS256" }
  );

  const res = await fetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  const data = await res.json();
  if (!data.token) {
    console.error("Failed to get token:", data);
    process.exit(1);
  }
  return data.token;
}

async function main() {
  const token = await getToken();
  const repo = process.argv[2] || "isaac-sim/IsaacLab";
  
  // Output just the token for easy capture
  if (process.argv.includes("--token-only")) {
    console.log(token);
    return;
  }

  // Output the full auth block
  console.log(`## 🛑 MANDATORY: Bot Authentication

\`\`\`bash
export GH_TOKEN="${token}"

# Verify identity — MUST be bot
IDENTITY=$(curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/user | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('login','UNKNOWN'))" 2>/dev/null)
echo "Authenticated as: $IDENTITY"
if [[ "$IDENTITY" != *"[bot]"* ]]; then
  echo "FATAL: Not authenticated as bot! Got: $IDENTITY"
  echo "ABORTING — refusing to post reviews as personal account."
  exit 1
fi
\`\`\`

Target repo: ${repo}
`);
}

main().catch(console.error);
