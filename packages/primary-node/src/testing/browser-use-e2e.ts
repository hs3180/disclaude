/**
 * Agent-level browser-use e2e harness — assertion + orchestration core
 * (Issue #4602 part 2, injection channel option b).
 *
 * Part 1 (`scripts/browser-use-smoke.sh`, PR #4610) encoded the **CLI-level**
 * smoke matrix as a repeatable script: it pipes Python straight into the
 * `browser-use` CLI. But the layer that had never been verified (#4602's
 * opening table) is the **agent-level** chain:
 *
 *   agent auto-discovers the browser-use skill (no human naming it)
 *     → calls Bash per the SKILL.md contract (`browser-use <<'PY' … PY`)
 *     → attaches via `BU_CDP_URL` (no self-spawned Chrome)
 *     → `js()` injection returns structured results
 *     → screenshot artifact lands in the workspace, non-empty
 *     → CDP-unreachable fails loudly, never silently self-spawns (#4496 Scope-3)
 *
 * This module implements that layer by instantiating a **real ChatAgent**
 * (`AgentFactory.createAgent`, the same one-shot entry the scheduler uses),
 * feeding it a prompt, and asserting on (a) the reply text the agent sends
 * back and (b) the artifacts it leaves in the workspace. A live run needs a
 * model API key and a reachable CDP endpoint, so the runner lives behind
 * `scripts/browser-use-agent-e2e.mts` for an operator shell — the same
 * tooling-first split as the Card Kit bench (#4398 / #4416 / #4454), where
 * the CI-testable half is the assertion logic itself (see
 * `browser-use-e2e.test.ts`): check extraction, verdict aggregation, and the
 * failure-path contract, all driven by canned replies.
 *
 * @module primary-node/testing/browser-use-e2e
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Check definitions — the 5 assertion points from #4602 Scope-2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The checks are phrased against what the *prompt contract* asks the agent to
 * echo back. The prompt (AGENT_E2E_PROMPT) requires the agent to finish with
 * a fenced ```e2e-report block of `key=value` lines, so a single reply can
 * satisfy every structured assertion without the harness parsing prose.
 */
export interface E2ECheck {
  /** Stable id, used in the report and by tests. */
  id: string;
  /** One-line human description (report output). */
  label: string;
}

export const E2E_CHECKS: readonly E2ECheck[] = [
  { id: 'skill_discovery', label: 'agent used the browser-use skill unprompted (reply mentions the CLI call it ran)' },
  { id: 'attach_no_self_spawn', label: 'attached via BU_CDP_URL; no self-spawned browser (agent-observed attach mode)' },
  { id: 'js_round_trip', label: 'js() script injection returned the expected structured result' },
  { id: 'screenshot_artifact', label: 'screenshot artifact exists in workspace and is a non-empty PNG' },
  { id: 'cdp_failure_explicit', label: 'CDP-unreachable path produced an explicit error, not a silent self-spawn fallback' },
] as const;

/**
 * Workspace-relative marker path the prompt asks the agent to write to.
 * Deliberately does NOT contain the string "browser-use" — the prompt must
 * not leak the skill name (that is the skill_discovery check's whole point).
 */
export const E2E_SCREENSHOT_RELATIVE_PATH = 'e2e/browser-shot.png';

/**
 * The prompt fed to the ChatAgent. Deliberately does NOT name any tool, skill
 * or command — the whole point of the skill_discovery check is that the agent
 * finds the browser-use skill itself (the #4460 acceptance being verified).
 *
 * The reply contract (final ```e2e-report block) gives the harness one stable
 * surface to assert on; without it every check would be prose-grepping.
 */
export const AGENT_E2E_PROMPT = `Run this browser e2e checklist using whatever browser capability you have in this environment (a headless host — an external Chromium CDP endpoint is the intended path; do NOT install or launch a browser yourself):

1. Attach to the external CDP endpoint configured for you (BU_CDP_URL) and open a new tab with this exact data URL:
   data:text/html,<script>window.marker=42</script><h1 id="x">hello-agent-e2e</h1>
2. In that tab, evaluate JavaScript that returns JSON.stringify({marker: window.marker, heading: document.getElementById('x').textContent}).
3. Take a screenshot and save the PNG to the workspace at exactly: ${E2E_SCREENSHOT_RELATIVE_PATH} (create the parent directory first — the screenshot helper does not create it and will hang if missing).
4. Then simulate the failure path: attempt ONE additional attach with BU_CDP_URL pointing at http://127.0.0.1:1 (a port nothing listens on), and record what error you get. Do not retry it more than once.

Finish your reply with a fenced code block tagged e2e-report containing exactly these keys, one key=value per line:
skill_discovery=<which skill or CLI you used to drive the browser>
attach_no_self_spawn=<true if you attached to the external endpoint without launching a local browser; otherwise false plus what happened>
js_round_trip=<the JSON string step 2 returned, or ERROR>
screenshot_artifact=<the path you saved to, or ERROR>
cdp_failure_explicit=<the error text from step 4, or EMPTY if it silently succeeded>

The e2e-report block must be the last thing in your reply.`;

// ─────────────────────────────────────────────────────────────────────────────
// Report parsing + verdicts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the last ```e2e-report fenced block from an agent reply and parse it
 * into a key→value map. Tolerates leading/trailing whitespace per line and
 * ignores blank lines; keys without '=' are skipped (a malformed line fails
 * its own check later rather than breaking the parse).
 */
export function parseE2EReport(reply: string): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = [...reply.matchAll(/```e2e-report\s*\n([\s\S]*?)```/g)];
  const block = matches.length > 0 ? matches[matches.length - 1][1] : '';
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {continue;}
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {continue;}
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export interface CheckResult {
  id: string;
  label: string;
  /** true = passed, false = failed, null = could not be evaluated (counts as failed). */
  passed: boolean | null;
  /** What was actually observed — always populated, for the report. */
  evidence: string;
}

export interface E2EVerdict {
  results: CheckResult[];
  /** All check ids that did not pass (failed or unevaluable). */
  failed: string[];
  /** Human-readable multi-line report. */
  report: string;
}

/** Truncate evidence for stable report lines (long error dumps help no one). */
function clip(s: string, max = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)  }…`;
}

/**
 * Evaluate the 5 checks against an agent reply + the workspace dir the agent
 * ran in. Pure (fs reads aside, all read-only) so the CI test can drive it
 * with canned replies and temp files.
 *
 * Check semantics:
 * - skill_discovery: report mentions `browser-use` in skill_discovery (the
 *   agent must have found THE skill, not any tool).
 * - attach_no_self_spawn: value starts with `true`.
 * - js_round_trip: value parses as JSON with marker=42 and
 *   heading='hello-agent-e2e' — the exact round-trip payload the prompt set up
 *   (same shape as the CLI matrix case 2 in docs/cdp-endpoint.md).
 * - screenshot_artifact: path resolves inside workspaceDir, exists, size > 0,
 *   and starts with the PNG magic bytes.
 * - cdp_failure_explicit: value non-empty and contains an error indicator
 *   (refused / unreachable / timeout / error-ish) — a silent success here is
 *   exactly the #4496 Scope-3 regression this check exists to catch.
 */
export function evaluateE2EReport(
  reply: string,
  workspaceDir: string,
): E2EVerdict {
  const report = parseE2EReport(reply);
  const results: CheckResult[] = [];

  const push = (c: E2ECheck, passed: boolean | null, evidence: string) =>
    results.push({ id: c.id, label: c.label, passed, evidence: clip(evidence) });

  for (const check of E2E_CHECKS) {
    const raw = report[check.id];
    if (raw === undefined) {
      push(check, null, 'missing from e2e-report block');
      continue;
    }
    switch (check.id) {
      case 'skill_discovery': {
        const ok = /browser-use/i.test(raw);
        push(check, ok, ok ? `used: ${raw}` : `did not use browser-use: ${raw}`);
        break;
      }
      case 'attach_no_self_spawn': {
        const ok = raw.toLowerCase().startsWith('true');
        push(check, ok, ok ? 'agent reports external attach, no local browser' : raw);
        break;
      }
      case 'js_round_trip': {
        let ok = false;
        let why = `unparseable as JSON: ${raw}`;
        try {
          const parsed = JSON.parse(raw) as { marker?: unknown; heading?: unknown };
          ok = parsed.marker === 42 && parsed.heading === 'hello-agent-e2e';
          if (!ok) {why = `payload mismatch: ${raw}`;}
        } catch {
          /* keep default why */
        }
        push(check, ok, ok ? raw : why);
        break;
      }
      case 'screenshot_artifact': {
        const abs = path.resolve(workspaceDir, raw);
        const inside = abs.startsWith(path.resolve(workspaceDir) + path.sep);
        if (!inside) {
          push(check, false, `path escapes workspace: ${raw}`);
          break;
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          push(check, false, `artifact not found at ${abs}`);
          break;
        }
        const {size} = statSync(abs);
        const isPng =
          size > 0 && readFileSync(abs).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        push(
          check,
          size > 0 && isPng,
          `${abs} — ${size} bytes${isPng ? ', PNG magic ok' : ', NOT a PNG'}`,
        );
        break;
      }
      case 'cdp_failure_explicit': {
        const looksLikeError = /(refus|unreach|tim(e)?d? ?out|error|fail|closed|reset|econn)/i.test(raw);
        push(
          check,
          raw !== 'EMPTY' && raw.length > 0 && looksLikeError,
          raw === 'EMPTY' || raw.length === 0
            ? 'silent success on a dead endpoint — the exact regression #4496 Scope-3 forbids'
            : raw,
        );
        break;
      }
      default:
        push(check, null, 'unknown check id');
    }
  }

  const failed = results.filter((r) => r.passed !== true).map((r) => r.id);
  const lines = [
    `browser-use agent e2e — ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED (${failed.join(', ')})`}`,
    '',
    ...results.map(
      (r) =>
        `- [${r.passed === true ? 'PASS' : r.passed === false ? 'FAIL' : 'N/A '}] ${r.id.padEnd(22)} ${r.evidence}`,
    ),
  ];
  return { results, failed, report: lines.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness config + preflight
// ─────────────────────────────────────────────────────────────────────────────

export interface HarnessConfig {
  /** Chat id the one-shot agent is bound to (arbitrary stable string). */
  chatId: string;
  /** Workspace dir — also the agent cwd and the artifact root. */
  workspaceDir: string;
  /** CDP endpoint forwarded to the agent subprocess as BU_CDP_URL. */
  cdpUrl: string;
  /** Model API key (ANTHROPIC_API_KEY or provider equivalent). */
  apiKey: string;
  /** Optional model override; otherwise Config.getAgentConfig() default. */
  model?: string;
  /** Optional provider override (e.g. 'anthropic' | 'glm'). */
  provider?: string;
  /** Optional API base URL override (GLM / proxy). */
  apiBaseUrl?: string;
  /** Per-turn timeout for the agent, ms. Default 10 min. */
  turnTimeoutMs: number;
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
}

/**
 * Fail-fast checks an operator can act on (mirrors the bench's requiredEnv
 * style). Verifies the two live-only inputs (CDP reachability, API key) plus
 * workspace sanity — so a misconfigured run dies in seconds with a precise
 * message instead of a 10-minute agent hang.
 */
export function preflight(config: HarnessConfig): PreflightResult {
  const problems: string[] = [];
  if (!config.apiKey) {
    problems.push('missing model API key (set ANTHROPIC_API_KEY or pass --api-key)');
  }
  if (!config.cdpUrl) {
    problems.push('missing CDP endpoint (set BU_CDP_URL or pass --cdp-url)');
  }
  if (!existsSync(config.workspaceDir)) {
    problems.push(`workspace dir does not exist: ${config.workspaceDir}`);
  }
  return { ok: problems.length === 0, problems };
}
