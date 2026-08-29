/**
 * Codex sandbox policy resolver — disclaude permission gate → codex exec
 * sandbox level (Issue #4631, S4 of #4627).
 *
 * Why a mapping (and not a per-call gate like pi's #4389
 * tool-permission-gate): codex `exec` is headless — verified live against
 * codex-cli 0.132.0, `codex exec -a …` fails with "unexpected argument"
 * (the approval axis exists only in the interactive TUI), so there is NO
 * per-call approval hook to ride. The entire permission surface available
 * pre-run is the sandbox axis (#4432 part 5, C-Q3.2: Codex's design is two
 * ORTHOGONAL axes — approval_policy × sandbox_mode; exec mode collapses the
 * first). This module therefore maps disclaude's policy ONTO that one axis:
 *
 * | disclaude input                              | codex sandbox          |
 * |----------------------------------------------|------------------------|
 * | permissionMode 'bypassPermissions'/unset     | workspace-write        |
 * | permissionMode 'default' (ask)               | read-only (fail closed)|
 * | agent.codexSandbox explicit override         | that level             |
 * | disallowedTools contains a mutation tool     | capped at read-only    |
 * | disallowedTools contains WebSearch           | THROWS (unenforceable) |
 * | disallowedTools contains only claude-only    | no effect              |
 * |   names (EnterPlanMode, Cron*, …)            |                        |
 *
 * Verified enforcement (0.132.0, live): `-c sandbox_mode=read-only` makes
 * codex's own file writes fail ("operation not permitted", rejected before
 * any command_execution item is even emitted); `-s` is REJECTED on
 * `exec resume` ("unexpected argument '-s'") while `-c sandbox_mode=` is
 * accepted there — so the runner passes the level uniformly as
 * `-c sandbox_mode=<level>` on both fresh and resume runs.
 *
 * Fail-closed semantics (#4631 acceptance): "ask" cannot be honored
 * headlessly (no approver exists) → read-only; a denylist entry that codex
 * demonstrably cannot honor (WebSearch: both `-c tools.web_search=false`
 * and `--disable web_search` verified INEFFECTIVE on 0.132.0) → thrown
 * error naming the entry, never a silent policy hole.
 *
 * Pure module: no I/O, fully unit-testable — same pattern as the pi gate
 * (tool-permission-gate.ts, #4389 part 1).
 */

import type { AgentQueryOptions } from '../../types.js';

/** codex `sandbox_mode` values (canonical config key, #4432 part 5). */
export type CodexSandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Denylist names (lowercased, exact match) whose intent is "the model must
 * not mutate the workspace / run arbitrary commands". Codex-side capability
 * names (its item types + apply_patch) plus the Claude-side tool names that
 * map onto the same capability — an operator denylisting `Bash` means the
 * same thing regardless of backend.
 *
 * Enforcement is a PARTIAL analog: read-only blocks all mutation (verified)
 * but codex can still run read-only commands; a true "no shell at all"
 * switch does not exist in exec mode. Documented residual gap (#4631).
 */
const MUTATION_TOOL_NAMES = new Set([
  'bash',
  'write',
  'edit',
  'notebookedit',
  'notebookeditfile',
  'str_replace_editor',
  // codex-side capability names
  'shell',
  'command_execution',
  'file_change',
  'apply_patch',
]);

/**
 * Denylist names targeting codex's built-in web search. Codex HAS this
 * capability (web_search items) but 0.132.0 provides NO working off switch
 * (`-c tools.web_search=false` and `--disable web_search` both verified
 * ineffective — searches still ran), so honoring the entry is impossible
 * and the resolver fails closed with a clear error instead.
 */
const WEB_SEARCH_TOOL_NAMES = new Set(['websearch', 'web_search']);

/** Resolved sandbox decision — the runner turns this into argv. */
export interface CodexSandboxDecision {
  /** The level to pass as `-c sandbox_mode=<level>`. */
  sandbox: CodexSandboxLevel;
  /** argv fragment for codex-runner (CodexExecRunOptions.configOverrides). */
  configOverrides: string[];
  /** Human-readable mapping rationale, in decision order (logged, tested). */
  reasons: string[];
}

/**
 * Resolve the codex sandbox level for one queryStream call.
 *
 * Throws (fail closed, actionable message) when the denylist demands
 * something codex exec demonstrably cannot honor. Never reads the
 * environment — inputs are the query options plus the optional explicit
 * `agent.codexSandbox` override.
 */
export function resolveCodexSandboxPolicy(
  options: Pick<AgentQueryOptions, 'permissionMode' | 'disallowedTools'>,
  configSandbox?: CodexSandboxLevel,
): CodexSandboxDecision {
  const reasons: string[] = [];

  // 1) Base level: explicit config wins; else infer from permissionMode.
  //    'default' means "ask the user" — headless exec has no asker, and the
  //    safe degradation is read-only, NOT a silently wider sandbox.
  let sandbox: CodexSandboxLevel =
    configSandbox ?? (options.permissionMode === 'default' ? 'read-only' : 'workspace-write');
  reasons.push(
    configSandbox
      ? `agent.codexSandbox=${configSandbox} (explicit override)`
      : options.permissionMode === 'default'
        ? "permissionMode 'default' (ask) has no headless approver → read-only (fail closed)"
        : "permissionMode '${options.permissionMode ?? 'bypassPermissions (default)'}' → workspace-write",
  );

  // 2) Denylist cap: mutation-blocking entries cap the sandbox at read-only
  //    even under an explicit override — a security denylist outranks a
  //    convenience preference.
  const denylist = (options.disallowedTools ?? []).map((name) => name.toLowerCase());
  const mutationHits = denylist.filter((name) => MUTATION_TOOL_NAMES.has(name));
  if (mutationHits.length > 0) {
    sandbox = 'read-only';
    reasons.push(
      `disallowedTools has mutation tools (${[...new Set(mutationHits)].join(', ')}) → capped at read-only`,
    );
  }

  // 3) Unenforceable entries: web search cannot be disabled on codex exec
  //    (verified 0.132.0) → fail closed instead of silently violating policy.
  const webSearchHits = denylist.filter((name) => WEB_SEARCH_TOOL_NAMES.has(name));
  if (webSearchHits.length > 0) {
    throw new Error(
      'CodexAgentProvider: disallowedTools includes web-search tools ' +
        `(${[...new Set(webSearchHits)].join(', ')}), but the codex CLI cannot disable its ` +
        'built-in web search in exec mode (verified codex-cli 0.132.0 — no effective flag). ' +
        'Refusing to run with a permission policy that cannot be honored (fail closed, #4631). ' +
        'Remove the web-search entries or use another agentBackend for this policy.',
    );
  }

  return {
    sandbox,
    configOverrides: [`sandbox_mode=${sandbox}`],
    reasons,
  };
}
