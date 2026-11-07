import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

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
 * The booted session's model-catalog surface (Issue #5422): exactly the
 * `Query` methods the alias resolution needs. Kept structural so tests can
 * supply a fixture catalog without mocking the SDK module.
 */
export interface ClaudeModelCatalog {
  supportedModels(): Promise<ModelInfo[]>;
}

/**
 * Alias resolutions keyed by `<llm>::<alias>` (Issue #5422).
 *
 * Cache lifetime: the process lifetime. The catalog belongs to the Claude
 * Code CLI bundled with the pinned agent SDK, so it only changes when the
 * disclaude process itself restarts on an upgraded dependency — a TTL would
 * add churn without adding correctness. Per-LLM keying keeps bindings that
 * constrain the catalog through their own settings from sharing rows.
 * Failures are never cached: the next session boot re-asks the catalog.
 */
const resolvedAliasCache = new Map<string, string>();

/** Test hook: drop cached alias resolutions. */
export function clearResolvedClaudeAliasCache(): void {
  resolvedAliasCache.clear();
}

/**
 * Resolve a bare `behavesAs` alias against the running session's model
 * catalog (Issue #5422): the catalog row whose `value` matches the alias
 * names the full model ID in `resolvedModel` (the row's `value` itself when
 * it omits `resolvedModel`). A missing alias is an explicit error listing
 * the catalog's selectable values — never a silent fallback.
 */
export async function resolveClaudeModelAlias(
  alias: string,
  llmKey: string | undefined,
  catalog: ClaudeModelCatalog
): Promise<string> {
  const normalized = alias.trim().toLowerCase();
  const cacheKey = `${llmKey ?? ''}::${normalized}`;
  const cached = resolvedAliasCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const models = await catalog.supportedModels();
  const row = models.find((model) => model.value.trim().toLowerCase() === normalized);
  if (!row) {
    const available = models.map((model) => model.value).join(', ');
    throw new Error(
      `behavesAs alias "${alias}" is not in the running Claude model catalog (available: ${available || 'none'})`
    );
  }
  const resolved = row.resolvedModel?.trim() || row.value;
  resolvedAliasCache.set(cacheKey, resolved);
  return resolved;
}
