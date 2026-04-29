/**
 * GLM API Proxy - Local proxy for non-Anthropic Claude-compatible endpoints.
 *
 * Problem (Issue #2948):
 *   Claude Agent SDK embeds tool definitions in the system prompt as XML
 *   (`<functions><function>JSON</function></functions>`), not through the
 *   `tools` API parameter.  Anthropic's native API understands both, but
 *   third-party endpoints like GLM (智谱) only recognise the `tools`
 *   parameter, causing all built-in system tools (Bash/Read/Write/...) to be
 *   silently dropped.
 *
 * Solution:
 *   This lightweight HTTP proxy sits between the Claude Agent SDK subprocess
 *   and the real GLM endpoint.  For every `/v1/messages` POST it:
 *     1. Parses the request body.
 *     2. Extracts `<functions>` blocks from the `system` field.
 *     3. Converts each `<function>` JSON definition into an Anthropic
 *        `tools` parameter entry.
 *     4. Strips the XML block from `system`.
 *     5. Forwards the transformed request to the real GLM endpoint.
 *
 * All other requests (streaming SSE responses, non-messages endpoints) are
 * forwarded verbatim.
 *
 * @module sdk/glm-proxy
 */

import http from 'node:http';
import { URL } from 'node:url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GLMProxy');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GLMProxyOptions {
  /** The actual upstream API base URL (e.g. `https://open.bigmodel.cn/api/anthropic`). */
  targetBaseUrl: string;
}

/** Structured tool definition in Anthropic API format. */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Proxy implementation
// ---------------------------------------------------------------------------

/**
 * A singleton-capable local HTTP proxy that transforms tool definitions from
 * the system prompt into the `tools` API parameter for GLM compatibility.
 *
 * Usage:
 * ```ts
 * const proxy = GLMProxyManager.getInstance({ targetBaseUrl: 'https://open.bigmodel.cn/api/anthropic' });
 * const proxyUrl = await proxy.start(); // e.g. 'http://127.0.0.1:49152'
 * // Set ANTHROPIC_BASE_URL = proxyUrl in SDK env
 * // ...
 * await proxy.stop();
 * ```
 */
export class GLMProxyManager {
  private static instance: GLMProxyManager | null = null;

  private server: http.Server | null = null;
  private targetUrl: URL;
  private proxyUrl: string | null = null;

  // ---- Singleton ----------------------------------------------------------

  private constructor(options: GLMProxyOptions) {
    this.targetUrl = new URL(options.targetBaseUrl);
  }

  /**
   * Get or create the singleton proxy instance.
   *
   * If an instance already exists the options are ignored (the existing
   * instance is returned).
   */
  static getInstance(options: GLMProxyOptions): GLMProxyManager {
    if (!GLMProxyManager.instance) {
      GLMProxyManager.instance = new GLMProxyManager(options);
    }
    return GLMProxyManager.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    if (GLMProxyManager.instance) {
      GLMProxyManager.instance.stop().catch(() => {});
    }
    GLMProxyManager.instance = null;
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Start the proxy server on a random port.
   *
   * @returns The proxy URL (e.g. `http://127.0.0.1:49152`)
   */
  start(): Promise<string> {
    if (this.proxyUrl) {return Promise.resolve(this.proxyUrl);}

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        this.proxyUrl = `http://127.0.0.1:${port}`;
        logger.info({ proxyUrl: this.proxyUrl, target: this.targetUrl.href }, 'GLM proxy started');
        resolve(this.proxyUrl);
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'GLM proxy error');
        reject(err);
      });
    });
  }

  /** Stop the proxy server. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('GLM proxy stopped');
          this.server = null;
          this.proxyUrl = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** Whether the proxy is currently running. */
  get isRunning(): boolean {
    return this.server !== null;
  }

  /** Get the proxy URL (only available after `start()`). */
  get url(): string | null {
    return this.proxyUrl;
  }

  // ---- Request handling ---------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);

      // Only transform Messages API POST requests
      if (req.method === 'POST' && req.url?.includes('/messages')) {
        try {
          const parsed = JSON.parse(body);
          const transformed = this.transformRequest(parsed);
          await this.forwardRequest(req, JSON.stringify(transformed), res);
          return;
        } catch (parseErr) {
          logger.warn({ err: parseErr }, 'Failed to parse/transform request, forwarding as-is');
          // Fall through to forward raw body
        }
      }

      // Forward all other requests verbatim
      await this.forwardRequest(req, body, res);
    } catch (err) {
      logger.error({ err }, 'Unhandled proxy error');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: 'Proxy error', type: 'proxy_error' } }));
    }
  }

  // ---- Request transformation ---------------------------------------------

  /**
   * Transform an Anthropic Messages API request body:
   *  - Extract `<functions>` XML blocks from the `system` field
   *  - Convert them to the `tools` API parameter
   *  - Strip the XML from `system`
   */
  transformRequest(body: Record<string, unknown>): Record<string, unknown> {
    const {system} = body;
    if (typeof system !== 'string') {return body;}

    const { tools, cleanSystem } = this.extractToolsFromSystem(system);

    if (tools.length === 0) {return body;}

    logger.debug({ toolCount: tools.length, toolNames: tools.map(t => t.name) }, 'Extracted tools from system prompt');

    return {
      ...body,
      system: cleanSystem,
      tools: [...(Array.isArray(body.tools) ? body.tools as unknown[] : []), ...tools],
    };
  }

  /**
   * Parse `<functions><function>JSON</function>...</functions>` XML blocks
   * from the system prompt string.
   */
  extractToolsFromSystem(system: string): { tools: AnthropicTool[]; cleanSystem: string } {
    const tools: AnthropicTool[] = [];

    // Match the outer <functions>...</functions> block
    const funcMatch = system.match(/<functions>([\s\S]*?)<\/functions>/);
    if (!funcMatch) {return { tools, cleanSystem: system };}

    const [, funcBlock] = funcMatch;

    // Extract individual <function>JSON</function> entries
    const funcRegex = /<function>([\s\S]*?)<\/function>/g;
    let match;

    while ((match = funcRegex.exec(funcBlock)) !== null) {
      try {
        const raw = match[1].trim();
        const def = JSON.parse(raw) as {
          name?: string;
          description?: string;
          parameters?: Record<string, unknown>;
        };

        if (!def.name) {continue;}

        tools.push({
          name: def.name,
          description: def.description ?? '',
          input_schema: def.parameters ?? { type: 'object', properties: {} },
        });
      } catch {
        // Skip malformed function definitions
      }
    }

    // Remove the entire <functions>...</functions> block from system prompt
    const cleanSystem = system.replace(/<functions>[\s\S]*?<\/functions>/, '').trim();

    return { tools, cleanSystem };
  }

  // ---- HTTP helpers -------------------------------------------------------

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private forwardRequest(
    req: http.IncomingMessage,
    body: string,
    clientRes: http.ServerResponse,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build the target URL, preserving the original path
      const targetPath = req.url ?? '/v1/messages';
      const targetUrl = new URL(targetPath, this.targetUrl);

      const options: http.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
          'content-length': Buffer.byteLength(body),
        },
      };

      // Use http or https based on target protocol
      const lib = targetUrl.protocol === 'https:' ? require('node:https') : http;
      const proxyReq = lib.request(options, (proxyRes: http.IncomingMessage) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });
        proxyRes.on('error', (err: Error) => {
          logger.error({ err }, 'Error reading upstream response');
          reject(err);
        });
        clientRes.on('finish', resolve);
      });

      proxyReq.on('error', (err: Error) => {
        logger.error({ err, target: targetUrl.href }, 'Error forwarding request');
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: { message: 'Upstream connection failed', type: 'proxy_error' } }));
        }
        reject(err);
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  }
}
