/** Opus 4.7 and later (including Opus 5) are the 1M-context keys in Claude Code's catalog (Issue #5410). */
export function assumedContextWindow(claudeModelId: string): 1_000_000 | 200_000 {
  const match = /^claude-opus-(\d+)(?:-(\d+))?/.exec(claudeModelId);
  if (!match) {
    return 200_000;
  }
  const major = Number(match[1]);
  return major > 4 || (major === 4 && Number(match[2] ?? 0) >= 7) ? 1_000_000 : 200_000;
}

/**
 * Full Claude model IDs as modelOverrides keys (Issue #5410). A bare alias
 * key reaches the provider only as the config-compiled three-tier mapping
 * (Issue #5422): the user-declared `agents.<name>.claude.models` mapping is
 * the single capability-slot source and is compiled into the parameter
 * mapping at config time, so the Claude runtime receives only static
 * entries — no live-catalog resolution and no first-use resolution path
 * exists. Claude Code resolves each tier alias against its current catalog
 * before the wire, so the binding follows CLI upgrades.
 */
const FULL_CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a modelOverrides key is a full Claude catalog ID rather than a bare alias (Issue #5422). */
export function isFullClaudeModelId(key: string): boolean {
  return FULL_CLAUDE_MODEL_ID.test(key.trim().toLowerCase());
}
