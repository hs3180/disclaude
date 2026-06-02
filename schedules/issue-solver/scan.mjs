#!/usr/bin/env node
/* eslint-disable quotes -- this file uses double quotes for consistency with GitHub API strings */
/**
 * Issue Scanner for hs3180/disclaude
 *
 * Filters open issues: removes those with PRs, skip labels, or resolved in comments.
 * Includes GitHub App token auto-refresh before scanning.
 *
 * Usage:
 *   node scan.mjs           # List all candidates
 *   node scan.mjs --debug   # Verbose output to stderr
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = process.env.TARGET_REPO || "hs3180/disclaude";
const REPO_OWNER = REPO.split("/")[0];
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ENV_PATH = join(__dirname, ".runtime-env");

const SKIP_LABELS = new Set(["wontfix", "invalid", "duplicate", "wont-fix", "not-planned", "report", "documentation"]);

const SKIP_TITLE_KEYWORDS = ["[postponed]", "[deferred]"];

const SKIP_TITLE_PATTERNS = [/^📊/, /^📋/, /^📝/];

const SKIP_KEYWORDS = [
  "已完成", "不需要了", "已解决", "已修复", "可以关了",
  "duplicate of", "resolved in", "fixed in", "already fixed",
  "closing as", "already resolved",
];

const MAX_CANDIDATES = 3;

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

function output(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// GitHub App Token Management
// ---------------------------------------------------------------------------

/**
 * Parse .runtime-env file into a key-value map.
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
      const val = trimmed.slice(eq + 1).trim();
      env[trimmed.slice(0, eq).trim()] = val;
    }
  }
  return env;
}

/**
 * Write key-value pairs back to .runtime-env.
 */
function saveRuntimeEnv(env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(RUNTIME_ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

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
    log(`WARNING: No installation found for owner '${targetOwner}', falling back to first`);
  }
  return installations[0].id;
}

/**
 * Generate a new GitHub App Installation Access Token via JWT signing.
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

  // Resolve GitHub API IP (DNS may rotate between .166 and .168)
  let resolvedIp;
  try {
    const nsResult = execSync("nslookup api.github.com 2>/dev/null", { encoding: "utf-8", timeout: 10000 });
    const ipMatch = nsResult.match(/Address:\s*(\d+\.\d+\.\d+\.\d+)/g);
    if (ipMatch && ipMatch.length > 0) {
      // Take the last IP address (the actual resolved address, not the DNS server)
      resolvedIp = ipMatch[ipMatch.length - 1].replace("Address:\t", "").replace("Address: ", "");
    }
  } catch { /* ignore */ }
  if (!resolvedIp) resolvedIp = "20.205.243.168";
  const curlResolve = `--resolve api.github.com:443:${resolvedIp}`;

  // Get installation token via synchronous fetch (using execSync + curl for reliability)
  try {
    // Step A: Get installation ID if not provided
    let iid = INSTALL_ID;
    if (!iid) {
      const listResult = execSync(
        `curl -s -f ${curlResolve} -H "Authorization: Bearer ${jwt}" -H "Accept: application/vnd.github+json" https://api.github.com/app/installations`,
        { encoding: "utf-8", timeout: 30000 },
      );
      const installs = JSON.parse(listResult);
      if (!installs.length) {
        return { ok: false, error: "NO_INSTALLATIONS", message: "No installations found" };
      }
      log(`Available installations: ${installs.map((i) => `${i.account?.login}(${i.id})`).join(", ")}`);
      iid = selectInstallation(installs, REPO_OWNER);
      log(`Selected installation ID: ${iid}`);
    } else {
      log(`Using explicit GITHUB_APP_INSTALLATION_ID=${iid}`);
    }

    // Step B: Create installation access token
    const tokenResult = execSync(
      `curl -s -f -X POST ${curlResolve} -H "Authorization: Bearer ${jwt}" -H "Accept: application/vnd.github+json" https://api.github.com/app/installations/${iid}/access_tokens`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const data = JSON.parse(tokenResult);

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

// Cached token to avoid repeated file reads / refresh attempts
let cachedToken = null;

/**
 * Ensure a valid GH_TOKEN is available. Returns the token or exits with error.
 * Uses in-memory cache to avoid redundant checks within a single run.
 */
function ensureToken() {
  if (cachedToken) return cachedToken;

  const env = loadRuntimeEnv();

  if (isTokenValid(env)) {
    log("Using existing GH_TOKEN");
    cachedToken = env.GH_TOKEN;
    return cachedToken;
  }

  log("GH_TOKEN expired or missing, refreshing...");
  const result = refreshGitHubToken();
  if (!result.ok) {
    output({
      status: "auth_error",
      error: result.error,
      message: result.message,
    });
    process.exit(0);
  }
  cachedToken = result.token;
  return cachedToken;
}

// ---------------------------------------------------------------------------
// GitHub CLI helpers
// ---------------------------------------------------------------------------

/**
 * Run a gh CLI command. Returns parsed JSON or fallback on failure.
 */
function gh(...args) {
  const token = ensureToken();
  const cmd = `GH_TOKEN=${token} gh ${args.join(" ")}`;
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (err) {
    const stderr = err.stderr || "";
    // Detect auth errors specifically
    if (stderr.includes("401") || stderr.includes("Bad credentials")) {
      log(`Auth error from gh: ${stderr.trim()}`);
      return null;
    }
    log(`gh ${args.join(" ")} failed: ${(err.stderr || err.message).trim()}`);
    return null;
  }
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

function buildPrIssueSet(prs) {
  const nums = new Set();
  for (const pr of prs) {
    const combined = `${pr.body || ""} ${pr.headRefName || ""}`;
    for (const m of combined.matchAll(/#(\d+)/g)) {
      nums.add(Number(m[1]));
    }
  }
  return nums;
}

function checkCommentsResolved(issueNumber) {
  const out = gh("issue", "view", String(issueNumber), "--repo", REPO, "--comments");
  if (!out) return false;
  const tail = out.trim().split("\n").slice(-30).join("\n").toLowerCase();
  return SKIP_KEYWORDS.some((kw) => tail.includes(kw.toLowerCase()));
}

function fetchAllPRs() {
  const out = gh(
    "pr", "list", "--repo", REPO, "--state", "all",
    "--json", "number,title,state,body,headRefName", "--limit", "200",
  );
  if (!out) return [];
  return JSON.parse(out);
}

function findRelatedPRs(issueNumber, allPRs) {
  const issueStr = `#${issueNumber}`;
  return allPRs.filter((pr) => {
    const body = pr.body || "";
    const branch = pr.headRefName || "";
    const title = pr.title || "";
    return body.includes(issueStr) || title.includes(issueStr) || branch.includes(String(issueNumber));
  });
}

function fetchPRComments(prNumber) {
  const out = gh("pr", "view", String(prNumber), "--repo", REPO, "--comments");
  if (!out) return "";
  return out.trim().split("\n").slice(-80).join("\n");
}

function fetchIssueDetail(issueNumber) {
  const out = gh("issue", "view", String(issueNumber), "--repo", REPO, "--comments");
  if (!out) return `_(Failed to fetch issue #${issueNumber} details)_`;
  return out.trim();
}

// ---------------------------------------------------------------------------
// Close reason extraction
// ---------------------------------------------------------------------------

/**
 * Extract a one-line close reason from PR comments.
 * Returns the first substantive comment from the author who closed the PR.
 */
function extractCloseReason(comments) {
  if (!comments) return null;
  const lines = comments.split("\n");
  // Look for the first non-empty, non-header line after the comment metadata
  let reason = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip metadata-like lines (author:, association:, etc.)
    if (/^(author|association|edited|status|--)/.test(line)) continue;
    if (!line) continue;
    // Take the first substantive line as the reason
    reason = line.substring(0, 200);
    break;
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score an issue candidate for prioritization.
 * Higher score = more actionable.
 */
function scoreIssue(issue, relatedPRs) {
  let score = 0;
  const title = (issue.title || "").toLowerCase();
  const labels = (issue.labels || []).map((l) => (l.name || l || "").toLowerCase());

  // Bug labels → high priority
  if (labels.includes("bug")) score += 10;

  // Enhancement/feature → medium
  if (labels.includes("enhancement") || title.startsWith("feat")) score += 5;

  // Test-related → medium-low
  if (title.startsWith("test")) score += 3;

  // CI monitor bugs → lower (often API-side issues)
  if (labels.includes("ci-monitor")) score -= 5;

  // Automation label → medium (operational improvements)
  if (labels.includes("automation")) score += 4;

  // Many rejected PRs → penalty (heavy historical baggage)
  const rejectedCount = relatedPRs.filter((pr) => (pr.state || "").toUpperCase() === "CLOSED").length;
  score -= rejectedCount * 2;

  return score;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(`Scanning ${REPO} ...`);

  // Step 1: Fetch issues
  const issues = fetchOpenIssues();
  if (issues === null) {
    output({
      status: "auth_error",
      message: "GitHub API authentication failed. Token refresh also failed. Check GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH.",
    });
    process.exit(0);
  }

  log(`Found ${issues.length} open issues`);
  if (!issues.length) {
    output({ status: "no_issues", message: "No open issues found" });
    return;
  }

  // Step 2: Fetch open PRs
  const prs = fetchOpenPRs();
  if (prs === null) {
    output({
      status: "auth_error",
      message: "GitHub API authentication failed while fetching PRs.",
    });
    process.exit(0);
  }

  log(`Found ${prs.length} open PRs`);
  const prIssueNums = buildPrIssueSet(prs);
  log(`Issues with open PRs: ${[...prIssueNums].sort((a, b) => a - b)}`);

  // Step 3: Filter — remove issues with PRs, skip labels, skip title patterns
  const candidates = [];
  for (const issue of issues) {
    const num = issue.number;
    const title = issue.title;
    const titleLower = title.toLowerCase();
    const labels = (issue.labels || []).map((l) => (l.name || "").toLowerCase());

    if (prIssueNums.has(num)) {
      log(`Skipping #${num} (has open PR): ${title}`);
      continue;
    }

    if (labels.some((ln) => SKIP_LABELS.has(ln))) {
      log(`Skipping #${num} (skip label): ${title}`);
      continue;
    }

    if (SKIP_TITLE_KEYWORDS.some((kw) => titleLower.includes(kw))) {
      log(`Skipping #${num} (skip title keyword): ${title}`);
      continue;
    }

    if (SKIP_TITLE_PATTERNS.some((pat) => pat.test(title))) {
      log(`Skipping #${num} (skip title pattern): ${title}`);
      continue;
    }

    candidates.push({
      number: num,
      title,
      labels: (issue.labels || []).map((l) => l.name || ""),
    });
  }

  log(`${candidates.length} candidate(s) after PR/label filtering`);

  if (!candidates.length) {
    output({
      status: "no_candidates",
      message: "All open issues have PRs or are disqualified by labels",
    });
    return;
  }

  // Step 4: Check comments for resolution
  const final = candidates.filter((c) => {
    if (checkCommentsResolved(c.number)) {
      log(`Skipping #${c.number} (resolved in comments): ${c.title}`);
      return false;
    }
    return true;
  });

  log(`${final.length} candidate(s) after comment check`);

  if (!final.length) {
    output({
      status: "no_candidates",
      message: "All candidates appear resolved in comments",
    });
    return;
  }

  // Step 5: Fetch all PRs for cross-reference and scoring
  log("Fetching all PRs for cross-reference...");
  const allPRs = fetchAllPRs();
  log(`Found ${allPRs.length} total PRs`);

  // Score candidates and sort by score (descending)
  for (const c of final) {
    const related = findRelatedPRs(c.number, allPRs);
    c.score = scoreIssue(c, related);
    log(`Issue #${c.number} score: ${c.score} — ${c.title}`);

    // Fetch rejected PR comments (only for top candidates)
    const rejected = related.filter((pr) => (pr.state || "").toUpperCase() === "CLOSED");
    if (rejected.length) {
      // Only fetch comments for the 3 most recently closed PRs
      const topRejected = rejected.slice(-3);
      log(`Fetching comments for ${topRejected.length} rejected PR(s) on issue #${c.number}`);
      c.rejected_prs = topRejected.map((pr) => ({
        number: pr.number,
        title: pr.title,
        closeReason: extractCloseReason(fetchPRComments(pr.number)),
      }));
    }
  }

  final.sort((a, b) => b.score - a.score);

  // Limit to top N candidates
  const limited = final.slice(0, MAX_CANDIDATES);

  if (final.length > MAX_CANDIDATES) {
    log(`Limiting output from ${final.length} to ${MAX_CANDIDATES} candidates (score-based)`);
  }

  // Step 6: Output as Markdown with truncated details
  let md = `# Issue Scan Results\n\n`;
  md += `**Status:** candidates  |  **Count:** ${final.length} (showing top ${limited.length})  |  **Repo:** ${REPO}\n\n---\n\n`;

  for (const c of limited) {
    md += `## Issue #${c.number}: ${c.title}\n\n`;
    md += `**Score:** ${c.score}  |  `;
    if (c.labels.length) {
      md += `**Labels:** ${c.labels.join(", ")}\n\n`;
    }

    // Truncated issue body + limited comments
    md += `### Issue Details & Comments\n\n`;
    const detail = fetchIssueDetail(c.number);
    // Truncate to ~1500 chars to keep output manageable
    const truncated = detail.length > 1500
      ? detail.substring(0, 1500) + "\n... (truncated, use `gh issue view` for full details)"
      : detail;
    md += "```\n" + truncated + "\n```\n\n";

    // Rejected PRs (summary only)
    if (c.rejected_prs && c.rejected_prs.length) {
      md += `### Rejected PRs\n\n`;
      for (const pr of c.rejected_prs) {
        md += `**PR #${pr.number}: ${pr.title}** (CLOSED)\n\n`;
        if (pr.closeReason) {
          md += `> ${pr.closeReason}\n\n`;
        }
      }
    }

    md += `---\n\n`;
  }

  console.log(md);
}

main();
