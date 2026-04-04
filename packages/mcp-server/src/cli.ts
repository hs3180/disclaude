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
  getIpcSocketPath,
} from '@disclaude/core';
import { existsSync } from 'fs';
import {
  setMessageSentCallback,
  send_file,
  send_text,
  send_card,
  send_interactive_message,
} from './index.js';
import { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

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
    if (method === 'initialize') {
      // MCP handshake - return server capabilities
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'channel-mcp',
            version: '0.0.1',
          },
        },
      };
    } else if (method === 'tools/list') {
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
                    description: 'Optional parent message ID for thread replies',
                  },
                },
                required: ['text', 'chatId'],
              },
            },
            {
              name: 'send_card',
              description: `Send a display-only card to a chat. No button interactions.

## Card Structure
A Feishu card object with config, header, and elements.

## Type Constraints (IMPORTANT)
- **card**: MUST be an object with config/header/elements, NOT an array or string
- **chatId**: MUST be a non-empty string

Example:
\`\`\`json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "Title", "tag": "plain_text"}},
  "elements": [{"tag": "markdown", "content": "Content"}]
}
\`\`\`

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card`,
              inputSchema: {
                type: 'object',
                properties: {
                  card: {
                    type: 'object',
                    description: 'The card content object. MUST be an object, NOT an array or string.',
                  },
                  chatId: {
                    type: 'string',
                    description: 'Target chat ID',
                  },
                  parentMessageId: {
                    type: 'string',
                    description: 'Optional parent message ID for thread replies',
                  },
                },
                required: ['card', 'chatId'],
              },
            },
            {
              name: 'send_interactive',
              description: `Send an interactive card with buttons/actions to a chat.

Primary Node builds the card from raw parameters (question, options).

## Parameters
- **question**: The question or main content to display (string)
- **options**: Array of button options with text, value, and optional type
- **chatId**: Target chat ID
- **title**: Optional card title
- **context**: Optional context shown above the question
- **actionPrompts**: Optional custom action prompts

## Type Constraints (IMPORTANT)
- **question**: MUST be a non-empty string
- **options**: MUST be a non-empty array of objects with text and value
- **chatId**: MUST be a non-empty string

Example:
\`\`\`json
{
  "question": "Which option do you prefer?",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Reject", "value": "reject", "type": "danger" }
  ],
  "chatId": "oc_xxx"
}
\`\`\``,
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
                  title: {
                    type: 'string',
                    description: 'Optional card title.',
                  },
                  context: {
                    type: 'string',
                    description: 'Optional context shown above the question.',
                  },
                  actionPrompts: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: 'Optional custom action prompts that override auto-generated defaults.',
                  },
                  chatId: {
                    type: 'string',
                    description: 'Target chat ID',
                  },
                  parentMessageId: {
                    type: 'string',
                    description: 'Optional parent message ID for thread replies',
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
                    description: 'Path to the file to send (absolute or relative to workspace).',
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
                required: ['filePath', 'chatId'],
              },
            },
          ],
        },
      };
    } else if (method === 'tools/call') {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

      if (toolName === 'send_text') {
        // Pre-validation
        if (typeof toolArgs.text !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid text: must be a string' }],
              isError: true,
            },
          };
        }
        if (!toolArgs.chatId || typeof toolArgs.chatId !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid chatId: must be a non-empty string' }],
              isError: true,
            },
          };
        }

        const result = await send_text({
          text: toolArgs.text,
          chatId: toolArgs.chatId,
          parentMessageId: toolArgs.parentMessageId as string | undefined,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text' as const, text: result.success ? result.message : `⚠️ ${result.message}` }],
          },
        };
      } else if (toolName === 'send_card') {
        // eslint-disable-next-line prefer-destructuring
        const card = toolArgs.card;
        const chatId = (toolArgs.chatId as string | undefined);

        // Pre-validation: card must be an object
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: `⚠️ Invalid card: must be an object, got ${Array.isArray(card) ? 'array' : typeof card}` }],
              isError: true,
            },
          };
        }

        // Pre-validation: card structure
        if (!isValidFeishuCard(card as Record<string, unknown>)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: `⚠️ Invalid card structure: ${getCardValidationError(card)}` }],
              isError: true,
            },
          };
        }

        // Pre-validation: chatId
        if (!chatId || typeof chatId !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid chatId: must be a non-empty string' }],
              isError: true,
            },
          };
        }

        const result = await send_card({
          card: card as Record<string, unknown>,
          chatId,
          parentMessageId: toolArgs.parentMessageId as string | undefined,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text' as const, text: result.success ? result.message : `⚠️ ${result.message}` }],
          },
        };
      } else if (toolName === 'send_interactive') {
        const { question, options } = toolArgs;
        const chatId = toolArgs.chatId as string | undefined;

        // Pre-validation: question must be a non-empty string
        if (!question || typeof question !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid question: must be a non-empty string' }],
              isError: true,
            },
          };
        }

        // Pre-validation: options must be a non-empty array
        if (!Array.isArray(options) || options.length === 0) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid options: must be a non-empty array' }],
              isError: true,
            },
          };
        }

        // Pre-validation: each option must have text and value
        const opts = options as Array<{ text?: unknown; value?: unknown }>;
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          if (typeof opt.text !== 'string' || opt.text.trim().length === 0) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text' as const, text: `⚠️ Invalid options[${i}].text: must be a non-empty string` }],
                isError: true,
              },
            };
          }
          if (typeof opt.value !== 'string' || opt.value.trim().length === 0) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text' as const, text: `⚠️ Invalid options[${i}].value: must be a non-empty string` }],
                isError: true,
              },
            };
          }
        }

        // Pre-validation: chatId
        if (!chatId || typeof chatId !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid chatId: must be a non-empty string' }],
              isError: true,
            },
          };
        }

        const result = await send_interactive_message({
          question: question as string,
          options: options as Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>,
          chatId,
          title: toolArgs.title as string | undefined,
          context: toolArgs.context as string | undefined,
          actionPrompts: toolArgs.actionPrompts as Record<string, string> | undefined,
          parentMessageId: toolArgs.parentMessageId as string | undefined,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text' as const, text: result.success ? result.message : `⚠️ ${result.message}` }],
          },
        };
      } else if (toolName === 'send_file') {
        // Pre-validation
        if (typeof toolArgs.filePath !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid filePath: must be a string' }],
              isError: true,
            },
          };
        }
        if (!toolArgs.chatId || typeof toolArgs.chatId !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text' as const, text: '⚠️ Invalid chatId: must be a non-empty string' }],
              isError: true,
            },
          };
        }

        const result = await send_file({
          filePath: toolArgs.filePath,
          chatId: toolArgs.chatId,
          parentMessageId: typeof toolArgs.parentMessageId === 'string' ? toolArgs.parentMessageId : undefined,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text' as const, text: result.success ? `File sent: ${result.message}` : `⚠️ ${result.message}` }],
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

// Run main
main().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in main');
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
