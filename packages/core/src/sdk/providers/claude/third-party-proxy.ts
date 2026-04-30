/**
 * Third-party API Compatibility Proxy (Issue #2948)
 *
 * Intercepts API requests from Claude Agent SDK (CLI subprocess) and converts
 * tool definitions from system prompt XML format to the `tools` API parameter.
 *
 * Background:
 * - Claude Agent SDK embeds built-in tool definitions (Bash, Read, Write, etc.)
 *   in the system prompt as XML, NOT via the Anthropic API `tools` parameter.
 * - Anthropic's native API supports both, but third-party Claude-compatible
 *   endpoints (e.g., GLM/智谱) only recognize the `tools` API parameter.
 * - This proxy bridges the gap by extracting tool definitions from the system
 *   prompt and moving them to the `tools` API parameter format.
 *
 * Architecture:
 *   CLI subprocess → local proxy → actual API endpoint (GLM)
 *                        ↓
 *              extract tools from system prompt
 *              add to `tools` API parameter
 *              forward modified request
 *
 * Lifecycle:
 * 1. Proxy starts on a random available port when a non-Anthropic endpoint is detected
 * 2. ANTHROPIC_BASE_URL is set to the proxy URL
 * 3. CLI sends requests to the proxy
 * 4. Proxy modifies and forwards to the original endpoint
 * 5. Proxy is cleaned up when the provider is disposed
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ThirdPartyProxy');

// ============================================================================
// Types
// ============================================================================

/** Anthropic API tool definition format */
interface ApiToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** Parsed Anthropic Messages API request body */
interface MessagesRequestBody {
  model?: string;
  system?: string | Array<{ type: string; text: string; [key: string]: unknown }>;
  messages?: unknown[];
  max_tokens?: number;
  tools?: ApiToolDefinition[];
  stream?: boolean;
  [key: string]: unknown;
}

/** Result of extracting tools from system prompt */
interface ToolExtractionResult {
  /** Extracted tool definitions */
  tools: ApiToolDefinition[];
  /** System prompt with tool definitions removed */
  cleanedSystem: string | Array<{ type: string; text: string; [key: string]: unknown }>;
  /** Whether any tools were found */
  found: boolean;
}

/** Proxy configuration */
export interface ThirdPartyProxyOptions {
  /** The original API base URL to forward requests to */
  targetBaseUrl: string;
  /** Port to listen on (0 = random available port) */
  port?: number;
}

// ============================================================================
// Tool Definition Extraction
// ============================================================================

/**
 * Extract tool definitions from a system prompt string.
 *
 * The Claude Code CLI embeds tool definitions in the system prompt using
 * an XML-like format. This function parses that format and converts it
 * to the Anthropic API `tools` parameter format.
 *
 * Supported XML patterns:
 * - `<tools>...</tools>` block containing individual tool definitions
 * - `<tool name="...">` with nested `<description>` and `<parameters>`
 *
 * The parser is designed to be flexible — it handles variations in formatting
 * while being conservative (only extracts clearly identified tool blocks).
 */
export function extractToolsFromSystemPrompt(systemPrompt: string): ToolExtractionResult {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return { tools: [], cleanedSystem: systemPrompt, found: false };
  }

  const tools: ApiToolDefinition[] = [];
  let cleanedPrompt = systemPrompt;

  // Strategy 1: Extract from <tools>...</tools> block (Claude Code format)
  const toolsBlockRegex = /<tools>([\s\S]*?)<\/tools>/g;
  const toolBlockRegex = /<tool\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool>/g;

  let match: RegExpExecArray | null;
  const toolsBlocks: string[] = [];

  // Find all <tools> blocks
  while ((match = toolsBlockRegex.exec(systemPrompt)) !== null) {
    toolsBlocks.push(match[1]);
  }

  if (toolsBlocks.length > 0) {
    // Parse individual tools from each block
    for (const block of toolsBlocks) {
      let toolMatch: RegExpExecArray | null;
      const blockRegex = new RegExp(toolBlockRegex.source, 'g');
      while ((toolMatch = blockRegex.exec(block)) !== null) {
        const [, toolName, toolContent] = toolMatch;

        const extracted = parseToolContent(toolName, toolContent);
        if (extracted) {
          tools.push(extracted);
        }
      }
    }

    // Remove <tools>...</tools> blocks from system prompt
    cleanedPrompt = cleanedPrompt.replace(toolsBlockRegex, '').trim();
  }

  // Strategy 2: Extract from <tool_use> hints (fallback)
  // Some formats include tool descriptions as individual elements
  if (tools.length === 0) {
    const individualToolRegex = /<tool_description\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_description>/g;
    while ((match = individualToolRegex.exec(systemPrompt)) !== null) {
      const [, toolName, toolContent] = match;
      const extracted = parseToolContent(toolName, toolContent);
      if (extracted) {
        tools.push(extracted);
      }
    }

    if (tools.length > 0) {
      cleanedPrompt = cleanedPrompt.replace(
        /<tool_description\s+name=["'][^"']*["']\s*>[\s\S]*?<\/tool_description>/g,
        ''
      ).trim();
    }
  }

  logger.info(
    { toolCount: tools.length, toolNames: tools.map(t => t.name) },
    'Extracted tools from system prompt'
  );

  return {
    tools,
    cleanedSystem: cleanedPrompt,
    found: tools.length > 0,
  };
}

/**
 * Parse the content of a single tool definition from XML.
 *
 * Expected format:
 * <tool name="Bash">
 *   <description>Executes a bash command</description>
 *   <parameters>{"type": "object", ...}</parameters>
 * </tool>
 */
function parseToolContent(name: string, content: string): ApiToolDefinition | null {
  try {
    // Extract description
    const descMatch = content.match(/<description>([\s\S]*?)<\/description>/);
    const description = descMatch ? descMatch[1].trim() : `Tool: ${name}`;

    // Extract parameters (JSON schema)
    const paramsMatch = content.match(/<parameters>([\s\S]*?)<\/parameters>/);
    let inputSchema: ApiToolDefinition['input_schema'] = {
      type: 'object',
      properties: {},
    };

    if (paramsMatch) {
      try {
        const parsed = JSON.parse(paramsMatch[1].trim());
        inputSchema = {
          type: 'object',
          ...parsed,
        };
      } catch {
        logger.debug({ toolName: name }, 'Failed to parse parameters JSON, using default schema');
      }
    }

    return {
      name,
      description,
      input_schema: inputSchema,
    };
  } catch (error) {
    logger.debug({ toolName: name, error }, 'Failed to parse tool content');
    return null;
  }
}

/**
 * Process a Messages API request body, extracting tools from system prompt.
 */
function processRequestBody(body: MessagesRequestBody): MessagesRequestBody {
  if (!body.system) {
    return body;
  }

  // Handle both string and array format for system field
  const systemText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system
          .filter((block): block is { type: string; text: string } => block.type === 'text')
          .map(block => block.text)
          .join('\n')
      : '';

  const extraction = extractToolsFromSystemPrompt(systemText);

  if (!extraction.found) {
    return body;
  }

  // Merge extracted tools with any existing tools
  const existingTools = body.tools ?? [];
  const existingToolNames = new Set(existingTools.map(t => t.name));
  const newTools = extraction.tools.filter(t => !existingToolNames.has(t.name));
  const mergedTools = [...existingTools, ...newTools];

  // Build the modified request body
  const modified: MessagesRequestBody = {
    ...body,
    tools: mergedTools,
  };

  // Update system prompt
  if (typeof body.system === 'string') {
    modified.system = extraction.cleanedSystem as string;
  } else if (Array.isArray(body.system)) {
    // For array format, update text blocks
    modified.system = body.system.map(block => {
      if (block.type === 'text') {
        const cleaned = extraction.cleanedSystem as string;
        // Only update if we extracted tools from this block's text
        if (systemText.includes(block.text)) {
          return { ...block, text: cleaned };
        }
      }
      return block;
    });
  }

  logger.info(
    {
      existingToolCount: existingTools.length,
      extractedToolCount: newTools.length,
      totalToolCount: mergedTools.length,
      newToolNames: newTools.map(t => t.name),
    },
    'Modified request: added tools from system prompt'
  );

  return modified;
}

// ============================================================================
// Proxy Server
// ============================================================================

/**
 * Third-party API compatibility proxy.
 *
 * Starts a local HTTP server that intercepts API requests from the CLI,
 * modifies them to include proper `tools` parameter, and forwards to
 * the actual third-party API endpoint.
 */
export class ThirdPartyApiProxy {
  private server: http.Server | null = null;
  private targetUrl: URL;
  private targetPort: number;
  private targetProtocol: typeof http | typeof https;
  private localPort: number = 0;

  constructor(private readonly options: ThirdPartyProxyOptions) {
    this.targetUrl = new URL(options.targetBaseUrl);
    this.targetPort = this.targetUrl.port
      ? parseInt(this.targetUrl.port, 10)
      : (this.targetUrl.protocol === 'https:' ? 443 : 80);
    this.targetProtocol = this.targetUrl.protocol === 'https:' ? https : http;
  }

  /**
   * Start the proxy server.
   * @returns The proxy URL (e.g., http://localhost:12345)
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

    const {server} = this;
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
    const body = await this.readBody(req);

    // Determine the target path
    const targetPath = req.url || '/';
    const isMessagesEndpoint = targetPath.includes('/v1/messages');

    let modifiedBody: string | undefined;
    let requestBody: MessagesRequestBody | undefined;

    if (isMessagesEndpoint && body.length > 0) {
      try {
        requestBody = JSON.parse(body);

        // Only process if this is a messages request with a system prompt
        if (requestBody && requestBody.system) {
          const modified = processRequestBody(requestBody);
          modifiedBody = JSON.stringify(modified);

          logger.debug(
            {
              url: targetPath,
              originalLength: body.length,
              modifiedLength: modifiedBody.length,
              toolCount: modified.tools?.length ?? 0,
            },
            'Request modified'
          );
        }
      } catch (parseError) {
        logger.debug({ error: parseError }, 'Failed to parse request body, forwarding as-is');
      }
    }

    // Build target request options
    const targetHeaders: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: this.targetUrl.host,
    };

    // Update content-length if body was modified
    const finalBody = modifiedBody ?? body;
    if (modifiedBody) {
      targetHeaders['content-length'] = String(finalBody.length);
    }

    const proxyReqOptions: https.RequestOptions = {
      hostname: this.targetUrl.hostname,
      port: this.targetPort,
      path: targetPath,
      method: req.method,
      headers: targetHeaders,
    };

    // Forward the request
    return new Promise((resolve, reject) => {
      const proxyReq = this.targetProtocol.request(proxyReqOptions, (proxyRes) => {
        // Check if this is a streaming response
        const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream')
          || proxyRes.headers['content-type']?.includes('application/stream');

        // Forward response headers
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

        if (isStreaming) {
          // For streaming responses (SSE), pipe directly without modification
          proxyRes.pipe(res);

          proxyRes.on('end', resolve);
          proxyRes.on('error', reject);
        } else {
          // For non-streaming responses, pipe directly
          proxyRes.pipe(res);

          proxyRes.on('end', resolve);
          proxyRes.on('error', reject);
        }
      });

      proxyReq.on('error', (error) => {
        logger.error({ err: error, url: targetPath }, 'Proxy forwarding error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream error', message: error.message }));
        }
        resolve();
      });

      // Send the (possibly modified) body
      proxyReq.write(finalBody);
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

// ============================================================================
// Utility: Check if URL is a third-party (non-Anthropic) endpoint
// ============================================================================

/**
 * Check if an API base URL points to a non-Anthropic endpoint.
 *
 * Returns true for URLs that are NOT api.anthropic.com or console.anthropic.com,
 * indicating they need the compatibility proxy.
 */
export function isThirdPartyEndpoint(apiBaseUrl: string): boolean {
  if (!apiBaseUrl) {
    return false;
  }

  try {
    const url = new URL(apiBaseUrl);
    const hostname = url.hostname.toLowerCase();

    // Anthropic official endpoints
    const anthropicHosts = [
      'api.anthropic.com',
      'console.anthropic.com',
    ];

    return !anthropicHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    // Invalid URL, treat as third-party
    return true;
  }
}
