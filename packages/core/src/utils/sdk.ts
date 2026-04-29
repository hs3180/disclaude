/**
 * Shared utilities for Agent SDK integration.
 */

import type {
  AgentMessage,
  ContentBlock,
} from '../types/agent.js';
import { GLMProxyManager } from '../sdk/glm-proxy.js';
import { createLogger } from './logger.js';

const sdkLogger = createLogger('sdk-utils');

// ---------------------------------------------------------------------------
// GLM Proxy singleton state (Issue #2948)
// ---------------------------------------------------------------------------

/**
 * Cached GLM proxy URL.
 * Once the proxy is started, this stores the local proxy URL (e.g. http://127.0.0.1:49152).
 * All subsequent `buildSdkEnv()` calls will use this URL instead of the raw GLM endpoint.
 */
let glmProxyUrl: string | null = null;

/**
 * Whether GLM proxy initialization is in progress (prevents double-start).
 */
let glmProxyInitializing = false;

/**
 * Initialize the GLM API proxy for a non-Anthropic endpoint.
 *
 * Call this once during application startup when the provider is GLM.
 * The proxy intercepts SDK subprocess requests, extracts tool definitions
 * from the system prompt XML, and converts them to the `tools` API parameter.
 *
 * @param targetBaseUrl - The actual GLM API base URL to forward to
 * @returns The proxy URL (e.g. http://127.0.0.1:49152)
 *
 * @see Issue #2948 - GLM endpoint tool compatibility
 */
export async function initGLMProxy(targetBaseUrl: string): Promise<string> {
  if (glmProxyUrl) {return glmProxyUrl;}
  if (glmProxyInitializing) {
    // Wait for the other in-flight init to complete
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (glmProxyUrl) {
          clearInterval(interval);
          resolve(glmProxyUrl);
        }
      }, 50);
    });
  }

  glmProxyInitializing = true;
  try {
    const proxy = GLMProxyManager.getInstance({ targetBaseUrl });
    glmProxyUrl = await proxy.start();
    sdkLogger.info({ proxyUrl: glmProxyUrl, target: targetBaseUrl }, 'GLM proxy initialized');
    return glmProxyUrl;
  } finally {
    glmProxyInitializing = false;
  }
}

/**
 * Get the cached GLM proxy URL (if initialized).
 *
 * @returns The proxy URL or null if not initialized
 */
export function getGLMProxyUrl(): string | null {
  return glmProxyUrl;
}

/**
 * Stop the GLM proxy (for graceful shutdown).
 */
export async function stopGLMProxy(): Promise<void> {
  if (glmProxyUrl) {
    const proxy = GLMProxyManager.getInstance({ targetBaseUrl: '' });
    await proxy.stop();
    glmProxyUrl = null;
    GLMProxyManager.resetInstance();
    sdkLogger.info('GLM proxy stopped');
  }
}

/**
 * Reset GLM proxy state (for testing only).
 */
export function resetGLMProxyState(): void {
  glmProxyUrl = null;
  glmProxyInitializing = false;
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
 * @returns Environment object for SDK options
 */
export function buildSdkEnv(
  apiKey: string,
  apiBaseUrl?: string,
  extraEnv?: Record<string, string | undefined>,
  sdkDebug: boolean = true
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

  // Set base URL if provided (for GLM or custom endpoints)
  // Issue #2948: Use GLM proxy URL when available to transform tool definitions
  if (apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = glmProxyUrl ?? apiBaseUrl;
  }

  return env;
}
