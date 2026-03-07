#!/usr/bin/env node
/**
 * Context MCP Server - stdio implementation
 *
 * This is a Model Context Protocol (MCP) server that provides
 * messaging integration tools to the Agent SDK via stdio.
 *
 * Tools provided:
 * - send_message: Send a message to a chat
 * - send_file: Send a file to a chat
 * - wait_for_interaction: Wait for user to interact with a card
 *
 * Environment Variables Required:
 * - FEISHU_APP_ID: Platform app ID
 * - FEISHU_APP_SECRET: Platform app secret
 * - WORKSPACE_DIR: Workspace directory (optional, defaults to cwd)
 *
 * Note: This is a thin wrapper around feishu-context-mcp.ts.
 * The actual implementation is in feishu-context-mcp.ts.
 */

import { createLogger } from '../utils/logger.js';
import { send_message, send_file, wait_for_interaction } from './feishu-context-mcp.js';

const logger = createLogger('ContextMCPServer');

/**
 * Handle MCP requests
 */
async function handleMessage(message: unknown) {
  const msg = message as Record<string, unknown>;
  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'tools/list':
        // Return list of available tools
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'send_message',
                description: 'Send a message to a chat. Requires explicit format: "text" or "card".',
                inputSchema: {
                  type: 'object',
                  properties: {
                    content: {
                      type: 'string',
                      description: 'The content to send. String for text messages.',
                    },
                    format: {
                      type: 'string',
                      enum: ['text', 'card'],
                      description: 'Format specifier: "text" for plain text, "card" for interactive cards.',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Chat ID to send the message to',
                    },
                    parentMessageId: {
                      type: 'string',
                      description: 'Optional parent message ID for thread replies.',
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
                      description: 'Path to the file to send (relative to workspace or absolute)',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Chat ID to send the file to',
                    },
                  },
                  required: ['filePath', 'chatId'],
                },
              },
              {
                name: 'wait_for_interaction',
                description: 'Wait for user to interact with a card. Blocks until interaction or timeout.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    messageId: {
                      type: 'string',
                      description: 'The message ID of the card to wait for',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Chat ID where the card was sent',
                    },
                    timeoutSeconds: {
                      type: 'number',
                      description: 'Maximum time to wait in seconds (default: 300)',
                    },
                  },
                  required: ['messageId', 'chatId'],
                },
              },
            ],
          },
        };

      case 'tools/call':
        // Call a tool
        const callParams = params as Record<string, unknown>;
        const { name, arguments: toolArgs } = callParams;

        if (name === 'send_message') {
          const args = toolArgs as { content: string; format: 'text' | 'card'; chatId: string; parentMessageId?: string };
          const result = await send_message(args);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: result.success
                  ? result.message
                  : `⚠️ ${result.message}`,
              }],
            },
          };
        }

        if (name === 'send_file') {
          const args = toolArgs as { filePath: string; chatId: string };
          const result = await send_file(args);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: result.success
                  ? result.message
                  : `⚠️ ${result.message}`,
              }],
            },
          };
        }

        if (name === 'wait_for_interaction') {
          const args = toolArgs as { messageId: string; chatId: string; timeoutSeconds?: number };
          const result = await wait_for_interaction(args);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: result.success
                  ? `${result.message}\nAction: ${result.actionValue}\nType: ${result.actionType}\nUser: ${result.userId}`
                  : `⚠️ ${result.message}`,
              }],
            },
          };
        }

        throw new Error(`Unknown tool: ${name}`);

      case 'initialize':
        // Initialize connection
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'context-mcp-server',
              version: '1.0.0',
            },
          },
        };

      default:
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
 * Main server loop - read from stdin, write to stdout
 */
function main() {
  logger.info('Starting Context MCP Server (stdio)');

  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          handleMessage(message).then(response => {
            process.stdout.write(`${JSON.stringify(response)}\n`);
          }).catch(error => {
            logger.error({ err: error }, 'Error handling message');
            const errorResponse = {
              jsonrpc: '2.0',
              id: (message as Record<string, unknown>).id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : 'Unknown error',
              },
            };
            process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
          });
        } catch (error) {
          logger.error({ line, err: error }, 'Error parsing message');
        }
      }
    }
  });

  process.stdin.on('end', () => {
    logger.info('Context MCP Server shutting down');
  });

  process.stdin.on('error', (error) => {
    logger.error({ err: error }, 'stdin error');
  });
}

// Start server if this is the main module
// Handle both ESM (import.meta.url) and CommonJS (undefined) bundling
if (typeof import.meta.url === 'undefined' || import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    logger.error({ err: error }, 'Fatal error');
    process.exit(1);
  }
}
