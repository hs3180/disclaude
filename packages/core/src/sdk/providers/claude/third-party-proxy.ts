/**
 * Third-party API Proxy for Claude-compatible endpoints.
 *
 * Combines two adapter functions for third-party API compatibility:
 *
 * 1. **Auth Header Transformation** (Issue #2916):
 *    Converts `Authorization: Bearer xxx` → `x-api-key: xxx`
 *    for APIs that require the Anthropic-style header.
 *
 * 2. **Tool Extraction & Injection** (Issue #2948):
 *    Extracts tool definitions from the system prompt (XML format)
 *    and injects them as the `tools` API parameter, enabling
 *    third-party endpoints to recognize system tools.
 *
 * Architecture:
 *   CLI subprocess → local proxy → [transform headers + inject tools] → actual API (GLM)
 *
 * @module third-party-proxy
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createLogger } from '../../../utils/logger.js';
import { transformRequestBodyForThirdParty } from './third-party-adapter.js';

const logger = createLogger('ThirdPartyProxy');

// ============================================================================
// Types
// ============================================================================

/** Proxy configuration */
export interface ThirdPartyProxyOptions {
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
 * indicating they need the proxy.
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
 * Third-party API Proxy.
 *
 * Starts a local HTTP server that intercepts API requests from the CLI,
 * transforms authentication headers, extracts and injects tool definitions,
 * and forwards the request to the actual third-party API endpoint.
 */
export class ThirdPartyProxy {
  private server: http.Server | null = null;
  private targetUrl: URL;
  private targetPort: number;
  private targetProtocol: typeof http | typeof https;
  private localPort = 0;

  constructor(private readonly options: ThirdPartyProxyOptions) {
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
          'Third-party API proxy started'
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
        logger.info('Third-party API proxy stopped');
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
    const originalBody = await this.readBody(req);

    // Issue #2948: Transform request body to inject tool definitions
    const transformedBody = this.shouldTransformBody(req)
      ? transformRequestBodyForThirdParty(originalBody)
      : originalBody;

    // Transform auth headers (Issue #2916)
    const targetHeaders = transformAuthHeaders(req.headers);

    // Set correct host for target
    targetHeaders.host = this.targetUrl.host;

    // Update content-length if body was transformed
    if (transformedBody !== originalBody) {
      targetHeaders['content-length'] = String(Buffer.byteLength(transformedBody));
    }

    const targetPath = req.url || '/';

    const proxyReqOptions: https.RequestOptions = {
      hostname: this.targetUrl.hostname,
      port: this.targetPort,
      path: targetPath,
      method: req.method,
      headers: targetHeaders,
    };

    logger.debug(
      {
        method: req.method,
        path: targetPath,
        hasBody: transformedBody.length > 0,
        bodyTransformed: transformedBody !== originalBody,
      },
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

      // Send the (potentially transformed) body
      if (transformedBody.length > 0) {
        proxyReq.write(transformedBody);
      }
      proxyReq.end();
    });
  }

  /**
   * Check if the request body should be transformed (tool injection).
   *
   * Only POST requests to /v1/messages need tool injection.
   */
  private shouldTransformBody(req: http.IncomingMessage): boolean {
    return (
      req.method === 'POST' &&
      Boolean(req.url?.includes('/v1/messages') || req.url?.includes('/messages'))
    );
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
