#!/usr/bin/env node
/**
 * Issue Scanner — configurable target repository via TARGET_REPO env var
 *
 * Lists open issues that don't have an associated open PR.
 * Outputs Markdown with full issue details + comments for each candidate.
 * Downstream agent decides priority and actionability.
 *
 * Usage:
 *   node scan.mjs           # List all candidates
 *   node scan.mjs --debug   # Verbose output to stderr
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = process.env.TARGET_REPO || "hs3180/disclaude";
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
  console.error(`Invalid TARGET_REPO: "${REPO}". Expected owner/repo format.`);
  process.exit(1);
}
const REPO_OWNER = REPO.split("/")[0];
// Use workspace .runtime-env (agent runs with cwd=workspace, consistent with
// packages/core/src/config/runtime-env.ts which reads from {workspace}/.runtime-env)
const RUNTIME_ENV_PATH = join(process.cwd(), ".runtime-env");

const DEBUG = process.argv.includes("--debug");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  if (DEBUG) {
    const ts = new Date().toISOString();
    console.error(`[${ts}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime Env File I/O
// ---------------------------------------------------------------------------

/**
 * Strip surrounding quotes and unescape internal escaped quotes from an env value.
 * Handles both single and double quoted values.
 */
function unquoteValue(val) {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
    // Unescape internal escaped quotes matching the outer quote type
    if (val.includes('\\"')) val = val.replace(/\\"/g, '"');
    if (val.includes("\\'")) val = val.replace(/\\'/g, "'");
  }
  return val;
}

/**
 * Quote an env value if it contains spaces or double-quotes, escaping as needed.
 */
function quoteValue(val) {
  if (val.includes(" ") || val.includes('"')) {
    return `"${val.replace(/"/g, '\\"')}"`;
  }
  return val;
}

/**
 * Parse .runtime-env file into a key-value map.
 * Format: KEY=VALUE per line, # comments and blank lines ignored.
 * Values may be quoted with single or double quotes; escaped quotes are unescaped.
 */
function loadRuntimeEnv() {
  if (!existsSync(RUNTIME_ENV_PATH)) return {};
  const content = readFileSync(RUNTIME_ENV_PATH, "utf-8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      env[trimmed.slice(0, eq).trim()] = unquoteValue(trimmed.slice(eq + 1).trim());
    }
  }
  return env;
}

/**
 * Write key-value pairs back to .runtime-env.
 */
function saveRuntimeEnv(env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${quoteValue(v)}`);
  writeFileSync(RUNTIME_ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// GitHub App Token Management
// ---------------------------------------------------------------------------

/**
 * Check if the stored GH_TOKEN is still valid (with 5-minute safety margin).
 */
function isTokenValid(env) {
  const expiresAt = env.GH_TOKEN_EXPIRES_AT;
  if (!expiresAt || !env.GH_TOKEN) return false;
  const expiry = new Date(expiresAt).getTime();
  const now = Date.now();
  const margin = 5 * 60 * 1000; // 5 minutes
  return now < expiry - margin;
}

/**
 * Select the correct installation ID based on target repo owner.
 *
 * Priority:
 *  1. Explicit GITHUB_APP_INSTALLATION_ID env var (always wins)
 *  2. Match installation account.login against REPO_OWNER
 *  3. Fall back to first installation
 */
function selectInstallation(installations, targetOwner) {
  if (targetOwner) {
    const match = installations.find(
      (inst) => inst.account && inst.account.login.toLowerCase() === targetOwner.toLowerCase(),
    );
    if (match) {
      log(`Matched installation by owner: ${targetOwner} -> ID ${match.id}`);
      return match.id;
    }
    return {
      error: `No installation found for owner '${targetOwner}'. Available: ${installations.map((i) => i.account?.login).join(", ")}. Set GITHUB_APP_INSTALLATION_ID explicitly or ensure the app is installed on the target repository.`,
    };
  }
  return installations[0].id;
}

/**
 * Generate a new GitHub App Installation Access Token via JWT signing.
 * Uses gh api instead of curl to avoid external dependency and DNS resolution hacks.
 * Writes the new token (and detected installation ID) to .runtime-env.
 */
function refreshGitHubToken() {
  const APP_ID = process.env.GITHUB_APP_ID;
  const KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const INSTALL_ID = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!APP_ID || !KEY_PATH) {
    return {
      ok: false,
      error: "MISSING_CONFIG",
      message: "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH must be set",
    };
  }
  if (!existsSync(KEY_PATH)) {
    return {
      ok: false,
      error: "MISSING_KEY",
      message: `Private key file not found: ${KEY_PATH}`,
    };
  }

  const privateKey = readFileSync(KEY_PATH, "utf-8");

  // Generate JWT (RS256, 10 minute expiry)
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 600,
    iss: APP_ID,
  })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(sigInput);
  const signature = sign.sign(privateKey, "base64url");
  const jwt = `${sigInput}.${signature}`;

  try {
    // Step A: Get installation ID if not provided
    let iid = INSTALL_ID;
    if (!iid) {
      const listResult = spawnSync("gh", [
        "api", "app/installations",
        "-H", "Accept: application/vnd.github+json",
      ], {
        env: { ...process.env, GH_TOKEN: jwt },
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (listResult.status !== 0 || !listResult.stdout) {
        return { ok: false, error: "INSTALLATIONS_FETCH_FAILED", message: `gh api failed: ${listResult.stderr || "unknown error"}` };
      }
      const installs = JSON.parse(listResult.stdout);
      if (!installs.length) {
        return { ok: false, error: "NO_INSTALLATIONS", message: "No installations found" };
      }
      log(`Available installations: ${installs.map((i) => `${i.account?.login}(${i.id})`).join(", ")}`);
      const selected = selectInstallation(installs, REPO_OWNER);
      if (selected.error) {
        return { ok: false, error: "INSTALLATION_NOT_FOUND", message: selected.error };
      }
      iid = selected;
      log(`Selected installation ID: ${iid}`);
    } else {
      log(`Using explicit GITHUB_APP_INSTALLATION_ID=${iid}`);
    }

    // Step B: Create installation access token
    const tokenResult = spawnSync("gh", [
      "api",
      "-X", "POST",
      `app/installations/${iid}/access_tokens`,
      "-H", "Accept: application/vnd.github+json",
    ], {
      env: { ...process.env, GH_TOKEN: jwt },
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (tokenResult.status !== 0 || !tokenResult.stdout) {
      return { ok: false, error: "TOKEN_FETCH_FAILED", message: `gh api failed: ${tokenResult.stderr || "unknown error"}` };
    }
    const data = JSON.parse(tokenResult.stdout);

    // Write to runtime env (including installation ID for future reference)
    const env = loadRuntimeEnv();
    env.GH_TOKEN = data.token;
    env.GH_TOKEN_EXPIRES_AT = data.expires_at;
    env.GITHUB_APP_INSTALLATION_ID = String(iid);
    saveRuntimeEnv(env);

    log(`Token refreshed: ${data.token.substring(0, 12)}... expires ${data.expires_at} (install ID: ${iid})`);
    return { ok: true, token: data.token, expiresAt: data.expires_at };
  } catch (err) {
    return {
      ok: false,
      error: "TOKEN_REFRESH_FAILED",
      message: `Failed to refresh GitHub token: ${err.message}`,
    };
  }
}

// Token cache with invalidation support
let cachedToken = null;
let cachedTokenExpiry = 0;

/**
 * Ensure a valid GH_TOKEN is available. Returns the token or exits with error.
 * Uses in-memory cache with expiry awareness to avoid redundant checks.
 */
function ensureToken() {
  // Check cache validity (token must not be within 3-minute margin of expiry)
  if (cachedToken && Date.now() < cachedTokenExpiry - 3 * 60 * 1000) {
    return cachedToken;
  }
  cachedToken = null;

  const env = loadRuntimeEnv();

  if (isTokenValid(env)) {
    log("Using existing GH_TOKEN");
    cachedToken = env.GH_TOKEN;
    cachedTokenExpiry = new Date(env.GH_TOKEN_EXPIRES_AT).getTime();
    return cachedToken;
  }

  log("GH_TOKEN expired or missing, refreshing...");
  const result = refreshGitHubToken();
  if (!result.ok) {
    console.log(`# Auth Error\n\n**Error:** ${result.error}\n**Message:** ${result.message}\n`);
    process.exit(1);
  }
  cachedToken = result.token;
  cachedTokenExpiry = new Date(result.expiresAt).getTime();
  return cachedToken;
}

// ---------------------------------------------------------------------------
// GitHub CLI helper
// ---------------------------------------------------------------------------

/**
 * Run a gh CLI command. Returns stdout string or null on failure.
 * Uses spawnSync to avoid shell injection from token or arguments.
 */
function gh(...args) {
  const token = ensureToken();
  const result = spawnSync("gh", args, {
    env: { ...process.env, GH_TOKEN: token },
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr || "";
    // Detect auth errors specifically — invalidate cache and retry once
    if (stderr.includes("401") || stderr.includes("Bad credentials")) {
      log(`Auth error from gh: ${stderr.trim()}`);
      // Invalidate cache so next call triggers a refresh
      cachedToken = null;
      return null;
    }
    log(`gh ${args.join(" ")} failed: ${(stderr || "unknown error").trim()}`);
    return null;
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

function fetchOpenIssues() {
  const out = gh(
    "issue", "list", "--repo", REPO, "--state", "open",
    "--json", "number,title,labels", "--limit", "200",
  );
  if (!out) return null; // null = auth/network failure
  try { return JSON.parse(out); } catch { return []; }
}

function fetchOpenPRs() {
  const out = gh(
    "pr", "list", "--repo", REPO, "--state", "open",
    "--json", "number,title,body,headRefName", "--limit", "200",
  );
  if (!out) return null;
  try { return JSON.parse(out); } catch { return []; }
}

/**
 * Build a set of issue numbers that have open PRs referencing them.
 * Only matches explicit close/fix/resolve keywords + bare #N in branch names.
 */
function buildPrIssueSet(prs) {
  const nums = new Set();
  const ISSUE_LINK_PATTERN = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related:?|ref:?|addresses)\s+#(\d+)/gi;
  const BRANCH_ISSUE_PATTERN = /(\d+)/g;

  for (const pr of prs) {
    // Match keyword-prefixed issue references in body
    const body = pr.body || "";
    for (const m of body.matchAll(ISSUE_LINK_PATTERN)) {
      nums.add(Number(m[1]));
    }
    // Match issue numbers in branch name (e.g. fix/issue-123)
    const branch = pr.headRefName || "";
    for (const m of branch.matchAll(BRANCH_ISSUE_PATTERN)) {
      nums.add(Number(m[1]));
    }
  }
  return nums;
}

function fetchIssueDetail(issueNumber) {
  const out = gh("issue", "view", String(issueNumber), "--repo", REPO, "--comments");
  if (!out) return `_(Failed to fetch issue #${issueNumber} details)_`;
  return out.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(`Scanning ${REPO} ...`);

  // Step 1: Fetch issues
  const issues = fetchOpenIssues();
  if (issues === null) {
    console.log("# Auth Error\n\nGitHub API authentication failed. Token refresh also failed.\nCheck GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH.\n");
    process.exit(1);
  }

  log(`Found ${issues.length} open issues`);
  if (!issues.length) {
    console.log("# No Issues\n\nNo open issues found.\n");
    return;
  }

  // Step 2: Fetch open PRs and build issue→PR mapping
  const prs = fetchOpenPRs();
  if (prs === null) {
    console.log("# Auth Error\n\nGitHub API authentication failed while fetching PRs.\n");
    process.exit(1);
  }

  log(`Found ${prs.length} open PRs`);
  const prIssueNums = buildPrIssueSet(prs);
  log(`Issues with open PRs: ${[...prIssueNums].sort((a, b) => a - b)}`);

  // Step 3: Filter out issues with open PRs
  const candidates = [];
  for (const issue of issues) {
    if (prIssueNums.has(issue.number)) {
      log(`Skipping #${issue.number} (has open PR): ${issue.title}`);
      continue;
    }
    candidates.push({
      number: issue.number,
      title: issue.title,
      labels: (issue.labels || []).map((l) => l.name || ""),
    });
  }

  log(`${candidates.length} candidate(s) after PR filtering`);

  if (!candidates.length) {
    console.log("# No Candidates\n\nAll open issues have associated open PRs.\n");
    return;
  }

  // Step 4: Output as Markdown with full issue details
  let md = `# Issue Scan Results\n\n`;
  md += `**Status:** candidates  |  **Count:** ${candidates.length}  |  **Repo:** ${REPO}\n\n---\n\n`;

  for (const c of candidates) {
    md += `## Issue #${c.number}: ${c.title}\n\n`;
    if (c.labels.length) {
      md += `**Labels:** ${c.labels.join(", ")}\n\n`;
    }

    md += `### Issue Details & Comments\n\n`;
    const detail = fetchIssueDetail(c.number);
    // Truncate to ~2000 chars to keep output manageable
    const truncated = detail.length > 2000
      ? detail.substring(0, 2000) + "\n... (truncated, use `gh issue view` for full details)"
      : detail;
    md += "```\n" + truncated + "\n```\n\n";

    md += `---\n\n`;
  }

  console.log(md);
}

main();
