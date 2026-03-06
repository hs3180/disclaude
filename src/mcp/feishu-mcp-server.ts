#!/usr/bin/env node
/**
 * Feishu MCP Server - stdio implementation
 *
 * This is a Model Context Protocol (MCP) server that provides
 * Feishu/Lark integration tools to the Agent SDK via stdio.
 *
 * Tools provided:
 * - send_user_feedback: Send a message to a Feishu chat
 * - send_file_to_feishu: Send a file to a Feishu chat
 * - update_card: Update an existing interactive card (deprecated, use send_interactive_message instead)
 * - wait_for_interaction: Wait for user to interact with a card (deprecated)
 * - send_interactive_message: Send an interactive card with buttons/menus (recommended)
 *
 * Environment Variables Required:
 * - FEISHU_APP_ID: Feishu app ID
 * - FEISHU_APP_SECRET: Feishu app secret
 * - WORKSPACE_DIR: Workspace directory (optional, defaults to cwd)
 *
 * Note: This is a thin wrapper around feishu-context-mcp.ts.
 * The actual implementation is in feishu-context-mcp.ts.
 */

import { createLogger } from '../utils/logger.js';
import {
  send_user_feedback,
  send_file_to_feishu,
  update_card,
  wait_for_interaction,
  send_interactive_message,
  SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION,
} from './feishu-context-mcp.js';

const logger = createLogger('FeishuMCPServer');

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
                name: 'send_user_feedback',
                description: 'Send a message to a Feishu chat. Requires explicit format: "text" or "card".',
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
                      description: 'Feishu chat ID to send the message to',
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
                name: 'send_file_to_feishu',
                description: 'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    filePath: {
                      type: 'string',
                      description: 'Path to the file to send (relative to workspace or absolute)',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Feishu chat ID to send the file to',
                    },
                  },
                  required: ['filePath', 'chatId'],
                },
              },
              {
                name: 'send_interactive_message',
                description: SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION,
                inputSchema: {
                  type: 'object',
                  properties: {
                    card: {
                      type: 'object',
                      description: 'The interactive card JSON structure (Feishu card format). Use this for cards with buttons, menus, or other interactive components.',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Feishu chat ID to send the message to',
                    },
                    parentMessageId: {
                      type: 'string',
                      description: 'Optional parent message ID for thread replies',
                    },
                    description: {
                      type: 'string',
                      description: 'Optional description of what this card is for (for logging)',
                    },
                  },
                  required: ['card', 'chatId'],
                },
              },
              {
                name: 'update_card',
                description: 'Update an existing interactive card message.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    messageId: {
                      type: 'string',
                      description: 'The message ID of the card to update',
                    },
                    card: {
                      type: 'object',
                      description: 'The new card content',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Feishu chat ID where the card was sent',
                    },
                  },
                  required: ['messageId', 'card', 'chatId'],
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
                      description: 'Feishu chat ID where the card was sent',
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

        if (name === 'send_user_feedback') {
          const args = toolArgs as { content: string; format: 'text' | 'card'; chatId: string; parentMessageId?: string };
          const result = await send_user_feedback(args);

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

        if (name === 'send_file_to_feishu') {
          const args = toolArgs as { filePath: string; chatId: string };
          const result = await send_file_to_feishu(args);

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

        if (name === 'update_card') {
          const args = toolArgs as { messageId: string; card: Record<string, unknown>; chatId: string };
          const result = await update_card(args);

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

        if (name === 'send_interactive_message') {
          const args = toolArgs as {
            card: Record<string, unknown>;
            chatId: string;
            parentMessageId?: string;
            description?: string;
          };
          const result = await send_interactive_message(args);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: result.success
                  ? `${result.message}${result.messageId ? `\nMessage ID: ${result.messageId}` : ''}`
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
              name: 'feishu-mcp-server',
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
  logger.info('Starting Feishu MCP Server (stdio)');

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
    logger.info('Feishu MCP Server shutting down');
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
