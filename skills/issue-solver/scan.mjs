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
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
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

// #4373 part 4: execute the part-3 batch-verification checklist against the
// current repo's git log (with gh pr view fallback) instead of only printing
// it. Off by default — the plain scan output is byte-identical unless asked.
const VERIFY_SHIPPED = process.argv.includes("--verify-shipped");

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
// Phantom-filter reference extraction (pure — regression-tested in scan.test.ts)
// ---------------------------------------------------------------------------

/**
 * Reference keywords that mark an OPEN PR as work-in-progress on an issue.
 * "related" is included here: an open PR saying "Related #N" still covers #N.
 */
const OPEN_KEYWORD = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related)\s+#(\d+)/gi;

const BRANCH_NUM = /(\d+)/g;

/**
 * Issue numbers covered by OPEN PRs (work in progress): any keyword-prefixed
 * reference in body/title, plus loose number matching in the branch name
 * (e.g. fix/issue-123). Pure — no I/O.
 *
 * @param {Array<{title?: string | null, body?: string | null, headRefName?: string | null}>} openPRs
 * @returns {Set<number>}
 */
export function extractOpenPRRefs(openPRs) {
  const nums = new Set();
  for (const pr of openPRs) {
    for (const m of `${pr.body || ""} ${pr.title || ""}`.matchAll(OPEN_KEYWORD)) {
      nums.add(Number(m[1]));
    }
    for (const m of (pr.headRefName || "").matchAll(BRANCH_NUM)) {
      nums.add(Number(m[1]));
    }
  }
  return nums;
}

/**
 * Whether a merged PR's title mentions the issue number itself — the
 * high-confidence half of the weak-ref signal (#4373 part 2, direction #4
 * refinement — still advisory, NOT auto-exclusion).
 *
 * This repo's covering-PR convention puts the target issue number in the
 * title ("fix #4402: ...", "feat #4388 (part 1): ...", "... by isTopicThread
 * (#4402)"), while a context-only mention of an open epic puts a DIFFERENT
 * number there ("feat #4279 (part 1): ..." on epic #4168 — the sub-issue).
 * Splitting the advisory caveat on this line keeps the "likely shipped"
 * short-list short: epics referenced only as context (#4376 guard,
 * #4168/#4040/#4039) land in the context-only tier instead of diluting it.
 *
 * A `willCloseTarget === false` cross-ref exists precisely because some `#N`
 * mention in the PR title/body created it, so a title hit means the PR is
 * *about* #N in the author's own words. Pure — no I/O.
 *
 * @param {string} title merged PR title
 * @param {number} issueNum candidate issue number
 * @returns {boolean}
 */
export function titleMentionsIssue(title, issueNum) {
  return new RegExp(`(^|[^0-9])#${issueNum}([^0-9]|$)`).test(title || "");
}

/**
 * Split the tier-1 ("likely shipped") weak-ref list into ready-to-verify work
 * items, one per issue (#4373 part 3).
 *
 * Part 2 tiers weak refs by title-mention but renders them as flat Markdown
 * lines — a solver tick then re-derives the verification step by hand each
 * round (exactly what this repo's issue-solver ticks have been doing). Part 3
 * shapes the same advisory data as a per-issue record so the caveat section
 * can be consumed programmatically: each entry carries the issue and its
 * title-hit merged refs as PR numbers sorted descending (newest merge first —
 * the natural order to grep a clone for the anchor). Pure — no I/O.
 *
 * @param {Array<{number: number, title?: string | null}>} candidates the scan's candidate issues
 * @param {Map<number, {titleHit: Array<{pr: number, title?: string}>, contextOnly: Array<unknown>}>} weakRefsByIssue
 * @returns {Array<{number: number, title: string, mergedPRs: number[]}>}
 */
export function buildVerificationQueue(candidates, weakRefsByIssue) {
  const queue = [];
  for (const issue of candidates) {
    const refs = weakRefsByIssue.get(issue.number);
    if (!refs || !refs.titleHit.length) continue;
    queue.push({
      number: issue.number,
      title: (issue.title || "").trim(),
      mergedPRs: refs.titleHit.map((r) => r.pr).sort((a, b) => b - a),
    });
  }
  // Newest likely-shipped issue first — cheap, stable tie-break on number.
  return queue.sort((a, b) => b.number - a.number);
}

/**
 * Render the part-3 batch-verification block (#4373 part 3).
 *
 * One `git log --grep` line per tier-1 issue against a clone of `main`: if
 * every listed merge is present, the anchor landed and the issue is a
 * close-hygiene candidate, not a development opportunity. Pure — no I/O.
 *
 * Two grep traps the rendered header pins for the runner (both hit during
 * this PR's own live verification): a `--depth 1` clone has no history to
 * grep (fetch full history first), and a squash merge may retitle the commit
 * away from the PR number (#4407's squash subject reads "(#4396, #4208
 * P1-b)" — no `#4407` anywhere) — fall back to `gh pr view --json
 * mergeCommit` for those, not the grep.
 *
 * @param {Array<{number: number, title: string, mergedPRs: number[]}>} queue output of buildVerificationQueue
 * @returns {string} Markdown block (empty string for an empty queue)
 */
export function renderVerificationBlock(queue) {
  if (!queue.length) return "";
  const lines = [
    `#### Batch verification (#4373 part 3)`,
    ``,
    `Run these in a full (unshallowed) clone of \`main\` — every listed merge present means the issue's work already shipped (close-hygiene, not a dev opportunity). A grep MISS is not proof of absence: a \`--depth 1\` clone has no history, and a squash merge may retitle the commit away from the PR number (then: \`gh pr view N --repo ${REPO} --json mergeCommit\`).`,
    ``,
  ];
  for (const item of queue) {
    const greps = item.mergedPRs
      .slice(0, 3)
      .map((n) => `git log --oneline --grep="#${n}[^0-9]" | head -1`)
      .join(" && ");
    lines.push(`- **#${item.number}** (merged: ${item.mergedPRs.join(", ")}): ${greps}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Execute the part-3 checklist instead of printing it (#4373 part 4).
 *
 * Part 3 renders `git log --grep` lines for a human (or a solver tick) to
 * copy-paste into a clone of `main`. This repo's own ticks did exactly that
 * by hand every round — memory logs ~15 of the last ~35 minutes per tick
 * spent re-deriving the same clone+grep+interpret loop. Part 4 automates the
 * loop behind `--verify-shipped`, so the tick spends its budget on the one or
 * two issues the automation flags as genuinely unverified.
 *
 * Every listed merge present in the repo's `git log` ⇒ the tier-1 anchor
 * landed ⇒ the issue is a close-hygiene candidate (likely shipped), not a
 * development opportunity. A grep MISS falls back to `gh pr view --json
 * mergeCommit` (the squash-retitle trap pinned in the part-3 header: PR
 * #4407's squash subject reads "(#4396, #4208 P1-b)" — no `#4407` anywhere,
 * so grep misses on a genuinely merged PR) and only counts as MISS if that
 * PR's merge commit is ALSO absent from the log.
 *
 * Per-PR outcomes: `present` (grep or mergeCommit hit), `absent` (both miss),
 * `error` (the git/gh invocation itself failed — never interpreted as
 * absence). An issue is `confirmed-shipped` only when ALL its PRs are
 * `present` and none are `error`; any `absent` or `error` keeps it
 * `unverified` so a tooling failure can never print a false all-clear.
 *
 * DiFX injection-safe by construction: PR numbers come from GitHub's
 * cross-ref table as integers (`buildVerificationQueue` maps `r.pr` straight
 * through), and the log regex is derived from `${n}` under a `^[\d]+$`
 * guard — neither surface accepts caller text.
 *
 * @param {Array<{number: number, title: string, mergedPRs: number[]}>} queue output of buildVerificationQueue
 * @param {object} deps injectables for tests: `git` (repo dir; default `process.cwd()`)
 *   and `prMergeCommits` (async (pr: number) => string|null; default shells out
 *   to `gh pr view`, null on any failure — the caller's auth problem, not ours)
 * @returns {Promise<{summary: string, details: Array<{issue: number, verdict: "confirmed-shipped"|"unverified", results: Array<{pr: number, outcome: "present"|"absent"|"error", via: "grep"|"mergeCommit", detail: string}>}>}>}
 */
export async function verifyShippedAnchors(queue, deps = {}) {
  const git = typeof deps.git === "function" ? deps.git : null;
  const repoDir = deps.repoDir || process.cwd();
  const prMergeCommits =
    deps.prMergeCommits ||
    (async (pr) => {
      // GH token plumbing lives in ensureToken(); gh reads GH_TOKEN from env.
      const token = await ensureToken();
      const r = spawnSync("gh", ["pr", "view", String(pr), "--repo", REPO, "--json", "mergeCommit"], {
        env: { ...process.env, GH_TOKEN: token }, encoding: "utf-8", timeout: 30000,
      });
      if (r.status !== 0) return null;
      try {
        const sha = JSON.parse(r.stdout)?.mergeCommit?.oid;
        return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
      } catch {
        return null;
      }
    });

  const details = [];
  for (const item of queue) {
    if (!/^\d+$/.test(String(item.number)) || !Array.isArray(item.mergedPRs)) {
      details.push({ issue: item.number, verdict: "unverified", results: [] });
      continue;
    }
    const results = [];
    for (const pr of item.mergedPRs) {
      if (!/^\d+$/.test(String(pr))) {
        results.push({ pr, outcome: "error", via: "grep", detail: "non-numeric PR number" });
        continue;
      }
      // Primary: grep the log for the PR number (the part-3 command, verbatim
      // semantics — `#N` not followed by another digit).
      const grep = git
        ? git(["log", "--oneline", `--grep=#${pr}[^0-9]`], repoDir)
        : spawnSync("git", ["log", "--oneline", `--grep=#${pr}[^0-9]`], {
            cwd: repoDir, encoding: "utf-8", timeout: 30000,
          });
      if (grep.error || grep.status !== 0) {
        results.push({ pr, outcome: "error", via: "grep", detail: (grep.stderr || grep.error?.message || "").trim() });
        continue;
      }
      if ((grep.stdout || "").trim()) {
        results.push({ pr, outcome: "present", via: "grep", detail: grep.stdout.trim().split("\n")[0] });
        continue;
      }
      // Grep missed — fall back to the merge commit before believing absence.
      const sha = await prMergeCommits(pr);
      if (sha === null) {
        results.push({ pr, outcome: "error", via: "mergeCommit", detail: "gh pr view unavailable" });
        continue;
      }
      const cat = git
        ? git(["cat-file", "-e", `${sha}^{commit}`], repoDir)
        : spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
            cwd: repoDir, encoding: "utf-8", timeout: 30000,
          });
      if (cat.error || cat.status !== 0) {
        results.push({ pr, outcome: "absent", via: "mergeCommit", detail: `merge commit ${sha.slice(0, 9)} not in log` });
      } else {
        results.push({ pr, outcome: "present", via: "mergeCommit", detail: `squash-retitled merge ${sha.slice(0, 9)}` });
      }
    }
    const confirmed = results.length > 0 && results.every((r) => r.outcome === "present");
    details.push({ issue: item.number, verdict: confirmed ? "confirmed-shipped" : "unverified", results });
  }

  const shipped = details.filter((d) => d.verdict === "confirmed-shipped").map((d) => `#${d.issue}`);
  const summary = !details.length
    ? "no tier-1 weak-ref candidates to verify"
    : shipped.length === details.length
      ? `all ${details.length} tier-1 candidates confirmed shipped (close-hygiene): ${shipped.join(" ")}`
      : `${shipped.length}/${details.length} tier-1 candidates confirmed shipped (close-hygiene): ${shipped.join(" ") || "none"} — rest unverified (absent merge or tooling error; check details)`;
  return { summary, details };
}

/**
 * Issue numbers whose work already shipped, resolved per open issue via
 * GitHub's authoritative closing-link table (#4375). Each open issue's
 * CROSS_REFERENCED_EVENT entries carry `willCloseTarget` — GitHub's own link
 * semantics for "this reference closes the issue when merged" (formal closing
 * keywords + dev-panel links). A "part N" title or bare "#N" mention does NOT
 * set it, so open epics referenced by merged part-series PRs purely as
 * context/parent stay in the candidate pool (the #4376 regression guard,
 * #4168/#4040/#4039). An issue whose will-close ref comes from a MERGED PR
 * is already-shipped work: exclude it. Pure — no I/O.
 *
 * This replaced an earlier mergedPRs(first: 100) title/body regex scan, which
 * only ever saw the 100 most-recently-updated merged PRs of a 1000+-merged
 * repo — an issue whose covering merge fell outside that window leaked as a
 * false candidate, and the cutoff marches forward with every new merge.
 * Asking GitHub per open issue bounds the work to the (small) open-issue set
 * instead of the ever-growing merged-PR set, with zero window truncation.
 *
 * @param {Array<{number: number, timelineItems?: {totalCount?: number, nodes?: Array<{willCloseTarget?: boolean, source?: {state?: string}}>}}>} allIssues
 * @param {(msg: string) => void} [logFn] receives the truncation warning when present
 * @returns {Set<number>}
 */
export function extractShippedIssueNums(allIssues, logFn = () => {}) {
  const nums = new Set();
  for (const issue of allIssues) {
    const events = issue.timelineItems?.nodes || [];
    // Guard: if an issue has more cross-referenced events than the window
    // fetched, a will-close link could sit outside it (false negative →
    // phantom leaks into candidates). Surface it instead of missing silently.
    const tc = issue.timelineItems?.totalCount;
    if (tc !== undefined && tc > events.length) {
      logFn(`WARNING: #${issue.number} has ${tc} cross-ref events, only ${events.length} fetched — willCloseTarget link may be outside the window`);
    }
    const closedByMergedPR = events.some(
      (e) => e.willCloseTarget && e.source?.state === "MERGED",
    );
    if (closedByMergedPR) nums.add(issue.number);
  }
  return nums;
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
  const openPRIssueNums = extractOpenPRRefs(openPRs);
  const mergedPRIssueNums = extractShippedIssueNums(allIssues, log);

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
  //
  // #4373 part 2 tiers each weak ref by whether the PR title mentions the
  // issue number itself (titleMentionsIssue): a title hit is the repo's
  // covering-PR convention ("fix #N ..."), a title miss is a context-only
  // mention (epic lineage — see #4376). Still advisory only.
  const weakRefsByIssue = new Map(); // issueNum -> { titleHit: [{pr,title}], contextOnly: [{pr,title}] }
  for (const issue of allIssues) {
    for (const e of issue.timelineItems?.nodes || []) {
      if (e.willCloseTarget || e.source?.state !== "MERGED") continue;
      if (!weakRefsByIssue.has(issue.number)) {
        weakRefsByIssue.set(issue.number, { titleHit: [], contextOnly: [] });
      }
      const entry = { pr: e.source.number, title: (e.source.title || "").trim() };
      const tier = titleMentionsIssue(entry.title, issue.number) ? "titleHit" : "contextOnly";
      weakRefsByIssue.get(issue.number)[tier].push(entry);
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
  //
  // #4373 part 2 tiers the list: "likely shipped" (a merged weak-ref PR whose
  // TITLE names the issue — this repo's covering-PR convention) first, then
  // "context-only" mentions (epic lineage) at lower priority. Both remain
  // advisory; the split only spends the reader's attention where a phantom is
  // most likely.
  const flagged = candidates
    .map((i) => ({ issue: i, refs: weakRefsByIssue.get(i.number) }))
    .filter((x) => x.refs && (x.refs.titleHit.length || x.refs.contextOnly.length));
  const titleHitList = flagged.filter((x) => x.refs.titleHit.length);
  const contextOnlyList = flagged.filter((x) => !x.refs.titleHit.length && x.refs.contextOnly.length);
  if (flagged.length) {
    md += `## ⚠️ Weak-ref phantoms — verify before implementing (advisory, NOT auto-excluded)\n\n`;
    md += `These candidates are referenced by an already-**merged** PR via a weak link — a mention without a \`fixes/closes/resolves\` closing link (bare \`#N\` in title/body, dev-panel-free). GitHub did not auto-close them and the phantom filter did not exclude them, so the work **may already be shipped**. Check each against \`main\` (code grep + merged-PR list) before implementing.\n\n`;
    if (titleHitList.length) {
      md += `### Likely shipped — merged PR title names the issue (#4373 part 2 tier 1)\n\n`;
      for (const { issue, refs } of titleHitList) {
        md += `- **#${issue.number}** ${issue.title}\n`;
        for (const r of refs.titleHit.slice(0, 3)) md += `  - ← merged #${r.pr}${r.title ? ` _"${r.title}"_` : ""}\n`;
      }
      md += `\n`;
      // #4373 part 3: the same tier-1 data as a batch-verification checklist —
      // copy-paste grep commands instead of a hand-derived per-issue routine.
      // #4373 part 4: with --verify-shipped, EXECUTE the checklist (grep this
      // repo's git log + gh pr view fallback) and prepend the verdicts, so a
      // tick stops re-deriving the clone+grep loop by hand every round. The
      // copy-paste block still renders — the automated run can error (no
      // clone, no gh auth) and must not leave the reader without the manual
      // path.
      const queue = buildVerificationQueue(candidates, weakRefsByIssue);
      if (VERIFY_SHIPPED) {
        const { summary, details } = await verifyShippedAnchors(queue);
        md += `#### Shipped-anchor verification (#4373 part 4)\n\n${summary}\n\n`;
        for (const d of details) {
          md += `- **#${d.issue}** ${d.verdict}\n`;
          for (const r of d.results) md += `  - #${r.pr} ${r.outcome} (via ${r.via}): ${r.detail}\n`;
        }
        md += `\n`;
      }
      md += renderVerificationBlock(queue);
      md += `\n`;
    }
    if (contextOnlyList.length) {
      md += `### Context-only mentions — epic lineage, lower priority (tier 2)\n\n`;
      for (const { issue, refs } of contextOnlyList) {
        md += `- **#${issue.number}** ${issue.title}\n`;
        for (const r of refs.contextOnly.slice(0, 3)) md += `  - ← merged #${r.pr}${r.title ? ` _"${r.title}"_` : ""}\n`;
      }
      md += `\n`;
    }
    md += `_Tiering heuristic: a merged PR whose title contains the issue's own \`#N\` (this repo's covering-PR convention) is tier 1; every other weak ref is context-only lineage (e.g. open epics referenced by part-series PRs, #4376). Auto-excluding on weak refs is intentionally deferred: a bare \`#N\` can be mere context ("part of #N"), so aggressive matching would drop legitimately-open epics (#4376). This advisory caveat is direction #4 of #4373; semantic-overlap auto-exclusion (direction #3) is a future design call._\n\n---\n\n`;
  }

  console.log(md);
}

// Run main() only when executed directly as a CLI entry point — NOT when
// imported (e.g. by scan.test.ts). Compared via realpath so a symlinked
// invocation (e.g. deployed via schedules/ -> skills/) still matches.
const isMainEntry = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
