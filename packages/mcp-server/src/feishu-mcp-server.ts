#!/usr/bin/env node
/**
 * Context MCP Server - stdio implementation
 *
 * This is a Model Context Protocol (MCP) server that provides
 * messaging integration tools to the Agent SDK via stdio.
 *
 * Tools provided:
 * - send_text: Send a plain text message to a chat
 * - send_card: Send a display-only card to a chat
 * - send_interactive: Send an interactive card with buttons/actions
 * - send_file: Send a file to a chat
 *
 * Environment Variables Required:
 * - FEISHU_APP_ID: Platform app ID
 * - FEISHU_APP_SECRET: Platform app secret
 * - WORKSPACE_DIR: Workspace directory (optional, defaults to cwd)
 *
 * Note: This is a thin wrapper around channel-mcp.ts.
 * The actual implementation is in channel-mcp.ts.
 */

import { createLogger } from '@disclaude/core';
import { send_file, send_text, send_card, send_interactive_message } from './channel-mcp.js';

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
                name: 'send_text',
                description: 'Send a plain text message to a chat.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    text: {
                      type: 'string',
                      description: 'The text message content.',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Target chat ID',
                    },
                    parentMessageId: {
                      type: 'string',
                      description: 'Optional parent message ID for thread replies.',
                    },
                  },
                  required: ['text', 'chatId'],
                },
              },
              {
                name: 'send_card',
                description: 'Send a display-only card to a chat. No button interactions.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    card: {
                      type: 'object',
                      description: 'The card content object.',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Target chat ID',
                    },
                    parentMessageId: {
                      type: 'string',
                      description: 'Optional parent message ID for thread replies.',
                    },
                  },
                  required: ['card', 'chatId'],
                },
              },
              {
                name: 'send_interactive',
                description: 'Send an interactive card with buttons to a chat. Primary Node builds the card from raw parameters.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    question: {
                      type: 'string',
                      description: 'The question or main content to display.',
                    },
                    options: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          text: { type: 'string', description: 'Button display text' },
                          value: { type: 'string', description: 'Button action value' },
                          type: { type: 'string', enum: ['primary', 'default', 'danger'], description: 'Button style' },
                        },
                        required: ['text', 'value'],
                      },
                      description: 'Button options for user interaction.',
                    },
                    chatId: {
                      type: 'string',
                      description: 'Target chat ID',
                    },
                    title: {
                      type: 'string',
                      description: 'Card title (defaults to 交互消息)',
                    },
                    context: {
                      type: 'string',
                      description: 'Optional context shown above the question',
                    },
                    actionPrompts: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      description: 'Optional custom action prompts (overrides auto-generated defaults).',
                    },
                    parentMessageId: {
                      type: 'string',
                      description: 'Optional parent message ID for thread replies.',
                    },
                  },
                  required: ['question', 'options', 'chatId'],
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
            ],
          },
        };

      case 'tools/call':
        // Call a tool
        const callParams = params as Record<string, unknown>;
        const { name, arguments: toolArgs } = callParams;

        if (name === 'send_text') {
          const args = toolArgs as { text: string; chatId: string; parentMessageId?: string };
          const result = await send_text(args);

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

        if (name === 'send_card') {
          const args = toolArgs as { card: Record<string, unknown>; chatId: string; parentMessageId?: string };
          const result = await send_card(args);

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

        if (name === 'send_interactive') {
          const args = toolArgs as {
            question: string;
            options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
            chatId: string;
            title?: string;
            context?: string;
            actionPrompts?: Record<string, string>;
            parentMessageId?: string;
          };
          const result = await send_interactive_message(args);

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
