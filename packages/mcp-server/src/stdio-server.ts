/**
 * Stdio transport for the MCP Server.
 *
 * Reads newline-delimited JSON-RPC requests from stdin and writes JSON-RPC
 * responses to stdout. Request handling is delegated to the provided handler,
 * keeping the transport layer separate from arg parsing and request routing
 * (which stay in cli.ts).
 *
 * Issue #4128: Extracted from cli.ts so cli.ts remains a thin entry point.
 *
 * @module mcp-server/stdio-server
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('McpServerStdio');

/** A single JSON-RPC request read from stdin. */
export interface JsonRpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC response written to stdout. */
export interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Processes a JSON-RPC request and returns the response to write back. */
export type RequestHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/**
 * Start the stdio transport loop.
 *
 * Buffers stdin, dispatches each newline-delimited JSON-RPC message to
 * `handleRequest`, and writes the serialized response to stdout. Malformed
 * lines produce a JSON-RPC parse error (-32700). Returns once stdin closes.
 */
export function startStdioServer(handleRequest: RequestHandler): void {
  let buffer = '';

  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', async (chunk) => {
    buffer += chunk;

    // Try to parse complete JSON messages
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) {continue;}

      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = await handleRequest(request);
        console.log(JSON.stringify(response));
      } catch (error) {
        logger.error({ err: error, line }, 'Failed to parse or handle request');
        console.error(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32700,
            message: 'Parse error',
          },
        }));
      }
    }
  });

  process.stdin.on('end', () => {
    logger.info('MCP Server shutting down');
    process.exit(0);
  });

  logger.info('MCP Server started (stdio mode)');
}
