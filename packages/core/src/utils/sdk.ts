/**
 * Shared utilities for Agent SDK integration.
 *
 * Includes GLM API health check for early authentication failure detection.
 * @see https://github.com/hs3180/disclaude/issues/2916
 */

import { request } from 'https';
import type {
  AgentMessage,
  ContentBlock,
} from '../types/agent.js';
import { createLogger } from './logger.js';

const logger = createLogger('SDKUtils');

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
  if (apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = apiBaseUrl;
  }

  return env;
}

/**
 * Result of GLM API health check.
 */
export interface GlmHealthCheckResult {
  /** Whether the health check passed */
  ok: boolean;
  /** HTTP status code (if a response was received) */
  status?: number;
  /** Error message if the check failed */
  error?: string;
  /** Whether the error appears to be an authentication issue */
  isAuthError: boolean;
}

/**
 * Validate GLM API key by sending a minimal request.
 *
 * This pre-flight check detects authentication issues early (at startup)
 * instead of failing silently during agent execution. It sends a tiny
 * request to the /v1/messages endpoint using the `x-api-key` header
 * (which is what the Anthropic SDK uses internally).
 *
 * @param apiKey - GLM API key to validate
 * @param apiBaseUrl - GLM API base URL (e.g., https://open.bigmodel.cn/api/anthropic)
 * @param model - GLM model name (e.g., glm-5-turbo)
 * @param timeoutMs - Request timeout in milliseconds (default: 10000)
 * @returns Health check result with status and error details
 *
 * @example
 * ```typescript
 * const result = await checkGlmApiHealth('key123', 'https://open.bigmodel.cn/api/anthropic', 'glm-5-turbo');
 * if (!result.ok) {
 *   console.error(`GLM API health check failed: ${result.error}`);
 * }
 * ```
 *
 * @see https://github.com/hs3180/disclaude/issues/2916
 */
export function checkGlmApiHealth(
  apiKey: string,
  apiBaseUrl: string,
  model: string,
  timeoutMs: number = 10000,
): Promise<GlmHealthCheckResult> {
  return new Promise((resolve) => {
    try {
      const url = new URL(`${apiBaseUrl}/v1/messages`);
      const body = JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve({ ok: true, status, isAuthError: false });
            } else if (status === 401 || status === 403) {
              // Authentication/authorization failure
              let errorMsg = '';
              try {
                const parsed = JSON.parse(data);
                errorMsg = parsed.error?.message || parsed.message || data;
              } catch {
                errorMsg = data || `HTTP ${status}`;
              }
              resolve({
                ok: false,
                status,
                error: `Authentication failed (HTTP ${status}): ${errorMsg}`,
                isAuthError: true,
              });
            } else {
              // Other errors (rate limit, server error, etc.)
              // Non-auth errors don't block startup
              resolve({
                ok: true, // Allow startup for transient errors
                status,
                error: `Non-auth error (HTTP ${status}): ${data.slice(0, 200)}`,
                isAuthError: false,
              });
            }
          });
        },
      );

      req.on('error', (err) => {
        resolve({
          ok: false,
          error: `Network error: ${err.message}`,
          isAuthError: false,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          ok: false,
          error: `Request timed out after ${timeoutMs}ms`,
          isAuthError: false,
        });
      });

      req.write(body);
      req.end();
    } catch (err) {
      resolve({
        ok: false,
        error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        isAuthError: false,
      });
    }
  });
}

/**
 * Run GLM API health check and log the result.
 *
 * This is intended to be called at startup to provide early warning
 * about authentication issues. It does NOT throw on failure — it only
 * logs warnings/errors for diagnostic purposes.
 *
 * @param apiKey - GLM API key
 * @param apiBaseUrl - GLM API base URL
 * @param model - GLM model name
 *
 * @see https://github.com/hs3180/disclaude/issues/2916
 */
export async function runGlmStartupCheck(
  apiKey: string,
  apiBaseUrl: string,
  model: string,
): Promise<void> {
  logger.info(
    { apiBaseUrl, model, keyPrefix: `${apiKey.slice(0, 8)  }...` },
    'Running GLM API health check',
  );

  const result = await checkGlmApiHealth(apiKey, apiBaseUrl, model);

  if (result.ok) {
    if (result.error) {
      // Non-auth error (e.g., rate limit) — warn but don't block
      logger.warn({ status: result.status, error: result.error }, 'GLM API health check: non-critical issue');
    } else {
      logger.info({ status: result.status }, 'GLM API health check passed');
    }
  } else if (result.isAuthError) {
    logger.error(
      {
        status: result.status,
        error: result.error,
        hint: 'Verify glm.apiKey and glm.apiBaseUrl in disclaude.config.yaml. ' +
              'GLM API expects x-api-key header — some Claude Code CLI versions may ' +
              'use Authorization: Bearer instead, causing 401 errors. ' +
              'See Issue #2916 for SDK version compatibility details.',
      },
      'GLM API health check FAILED: authentication error',
    );
  } else {
    logger.warn(
      { error: result.error },
      'GLM API health check failed (network/connectivity issue)',
    );
  }
}
