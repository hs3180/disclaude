/**
 * Auth Header Proxy for third-party API compatibility (Issue #2916)
 *
 * Intercepts API requests from Claude Agent SDK (CLI subprocess) and converts
 * the authentication header from `Authorization: Bearer xxx` to `x-api-key: xxx`.
 *
 * Background:
 * - Claude Code CLI (>= 2.1.104) sends the API key via `Authorization: Bearer`
 *   header when connecting to API endpoints.
 * - Third-party Claude-compatible endpoints (e.g., GLM/智谱) expect the
 *   `x-api-key` header for authentication, as per the Anthropic API spec.
 * - GLM returns 401 "令牌已过期或验证不正确" when receiving `Authorization: Bearer`.
 * - Direct curl with `x-api-key` header works correctly with the same API key.
 *
 * Architecture:
 *   CLI subprocess → local proxy (transform auth header) → actual API (GLM)
 *                        ↓
 *              Authorization: Bearer xxx → x-api-key: xxx
 *              remove x-anthropic-billing-header
 *              forward everything else as-is
 *
 * Lifecycle:
 * 1. Proxy starts lazily on first query with a non-Anthropic endpoint
 * 2. ANTHROPIC_BASE_URL is set to the proxy URL in SDK options
 * 3. CLI sends requests to the proxy
 * 4. Proxy transforms auth header and forwards to the original endpoint
 * 5. Proxy is cleaned up via stopAllAuthProxies()
 *
 * @module third-party-auth-proxy
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('AuthHeaderProxy');

// ============================================================================
// Types
// ============================================================================

/** Proxy configuration */
export interface AuthHeaderProxyOptions {
  /** The original API base URL to forward requests to */
  targetBaseUrl: string;
  /** Port to listen on (0 = random available port) */
  port?: number;
}

// ============================================================================
// Utility: Check if URL is a third-party (non-Anthropic) endpoint
// ============================================================================

/**
 * Check if an API base URL points to a non-Anthropic endpoint.
 *
 * Returns true for URLs that are NOT api.anthropic.com or console.anthropic.com,
 * indicating they need the auth header proxy.
 *
 * @param apiBaseUrl - The API base URL to check
 * @returns true if the URL is a third-party endpoint
 */
export function isThirdPartyEndpoint(apiBaseUrl: string): boolean {
  if (!apiBaseUrl) {
    return false;
  }

  try {
    const url = new URL(apiBaseUrl);
    const hostname = url.hostname.toLowerCase();

    // Anthropic official endpoints — no proxy needed
    const anthropicHosts = [
      'api.anthropic.com',
      'console.anthropic.com',
    ];

    return !anthropicHosts.some(
      host => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    // Invalid URL, treat as third-party
    return true;
  }
}

// ============================================================================
// Header transformation
// ============================================================================

/**
 * Headers that should be removed when proxying to third-party endpoints.
 *
 * These headers are specific to the official Anthropic API and may cause
 * issues with third-party implementations.
 */
const HEADERS_TO_REMOVE = [
  'x-anthropic-billing-header',
];

/**
 * Transform request headers for third-party API compatibility.
 *
 * - Converts `Authorization: Bearer xxx` → `x-api-key: xxx`
 * - Removes Anthropic-specific headers that third-party APIs don't understand
 * - Preserves all other headers
 *
 * @param headers - Original request headers
 * @returns Transformed headers
 */
export function transformAuthHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Skip hop-by-hop headers
    if (lowerKey === 'host' || lowerKey === 'connection') {
      continue;
    }

    // Skip Anthropic-specific headers that third-party APIs don't understand
    if (HEADERS_TO_REMOVE.some(h => lowerKey === h)) {
      continue;
    }

    // Transform Authorization: Bearer xxx → x-api-key: xxx
    if (lowerKey === 'authorization' && typeof value === 'string') {
      const bearerMatch = value.match(/^Bearer\s+(.+)$/i);
      if (bearerMatch) {
        const [, apiKey] = bearerMatch;
        result['x-api-key'] = apiKey;
        logger.debug(
          { originalHeader: 'Authorization: Bearer ***', transformedHeader: 'x-api-key: ***' },
          'Transformed auth header'
        );
        continue;
      }
    }

    result[key] = value;
  }

  return result;
}

// ============================================================================
// Proxy Server
// ============================================================================

/**
 * Auth Header Proxy for third-party API compatibility.
 *
 * Starts a local HTTP server that intercepts API requests from the CLI,
 * transforms the authentication header, and forwards to the actual
 * third-party API endpoint.
 */
export class AuthHeaderProxy {
  private server: http.Server | null = null;
  private targetUrl: URL;
  private targetPort: number;
  private targetProtocol: typeof http | typeof https;
  private localPort = 0;

  constructor(private readonly options: AuthHeaderProxyOptions) {
    this.targetUrl = new URL(options.targetBaseUrl);
    this.targetPort = this.targetUrl.port
      ? parseInt(this.targetUrl.port, 10)
      : (this.targetUrl.protocol === 'https:' ? 443 : 80);
    this.targetProtocol = this.targetUrl.protocol === 'https:' ? https : http;
  }

  /**
   * Start the proxy server.
   * @returns The proxy URL (e.g., http://127.0.0.1:12345)
   */
  start(): Promise<string> {
    if (this.server) {
      throw new Error('Proxy already started');
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          logger.error({ err: error, url: req.url }, 'Proxy request handler error');
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'Proxy error', message: String(error) }));
        });
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.options.port} is already in use`));
        } else {
          reject(error);
        }
      });

      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.localPort = addr.port;
        }
        const proxyUrl = `http://127.0.0.1:${this.localPort}`;
        logger.info(
          { proxyUrl, targetBaseUrl: this.options.targetBaseUrl },
          'Auth header proxy started'
        );
        resolve(proxyUrl);
      });
    });
  }

  /**
   * Stop the proxy server.
   */
  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    const { server } = this;
    return new Promise((resolve) => {
      server.close(() => {
        logger.info('Auth header proxy stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Get the proxy URL (only valid after start()).
   */
  getProxyUrl(): string {
    return `http://127.0.0.1:${this.localPort}`;
  }

  /**
   * Handle an incoming HTTP request from the CLI.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Read request body
    const body = await this.readBody(req);

    // Transform auth headers
    const targetHeaders = transformAuthHeaders(req.headers);

    // Set correct host for target
    targetHeaders.host = this.targetUrl.host;

    const targetPath = req.url || '/';

    const proxyReqOptions: https.RequestOptions = {
      hostname: this.targetUrl.hostname,
      port: this.targetPort,
      path: targetPath,
      method: req.method,
      headers: targetHeaders,
    };

    logger.debug(
      { method: req.method, path: targetPath, hasBody: body.length > 0 },
      'Forwarding request to target'
    );

    // Forward the request
    return new Promise((resolve, reject) => {
      const proxyReq = this.targetProtocol.request(proxyReqOptions, (proxyRes) => {
        // Forward response headers
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

        // Pipe response (handles both streaming SSE and regular responses)
        proxyRes.pipe(res);

        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      });

      proxyReq.on('error', (error) => {
        logger.error({ err: error, url: targetPath }, 'Proxy forwarding error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream error', message: error.message }));
        }
        resolve();
      });

      // Send the body
      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }

  /**
   * Read the full body of an incoming HTTP request.
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
