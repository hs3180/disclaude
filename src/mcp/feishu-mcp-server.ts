#!/usr/bin/env node
/**
 * Feishu MCP Server - stdio implementation
 *
 * This is a Model Context Protocol (MCP) server that provides
 * Feishu/Lark integration tools to the Agent SDK via stdio.
 *
 * Tools provided:
 * - send_file_to_feishu: Send a file to a Feishu chat
 *
 * Environment Variables Required:
 * - FEISHU_APP_ID: Feishu app ID
 * - FEISHU_APP_SECRET: Feishu app secret
 * - WORKSPACE_DIR: Workspace directory (optional, defaults to cwd)
 */

import { createLogger } from '../utils/logger.js';
import { uploadAndSendFile } from '../feishu/file-uploader.js';
import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createLogger('FeishuMCPServer');

/**
 * MCP Tool: Send file to Feishu
 */
async function send_file_to_feishu(args: { filePath: string; chatId: string }) {
  const { filePath, chatId } = args;

  try {
    if (!chatId) {
      throw new Error('chatId is required - cannot send file');
    }

    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in environment variables');
    }

    // Resolve file path
    const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceDir, filePath);

    logger.info({ filePath, resolvedPath, workspaceDir, chatId }, 'MCP tool: send_file_to_feishu called');

    // Check file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Create Lark client
    const client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

    // Upload and send file
    const fileSize = await uploadAndSendFile(client, resolvedPath, chatId);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({
      fileName,
      fileSize,
      sizeMB,
      filePath: resolvedPath,
      chatId
    }, 'File sent successfully via MCP tool');

    return {
      content: [{
        type: 'text',
        text: `✅ File sent to Feishu: ${fileName} (${sizeMB} MB)`,
      }],
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'MCP tool: send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Return as soft error (no isError flag) to allow agent to continue
    // Include detailed error info for agent self-correction
    return {
      content: [{
        type: 'text',
        text: `⚠️ Failed to send file: ${errorMessage}\n\nPlease verify:\n- File path is correct and file exists\n- Chat ID is valid\n- Feishu credentials are configured`,
      }],
    };
  }
}

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
                name: 'send_file_to_feishu',
                description: 'Send a file to a Feishu chat. Use the chatId from the current context (marked as [Current Chat ID: xxx] in the prompt). Supports images, audio, video, and documents.',
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
            ],
          },
        };

      case 'tools/call':
        // Call a tool
        const callParams = params as Record<string, unknown>;
        const { name, arguments: toolArgs } = callParams;
        if (name === 'send_file_to_feishu') {
          const result = await send_file_to_feishu(toolArgs as { filePath: string; chatId: string });
          return {
            jsonrpc: '2.0',
            id,
            result,
          };
        } else {
          throw new Error(`Unknown tool: ${name}`);
        }

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
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    logger.error({ err: error }, 'Fatal error');
    process.exit(1);
  }
}
