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
 * @param apiBaseUrl - Optional base URL for API requests (for a compatible endpoint)
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
  sdkTimeoutMs?: number,
  selected?: {
    protocol?: import('../config/types.js').ApiProtocol;
    selectedEnv?: Record<string, string>;
    credentialEnvKeys?: string[];
  },
): Record<string, string | undefined> {
  const nodeBinDir = getNodeBinDir();

  // Ensure PATH includes node bin dir at the front
  // SDK subprocess needs to find 'node' command
  const originalPath = process.env.PATH || '';
  const newPath = originalPath.includes(nodeBinDir)
    ? originalPath
    : `${nodeBinDir}:${originalPath}`;

  // Host environment overrides global defaults. Bound LLM settings and the
  // selected API credential are applied below, after these shared values.
  const env: Record<string, string | undefined> = {
    ...extraEnv,
    ...(process.env as Record<string, string | undefined>),
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

  // A named LLM supplies native settings and only its own credential. Remove
  // all configured credential references before projecting the selected key.
  for (const key of selected?.credentialEnvKeys ?? []) { env[key] = undefined; }
  Object.assign(env, selected?.selectedEnv);
  const protocol = selected ? selected.protocol : 'anthropic';
  const apiVariables = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'];
  if (selected || apiKey) {
    for (const key of apiVariables) {
      // A native account binding may explicitly select its own auth/endpoint.
      // Protocol bindings below always take credentials from their API block.
      if (selected && !protocol && Object.hasOwn(selected.selectedEnv ?? {}, key)) {continue;}
      // Explicit undefined also masks credentials in adapters that merge env.
      if (selected) { env[key] = undefined; } else { delete env[key]; }
    }
  }
  if (protocol) {
    const keyName = protocol === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    const urlName = protocol === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL';
    env[keyName] = apiKey;
    if (apiBaseUrl) { env[urlName] = apiBaseUrl; }
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
