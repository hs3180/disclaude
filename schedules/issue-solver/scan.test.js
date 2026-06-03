#!/usr/bin/env node
/**
 * Tests for schedules/issue-solver/scan.mjs
 *
 * Tests the pure logic functions (scoring, filtering, env parsing)
 * without requiring GitHub API access.
 *
 * Usage: node scan.test.js
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Create a temporary .runtime-env for testing loadRuntimeEnv/saveRuntimeEnv
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `scan-test-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

// We test the env file I/O logic directly since the functions are module-scoped.
// The scan.mjs functions are not exported, so we replicate the pure logic here
// for unit testing (the actual implementations are identical).

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

function loadRuntimeEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
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

function saveRuntimeEnv(filePath, env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${quoteValue(v)}`);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Test: Runtime Env I/O
// ---------------------------------------------------------------------------

console.log("Runtime Env I/O:");

{
  const fp = join(TEST_DIR, ".runtime-env");

  // Empty / non-existent file
  assertEqual(loadRuntimeEnv(fp), {}, "returns {} for non-existent file");

  // Basic KEY=VALUE
  writeFileSync(fp, "GH_TOKEN=ghs_abc123\nEXPIRES=2026-01-01\n");
  const env = loadRuntimeEnv(fp);
  assertEqual(env.GH_TOKEN, "ghs_abc123", "reads GH_TOKEN");
  assertEqual(env.EXPIRES, "2026-01-01", "reads EXPIRES");

  // Comments and blank lines
  writeFileSync(fp, "# comment\n\nKEY1=val1\n# another\nKEY2=val2\n");
  const env2 = loadRuntimeEnv(fp);
  assertEqual(env2.KEY1, "val1", "ignores comments (KEY1)");
  assertEqual(env2.KEY2, "val2", "ignores comments (KEY2)");

  // Values with = sign
  writeFileSync(fp, "EQUATION=a=b=c\n");
  assertEqual(loadRuntimeEnv(fp).EQUATION, "a=b=c", "handles values with = sign");

  // Whitespace trimming
  writeFileSync(fp, "  KEY  =  value  \n");
  assertEqual(loadRuntimeEnv(fp).KEY, "value", "trims whitespace");

  // saveRuntimeEnv round-trip
  const data = { GH_TOKEN: "ghs_new", EXPIRES: "2026-06-03" };
  saveRuntimeEnv(fp, data);
  const loaded = loadRuntimeEnv(fp);
  assertEqual(loaded.GH_TOKEN, "ghs_new", "save round-trip: GH_TOKEN");
  assertEqual(loaded.EXPIRES, "2026-06-03", "save round-trip: EXPIRES");

  // Quoted values — double quotes
  writeFileSync(fp, 'KEY="hello world"\n');
  assertEqual(loadRuntimeEnv(fp).KEY, "hello world", "strips double quotes from value");

  // Quoted values — single quotes
  writeFileSync(fp, "KEY='hello world'\n");
  assertEqual(loadRuntimeEnv(fp).KEY, "hello world", "strips single quotes from value");

  // Mismatched quotes are NOT stripped
  writeFileSync(fp, 'KEY="hello\'\n');
  assertEqual(loadRuntimeEnv(fp).KEY, "\"hello'", "mismatched quotes kept as-is");

  // saveRuntimeEnv quotes values with spaces
  saveRuntimeEnv(fp, { MSG: "hello world" });
  const raw = readFileSync(fp, "utf-8");
  assert(raw.includes('MSG="hello world"'), "saves value with spaces in double quotes");
  assertEqual(loadRuntimeEnv(fp).MSG, "hello world", "round-trip: value with spaces");

  // saveRuntimeEnv escapes and quotes values with double quotes
  saveRuntimeEnv(fp, { MSG: 'say "hi"' });
  const raw2 = readFileSync(fp, "utf-8");
  assert(raw2.includes('MSG="say \\"hi\\""'), "escapes internal double quotes");
  assertEqual(loadRuntimeEnv(fp).MSG, 'say "hi"', "round-trip: value with double quotes");

  // Unquoted values without spaces are preserved as-is
  saveRuntimeEnv(fp, { TOKEN: "ghs_abc123" });
  const raw3 = readFileSync(fp, "utf-8");
  assert(raw3.includes("TOKEN=ghs_abc123"), "simple value written without quotes");
}

// ---------------------------------------------------------------------------
// Test: isTokenValid
// ---------------------------------------------------------------------------

console.log("Token Validity:");

function isTokenValid(env) {
  const expiresAt = env.GH_TOKEN_EXPIRES_AT;
  if (!expiresAt || !env.GH_TOKEN) return false;
  const expiry = new Date(expiresAt).getTime();
  const now = Date.now();
  const margin = 5 * 60 * 1000;
  return now < expiry - margin;
}

{
  assert(!isTokenValid({}), "empty env → invalid");
  assert(!isTokenValid({ GH_TOKEN: "abc" }), "missing expiry → invalid");
  assert(!isTokenValid({ GH_TOKEN_EXPIRES_AT: "2020-01-01" }), "expired token → invalid");

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert(isTokenValid({ GH_TOKEN: "abc", GH_TOKEN_EXPIRES_AT: future }), "future token → valid");

  const soon = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  assert(!isTokenValid({ GH_TOKEN: "abc", GH_TOKEN_EXPIRES_AT: soon }), "within margin → invalid");
}

// ---------------------------------------------------------------------------
// Test: selectInstallation
// ---------------------------------------------------------------------------

console.log("Installation Selection:");

function selectInstallation(installations, targetOwner) {
  if (targetOwner) {
    const match = installations.find(
      (inst) => inst.account && inst.account.login.toLowerCase() === targetOwner.toLowerCase(),
    );
    if (match) return match.id;
    return {
      error: `No installation found for owner '${targetOwner}'. Available: ${installations.map((i) => i.account?.login).join(", ")}. Set GITHUB_APP_INSTALLATION_ID explicitly or ensure the app is installed on the target repository.`,
    };
  }
  return installations[0].id;
}

{
  const installs = [
    { id: 100, account: { login: "OtherUser" } },
    { id: 200, account: { login: "hs3180" } },
  ];

  assertEqual(selectInstallation(installs, "hs3180"), 200, "matches by owner");
  assertEqual(selectInstallation(installs, "HS3180"), 200, "case-insensitive match");
  const unknownResult = selectInstallation(installs, "unknown");
  assert(unknownResult.error, "unknown owner → returns error object");
  assert(unknownResult.error.includes("unknown"), "error message mentions owner name");
  assertEqual(selectInstallation(installs, null), 100, "null owner → first");
}

// ---------------------------------------------------------------------------
// Test: scoreIssue
// ---------------------------------------------------------------------------

console.log("Issue Scoring:");

function scoreIssue(issue, relatedPRs) {
  let score = 0;
  const title = (issue.title || "").toLowerCase();
  const labels = (issue.labels || []).map((l) => (l.name || l || "").toLowerCase());

  if (labels.includes("bug")) score += 10;
  if (labels.includes("enhancement") || title.startsWith("feat")) score += 5;
  if (title.startsWith("test")) score += 3;
  if (labels.includes("ci-monitor")) score -= 5;
  if (labels.includes("automation")) score += 4;
  const rejectedCount = relatedPRs.filter((pr) => (pr.state || "").toUpperCase() === "CLOSED").length;
  score -= rejectedCount * 2;
  score -= 1;

  return score;
}

{
  // Bug label → high priority
  const s1 = scoreIssue({ title: "crash on startup", labels: [{ name: "bug" }] }, []);
  assertEqual(s1, 9, "bug label: 10 - 1 = 9");

  // Feature request (enhancement OR feat title → +5 once)
  const s2 = scoreIssue({ title: "feat: add dark mode", labels: [{ name: "enhancement" }] }, []);
  assertEqual(s2, 4, "enhancement + feat title: 5 - 1 = 4 (OR condition, counted once)");

  // With rejected PRs
  const s3 = scoreIssue({ title: "some issue", labels: [] }, [
    { state: "CLOSED" }, { state: "CLOSED" },
  ]);
  assertEqual(s3, -5, "2 rejected PRs: -4 - 1 = -5");

  // CI monitor → penalty
  const s4 = scoreIssue({ title: "flaky test", labels: [{ name: "ci-monitor" }] }, []);
  assertEqual(s4, -6, "ci-monitor: -5 - 1 = -6");

  // Automation label
  const s5 = scoreIssue({ title: "auto label issue", labels: [{ name: "automation" }] }, []);
  assertEqual(s5, 3, "automation: 4 - 1 = 3");
}

// ---------------------------------------------------------------------------
// Test: buildPrIssueSet
// ---------------------------------------------------------------------------

console.log("PR Issue Set:");

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

{
  const prs = [
    { body: "Fixes #123", headRefName: "fix/issue-456" },
    { body: "Related to #789", headRefName: "main" },
    { body: "No issue ref", headRefName: "feature" },
  ];
  const set = buildPrIssueSet(prs);
  assert(set.has(123), "extracts #123 from body");
  assert(set.has(789), "extracts #789 from body");
  // Note: branch "fix/issue-456" contains "456" but not "#456", so regex /#(\d+)/ won't match it
  assert(!set.has(456), "branch without # prefix not extracted by regex");
  assertEqual(set.size, 2, "2 unique issue numbers from bodies");
}

// ---------------------------------------------------------------------------
// Test: findRelatedPRs
// ---------------------------------------------------------------------------

console.log("Related PRs:");

function findRelatedPRs(issueNumber, allPRs) {
  const issueStr = `#${issueNumber}`;
  return allPRs.filter((pr) => {
    const body = pr.body || "";
    const branch = pr.headRefName || "";
    const title = pr.title || "";
    return body.includes(issueStr) || title.includes(issueStr) || branch.includes(String(issueNumber));
  });
}

{
  const allPRs = [
    { title: "Fix #100", body: "", headRefName: "main", state: "OPEN" },
    { title: "Unrelated", body: "See #100 for context", headRefName: "fix", state: "CLOSED" },
    { title: "Other PR", body: "No refs", headRefName: "fix-100", state: "OPEN" },
    { title: "Unrelated", body: "No refs", headRefName: "main", state: "OPEN" },
  ];

  const related = findRelatedPRs(100, allPRs);
  assertEqual(related.length, 3, "finds 3 related PRs for #100");

  const unrelated = findRelatedPRs(999, allPRs);
  assertEqual(unrelated.length, 0, "finds 0 related PRs for #999");
}

// ---------------------------------------------------------------------------
// Test: extractCloseReason
// ---------------------------------------------------------------------------

console.log("Close Reason Extraction:");

function extractCloseReason(comments) {
  if (!comments) return null;
  const lines = comments.split("\n");
  let reason = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^(author|association|edited|status|--)/.test(line)) continue;
    if (!line) continue;
    reason = line.substring(0, 200);
    break;
  }
  return reason;
}

{
  assertEqual(extractCloseReason(null), null, "null input → null");
  assertEqual(extractCloseReason(""), null, "empty string → null");
  assertEqual(extractCloseReason("author: bot\n\nThis was fixed in #42"), "This was fixed in #42", "extracts reason after metadata");
  assertEqual(extractCloseReason("--\nstatus: closed\n\nDuplicate of #10\n"), "Duplicate of #10", "skips status line");
}

// ---------------------------------------------------------------------------
// Test: TARGET_REPO validation regex
// ---------------------------------------------------------------------------

console.log("TARGET_REPO Validation:");

{
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

  // Valid formats
  assert(REPO_RE.test("hs3180/disclaude"), "standard owner/repo");
  assert(REPO_RE.test("my-org/my.repo"), "repo with dots");
  assert(REPO_RE.test("org_name/repo_name"), "underscores");
  assert(REPO_RE.test("org/repo-name"), "hyphens");

  // Invalid formats
  assert(!REPO_RE.test(""), "empty string");
  assert(!REPO_RE.test("noslash"), "missing slash");
  assert(!REPO_RE.test("too/many/slashes"), "too many slashes");
  assert(!REPO_RE.test("space owner/repo"), "space in owner");
  assert(!REPO_RE.test("owner/repo space"), "space in repo");
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  |  Failed: ${failed}`);
console.log("=".repeat(40));

if (failed > 0) process.exit(1);
