/**
 * GLM Auth Adapter — transforms Authorization: Bearer → x-api-key
 *
 * Claude Code CLI sends API keys via `Authorization: Bearer {key}` header,
 * but GLM's Anthropic-compatible API only accepts `x-api-key: {key}`.
 * This adapter intercepts requests on a local port and transforms the auth
 * header before forwarding to the real GLM endpoint.
 *
 * Issue #2916: Claude Code CLI 2.1.104 与 GLM API 认证失败 (401)
 *
 * ## Architecture
 *
 * ```
 * SDK subprocess
 *   → ANTHROPIC_BASE_URL=http://127.0.0.1:{port}
 *     → GLM Auth Adapter
 *         ├── Authorization: Bearer {key} → x-api-key: {key}
 *         ├── Remove x-anthropic-billing-header (GLM rejects it)
 *       → https://open.bigmodel.cn/api/anthropic
 * ```
 *
 * ## Lifecycle
 *
 * - Singleton per process: `start()` is idempotent
 * - Auto-started by `buildSdkEnv()` when GLM provider is detected
 * - Stopped via `stop()` during service shutdown
 *
 * ## Future migration
 *
 * This adapter can be replaced by LiteLLM proxy for a more comprehensive
 * API gateway solution. See PR #3100 closing comment.
 *
 * @module sdk/glm-auth-adapter
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GlmAuthAdapter');

/**
 * State for the singleton adapter instance.
 */
let adapterServer: Server | null = null;
let adapterPort: number | null = null;
let upstreamUrl: string | null = null;

/**
 * Start the GLM auth adapter.
 *
 * Creates a lightweight HTTP server that transforms auth headers
 * before forwarding to the real GLM endpoint.
 *
 * Idempotent: returns existing port if already running.
 *
 * @param targetUrl - The real GLM API base URL (e.g., https://open.bigmodel.cn/api/anthropic)
 * @returns The local adapter URL to use as ANTHROPIC_BASE_URL
 */
export async function start(targetUrl: string): Promise<string> {
  // Return existing adapter URL if already running with same target
  if (adapterServer && adapterPort && upstreamUrl === targetUrl) {
    return `http://127.0.0.1:${adapterPort}`;
  }

  // Stop previous instance if target changed
  if (adapterServer) {
    await stop();
  }

  upstreamUrl = targetUrl;

  const server = createServer(handleRequest);
  adapterServer = server;

  // Listen on a random available port
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to get adapter port');
  }

  adapterPort = addr.port;
  const adapterUrl = `http://127.0.0.1:${adapterPort}`;

  logger.info({ adapterUrl, targetUrl }, 'GLM auth adapter started');

  return adapterUrl;
}

/**
 * Stop the GLM auth adapter.
 *
 * Idempotent: safe to call multiple times.
 */
export async function stop(): Promise<void> {
  if (!adapterServer) {
    return;
  }

  const server = adapterServer;
  adapterServer = null;
  adapterPort = null;
  upstreamUrl = null;

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  logger.info('GLM auth adapter stopped');
}

/**
 * Check if the adapter is currently running.
 */
export function isRunning(): boolean {
  return adapterServer !== null && adapterPort !== null;
}

/**
 * Get the current adapter URL (or null if not running).
 */
export function getAdapterUrl(): string | null {
  if (!adapterPort) {
    return null;
  }
  return `http://127.0.0.1:${adapterPort}`;
}

/**
 * Handle an incoming request by transforming auth headers and forwarding.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const target = upstreamUrl;
  if (!target) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GLM auth adapter: no upstream URL configured' }));
    return;
  }

  // Collect request body
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // Build forwarded URL
    const targetUrl = new URL(req.url || '/', target);
    const targetPath = targetUrl.pathname + targetUrl.search;

    // Transform headers for GLM compatibility
    const forwardedHeaders = transformHeaders(req.headers);

    // Determine protocol module
    const useHttps = targetUrl.protocol === 'https:';
    const httpModule = useHttps ? require('https') : require('http');

    // Build proxy request options
    const proxyOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (useHttps ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers: {
        ...forwardedHeaders,
        host: targetUrl.host,
      },
    };

    logger.debug({
      method: req.method,
      path: targetPath,
      hasAuthHeader: 'authorization' in req.headers,
      hasXApiKey: 'x-api-key' in forwardedHeaders,
    }, 'Forwarding request to GLM');

    // Forward the request
    const proxyReq = httpModule.request(proxyOptions, (proxyRes: IncomingMessage) => {
      // Forward response status and headers
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);

      // Pipe response body
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err: Error) => {
      logger.error({ err }, 'Proxy request error');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `GLM auth adapter: ${err.message}` }));
      }
    });

    // Send request body
    proxyReq.end(body);
  });

  req.on('error', (err: Error) => {
    logger.error({ err }, 'Request error');
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `GLM auth adapter: ${err.message}` }));
    }
  });
}

/**
 * Headers that should be stripped when forwarding to GLM.
 * These headers are either invalid or rejected by GLM's API.
 */
const HEADER_BLACKLIST = new Set([
  'host',
  'connection',
  'x-anthropic-billing-header', // GLM rejects this header
]);

/**
 * Transform HTTP headers for GLM API compatibility.
 *
 * Key transformations:
 * - `Authorization: Bearer {key}` → `x-api-key: {key}`
 * - Strips `x-anthropic-billing-header` (GLM rejects it)
 * - Preserves all other headers
 *
 * Exported for unit testing.
 *
 * @param headers - Original request headers (from IncomingMessage)
 * @returns Transformed headers safe for GLM API
 */
export function transformHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Skip blacklisted headers
    if (HEADER_BLACKLIST.has(lowerKey)) {
      continue;
    }

    // Transform Authorization: Bearer → x-api-key
    if (lowerKey === 'authorization' && typeof value === 'string') {
      const apiKey = value.startsWith('Bearer ')
        ? value.slice(7)
        : value;
      result['x-api-key'] = apiKey;
      continue;
    }

    // Pass through string headers
    if (typeof value === 'string') {
      result[key] = value;
    }
    // Skip array headers (not relevant for proxy forwarding)
  }

  return result;
}

// ============================================================================
// Test helpers (only used in tests)
// ============================================================================

/**
 * Reset all internal state. For testing only.
 * @internal
 */
export function _reset(): void {
  adapterServer = null;
  adapterPort = null;
  upstreamUrl = null;
}

/**
 * Get the internal state for testing.
 * @internal
 */
export function _getState(): { port: number | null; upstreamUrl: string | null } {
  return { port: adapterPort, upstreamUrl };
}
