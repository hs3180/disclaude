/**
 * Shared utilities for Agent SDK integration.
 */

import type {
  AgentMessage,
  ContentBlock,
} from '../types/agent.js';

/**
 * Model alias mapping for SDK model resolution.
 *
 * When the SDK spawns team agents with `model: opus` (or sonnet/haiku),
 * it resolves the alias using `ANTHROPIC_DEFAULT_*_MODEL` env vars.
 * This mapping overrides those env vars to ensure team agents use
 * models from the disclaude tier configuration.
 *
 * @see Issue #3706
 */
export interface ModelAliases {
  /** Model to use when SDK resolves `model: opus` */
  opus?: string;
  /** Model to use when SDK resolves `model: sonnet` */
  sonnet?: string;
  /** Model to use when SDK resolves `model: haiku` */
  haiku?: string;
}

/**
 * Get directory containing node executable.
 * This is needed for SDK subprocess spawning to find node.
 */
export function getNodeBinDir(): string {
  const {execPath} = process;
  return execPath.substring(0, execPath.lastIndexOf('/'));
}

/**
 * Extract text from AgentMessage.
 * Handles both string content and array content with text blocks.
 *
 * This is the canonical extractText function - use this instead of
 * duplicating the logic in agent classes.
 *
 * @param message - AgentMessage to extract text from
 * @returns Extracted text content
 */
export function extractText(message: AgentMessage): string {
  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block: ContentBlock): block is ContentBlock & { text: string } =>
        'text' in block && typeof block.text === 'string'
      )
      .map((block: ContentBlock & { text: string }) => block.text)
      .join('');
  }

  return '';
}

/**
 * Build SDK environment variables with unified apiBaseUrl handling.
 * This function centralizes environment variable setup for all agents.
 *
 * IMPORTANT: SDK's env option completely replaces subprocess environment,
 * so we MUST include PATH for node to be found. Without PATH, the SDK
 * subprocess will fail with "spawn node ENOENT".
 *
 * Also, we must unset CLAUDECODE to allow SDK subprocess to run inside
 * another Claude Code session (nested session detection).
 *
 * @param apiKey - API key for authentication
 * @param apiBaseUrl - Optional base URL for API requests (e.g., for GLM)
 * @param extraEnv - Optional extra environment variables to merge
 * @param sdkDebug - Enable SDK debug logging (default: true)
 * @param sdkTimeoutMs - SDK HTTP request timeout in ms (Issue #2992, default: 300000)
 * @param modelAliases - Optional model alias overrides for SDK team agent resolution (Issue #3706)
 * @returns Environment object for SDK options
 */
export function buildSdkEnv(
  apiKey: string,
  apiBaseUrl?: string,
  extraEnv?: Record<string, string | undefined>,
  sdkDebug: boolean = true,
  sdkTimeoutMs?: number,
  modelAliases?: ModelAliases,
): Record<string, string | undefined> {
  const nodeBinDir = getNodeBinDir();

  // Ensure PATH includes node bin dir at the front
  // SDK subprocess needs to find 'node' command
  const originalPath = process.env.PATH || '';
  const newPath = originalPath.includes(nodeBinDir)
    ? originalPath
    : `${nodeBinDir}:${originalPath}`;

  // Priority (highest to lowest):
  // 1. Our forced values (API_KEY, PATH, BASE_URL, DEBUG)
  // 2. process.env (system environment)
  // 3. extraEnv (caller-provided defaults)
  // This ensures system env vars can't be accidentally overridden by extraEnv,
  // but our critical values always take precedence.
  const env: Record<string, string | undefined> = {
    ...extraEnv,
    ...(process.env as Record<string, string | undefined>),
    ANTHROPIC_API_KEY: apiKey,
    PATH: newPath,
    // Enable SDK debug logging by default for better troubleshooting
    // SDK subprocess errors go to stderr and are critical for debugging
    // Can be disabled via config logging.sdkDebug: false
    DEBUG_CLAUDE_AGENT_SDK: sdkDebug ? (process.env.DEBUG_CLAUDE_AGENT_SDK ?? '1') : undefined,
  };

  // Issue #3706: Inject model alias overrides for SDK team agent resolution.
  // When Agent Teams spawns workers with `model: opus`, the SDK resolves the
  // alias via ANTHROPIC_DEFAULT_OPUS_MODEL env var. Without these overrides,
  // the SDK may use a model from ~/.claude/settings.json that doesn't support
  // tool_use (e.g., GLM glm-5.1). By injecting the disclaude tier config here,
  // team agents correctly resolve to the provider's tier model.
  if (modelAliases?.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelAliases.opus;
  }
  if (modelAliases?.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelAliases.sonnet;
  }
  if (modelAliases?.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelAliases.haiku;
  }

  // CRITICAL: Remove CLAUDECODE to allow SDK subprocess to run inside
  // another Claude Code session. Without this, SDK will fail with:
  // "Claude Code cannot be launched inside another Claude Code session"
  // Must use delete to completely remove the key, not just set to undefined.
  delete env.CLAUDECODE;

  // Set base URL if provided (for GLM or custom endpoints)
  if (apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = apiBaseUrl;
  }

  // Issue #2992: Set HTTP timeout for SDK→API connections.
  // Prevents infinite hang when the TCP connection to the API proxy (e.g., LiteLLM)
  // stalls without closing. The default 5-minute timeout ensures that hung connections
  // are aborted rather than blocking the session indefinitely.
  // Users can override via ANTHROPIC_TIMEOUT env var (process.env takes precedence).
  // Set to 0 to disable.
  const effectiveTimeoutMs = sdkTimeoutMs ?? 300_000;
  if (effectiveTimeoutMs > 0 && !env.ANTHROPIC_TIMEOUT) {
    env.ANTHROPIC_TIMEOUT = String(effectiveTimeoutMs);
  }

  return env;
}
