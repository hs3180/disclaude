/**
 * GLM Tool Extract Proxy — local HTTP reverse proxy that extracts tool
 * definitions from the system prompt and adds them to the `tools` API
 * parameter for third-party Claude-compatible endpoints (e.g. GLM).
 *
 * Problem (Issue #2948):
 *   Claude Agent SDK embeds built-in tool definitions (Bash, Read, Write,
 *   Edit, Glob, Grep) in the system prompt as XML rather than passing them
 *   through the `tools` API parameter.  Anthropic's native API accepts both
 *   formats, but third-party endpoints like GLM only recognise the `tools`
 *   parameter — causing all system tools to be silently lost.
 *
 * Solution:
 *   A lightweight HTTP proxy that sits between the SDK subprocess and the
 *   upstream API endpoint.  On every request it:
 *     1. Translates `Authorization: Bearer` → `x-api-key` (GLM compat)
 *     2. Parses the JSON body to find the `system` field
 *     3. Extracts tool definitions from XML blocks in the system prompt
 *     4. Adds them to the `tools` array in the request body
 *     5. Removes the XML tool blocks from the system prompt
 *     6. Forwards the modified request to the real endpoint
 *
 * Flow:
 * ```
 * Claude Code CLI
 *   → ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *     → GLM Tool Extract Proxy
 *         ├── auth: Authorization: Bearer → x-api-key
 *         └── tools: system prompt XML → tools[] param
 *       → https://open.bigmodel.cn/api/anthropic
 * ```
 *
 * @module utils/glm-tool-extract-proxy
 * @see Issue #2948
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('GlmToolExtractProxy');

/**
 * Headers that should NOT be forwarded to the upstream server.
 * Hop-by-hop headers per RFC 2616 §13.5.1.
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

// ---------------------------------------------------------------------------
// XML Tool Extraction
// ---------------------------------------------------------------------------

/**
 * Represents a single extracted tool definition.
 */
interface ExtractedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Regex that matches Claude Code's system-prompt tool definition blocks.
 *
 * Claude Code uses two known XML formats for embedding tool definitions:
 *
 * Format A — `<tool name="...">` (older):
 * ```
 * <tool name="Bash">
 * <description>Executes a bash command</description>
 * <parameters>{"type":"object",...}</parameters>
 * </tool>
 * ```
 *
 * Format B — `<tool_description>` (newer):
 * ```
 * <tool_description>
 * <tool_name>Bash</tool_name>
 * <description>...</description>
 * <parameters>{...}</parameters>
 * </tool_description>
 * ```
 *
 * This regex handles both formats by matching the outermost tags and then
 * parsing the inner content separately.
 */
const TOOL_XML_REGEX =
  /<(?:tool\s+name="([^"]+)"|tool_description)>([\s\S]*?)<\/(?:tool|tool_description)>/g;

const TOOL_NAME_TAG_REGEX = /<tool_name>([^<]+)<\/tool_name>/;
const DESCRIPTION_TAG_REGEX = /<description>([\s\S]*?)<\/description>/;
const PARAMETERS_TAG_REGEX = /<parameters>([\s\S]*?)<\/parameters>/;

/**
 * Result of extracting tools from a system prompt.
 */
interface ExtractionResult {
  /** Extracted tool definitions (Anthropic API format) */
  tools: ExtractedTool[];
  /** The system prompt with tool XML blocks removed */
  cleanedSystem: string;
}

/**
 * Extract tool definitions from a system prompt string and convert them
 * to the Anthropic API `tools` format.
 *
 * @param systemPrompt - The raw system prompt string
 * @returns Extraction result with tools and cleaned prompt
 */
export function extractToolsFromSystemPrompt(systemPrompt: string): ExtractionResult {
  const tools: ExtractedTool[] = [];
  let cleanedSystem = systemPrompt;

  // Reset regex state for global matching
  TOOL_XML_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOOL_XML_REGEX.exec(systemPrompt)) !== null) {
    const [fullMatch, nameAttr, innerContent] = match;

    // Determine tool name: from attribute (Format A) or inner tag (Format B)
    let toolName: string | undefined = nameAttr;
    if (!toolName) {
      const nameMatch = TOOL_NAME_TAG_REGEX.exec(innerContent);
      toolName = nameMatch?.[1]?.trim();
    }

    if (!toolName) {
      logger.debug({ match: fullMatch.substring(0, 80) }, 'Skipping tool block without name');
      continue;
    }

    // Extract description
    const descMatch = DESCRIPTION_TAG_REGEX.exec(innerContent);
    const description = descMatch?.[1]?.trim() ?? '';

    // Extract parameters JSON
    const paramsMatch = PARAMETERS_TAG_REGEX.exec(innerContent);
    if (!paramsMatch) {
      logger.debug({ toolName }, 'Skipping tool block without parameters');
      continue;
    }

    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = JSON.parse(paramsMatch[1].trim());
    } catch {
      logger.warn({ toolName, params: paramsMatch[1].substring(0, 80) }, 'Failed to parse tool parameters JSON');
      continue;
    }

    tools.push({
      name: toolName,
      description,
      input_schema: inputSchema,
    });

    // Remove the entire XML block from the system prompt
    cleanedSystem = cleanedSystem.replace(fullMatch, '');
  }

  // Clean up multiple consecutive blank lines left behind
  cleanedSystem = cleanedSystem.replace(/\n{3,}/g, '\n\n').trim();

  return { tools, cleanedSystem };
}

// ---------------------------------------------------------------------------
// Request Body Transformation
// ---------------------------------------------------------------------------

/**
 * Anthropic API `system` field can be either a string or an array of
 * content blocks.  This handles both cases.
 */
export interface SystemContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AnthropicRequestBody {
  system?: string | SystemContentBlock[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Transform an Anthropic API request body by extracting tools from the
 * system prompt and merging them into the `tools` array.
 *
 * @param body - The parsed request body
 * @returns Whether the body was modified
 */
export function transformRequestBody(body: AnthropicRequestBody): boolean {
  if (!body.system) {
    return false;
  }

  let systemText: string;
  let systemBlocks: SystemContentBlock[] | undefined;

  if (typeof body.system === 'string') {
    systemText = body.system;
  } else if (Array.isArray(body.system)) {
    // Concatenate text from all text blocks
    systemBlocks = body.system;
    systemText = body.system
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
  } else {
    return false;
  }

  const { tools, cleanedSystem } = extractToolsFromSystemPrompt(systemText);

  if (tools.length === 0) {
    return false;
  }

  logger.info(
    { toolNames: tools.map((t) => t.name), count: tools.length },
    'Extracted tools from system prompt',
  );

  // Merge extracted tools into existing tools array (deduplicating by name)
  const existingTools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown>; [key: string]: unknown }> = body.tools ?? [];
  const existingNames = new Set(existingTools.map((t) => t.name));

  const newTools = tools.filter((t) => !existingNames.has(t.name));
  body.tools = [...existingTools, ...newTools] as AnthropicRequestBody['tools'];

  if (newTools.length > 0) {
    logger.debug(
      { added: newTools.map((t) => t.name) },
      'Added new tools to request body',
    );
  }

  // Update the system field with cleaned content
  if (typeof body.system === 'string') {
    body.system = cleanedSystem;
  } else if (systemBlocks) {
    // For array format, update only text blocks that contained tools
    // Simple approach: replace the concatenated text
    const textBlocks = systemBlocks.filter(
      (block) => block.type === 'text' && typeof block.text === 'string',
    );
    if (textBlocks.length === 1) {
      textBlocks[0].text = cleanedSystem;
    } else {
      // Multiple text blocks — find the one(s) containing tool definitions
      // and update them. For simplicity, update the last text block.
      const lastTextBlock = textBlocks[textBlocks.length - 1];
      if (lastTextBlock) {
        lastTextBlock.text = cleanedSystem;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Proxy Server
// ---------------------------------------------------------------------------

/**
 * Lightweight HTTP reverse proxy that extracts tool definitions from the
 * system prompt and translates auth headers for GLM-compatible endpoints.
 *
 * Designed as a process-level singleton — call `startGlmToolProxy()` to
 * obtain the shared instance.
 */
export class GlmToolExtractProxy {
  private server: http.Server | null = null;
  private readonly targetUrl: URL;
  private port = 0;

  constructor(targetBaseUrl: string) {
    this.targetUrl = new URL(targetBaseUrl);
  }

  /**
   * Start the proxy server on a random ephemeral port.
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
          'GLM tool extract proxy started',
        );
        resolve(this.port);
      });

      server.on('error', (err) => {
        logger.error({ err }, 'GLM tool extract proxy server error');
        reject(err);
      });
    });
  }

  /** Stop the proxy server. */
  stop(): Promise<void> {
    const { server } = this;
    if (!server) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      server.close(() => {
        logger.info({ port: this.port }, 'GLM tool extract proxy stopped');
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }

  /** Get the proxy URL (must call `start()` first). */
  getProxyUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Get the listening port. */
  getPort(): number {
    return this.port;
  }

  /**
   * Handle an incoming HTTP request.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
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
   * Forward the request to the upstream endpoint, applying tool extraction
   * and auth header translation.
   */
  private forwardRequest(
    req: http.IncomingMessage,
    body: Buffer,
    res: http.ServerResponse,
  ): void {
    // --- 1. Parse and transform request body ---
    let modifiedBody: Buffer;
    try {
      const isJson = (req.headers['content-type'] ?? '').includes('application/json');
      if (isJson && body.length > 0) {
        const parsed = JSON.parse(body.toString('utf-8')) as AnthropicRequestBody;
        const modified = transformRequestBody(parsed);
        modifiedBody = modified
          ? Buffer.from(JSON.stringify(parsed), 'utf-8')
          : body;
      } else {
        modifiedBody = body;
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to parse request body, forwarding as-is');
      modifiedBody = body;
    }

    // --- 2. Build outgoing headers with auth translation ---
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
          outgoingHeaders['x-api-key'] = authValue;
        }
        continue;
      }

      // Skip hop-by-hop headers
      if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
        continue;
      }

      // Skip host header (set for the target)
      if (lowerKey === 'host') {
        continue;
      }

      if (value !== undefined) {
        outgoingHeaders[key] = value;
      }
    }

    // Update content-length if body was modified
    if (modifiedBody !== body) {
      outgoingHeaders['content-length'] = String(modifiedBody.length);
    }

    // --- 3. Construct target path ---
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

    proxyReq.write(modifiedBody);
    proxyReq.end();
  }
}

// ---------------------------------------------------------------------------
// Singleton Management
// ---------------------------------------------------------------------------

let proxyInstance: GlmToolExtractProxy | null = null;
let proxyStartPromise: Promise<GlmToolExtractProxy> | null = null;

/**
 * Get or create the GLM tool extract proxy singleton.
 *
 * @param targetBaseUrl - The real API base URL (e.g. `https://open.bigmodel.cn/api/anthropic`)
 * @returns The running proxy instance
 */
export async function startGlmToolProxy(targetBaseUrl: string): Promise<GlmToolExtractProxy> {
  if (proxyInstance && proxyInstance.getPort() > 0) {
    return proxyInstance;
  }

  if (proxyStartPromise) {
    return proxyStartPromise;
  }

  proxyStartPromise = (async () => {
    const proxy = new GlmToolExtractProxy(targetBaseUrl);
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

/** Stop and destroy the singleton proxy (for graceful shutdown). */
export async function stopGlmToolProxy(): Promise<void> {
  if (proxyInstance) {
    await proxyInstance.stop();
    proxyInstance = null;
  }
}

/** Get the current proxy instance without starting it. */
export function getGlmToolProxy(): GlmToolExtractProxy | null {
  return proxyInstance;
}

/**
 * Get the proxy URL if the proxy is running.
 * Used by `buildSdkEnv()` to route SDK requests through the proxy.
 */
export function getGlmToolProxyUrl(): string | undefined {
  if (proxyInstance && proxyInstance.getPort() > 0) {
    return proxyInstance.getProxyUrl();
  }
  return undefined;
}
