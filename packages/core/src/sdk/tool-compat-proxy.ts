/**
 * Tool Compatibility Proxy for third-party Anthropic-compatible endpoints.
 *
 * Problem: Claude Agent SDK embeds system tool definitions (Bash, Read, Write, etc.)
 * in the system prompt (XML format). Third-party endpoints (e.g., GLM/Zhipu AI) only
 * recognize the `tools` API parameter, causing system tools to be unavailable.
 *
 * Solution: This proxy intercepts API requests to third-party endpoints, injects
 * system tool definitions into the `tools` API parameter, and forwards the request.
 * The model receives tools via the standard `tools` parameter which all
 * Anthropic-compatible endpoints support.
 *
 * Architecture:
 * ```
 * Claude Code SDK → localhost:proxyPort/v1/messages → GLM endpoint/v1/messages
 *                     (inject tools into `tools` param)
 * ```
 *
 * @module sdk/tool-compat-proxy
 * @see Issue #2943
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ToolCompatProxy');

// ============================================================================
// System Tool Definitions (Anthropic Messages API format)
// ============================================================================

/**
 * Tool definitions matching Claude Code's built-in system tools.
 *
 * These definitions are sent via the `tools` API parameter so that
 * third-party endpoints (GLM, etc.) can recognize available tools.
 *
 * Tool names and input schemas match Claude Code's internal definitions
 * (from @anthropic-ai/claude-agent-sdk sdk-tools.d.ts).
 */
export const SYSTEM_TOOL_DEFINITIONS: Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> = [
  {
    name: 'Bash',
    description: 'Execute a bash command and return the output.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000)' },
        description: { type: 'string', description: 'Clear, concise description of what this command does' },
        run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the local filesystem. Supports text, images, PDFs, and Jupyter notebooks.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read' },
        offset: { type: 'number', description: 'The line number to start reading from' },
        limit: { type: 'number', description: 'The number of lines to read' },
        pages: { type: 'string', description: 'Page range for PDF files (e.g., "1-5")' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. This tool will overwrite the existing file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Perform exact string replacements in files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to modify' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The text to replace it with' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching tool that works with any codebase size.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: { type: 'string', description: 'The directory to search in (default: cwd)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'A powerful search tool built on ripgrep.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        '-B': { type: 'number', description: 'Lines before match' },
        '-A': { type: 'number', description: 'Lines after match' },
        '-C': { type: 'number', description: 'Context lines' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'NotebookEdit',
    description: 'Edit a cell in a Jupyter notebook.',
    input_schema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'The absolute path to the notebook file' },
        new_source: { type: 'string', description: 'The new source for the cell' },
        cell_number: { type: 'number', description: 'The 0-indexed cell number to edit' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['notebook_path', 'new_source'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web and use the results to inform responses.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch and convert URL to large model friendly input.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the website to fetch and read' },
        timeout: { type: 'number', description: 'Request timeout in seconds (default 20)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'TodoWrite',
    description: 'Create and manage a structured task list.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: 'Present continuous form' },
            },
            required: ['content', 'status', 'activeForm'],
          },
          description: 'Updated todo list',
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'AskUserQuestion',
    description: 'Ask the user questions during execution.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
];

// ============================================================================
// Proxy Implementation
// ============================================================================

/**
 * Proxy instance state.
 */
export interface ProxyInstance {
  /** The HTTP server instance */
  server: http.Server;
  /** The local proxy URL (e.g., http://127.0.0.1:12345) */
  proxyUrl: string;
  /** The target API base URL (e.g., https://open.bigmodel.cn/api/anthropic) */
  targetUrl: string;
  /** Whether the proxy has been stopped */
  stopped: boolean;
}

// Singleton proxy instance — shared across all agents in the process
let activeProxy: ProxyInstance | null = null;

/**
 * Inject system tool definitions into the request body's `tools` parameter.
 *
 * If the request already has a `tools` array, system tools are prepended
 * (avoiding duplicates by name). If not, a new `tools` array is created.
 *
 * @param body - Parsed JSON request body
 * @returns Modified body with system tools injected
 */
export function injectToolDefinitions(body: Record<string, unknown>): Record<string, unknown> {
  const existingTools = Array.isArray(body.tools) ? body.tools as Array<{ name: string }> : [];
  const existingNames = new Set(existingTools.map(t => t.name));

  // Only add system tools that aren't already present
  const newTools = SYSTEM_TOOL_DEFINITIONS.filter(t => !existingNames.has(t.name));

  if (newTools.length === 0) {
    return body;
  }

  const mergedTools = [...newTools, ...existingTools];

  logger.debug({
    injectedCount: newTools.length,
    existingCount: existingTools.length,
    totalTools: mergedTools.length,
    injectedNames: newTools.map(t => t.name),
  }, 'Injected system tool definitions');

  return {
    ...body,
    tools: mergedTools,
  };
}

/**
 * Start the tool compatibility proxy.
 *
 * Creates a local HTTP server that intercepts API requests,
 * injects system tool definitions, and forwards to the target endpoint.
 *
 * @param targetUrl - The target API base URL (e.g., https://open.bigmodel.cn/api/anthropic)
 * @returns Promise resolving to the proxy instance
 */
export async function startToolCompatProxy(targetUrl: string): Promise<ProxyInstance> {
  // Return existing proxy if it targets the same URL
  if (activeProxy && !activeProxy.stopped && activeProxy.targetUrl === targetUrl) {
    logger.debug({ proxyUrl: activeProxy.proxyUrl }, 'Reusing existing tool compat proxy');
    return activeProxy;
  }

  // Stop existing proxy if targeting different URL
  if (activeProxy && !activeProxy.stopped) {
    logger.warn(
      { oldTarget: activeProxy.targetUrl, newTarget: targetUrl },
      'Stopping existing proxy (different target URL)'
    );
    stopToolCompatProxy();
  }

  const proxy = await createProxy(targetUrl);
  activeProxy = proxy;

  logger.info(
    { proxyUrl: proxy.proxyUrl, targetUrl },
    'Tool compatibility proxy started — system tools will be injected via `tools` API parameter'
  );

  return proxy;
}

/**
 * Stop the tool compatibility proxy.
 */
export function stopToolCompatProxy(): void {
  if (activeProxy && !activeProxy.stopped) {
    activeProxy.stopped = true;
    activeProxy.server.close();
    logger.info('Tool compatibility proxy stopped');
    activeProxy = null;
  }
}

/**
 * Get the active proxy instance (if any).
 */
export function getActiveProxy(): ProxyInstance | null {
  return activeProxy && !activeProxy.stopped ? activeProxy : null;
}

/**
 * Create and start the proxy HTTP server.
 */
function createProxy(targetUrl: string): Promise<ProxyInstance> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, targetUrl);
    });

    // Listen on random available port on localhost
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve({
          server,
          proxyUrl: `http://127.0.0.1:${addr.port}`,
          targetUrl,
          stopped: false,
        });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Handle an incoming proxy request.
 */
function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
): void {
  // Only inject tools for POST requests to /v1/messages
  const shouldInjectTools = req.method === 'POST' && req.url?.startsWith('/v1/messages');

  // Collect request body
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf-8');

    // Parse and potentially modify the request body
    let modifiedBody = rawBody;
    if (shouldInjectTools) {
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        const modified = injectToolDefinitions(parsed);
        modifiedBody = JSON.stringify(modified);
      } catch (err) {
        logger.error({ err }, 'Failed to parse/modify request body, forwarding as-is');
      }
    }

    // Build target URL
    const parsedTarget = new URL(targetUrl);
    const targetPath = req.url || '/';
    const targetFullPath = `${parsedTarget.origin}${targetPath}`;

    // Parse target URL for http/https module
    const targetUrlParsed = new URL(targetFullPath);
    const isHttps = targetUrlParsed.protocol === 'https:';
    const transportModule = isHttps ? https : http;

    // Build forwarded request options
    const options: https.RequestOptions = {
      hostname: targetUrlParsed.hostname,
      port: targetUrlParsed.port || (isHttps ? 443 : 80),
      path: targetUrlParsed.pathname + targetUrlParsed.search,
      method: req.method,
      headers: {
        ...req.headers,
        // Update host header for the target
        host: targetUrlParsed.host,
        // Update content-length for modified body
        'content-length': Buffer.byteLength(modifiedBody).toString(),
      },
    };

    // Make the forwarded request
    const proxyReq = transportModule.request(options, (proxyRes) => {
      // Forward status code and headers
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      // Stream the response back (handles SSE streaming)
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      logger.error(
        { err, targetUrl: targetFullPath },
        'Proxy request to target failed'
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'proxy_error',
          message: `Tool compat proxy failed to reach target: ${err.message}`,
        },
      }));
    });

    // Send modified body
    proxyReq.write(modifiedBody);
    proxyReq.end();
  });

  req.on('error', (err) => {
    logger.error({ err }, 'Error reading incoming request');
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'proxy_error',
        message: `Failed to read request: ${err.message}`,
      },
    }));
  });
}
