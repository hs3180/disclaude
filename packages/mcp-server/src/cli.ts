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
 * @module mcp-server/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  createLogger,
} from '@disclaude/core';
import {
  setMessageSentCallback,
  send_message,
  send_file,
} from './index.js';

const logger = createLogger('McpServerCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  configPath?: string;
}

function parseArgs(args: string[]): CliOptions {
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
 */
async function handleRequest(request: {
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
    // Handle different MCP methods
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'send_message',
              description: `Send a message to a chat. Supports text, card, and interactive modes.

## Modes
1. **Text**: Simple text message
2. **Card**: Display-only card (no interactions)
3. **Interactive**: Card with buttons/actions (requires actionPrompts)

## Parameters
- **content**: Text string or card object
- **format**: "text" or "card"
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply
- **actionPrompts**: Optional, enables interactive mode. Maps button values to prompts.`,
              inputSchema: {
                type: 'object',
                properties: {
                  content: {
                    oneOf: [{ type: 'string' }, { type: 'object' }],
                    description: 'The message content. String for text, object for card.',
                  },
                  format: {
                    type: 'string',
                    description: 'Message format. Use "text" for plain text, "card" for interactive cards.',
                    enum: ['text', 'card'],
                    default: 'text',
                  },
                  chatId: {
                    type: 'string',
                    description: 'Target chat ID',
                  },
                  parentMessageId: {
                    type: 'string',
                    description: 'Optional parent message ID for thread reply',
                  },
                  actionPrompts: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: 'Optional action prompts for interactive cards. Maps button values to prompts.',
                  },
                },
                required: ['content', 'format', 'chatId'],
              },
            },
            {
              name: 'send_file',
              description: 'Send a file to a chat. Supports images, audio, video, and documents.',
              inputSchema: {
                type: 'object',
                properties: {
                  filePath: {
                    type: 'string',
                    description: 'Path to the file to send (absolute or relative to workspace).',
                  },
                  chatId: {
                    type: 'string',
                    description: 'Target chat ID',
                  },
                },
                required: ['filePath', 'chatId'],
              },
            },
          ],
        },
      };
    } else if (method === 'tools/call') {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

      if (toolName === 'send_message') {
        const format = (toolArgs.format as 'text' | 'card') || 'text';
        const result = await send_message({
          content: toolArgs.content as string | Record<string, unknown>,
          format,
          chatId: (toolArgs.chatId as string) || '',
          parentMessageId: toolArgs.parentMessageId as string | undefined,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: result.success
              ? result.message
              : `⚠️ ${result.message}`,
          },
        };
      } else if (toolName === 'send_file') {
        const result = await send_file({
          filePath: toolArgs.filePath as string,
          chatId: (toolArgs.chatId as string) || '',
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: result.success
              ? `File sent: ${result.message}`
              : `⚠️ ${result.message}`,
          },
        };
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }
    } else {
      throw new Error(`Unknown method: ${method}`);
    }
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

// Run main
main().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in main');
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
