#!/usr/bin/env node
/**
 * Issue Scanner for hs3180/disclaude
 *
 * Minimal filter: removes issues with open PRs, outputs remaining list.
 *
 * Usage:
 *   node scan.mjs           # List candidates
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
const REPO_OWNER = REPO.split("/")[0];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
const RUNTIME_ENV_PATH = join(PROJECT_ROOT, ".runtime-env");

const DEBUG = process.argv.includes("--debug");

function log(msg) {
  if (DEBUG) {
    console.error(`[${new Date().toISOString()}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime Env File I/O
// ---------------------------------------------------------------------------

function unquoteValue(val) {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
    if (val.includes('\\"')) val = val.replace(/\\"/g, '"');
    if (val.includes("\\'")) val = val.replace(/\\'/g, "'");
  }
  return val;
}

function quoteValue(val) {
  if (val.includes(" ") || val.includes('"')) {
    return `"${val.replace(/"/g, '\\"')}"`;
  }
  return val;
}

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

function saveRuntimeEnv(env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${quoteValue(v)}`);
  writeFileSync(RUNTIME_ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// GitHub App Token Management
// ---------------------------------------------------------------------------

function isTokenValid(env) {
  const expiresAt = env.GH_TOKEN_EXPIRES_AT;
  if (!expiresAt || !env.GH_TOKEN) return false;
  return Date.now() < new Date(expiresAt).getTime() - 5 * 60 * 1000;
}

function selectInstallation(installations, targetOwner) {
  if (targetOwner) {
    const match = installations.find(
      (inst) => inst.account && inst.account.login.toLowerCase() === targetOwner.toLowerCase(),
    );
    if (match) return match.id;
  }
  return installations[0].id;
}

function refreshGitHubToken() {
  const APP_ID = process.env.GITHUB_APP_ID;
  const KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const INSTALL_ID = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!APP_ID || !KEY_PATH) {
    return { ok: false, error: "MISSING_CONFIG", message: "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH must be set" };
  }
  if (!existsSync(KEY_PATH)) {
    return { ok: false, error: "MISSING_KEY", message: `Private key file not found: ${KEY_PATH}` };
  }

  const privateKey = readFileSync(KEY_PATH, "utf-8");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(sigInput);
  const jwt = `${sigInput}.${sign.sign(privateKey, "base64url")}`;

  try {
    let iid = INSTALL_ID;
    if (!iid) {
      const listResult = spawnSync("gh", ["api", "app/installations", "-H", "Accept: application/vnd.github+json"], {
        env: { ...process.env, GH_TOKEN: jwt }, encoding: "utf-8", timeout: 30000,
      });
      if (listResult.status !== 0 || !listResult.stdout) {
        return { ok: false, error: "INSTALLATIONS_FETCH_FAILED", message: `gh api failed: ${listResult.stderr || "unknown"}` };
      }
      const installs = JSON.parse(listResult.stdout);
      if (!installs.length) return { ok: false, error: "NO_INSTALLATIONS", message: "No installations found" };
      iid = selectInstallation(installs, REPO_OWNER);
    }

    const tokenResult = spawnSync("gh", [
      "api", "-X", "POST", `app/installations/${iid}/access_tokens`, "-H", "Accept: application/vnd.github+json",
    ], { env: { ...process.env, GH_TOKEN: jwt }, encoding: "utf-8", timeout: 30000 });
    if (tokenResult.status !== 0 || !tokenResult.stdout) {
      return { ok: false, error: "TOKEN_FETCH_FAILED", message: `gh api failed: ${tokenResult.stderr || "unknown"}` };
    }
    const data = JSON.parse(tokenResult.stdout);

    const env = loadRuntimeEnv();
    env.GH_TOKEN = data.token;
    env.GH_TOKEN_EXPIRES_AT = data.expires_at;
    env.GITHUB_APP_INSTALLATION_ID = String(iid);
    saveRuntimeEnv(env);

    log(`Token refreshed, expires ${data.expires_at}`);
    return { ok: true, token: data.token, expiresAt: data.expires_at };
  } catch (err) {
    return { ok: false, error: "TOKEN_REFRESH_FAILED", message: err.message };
  }
}

let cachedToken = null;
let cachedTokenExpiry = 0;

function ensureToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 3 * 60 * 1000) return cachedToken;
  cachedToken = null;
  const env = loadRuntimeEnv();
  if (isTokenValid(env)) {
    cachedToken = env.GH_TOKEN;
    cachedTokenExpiry = new Date(env.GH_TOKEN_EXPIRES_AT).getTime();
    return cachedToken;
  }
  log("Refreshing GH_TOKEN...");
  const result = refreshGitHubToken();
  if (!result.ok) {
    console.log(`# Auth Error\n\n${result.error}: ${result.message}\n`);
    process.exit(1);
  }
  cachedToken = result.token;
  cachedTokenExpiry = new Date(result.expiresAt).getTime();
  return cachedToken;
}

// ---------------------------------------------------------------------------
// GitHub CLI helper
// ---------------------------------------------------------------------------

function gh(...args) {
  const token = ensureToken();
  const result = spawnSync("gh", args, {
    env: { ...process.env, GH_TOKEN: token }, encoding: "utf-8", timeout: 30000,
  });
  if (result.status !== 0) {
    log(`gh ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
    return null;
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------
// GraphQL query — fetch issues + PRs in one call
// ---------------------------------------------------------------------------

const GRAPHQL_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        number
        title
        body
        labels(first: 20) { nodes { name } }
        comments(first: 30) {
          nodes { body author { login } }
        }
      }
    }
    pullRequests(first: 100, states: [OPEN]) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        number
        title
        body
        headRefName
      }
    }
  }
}`;

function ghGraphQL(query, owner, name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = ensureToken();
    const result = spawnSync("gh", [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
    ], {
      env: { ...process.env, GH_TOKEN: token }, encoding: "utf-8", timeout: 30000,
    });
    if (result.status !== 0) {
      const stderr = result.stderr || "";
      if (attempt === 0 && (stderr.includes("401") || stderr.includes("Bad credentials"))) {
        log(`Auth error from gh graphql, retrying with fresh token...`);
        cachedToken = null;
        continue;
      }
      log(`gh api graphql failed: ${stderr.trim()}`);
      return null;
    }
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(`Scanning ${REPO} via GraphQL ...`);

  const data = ghGraphQL(GRAPHQL_QUERY, REPO_OWNER, REPO.split("/")[1]);
  if (!data || !data.data || !data.data.repository) {
    console.log("# Auth Error\n\nGitHub GraphQL API failed.\n");
    process.exit(1);
  }

  const repo = data.data.repository;
  const allIssues = repo.issues.nodes || [];
  const allPRs = repo.pullRequests.nodes || [];

  if (repo.issues.pageInfo?.hasNextPage || repo.pullRequests.pageInfo?.hasNextPage) {
    log(`WARNING: Results truncated. Issues total: ${repo.issues.totalCount}, PRs total: ${repo.pullRequests.totalCount}. Only first 100 of each fetched.`);
  }

  log(`Found ${allIssues.length} open issues, ${allPRs.length} open PRs`);

  // Build set of issue numbers referenced by open PRs
  const prIssueNums = new Set();
  const ISSUE_KEYWORD = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const BRANCH_NUM = /(\d+)/g;
  for (const pr of allPRs) {
    // Keyword-prefixed references in body and title (strict)
    for (const m of `${pr.body || ""} ${pr.title || ""}`.matchAll(ISSUE_KEYWORD)) {
      prIssueNums.add(Number(m[1]));
    }
    // Loose number matching in branch name (e.g. fix/issue-123)
    for (const m of (pr.headRefName || "").matchAll(BRANCH_NUM)) {
      prIssueNums.add(Number(m[1]));
    }
  }
  log(`Issues with open PRs: ${[...prIssueNums].sort((a, b) => a - b).join(", ") || "none"}`);

  // Filter: remove issues with open PRs
  const candidates = allIssues.filter((i) => !prIssueNums.has(i.number));
  log(`${candidates.length} candidate(s) after filtering`);

  if (!candidates.length) {
    console.log("# No Candidates\n\nAll open issues have PRs.\n");
    return;
  }

  // Build Markdown output with full issue details
  let md = `# Issue Scan Results\n\n`;
  md += `**Candidates:** ${candidates.length} | **Open PRs:** ${allPRs.length} | **Repo:** ${REPO}\n\n---\n\n`;

  for (const issue of candidates) {
    const labels = (issue.labels?.nodes || []).map((l) => l.name);
    md += `## #${issue.number} ${issue.title}\n\n`;
    if (labels.length) md += `**Labels:** ${labels.join(", ")}\n\n`;

    // Issue body
    const body = (issue.body || "").trim();
    if (body) {
      md += `${body}\n\n`;
    }

    // Comments
    const comments = issue.comments?.nodes || [];
    if (comments.length) {
      md += `### Comments (${comments.length})\n\n`;
      for (const c of comments) {
        const cBody = (c.body || "").trim();
        if (cBody) {
          md += `**@${c.author?.login || "unknown"}:**\n> ${cBody.replace(/\n/g, "\n> ")}\n\n`;
        }
      }
    }

    md += `---\n\n`;
  }

  console.log(md);
}

main();
