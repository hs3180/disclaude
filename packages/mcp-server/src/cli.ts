#!/usr/bin/env node
/**
 * CLI entry point for @disclaude/mcp-server
 *
 * Usage:
 *   disclaude-mcp [options]
 *
 * This starts the MCP Server (stdio mode) for use with Claude Code
 * and other MCP clients.
 *
 * Issue #4128: Tool schemas and dispatch logic extracted to tools/.
 * This file handles arg parsing, MCP handshake, and request routing.
 *
 * @module mcp-server/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  createLogger,
  getIpcSocketPath,
} from '@disclaude/core';
import { existsSync } from 'fs';
import { setMessageSentCallback } from './index.js';
import { toolDefinitions } from './tools/tool-definitions.js';
import { dispatchToolCall } from './tools/tool-dispatch.js';

const logger = createLogger('McpServerCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  configPath?: string;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { command: 'help' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'start') {
      options.command = 'start';
    } else if (arg === '--config' || arg === '-c') {
      const value = args[++i];
      if (value) {
        options.configPath = value;
      }
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }

  return options;
}

/**
 * Print usage information.
 */
function printUsage(): void {
  console.log(`
@disclaude/mcp-server - MCP Server for disclaude

Usage:
  disclaude-mcp [options]

Options:
  --config, -c PATH       Path to configuration file
  --help, -h              Show this help message

The MCP Server runs in stdio mode and communicates via JSON-RPC.
It provides tools for sending messages, files, and interactive cards.

Environment Variables:
  FEISHU_APP_ID           Feishu App ID (required)
  FEISHU_APP_SECRET       Feishu App Secret (required)
  WORKSPACE_DIR           Workspace directory (default: ./workspace)

Examples:
  # Start with environment variables
  FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx disclaude-mcp

  # Start with config file
  disclaude-mcp --config /path/to/disclaude.config.yaml
`);
}

/**
 * Handle incoming JSON-RPC requests.
 *
 * Issue #4128: Delegates to tool-definitions (tools/list) and
 * tool-dispatch (tools/call) for a thin routing layer.
 */
export async function handleRequest(request: {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}): Promise<{
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}> {
  const { id, method, params } = request;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'channel-mcp', version: '0.0.1' },
        },
      };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: toolDefinitions } };
    }

    if (method === 'tools/call') {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
      const toolResult = await dispatchToolCall(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result: toolResult };
    }

    throw new Error(`Unknown method: ${method}`);
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

/**
 * Main entry point.
 */
// eslint-disable-next-line require-await
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.command === 'help' || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Load configuration if provided
  if (options.configPath) {
    logger.info({ path: options.configPath }, 'Loading configuration file');
    const config = loadConfigFile(options.configPath);
    if (!config._fromFile) {
      logger.error({ path: options.configPath }, 'Failed to load configuration file');
      console.error(`Error: Could not load configuration file: ${options.configPath}`);
      process.exit(1);
    }
    setLoadedConfig(config);
    logger.info({ path: config._source }, 'Configuration loaded successfully');
  }

  logger.info('Starting MCP Server (stdio mode)');

  // Log startup environment for debugging MCP server spawn issues
  const ipcSocket = process.env.DISCLAUDE_WORKER_IPC_SOCKET;
  const ipcSocketPath = getIpcSocketPath();
  const ipcAvailable = existsSync(ipcSocketPath);

  logger.info({
    nodeVersion: process.version,
    cwd: process.cwd(),
    ipcSocket,
    ipcSocketPath,
    ipcAvailable,
    hasConfig: !!options.configPath,
  }, 'MCP Server startup environment');

  // Set up message sent callback
  setMessageSentCallback((chatId: string) => {
    logger.debug({ chatId }, 'Message sent callback triggered');
  });

  // Main server loop - read from stdin, write to stdout
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
        const request = JSON.parse(line);
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

// Run main (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    logger.error({ err: error }, 'Unhandled error in main');
    console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
