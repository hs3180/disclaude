/** Codex sandbox selection from its native config and the existing permission mode. */
import type { AgentQueryOptions } from '../../types.js';

/** codex `sandbox_mode` values (canonical config key, #4432 part 5). */
export type CodexSandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Resolved sandbox decision — the runner turns this into argv. */
export interface CodexSandboxDecision {
  /** The level to pass as `-c sandbox_mode=<level>`. */
  sandbox: CodexSandboxLevel;
  /** Human-readable mapping rationale, in decision order (logged, tested). */
  reasons: string[];
}

/**
 * Resolve the codex sandbox level for one queryStream call.
 *
 * Refuses unknown permission modes. Never reads the environment — inputs are the query options plus the optional explicit
 * `agent.codexSandbox` override.
 */
export function resolveCodexSandboxPolicy(
  options: Pick<AgentQueryOptions, 'permissionMode'>,
  configSandbox?: CodexSandboxLevel,
  fullAccess = false
): CodexSandboxDecision {
  const reasons: string[] = [];

  // 1) Base level: the explicit full-access opt-in wins, followed by the
  //    advanced sandbox override. Otherwise preserve the normal bot policy;
  //    'default' means "ask the user" — headless exec has no asker, and the
  //    safe degradation is read-only, NOT a silently wider sandbox.
  // Allowlist the inference (S4 review): this resolver IS the security
  // boundary, and `!== 'default' ? wider` would silently widen the sandbox
  // for any out-of-enum value a future caller passes — fail closed instead.
  let sandbox: CodexSandboxLevel;
  if (fullAccess) {
    sandbox = 'danger-full-access';
  } else if (configSandbox) {
    sandbox = configSandbox;
  } else if (options.permissionMode === 'default') {
    sandbox = 'read-only';
  } else if (
    options.permissionMode === 'bypassPermissions' ||
    options.permissionMode === undefined
  ) {
    sandbox = 'workspace-write';
  } else {
    throw new Error(
      `CodexAgentProvider: unknown permissionMode "${String(options.permissionMode)}" — ` +
        'refusing to infer a sandbox level (fail closed, #4631).'
    );
  }
  reasons.push(
    fullAccess
      ? 'agent.fullAccess=true (explicit full-access opt-in)'
      : configSandbox
        ? `agent.codexSandbox=${configSandbox} (explicit override)`
        : options.permissionMode === 'default'
          ? "permissionMode 'default' (ask) has no headless approver → read-only (fail closed)"
          : 'normal Codex policy → workspace-write'
  );

  return {
    sandbox,
    reasons,
  };
}