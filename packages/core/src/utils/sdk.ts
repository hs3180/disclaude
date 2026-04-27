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
 * @param customHeaders - Optional custom HTTP headers for API requests.
 *   Serialized as JSON and set to ANTHROPIC_CUSTOM_HEADERS.
 *   When explicitly set (even to empty object), overrides any existing
 *   ANTHROPIC_CUSTOM_HEADERS from process.env to prevent proxy-specific
 *   headers from leaking between providers.
 * @see Issue #2768
 * @returns Environment object for SDK options
 */
export function buildSdkEnv(
  apiKey: string,
  apiBaseUrl?: string,
  extraEnv?: Record<string, string | undefined>,
  sdkDebug: boolean = true,
  customHeaders?: Record<string, string> | null
): Record<string, string | undefined> {
  const nodeBinDir = getNodeBinDir();

  // Ensure PATH includes node bin dir at the front
  // SDK subprocess needs to find 'node' command
  const originalPath = process.env.PATH || '';
  const newPath = originalPath.includes(nodeBinDir)
    ? originalPath
    : `${nodeBinDir}:${originalPath}`;

  // Priority (highest to lowest):
  // 1. Our forced values (API_KEY, PATH, BASE_URL, DEBUG, CUSTOM_HEADERS)
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

  // Set base URL if provided (for GLM or custom endpoints)
  if (apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = apiBaseUrl;
  }

  // Handle custom headers for Anthropic-compatible API providers.
  // When customHeaders is explicitly configured (non-null), it overrides
  // any process.env ANTHROPIC_CUSTOM_HEADERS to prevent proxy-specific
  // headers from leaking. When null, existing env var is preserved.
  // @see Issue #2768
  if (customHeaders !== undefined && customHeaders !== null) {
    if (Object.keys(customHeaders).length > 0) {
      env.ANTHROPIC_CUSTOM_HEADERS = JSON.stringify(customHeaders);
    } else {
      // Explicitly clear to prevent stale proxy headers
      delete env.ANTHROPIC_CUSTOM_HEADERS;
    }
  }

  return env;
}
