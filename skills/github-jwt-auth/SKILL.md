---
name: github-jwt-auth
description: GitHub App JWT authentication specialist - generates Installation Access Token via JWT and writes it to runtime env. Use when user says keywords like "JWT 认证", "生成 token", "GitHub App token", "gh auth", "runtime env", "刷新 token", "JWT token".
allowed-tools: [Bash, Read, Write, Glob]
---

# GitHub App JWT Authentication Skill

You are a GitHub App JWT authentication specialist. Your job is to generate a GitHub App Installation Access Token using JWT signing, and write it to the runtime env file so other skills and tools can use it.

## Single Responsibility

- ✅ Generate GitHub App JWT and obtain Installation Access Token
- ✅ **Auto-match the correct installation ID based on the current project's git remote**
- ✅ Write the token to runtime env (`{workspace}/.runtime-env`) as `GH_TOKEN`
- ✅ Verify token validity
- ✅ Troubleshoot authentication issues
- ❌ DO NOT perform GitHub operations (use `github-app` skill for that)
- ❌ DO NOT store private keys or tokens in the repository

## Prerequisites

Before running this skill, the following environment variables must be set (in `disclaude.config.yaml` under `env:` or system environment):

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_APP_ID` | GitHub App ID | ✅ Yes |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to private key PEM file | ✅ Yes |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID (deprecated, auto-matched now) | ❌ Optional fallback |

## Installation ID Resolution Strategy

**CRITICAL**: A GitHub App can be installed to multiple accounts (orgs/users). Each installation has a different ID and grants access to different repositories. The skill must select the correct installation for the current project.

Resolution order:
1. **Git remote matching** (primary): Parse `git remote get-url origin` to extract the repo owner (e.g., `Mathlab-Crypto` from `git@github.com:Mathlab-Crypto/Quantex.git`). Then list all installations and match `installation.account.login` (case-insensitive) to the owner.
2. **Env var fallback**: If git remote is unavailable or no match is found, fall back to `GITHUB_APP_INSTALLATION_ID` from environment.
3. **Error**: If neither yields a valid installation, stop and report the available installations to the user.

## Runtime Env File

The token is written to `{workspace}/.runtime-env` in KEY=VALUE format:

```
GH_TOKEN=ghs_xxxxxxxxxxxx
GH_TOKEN_EXPIRES_AT=2026-03-20T12:00:00Z
GH_INSTALLATION_ID=98765432
GH_REPO=Mathlab-Crypto/Quantex
```

- `GH_TOKEN` — the Installation Access Token
- `GH_TOKEN_EXPIRES_AT` — ISO 8601 expiry time (1 hour lifetime)
- `GH_INSTALLATION_ID` — which installation was matched (for debugging)
- `GH_REPO` — the repo that was matched (for debugging)

## Workflow

### Step 1: Generate Token (One-Shot Script)

**Always use this as the primary method.** Write the script to a temp file and execute it — this avoids shell escaping issues with `node -e` (especially the `!` character in bash/zsh).

```bash
TMP_SCRIPT="/tmp/gh-jwt-auth.$$.js"
cat > "$TMP_SCRIPT" << 'SCRIPT'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_ID = process.env.GITHUB_APP_ID;
const KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const ENV_INSTALL_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const RUNTIME_ENV = path.join(process.cwd(), ".runtime-env");

// --- Validation ---
if (!APP_ID || !KEY_PATH) {
  console.error("MISSING: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH must be set");
  process.exit(1);
}
if (!fs.existsSync(KEY_PATH)) {
  console.error("MISSING: Private key file not found: " + KEY_PATH);
  process.exit(1);
}

// --- Detect repo from git remote ---
let repoOwner = null;
let repoFullName = null;
try {
  const remoteUrl = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
  // SSH: git@github.com:Owner/Repo.git
  // HTTPS: https://github.com/Owner/Repo.git
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (match) {
    repoOwner = match[1];
    repoFullName = match[1] + "/" + match[2];
  }
} catch {}

if (repoOwner) {
  console.error("Detected repo: " + repoFullName + " (owner: " + repoOwner + ")");
} else {
  console.error("WARNING: Could not detect git remote. Falling back to env var installation ID.");
}

// --- Generate JWT ---
const privateKey = fs.readFileSync(KEY_PATH, "utf-8");
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID })).toString("base64url");
const sigInput = header + "." + payload;
const sign = crypto.createSign("RSA-SHA256");
sign.update(sigInput);
const jwt = sigInput + "." + sign.sign(privateKey, "base64url");

// --- Main ---
(async () => {
  // Step A: List all installations
  const listResp = await fetch("https://api.github.com/app/installations", {
    headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json" }
  });
  if (!listResp.ok) {
    console.error("ERROR: Cannot list installations: " + listResp.status);
    process.exit(1);
  }
  const installations = await listResp.json();

  if (!installations.length) {
    console.error("ERROR: No installations found. Is the GitHub App installed to any account?");
    process.exit(1);
  }

  // Step B: Match installation
  let matched = null;
  if (repoOwner) {
    matched = installations.find(
      (i) => i.account && i.account.login && i.account.login.toLowerCase() === repoOwner.toLowerCase()
    );
  }

  let installId;
  if (matched) {
    installId = matched.id;
    console.error("Matched installation by repo owner: id=" + installId + " account=" + matched.account.login);
  } else if (ENV_INSTALL_ID) {
    installId = ENV_INSTALL_ID;
    console.error("WARNING: No installation matched repo owner '" + repoOwner + "'. Using env var installation ID: " + installId);
    console.error("Available installations:");
    installations.forEach((i) => console.error("  id=" + i.id + " account=" + (i.account && i.account.login)));
  } else {
    console.error("ERROR: Cannot determine installation ID.");
    console.error("Repo owner '" + repoOwner + "' does not match any installation.");
    console.error("Available installations:");
    installations.forEach((i) => console.error("  id=" + i.id + " account=" + (i.account && i.account.login)));
    process.exit(1);
  }

  // Step C: Create installation access token
  const tokenResp = await fetch("https://api.github.com/app/installations/" + installId + "/access_tokens", {
    method: "POST",
    headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json" }
  });
  if (!tokenResp.ok) {
    console.error("ERROR: Cannot create token: " + tokenResp.status);
    const body = await tokenResp.text();
    console.error(body);
    process.exit(1);
  }
  const tokenData = await tokenResp.json();

  // Step D: Write to runtime env
  let content = "";
  try { content = fs.readFileSync(RUNTIME_ENV, "utf-8"); } catch {}
  const keepLines = content.split("\n").filter((l) => {
    return !l.startsWith("GH_TOKEN=")
      && !l.startsWith("GH_TOKEN_EXPIRES_AT=")
      && !l.startsWith("GH_INSTALLATION_ID=")
      && !l.startsWith("GH_REPO=");
  });
  keepLines.push("GH_TOKEN=" + tokenData.token);
  keepLines.push("GH_TOKEN_EXPIRES_AT=" + tokenData.expires_at);
  keepLines.push("GH_INSTALLATION_ID=" + installId);
  if (repoFullName) keepLines.push("GH_REPO=" + repoFullName);
  fs.writeFileSync(RUNTIME_ENV, keepLines.filter(Boolean).join("\n") + "\n");

  console.log("OK");
  console.log("  Expires: " + tokenData.expires_at);
  console.log("  Installation ID: " + installId);
  console.log("  Repo: " + (repoFullName || "unknown"));
})();
SCRIPT

node "$TMP_SCRIPT"
rm -f "$TMP_SCRIPT"
```

### Step 2: Verify Token (Optional)

```bash
# Source the runtime env and verify.
# NOTE: an installation access token is NOT a user token — GET /user returns 403
# ("Resource not accessible by integration"). Verify against the repositories the
# installation can actually access instead.
export $(grep '^GH_TOKEN=' .runtime-env | head -1)
curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/installation/repositories \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('OK — installation can see', d.get('total_count','?'), 'repo(s)')"
```

## Token Refresh

GitHub App Installation Tokens expire after **1 hour**. When other skills fail with authentication errors:

1. Check if token is expired by reading `GH_TOKEN_EXPIRES_AT` from `.runtime-env`
2. If expired or missing, re-run the one-shot script above
3. The new token will overwrite the old one

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `MISSING: GITHUB_APP_ID` | Env var not set | Set `GITHUB_APP_ID` in config |
| `Private key file not found` | Key path wrong or missing | Check `GITHUB_APP_PRIVATE_KEY_PATH` |
| `Cannot list installations` | Invalid JWT or network error | Verify APP_ID and key |
| `No installations found` | App not installed to any account | Install the GitHub App first |
| `Cannot determine installation ID` | Repo owner doesn't match any installation | Install the GitHub App to the org/user that owns the current repo |
| `Cannot create token: 404` | Wrong installation ID | The installation may have been removed. Re-check. |
| `Cannot create token: 403` | Insufficient permissions | Check GitHub App permission settings |

## Security Notes

- Private keys are read from file system, never stored or logged
- Tokens are written to `.runtime-env` which should be in `.gitignore`
- Token scope is limited to the GitHub App's configured permissions
- Tokens automatically expire after 1 hour
