/**
 * GLM Auth Proxy — lightweight local HTTP reverse proxy that translates
 * `Authorization: Bearer <key>` to `x-api-key: <key>`.
 *
 * Claude Code CLI ≥ 2.1.104 sends API keys via the `Authorization: Bearer`
 * header rather than `x-api-key`.  GLM's Anthropic-compatible endpoint
 * (`https://open.bigmodel.cn/api/anthropic`) only accepts `x-api-key`,
 * causing every request to fail with HTTP 401.
 *
 * This proxy is started lazily (once per process) when the provider is GLM
 * and sits between the CLI subprocess and the real GLM endpoint.
 *
 * Flow:
 * ```
 * Claude Code CLI
 *   → ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *     → GLM Auth Proxy  (Authorization → x-api-key)
 *       → https://open.bigmodel.cn/api/anthropic
 * ```
 *
 * @module utils/glm-auth-proxy
 * @see Issue #2916
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('GlmAuthProxy');

/**
 * Headers that should NOT be forwarded to the upstream server.
 * Hop-by-hop headers and proxy-specific headers are removed per RFC 2616 §13.5.1.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Lightweight HTTP reverse proxy that translates `Authorization: Bearer` to `x-api-key`.
 *
 * Designed as a process-level singleton — call `startGlmProxy()` to obtain the
 * shared instance. The proxy listens on a random ephemeral port bound to `127.0.0.1`.
 */
export class GlmAuthProxy {
  private server: http.Server | null = null;
  private readonly targetUrl: URL;
  private port = 0;

  constructor(targetBaseUrl: string) {
    this.targetUrl = new URL(targetBaseUrl);
  }

  /**
   * Start the proxy server on a random ephemeral port.
   * Safe to call multiple times — subsequent calls return the existing port.
   *
   * @returns The port the proxy is listening on
   */
  start(): Promise<number> {
    if (this.server) {
      return Promise.resolve(this.port);
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        this.server = server;
        logger.info(
          { port: this.port, target: this.targetUrl.origin },
          'GLM auth proxy started',
        );
        resolve(this.port);
      });

      server.on('error', (err) => {
        logger.error({ err }, 'GLM auth proxy server error');
        reject(err);
      });
    });
  }

  /**
   * Stop the proxy server.
   */
  stop(): Promise<void> {
    const {server} = this;
    if (!server) {return Promise.resolve();}

    return new Promise((resolve) => {
      server.close(() => {
        logger.info({ port: this.port }, 'GLM auth proxy stopped');
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }

  /**
   * Get the proxy URL that should be used as `ANTHROPIC_BASE_URL`.
   * Must call `start()` first.
   */
  getProxyUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Get the port the proxy is listening on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Handle an incoming HTTP request by forwarding it to the target with
   * translated authentication headers.
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      this.forwardRequest(req, Buffer.concat(chunks), res);
    });

    req.on('error', (err) => {
      logger.error({ err, url: req.url }, 'Request body read error');
      if (!res.headersSent) {
        res.writeHead(400);
      }
      res.end('Bad Request');
    });
  }

  /**
   * Forward the request to the target, translating auth headers.
   */
  private forwardRequest(
    req: http.IncomingMessage,
    body: Buffer,
    res: http.ServerResponse,
  ): void {
    // Build outgoing headers with auth translation
    const outgoingHeaders: Record<string, string | string[] | undefined> = {};

    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();

      // Translate Authorization: Bearer → x-api-key
      if (lowerKey === 'authorization') {
        const authValue = Array.isArray(value) ? value[0] : value;
        if (authValue?.startsWith('Bearer ')) {
          outgoingHeaders['x-api-key'] = authValue.substring(7);
          logger.debug('Translated Authorization: Bearer → x-api-key');
        } else if (authValue) {
          // Non-Bearer auth — keep x-api-key as-is if already present
          // or pass through for other auth schemes
          outgoingHeaders['x-api-key'] = authValue;
        }
        // Never forward the Authorization header to GLM
        continue;
      }

      // Skip hop-by-hop headers
      if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
        continue;
      }

      // Skip host header (will be set for the target)
      if (lowerKey === 'host') {
        continue;
      }

      if (value !== undefined) {
        outgoingHeaders[key] = value;
      }
    }

    // Ensure x-api-key is set even if no Authorization header was present
    // but ANTHROPIC_API_KEY was in the request headers (belt-and-suspenders)
    if (!outgoingHeaders['x-api-key'] && req.headers['anthropic-api-key']) {
      outgoingHeaders['x-api-key'] = req.headers['anthropic-api-key'] as string;
    }

    // Construct target path: prepend the base URL path prefix
    const basePath = this.targetUrl.pathname.replace(/\/$/, '');
    const targetPath = basePath + (req.url || '/');

    const options: https.RequestOptions = {
      hostname: this.targetUrl.hostname,
      port: this.targetUrl.port || (this.targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers: {
        ...outgoingHeaders,
        host: this.targetUrl.host,
      },
    };

    const httpModule = this.targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = httpModule.request(options, (proxyRes) => {
      // Forward response status
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      logger.error({ err, path: targetPath }, 'Upstream request error');
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end('Bad Gateway');
    });

    proxyReq.write(body);
    proxyReq.end();
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let proxyInstance: GlmAuthProxy | null = null;
let proxyStartPromise: Promise<GlmAuthProxy> | null = null;

/**
 * Get or create the GLM auth proxy singleton.
 *
 * On first call this starts the proxy server; subsequent calls return the
 * existing instance.  The proxy URL replaces `ANTHROPIC_BASE_URL` so the CLI
 * sends requests to the local proxy instead of directly to GLM.
 *
 * @param targetBaseUrl - The real GLM API base URL (e.g. `https://open.bigmodel.cn/api/anthropic`)
 * @returns The running proxy instance
 */
export async function startGlmProxy(targetBaseUrl: string): Promise<GlmAuthProxy> {
  // If already started, return existing instance
  if (proxyInstance && proxyInstance.getPort() > 0) {
    return proxyInstance;
  }

  // If a start is already in progress, wait for it
  if (proxyStartPromise) {
    return proxyStartPromise;
  }

  proxyStartPromise = (async () => {
    const proxy = new GlmAuthProxy(targetBaseUrl);
    await proxy.start();
    proxyInstance = proxy;
    return proxy;
  })();

  try {
    return await proxyStartPromise;
  } finally {
    proxyStartPromise = null;
  }
}

/**
 * Stop and destroy the singleton proxy instance (for graceful shutdown).
 */
export async function stopGlmProxy(): Promise<void> {
  if (proxyInstance) {
    await proxyInstance.stop();
    proxyInstance = null;
  }
}

/**
 * Get the current proxy instance without starting it.
 * Returns `null` if the proxy has not been started.
 */
export function getGlmProxy(): GlmAuthProxy | null {
  return proxyInstance;
}

/**
 * Get the proxy URL if the proxy is running, otherwise `undefined`.
 *
 * This is used by `buildSdkEnv()` to transparently route SDK requests
 * through the proxy when GLM is configured.
 */
export function getGlmProxyUrl(): string | undefined {
  if (proxyInstance && proxyInstance.getPort() > 0) {
    return proxyInstance.getProxyUrl();
  }
  return undefined;
}
