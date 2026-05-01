/**
 * Shared utilities for Agent SDK integration.
 */

import type {
  AgentMessage,
  ContentBlock,
} from '../types/agent.js';

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
 * @returns Environment object for SDK options
 */
export function buildSdkEnv(
  apiKey: string,
  apiBaseUrl?: string,
  extraEnv?: Record<string, string | undefined>,
  sdkDebug: boolean = true,
  sdkTimeoutMs?: number
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

  // CRITICAL: Remove CLAUDECODE to allow SDK subprocess to run inside
  // another Claude Code session. Without this, SDK will fail with:
  // "Claude Code cannot be launched inside another Claude Code session"
  // Must use delete to completely remove the key, not just set to undefined.
  delete env.CLAUDECODE;

  // Issue #2916: Remove OAuth/auth-token env vars that conflict with
  // API key authentication. When using third-party Anthropic-compatible
  // APIs (GLM, etc.), the CLI reads these env vars and sends
  // "Authorization: Bearer <token>" headers that override or conflict
  // with the "X-Api-Key" header, causing 401 authentication failures.
  // By stripping these, the CLI only uses ANTHROPIC_API_KEY → X-Api-Key.
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_CLIENT_ID;
  delete env.CLAUDE_CODE_OAUTH_SCOPES;

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
