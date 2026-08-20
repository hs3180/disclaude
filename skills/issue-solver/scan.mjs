#!/usr/bin/env node
/**
 * Issue Scanner — configurable target repository via TARGET_REPO env var
 *
 * Lists open issues that don't have an associated open PR, or whose work already
 * landed in a merged PR (phantom-pool filter — GitHub-authoritative will-close
 * links resolved per open issue, #4375).
 * Outputs Markdown with full issue details + comments for each candidate.
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

const REPO = process.env.TARGET_REPO || "hs3180/disclaude";
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
  console.error(`Invalid TARGET_REPO: "${REPO}". Expected owner/repo format.`);
  process.exit(1);
}
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

/**
 * Call a GitHub App-auth endpoint (`/app/installations...`) with a raw App JWT
 * as a Bearer token. The `gh` CLI does not authenticate an App JWT passed via
 * GH_TOKEN (HTTP 401), so these endpoints bypass `gh` entirely.
 * Returns { ok: true, data } with the parsed JSON, or { ok: false, message }
 * with the failure detail. The detail is always printed to stderr too — a dead
 * mint is the primary diagnostic for a failed tick, so it must not hide behind
 * --debug (the pre-#4513 code passed gh's stderr through the same way).
 */
async function appApi(jwt, method, apiPath) {
  try {
    const resp = await fetch(`https://api.github.com/${apiPath.replace(/^\//, "")}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const detail = `HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`;
      console.error(`appApi ${method} ${apiPath} failed: ${detail}`);
      return { ok: false, message: detail };
    }
    return { ok: true, data: await resp.json() };
  } catch (err) {
    console.error(`appApi ${method} ${apiPath} failed: ${err.message}`);
    return { ok: false, message: err.message };
  }
}

async function refreshGitHubToken() {
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
    // NOTE: App-auth endpoints (/app/installations*) require the App JWT as a
    // raw `Authorization: Bearer` credential. The `gh` CLI cannot authenticate
    // an App JWT passed through GH_TOKEN (GitHub returns 401 "Bad credentials"
    // / "A JSON web token could not be decoded"), so these calls use fetch
    // directly — same pattern as skills/github-jwt-auth/SKILL.md. GraphQL and
    // other REST calls below still go through `gh` with the installation
    // token, which `gh` handles fine.
    let iid = INSTALL_ID;
    if (!iid) {
      const installs = await appApi(jwt, "GET", "app/installations");
      if (!installs.ok) {
        return { ok: false, error: "INSTALLATIONS_FETCH_FAILED", message: `appApi GET app/installations: ${installs.message}` };
      }
      if (!Array.isArray(installs.data) || !installs.data.length) {
        return { ok: false, error: "NO_INSTALLATIONS", message: `No installations found (${Array.isArray(installs.data) ? installs.data.length : "non-array response"})` };
      }
      iid = selectInstallation(installs.data, REPO_OWNER);
    }

    const minted = await appApi(jwt, "POST", `app/installations/${iid}/access_tokens`);
    if (!minted.ok || !minted.data.token) {
      const detail = minted.ok ? `missing token field (${minted.data.message || JSON.stringify(minted.data).slice(0, 200)})` : minted.message;
      return { ok: false, error: "TOKEN_FETCH_FAILED", message: `appApi POST app/installations/${iid}/access_tokens: ${detail}` };
    }
    const data = minted.data;

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

async function ensureToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 3 * 60 * 1000) return cachedToken;
  cachedToken = null;
  const env = loadRuntimeEnv();
  if (isTokenValid(env)) {
    cachedToken = env.GH_TOKEN;
    cachedTokenExpiry = new Date(env.GH_TOKEN_EXPIRES_AT).getTime();
    return cachedToken;
  }
  log("Refreshing GH_TOKEN...");
  const result = await refreshGitHubToken();
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

async function gh(...args) {
  const token = await ensureToken();
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
        timelineItems(itemTypes: CROSS_REFERENCED_EVENT, first: 100) {
          totalCount
          nodes {
            ... on CrossReferencedEvent {
              willCloseTarget
              source {
                ... on PullRequest { number state title }
              }
            }
          }
        }
      }
    }
    openPRs: pullRequests(first: 100, states: [OPEN]) {
      totalCount
      pageInfo { hasNextPage }
      nodes { number title body headRefName }
    }
  }
}`;

async function ghGraphQL(query, owner, name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureToken();
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

async function main() {
  log(`Scanning ${REPO} via GraphQL ...`);

  const data = await ghGraphQL(GRAPHQL_QUERY, REPO_OWNER, REPO.split("/")[1]);
  if (!data || !data.data || !data.data.repository) {
    console.log("# Auth Error\n\nGitHub GraphQL API failed.\n");
    process.exit(1);
  }

  const repo = data.data.repository;
  const allIssues = repo.issues.nodes || [];
  const openPRs = repo.openPRs.nodes || [];

  if (repo.issues.pageInfo?.hasNextPage || repo.openPRs.pageInfo?.hasNextPage) {
    log(`WARNING: Results truncated. Issues total: ${repo.issues.totalCount}, open PRs: ${repo.openPRs.totalCount}. Only first 100 of each fetched.`);
  }

  log(`Found ${allIssues.length} open issues, ${openPRs.length} open PRs`);

  // Open PRs reference work-in-progress issues (any keyword match) — exclude them.
  // Merged PRs that closed an issue signal already-shipped work — the
  // phantom-pool filter (#4375: resolved per open issue via GitHub's
  // authoritative link table, not by scanning a capped window of merged PRs).
  const OPEN_KEYWORD = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related)\s+#(\d+)/gi;
  const BRANCH_NUM = /(\d+)/g;

  const openPRIssueNums = new Set();
  for (const pr of openPRs) {
    // Any keyword-prefixed reference in body/title — work in progress, don't duplicate.
    for (const m of `${pr.body || ""} ${pr.title || ""}`.matchAll(OPEN_KEYWORD)) {
      openPRIssueNums.add(Number(m[1]));
    }
    // Loose number matching in branch name (e.g. fix/issue-123)
    for (const m of (pr.headRefName || "").matchAll(BRANCH_NUM)) {
      openPRIssueNums.add(Number(m[1]));
    }
  }

  // Phantom-pool filter via per-issue closing links (#4375). Each open issue's
  // CROSS_REFERENCED_EVENT entries carry `willCloseTarget` — GitHub's own
  // link semantics for "this reference closes the issue when merged" (formal
  // closing keywords + dev-panel links; a "part N" title or bare "#N" mention
  // does NOT set it, so open epics referenced as parents stay in the pool —
  // the #4376 regression guard, #4168/#4040/#4039). An issue whose
  // will-close ref comes from a MERGED PR is already-shipped work: exclude it.
  //
  // This replaces the previous mergedPRs(first: 100) title/body regex scan,
  // which only ever saw the 100 most-recently-updated merged PRs of a
  // 1000+-merged repo — an issue whose covering merge fell outside that
  // window leaked as a false candidate, and the cutoff marches forward with
  // every new merge. Asking GitHub per open issue bounds the work to the
  // (small) open-issue set instead of the ever-growing merged-PR set, with
  // zero window truncation.
  const mergedPRIssueNums = new Set();
  for (const issue of allIssues) {
    const events = issue.timelineItems?.nodes || [];
    // Guard: if an issue has more cross-referenced events than the window
    // fetched, a will-close link could sit outside it (false negative →
    // phantom leaks into candidates). Surface it instead of missing silently.
    const tc = issue.timelineItems?.totalCount;
    if (tc !== undefined && tc > events.length) {
      log(`WARNING: #${issue.number} has ${tc} cross-ref events, only ${events.length} fetched — willCloseTarget link may be outside the window`);
    }
    const closedByMergedPR = events.some(
      (e) => e.willCloseTarget && e.source?.state === "MERGED",
    );
    if (closedByMergedPR) mergedPRIssueNums.add(issue.number);
  }

  // Weak-ref phantom detection (#4373, direction #4 — caveat only, NOT auto-excluded).
  //
  // The will-close filter above honours GitHub-authoritative closing links
  // (formal closing keywords + dev-panel links), and GitHub auto-closes on
  // those too — so on the OPEN pool that filter is essentially
  // false-negative-only (see comment below). The leak that actually bites is
  // the *weak* ref: a merged PR that shipped the work for #N via a bare "#N"
  // mention or a title/body phrase, with no closing link. GitHub did not
  // auto-close #N and the filter did not exclude it, so #N re-enters the
  // candidate pool as a phantom (e.g. "#4410 fix ... (#4402)" leaves #4402
  // looking open).
  //
  // Direction #4 (lowest-risk, no precision/recall tradeoff): do NOT auto-exclude
  // — a weak ref can be mere context ("part of #N", "unlike #N"; see #4376).
  // Instead surface each candidate's weak refs as a verification caveat so the
  // work is checked against main before a solver re-implements it. Auto-exclusion
  // (semantic-overlap, #4373 direction #3) is deferred to a design sign-off.
  //
  // Signal source: the same per-issue CROSS_REFERENCED_EVENT table the #4375
  // filter uses. Every merged PR that referenced #N — closing link or mere
  // mention — created a cross-ref event on #N, so `willCloseTarget === false`
  // + `source.state === "MERGED"` is exactly "a merged PR referenced this
  // issue without a closing link". This keeps the detection on the
  // #4375 per-issue base (no merged-PR window, no truncation blind spot)
  // instead of resurrecting the mergedPRs(first: 100) scan that #4375 removed;
  // a bare "#N" in a PR title/body is itself what creates the cross-ref.
  const weakRefsByIssue = new Map(); // issueNum -> [{ pr, title }]
  for (const issue of allIssues) {
    for (const e of issue.timelineItems?.nodes || []) {
      if (e.willCloseTarget || e.source?.state !== "MERGED") continue;
      if (!weakRefsByIssue.has(issue.number)) weakRefsByIssue.set(issue.number, []);
      weakRefsByIssue.get(issue.number).push({ pr: e.source.number, title: (e.source.title || "").trim() });
    }
  }

  // An issue is excluded if it has an in-progress (open) PR or its work already
  // shipped in a merged PR (phantom).
  const excludedIssueNums = new Set(openPRIssueNums);
  for (const n of mergedPRIssueNums) {
    excludedIssueNums.add(n);
  }

  // GitHub auto-closes an issue when a merged PR carries a closing link for it,
  // so a will-close merge nearly always points at an already-CLOSED issue
  // (absent from the open pool above). The only OPEN issues this filter can
  // exclude are ones REOPENED after such a merge — which are real candidates —
  // so on the open pool the filter is false-negative-only. mergedPRIssueNums is
  // built from the open pool directly, so every entry bites the candidate set.
  let phantomFilteredOpenCount = 0;
  for (const n of mergedPRIssueNums) {
    if (!openPRIssueNums.has(n)) phantomFilteredOpenCount++;
  }

  const openPRCount = openPRs.length;
  log(`Issues with open PRs: ${[...openPRIssueNums].sort((a, b) => a - b).join(", ") || "none"}`);
  log(`Merged closing-link issues: ${[...mergedPRIssueNums].sort((a, b) => a - b).join(", ") || "none"} — ${phantomFilteredOpenCount} excluded from the open pool (resolved per-issue via willCloseTarget; #4375)`);
  log(`PRs scanned: ${openPRCount} open (phantom filter resolved per open issue, no merged-PR window)`);

  // Filter: remove issues with open PRs or already-shipped merged-PR work
  const candidates = allIssues.filter((i) => !excludedIssueNums.has(i.number));
  log(`${candidates.length} candidate(s) after filtering`);

  if (!candidates.length) {
    console.log("# No Candidates\n\nAll open issues have PRs.\n");
    return;
  }

  // Build Markdown output with full issue details
  let md = `# Issue Scan Results\n\n`;
  md += `**Candidates:** ${candidates.length} | **Open PRs:** ${openPRCount} | **Repo:** ${REPO}\n\n---\n\n`;

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

  // Weak-ref verification caveat (#4373 direction #4). Advisory only — it never
  // auto-excludes, so the candidate pool shape above is unchanged. Appended after
  // the candidate bodies to prompt a solver/reviewer to verify flagged issues
  // against main before implementing.
  const flagged = candidates
    .map((i) => ({ issue: i, refs: (weakRefsByIssue.get(i.number) || []).slice(0, 3) }))
    .filter((x) => x.refs.length);
  if (flagged.length) {
    md += `## ⚠️ Weak-ref phantoms — verify before implementing (advisory, NOT auto-excluded)\n\n`;
    md += `These candidates are referenced by an already-**merged** PR via a weak link — a mention without a \`fixes/closes/resolves\` closing link (bare \`#N\` in title/body, dev-panel-free). GitHub did not auto-close them and the phantom filter did not exclude them, so the work **may already be shipped**. Check each against \`main\` (code grep + merged-PR list) before implementing.\n\n`;
    for (const { issue, refs } of flagged) {
      md += `- **#${issue.number}** ${issue.title}\n`;
      for (const r of refs) md += `  - ← merged #${r.pr}${r.title ? ` _"${r.title}"_` : ""}\n`;
    }
    md += `\n_Auto-excluding on weak refs is intentionally deferred: a bare \`#N\` can be mere context ("part of #N"), so aggressive matching would drop legitimately-open epics (#4376). This advisory caveat is direction #4 of #4373; semantic-overlap auto-exclusion (direction #3) is a future design call._\n\n---\n\n`;
  }

  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
