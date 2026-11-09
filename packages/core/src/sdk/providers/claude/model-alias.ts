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

/** Full Claude model IDs as modelOverrides keys (Issue #5410); anything else in a key is a bare alias. */
const FULL_CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a modelOverrides key is a full Claude catalog ID rather than a bare alias (Issue #5422). */
export function isFullClaudeModelId(key: string): boolean {
  return FULL_CLAUDE_MODEL_ID.test(key.trim().toLowerCase());
}

/**
 * Split a modelOverrides map by key kind (Issue #5422): full Claude model
 * IDs flow into the session's settings file as-is, while bare alias keys
 * (`opus`, `sonnet`, …) name catalog rows the Claude provider must resolve
 * against the booted session before the first input.
 */
export function splitModelOverrides(
  overrides: Record<string, string> | undefined
): { static: Record<string, string>; aliases: Array<{ alias: string; providerModel: string }> } {
  const staticEntries: Record<string, string> = {};
  const aliases: Array<{ alias: string; providerModel: string }> = [];
  for (const [key, providerModel] of Object.entries(overrides ?? {})) {
    if (isFullClaudeModelId(key)) {
      staticEntries[key] = providerModel;
    } else {
      aliases.push({ alias: key.trim().toLowerCase(), providerModel });
    }
  }
  return { static: staticEntries, aliases };
}

/**
 * Fingerprint the query environment that can change the session's model
 * catalog (Issue #5422): bindings may pin different env, and the catalog the
 * booted session reports follows it. Sessions with the same env — in
 * particular every session of one LLM binding — share one fingerprint.
 */
export function aliasScopeKey(env: Record<string, string | undefined> | undefined): string {
  const entries = (Object.entries(env ?? {}) as Array<[string, string | undefined]>)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
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
 * Alias resolutions keyed by `<env-scope>::<alias>` (Issue #5422).
 *
 * Cache lifetime: the process lifetime. The catalog belongs to the Claude
 * Code CLI bundled with the pinned agent SDK, so it only changes when the
 * disclaude process itself restarts on an upgraded dependency — a TTL would
 * add churn without adding correctness. The env-scope key keeps sessions
 * whose environment can constrain the catalog (per LLM binding) from sharing
 * rows; sessions of one binding share the cached resolution.
 * Failures are never cached: the next session boot re-asks the catalog.
 */
const resolvedAliasCache = new Map<string, string>();

/** Test hook: drop cached alias resolutions. */
export function clearResolvedClaudeAliasCache(): void {
  resolvedAliasCache.clear();
}

/**
 * Resolve a bare model alias against the running session's model catalog
 * (Issue #5422): the catalog row whose `value` matches the alias names the
 * full model ID in `resolvedModel` (the row's `value` itself when it omits
 * `resolvedModel`). A missing alias is an explicit error listing the
 * catalog's selectable values — never a silent fallback.
 */
export async function resolveClaudeModelAlias(
  alias: string,
  scope: string | undefined,
  catalog: ClaudeModelCatalog
): Promise<string> {
  const normalized = alias.trim().toLowerCase();
  const cacheKey = `${scope ?? ''}::${normalized}`;
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
