/**
 * GLM Auth Proxy — lightweight HTTP reverse proxy for GLM API authentication.
 *
 * Problem (Issue #2916):
 *   Claude Code CLI sends API key via `Authorization: Bearer {key}` header,
 *   but GLM's Anthropic-compatible API expects `x-api-key: {key}` header.
 *   This causes 401 authentication failures for all GLM requests.
 *
 * Solution:
 *   A local HTTP reverse proxy that transparently transforms the auth header
 *   before forwarding requests to the real GLM endpoint.
 *
 * Architecture:
 *   SDK subprocess
 *     → ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *       → GLM Auth Proxy
 *           ├── auth: Authorization: Bearer {key} → x-api-key: {key}
 *         → https://open.bigmodel.cn/api/anthropic
 *
 * Lifecycle:
 *   - Process-level singleton: shared across all agents
 *   - Started at service startup when GLM provider is configured
 *   - Stopped during graceful shutdown
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('GlmAuthProxy');

/**
 * GLM Auth Proxy instance.
 *
 * Wraps an HTTP server that listens on a random local port and transforms
 * `Authorization: Bearer` headers to `x-api-key` before forwarding to the
 * real GLM API endpoint.
 */
export class GlmAuthProxy {
  private server: Server | null = null;
  private port: number = 0;
  private readonly targetUrl: string;
  private running = false;

  /**
   * @param targetUrl - The real GLM API base URL to forward requests to
   *                    (e.g., 'https://open.bigmodel.cn/api/anthropic')
   */
  constructor(targetUrl: string) {
    this.targetUrl = targetUrl;
  }

  /**
   * Start the proxy server on a random available port.
   *
   * @returns The local proxy URL (e.g., 'http://127.0.0.1:12345')
   */
  start(): Promise<string> {
    if (this.running) {
      return Promise.resolve(this.getProxyUrl());
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error({ err, url: req.url }, 'Proxy request handler error');
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'Proxy error' }));
        });
      });

      // Listen on a random port (port 0 = OS assigns)
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.port = addr.port;
          this.running = true;
          logger.info(
            { port: this.port, target: this.targetUrl },
            'GLM Auth Proxy started'
          );
          resolve(this.getProxyUrl());
        } else {
          reject(new Error('Failed to get proxy port'));
        }
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'GLM Auth Proxy server error');
        reject(err);
      });
    });
  }

  /**
   * Stop the proxy server.
   */
  stop(): Promise<void> {
    if (!this.running || !this.server) {
      return Promise.resolve();
    }

    const {server} = this;
    return new Promise((resolve) => {
      server.close(() => {
        this.running = false;
        this.server = null;
        logger.info('GLM Auth Proxy stopped');
        resolve();
      });
    });
  }

  /**
   * Get the local proxy URL.
   *
   * @returns The proxy URL (e.g., 'http://127.0.0.1:12345')
   * @throws Error if proxy is not running
   */
  getProxyUrl(): string {
    if (!this.running) {
      throw new Error('GLM Auth Proxy is not running');
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Check if the proxy is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle an incoming HTTP request by transforming headers and forwarding.
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Read the full request body
    const body = await this.readBody(req);

    // Build the target URL
    const targetUrl = new URL(req.url || '/', this.targetUrl);

    // Transform headers: Authorization: Bearer → x-api-key
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'authorization') {
        // Extract the Bearer token and set as x-api-key
        const authValue = Array.isArray(value) ? value[0] : value;
        if (authValue?.startsWith('Bearer ')) {
          const apiKey = authValue.slice(7);
          headers['x-api-key'] = apiKey;
          logger.debug('Transformed Authorization: Bearer → x-api-key');
          continue;
        }
        // If not Bearer, keep as-is (shouldn't happen but be safe)
        headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
        continue;
      }

      // Skip host header (will be set to target)
      if (key.toLowerCase() === 'host') {
        continue;
      }

      // Forward all other headers as-is
      if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      } else if (value !== undefined) {
        headers[key] = value;
      }
    }

    // Set the correct host for the target
    headers['host'] = targetUrl.host;

    // Log the request (without exposing API key)
    const safeHeaders = { ...headers };
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = `${safeHeaders['x-api-key'].slice(0, 8)}...`;
    }
    logger.debug(
      {
        method: req.method,
        url: req.url,
        targetUrl: targetUrl.toString(),
        headers: safeHeaders,
        bodyLength: body.length,
      },
      'Forwarding request to GLM API'
    );

    // Forward the request to the target
    await this.forwardRequest(req.method || 'POST', targetUrl, headers, body, res);
  }

  /**
   * Forward a request to the target URL and pipe the response back.
   * Supports both HTTP and HTTPS targets based on the URL scheme.
   */
  private forwardRequest(
    method: string,
    targetUrl: URL,
    headers: Record<string, string>,
    body: Buffer,
    clientRes: ServerResponse
  ): Promise<void> {
    const isHttps = targetUrl.protocol === 'https:';
    const defaultPort = isHttps ? 443 : 80;
    const requestFn = isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const proxyReq = requestFn(
        {
          method,
          hostname: targetUrl.hostname,
          port: targetUrl.port || defaultPort,
          path: targetUrl.pathname + targetUrl.search,
          headers,
        },
        (proxyRes) => {
          // Forward the response status and headers
          clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);

          // Pipe the response body
          proxyRes.pipe(clientRes);
          proxyRes.on('error', (err) => {
            logger.error({ err }, 'Error reading upstream response');
            reject(err);
          });
          proxyRes.on('end', () => {
            resolve();
          });
        }
      );

      proxyReq.on('error', (err) => {
        logger.error({ err, targetUrl: targetUrl.toString() }, 'Forward request error');
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: 'Upstream connection failed' }));
        }
        reject(err);
      });

      // Send the request body
      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }

  /**
   * Read the entire request body into a Buffer.
   */
  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}

// ============================================================================
// Singleton management
// ============================================================================

let proxyInstance: GlmAuthProxy | null = null;

/**
 * Get or create the GLM Auth Proxy singleton.
 *
 * The proxy is a process-level singleton shared across all agents.
 * It starts automatically when first called and stays running until
 * the process exits.
 *
 * @param targetUrl - The real GLM API base URL (only used on first call)
 * @returns The proxy instance
 */
export function getGlmAuthProxy(targetUrl: string): GlmAuthProxy {
  if (!proxyInstance) {
    proxyInstance = new GlmAuthProxy(targetUrl);
  }
  return proxyInstance;
}

/**
 * Start the GLM Auth Proxy singleton if not already running.
 *
 * @param targetUrl - The real GLM API base URL to forward to
 * @returns The local proxy URL
 */
export function startGlmAuthProxy(targetUrl: string): Promise<string> {
  const proxy = getGlmAuthProxy(targetUrl);
  if (!proxy.isRunning()) {
    return proxy.start();
  }
  return Promise.resolve(proxy.getProxyUrl());
}

/**
 * Stop the GLM Auth Proxy singleton.
 */
export async function stopGlmAuthProxy(): Promise<void> {
  if (proxyInstance) {
    await proxyInstance.stop();
    proxyInstance = null;
  }
}
