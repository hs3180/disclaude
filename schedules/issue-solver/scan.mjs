#!/usr/bin/env node
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

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = "hs3180/disclaude";
const REPO_OWNER = REPO.split("/")[0]; // "hs3180"
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Use project root .runtime-env (consistent with packages/core/src/config/runtime-env.ts)
const PROJECT_ROOT = join(__dirname, "..", "..");
const RUNTIME_ENV_PATH = join(PROJECT_ROOT, ".runtime-env");

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

// ---------------------------------------------------------------------------
// Runtime Env File I/O (aligned with packages/core/src/config/runtime-env.ts)
// ---------------------------------------------------------------------------

/**
 * Parse .runtime-env file into a key-value map.
 * Format: KEY=VALUE per line, # comments and blank lines ignored.
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
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
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
    log(`WARNING: No installation found for owner '${targetOwner}', falling back to first`);
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
      iid = selectInstallation(installs, REPO_OWNER);
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
// GitHub CLI helpers
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
  // Check all comment lines (not just last 30) for resolution keywords
  const full = out.trim().toLowerCase();
  return SKIP_KEYWORDS.some((kw) => full.includes(kw.toLowerCase()));
}

function fetchAllPRs() {
  const out = gh(
    "pr", "list", "--repo", REPO, "--state", "all",
    "--json", "number,title,state,body,headRefName", "--limit", "200",
  );
  if (!out) return null; // null = auth/network failure (consistent with other fetchers)
  try { return JSON.parse(out); } catch { return []; }
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

  // Very old issues → slight penalty (likely stale or blocked)
  score -= 1;

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
    console.log("# Auth Error\n\nGitHub API authentication failed. Token refresh also failed.\nCheck GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH.\n");
    process.exit(1);
  }

  log(`Found ${issues.length} open issues`);
  if (!issues.length) {
    console.log("# No Issues\n\nNo open issues found.\n");
    return;
  }

  // Step 2: Fetch open PRs
  const prs = fetchOpenPRs();
  if (prs === null) {
    console.log("# Auth Error\n\nGitHub API authentication failed while fetching PRs.\n");
    process.exit(1);
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
    console.log("# No Candidates\n\nAll open issues have PRs or are disqualified by labels.\n");
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
    console.log("# No Candidates\n\nAll candidates appear resolved in comments.\n");
    return;
  }

  // Step 5: Fetch all PRs for cross-reference and scoring
  log("Fetching all PRs for cross-reference...");
  const allPRs = fetchAllPRs();
  if (allPRs === null) {
    console.log("# Auth Error\n\nGitHub API authentication failed while fetching all PRs.\n");
    process.exit(1);
  }
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

  // Step 6: Output as Markdown
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
