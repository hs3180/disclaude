---
name: github-jwt-auth
description: GitHub App JWT authentication specialist - generates Installation Access Token via JWT and writes it to runtime env. Use when user says keywords like "JWT 认证", "生成 token", "GitHub App token", "gh auth", "runtime env", "刷新 token", "JWT token".
allowed-tools: [Bash, Read, Write, Glob]
---

# GitHub App JWT Authentication Skill

You are a GitHub App JWT authentication specialist. Your job is to generate a GitHub App Installation Access Token using JWT signing, and write it to the runtime env file so other skills and tools can use it.

## Single Responsibility

- ✅ Generate GitHub App JWT and obtain Installation Access Token
- ✅ Write the token to runtime env (`{workspace}/.runtime-env`) as `GH_TOKEN`
- ✅ Verify token validity
- ✅ Troubleshoot authentication issues
- ❌ DO NOT perform GitHub operations (use `github-app` skill for that)
- ❌ DO NOT store private keys or tokens in the repository

## Prerequisites

Before running this skill, the following environment variables must be set (in `disclaude.config.yaml` under `env:` or system environment):

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_APP_ID` | GitHub App ID | `123456` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to private key PEM file | `/home/user/.ssh/github-app-key.pem` |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID (optional, auto-detected) | `98765432` |

## Runtime Env File

The token is written to `{workspace}/.runtime-env` in KEY=VALUE format:

```
GH_TOKEN=ghs_xxxxxxxxxxxx
GH_TOKEN_EXPIRES_AT=2026-03-20T12:00:00Z
```

- `GH_TOKEN` — the Installation Access Token
- `GH_TOKEN_EXPIRES_AT` — ISO 8601 expiry time (1 hour lifetime)

Other skills and MCP servers can read this file to use the token.

## Workflow

### Step 1: Validate Prerequisites

```bash
# Check required environment variables
echo "APP_ID: $GITHUB_APP_ID"
echo "KEY_PATH: $GITHUB_APP_PRIVATE_KEY_PATH"
echo "INSTALLATION_ID: ${GITHUB_APP_INSTALLATION_ID:-auto-detect}"

# Verify private key file exists and is readable
test -f "$GITHUB_APP_PRIVATE_KEY_PATH" && echo "✅ Private key file exists" || echo "❌ Private key file not found"
```

If any prerequisite is missing, **stop and inform the user** what they need to configure.

### Step 2: Generate JWT and Get Installation Token

Use the following Node.js script to generate JWT and obtain the Installation Access Token. This avoids requiring `jsonwebtoken` as a project dependency:

```bash
node -e '
const crypto = require("crypto");
const fs = require("fs");

const APP_ID = process.env.GITHUB_APP_ID;
const KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const INSTALL_ID = process.env.GITHUB_APP_INSTALLATION_ID;

if (!APP_ID || !KEY_PATH) {
  console.error("ERROR: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH must be set");
  process.exit(1);
}

// Read private key
const privateKey = fs.readFileSync(KEY_PATH, "utf-8");

// Generate JWT (RS256, 10 minute expiry)
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  iat: now - 60,
  exp: now + 600,
  iss: APP_ID
})).toString("base64url");
const signatureInput = header + "." + payload;
const sign = crypto.createSign("RSA-SHA256");
sign.update(signatureInput);
const signature = sign.sign(privateKey, "base64url");
const jwt = signatureInput + "." + signature;

// Get Installation Access Token
async function getToken(jwt, installId) {
  // Step A: Get installation ID if not provided
  let iid = installId;
  if (!iid) {
    const resp = await fetch("https://api.github.com/app/installations", {
      headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json" }
    });
    if (!resp.ok) { throw new Error("Failed to list installations: " + resp.status + " " + await resp.text()); }
    const installs = await resp.json();
    if (!installs.length) { throw new Error("No installations found. Is the GitHub App installed to any repository?"); }
    iid = installs[0].id;
    console.error("Auto-detected installation ID: " + iid);
  }

  // Step B: Create installation access token
  const resp = await fetch("https://api.github.com/app/installations/" + iid + "/access_tokens", {
    method: "POST",
    headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json" }
  });
  if (!resp.ok) { throw new Error("Failed to create token: " + resp.status + " " + await resp.text()); }
  const data = await resp.json();
  return data;
}

getToken(jwt, INSTALL_ID).then(data => {
  console.log(JSON.stringify(data, null, 2));
}).catch(err => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
'
```

### Step 3: Write Token to Runtime Env

After successfully obtaining the token, write it to the runtime env file:

```bash
# Parse the token from the previous step output and write to .runtime-env
# The workspace directory is the current working directory

# Extract token and expiry from JSON output
# TOKEN and EXPIRES should be set from the previous command output

# Write to runtime env file (append or update)
RUNTIME_ENV_FILE=".runtime-env"

# Remove old entries if they exist
if [ -f "$RUNTIME_ENV_FILE" ]; then
  sed -i "/^GH_TOKEN=/d; /^GH_TOKEN_EXPIRES_AT=/d" "$RUNTIME_ENV_FILE"
fi

# Append new entries
echo "GH_TOKEN=${TOKEN}" >> "$RUNTIME_ENV_FILE"
echo "GH_TOKEN_EXPIRES_AT=${EXPIRES}" >> "$RUNTIME_ENV_FILE"

echo "✅ Token written to $RUNTIME_ENV_FILE"
```

### Step 4: Verify Token

```bash
# Verify the token works
gh auth status --with-token <<< "$TOKEN" 2>/dev/null && echo "✅ Token valid" || echo "❌ Token invalid"

# Or verify via API
curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/app | head -c 200
```

## Complete One-Shot Script

For convenience, you can combine all steps into a single command. **Always run this as the primary method** — it handles everything in one go:

```bash
node -e '
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const APP_ID = process.env.GITHUB_APP_ID;
const KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const INSTALL_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const RUNTIME_ENV = path.join(process.cwd(), ".runtime-env");

if (!APP_ID || !KEY_PATH) {
  console.error("MISSING: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH must be set");
  process.exit(1);
}
if (!fs.existsSync(KEY_PATH)) {
  console.error("MISSING: Private key file not found: " + KEY_PATH);
  process.exit(1);
}

const privateKey = fs.readFileSync(KEY_PATH, "utf-8");
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID })).toString("base64url");
const sigInput = header + "." + payload;
const sign = crypto.createSign("RSA-SHA256");
sign.update(sigInput);
const sig = sign.sign(privateKey, "base64url");
const jwt = sigInput + "." + sig;

(async () => {
  let iid = INSTALL_ID;
  if (!iid) {
    const r = await fetch("https://api.github.com/app/installations", {
      headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json" }
    });
    if (!r.ok) { console.error("ERROR: Cannot list installations: " + r.status); process.exit(1); }
    const inst = await r.json();
    if (!inst.length) { console.error("ERROR: No installations found"); process.exit(1); }
    iid = inst[0].id;
  }

  const r = await fetch("https://api.github.com/app/installations/" + iid + "/access_tokens", {
    method: "POST",
    headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json" }
  });
  if (!r.ok) { console.error("ERROR: Cannot create token: " + r.status); process.exit(1); }
  const data = await r.json();

  // Write to runtime env
  let content = "";
  try { content = fs.readFileSync(RUNTIME_ENV, "utf-8"); } catch {}
  const lines = content.split("\n").filter(l => !l.startsWith("GH_TOKEN=") && !l.startsWith("GH_TOKEN_EXPIRES_AT="));
  lines.push("GH_TOKEN=" + data.token);
  lines.push("GH_TOKEN_EXPIRES_AT=" + data.expires_at);
  fs.writeFileSync(RUNTIME_ENV, lines.filter(Boolean).join("\n") + "\n");

  console.log("✅ Installation Access Token generated");
  console.log("   Token: " + data.token.substring(0, 12) + "...");
  console.log("   Expires: " + data.expires_at);
  console.log("   Runtime env: " + RUNTIME_ENV);
  console.log("   Installation ID: " + iid);
})();
'
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
| `No installations found` | App not installed to any repo | Install the GitHub App first |
| `Cannot create token: 404` | Wrong installation ID | Check or remove `GITHUB_APP_INSTALLATION_ID` to auto-detect |
| `Cannot create token: 403` | Insufficient permissions | Check GitHub App permission settings |

## Security Notes

- Private keys are read from file system, never stored or logged
- Tokens are written to `.runtime-env` which should be in `.gitignore`
- Token scope is limited to the GitHub App's configured permissions
- Tokens automatically expire after 1 hour
